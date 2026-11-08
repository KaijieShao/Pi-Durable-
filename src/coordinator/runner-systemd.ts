/**
 * "systemd" isolation of Pi processes (Deployment § Processes: "Pi processes run as their own unprivileged user in a
 * dedicated systemd slice"; § Network: "Pi gets only its run key", the metadata server blocked for the Pi user).
 *
 * Each run is one transient service unit, started with `systemd-run --pipe --wait`:
 *
 *   unit     pi-run-<deployment>-r<runId>-g<generation>.service (derived again from the run row at restart cleanup)
 *   slice    PI_RUNNER_SLICE (default pi-durable-runs.slice), installed once on the host (deploy/systemd/)
 *   user     PI_RUNNER_USER / PI_RUNNER_GROUP (default pi-runner / pi-durable), never the Coordinator's user
 *   sandbox  NoNewPrivileges, empty capability bounding set, PrivateTmp, PrivateDevices, ProtectSystem=strict with
 *            only the conversations directory and the Pi home writable, ProtectHome, RestrictAddressFamilies,
 *            IPAddressDeny=any + IPAddressAllow=localhost (the relay is on 127.0.0.1; this also blocks the metadata
 *            server for Pi, on top of the host firewall rule in deploy/nftables/), TasksMax, MemoryMax,
 *            RuntimeMaxSec = run deadline + 60 s (an independent stop), KillMode=control-group, UMask=0007.
 *
 * `--pipe` passes only stdin, stdout and stderr, so the Pi process runs the stdio transport (src/runner/frames.ts).
 * The run key is the first stdin frame: it is never in argv, the unit's environment or its properties. Stdout
 * carries only frames; stderr (the Pi process's crash line and systemd-run's own messages) is counted, never logged.
 *
 * Kill = `systemctl kill --signal=SIGKILL <unit>` (every process of the unit's control group) plus SIGKILL of the
 * systemd-run client while it lives; the client's stdin is closed too, so a unit that systemd starts only after the
 * kill (a start still waiting for polkit) reads EOF after its frames and exits by itself. `exited` resolves only once
 * the client has exited AND systemd reports the unit inactive, so a confirmed stop means the whole unit is gone.
 * Liveness for restart cleanup is the unit's ActiveState; when systemctl cannot tell, the unit counts as alive (fail
 * closed: recovery then freezes the group). Restart cleanup also lists every unit of this deployment
 * (`pi-run-<deployment>-*`), whatever run it served, so nothing of this deployment in the slice survives it.
 *
 * `available()` fails closed when the isolation is unusable: not Linux, systemd-run or systemctl missing, the slice not
 * installed, node or the runner under a home directory (ProtectHome hides it from the Pi user), the data directory
 * layout of the one-time host setup missing, or the Pi user or group wrong as the host resolves them (a missing user,
 * uid 0 or the Coordinator's uid under another name; a group other than the conversations directory's)
 * (docs/isolation.md).
 */
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { deploymentId, runnerArgv } from "../runner/argv.ts";
import { encodeFrame, MAX_FRAME_BYTES, readFrames } from "../runner/frames.ts";
import { type FromRunner, isFromRunner, type RunnerStart, type ToRunner } from "../runner/protocol.ts";
import { errorSummary, type Logger } from "../runtime/log.ts";
import type { Availability, RunLauncher, RunnerExit, RunnerHandle, RunnerRef } from "./ports.ts";
import {
	checkTestEnv,
	drainStderr,
	FALLBACK_PATH,
	logNote,
	newOutputCounts,
	noteFields,
	type OutputCounts,
} from "./runner-common.ts";
import { defaultRunnerPath } from "./runner-launcher.ts";

