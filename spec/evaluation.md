---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/evaluation.html
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

OperationsEvaluation

# Evaluation

How we prove correctness, safety and load behavior.

**This section is the test plan; results will be added when they exist.**

## What's Graded

The A/B agent labels and User 1/2 examples below define a representative demo fixture. They do not cap the number of configured agents or group members. These trials validate the stated demo capacity only; a larger deployment needs load tests at its own configured concurrency.

The evaluator grades only the sealed snapshot of the main branch, taken after the trial’s tasks have merged, and "passed" comes only from it. It runs:

* each module's hidden tests
* an integration test of the signup flow across A and B
* a baseline suite for behavior that existed before

Each task’s pull request and merge history is supporting evidence, not proof that each agent stayed in its own worktree.

## Frozen Before Trial 1

* The fixture, hidden tests, prompts, model and settings, and grading rules are all versioned.
* Each trial records the application commit, the Pi Durable and Telegram scaffold versions with any patches, container image digests, the tool policy version and container limits.
* All runs are reported, and no failed run is rerun or replaced.
* Any build or grading change starts a new, separately reported evaluation series.

## Quality Track (3 clean trials, 2 of 3 must pass)

In the representative demo, User 1 and User 2 submit tasks to example agents A and B at the same time in one group, with follow-ups during the runs. These labels describe the test fixture, not system-wide user or agent limits.

A trial passes when both tasks’ pull requests are approved and merged, all graded suites pass, the agents' work overlaps in time, and no change is overwritten unintentionally.

## Fault Track (same build, 100% every time)

The fault suite runs 3 times against the frozen build. Every defined check must pass. A skipped or unexecuted check is reported as "not tested", never as a pass.

| Check                              | How it's injected                                                                                                                                                            | Pass condition                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Write safety                       | Out-of-scope edit/write/new-file/symlink/.. and run\_check subprocesses; writes to another worktree or git data; protected-file reads; container network; Pi metadata access | Writes denied or fail closed; protected-file reads fail; no container network; no Pi metadata access                                                                                                                                                           |
| Permissions                        | Follow-up, approval or cancel from a non-creator, non-owner                                                                                                                  | Rejected                                                                                                                                                                                                                                                       |
| Steer while busy                   | Reply during an active run                                                                                                                                                   | Delivered to the same task's conversation                                                                                                                                                                                                                      |
| Duplicate update ID                | Resubmit the same Telegram update                                                                                                                                            | One submission only                                                                                                                                                                                                                                            |
| Accepted follow-up outcomes        | Finalize with pending follow-ups                                                                                                                                             | Every accepted follow-up ends as delivered, expired or started as another run of the same task; tasks report their own final state                                                                                                                             |
| Steer at normal completion         | Accepted steer still unconsumed when the run completes                                                                                                                       | One successor run in the same task, same requestId; same cap, deadline and budget                                                                                                                                                                              |
| Steer with cap used                | Unconsumed steer after the 30-request cap is reached                                                                                                                         | Steer expires; no new run                                                                                                                                                                                                                                      |
| Cancel or limit with pending input | Cancel, or hit a limit, with a steer pending                                                                                                                                 | Pending input expires; no run starts after revocation; only the current tool round may finish                                                                                                                                                                  |
| Follow-up during review            | Reply while the task is in review                                                                                                                                            | Another admitted run on the same branch and pull request, or rejected                                                                                                                                                                                          |
| Follow-up after merge              | Reply after the task merged, was cancelled or hit a limit                                                                                                                    | Rejected with a hint to send a new /task                                                                                                                                                                                                                       |
| Stale approval                     | Approve, then push a new commit before the merge                                                                                                                             | Approval rejected; nothing merges                                                                                                                                                                                                                              |
| Merge conflict                     | Two tasks edit the same lines; merge the second                                                                                                                              | Nothing merges; conflicting files listed; a fix run is admitted automatically, then retested and approved again                                                                                                                                                |
| Main branch moved                  | Merge another task while one is approved                                                                                                                                     | Combined result tested; approval required again                                                                                                                                                                                                                |
| Main branch moved during merge     | Change the main branch between the Coordinator’s check and GitHub’s merge                                                                                                    | GitHub refuses; the Coordinator starts over                                                                                                                                                                                                                    |
| Restart mid-merge                  | Kill the Coordinator after GitHub merges but before the record is saved                                                                                                      | Recovery sees the main branch contains the commit; no second merge                                                                                                                                                                                             |
| Lost pull request response         | GitHub opens the pull request but the response is lost                                                                                                                       | Recovery finds it by repository, base and head branch; no second pull request                                                                                                                                                                                  |
| Restart after acceptance           | Kill the Coordinator after a command is saved but before Telegram confirms the reply                                                                                         | The command is applied once; the reply is sent after restart, possibly twice                                                                                                                                                                                   |
| Delivery backlog                   | Build a progress backlog and inject Telegram 429s                                                                                                                            | Required messages go out before progress; none are dropped                                                                                                                                                                                                     |
| Check tampering                    | A task tries to change the run\_check operation list                                                                                                                         | The change is denied; checks run unchanged                                                                                                                                                                                                                     |
| Task disk full                     | Fill the task disk during a run                                                                                                                                              | Commands are still saved and acknowledged; the run stops and is verified gone; unpushed work is kept                                                                                                                                                           |
| Task disk missing                  | Start the VM without the task disk mounted                                                                                                                                   | Docker and the Coordinator don’t start; nothing is written to the boot disk                                                                                                                                                                                    |
| Cancel in review                   | Cancel a task with an open pull request                                                                                                                                      | Pull request closed; worktree archived                                                                                                                                                                                                                         |
| Cancellation                       | Cancel a running task                                                                                                                                                        | Workload terminated and verified gone; remaining work committed as a final checkpoint; worktree archived                                                                                                                                                       |
| Coordinator kill mid-run           | Kill Coordinator during a run                                                                                                                                                | Run failed as interrupted; worktree kept; conversation quarantined; no auto-resume; queued stay queued; no double admission; judged on recovery, not on finishing                                                                                              |
| Frozen group                       | Freeze the group while other tasks run and tasks are queued                                                                                                                  | No dispatch or merges; all other running tasks cancelled as "group frozen"; tasks in review keep their pull requests; new tasks, follow-ups and approvals rejected with a frozen notice; /status works; queued tasks stay queued; only the owner CLI unfreezes |
| Uncertain edit                     | Inject an uncertain edit outcome                                                                                                                                             | Reconciled or group freezes                                                                                                                                                                                                                                    |
| 30-request cap                     | Recording relay counts retries                                                                                                                                               | Cap holds, retries included                                                                                                                                                                                                                                    |
| Over-48K input                     | Assemble input above 48K                                                                                                                                                     | Refused before send                                                                                                                                                                                                                                            |
| Container limits                   | Hit each container limit                                                                                                                                                     | Named outcome returned                                                                                                                                                                                                                                         |
| 10-minute deadline                 | Let a run exceed 10 minutes                                                                                                                                                  | Deadline fires; task fails; pull request closed; worktree archived                                                                                                                                                                                             |
| Budget reservation                 | Concurrent reservations; unknown usage; restart with outstanding reservations                                                                                                | Stay within ceiling; unknown keeps reservation; restart is safe                                                                                                                                                                                                |

