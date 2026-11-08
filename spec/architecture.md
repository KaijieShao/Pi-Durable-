---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/architecture.html
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

DesignArchitecture

# Architecture

The parts, how a request flows, and who is trusted.

## Components

The Coordinator resolves the requested agent ID from the group configuration. Agent IDs must be unique within the group. Each task gets its own git branch and worktree, created by the Coordinator from the latest main branch, and only the Coordinator changes the repository or talks to GitHub. The same task, permission, queue and isolation rules apply to every configured agent.

Where things run and who can touch what

Where things run and who can touch whatOne VM contains a trusted-components zone and separate untrusted task containers. The model relay is inside the Coordinator process. The Coordinator starts the isolated evaluator after sealing. Execution stays held until the evaluator exits and cleanup is verified. The Coordinator alone holds the git repository and the GitHub connection; task containers mount only their task's worktree.ONE VM · OUTER BOUNDARYTRUSTED COMPONENTSTASK CONTAINERS · PER TASK · UNTRUSTED CODEUserTelegram botCOORDINATOR PROCESSCoordinatorSQLiteModel relaykey, budget, requestsOwner CLIWatchdogPi processone per runGitHubmain · pull requestsGit repositoryworktree per taskModel providerTool hooksTool executionfiles · commandsTask worktree: read-writeNo other worktrees, main or git dataNo network · no credentialsrun\_check: separate, worktree read-only + scratchIsolated evaluatortrusted containerstart · run keystopstopstarts after sealingsealed snapshot

Select a part of the diagram to see its role.

### Telegram bot

Receives commands and posts status to the group.

### Coordinator, the collaboration layer

Saves each command before acknowledging it. Maps each task to its Pi conversation. Routes new tasks and follow-ups. Applies admission limits and permissions, and handles cancellation. Creates each task’s worktree and runs review and merge. Sends replies through a durable outbox.

### Git repository and GitHub

The project is a git repository on the VM’s disk, with GitHub holding the main branch and one pull request per task. Only the Coordinator runs git and calls GitHub, with the repository’s hooks and local git config disabled, since the code is untrusted. For each task it creates a branch and worktree from the latest main branch, commits a checkpoint after each run is finalized and cleaned up, pushes the branch, opens or updates the pull request and performs the merge. Agents never run git, never see git’s internal data and never hold the GitHub token.

### Pi Durable 1.5.0, one process per run

Supplies the agent loop, the persistent conversation, the inbox (steer and follow-up modes), deduplication by `requestId`, abort and tool hooks. Our startup code passes it a model configuration whose base URL points at the relay and whose key is bound to this run.

### Model relay

Runs inside the Coordinator process.

Every model call goes through it. It accepts only an open run key. It reserves budget before each request. It checks that the fully assembled input is within 48K tokens. It counts model requests across a run and its successor run, retries included, up to 30 per run.

### Policy hooks and containers

Pi's tool hooks apply our permission policy. Every file operation and command runs inside the task's container, with no fallback to the host. Only the task’s worktree is mounted, read-write and without git’s internal data; other worktrees and the main branch are not mounted at all. There's no network and no credentials, and CPU, memory, process and time limits apply. `run_check` runs in a separate container with the task’s worktree read-only and a disposable scratch space that's wiped after each check.

### Watchdog

An independent stop path. It terminates processes and containers and verifies they're gone. It enforces each run’s 10-minute deadline independently.

### Isolated evaluator

Grades an immutable copy of the main branch, taken at sealing after the trial’s tasks have merged. It's a separate trusted container, launched only by the Coordinator after sealing, with the sealed snapshot and hidden tests read-only plus scratch space, and no network or credentials. Agents can't reach it.

### Owner CLI

Local operator control.

## Request Flow

Before every run is dispatched, including a follow-up run, the Coordinator atomically checks the target agent is idle and reserves a free deployment-wide execution slot across all groups. Merge tests reserve a slot too. The demo run limit is 2\. A queued run starts only after both checks pass and its permissions and budget checks remain valid. A new task’s first run also needs its group to have fewer than 4 open tasks; a follow-up run on a task in review already counts as one of them. The reservation is released only after finalization and verified cleanup, not merely when the model reports completion.

Evaluation holds all deployment-wide dispatch from sealing until the evaluator exits and cleanup is verified. More configured agents do not bypass this hold or create extra execution slots. Per-agent, per-user and per-group queue bounds still apply.

A follow-up’s life

Steer during a runFollow-up during reviewFinalizing a runReview and merge