export type SystemdLauncherOptions = {
	readonly dataDir: string;
	readonly log: Logger;
	/** The Pi user and group (PI_RUNNER_USER, PI_RUNNER_GROUP). */
	readonly user: string;
	readonly group: string;
	/** PI_RUNNER_SLICE. */
	readonly slice: string;
	/** SYSTEMD_RUN_BIN / SYSTEMCTL_BIN: absolute paths or names looked up on PATH. */
	readonly systemdRun: string;
	readonly systemctl: string;
	/** The runner entry; default `../runner/main.ts` next to this file (`main.js` when running from dist). */
	readonly runnerPath?: string;
	/** Node flags for the Pi process; default none. */
	readonly execArgv?: readonly string[];
	/** Per-unit limits; defaults 512M and 64 tasks (the slice carries the budget of all Pi processes together). */
	readonly memoryMax?: string;
	readonly tasksMax?: number;
	/** TEST ONLY: extra variables for the Pi process; only names starting with PI_RUNNER_TEST_ are accepted. */
	readonly testEnv?: Readonly<Record<string, string>>;
	/** TEST ONLY: the platform the availability check assumes (default process.platform); never set from config. */
	readonly platform?: NodeJS.Platform;
	/**
	 * TEST ONLY: the path prefixes ProtectHome=yes hides from the Pi user (default /home/, /root/, /run/user/); the
	 * systemd-run stand-ins of the tests hide nothing, so a checkout under /home still runs them. Never set from config.
	 */
	readonly protectedHomes?: readonly string[];
	/**
	 * TEST ONLY: how the Pi user's uid and the Pi group's gid are resolved (default `id -u` and `getent group`); the
	 * stand-ins of the tests run as this user, where no Pi user exists. Never set from config.
	 */
	readonly accounts?: Accounts;
};

/** Resolves account names to ids; undefined when the name does not exist (or cannot be resolved). */
export type Accounts = {
	uid(user: string): number | undefined;
	gid(group: string): number | undefined;
};