## Stress Test

| Test                    | Load                                                                                                                  | Measured evidence                                                               | Pass condition                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Queue saturation        | Fill and exceed every configured queue cap.                                                                           | Queue positions and rejection reasons.                                          | Positions are correct; excess submissions get “queue full”.                               |
| Acknowledgement latency | Demo capacity occupied throughout: 4 test users send 100 synthetic /status commands within 60 s; 3 runs, 300 samples. | Per-run p95, count, failures and 429s; Telegram timestamp → reply confirmation. | Target p95 within 2 s in each run. This declared stress workload is not expected traffic. |
| Hostile checks          | Fork bomb, memory exhaustion and endless loop.                                                                        | Containment and stop / limit outcomes.                                          | Each stays contained.                                                                     |
| Model faults            | Inject 429s and 5xx at the relay.                                                                                     | Retry, refusal and run-limit evidence.                                          | Existing retry and run limits must hold; no new numerical threshold is specified.         |

### Latency method and evidence

* Each run reports its own p95, never only a pooled figure.
* Local receive-to-confirm latency is also recorded, and Telegram's timestamp precision is noted.
* Model or transport throttling is reported as such, not blamed on the VM.
* This `/status` run is not evidence for all commands; `/task`, follow-up, `/approve` and `/cancel` acknowledgements are measured in the quality trials, with 2 tasks running, against the same 2-second p95 target, and each trial reports its sample count.

Each run reports the first resource to saturate, using [Deployment measurements](deployment.html#6-7-measurements-stress-test-and-spof-report).

## SPOF and Bottleneck Report

For each SPOF (VM, zone, Coordinator, model provider, Telegram, GitHub, a person for frozen groups):

* what fails
* the effect
* the recovery time, or "not tested" for failures we didn't inject (VM, zone)
* the mitigation we didn't build

The bottleneck is named from the measurements, not assumed.

[PreviousDeployment](deployment.html)

On this page

[What's Graded](#7-1-what-s-graded "What's Graded")[Frozen Trial Build](#7-2-frozen-before-trial-1 "Frozen Before Trial 1")[Quality Track](#7-3-quality-track-3-clean-trials-2-of-3-must-pass "Quality Track (3 clean trials, 2 of 3 must pass)")[Fault Track](#7-4-fault-track-same-build-100-every-time "Fault Track (same build, 100% every time)")[Stress Test](#7-5-stress-test "Stress Test")[Failures and Bottlenecks](#7-6-spof-and-bottleneck-report "SPOF and Bottleneck Report")

## Post-acceptance cleanup closeout

Branch cleanup stays disabled for all frozen quality, fault and stress runs. Only after those runs finish and their PASS/FAIL/NOT TESTED evidence is saved may the owner-approved cleanup policy be activated. This does not convert a failed or incomplete formal acceptance into a pass.

A separate disposable task must demonstrate Telegram approval, actual GitHub merge, task completion and worktree archival before the independent worker deletes its remote feature branch. Confirm the PR page shows deletion and PR/head/merge records remain intact. Verify the exact authorized historical task/1 through task/5 PR pages separately. All open, unmerged, failed and cancelled task branches stay. Cleanup failure is a housekeeping result and cannot change a successful merge/task to failed. See [the operational policy](../docs/branch-cleanup.md).