USERCOORDINATORPIReply to statusmessageCheck permissionand limits, then saveSend to PiwhenBusy: "steer"Delivered after the current tool roundsame task, deadline, request count, budgetrequestId = update IDAccepted steer unconsumed at normal completion:becomes a successor run in the same task; expires if the 30-request cap is reached.Normal finalize waits until Pi is idle and any successor run has drained.

USERCOORDINATORPIReply duringreview, before mergeAnother run, same taskadmitted; same branch and PRFinished cleanly, quiescence confirmedreuses its conversationEarlier run interruptedfresh conversation; old one read-onlyAfter the merge, a reply is rejected; new work is a new /task.

USERCOORDINATORPI1\. Close run keyrevoke generation2\. Abort Pi3\. Settle in-flightcall or tool effectIf unconfirmed:uncertain, freeze group4\. Terminateprocess, containerVerify goneFinalize after cancel or a limit.Normal completion first waits for Pi to be idle and any successor run to drain.

USERCOORDINATORGITHUB1\. Test, commit, pushafter each runPull requestone per task2\. Review, /approvebound to the head commit3\. Merge latest maininto the task branch4\. Main unchangedask GitHub to mergeMerges that commitrefuses if main movedConflict: nothing merges; a new run resolves it, then review again.Main moved: the combined result is tested and approved again before it merges.If GitHub refuses, the Coordinator starts over. Merges run one at a time.

### New task

`/task <agent>` is saved, then acknowledged with its queue position. When the target agent is idle and execution capacity is available, the Coordinator fetches the latest main branch, creates the task’s branch and worktree and records its base commit. The project’s checked-in setup script then runs in the check container, with the worktree writable for that step only and dependencies taken from the pinned check image, since there is no network, to create the task’s own test data. Finally the Coordinator opens a run key and starts the Pi process and its container.

### Follow-up during a run

A reply to the task's status message is checked for permission and limits, then saved. It goes to Pi with `whenBusy: "steer"` and the Telegram update ID as `requestId`. If an accepted steer is still unconsumed when the run completes normally, it becomes one internal successor run of the same task with the same `requestId`, keeping the slot, the 10-minute deadline, the 30-request count and the budget. If the cap is already reached, the steer expires.

### Follow-up during review

A reply after the run ends and before the merge starts another run of the same task, admitted like new work, on the same worktree, branch and pull request.

