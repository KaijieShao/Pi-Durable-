/**
 * The isolated evaluator on Docker (Architecture § Isolated evaluator: "a separate trusted container, launched only by
 * the Coordinator after sealing, with the sealed snapshot and hidden tests read-only plus scratch space, and no network
 * or credentials. Agents can't reach it"; Agent Execution § Containers, Evaluator column; Capacity § Evaluator: "a
 * single container with 2 vCPU and 2 GiB, and grades the suites sequentially").
 *
 * One container per evaluation, from the trusted evaluator image (deploy/docker/evaluator.Dockerfile, built offline by
 * scripts/build-images.sh as pi-durable-evaluator:demo), pinned by image id once probed:
 *
 *   docker run --name pd-e-<hex> --label pi-durable.managed=1 --label pi-durable.kind=evaluator
 *     --label pi-durable.trial=<trial> <hardeningArgs: --network none, --read-only, --cap-drop ALL, no-new-privileges,
 *     --cpus 2 --memory 2048m --memory-swap 2048m --pids-limit 512, --user <uid:gid>> --init
 *     --mount type=bind,src=<snapshot>,dst=/eval/snapshot,readonly
 *     --mount type=bind,src=<hidden tests>,dst=/eval/hidden,readonly
 *     --mount type=bind,src=<scratch>,dst=/scratch
 *     -e HOME=/scratch/home -e TMPDIR=/scratch/tmp -e PI_EVAL_DEADLINE_MS=<deadline + 5 s> -w /scratch
 *     <image id> node /opt/pi-eval/run-eval.mjs
 *
 * The launcher runs the image's fixed suite list (/opt/pi-eval/suites.json) one suite after another and prints one JSON
 * line per suite (sandbox/evaluator-output.ts). The environment holds those three variables only: the docker client
 * gets dockerEnv() (no Coordinator secret), the container no credential at all. The managed label means restart
 * recovery and the watchdog remove an evaluator left by a dead Coordinator; the task and generation labels are absent,
 * so a run's scoped sweep never touches it. Its deadline removes the container (`docker rm -f`); the launcher also
 * stops by itself after PI_EVAL_DEADLINE_MS.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import type { Limits } from "../limits.ts";
import type { Availability, Evaluator, EvaluatorFacts, EvaluatorRun, EvaluatorSpec } from "../ports.ts";
import {
	DOCKER_QUICK_MS,
	DOCKER_START_MS,
	type DockerOutput,
	describeFailure,
	dockerEnv,
	hardeningArgs,
	LABEL_KIND,
	LABEL_MANAGED,
	MOUNT_UNSAFE,
	runDocker,
	USER_PATTERN,
} from "./docker.ts";
import { evaluatorRunOf, type LauncherEnd } from "./evaluator-output.ts";
import { createScratch, removeScratch, sleep } from "./limits-text.ts";

export const EVAL_LAUNCHER_PATH = "/opt/pi-eval/run-eval.mjs";
export const EVAL_SUITES_PATH = "/opt/pi-eval/suites.json";
export const EVAL_SNAPSHOT_MOUNT = "/eval/snapshot";
export const EVAL_HIDDEN_MOUNT = "/eval/hidden";
export const EVAL_SCRATCH_MOUNT = "/scratch";
export const LABEL_TRIAL = "pi-durable.trial";
export const EVALUATOR_KIND = "evaluator";

/** The launcher's own deadline trails the Coordinator's by this much, so the Coordinator's normally fires first. */
const LAUNCHER_DEADLINE_SLACK_MS = 5_000;
const STDOUT_MAX_BYTES = 1024 * 1024;
const STOP_RETRY_MS = 1_000;
const CLIENT_EXIT_GRACE_MS = 10_000;
const REMOVE_VERIFY_MS = 15_000;

export type DockerEvaluatorOptions = {
	readonly bin: string;
	readonly image: string;
	/** uid:gid the container runs as; never root. */
	readonly user: string;
	readonly limits: Limits;
	readonly log: Logger;
};

