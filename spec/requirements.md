---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/requirements.html
reviewUrl: https://artifact.cafe/a/pi-durable-agents-0rrc3e
---
[Skip to content](#main) 

☰[Pi Durable Agents](requirements.html)

[Docs](requirements.html)[Changelog](changelog.html)

Search⌘ K

Foundations

[Requirements](requirements.html)[Capacity](capacity.html)

Design

[Architecture](architecture.html)[Interfaces and Storage](interfaces-and-storage.html)[Agent Execution](agent-execution.html)

Operations

[Deployment](deployment.html)[Evaluation](evaluation.html)

FoundationsRequirements

# Requirements

## Overview

This project builds a **multi-user, multi-agent AI coding system on Pi Durable**, allowing people in the same Telegram group to work concurrently with coding agents on one shared project filesystem. A coordination layer routes tasks and follow-ups, controls file access, and handles cancellation and recovery so agents can collaborate safely on the same codebase. The system targets **Google Cloud Platform (GCP)**, with correctness checks and stress tests to evaluate performance, identify bottlenecks and single points of failure, and make its limitations clear.

## Functional Requirements

Task-to-conversation mapping

Task-to-conversation mapping User 1 submits Task A and User 2 submits Task B in the same group. Task A is assigned to agent A and bound to a conversation; Task B is assigned to agent B and bound to a conversation. User 1's follow-up reply to Task A, sent while Task A is busy, is steered into Task A's conversation; after Task A's run ends and before its pull request merges, a follow-up starts another admitted run of Task A, which may reuse the conversation if the earlier run ended cleanly. USERSONE TELEGRAM GROUPCONVERSATIONS User 1User 2 Task Aassigned to agent A Follow-up to Task Areply to Task A Task Bassigned to agent B Task A conversationagent A Task B conversationagent B while the taskis running

Each task has its own conversation. A follow-up sent while Task A is running is steered into it; a reply after Task A’s run ends starts another run of Task A on its branch, which reuses the conversation only if the earlier run ended cleanly ([see Request Flow](architecture.html#3-2-request-flow)).

### Tasks

Members of the same Telegram group can submit a task to one of the group’s configured coding agents using `/task <agent> <text>`. Each agent has an ID; the design does not fix the number of agents or group members.

Several users can choose the same agent. It runs one task at a time, and later tasks share its queue rather than getting a separate agent. Different agents can work at the same time, up to a shared limit for the whole system (2 in the demo configuration). For example, if agents A and B are both running, a new task for agent C waits in its queue until one of them finishes, even though C is free.

Members can watch progress and results, and cancel tasks they are allowed to stop. Queues are bounded. The demo configuration allows:

* Up to 2 waiting tasks per agent.
* Up to 4 waiting tasks per group.
* Up to 4 waiting tasks per user.

Each group can also have up to 4 open tasks, counting those running or waiting for review. Submissions beyond a configured limit are refused with a reason. These limits are demo settings for a proof of concept on one small VM, not limits of the design. A larger deployment can add agents and raise the execution and queue limits, given enough compute and fresh testing.

### Follow-ups

The task’s creator or the group’s configured owner can add instructions by replying to its status message. The Coordinator chooses what happens from the task’s state; the user does not select a mode. A separate request is sent as a new `/task` message instead; the type of Telegram message, not its wording, decides whether it is a new task or a follow-up.

* **While the task is running,** the reply steers that task between tool rounds. A steer does not reset the task’s time, request or token limits.
* **After the task’s run ends,** the reply starts another run of the same task, on its branch and pull request, until that pull request merges. It is subject to the same permissions, admission checks, queue limits and execution-slot rules as any other run. After the merge, further work is a new `/task` request with its own branch and pull request.

The bot tells the user which happened.

### Shared project and review

Each Telegram group has one shared project, a git repository with a main branch. When a task starts, it gets its own branch and git worktree from the latest main branch. Each `/task` request produces one branch and one pull request; follow-ups before the merge update that same pull request.

When the run finishes, the bot sends a link to a GitHub pull request with the task’s changes. The task’s creator or the group’s configured owner reviews it and approves with `/approve` in Telegram. While a task waits for review, its agent is free to start its next task.

Before merging, the Coordinator combines the change with the latest main branch and runs the tests on the combined result; the main branch changes only if they pass. If the main branch moved since approval, the updated result is approved again. If git can’t merge it cleanly, the agent resolves the conflict in a new admitted run, and the user reviews again. Merges happen one at a time. After the merge, the task’s worktree is archived: its folder is deleted and its branch is kept during the current acceptance and rehearsal. Cancelling a task in review closes its pull request and archives its worktree, keeping its branch.

### Post-acceptance remote branch cleanup — proposed, disabled

After formal acceptance and separate owner approval to enable it, independent housekeeping may delete an exact remote task feature branch **only after** GitHub confirms the matching PR merged, the Coordinator durably records the successful task/merge, and the task's worktree is confirmed archived and absent. There must be no active/admitted run, execution/check slot, unresolved file effect, pending merge reconciliation, or open PR using that branch.

* Never delete main, the repository default/base branch, protected or long-lived branches, or any open, cancelled, failed or unmerged task branch. Unknown protection or remote state retains the branch.
* Require repository, task ID, exact branch name, PR number, reviewed head and actual merge commit to agree. The merge must remain reachable from the base branch. A branch pushed/reused after merging is kept; deletion must use an atomic expected-head lease.
* Activation is off throughout this acceptance/rehearsal. No deletion of existing branches or historical backfill is authorized by this policy change. Future activation records a cutoff and repository scope; older branches remain retained unless separately reviewed and authorized.
* Cleanup has its own durable, idempotent journal. A deletion timeout is read back before any retry. Transient failures retry with bounded backoff; permission/protection/head-change problems retain the branch and request attention. **A successful merge/task never becomes failed because branch cleanup failed.**
* Keep task, conversation, approval, PR and immutable commit records. Deleting a remote ref never erases or rewrites acceptance evidence, opens a replacement PR, replays a merge or resumes an ended task.

The review-only worker core and required integration gates are in [`proposals/branch-cleanup`](../proposals/branch-cleanup/README.md). It is not wired into the running Coordinator. GitHub's immediate `delete_branch_on_merge` setting remains disabled because it cannot enforce the archive-completed gate.

### Permissions

Only the task’s creator and the group’s owner can cancel a task, send it a follow-up or approve its merge; other members of the group can’t.

The group’s owner is set by Telegram user ID in the system configuration.

## Non-functional Requirements

| Requirement                  | Target and limits                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability                 | The bot is always on. The VM and the Coordinator run continuously, so a command sent at any hour gets a reply without waiting for a server to start. If the Coordinator process crashes, it restarts automatically. Everything runs on 1 VM, so losing the VM or its zone stops the service until it is rebuilt. |
| Responsiveness (provisional) | 95% of commands get a reply in the group within 2 seconds while 2 tasks are running. The stress test measures this with /status, and the quality trials measure the replies to tasks and follow-ups.                                                                                                             |
| Durability                   | Accepted tasks and follow-ups survive a process crash or restart. An interrupted run doesn’t resume automatically. Its worktree is kept, its pending follow-ups expire, and the user is told. Work already pushed to GitHub also survives losing the VM, but anything only on the VM’s disk does not.            |
| Follow-up outcomes           | Every follow-up ends with exactly one outcome that the user sees: delivered, started as another run of the task, rejected or expired. Each task also reports its own final state.                                                                                                                                |
| No duplicate submissions     | A submission retried while the system is running reuses the same request ID, so Pi ignores the repeat. An interrupted run is never resubmitted automatically. File edits are not guaranteed to happen exactly once.                                                                                              |
| Safe recovery                | When the system can’t tell whether an action took effect, it freezes the group so the owner can review it, instead of guessing or retrying. After a restart, it checks whether a merge already happened before trying it again.                                                                                  |
| Limits always apply          | Every run, including a follow-up run, goes through the same queue and budget limits. No work runs outside them.                                                                                                                                                                                                  |
| Write safety                 | 100% of writes outside the task’s own worktree are blocked before they happen. This covers writes to the main branch, to other tasks’ worktrees and to git’s internal data, including writes made by commands and their subprocesses.                                                                            |
| Combined result              | The final project keeps every task’s required behavior. Each change is tested together with the latest main branch before it merges, and the evaluation checks the final result instead of assuming it.                                                                                                          |

## Scope and Constraints

The project is built on Pi Durable for multiple users and multiple agents, with one shared git repository per group, to be deployed on GCP and stress-tested, with a report on bottlenecks and single points of failure. Its main constraint is that agents change one shared codebase at the same time, so each task works on its own branch and merges only after review and testing.

**Our design choices:**

* Telegram as the interface
* One VM and one Coordinator
* A git branch and worktree for each task
* GitHub pull requests for review
* Pi Durable 1.5.0
* The signup test project
* A pinned model
* Fixed queue limits

**Out of scope:**

* A custom web UI
* Scheduling across machines
* Autoscaling
* Agents handing work to each other on their own
* Automatic file rollback

**Never given up.** Accepted messages keep their identity through recovery, agents only write where they're allowed, and nothing reaches the main branch without approval. An interrupted conversation stays quarantined, and the next admitted run of that task starts in a fresh conversation.

## Success Criteria

| Criterion  | Pass condition                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlap    | Several real users give tasks to different agents in one group, and the agents' work overlaps in time.                                                                                                                            |
| Follow-ups | A follow-up sent while an agent is busy reaches that task between rounds. Unauthorized follow-ups are rejected, and a resubmitted duplicate creates no second submission.                                                         |
| Clean stop | After cancellation or a limit revokes a task, no new run starts for that task. Every accepted follow-up ends as delivered, expired or started as another run; tasks report their own final state.                                 |
| Quality    | At least 2 of 3 end-to-end trials, each starting from the same clean project, pass the evaluator’s checks on the main branch after their tasks merge. All 3 trials are reported. This grades the trials and never blocks a merge. |
| Review     | No change reaches the main branch without approval from the task’s creator or owner. A conflicting or outdated change is resolved, retested and approved again before it merges.                                                  |
| Safety     | Every mandatory safety, permission, cancel and recovery check passes in all three fault-track runs; skipped checks are reported as “not tested”.                                                                                  |
| Operations | The system is deployed on GCP and stress-tested, and the bottleneck and single-point-of-failure report is complete.                                                                                                               |

See [Evaluation](evaluation.html) for the test procedures. These are acceptance criteria, not completed results.

[NextCapacity](capacity.html)

On this page

[Overview](#overview "Overview")[Functional Requirements](#1-1-functional-requirements "Functional Requirements")[Non-functional Requirements](#1-2-non-functional-requirements "Non-functional Requirements")[Scope and Constraints](#1-3-scope-and-constraints "Scope and Constraints")[Success Criteria](#1-4-success-criteria "Success Criteria")