If the earlier run finished cleanly and quiescence is confirmed, the new run reuses its conversation. If the run was interrupted, the new run starts a fresh conversation seeded with the original task text, the follow-up and the branch’s current changes, and the old conversation is kept read-only (see [Recovery After a Restart](interfaces-and-storage.html#4-4-recovery-after-a-restart)). A reply after the merge, a cancellation or a limit is rejected with a hint to send a new `/task`.

### Finalizing a run

* Normal completion waits until Pi is idle and any successor run has drained.
* Cancel or a limit revokes first: no successor run starts, every pending follow-up expires, and only the current in-flight tool round may finish. Effects after revocation aren't ruled out.
* Close the run key and revoke its generation, which blocks further dispatches for this run. After a normal completion, the task stays open, and a later admitted follow-up run gets a new key. A cancel or a limit ends the task: a limit marks it failed, its pull request is closed and its worktree is archived, and the bot says which limit was hit. Further work is a new `/task`.
* Abort Pi.
* Let any model call or tool effect already in flight settle. If it can't be confirmed, mark it uncertain and freeze the group.
* Terminate the process and container, and verify they're gone.

### Review and merge

* When a run has been finalized and its process and container are verified gone, the Coordinator runs the approved tests on the worktree, commits a checkpoint and pushes the branch. It opens the task’s pull request, or updates it, and posts the link, the test result and the head commit, and names any test files the task changed. The task is now in review, and its agent is free.
* `/approve <task>` from the creator or owner approves that head commit. If the branch has changed since, or a new run has been admitted, the approval is rejected.
* If a task stays in review past a configured time, the bot reminds the reviewer once. A task in review never expires or is cancelled on its own.
* Merges run one at a time. The Coordinator saves a merge intent, then merges the latest main branch into the task branch in its worktree. If git reports a conflict, nothing merges; the bot lists the conflicting files, and the Coordinator admits a new run of the task for its agent to resolve them. The user then reviews again.
* If the main branch had moved, the combined result is tested and pushed, and the task returns to review for a new approval, because the result changed.
* If the main branch had not moved, the tests that passed at the end of the run already cover this commit; failed tests block the merge. The Coordinator asks GitHub to merge exactly that commit, and a GitHub rule requires the branch to be up to date with the main branch. If it moved in the meantime, GitHub refuses and the Coordinator starts over, so what was tested is what merges.
* After the merge, the task is merged and its worktree is archived: the folder is deleted, and the branch stays on GitHub so the work can be restored.
* Before any worktree is archived, its run must be finalized and verified stopped. The Coordinator then commits everything left in the worktree, untracked files included unless `.gitignore` excludes them, as a final checkpoint and pushes it. The folder is deleted only after GitHub confirms the push, so a task cancelled mid-run keeps its work on its branch. A task in review has no uncommitted work, because each run already ended with a checkpoint.

This is optimistic concurrency: tasks work in parallel without locking the main branch, and the check happens at merge time.

### Sealing

The group enters a "sealing" state that blocks dispatch and follow-up delivery. Dispatch is held deployment-wide, and all active runs and merge tests are finalized, and an immutable copy of the main branch is captured after the trial’s tasks have merged. Evaluation and execution never overlap. Dispatch stays held from sealing until the evaluator has exited and its cleanup is verified. New `/task` commands may be accepted and queued within the usual limits, and they wait until dispatch reopens. Only then may queued work dispatch. Evaluation runs only in the trial harness.

### States

### Task lifecycle and group holds

Task lifecycleA queued task is dispatched to running. When the run ends, the task is in review with its pull request. A follow-up or conflict fix queues another run of the same task. Approval moves it to merging; if main moved or there is a conflict, it returns to review; if the tests pass, it is merged. A queued task may be cancelled; a running task may fail or be cancelled. Group states normal, sealing and frozen apply separately.QueuedRunningIn review/cancelFailed · CancelledMergingMergedfollow-up or conflict fix starts another run/approvemain movedor conflicttests passGroup state is separate from task state: Normal · Sealing · FrozenGroup frozen blocks dispatch and merges; it is not a task state.

Representative path. A queued task can also be cancelled, and cancelling a task in review closes its pull request. Finalizing is cleanup at the end of each run, not a stored state. Sealing and frozen are group-level holds; the rules below define their effects.

A task is queued, running, in review, merging, merged, failed or cancelled. A group is normal, sealing or frozen. A finished run is the agent’s claim; "merged" needs approval and passing tests, and "passed" comes only from the evaluator.

### Frozen group

Nothing is dispatched or merged, and all other running tasks in the group are cancelled with the reason "group frozen"; tasks in review keep their pull requests. New `/task` commands, follow-ups and approvals are rejected with a frozen notice; `/status` and authorized `/cancel` still work. Queued tasks stay queued and never expire on their own. A stop that couldn't be confirmed stays under review. Only the owner CLI unfreezes the group, after resolution.

## Trust Boundaries

| Trusted                                                                                                                               | Untrusted                                        |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| The Coordinator, Pi, the relay, the hooks, the expected test outputs, the watchdog, the evaluator and the GitHub repository settings. | Model output, tool arguments and generated code. |

### Fails closed

* If enforcement is unavailable, no new execution starts.
* If a stop can't be confirmed or an effect is uncertain, the group freezes.

### Isolation

* Each run reads and writes only its task’s worktree; that’s our design choice, to be verified by mount and path-alias tests.
* A peer’s unfinished work is never visible. The main branch changes only through an approved, tested merge, and only the sealed copy is graded.

## Why This Shape

### One fix per problem

* A durable queue, so several users can submit safely.
* A persistent task-to-conversation mapping, for follow-ups; clean follow-up runs reuse the conversation.
* A run-scoped key, so only admitted work can call the model.
* Hooks plus containers, to contain generated code.
* A worktree and pull request per task, so agents don’t overwrite each other and nothing merges without review.
* A watchdog, for stopping.

### Reuse before build

Pi’s inbox, deduplication, abort and hooks are reused, and git and GitHub supply branches, merging and review. We build routing, admission, the relay, enforcement, the merge procedure and the stop path.

### Scope

Bounded coding tasks with approved checks. No MCP and no compaction; a run stops explicitly at the context limit.

### Accepted single points of failure

See [Deployment’s single points of failure](deployment.html#6-9-accepted-spofs) for the failure, effect and recovery boundaries.

[PreviousCapacity](capacity.html)[NextInterfaces and Storage](interfaces-and-storage.html)

On this page

[Components](#3-1-components "Components")[Request Flow](#3-2-request-flow "Request Flow")[Trust Boundaries](#3-3-trust-boundaries "Trust Boundaries")[Why This Shape](#3-4-why-this-shape "Why This Shape")