type Attached = {
	readonly clientCode: number | null;
	readonly stopReason: "timeout" | "aborted" | "output" | undefined;
	readonly spawnFailed: boolean;
	readonly stdout: string;
	readonly stderr: string;
};

type ContainerState = { readonly started: boolean; readonly exitCode: number | undefined; readonly oomKilled: boolean };

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The image's suite list must be an object with a non-empty `suites` array (the launcher checks every entry). */
function checkSuites(text: string): void {
	const parsed = JSON.parse(text) as { suites?: unknown };
	if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.suites) || parsed.suites.length === 0)
		throw new Error("the evaluator image's suite list has no suites");
}

/** A directory to bind-mount: absolute, resolved, a directory, and safe inside a --mount value. */
async function mountable(path: string, what: string): Promise<string> {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${what} must be an absolute path`);
	const real = await realpath(path);
	if (!(await stat(real)).isDirectory()) throw new Error(`${what} is not a directory`);
	if (MOUNT_UNSAFE.test(real)) throw new Error(`${what} cannot be mounted safely`);
	return real;
}

/** Stop the attached `docker run`: `docker rm -f` now and every second until the client exits (killed after a grace). */
function stopper(bin: string, name: string, kill: () => void) {
	let reason: Attached["stopReason"];
	let interval: NodeJS.Timeout | undefined;
	let killTimer: NodeJS.Timeout | undefined;
	const remove = () => void runDocker(bin, ["rm", "-f", name]);
	return {
		get reason() {
			return reason;
		},
		request(next: NonNullable<Attached["stopReason"]>): void {
			if (reason !== undefined) return;
			reason = next;
			remove();
			interval = setInterval(remove, STOP_RETRY_MS);
			killTimer = setTimeout(kill, CLIENT_EXIT_GRACE_MS);
		},
		dispose(): void {
			clearInterval(interval);
			clearTimeout(killTimer);
		},
	};
}

/** The attached run, stopped at the deadline, on the caller's signal, or when its output passes the bound. */
function runAttached(bin: string, name: string, args: readonly string[], spec: EvaluatorSpec): Promise<Attached> {
	const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv(), shell: false });
	const stop = stopper(bin, name, () => child.kill("SIGKILL"));
	const onAbort = (): void => stop.request("aborted");
	const timer = setTimeout(() => stop.request("timeout"), spec.deadlineMs);
	spec.signal?.addEventListener("abort", onAbort, { once: true });
	if (spec.signal?.aborted === true) onAbort();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		if (stdout.length + chunk.length > STDOUT_MAX_BYTES) stop.request("output");
		else stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < 16_384) stderr += chunk.toString("utf8");
	});
	let spawnFailed = false;
	child.on("error", () => {
		spawnFailed = true;
	});
	return new Promise((resolve) => {
		child.on("close", (code) => {
			clearTimeout(timer);
			stop.dispose();
			spec.signal?.removeEventListener("abort", onAbort);
			resolve({ clientCode: code, stopReason: stop.reason, spawnFailed, stdout, stderr });
		});
	});
}

/** Docker's own failures exit 125+ before a container starts; a stopped one started. */
function containerStarted(attached: Attached, state: ContainerState | undefined): boolean {
	if (attached.spawnFailed) return false;
	if (state !== undefined) return state.started;
	return attached.stopReason !== undefined || (attached.clientCode !== null && attached.clientCode < 125);
}

function launcherEnd(attached: Attached, state: ContainerState | undefined, startedAt: number): LauncherEnd {
	const stopped = attached.stopReason !== undefined;
	return {
		exitCode: stopped ? undefined : (state?.exitCode ?? attached.clientCode ?? undefined),
		timedOut: attached.stopReason === "timeout",
		aborted: attached.stopReason === "aborted",
		// A memory or output limit, or an exit state Docker could not tell.
		failed: attached.stopReason === "output" || state?.oomKilled === true || (!stopped && state === undefined),
		durationMs: Date.now() - startedAt,
	};
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 200);
}

export function createDockerEvaluator(options: DockerEvaluatorOptions): Evaluator {
	const { bin, image, user, limits, log } = options;
	let ready: EvaluatorFacts | undefined;
	const docker = (args: readonly string[], timeoutMs?: number): Promise<DockerOutput> =>
		runDocker(bin, args, { timeoutMs });
	const labels = (trial: string, kind: string): string[] => [
		"--label",
		`${LABEL_MANAGED}=1`,
		"--label",
		`${LABEL_KIND}=${kind}`,
		"--label",
		`${LABEL_TRIAL}=${trial}`,
	];
	const hardening = (memoryMiB = limits.evaluatorMemoryMiB): string[] =>
		hardeningArgs({ user, cpus: limits.evaluatorCpus, memoryMiB, pids: limits.evaluatorPids });

	const inspectImage = async (): Promise<{ imageId: string; repoDigest: string | undefined }> => {
		const output = await docker(["image", "inspect", "--format", "{{.Id}}|{{range .RepoDigests}}{{.}} {{end}}", image]);
		const [id = "", digests = ""] = output.stdout.trim().split("|");
		if (output.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id))
			throw new Error(`evaluator image ${image} is missing (build it with scripts/build-images.sh)`);
		return { imageId: id, repoDigest: digests.trim().split(" ")[0] || undefined };
	};

	const readSuites = async (imageId: string): Promise<string> => {
		const args = ["run", "--rm", "--name", `pd-e-probe-${randomBytes(4).toString("hex")}`, ...labels("probe", "probe")];
		args.push(...hardening(Math.min(limits.evaluatorMemoryMiB, 256)), "--init", imageId, "cat", EVAL_SUITES_PATH);
		const output = await docker(args, DOCKER_START_MS);
		if (output.code !== 0)
			throw new Error(`the evaluator image's suite list is unreadable: ${describeFailure(output)}`);
		checkSuites(output.stdout);
		return output.stdout;
	};

	const probe = async (): Promise<EvaluatorFacts> => {
		if (!USER_PATTERN.test(user)) throw new Error("container user must be uid:gid with a non-root uid");
		const version = await docker(["version", "--format", "{{.Server.Version}}"]);
		if (version.code !== 0) throw new Error(`docker is not available: ${describeFailure(version)}`);
		const { imageId, repoDigest } = await inspectImage();
		return { image, imageId, repoDigest, suitesHash: sha256(await readSuites(imageId)) };
	};

	const available = async (): Promise<Availability> => {
		try {
			ready = await probe();
			log.info("evaluator_available", { image: ready.imageId.slice(0, 19), suites: ready.suitesHash.slice(0, 19) });
			return { ok: true };
		} catch (error) {
			ready = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			log.warn("evaluator_unavailable", { reason });
			return { ok: false, reason };
		}
	};

	const filterArgs = (): string[] => [
		"--filter",
		`label=${LABEL_MANAGED}=1`,
		"--filter",
		`label=${LABEL_KIND}=evaluator`,
	];

	const live = async (): Promise<string[]> => {
		const output = await docker(["ps", "-a", "--no-trunc", "--format", "{{.Names}}", ...filterArgs()]);
		if (output.code !== 0) throw new Error(`cannot list containers: ${describeFailure(output)}`);
		return output.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	};

	const killAll = async (): Promise<void> => {
		const deadline = Date.now() + REMOVE_VERIFY_MS;
		for (let names = await live(); names.length > 0 && Date.now() < deadline; names = await live()) {
			await docker(["rm", "-f", ...names.slice(0, 32)], DOCKER_START_MS);
			await sleep(200);
		}
	};

	const inspectState = async (name: string): Promise<ContainerState | undefined> => {
		const output = await docker(["container", "inspect", "--format", "{{json .State}}", name]);
		if (output.code !== 0) return undefined;
		try {
			const state = JSON.parse(output.stdout) as { ExitCode?: number; OOMKilled?: boolean; StartedAt?: string };
			const started = typeof state.StartedAt === "string" && !state.StartedAt.startsWith("0001-");
			return { started, exitCode: state.ExitCode, oomKilled: state.OOMKilled === true };
		} catch {
			return undefined;
		}
	};

	const runArgs = async (spec: EvaluatorSpec, facts: EvaluatorFacts, name: string): Promise<string[]> => {
		const snapshot = await mountable(spec.snapshot, "the snapshot");
		const hidden = await mountable(spec.hiddenTests, "the hidden tests directory");
		const scratch = await mountable(spec.scratch, "the scratch directory");
		return [
			"run",
			"--name",
			name,
			...labels(spec.trial, EVALUATOR_KIND),
			...hardening(),
			"--init",
			"--mount",
			`type=bind,src=${snapshot},dst=${EVAL_SNAPSHOT_MOUNT},readonly`,
			"--mount",
			`type=bind,src=${hidden},dst=${EVAL_HIDDEN_MOUNT},readonly`,
			"--mount",
			`type=bind,src=${scratch},dst=${EVAL_SCRATCH_MOUNT}`,
			"-e",
			`HOME=${EVAL_SCRATCH_MOUNT}/home`,
			"-e",
			`TMPDIR=${EVAL_SCRATCH_MOUNT}/tmp`,
			"-e",
			`PI_EVAL_DEADLINE_MS=${spec.deadlineMs + LAUNCHER_DEADLINE_SLACK_MS}`,
			"-w",
			EVAL_SCRATCH_MOUNT,
			facts.imageId,
			"node",
			EVAL_LAUNCHER_PATH,
		];
	};

	/** What the container did, read after its client exited; then it is removed (verified by the caller's live()). */
	const finish = async (name: string, attached: Attached, startedAt: number): Promise<EvaluatorRun> => {
		const state = attached.stopReason === undefined ? await inspectState(name) : undefined;
		await docker(["rm", "-f", name], DOCKER_QUICK_MS);
		if (!containerStarted(attached, state))
			return { kind: "not_started", reason: firstLine(attached.stderr) || "the evaluator container did not start" };
		return evaluatorRunOf(attached.stdout, launcherEnd(attached, state, startedAt));
	};

	const run = async (spec: EvaluatorSpec): Promise<EvaluatorRun> => {
		const startedAt = Date.now();
		const facts = ready ?? (await available().then(() => ready));
		if (facts === undefined) return { kind: "not_started", reason: "the evaluator is not available" };
		const name = `pd-e-${randomBytes(6).toString("hex")}`;
		let args: string[];
		try {
			args = await runArgs(spec, facts, name);
		} catch (error) {
			return { kind: "not_started", reason: errorSummary(error) };
		}
		log.info("evaluator_started", { trial: spec.trial, container: name, image: facts.imageId.slice(0, 19) });
		const result = await finish(name, await runAttached(bin, name, args, spec), startedAt);
		log.info("evaluator_finished", {
			trial: spec.trial,
			container: name,
			kind: result.kind,
			end: result.kind === "ran" ? result.end : undefined,
			suites: result.kind === "ran" ? result.suites.length : 0,
			duration_ms: Date.now() - startedAt,
		});
		return result;
	};

	/** Scratch files the container left as another uid are deleted in a throwaway container of the same image. */
	const wipeScratch = async (path: string): Promise<boolean> => {
		if (await removeScratch(path)) return true;
		if (ready !== undefined && isAbsolute(path) && !MOUNT_UNSAFE.test(path)) {
			const args = [
				"run",
				"--rm",
				"--name",
				`pd-e-clean-${randomBytes(4).toString("hex")}`,
				...labels("cleanup", "cleanup"),
			];
			args.push(
				...hardening(Math.min(limits.evaluatorMemoryMiB, 256)),
				"--mount",
				`type=bind,src=${path},dst=/scratch`,
			);
			await docker([...args, ready.imageId, "find", "/scratch", "-mindepth", "1", "-delete"], DOCKER_START_MS);
		}
		return removeScratch(path);
	};

	return {
		available,
		facts: () => ready,
		run,
		live,
		killAll,
		createScratch: (root) => createScratch(root, user),
		wipeScratch,
	};
}
