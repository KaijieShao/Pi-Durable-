/**
 * The owner CLI (Interfaces and Storage § Interfaces, Owner CLI: "A local socket for status, frozen-group resolution,
 * failed events and read-only inspection of quarantined conversations"; Architecture § Frozen group: "Only the owner
 * CLI unfreezes the group, after resolution"). Every command goes to the running Coordinator over its owner socket
 * (<PI_DATA_DIR>/owner/owner.sock, src/coordinator/owner/), which does the work: an unfreeze is the Coordinator
 * repeating its recovery checks, never a write to the database by the CLI.
 *
 * When the Coordinator is not running the CLI says so and exits 3. `owner status` then also prints the status from a
 * read-only connection to the database, labelled as such (nothing in it is live); nothing else has a fallback.
 *
 * Its configuration is its own (loadOwnerConfig: PI_DATA_DIR, PI_TASK_DIR, TELEGRAM_GROUP_CHAT_ID and the disk sizes;
 * Deployment § Secrets: "The secrets are held only in the Coordinator's memory"): given the Coordinator's env file, it
 * reads those lines only, so the bot token, the model key and the GitHub token never reach the CLI.
 *
 * Exit codes: 0 done; 1 refused or failed (e.g. a recovery check failed: the group stays frozen); 2 configuration
 * error; 3 the Coordinator is not running.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadOwnerConfig, type OwnerConfig } from "../coordinator/config.ts";
import { diskReport } from "../coordinator/owner/disk-report.ts";
import type { OwnerRequest } from "../coordinator/owner/protocol.ts";
import { ownerStatus } from "../coordinator/owner/report.ts";
import { Store } from "../coordinator/store.ts";
import { errorSummary } from "../runtime/log.ts";
import type { OwnerInvocation } from "./args.ts";
import { type ClientResult, ownerRequest } from "./owner-client.ts";
import { formatConfigError } from "./run.ts";

export const COORDINATOR_DB = "coordinator.sqlite";

export const OWNER_EXIT = { ok: 0, refused: 1, config: 2, notRunning: 3 } as const;

export type OwnerOptions = {
	readonly envFile?: string | undefined;
	readonly env?: NodeJS.ProcessEnv;
	/** Tests: an already parsed configuration instead of the environment. */
	readonly config?: OwnerConfig;
	readonly stdout?: (text: string) => void;
	readonly stderr?: (text: string) => void;
};

/** How long the CLI waits for the answer: an unfreeze runs the recovery checks (each step is bounded). */
export function answerTimeoutMs(request: OwnerRequest): number {
	if (request.command === "unfreeze") return 10 * 60_000;
	if (request.command === "inspect" || request.command === "seal") return 2 * 60_000;
	return 60_000;
}

/** The request of an invocation; an unfreeze without a group means the configured one. */
export function ownerRequestOf(invocation: OwnerInvocation, groupChatId: number): OwnerRequest {
	switch (invocation.action) {
		case "status":
		case "failed-events":
			return { command: invocation.action };
		case "unfreeze":
			return { command: "unfreeze", group: invocation.group ?? groupChatId };
		case "resolve":
			return { command: "resolve", intents: invocation.intents };
		case "conversations":
			return invocation.task === undefined
				? { command: "conversations" }
				: { command: "conversations", task: invocation.task };
		case "inspect":
			return { command: "inspect", conversation: invocation.conversation };
		case "seal":
			return {
				command: "seal",
				group: invocation.group ?? groupChatId,
				...(invocation.trial === undefined ? {} : { trial: invocation.trial }),
				...(invocation.tasks === undefined ? {} : { tasks: invocation.tasks }),
			};
	}
}

type Io = { readonly stdout: (text: string) => void; readonly stderr: (text: string) => void };

/**
 * `owner status` while the Coordinator is down: the same report from a read-only, query-only connection (no
 * migration, no write), labelled so nobody takes it for live state.
 */
async function fallbackStatus(config: OwnerConfig, io: Io): Promise<void> {
	const path = join(config.paths.dataDir, COORDINATOR_DB);
	if (!existsSync(path)) {
		io.stderr(`No Coordinator database at ${path} either: the Coordinator never ran with this PI_DATA_DIR.\n`);
		return;
	}
	let store: Store | undefined;
	try {
		store = new Store(path, Date.now, { readOnly: true });
		const disk = await diskReport(store, config);
		const status = ownerStatus(store, config.groupChatId, disk);
		io.stdout(
			"READ-ONLY STATUS FROM THE DATABASE: the Coordinator is not running, so nothing below is live and no command " +
				`can change it.\n${status}\n`,
		);
	} catch (error) {
		io.stderr(`The database could not be read: ${errorSummary(error)}\n`);
	} finally {
		store?.close();
	}
}

async function report(result: ClientResult, invocation: OwnerInvocation, config: OwnerConfig, io: Io): Promise<number> {
	switch (result.kind) {
		case "response":
			if (result.response.ok) {
				io.stdout(`${result.response.text}\n`);
				return OWNER_EXIT.ok;
			}
			io.stderr(`${result.response.text}\n`);
			return OWNER_EXIT.refused;
		case "not_running": {
			const needs =
				invocation.action === "unfreeze"
					? " An unfreeze needs the running Coordinator: it repeats the recovery checks before the group may dispatch again."
					: invocation.action === "seal"
						? " Sealing needs the running Coordinator: it holds dispatch and starts the evaluator."
						: "";
			io.stderr(`The Coordinator is not running (${result.detail}).${needs} Start it (pi-durable-telegram run).\n`);
			if (invocation.action === "status") await fallbackStatus(config, io);
			return OWNER_EXIT.notRunning;
		}
		case "denied":
		case "failed":
			io.stderr(`owner ${invocation.action}: ${result.detail}\n`);
			return OWNER_EXIT.refused;
	}
}

/** The owner CLI's configuration (no secret), or undefined after printing the problems. */
function readOwnerConfig(options: OwnerOptions, stderr: (text: string) => void): OwnerConfig | undefined {
	try {
		return loadOwnerConfig({
			...(options.envFile === undefined ? {} : { envFile: options.envFile }),
			...(options.env === undefined ? {} : { env: options.env }),
		});
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		stderr(formatConfigError(error));
		return undefined;
	}
}

/** `owner <command>` (src/cli/args.ts OWNER_USAGE). Resolves with the exit code. */
export async function runOwnerCommand(invocation: OwnerInvocation, options: OwnerOptions = {}): Promise<number> {
	const io: Io = {
		stdout: options.stdout ?? ((text: string) => void process.stdout.write(text)),
		stderr: options.stderr ?? ((text: string) => void process.stderr.write(text)),
	};
	const config = options.config ?? readOwnerConfig(options, io.stderr);
	if (config === undefined) return OWNER_EXIT.config;
	const request = ownerRequestOf(invocation, config.groupChatId);
	try {
		const result = await ownerRequest(config.paths.dataDir, request, answerTimeoutMs(request));
		return await report(result, invocation, config, io);
	} catch (error) {
		io.stderr(`owner ${invocation.action} failed: ${errorSummary(error)}\n`);
		return OWNER_EXIT.refused;
	}
}