/** Independent stop: systemd ends the unit this long after the run deadline even if nobody else does. */
export const UNIT_RUNTIME_MARGIN_MS = 60_000;
const DEFAULT_MEMORY_MAX = "512M";
const DEFAULT_TASKS_MAX = 64;
const COMMAND_TIMEOUT_MS = 10_000;
/** Polling for the unit to be gone after its client exited: first delays, then every last one, up to the bound. */
const GONE_POLL_MS = [20, 50, 100, 200, 500, 1000, 2000] as const;
const GONE_POLL_LIMIT_MS = 15 * 60_000;
/** Arguments that reach systemd: no whitespace, `$` (environment expansion), `%` (specifiers), quotes or `\`. */
const SAFE_WORD = /^[\w./=:@+,-]+$/;
const SAFE_PATH = /^\/[\w./@+-]*$/;
const UNIT_NAME_PART = /^[a-z_][a-z0-9_-]{0,31}$/;
const SLICE_NAME = /^[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*\.slice$/;
const MEMORY = /^[1-9]\d{0,5}[KMG]$/;
/** Paths ProtectHome=yes hides from the Pi process. */
const HOME_ROOTS: readonly string[] = ["/home/", "/root/", "/run/user/"];

/** What one transient unit runs and how it is confined. Exported for tests (the argv is built from it). */
export type UnitSpec = {
	readonly unit: string;
	readonly slice: string;
	readonly user: string;
	readonly group: string;
	/** HOME and working directory of the Pi process. */
	readonly home: string;
	/** ReadWritePaths (everything else is read-only under ProtectSystem=strict). */
	readonly writable: readonly string[];
	readonly env: Readonly<Record<string, string>>;
	readonly runtimeMaxSec: number;
	readonly memoryMax: string;
	readonly tasksMax: number;
	/** The command: node, its flags, the runner path and the runner's arguments. */
	readonly command: readonly string[];
};

/** The unit of one start of a run (a run's generation changes with every dispatch). */
export function unitName(deployment: string, runId: number, generation: number): string {
	return `pi-run-${deployment}-r${runId}-g${generation}.service`;
}

/** The systemd-run arguments for one unit; throws if any value is unsafe to hand to systemd. */
export function systemdRunArgs(spec: UnitSpec): string[] {
	checkUnitSpec(spec);
	return [
		`--unit=${spec.unit}`,
		`--slice=${spec.slice}`,
		`--uid=${spec.user}`,
		`--gid=${spec.group}`,
		"--pipe",
		"--wait",
		"--collect",
		"--quiet",
		"--no-ask-password",
		`--working-directory=${spec.home}`,
		...Object.entries(spec.env).map(([name, value]) => `--setenv=${name}=${value}`),
		...unitProperties(spec).map((property) => `--property=${property}`),
		"--",
		...spec.command,
	];
}

/** The unit's sandbox and limits (see the module comment). */
export function unitProperties(spec: UnitSpec): string[] {
	return [
		"Type=exec",
		"NoNewPrivileges=yes",
		"CapabilityBoundingSet=",
		"PrivateTmp=yes",
		"PrivateDevices=yes",
		"ProtectSystem=strict",
		"ProtectHome=yes",
		`ReadWritePaths=${spec.writable.join(" ")}`,
		"ProtectKernelTunables=yes",
		"ProtectKernelModules=yes",
		"ProtectControlGroups=yes",
		"ProtectProc=invisible",
		"RestrictNamespaces=yes",
		"RestrictSUIDSGID=yes",
		"RestrictRealtime=yes",
		"LockPersonality=yes",
		"RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
		"IPAddressDeny=any",
		"IPAddressAllow=localhost",
		`RuntimeMaxSec=${spec.runtimeMaxSec}`,
		`TasksMax=${spec.tasksMax}`,
		`MemoryMax=${spec.memoryMax}`,
		"KillMode=control-group",
		"UMask=0007",
	];
}

const isSafePath = (path: string): boolean => SAFE_PATH.test(path);
const isSafeEnv = ([name, value]: readonly [string, string]): boolean =>
	/^[A-Z_][A-Z0-9_]*$/.test(name) && SAFE_WORD.test(value);
const isCount = (value: number): boolean => Number.isInteger(value) && value > 0;

/** Each rule: what must hold, and what is unsafe otherwise. */
const SPEC_RULES: readonly (readonly [(spec: UnitSpec) => boolean, string])[] = [
	[(spec) => /^pi-run-[0-9a-f]{16}-r\d+-g\d+\.service$/.test(spec.unit), "unit"],
	[(spec) => SLICE_NAME.test(spec.slice), "slice"],
	[(spec) => UNIT_NAME_PART.test(spec.user) && UNIT_NAME_PART.test(spec.group), "user or group"],
	[(spec) => [spec.home, ...spec.writable].every(isSafePath), "path"],
	[(spec) => Object.entries(spec.env).every(isSafeEnv), "environment"],
	[(spec) => isCount(spec.runtimeMaxSec), "runtime"],
	[(spec) => MEMORY.test(spec.memoryMax) && isCount(spec.tasksMax), "limits"],
	[(spec) => isSafePath(spec.command[0] ?? "") && spec.command.every((word) => SAFE_WORD.test(word)), "command"],
];

function checkUnitSpec(spec: UnitSpec): void {
	const broken = SPEC_RULES.find(([holds]) => !holds(spec));
	if (broken !== undefined) throw new Error(`unsafe systemd unit ${broken[1]}`);
}

type Settings = {
	readonly dataDir: string;
	readonly log: Logger;
	readonly user: string;
	readonly group: string;
	readonly slice: string;
	readonly systemdRun: string;
	readonly systemctl: string;
	readonly runnerPath: string;
	readonly nodePath: string;
	readonly execArgv: readonly string[];
	readonly memoryMax: string;
	readonly tasksMax: number;
	readonly testEnv: Readonly<Record<string, string>>;
	readonly platform: NodeJS.Platform;
	readonly protectedHomes: readonly string[];
	readonly accounts: Accounts;
	readonly deployment: string;
	/** PATH of the systemd-run / systemctl clients (and for looking them up). */
	readonly clientPath: string;
	readonly conversations: string;
	readonly home: string;
};

export function createSystemdRunLauncher(options: SystemdLauncherOptions): RunLauncher {
	const settings: Settings = {
		dataDir: options.dataDir,
		log: options.log,
		user: options.user,
		group: options.group,
		slice: options.slice,
		systemdRun: options.systemdRun,
		systemctl: options.systemctl,
		runnerPath: options.runnerPath ?? defaultRunnerPath(),
		nodePath: process.execPath,
		execArgv: [...(options.execArgv ?? [])],
		memoryMax: options.memoryMax ?? DEFAULT_MEMORY_MAX,
		tasksMax: options.tasksMax ?? DEFAULT_TASKS_MAX,
		testEnv: checkTestEnv(options.testEnv),
		platform: options.platform ?? process.platform,
		protectedHomes: options.protectedHomes ?? HOME_ROOTS,
		accounts: options.accounts ?? systemAccounts(process.env.PATH ?? FALLBACK_PATH),
		deployment: deploymentId(options.dataDir),
		clientPath: process.env.PATH ?? FALLBACK_PATH,
		conversations: join(options.dataDir, "conversations"),
		home: join(options.dataDir, "run-home"),
	};
	return {
		isolation: "systemd",
		available: () => checkAvailable(settings),
		launch: (start, runKey, onMessage, run) => launchUnit(settings, start, runKey, onMessage, run.generation),
		isRunner: (ref) => unitMayBeAlive(settings, ref),
		killRunner: (ref) => killLeftover(settings, ref),
		leftovers: () => listUnits(settings),
	};
}

/** The unit spec of one start: the runner over stdio, group-shared conversation files, the markers. */
function unitSpecFor(s: Settings, unit: string, start: RunnerStart): UnitSpec {
	const args = runnerArgv({
		transport: "stdio",
		conversationAccess: "group",
		deployment: s.deployment,
		runId: start.runId,
	});
	return {
		unit,
		slice: s.slice,
		user: s.user,
		group: s.group,
		home: s.home,
		writable: [s.conversations, s.home],
		env: { HOME: s.home, PATH: FALLBACK_PATH, NODE_NO_WARNINGS: "1", ...s.testEnv },
		runtimeMaxSec: Math.ceil((start.limits.deadlineMs + UNIT_RUNTIME_MARGIN_MS) / 1000),
		memoryMax: s.memoryMax,
		tasksMax: s.tasksMax,
		command: [s.nodePath, ...s.execArgv, s.runnerPath, ...args],
	};
}

type LaunchState = {
	exited: boolean;
	/** The systemd-run client has exited (its pid may be reused from then on: never signal it again). */
	clientExited: boolean;
	/** kill() was called: every poll that still sees the unit alive kills it again (it may have started late). */
	killed: boolean;
};

function launchUnit(
	s: Settings,
	start: RunnerStart,
	runKey: string,
	onMessage: (message: FromRunner) => void,
	generation: number,
): RunnerHandle {
	const unit = unitName(s.deployment, start.runId, generation);
	const args = systemdRunArgs(unitSpecFor(s, unit, start));
	const child = spawn(s.systemdRun, args, {
		env: { PATH: s.clientPath },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	const meta = { runId: start.runId, taskId: start.taskId, pid: child.pid, unit };
	const counts = newOutputCounts();
	const state: LaunchState = { exited: false, clientExited: false, killed: false };
	child.stdin?.on("error", () => {});
	if (child.stdout !== null) readFrames(child.stdout, frameRouter(s.log, meta, counts, onMessage), MAX_FRAME_BYTES);
	drainStderr(child.stderr, counts);
	const exited = watchExit(s, child, unit, { meta, counts, state });
	s.log.info("runner_launched", { ...meta, fresh: start.fresh, steers: start.steers.length, isolation: "systemd" });
	// The run key first, then the start message: the key never travels anywhere else.
	writeFrame(child, { type: "key", key: runKey }, s.log, meta);
	writeFrame(child, start, s.log, meta);
	return {
		pid: child.pid,
		send: (message: ToRunner) => writeFrame(child, message, s.log, meta),
		kill: () => {
			if (state.exited) return;
			state.killed = true;
			killUnit(s, unit, child, state);
		},
		exited,
	};
}

function frameRouter(
	log: Logger,
	meta: Readonly<Record<string, unknown>>,
	counts: OutputCounts,
	onMessage: (message: FromRunner) => void,
) {
	return {
		frame(value: unknown): void {
			if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "note") {
				logNote(log, meta, noteFields(value), counts);
				return;
			}
			if (!isFromRunner(value)) {
				log.warn("runner_bad_message", meta);
				return;
			}
			try {
				onMessage(value);
			} catch (error) {
				log.error("runner_message_handler_failed", { ...meta, type: value.type, error: errorSummary(error) });
			}
		},
		invalid(kind: "json" | "oversize"): void {
			counts.stdoutLines++;
			if (kind === "oversize") log.warn("runner_frame_oversize", meta);
		},
		end(): void {},
	};
}

function writeFrame(child: ChildProcess, message: object, log: Logger, meta: Readonly<Record<string, unknown>>): void {
	const stdin = child.stdin;
	const type = (message as { type?: unknown }).type;
	if (stdin === null || !stdin.writable) {
		log.debug("runner_send_skipped", { ...meta, type });
		return;
	}
	try {
		stdin.write(encodeFrame(message), (error) => {
			if (error) log.warn("runner_send_failed", { ...meta, type });
		});
	} catch {
		log.warn("runner_send_failed", { ...meta, type });
	}
}

type ExitContext = {
	readonly meta: Readonly<Record<string, unknown>>;
	readonly counts: OutputCounts;
	readonly state: LaunchState;
};

/** Resolves once the systemd-run client has exited and the unit is verified gone (never on the client alone). */
function watchExit(s: Settings, child: ChildProcess, unit: string, context: ExitContext): Promise<RunnerExit> {
	const { meta, counts, state } = context;
	return new Promise<RunnerExit>((resolve) => {
		const finish = (exit: RunnerExit): void => {
			if (state.exited) return;
			state.exited = true;
			s.log.info("runner_exit", { ...meta, code: exit.code ?? undefined, signal: exit.signal ?? undefined, ...counts });
			resolve(exit);
		};
		child.once("exit", (code, signal) => {
			state.clientExited = true;
			void untilUnitGone(s, unit, state).then((gone) => {
				if (gone) finish({ code, signal });
				else s.log.error("runner_unit_not_gone", meta);
			});
		});
		child.once("error", (error) => {
			s.log.error("runner_process_error", { ...meta, error: errorSummary(error) });
			// A spawn failure emits no "exit" and started no unit.
			if (child.pid === undefined) finish({ code: null, signal: null });
		});
	});
}

async function untilUnitGone(s: Settings, unit: string, state: LaunchState): Promise<boolean> {
	const started = Date.now();
	for (let attempt = 0; Date.now() - started < GONE_POLL_LIMIT_MS; attempt++) {
		if ((await unitState(s, unit)) === "gone") return true;
		if (state.killed) systemctlKill(s, unit);
		const delay = GONE_POLL_MS[Math.min(attempt, GONE_POLL_MS.length - 1)] ?? 2000;
		await new Promise((resolve) => setTimeout(resolve, delay).unref());
	}
	return false;
}

function systemctlKill(s: Settings, unit: string): void {
	execFile(
		s.systemctl,
		["--no-ask-password", "kill", "--signal=SIGKILL", "--", unit],
		{ env: { PATH: s.clientPath }, timeout: COMMAND_TIMEOUT_MS },
		(error) => {
			if (error) s.log.warn("runner_unit_kill_failed", { unit });
		},
	);
}

/**
 * SIGKILL every process of the unit, and the systemd-run client (its own process group) while it lives. Its stdin is
 * closed: a Pi process that starts after this reads EOF and exits (the runner's "Coordinator gone" path).
 */
function killUnit(s: Settings, unit: string, child: ChildProcess, state: LaunchState): void {
	systemctlKill(s, unit);
	child.stdin?.destroy();
	const pid = child.pid;
	if (pid === undefined || state.clientExited) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			// Already gone.
		}
	}
}

