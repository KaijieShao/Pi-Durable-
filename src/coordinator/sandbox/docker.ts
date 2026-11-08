/**
 * Docker sandbox (Agent Execution § Containers, Architecture § Policy hooks and containers, Capacity § Provisional
 * container limits, Deployment § Processes: labels, § Network: none).
 *
 * Agent container, one per run: the task's worktree at /work read-write, /work/.git masked by an empty read-only
 * file, no network, read-only root, tmpfs /tmp, all capabilities dropped, no-new-privileges, non-root user, cpu /
 * memory / pids limits, labels pi-durable.managed / task / generation, command `sleep <lifetime>` (it ends by itself).
 * File operations run as `docker exec -i <name> node /opt/pi-agent/fsop.mjs /work` (JSON over stdin/stdout).
 *
 * Check container, one per run_check / test / setup: the worktree read-only (writable only for "setup"), a fresh
 * scratch directory at /scratch (deleted after), the same hardening plus --init, launcher and operation list from the
 * pinned check image. Its deadline removes the container; termination is verified before an outcome is returned.
 *
 * Fails closed: `available()` needs a reachable Docker daemon, both images present and the check image's operation
 * list readable; images are pinned by ID once probed. Every docker invocation is an argv array (never a shell) and
 * gets a minimal environment (no Coordinator secrets).
 *
 * Deviation from the design text: the agent container is started with --rm (it disappears by itself when its
 * lifetime ends); the check container is not, so its exit state (OOMKilled) can be read before it is removed.
 * STUB(spec: agent-execution.md § Containers, Evaluator column): no evaluator container (sealing is not built).
 * Containers also end by themselves (agent: `sleep <lifetime>`; check: the launcher's own deadline); recovery and the
 * watchdog (src/watchdog/reapers.ts, by the pi-durable.managed label) remove every labelled container.
 */
import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import type { Limits } from "../limits.ts";
import type { AgentSandbox, CheckResult, ContainerFilter, FsRequest, FsResponse, Sandbox } from "../ports.ts";
import {
	type CheckFacts,
	classifyCheck,
	containerName,
	createScratch,
	ensureTaskLayout,
	FS_TIMEOUT_MS,
	fsError,
	OP_NAME,
	OutputMonitor,
	outcomeTrailer,
	positiveFinite,
	precheckCheck,
	rejectedCheck,
	removeScratch,
	runFsop,
	sleep,
	type TaskLayout,
	validIds,
	validSetupScript,
	withTrailer,
} from "./limits-text.ts";

export const AGENT_FSOP_PATH = "/opt/pi-agent/fsop.mjs";
export const CHECK_LAUNCHER_PATH = "/opt/pi-check/run-check.mjs";
export const CHECK_OPS_PATH = "/opt/pi-check/ops.json";
export const LABEL_MANAGED = "pi-durable.managed";
export const LABEL_TASK = "pi-durable.task";
export const LABEL_GENERATION = "pi-durable.generation";
export const LABEL_KIND = "pi-durable.kind";

/** The launcher's own deadline trails the Coordinator's by this much, so the Coordinator's normally fires first. */
const LAUNCHER_DEADLINE_SLACK_MS = 5_000;
/** After a stop is requested, the attached docker client gets this long to exit before it is killed. */
const CLIENT_EXIT_GRACE_MS = 10_000;
const DOCKER_QUICK_MS = 20_000;
const DOCKER_START_MS = 60_000;
const MOUNT_UNSAFE = /[,"\n\r\0]/;
const USER_PATTERN = /^[1-9]\d*:\d+$/;
const DOCKER_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"DOCKER_HOST",
	"DOCKER_CONTEXT",
	"DOCKER_CONFIG",
	"DOCKER_CERT_PATH",
	"DOCKER_TLS_VERIFY",
	"DOCKER_API_VERSION",
	"XDG_RUNTIME_DIR",
];

export type DockerSandboxOptions = {
	readonly bin: string;
	readonly agentImage: string;
	readonly checkImage: string;
	/** uid:gid the containers run as; never root. */
	readonly user: string;
	readonly taskDir: string;
	readonly limits: Limits;
	readonly log: Logger;
	/** Repository-relative setup script path, passed to the launcher as PI_SETUP_SCRIPT. */
	readonly setupScript: string;
};

