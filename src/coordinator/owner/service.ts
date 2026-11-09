/**
 * The owner socket's commands, run by the Coordinator (Interfaces and Storage § Interfaces, Owner CLI: "status,
 * frozen-group resolution, failed events and read-only inspection of quarantined conversations"):
 *
 *   status              group state and reason, slots, the watchdog's health and last sweep, tasks, held tasks,
 *                       uncertain file changes, outbox and failed events, merge intents, quarantined conversations,
 *                       both disks. Metadata only.
 *   unfreeze <group>    the engine repeats the recovery checks while the group stays frozen and unfreezes it only if
 *                       all pass (engine/unfreeze.ts); otherwise it says which check failed.
 *   resolve <change>... the owner's resolution of an unresolved file change (Agent Execution § Uncertain Effects:
 *                       "Anything else freezes the group"; Interfaces and Storage § Recovery: "Owner review resolves
 *                       and unfreezes the group"): recorded as resolved, the file accepted as it is in the worktree.
 *                       It unfreezes nothing; the next unfreeze's checks let the change pass.
 *   failed-events       permanently failed Telegram deliveries, metadata only.
 *   conversations [task]  quarantined conversations of the group.
 *   inspect <conversation>  a quarantined conversation's transcript, read without writing (owner/inspect.ts). The
 *                       transcript goes back over the socket to the owner's terminal only; the log gets its size.
 *   seal <group> [trial] [tasks]  the trial harness's trigger (Architecture § Sealing: "Evaluation runs only in the
 *                       trial harness"): the group turns sealing and the isolated evaluator grades a snapshot of main
 *                       (engine/seal.ts), or the request is refused with the reason. It answers once sealing started;
 *                       status shows the progress and the result.
 */
import { join } from "node:path";
import { errorSummary, type Logger } from "../../runtime/log.ts";
import type { CoordinatorConfig } from "../config.ts";
import type { Engine, SealOutcome, UnfreezeOutcome } from "../engine.ts";
import { taskList } from "../evaluation.ts";
import type { Store } from "../store.ts";
import { diskReport } from "./disk-report.ts";
import { inspectConversation } from "./inspect.ts";
import { type CheckReport, type OwnerRequest, type OwnerResponse, ownerPaths } from "./protocol.ts";
import { clean, groupConversation, ownerConversations, ownerFailedEvents, ownerStatus } from "./report.ts";

/** What effect_intents.resolution records for the owner's resolution of an unresolved file change. */
export const OWNER_RESOLUTION = "owner resolve: accepted as found in the worktree";

export type OwnerServiceDeps = {
	readonly store: Store;
	readonly config: CoordinatorConfig;
	readonly log: Logger;
	/** The engine once it runs (after recovery, the relay and the poller started); undefined while starting. */
	readonly engine: () => Engine | undefined;
	readonly startedAt: number;
};

const refuse = (error: string, text: string): OwnerResponse => ({ ok: false, error, text });

function coordinatorLine(deps: OwnerServiceDeps): string {
	const running = deps.engine() === undefined ? "starting (recovery in progress)" : "running";
	return `Coordinator: ${running}, pid ${process.pid}, since ${new Date(deps.startedAt).toISOString()}`;
}

async function status(deps: OwnerServiceDeps): Promise<OwnerResponse> {
	const { store, config } = deps;
	const disk = await diskReport(store, config);
	const text = ownerStatus(store, config.telegram.groupChatId, disk, {
		repository: config.github.repo,
		topicId: config.telegram.topicId,
		databasePath: join(config.paths.dataDir, "coordinator.sqlite"),
	});
	return { ok: true, text: `${coordinatorLine(deps)}\n${text}` };
}

function checkLines(checks: readonly CheckReport[]): string[] {
	return checks.map((check) => `  ${check.ok ? "ok    " : "FAILED"} ${check.name}: ${check.detail}`);
}