type UnitState = "alive" | "gone" | "unknown";

const GONE_STATES: ReadonlySet<string> = new Set(["inactive", "failed"]);

function classifyState(status: number | null, stdout: unknown): UnitState {
	if (status !== 0 || typeof stdout !== "string") return "unknown";
	const value = stdout.trim();
	if (value === "") return "unknown";
	return GONE_STATES.has(value) ? "gone" : "alive";
}

function unitState(s: Settings, unit: string): Promise<UnitState> {
	return new Promise((resolve) => {
		execFile(
			s.systemctl,
			["--no-ask-password", "show", "--property=ActiveState", "--value", "--", unit],
			{ env: { PATH: s.clientPath }, timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) => resolve(classifyState(error === null ? 0 : 1, stdout)),
		);
	});
}

function unitStateSync(s: Settings, unit: string): UnitState {
	const result = spawnSync(
		s.systemctl,
		["--no-ask-password", "show", "--property=ActiveState", "--value", "--", unit],
		{
			env: { PATH: s.clientPath },
			timeout: COMMAND_TIMEOUT_MS,
			encoding: "utf8",
		},
	);
	return classifyState(result.error === undefined ? result.status : null, result.stdout);
}

/** Restart cleanup: the unit of this start may still run (unknown counts as alive). */
function unitMayBeAlive(s: Settings, ref: RunnerRef): boolean {
	return unitStateSync(s, unitName(s.deployment, ref.runId, ref.generation)) !== "gone";
}

