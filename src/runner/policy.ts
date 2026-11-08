/**
 * Tool-call policy (Agent Execution § Policy Hook): explicit allow rules for `read`, `edit`, `write` and the listed
 * `run_check` operations; everything else is denied. Pure functions with no I/O, so the Pi process's `beforeTool` hook
 * and the Coordinator's tool executor (the second layer) apply exactly the same rules.
 *
 * Paths are checked textually here: relative to the worktree root, no `..`, no absolute or drive paths, no `.git`
 * segment (in any case, or with trailing dots/spaces that some file systems ignore), no NUL, control or invisible
 * format characters, no backslashes, no leading `~`. Symlinks cannot be seen from the Pi process (it has no view of the
 * worktree); the container's confined file operation refuses them on every path component. Protected files are never
 * mounted, so these rules are a second layer, not the only one.
 */
import type { FsRequest } from "../coordinator/ports.ts";
import type { ToolName } from "./protocol.ts";

export const TOOL_NAMES: readonly ToolName[] = Object.freeze(["read", "edit", "write", "run_check"]);

/**
 * The tool policy's version, recorded with every trial (Evaluation § Frozen Before Trial 1: "the tool policy
 * version"). Bump it whenever the tool surface, these allow rules, the container's file-operation confinement
 * (deploy/docker/fsop.mjs) or the run_check launcher's rules change; the agent and check image ids are recorded too.
 */
export const TOOL_POLICY_VERSION = "1";

/** Bounds on arguments, matching the container's file operation (deploy/docker/fsop.mjs). */
export const POLICY_LIMITS = Object.freeze({
	/** UTF-8 bytes of a whole path. */
	pathBytes: 4096,
	/** UTF-8 bytes of one path segment. */
	segmentBytes: 255,
	/** Path segments (depth). */
	segments: 64,
	/** UTF-8 bytes of `write` content and of `edit` old/new text. */
	contentBytes: 1024 * 1024,
	/** Largest `read` offset (1-based line) and limit (lines). */
	maxLine: 10_000_000,
});

export type ReadArgs = { readonly path: string; readonly offset?: number; readonly limit?: number };
export type WriteArgs = { readonly path: string; readonly content: string };
export type EditArgs = {
	readonly path: string;
	readonly oldText: string;
	readonly newText: string;
	readonly replaceAll?: boolean;
};
export type RunCheckArgs = { readonly operation: string };

/** An allowed call with its normalized arguments (the path in canonical relative form). */
export type AllowedCall =
	| { readonly tool: "read"; readonly args: ReadArgs }
	| { readonly tool: "write"; readonly args: WriteArgs }
	| { readonly tool: "edit"; readonly args: EditArgs }
	| { readonly tool: "run_check"; readonly args: RunCheckArgs };

export type PolicyDecision =
	| { readonly allowed: true; readonly call: AllowedCall }
	| { readonly allowed: false; readonly reason: string };

export type PathDecision =
	| { readonly ok: true; readonly path: string }
	| { readonly ok: false; readonly reason: string };

// Control characters, invisible format characters (zero-width joiners and similar, which some file systems ignore when
// comparing names), private-use and lone surrogates, line and paragraph separators.
const FORBIDDEN_CHARS = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]/u;
const GIT_SEGMENT = /^\.git[. ]*$/i;
const DRIVE = /^[A-Za-z]:/;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** Whole-path rules, in order; the first that matches refuses the path. */
const PATH_RULES: readonly (readonly [(path: string) => boolean, string])[] = [
	[(path) => path.length === 0, "path is empty"],
	[(path) => path.includes("\0"), "path contains a NUL character"],
	[(path) => FORBIDDEN_CHARS.test(path), "path contains control or invisible characters"],
	[(path) => path.normalize("NFC") !== path, "path is not in Unicode normal form C"],
	[(path) => byteLength(path) > POLICY_LIMITS.pathBytes, "path is too long"],
	[(path) => path.includes("\\"), "path contains a backslash; use / as the separator"],
	[(path) => path.startsWith("/"), "absolute paths are not allowed; use a path relative to the project root"],
	[(path) => DRIVE.test(path), "drive paths are not allowed; use a path relative to the project root"],
	[(path) => path.startsWith("~"), "home-relative paths are not allowed; use a path relative to the project root"],
];

/** Per-segment rules (after `.` and empty segments are dropped). */
const SEGMENT_RULES: readonly (readonly [(segment: string) => boolean, string])[] = [
	[(segment) => segment === "..", "path must not contain '..'"],
	[(segment) => GIT_SEGMENT.test(segment), "git data (.git) is not accessible"],
	[(segment) => segment.trim() !== segment, "path segments must not start or end with spaces"],
	[(segment) => byteLength(segment) > POLICY_LIMITS.segmentBytes, "a path segment is too long"],
];

/**
 * Confine one path to the worktree root: returns it in canonical form (`./` and empty segments removed, `/` separated)
 * or the reason it is refused. Never touches the file system.
 */