function refusedText(group: number, outcome: Extract<UnfreezeOutcome, { kind: "refused" }>): OwnerResponse {
	const failed = outcome.checks.find((check) => !check.ok);
	const was = outcome.reason === null ? "" : ` (frozen: ${clean(outcome.reason)})`;
	const text = [
		`Group ${group} stays frozen${was}: the recovery check "${failed?.name ?? "?"}" failed. Nothing was unfrozen.`,
		"Recovery checks, in order (the ones after the failed check did not run):",
		...checkLines(outcome.checks),
		"Resolve the cause, then run owner unfreeze again.",
	].join("\n");
	return { ok: false, error: "refused", text, checks: outcome.checks };
}

function unfrozenText(group: number, outcome: Extract<UnfreezeOutcome, { kind: "unfrozen" }>): OwnerResponse {
	const was = outcome.reason === null ? "" : ` (it was frozen: ${clean(outcome.reason)})`;
	const plural = outcome.jobs === 1 ? "" : "s";
	const jobs = outcome.jobs === 0 ? "" : ` after the ${outcome.jobs} recovery job${plural} it found`;
	const text = [
		`Group ${group} unfrozen${was}. Every recovery check passed:`,
		...checkLines(outcome.checks),
		`Dispatch reopens for admitted work${jobs} (and while the watchdog's heartbeat is fresh). Tasks cancelled by the`,
		"freeze stay cancelled; nothing interrupted resumes on its own.",
	].join("\n");
	return { ok: true, text, checks: outcome.checks };
}

function unfreezeText(group: number, outcome: UnfreezeOutcome): OwnerResponse {
	switch (outcome.kind) {
		case "not_frozen":
			return outcome.state === "normal"
				? { ok: true, text: `Group ${group} is not frozen; nothing changed.` }
				: refuse("refused", `Group ${group} is ${outcome.state}, not frozen; unfreeze does not change it.`);
		case "in_progress":
			return refuse("busy", `An unfreeze of group ${group} is already running; wait for its answer.`);
		case "refused":
			return refusedText(group, outcome);
		case "unfrozen":
			return unfrozenText(group, outcome);
	}
}

async function unfreeze(deps: OwnerServiceDeps, group: number): Promise<OwnerResponse> {
	const chatId = deps.config.telegram.groupChatId;
	if (group !== chatId) return refuse("refused", `This Coordinator serves group ${chatId} only, not ${group}.`);
	const engine = deps.engine();
	if (engine === undefined)
		return refuse("unavailable", "The Coordinator is still starting (recovery in progress); try again in a moment.");
	return unfreezeText(chatId, await engine.unfreeze());
}

function sealText(group: number, outcome: SealOutcome): OwnerResponse {
	if (outcome.kind === "refused")
		return refuse("refused", `Sealing of group ${group} refused: ${outcome.reason}. Nothing changed.`);
	const which = outcome.named ? "named" : "every task of the group since the last evaluation";
	const text = [
		`Sealing started for trial ${outcome.trial} (group ${group}). Trial tasks (${which}): ${taskList(outcome.tasks)}, all merged.`,
		"Dispatch, merges and follow-up delivery are held deployment-wide until the evaluator has exited and its cleanup",
		"is verified; /task requests and replies are saved and queued meanwhile. Runs and merge tests in progress finish",
		"first, then a snapshot of main is graded. owner status shows the progress and, at the end, the result.",
	].join("\n");
	return { ok: true, text };
}

async function seal(
	deps: OwnerServiceDeps,
	request: Extract<OwnerRequest, { command: "seal" }>,
): Promise<OwnerResponse> {
	const chatId = deps.config.telegram.groupChatId;
	if (request.group !== chatId)
		return refuse("refused", `This Coordinator serves group ${chatId} only, not ${request.group}.`);
	const engine = deps.engine();
	if (engine === undefined)
		return refuse("unavailable", "The Coordinator is still starting (recovery in progress); try again in a moment.");
	return sealText(chatId, await engine.seal({ trial: request.trial, tasks: request.tasks }));
}