/** Restart cleanup: SIGKILL the unit, and its systemd-run client if that is still around. */
function killLeftover(s: Settings, ref: RunnerRef): void {
	const unit = unitName(s.deployment, ref.runId, ref.generation);
	spawnSync(s.systemctl, ["--no-ask-password", "kill", "--signal=SIGKILL", "--", unit], {
		env: { PATH: s.clientPath },
		timeout: COMMAND_TIMEOUT_MS,
		stdio: "ignore",
	});
	if (ref.pid !== null && isUnitClient(s, ref.pid, unit)) {
		for (const target of [-ref.pid, ref.pid]) {
			try {
				process.kill(target, "SIGKILL");
			} catch {
				// Gone already.
			}
		}
	}
}

/**
 * Restart cleanup, deployment-wide: every loaded unit of this deployment (`pi-run-<deployment>-*`, any run, any
 * generation; isRunner then tells which still run). Undefined when systemctl cannot list them (recovery then
 * freezes the group: the slice is not verified empty). None on a host that is not Linux: no systemd unit exists there.
 */
function listUnits(s: Settings): RunnerRef[] | undefined {
	if (s.platform !== "linux") return [];
	const result = spawnSync(
		s.systemctl,
		[
			"--no-ask-password",
			"list-units",
			"--all",
			"--plain",
			"--no-legend",
			"--full",
			"--type=service",
			`pi-run-${s.deployment}-*.service`,
		],
		{ env: { PATH: s.clientPath }, timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" },
	);
	if (result.error !== undefined || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	const unitOf = new RegExp(`^pi-run-${s.deployment}-r(\\d+)-g(\\d+)\\.service$`);
	const units = new Set(result.stdout.split(/\s+/).filter((word) => unitOf.test(word)));
	return [...units].map((name) => {
		const [, runId, generation] = unitOf.exec(name) ?? [];
		return { runId: Number(runId), generation: Number(generation), pid: null };
	});
}

/** True if `pid` is the systemd-run client of `unit` (or a Pi process of this deployment and run, e.g. in tests). */
function isUnitClient(s: Settings, pid: number, unit: string): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	const result = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: COMMAND_TIMEOUT_MS,
		env: { PATH: s.clientPath },
	});
	if (result.status !== 0 || typeof result.stdout !== "string") return false;
	const words = new Set(result.stdout.trim().split(/\s+/));
	return words.has(`--unit=${unit}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Availability (fails closed)

type Check = (s: Settings) => Promise<string | undefined>;

const CHECKS: readonly Check[] = [
	checkPlatform,
	checkBinaries,
	checkInstallPaths,
	checkSlice,
	checkLayout,
	checkAccounts,
];

async function checkAvailable(s: Settings): Promise<Availability> {
	for (const check of CHECKS) {
		const problem = await check(s).catch(() => "the systemd isolation check failed");
		if (problem !== undefined) return { ok: false, reason: problem };
	}
	return { ok: true };
}

async function checkPlatform(s: Settings): Promise<string | undefined> {
	return s.platform === "linux" ? undefined : "systemd isolation needs Linux";
}

async function checkBinaries(s: Settings): Promise<string | undefined> {
	if (!(await findExecutable(s.systemdRun, s.clientPath))) return "systemd-run is not available";
	if (!(await findExecutable(s.systemctl, s.clientPath))) return "systemctl is not available";
	return undefined;
}

async function checkInstallPaths(s: Settings): Promise<string | undefined> {
	const hidden = [s.nodePath, s.runnerPath].some((path) => s.protectedHomes.some((root) => path.startsWith(root)));
	if (hidden) return "node or the runner is installed under a home directory, which ProtectHome hides from Pi";
	const unsafe = [s.nodePath, s.runnerPath, s.conversations, s.home].some((path) => !SAFE_PATH.test(path));
	return unsafe ? "an install or data path contains characters systemd would interpret" : undefined;
}

async function checkSlice(s: Settings): Promise<string | undefined> {
	const result = await new Promise<string | undefined>((resolve) => {
		execFile(
			s.systemctl,
			["--no-ask-password", "show", "--property=LoadState", "--value", "--", s.slice],
			{ env: { PATH: s.clientPath }, timeout: COMMAND_TIMEOUT_MS, encoding: "utf8" },
			(error, stdout) => resolve(error === null ? stdout.trim() : undefined),
		);
	});
	return result === "loaded" ? undefined : "the Pi slice is not installed";
}

/**
 * The one-time host setup (docs/isolation.md): the data directory traversable by the shared group only, the
 * conversations directory shared with it (setgid, mode 2770, same group), the Pi home private to its owner.
 */
async function checkLayout(s: Settings): Promise<string | undefined> {
	const [data, conversations, home] = await Promise.all(
		[s.dataDir, s.conversations, s.home].map((path) => stat(path).catch(() => undefined)),
	);
	if (conversations === undefined || !conversations.isDirectory() || (conversations.mode & 0o7777) !== 0o2770)
		return "the conversations directory is not set up for the Pi group (setgid, mode 2770)";
	if (data === undefined || (data.mode & 0o007) !== 0 || (data.mode & 0o010) === 0 || data.gid !== conversations.gid)
		return "the data directory is not traversable by the Pi group only (mode 0710, same group)";
	if (home === undefined || !home.isDirectory() || (home.mode & 0o077) !== 0)
		return "the Pi home directory is missing or not private to the Pi user";
	return undefined;
}

/**
 * The Pi user and group as the host resolves them, not only by name: the user exists and is neither root nor the
 * Coordinator's own user; the group exists, is not root's, and is the conversations directory's group (the one the
 * host setup shares with the Coordinator, never e.g. a group with access to the Docker socket).
 */
async function checkAccounts(s: Settings): Promise<string | undefined> {
	const uid = UNIT_NAME_PART.test(s.user) ? s.accounts.uid(s.user) : undefined;
	if (uid === undefined) return "the Pi user does not exist";
	if (uid === 0 || uid === process.getuid?.()) return "the Pi user is root or the Coordinator's own user";
	const gid = UNIT_NAME_PART.test(s.group) ? s.accounts.gid(s.group) : undefined;
	if (gid === undefined || gid === 0) return "the Pi group does not exist or is root's";
	const conversations = await stat(s.conversations).catch(() => undefined);
	return conversations?.gid === gid ? undefined : "the conversations directory does not belong to the Pi group";
}

/** `id -u <user>` and `getent group <group>` (Linux; the availability check runs them only there). */
function systemAccounts(path: string): Accounts {
	const run = (command: string, args: readonly string[]): string | undefined => {
		const result = spawnSync(command, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, env: { PATH: path } });
		return result.error === undefined && result.status === 0 ? result.stdout.trim() : undefined;
	};
	const id = (text: string | undefined): number | undefined =>
		text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
	return {
		uid: (user) => id(run("id", ["-u", user])),
		gid: (group) => id(run("getent", ["group", group])?.split(":")[2]),
	};
}

/** An absolute executable path, or a name found executable on PATH. */
async function findExecutable(bin: string, path: string): Promise<boolean> {
	const candidates = isAbsolute(bin)
		? [bin]
		: bin.includes("/")
			? []
			: path
					.split(delimiter)
					.filter((dir) => isAbsolute(dir))
					.map((dir) => join(dir, bin));
	for (const candidate of candidates) {
		const ok = await access(candidate, fsConstants.X_OK).then(
			() => stat(candidate).then((info) => info.isFile()),
			() => false,
		);
		if (ok) return true;
	}
	return false;
}
