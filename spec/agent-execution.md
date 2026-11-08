---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/agent-execution.html
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

DesignAgent Execution

# Agent Execution

How an agent’s tool calls are checked, contained and stopped.

## Tool Surface

| Tool           | Purpose                                        | Allowed scope                                                                |
| -------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| read           | Read project files.                            | The task’s worktree only; protected files and git data are absent.           |
| edit           | Edit an existing file.                         | The task’s worktree; confined paths, no symlink following.                   |
| write          | Write a file, including a new-file path.       | The task’s worktree; confined paths, no symlink following.                   |
| run\_check(op) | Run an operation from the fixed approved list. | Separate check container; the task’s worktree read-only, disposable scratch. |

There is no arbitrary shell.

The model names a call and the harness routes it through the policy hook. Everything runs in the task's container, with no host fallback.

## Policy Hook (every call)

One tool call’s path

One tool call’s pathPi routes each call through the policy hook before container execution. An allowed call runs in the agent or read-only check container. Denials return to Pi and the model as errors. Protected files are absent from both container views.Protected files: not in agent or check viewscredentials, system-control files, hidden testsModelnames a callPi harnessroutes the callPolicy hookevery callselect for rule orderAGENT CONTAINERTask worktree: read-writeNo other worktrees or git dataread · edit · writeRUN\_CHECK CONTAINERTask worktree: read-onlyScratch space: wiped after each checkListed run\_check operationsDeniedor fails closedallowdenyTool resultcapped at 16 KiB, truncation markedreturned to Pi, then the modeldenial returned to the modelas an error

Select the policy hook to see its rule order.

**Rule order** (full text in the numbered list below):

1. Explicit allow rules; everything else is denied.
2. Writes go only to the task’s worktree, with confined file operations.
3. If the hook is unavailable, the call fails closed.

Protected files are never mounted in agent or run\_check views; the hook’s allow rules are a second layer.

1. Explicit allow rules for `read`, `edit`, `write` (including new-file paths) and listed `run_check` operations. Everything else is denied. The `run_check` launcher and its operation list come from the pinned check image, outside the worktree, so a task can’t change them. A task can still edit the project’s tests.
2. Writes go only to the task’s worktree; `run_check` may also write to its disposable scratch space, which is outside the project. File operations are confined: no following symlinks, and they stay beneath the worktree root, so there's no gap between check and open.
3. If the hook is unavailable, the call fails closed.

**Protected files** (credentials, system-control files, hidden tests) are **never mounted** in any agent or `run_check` container view, so no path or alias can reach them. The hook’s allow rules are a second layer. Hidden tests are mounted only in the evaluator container.

## Containers

| Attribute                  | Agent                                                                          | Check                                                                     | Evaluator                                                         |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Project mount              | The task’s worktree read-write, without git data; nothing else of the project. | The task’s worktree read-only; writable only while the setup script runs. | Immutable sealed snapshot read-only.                              |
| Other mounts               | No protected files.                                                            | Disposable scratch; wiped after each check. No protected files.           | Hidden tests read-only; scratch space.                            |
| Network / credentials      | None.                                                                          | None.                                                                     | None.                                                             |
| CPU / memory (provisional) | 0.5 vCPU / 512 MiB per running task.                                           | 1 vCPU / 1 GiB per running task.                                          | 2 vCPU / 2 GiB, exclusive phase.                                  |
| Trust / start              | Untrusted generated code.                                                      | Approved checks execute untrusted generated code.                         | Trusted; Coordinator only, after sealing. Agents cannot reach it. |

### Agent and check enforcement

* no network, no credentials, unprivileged user, no privilege escalation
* limits on wall-clock, CPU time, memory, process count and output
* each limit returns a named outcome to the model
* termination of the whole process tree is verified

## Output and Context

* Each tool result is capped at 16 KiB retained (provisional), with truncation marked.
* Total emitted output is bounded separately, and `read` is bounded.
* The complete next model input is checked against 48K before each call.

## Limits (per run; steering resets none of them)

| Per-run limit  | Rule                                                                                                                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model requests | at most 30 per run, shared with its successor run, retries included, enforced at the relay.                                                                                                  |
| Retries        | Pi's durable retry is the only owner (maxRetries: 2, provider retries 0). Invalid requests (400) and rejected credentials (401) aren’t retried, and the run ends as failed with that reason. |
| Deadline       | 10 minutes per run, enforced by the watchdog.                                                                                                                                                |
| Budget         | reserved before each request. Unknown usage keeps its reservation.                                                                                                                           |