type Ready = {
	readonly agentImageId: string;
	readonly checkImageId: string;
	readonly ops: Readonly<Record<string, readonly string[]>>;
};

type DockerOutput = {
	readonly code: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly spawnFailed: boolean;
};

type ContainerState = {
	readonly started: boolean;
	readonly exitCode: number | undefined;
	readonly oomKilled: boolean;
};

type StopReason = "timeout" | "aborted" | "output";

type AttachedRun = {
	readonly clientCode: number | null;
	readonly stopReason: StopReason | undefined;
	readonly spawnFailed: boolean;
	readonly monitor: OutputMonitor;
};

/** Environment for the docker CLI: what it needs to find the daemon, nothing else (no Coordinator secrets). */
export function dockerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of DOCKER_ENV_KEYS) if (source[key] !== undefined) env[key] = source[key];
	return env;
}

/** Run one docker command (argv, no shell) with a deadline; output bounded. Never throws. */
export function runDocker(
	bin: string,
	args: readonly string[],
	options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<DockerOutput> {
	const maxBytes = options.maxBytes ?? 1024 * 1024;
	return new Promise((resolve) => {
		const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv(), shell: false });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let spawnFailed = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs ?? DOCKER_QUICK_MS);
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < maxBytes) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 16_384) stderr += chunk.toString("utf8");
		});
		child.on("error", () => {
			spawnFailed = true;
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut, spawnFailed });
		});
	});
}

function firstLine(text: string): string {
	return (text.split("\n").find((line) => line.trim() !== "") ?? "").trim().slice(0, 200);
}

function describeFailure(output: DockerOutput): string {
	if (output.spawnFailed) return "docker command not found";
	if (output.timedOut) return "docker did not answer in time";
	return firstLine(output.stderr) || `exit ${output.code}`;
}

function parseOps(text: string): Record<string, readonly string[]> {
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
	const ops: Record<string, readonly string[]> = {};
	for (const [op, argv] of Object.entries(parsed)) {
		if (!OP_NAME.test(op)) throw new Error("invalid operation name");
		if (!Array.isArray(argv) || argv.length === 0 || !argv.every((part) => typeof part === "string" && part !== "")) {
			throw new Error(`invalid argv for ${op}`);
		}
		ops[op] = Object.freeze([...argv]);
	}
	if (!Object.hasOwn(ops, "test")) throw new Error("no test operation");
	return ops;
}

/** What one attached check run showed, for `classifyCheck`. Docker's own failures are 125+ before a start. */
function checkFacts(run: AttachedRun, state: ContainerState | undefined): CheckFacts {
	const stopped = run.stopReason !== undefined;
	const clientStarted = run.clientCode !== null && run.clientCode < 125;
	return {
		spawnFailed: run.spawnFailed,
		started: state?.started ?? (stopped || clientStarted),
		exitCode: stopped ? undefined : (state?.exitCode ?? run.clientCode ?? undefined),
		timedOut: run.stopReason === "timeout",
		aborted: run.stopReason === "aborted",
		outputLimited: run.stopReason === "output",
		oomKilled: state?.oomKilled === true,
		processLimitSeen: run.monitor.processLimitSeen,
	};
}

