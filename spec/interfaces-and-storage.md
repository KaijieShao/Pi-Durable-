---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/interfaces-and-storage.html
reviewUrl: https://artifact.cafe/a/pi-durable-agents-0rrc3e
---
[Skip to content](#main) 

☰[Pi Durable Agents](requirements.html)

[Docs](requirements.html)[Changelog](changelog.html)[Build plan](build-plan.html)

Search⌘ K

Foundations

[Requirements](requirements.html)[Capacity](capacity.html)

Design

[Architecture](architecture.html)[Interfaces and Storage](interfaces-and-storage.html)[Agent Execution](agent-execution.html)

Operations

[Deployment](deployment.html)[Evaluation](evaluation.html)

DesignInterfaces and Storage

# Interfaces and Storage

How the parts talk, where every record lives, and how we recover from a restart.

## Interfaces

| Interface                      | Direction              | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Telegram (user to Coordinator) | User → Coordinator     | Commands: /task <agent> <text>, a reply to a task message as a follow-up, /approve <task>, /status, and /cancel <task>. /approve approves the head commit the bot last posted for that task, and is rejected if the branch has changed or a new run has been admitted since; /cancel on a task in review closes its pull request and archives its worktree.The Coordinator checks the Telegram chat ID on every command against the target task’s group. The group owner’s Telegram user ID is explicitly set in the system configuration.Long polling with a 30 s timeout. The offset is saved only after the batch is saved.An accepted command, its task or follow-up change and its acknowledgement event are saved in one database transaction, so a crash keeps all three or none.Each acknowledgement carries the task ID and queue position. Each rejection gives its reason. |
| Coordinator to Pi              | Coordinator → Pi       | Harness.open() with the task's conversation and a Models configuration (the relay URL plus the run key).Each run gets the repository’s checked-in AGENTS.md as project guidance. It can’t change permissions, limits or required checks.Submissions use requestId \= Telegram update ID and whenBusy: steer. Abort and run events are also used.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Pi to relay                    | Pi → relay             | An OpenAI-compatible endpoint that accepts only an open run key.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Model tools                    | Model → task container | read, edit, write, and run\_check(operation) from a fixed list. There is no arbitrary shell.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Owner CLI                      | Owner → Coordinator    | A local socket for status, frozen-group resolution, failed events and read-only inspection of quarantined conversations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Coordinator to GitHub          | Coordinator → GitHub   | A fine-grained token for this repository only, with access to contents and pull requests, held only by the Coordinator.Pushes task branches, opens and updates pull requests, closes them on cancel or a limit, and merges an approved head commit with a merge commit, so that commit appears on the main branch.A rule on the main branch requires the task branch to be up to date before merging, so GitHub refuses a merge if the main branch moved.Failed calls are retried with backoff.Before retrying any GitHub change (a push, opening, updating or closing a pull request, or a merge), the Coordinator reads GitHub’s current state. A pull request is matched by repository, base branch and head branch. If the outcome is still unknown, the group freezes.                                                                                                           |
| Outbox to Telegram             | Outbox → Telegram      | Events have stable IDs and stay pending until Telegram confirms them.Network errors and 5xx responses are retried with backoff. A 429 waits for Telegram’s retry-after.Required messages (acknowledgements, rejections, cancellations, run outcomes and follow-up outcomes) go out before progress updates. For progress, only the latest update per task is kept.Permanent failures go to a failed-events table shown in the owner CLI.Delivery is at-least-once, so a duplicate Telegram message is possible.                                                                                                                                                                                                                                                                                                                                                                       |

### Scoped status presentation

`owner status` and Telegram `/status` default to the configured repository and group/topic. Both begin with
liveness, route, slots and succeeded/failed/open counts, then Completed task summaries and PR links marked
merged or open. Coding-finished open PRs remain awaiting approval and count as open. Old failures are
aggregated, not erased. `--all` includes other/unconfirmed scopes in the selected database (Telegram: this
group only); `--verbose` adds full diagnostics and, for the owner CLI, storage measurements. Offline status
has one explicit read-only header and retains exit code 3. Other exit codes and read-only behavior are unchanged.

Existing task rows lack repo/topic fields. An operator-verified external `PI_STATUS_SCOPE_FILE` maps known
routing periods without database rewriting, migration or inferred historic topics. Unknown/conflicting
routing is hidden by default, counted and available via `--all`. See [status operations](../docs/status-display.md).
This presentation change does not change command authorization, execution routing, approval or merge gates.

## Where Each Record Lives

| Record                                                                 | Store                                                                                                  | Survives what                                                                                                                   | Retention                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commands, with a unique update ID                                      | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Tasks, and immutable conversation and parent mappings                  | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Follow-ups and their outcomes                                          | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Runs: each run of a task, with its start, end and checkpoint commit    | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Branch, worktree and pull request per task, with base and head commits | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Approvals, each bound to a head commit, and merge intents              | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| The queue                                                              | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Run keys and generations                                               | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| The budget ledger                                                      | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| The outbox and failed events                                           | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| The Telegram offset                                                    | Coordinator SQLite: WAL, synchronous=FULL                                                              | Process crash / restart; no disk or VM loss guarantee.                                                                          | Normal retention follows its disk budget in Capacity; test reset wipes test databases.                                                                                                      |
| Conversation and inbox                                                 | Pi SQLite, one per conversation (WAL, NORMAL)                                                          | Process crash only.                                                                                                             | Raw content: trial only, then deleted. Other retention follows its disk budget in Capacity.                                                                                                 |
| Project work                                                           | Git repository on the VM disk, one worktree per open task; the main branch and pull requests on GitHub | Each run ends with a checkpoint commit pushed to GitHub; edits since the last checkpoint may need reconciliation after a crash. | A worktree is archived after its task merges, is cancelled or fails at a limit: its folder is deleted and its branch kept during acceptance/rehearsal. A separately approved post-acceptance cleanup may later delete only a confirmed merged-and-archived remote task ref; cancelled, failed and unmerged refs stay retained. Test reset recreates the test repository. No automatic rollback. |
| Metadata-only logs; raw content stays in Pi’s protected store.         | Allowlisted log fields / protected Pi store                                                            | No additional durability guarantee is specified.                                                                                | Raw content: trial only, then deleted. Metadata retention follows its disk budget in Capacity.                                                                                              |
| Immutable graded project copy                                          | Sealed snapshot                                                                                        | No additional durability guarantee is specified.                                                                                | Retention follows its disk budget in Capacity.                                                                                                                                              |

### Task mappings

tasks, each with one branch and one pull request, and runs, each with its `task_id` and `conversation_id`. A follow-up run that starts a fresh conversation records the earlier run’s `conversation_id` as its parent. A run’s `conversation_id` never changes; it’s kept for audit.

### Relay and conversation reuse

The relay runs inside the Coordinator process as a local HTTP listener, so there is one SQLite writer. It shares the Coordinator’s fate, which is already an accepted single point of failure.

Each conversation has its own Pi SQLite file (WAL, NORMAL) holding the conversation and its inbox. It survives a process crash only. A clean follow-up run reuses it, and a run’s conversation mapping never changes.

## Storage Choices

### One SQLite file

All Coordinator records live in one SQLite file, written with `BEGIN IMMEDIATE`. Command traffic is low QPS, so a transactional SQLite queue suffices.

### No cross-store transaction

Stores are reconciled on startup.

SQLite transactions are serialized and never held open across a network wait.

### Rejected

| Option not selected | Why the current design does not need it                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Postgres            | The declared low-QPS command traffic fits a transactional SQLite queue.                           |
| Redis or a cache    | There is no measured repeated-read bottleneck.                                                    |
| Kafka or Pub/Sub    | The queue is kept transactionally in the local SQLite store.                                      |
| Object storage      | The project lives in a git repository with GitHub as the remote; nothing else needs blob storage. |

## Recovery After a Restart

**Post-acceptance cleanup has a separate journal, not a merge state.** It stays disabled in this acceptance/rehearsal. After activation approval it may remove only a confirmed merged remote task ref after successful worktree archival. Preserve task/PR/conversation/approval/head/merge records. Reconcile pending merge intents first; retry incomplete archives before considering cleanup. A completed remote deletion must not trigger branch recreation, replacement PRs or a second merge for an ended task. Unknown deletion outcomes are read back in the cleanup worker; cleanup-only failures never downgrade a merged task. The implemented journal and atomic ref-lease adapter are documented in the [operational runbook](../docs/branch-cleanup.md); they never write the Coordinator database.

Restart recovery

Restart recoveryFive recovery steps in order: revoke generations and close run keys; the watchdog kills leftovers and verifies they are gone; reconcile effect evidence and keep uncertain budget reservations; restore relay, hooks and mounts; dispatch queued tasks. An unconfirmed stop or any unresolved effect freezes the group, and all other running tasks in the group are cancelled. Owner review resolves and unfreezes the group, then recovery checks are repeated before dispatch opens for admitted work; interrupted tasks never resume automatically. Reconciliation includes checking GitHub before retrying any GitHub change. A run that was in progress is marked failed, its task keeps its worktree, its conversation is quarantined, and only an authorized follow-up starts an explicitly admitted run of the same task on a fresh conversation.RESTART STEPS, IN ORDER1\. Revokegenerations,close run keys2\. Kill leftoverswatchdog verifiesthey are gone3\. Reconcileeffect evidence, mergesuncertain reservations4\. Restorerelay, hooks,mounts5\. Dispatchqueued tasksagainstop unconfirmedany effect unresolvedGroup frozencancels all other running tasksblocks dispatchOwner CLIresolve, then unfreezeRecheck steps 1–4new admitted work onlyno automatic resumeA RUN IN PROGRESSRun in progressat restartMarked failedinterrupted by restartConversationquarantined; worktree keptFresh conversationanother run, explicitly admittedonly after an authorized follow-up

Effects are reconciled before anything is dispatched. An unconfirmed stop or any unresolved effect freezes the group and cancels all other running tasks. The owner resolves and unfreezes it, then recovery checks repeat before admitted work can dispatch. Nothing in progress resumes automatically.

1. Revoke all generations and close all run keys.
2. The watchdog kills leftover processes and containers and verifies they're gone. If that can't be confirmed, the group freezes.
3. Reconcile effect evidence and keep uncertain budget reservations. For a saved merge intent, check whether the main branch on GitHub already contains the head commit before retrying, so nothing merges twice; compare each branch with GitHub before pushing, and look up the task’s pull request before opening one. If any effect is unresolved, the group freezes.
4. Restore the relay, hooks and mounts.
5. Reopen dispatch for queued tasks.

**Interrupted runs are never auto-resumed.**

* A run that was in progress is marked failed ("interrupted by restart"). Its task keeps its worktree, branch and pull request. If any effect is unresolved, the group freezes until the owner resolves it.
* Its conversation is quarantined and opened only read-only.
* Its pending follow-ups are marked "expired (interrupted)" and are not copied forward.
* A later follow-up from an authorized user is an explicitly admitted run of the same task on a **fresh conversation**. It's seeded with the original task text, that follow-up and the branch’s current changes.
* A conversation that finished normally is reused for a follow-up run only after quiescence is confirmed.
* `requestId` covers live retries only.

**This is a deliberate trade-off.** We give up automatic recovery of in-progress work. In return, nothing pending is ever replayed against a project that may have changed.

### After owner resolution

The owner unfreezes through the CLI, then recovery checks repeat before dispatch opens for admitted work. Interrupted tasks never resume automatically.

[PreviousArchitecture](architecture.html)[NextAgent Execution](agent-execution.html)

On this page

[Interfaces](#4-1-interfaces "Interfaces")[Data Storage](#4-2-where-each-record-lives "Where Each Record Lives")[Storage Choices](#4-3-storage-choices "Storage Choices")[Restart Recovery](#4-4-recovery-after-a-restart "Recovery After a Restart")