Hitting any limit triggers finalize and ends the task as failed.

## Uncertain Effects

* The model never re-runs an uncertain mutation.
* **`run_check`:** it can't mutate the project. Its outcome is reported as failed once termination is confirmed; otherwise the group freezes.
* **Single-file `edit`/`write`:**
  1. Intent (target, pre-hash, intended hash) is persisted before execution.
  2. After an unknown outcome, competing mutations are stopped and termination is confirmed.
  3. The target is inspected. If it matches the intended result, it's "applied"; if it matches the pre-hash, it's "currently unchanged".
  4. Anything else freezes the group.
* Dispatch stays blocked until reconciliation finishes.

## Finalize and Pending Inputs

**Normal completion** waits until Pi is idle. An accepted steer still unconsumed becomes one successor run of the same task, with the same `requestId`, cap, deadline and budget; if the cap is already reached, it expires.

**Cancel or a limit** revokes first: no run starts after revocation, and only the current in-flight tool round may finish. Pi is aborted. In-flight work settles or becomes uncertain. Then terminate and verify.

Every accepted follow-up gets an outcome, and the user is told:

| Outcome                | When it applies                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Delivered              | if it was steered in, including through a successor run                                                            |
| Expired                | if the run was cancelled, hit a limit or was interrupted by a restart                                              |
| Started as another run | of the same task, on the same branch and pull request, if it arrived while the task was in review and was admitted |

Inputs over a limit, or sent while the group is frozen, are rejected with a reason and never accepted.

## Accepted Limitations

The initial deployment is provisionally sized for the demo configuration; runtime validation is pending. More agents can be configured without increasing the run limit. Raising concurrency requires a larger or re-budgeted VM and new CPU, memory, Pi-process, disk and load measurements. A multi-VM deployment sharing one project would also need a shared Coordinator store and coordinated scheduling and isolation; distributed scheduling and autoscaling are outside this build.

Exact round accounting isn't claimed.

## One Task, Start to Finish (fictional, illustrative, not measured)

1. Ana sends `/task A add email validation`. The Coordinator saves it and replies "Task 12 accepted, position 1".
2. Task 12 is admitted. The Coordinator creates branch `task/12` and its worktree from the latest main branch, runs the setup script, opens the run key and generation, and starts the Pi process and agent A's container.
3. Pi asks the model, which requests `read signup/form.js`. The hook allows it, the container executes it, and the result is capped at 16 KiB.
4. Mid-run, Ana replies "also reject plus-addresses". The Coordinator checks she's the creator, saves the reply and submits it as a steer with its request ID. Pi delivers it after the current tool round, and Ana is told it was delivered.
5. Agent A edits files only in Task 12’s worktree, on branch `task/12`, and calls `run_check(test)`, which runs in a read-only check container.
6. The model gives its final answer. Finalize waits for Pi to be idle and any accepted successor run to drain, then revokes, terminates and verifies. The run is finished, which is the agent's claim, not "passed".
7. The Coordinator runs the tests, commits a checkpoint, pushes `task/12` and opens its pull request. The bot posts the link, the test result and the head commit, and Task 12 is in review. Agent A is free for other tasks.
8. An hour later Ana replies "add a unit test too". Task 12 is still in review, so this starts another run of Task 12\. It's admitted and queued like any task, reuses the conversation because the first run finished cleanly and quiescence was confirmed, and updates the same pull request.
9. Ana reviews the pull request and sends `/approve 12`. The main branch hasn't moved and the tests passed at the end of the latest run, so the Coordinator asks GitHub to merge that commit, and Task 12 is merged. Further work would be a new `/task`.
10. At sealing, the evaluator grades the snapshot. Only then can the work be called "passed".

[PreviousInterfaces and Storage](interfaces-and-storage.html)[NextDeployment](deployment.html)

On this page

[Tool Surface](#5-1-tool-surface "Tool Surface")[Policy Hook](#5-2-policy-hook-every-call "Policy Hook (every call)")[Containers](#5-3-containers "Containers")[Output and Context](#5-4-output-and-context "Output and Context")[Run Limits](#5-5-limits-per-run-steering-resets-none-of-them "Limits (per run; steering resets none of them)")[Uncertain Effects](#5-6-uncertain-effects "Uncertain Effects")[Finalization](#5-7-finalize-and-pending-inputs "Finalize and Pending Inputs")[Accepted Limitations](#5-8-accepted-limitations "Accepted Limitations")[Example Task](#5-9-one-task-start-to-finish-fictional-illustrative-not-measured "One Task, Start to Finish (fictional, illustrative, not measured)")
