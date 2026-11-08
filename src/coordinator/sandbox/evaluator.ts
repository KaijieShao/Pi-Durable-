/**
 * Full-Node external evaluation: a trusted hidden-test container and an independently isolated full-Node app.
 * Sources/scratch/PIDs/report channels are disjoint; the host mediates observations and reads actual file evidence.
 * Each role uses half the demo evaluation budget. Both roles and any cleanup carry managed/evaluator/trial labels,
 * so restart/watchdog/live checks verify the complete evaluation before dispatch can reopen.
 */
import { createHash, randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import type { Limits } from "../limits.ts";
import type { Availability, Evaluator, EvaluatorFacts, EvaluatorRun, EvaluatorSpec } from "../ports.ts";
import {
	DOCKER_START_MS,
	type DockerOutput,
	describeFailure,
	hardeningArgs,
	LABEL_KIND,
	LABEL_MANAGED,
	MOUNT_UNSAFE,
	runDocker,
	USER_PATTERN,
} from "./docker.ts";
import { fileObserverAvailable, runEvaluationPair } from "./evaluator-broker.ts";
import { evaluatorRunOf } from "./evaluator-output.ts";
import { launchEvaluationRole, type RoleContext, type RoleEvidence } from "./evaluator-role.ts";
import { createScratch, removeScratch, sleep } from "./limits-text.ts";

export const EVAL_LAUNCHER_PATH = "/opt/pi-eval/run-eval.mjs";
export const EVAL_SUITES_PATH = "/opt/pi-eval/suites.json";
export const EVAL_SNAPSHOT_MOUNT = "/eval/snapshot";
export const EVAL_HIDDEN_MOUNT = "/eval/hidden";
export const EVAL_SCRATCH_MOUNT = "/scratch";
export const LABEL_TRIAL = "pi-durable.trial";
export const EVALUATOR_KIND = "evaluator";

/** The launcher's own deadline trails the Coordinator's by this much, so the Coordinator's normally fires first. */
const REMOVE_VERIFY_MS = 15_000;

export type DockerEvaluatorOptions = {
	readonly bin: string;
	readonly image: string;
	/** uid:gid the container runs as; never root. */
	readonly user: string;
	readonly limits: Limits;
	readonly log: Logger;
};

function sha256(text: string): string {
	return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function safeSuite(entry: unknown): boolean {
	return typeof entry === "object" && entry !== null && !Array.isArray(entry) && !Object.hasOwn(entry, "argv");
}

/** Refuse legacy images before sealing; the launcher validates every v2 definition in detail. */
function checkSuites(text: string): void {
	const parsed = JSON.parse(text) as { version?: unknown; suites?: unknown };
	if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.suites) || parsed.suites.length === 0)
		throw new Error("the evaluator image's suite list has no suites");
	if (parsed.version !== 3 || !parsed.suites.every(safeSuite))
		throw new Error("the evaluator image requires version 3 external full-Node tests; rebuild scripts/build-images.sh");
}

/** A directory to bind-mount: absolute, resolved, a directory, and safe inside a --mount value. */
async function mountable(path: string, what: string): Promise<string> {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${what} must be an absolute path`);
	const real = await realpath(path);
	if (!(await stat(real)).isDirectory()) throw new Error(`${what} is not a directory`);
	if (MOUNT_UNSAFE.test(real)) throw new Error(`${what} cannot be mounted safely`);
	return real;
}

function recordedRun(
	result: Awaited<ReturnType<typeof runEvaluationPair>>,
	evidence: RoleEvidence,
	startedAt: number,
): EvaluatorRun {
	if (!evidence.graderStarted && !result.timedOut && !result.aborted)
		return { kind: "not_started", reason: "the trusted evaluator did not start" };
	const run = evaluatorRunOf(result.stdout, {
		exitCode: result.exitCode,
		timedOut: result.timedOut,
		aborted: result.aborted,
		failed:
			result.failed ||
			result.subjectFailed ||
			evidence.unexpectedSubjectExit ||
			evidence.cleanupFailed ||
			evidence.stateFailed,
		durationMs: Date.now() - startedAt,
	});
	return { ...run, subjectFailed: result.subjectFailed || evidence.unexpectedSubjectExit };
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
		hardeningArgs({
			user,
			cpus: limits.evaluatorCpus / 2,
			memoryMiB: Math.min(memoryMiB, Math.floor(limits.evaluatorMemoryMiB / 2)),
			pids: Math.floor(limits.evaluatorPids / 2),
		});

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
		await fileObserverAvailable();
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

	const run = async (spec: EvaluatorSpec): Promise<EvaluatorRun> => {
		const startedAt = Date.now();
		const facts = ready ?? (await available().then(() => ready));
		if (facts === undefined) return { kind: "not_started", reason: "the evaluator is not available" };
		let snapshot: string, hidden: string;
		try {
			snapshot = await mountable(spec.snapshot, "the snapshot");
			hidden = await mountable(spec.hiddenTests, "the hidden tests directory");
			await mountable(spec.scratch, "the scratch directory");
		} catch (error) {
			return { kind: "not_started", reason: errorSummary(error) };
		}
		const evidence: RoleEvidence = {
			graderStarted: false,
			unexpectedSubjectExit: false,
			stateFailed: false,
			cleanupFailed: false,
		};
		const context: RoleContext = {
			bin,
			imageId: facts.imageId,
			user,
			limits,
			log,
			trial: spec.trial,
			snapshot,
			hidden,
			scratchRoot: spec.scratch,
			deadlineMs: spec.deadlineMs,
			startedAt,
			evidence,
		};
		let result: Awaited<ReturnType<typeof runEvaluationPair>>;
		try {
			result = await runEvaluationPair({
				grader: await launchEvaluationRole(context, "grader"),
				launchSubject: () => launchEvaluationRole(context, "app"),
				deadlineMs: Math.max(1, spec.deadlineMs - (Date.now() - startedAt)),
				...(spec.signal === undefined ? {} : { signal: spec.signal }),
			});
		} catch {
			return { kind: "not_started", reason: "the isolated evaluator could not start" };
		}
		return recordedRun(result, evidence, startedAt);
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