type IntentState = { id: number; task_id: number; state: string; path: string | null; operation: string | null };

/** Record the owner's resolution of unresolved file changes of this group; each other number is reported as such. */
export function resolveChanges(store: Store, chatId: number, ids: readonly number[], log: Logger): OwnerResponse {
	const lines = store.tx(() =>
		ids.map((id) => {
			const row = store.get<IntentState>(
				`SELECT i.id, i.task_id, i.state, i.path, i.operation FROM effect_intents i JOIN tasks t ON t.id = i.task_id
				 WHERE i.id = ? AND t.chat_id = ?`,
				id,
				chatId,
			);
			if (row === undefined) return { ok: false, text: `  change ${id}: no such file change in this group` };
			const target = row.path ?? row.operation ?? "?";
			if (row.state !== "unresolved")
				return {
					ok: false,
					text: `  change ${id} (Task ${row.task_id}, ${target}): ${row.state}, not unresolved; unchanged`,
				};
			store.run(
				"UPDATE effect_intents SET state = 'resolved', resolution = ?, settled_at = ? WHERE id = ? AND state = 'unresolved'",
				OWNER_RESOLUTION,
				store.now(),
				id,
			);
			log.info("owner_effect_resolved", { intent: id, task: row.task_id });
			return {
				ok: true,
				text: `  change ${id} (Task ${row.task_id}, ${target}): resolved, accepted as it is in the worktree`,
			};
		}),
	);
	const ok = lines.every((line) => line.ok);
	const text = [
		ok ? "Recorded your resolution:" : "Recorded what could be resolved:",
		...lines.map((line) => line.text),
		"The group stays as it is: owner unfreeze repeats the recovery checks, then reopens dispatch.",
	].join("\n");
	return ok ? { ok: true, text } : { ok: false, error: "refused", text };
}

async function inspect(deps: OwnerServiceDeps, id: string): Promise<OwnerResponse> {
	const { store, config, log } = deps;
	const row = groupConversation(store, config.telegram.groupChatId, id);
	if (row === undefined)
		return refuse("refused", `No conversation ${id} in this group (owner conversations lists them).`);
	if (row.quarantined !== 1)
		return refuse("refused", `Conversation ${id} is not quarantined; only quarantined conversations can be inspected.`);
	const expected = join(config.paths.dataDir, "conversations", `${id}.sqlite`);
	if (row.path !== expected) return refuse("refused", `Conversation ${id} is not stored in this data directory.`);
	const inspection = await inspectConversation(row.path, ownerPaths(config.paths.dataDir).dir);
	log.info("owner_inspect", {
		conversation: id,
		task: row.task_id,
		entries: inspection.entries,
		source: inspection.source,
	});
	const header = `Conversation ${id} of Task ${row.task_id} (quarantined; read-only, nothing was written)`;
	return { ok: true, text: `${header}\n${inspection.text}` };
}

/** The handler of the owner socket. */
export function ownerService(deps: OwnerServiceDeps): (request: OwnerRequest) => Promise<OwnerResponse> {
	const chatId = deps.config.telegram.groupChatId;
	return async (request) => {
		try {
			switch (request.command) {
				case "status":
					return await status(deps);
				case "unfreeze":
					return await unfreeze(deps, request.group);
				case "resolve":
					return resolveChanges(deps.store, chatId, request.intents, deps.log);
				case "failed-events":
					return { ok: true, text: ownerFailedEvents(deps.store) };
				case "conversations":
					return { ok: true, text: ownerConversations(deps.store, chatId, request.task) };
				case "inspect":
					return await inspect(deps, request.conversation);
				case "seal":
					return await seal(deps, request);
			}
		} catch (error) {
			deps.log.error("owner_command_failed", { command: request.command, error: errorSummary(error) });
			return refuse("failed", `owner ${request.command} failed: ${errorSummary(error)}`);
		}
	};
}