export function createDockerSandbox(options: DockerSandboxOptions): Sandbox {
	const { bin, limits, log, user, setupScript } = options;
	const taskDir = options.taskDir;
	const opsByImage = new Map<string, Readonly<Record<string, readonly string[]>>>();
	let ready: Ready | undefined;
	let knownOps: readonly string[] = [];

	const docker = (args: readonly string[], timeoutMs?: number) => runDocker(bin, args, { timeoutMs });

	const labels = (taskId: number, generation: number, kind: string): string[] => [
		"--label",
		`${LABEL_MANAGED}=1`,
		"--label",
		`${LABEL_TASK}=${taskId}`,
		"--label",
		`${LABEL_GENERATION}=${generation}`,
		"--label",
		`${LABEL_KIND}=${kind}`,
	];

	// STUB(spec: capacity.md § Disk): no per-container disk quota; worktree and scratch writes are bounded only by
	// the task disk (a separate mount) and the free-space check at admission; the read-only root and the 64 MiB /tmp
	// tmpfs keep container writes off the boot disk.
	const hardening = (cpus: number, memoryMiB: number, pids: number): string[] => [
		"--pull",
		"never",
		"--network",
		"none",
		"--read-only",
		"--tmpfs",
		"/tmp:rw,size=64m,mode=1777,nosuid,nodev",
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		String(pids),
		"--cpus",
		String(cpus),
		"--memory",
		`${memoryMiB}m`,
		"--memory-swap",
		`${memoryMiB}m`,
		"--ulimit",
		"core=0",
		"--log-driver",
		"none",
		"--user",
		user,
	];

	const configProblem = (): string | undefined => {
		if (!USER_PATTERN.test(user)) return "container user must be uid:gid with a non-root uid";
		if (!validSetupScript(setupScript)) return "setup script path must be inside the repository";
		if (!isAbsolute(taskDir)) return "task directory must be an absolute path";
		return undefined;
	};

	const imageId = async (image: string, role: string): Promise<string> => {
		const output = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
		const id = output.stdout.trim();
		if (output.code !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) {
			throw new Error(`${role} image ${image} is missing (build it with scripts/build-images.sh)`);
		}
		return id;
	};

	const readOps = async (checkImageId: string): Promise<Readonly<Record<string, readonly string[]>>> => {
		const cached = opsByImage.get(checkImageId);
		if (cached !== undefined) return cached;
		const name = containerName("check", 0, 0);
		const output = await docker(
			[
				"run",
				"--rm",
				"--name",
				name,
				...labels(0, 0, "probe"),
				...hardening(limits.checkCpus, Math.min(limits.checkMemoryMiB, 256), 64),
				"--init",
				checkImageId,
				"cat",
				CHECK_OPS_PATH,
			],
			DOCKER_START_MS,
		);
		if (output.code !== 0) throw new Error(`check image operation list unreadable: ${describeFailure(output)}`);
		let ops: Record<string, readonly string[]>;
		try {
			ops = parseOps(output.stdout);
		} catch (error) {
			throw new Error(`check image operation list invalid: ${errorSummary(error)}`);
		}
		opsByImage.set(checkImageId, Object.freeze(ops));
		return ops;
	};

	const probe = async (): Promise<Ready> => {
		const problem = configProblem();
		if (problem !== undefined) throw new Error(problem);
		await ensureTaskLayout(taskDir);
		const version = await docker(["version", "--format", "{{.Server.Version}}"]);
		if (version.code !== 0) throw new Error(`docker is not available: ${describeFailure(version)}`);
		const agentImageId = await imageId(options.agentImage, "agent");
		const checkImageId = await imageId(options.checkImage, "check");
		const ops = await readOps(checkImageId);
		return { agentImageId, checkImageId, ops };
	};

	const available = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
		try {
			ready = await probe();
			knownOps = Object.keys(ready.ops).filter((op) => op !== "setup");
			log.info("sandbox_available", {
				agent_image: ready.agentImageId.slice(0, 19),
				check_image: ready.checkImageId.slice(0, 19),
				ops: knownOps.join(","),
			});
			return { ok: true };
		} catch (error) {
			ready = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			log.warn("sandbox_unavailable", { reason });
			return { ok: false, reason };
		}
	};

	const requireReady = async (): Promise<Ready> => {
		if (ready !== undefined) return ready;
		const result = await available();
		if (!result.ok || ready === undefined) throw new Error(`sandbox unavailable: ${result.ok ? "" : result.reason}`);
		return ready;
	};

	/** The worktree, resolved, inside `<taskDir>/worktrees/`, and safe to put into a --mount value. */
	const resolveWorktree = async (path: string): Promise<string> => {
		if (typeof path !== "string" || !isAbsolute(path)) throw new Error("worktree must be an absolute path");
		const real = await realpath(path);
		if (!(await stat(real)).isDirectory()) throw new Error("worktree is not a directory");
		const root = await realpath(join(taskDir, "worktrees"));
		if (!real.startsWith(root + sep)) throw new Error("worktree is outside the task directory's worktrees");
		if (MOUNT_UNSAFE.test(real)) throw new Error("worktree path cannot be mounted safely");
		return real;
	};

	const layoutFor = async (): Promise<TaskLayout> => {
		const layout = await ensureTaskLayout(await realpath(taskDir));
		if (MOUNT_UNSAFE.test(layout.emptyGit)) throw new Error("task directory path cannot be mounted safely");
		return layout;
	};

	/** Mount args hiding /work/.git: an empty read-only file (or directory, if the worktree's .git is one). */
	const gitMask = async (worktree: string, layout: TaskLayout, writable: boolean): Promise<string[]> => {
		let source = layout.emptyGit;
		try {
			if ((await lstat(join(worktree, ".git"))).isDirectory()) source = layout.emptyGitDir;
		} catch {
			// No .git in the worktree: nothing to hide on a read-only mount (and nothing can create one there).
			if (!writable) return [];
		}
		return ["--mount", `type=bind,src=${source},dst=/work/.git,readonly`];
	};

	const containerExists = async (name: string): Promise<boolean | undefined> => {
		const output = await docker(["container", "inspect", "--format", "{{.Id}}", name]);
		if (output.code === 0) return true;
		if (/no such (container|object)/i.test(output.stderr)) return false;
		return undefined;
	};

	/** `docker rm -f` until Docker no longer lists the container; throws if that cannot be confirmed in time. */
	const removeAndVerify = async (name: string): Promise<void> => {
		const deadline = Date.now() + Math.max(1_000, limits.stopGraceMs);
		for (;;) {
			await docker(["rm", "-f", name], DOCKER_QUICK_MS);
			if ((await containerExists(name)) === false) return;
			if (Date.now() > deadline) {
				log.error("container_stop_unconfirmed", { container: name });
				throw new Error(`container ${name}: stop unconfirmed`);
			}
			await sleep(250);
		}
	};

	const filterArgs = (filter?: ContainerFilter): string[] => {
		const args = ["--filter", `label=${LABEL_MANAGED}=1`];
		if (filter?.taskId !== undefined) args.push("--filter", `label=${LABEL_TASK}=${filter.taskId}`);
		if (filter?.generation !== undefined) args.push("--filter", `label=${LABEL_GENERATION}=${filter.generation}`);
		return args;
	};

	const live = async (filter?: ContainerFilter): Promise<string[]> => {
		const output = await docker(["ps", "-a", "--no-trunc", "--format", "{{.Names}}", ...filterArgs(filter)]);
		if (output.code !== 0) throw new Error(`cannot list containers: ${describeFailure(output)}`);
		return output.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "");
	};

	const removeAll = async (names: readonly string[]): Promise<void> => {
		for (let index = 0; index < names.length; index += 32) {
			await docker(["rm", "-f", ...names.slice(index, index + 32)], DOCKER_START_MS);
		}
	};

	/** Remove every matching container, retrying until none is listed or the stop grace passes; never throws on rm. */
	const killAll = async (filter?: ContainerFilter): Promise<void> => {
		const listed = await docker(["ps", "-aq", "--no-trunc", ...filterArgs(filter)]);
		if (listed.code !== 0) throw new Error(`cannot list containers: ${describeFailure(listed)}`);
		const ids = listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /^[0-9a-f]{12,64}$/.test(line));
		await removeAll(ids);
		const deadline = Date.now() + Math.max(1_000, limits.stopGraceMs);
		let remaining = ids.length === 0 ? [] : await live(filter);
		while (remaining.length > 0 && Date.now() < deadline) {
			await sleep(250);
			await removeAll(remaining);
			remaining = await live(filter);
		}
		log.info("containers_killed", { count: ids.length, remaining: remaining.length, task: filter?.taskId });
	};

	const agentHandle = (name: string, taskId: number, generation: number): AgentSandbox => {
		let stopped = false;
		return {
			name,
			fileOp(request: FsRequest, signal?: AbortSignal): Promise<FsResponse> {
				if (stopped) return Promise.resolve(fsError("unavailable", "the task container is not running"));
				return runFsop(bin, ["exec", "-i", name, "node", AGENT_FSOP_PATH, "/work"], request, {
					timeoutMs: FS_TIMEOUT_MS,
					signal,
					env: dockerEnv(),
				});
			},
			async stop(): Promise<void> {
				stopped = true;
				await removeAndVerify(name);
				log.info("agent_container_stopped", { task: taskId, generation, container: name });
			},
		};
	};

	const startAgent: Sandbox["startAgent"] = async (spec) => {
		if (!validIds(spec.taskId, spec.generation)) throw new Error("invalid task id or generation");
		if (!positiveFinite(spec.lifetimeMs)) throw new Error("invalid container lifetime");
		const current = await requireReady();
		const worktree = await resolveWorktree(spec.worktree);
		const layout = await layoutFor();
		const name = containerName("agent", spec.taskId, spec.generation);
		const lifetimeSeconds = Math.max(1, Math.ceil(spec.lifetimeMs / 1000));
		const args = [
			"run",
			"-d",
			"--rm",
			"--name",
			name,
			...labels(spec.taskId, spec.generation, "agent"),
			...hardening(limits.agentCpus, limits.agentMemoryMiB, limits.agentPids),
			"--mount",
			`type=bind,src=${worktree},dst=/work`,
			...(await gitMask(worktree, layout, true)),
			"-e",
			"HOME=/tmp",
			"-w",
			"/work",
			current.agentImageId,
			"sleep",
			String(lifetimeSeconds),
		];
		const output = await docker(args, DOCKER_START_MS);
		if (output.code !== 0) {
			await removeAndVerify(name).catch(() => {});
			log.error("agent_container_failed", { task: spec.taskId, generation: spec.generation, container: name });
			throw new Error(`agent container did not start: ${describeFailure(output)}`);
		}
		log.info("agent_container_started", { task: spec.taskId, generation: spec.generation, container: name });
		return agentHandle(name, spec.taskId, spec.generation);
	};

	/** Stops one check container: `docker rm -f` now and every second until the attached client exits. */
	const createStopper = (name: string, killClient: () => void) => {
		let reason: StopReason | undefined;
		let interval: NodeJS.Timeout | undefined;
		let clientTimer: NodeJS.Timeout | undefined;
		return {
			get reason(): StopReason | undefined {
				return reason;
			},
			request(next: StopReason): void {
				if (reason !== undefined) return;
				reason = next;
				void docker(["rm", "-f", name]);
				interval = setInterval(() => void docker(["rm", "-f", name]), 1_000);
				clientTimer = setTimeout(killClient, CLIENT_EXIT_GRACE_MS);
			},
			dispose(): void {
				clearInterval(interval);
				clearTimeout(clientTimer);
			},
		};
	};

	/** Run the attached `docker run`; stop it on the deadline, an abort or the total-output bound. */
	const runAttached = (
		name: string,
		args: readonly string[],
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<AttachedRun> => {
		const monitor = new OutputMonitor(limits.toolResultBytes);
		const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], env: dockerEnv(), shell: false });
		const stopper = createStopper(name, () => child.kill("SIGKILL"));
		const onAbort = (): void => stopper.request("aborted");
		const timer = setTimeout(() => stopper.request("timeout"), timeoutMs);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted === true) onAbort();
		const onData = (chunk: Buffer): void => {
			if (monitor.push(chunk)) stopper.request("output");
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		let spawnFailed = false;
		child.on("error", () => {
			spawnFailed = true;
		});
		return new Promise((resolve) => {
			child.on("close", (code) => {
				clearTimeout(timer);
				stopper.dispose();
				signal?.removeEventListener("abort", onAbort);
				resolve({ clientCode: code, stopReason: stopper.reason, spawnFailed, monitor });
			});
		});
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

	const cleanupScratch = async (scratch: string, current: Ready, taskId: number, generation: number) => {
		if (await removeScratch(scratch)) return;
		// Files left by another uid: delete them as that uid in a throwaway container, then remove the directory.
		await docker(
			[
				"run",
				"--rm",
				"--name",
				containerName("check", taskId, generation),
				...labels(taskId, generation, "cleanup"),
				...hardening(limits.checkCpus, Math.min(limits.checkMemoryMiB, 256), 64),
				"--mount",
				`type=bind,src=${scratch},dst=/scratch`,
				current.checkImageId,
				"find",
				"/scratch",
				"-mindepth",
				"1",
				"-delete",
			],
			DOCKER_START_MS,
		);
		if (!(await removeScratch(scratch))) log.warn("scratch_not_removed", { task: taskId, generation });
	};

	type CheckSpec = Parameters<Sandbox["runCheck"]>[0];

	type Prepared = { readonly current: Ready; readonly worktree: string; readonly layout: TaskLayout };

	const checkArgs = async (spec: CheckSpec, prepared: Prepared, scratch: string, name: string) => {
		const { current, worktree, layout } = prepared;
		const writable = spec.writable && spec.op === "setup";
		return [
			"run",
			"--name",
			name,
			...labels(spec.taskId, spec.generation, "check"),
			...hardening(limits.checkCpus, limits.checkMemoryMiB, limits.checkPids),
			"--init",
			"--mount",
			`type=bind,src=${worktree},dst=/work${writable ? "" : ",readonly"}`,
			...(await gitMask(worktree, layout, writable)),
			"--mount",
			`type=bind,src=${scratch},dst=/scratch`,
			"-e",
			"HOME=/scratch",
			"-e",
			"TMPDIR=/scratch/tmp",
			"-e",
			`PI_SETUP_SCRIPT=${setupScript}`,
			"-e",
			`PI_CHECK_DEADLINE_MS=${spec.timeoutMs + LAUNCHER_DEADLINE_SLACK_MS}`,
			"-w",
			"/work",
			current.checkImageId,
			"node",
			CHECK_LAUNCHER_PATH,
			spec.op,
		];
	};

	const runCheckContainer = async (
		spec: CheckSpec,
		prepared: Prepared,
		scratch: string,
		startedAt: number,
	): Promise<CheckResult> => {
		const name = containerName("check", spec.taskId, spec.generation);
		const args = await checkArgs(spec, prepared, scratch, name);
		const run = await runAttached(name, args, spec.timeoutMs, spec.signal);
		const state = run.stopReason === undefined ? await inspectState(name) : undefined;
		await removeAndVerify(name);
		const facts = checkFacts(run, state);
		const outcome = classifyCheck(facts);
		const trailer = outcomeTrailer(outcome, {
			timeoutMs: spec.timeoutMs,
			memoryMiB: limits.checkMemoryMiB,
			pids: limits.checkPids,
		});
		const durationMs = Date.now() - startedAt;
		log.info("check_finished", {
			task: spec.taskId,
			generation: spec.generation,
			op: spec.op,
			outcome,
			exit_code: facts.exitCode,
			duration_ms: durationMs,
			output_bytes: run.monitor.tail.totalBytes,
			container: name,
		});
		return {
			op: spec.op,
			outcome,
			exitCode: facts.exitCode,
			// A container that never started has only Docker's own error text (host paths); the model gets the trailer.
			output: withTrailer(facts.started ? run.monitor.tail.text() : "", trailer),
			truncated: facts.started && run.monitor.tail.truncated,
			durationMs,
		};
	};

	/** Image, operation and worktree for a check, or the result that rejects it. */
	const prepareCheck = async (spec: CheckSpec, startedAt: number): Promise<Prepared | CheckResult> => {
		let current: Ready;
		try {
			current = await requireReady();
		} catch {
			return rejectedCheck(spec.op, "unavailable", "the check sandbox is not available", startedAt);
		}
		if (!Object.hasOwn(current.ops, spec.op)) {
			const allowed = `unknown operation; allowed: ${knownOps.join(", ")}`;
			return rejectedCheck(spec.op, "unknown_operation", allowed, startedAt);
		}
		try {
			return { current, worktree: await resolveWorktree(spec.worktree), layout: await layoutFor() };
		} catch (error) {
			log.warn("check_worktree_rejected", { task: spec.taskId, reason: errorSummary(error) });
			return rejectedCheck(spec.op, "error", "the task worktree is not available", startedAt);
		}
	};

	const runCheck: Sandbox["runCheck"] = async (spec) => {
		const startedAt = Date.now();
		const rejected = precheckCheck(spec, startedAt);
		if (rejected !== undefined) return rejected;
		const prepared = await prepareCheck(spec, startedAt);
		if ("outcome" in prepared) return prepared;
		let scratch: string;
		try {
			scratch = await createScratch(prepared.layout.scratchRoot, user);
		} catch (error) {
			log.warn("check_scratch_failed", { task: spec.taskId, reason: errorSummary(error) });
			return rejectedCheck(spec.op, "error", "scratch space could not be created", startedAt);
		}
		try {
			return await runCheckContainer(spec, prepared, scratch, startedAt);
		} finally {
			await cleanupScratch(scratch, prepared.current, spec.taskId, spec.generation);
		}
	};

	return {
		available,
		startAgent,
		runCheck,
		checkOps: () => knownOps,
		killAll,
		live,
	};
}