export function confinePath(path: unknown): PathDecision {
	if (typeof path !== "string") return refuse("path must be a string");
	const broken = PATH_RULES.find(([matches]) => matches(path));
	if (broken !== undefined) return refuse(broken[1]);
	const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
	for (const segment of segments) {
		const bad = SEGMENT_RULES.find(([matches]) => matches(segment));
		if (bad !== undefined) return refuse(bad[1]);
	}
	if (segments.length === 0) return refuse("path names the project root, not a file");
	if (segments.length > POLICY_LIMITS.segments) return refuse("path is too deep");
	return { ok: true, path: segments.join("/") };
}

/**
 * Decide one tool call: the allow rules for the four tools, in order; anything else is denied. `args` is untrusted
 * model output. Unknown argument names are refused (the tool schemas are closed). Fails closed on anything unexpected.
 */
export function evaluateToolCall(
	name: unknown,
	args: unknown,
	options: { readonly checkOps: readonly string[] },
): PolicyDecision {
	try {
		if (typeof name !== "string" || !Object.hasOwn(DECIDERS, name)) {
			return deny(`tool ${typeof name === "string" ? JSON.stringify(name.slice(0, 64)) : "?"} is not allowed`);
		}
		if (typeof args !== "object" || args === null || Array.isArray(args)) return deny("arguments must be an object");
		const decider = DECIDERS[name as ToolName];
		return { allowed: true, call: decider(args as Record<string, unknown>, options.checkOps) };
	} catch (error) {
		return deny(error instanceof Refusal ? error.message : "the policy could not evaluate this call");
	}
}

/** A rule refused the call; its message is the reason the model sees. */
class Refusal extends Error {}

type Decider = (args: Record<string, unknown>, checkOps: readonly string[]) => AllowedCall;

const DECIDERS: Readonly<Record<ToolName, Decider>> = {
	read: (args) => {
		onlyKeys(args, ["path", "offset", "limit"]);
		const offset = line(args.offset, "offset", 0);
		const limit = line(args.limit, "limit", 1);
		return {
			tool: "read",
			args: {
				path: confined(args.path),
				...(offset === undefined ? {} : { offset }),
				...(limit === undefined ? {} : { limit }),
			},
		};
	},
	write: (args) => {
		onlyKeys(args, ["path", "content"]);
		return { tool: "write", args: { path: confined(args.path), content: text(args.content, "content", true) } };
	},
	edit: (args) => {
		onlyKeys(args, ["path", "oldText", "newText", "replaceAll"]);
		const path = confined(args.path);
		const oldText = text(args.oldText, "oldText", false);
		const newText = text(args.newText, "newText", true);
		if (args.replaceAll !== undefined && typeof args.replaceAll !== "boolean") {
			throw new Refusal("replaceAll must be a boolean");
		}
		const replaceAll = args.replaceAll === undefined ? {} : { replaceAll: args.replaceAll };
		return { tool: "edit", args: { path, oldText, newText, ...replaceAll } };
	},
	run_check: (args, checkOps) => {
		onlyKeys(args, ["operation"]);
		const operation = args.operation;
		if (typeof operation !== "string") throw new Refusal("operation must be a string");
		if (!checkOps.includes(operation)) {
			const listed = checkOps.length === 0 ? "none are available" : `allowed: ${checkOps.join(", ")}`;
			throw new Refusal(`operation ${JSON.stringify(operation.slice(0, 64))} is not on the approved list (${listed})`);
		}
		return { tool: "run_check", args: { operation } };
	},
};

function confined(path: unknown): string {
	const decision = confinePath(path);
	if (!decision.ok) throw new Refusal(decision.reason);
	return decision.path;
}

/** The container file operation for an allowed `read`, `edit` or `write`; undefined for `run_check`. */
export function toFsRequest(call: AllowedCall): FsRequest | undefined {
	switch (call.tool) {
		case "read":
			return { op: "read", ...call.args };
		case "write":
			return { op: "write", ...call.args };
		case "edit":
			return { op: "edit", ...call.args };
		case "run_check":
			return undefined;
	}
}

/** One-line, metadata-only description of an allowed call (tool name and path or operation), for progress lines. */
export function describeCall(call: AllowedCall): string {
	const target = call.tool === "run_check" ? call.args.operation : call.args.path;
	return `${call.tool} ${target.length > 120 ? `${target.slice(0, 117)}...` : target}`;
}

function deny(reason: string): PolicyDecision {
	return { allowed: false, reason };
}

function refuse(reason: string): PathDecision {
	return { ok: false, reason };
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
	const extra = Object.keys(record).find((key) => !allowed.includes(key));
	if (extra !== undefined) throw new Refusal(`unexpected argument ${JSON.stringify(extra.slice(0, 64))}`);
}

function line(value: unknown, name: string, minimum: number): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > POLICY_LIMITS.maxLine) {
		throw new Refusal(`${name} must be an integer from ${minimum} to ${POLICY_LIMITS.maxLine}`);
	}
	return value;
}

function text(value: unknown, name: string, allowEmpty: boolean): string {
	if (typeof value !== "string") throw new Refusal(`${name} must be a string`);
	if (!allowEmpty && value.length === 0) throw new Refusal(`${name} must not be empty`);
	if (byteLength(value) > POLICY_LIMITS.contentBytes) throw new Refusal(`${name} is larger than 1 MiB`);
	return value;
}
