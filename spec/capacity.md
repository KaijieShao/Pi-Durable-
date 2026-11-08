---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/capacity.html
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

FoundationsCapacity

# Capacity

How big the load is, and the limits that keep it bounded.

## Expected Workload

Available agents are configured by ID. Registering an agent does not reserve an execution slot, and neither does a task waiting for review. The demo has a deployment-wide limit of 2 concurrent runs across all groups, and 1 run per agent. Additional ready tasks wait within the configured queue bounds; excess submissions are rejected. These are provisional design budgets for the demo configuration, not measured capacity.

### Demo peak design point

The demo execution capacity is occupied by 2 concurrent runs, with 2 tasks waiting per agent (4 per group). These are demo settings, not limits on the number of users or available agents. Peak active work, not the registered agent count or average load, sizes the deployment.

### Command traffic

A handful of Telegram commands a minute is low QPS. One Coordinator is our starting design choice, not capacity proven by that number.

### Per run

Up to 30 model requests and 10 minutes. Tokens per run are to be measured. A task can have several runs: the first one, plus one for each follow-up sent after a run ends, and one for each conflict fix, before its merge. A follow-up sent during a run steers that run instead.

## Resource Estimates

For R concurrent runs, the provisional execution budget is `1 + 1.5 × R` vCPU and `2 + 1.5 × R` GiB: each run reserves an agent container (0.5 vCPU, 0.5 GiB) and a check container (1 vCPU, 1 GiB), even when a check is idle.

With R = 2, that is 4 vCPU and 5 GiB on an e2-standard-4 (4 vCPU, 16 GiB), leaving 11 GiB beyond the stated execution allocation. CPU is the binding constraint in this provisional arithmetic, not a measured guarantee. The host reserve includes Pi processes and host services at the demo concurrency; their overhead, disk, token limits and safety headroom must also be checked before raising R.

### Containers

For the demo execution capacity, budget the larger of two phases: execution (2 agent containers + 2 check containers) or evaluation. The tests before a merge run in a check container that reserves an execution slot like a run, so they fit the same budget. Each container gets a provisional CPU and memory limit, validated by the stress test.

### Provisional container limits

| Allocation                        | CPU cap  | Memory cap |
| --------------------------------- | -------- | ---------- |
| Agent container, per running task | 0.5 vCPU | 512 MiB    |
| Check container, per running task | 1 vCPU   | 1 GiB      |
| Host reserve, demo concurrency    | 1 vCPU   | 2 GiB      |
| Evaluator, exclusive phase        | 2 vCPU   | 2 GiB      |

The host reserve covers the Coordinator, watchdog, concurrent Pi processes and Docker. These are provisional budgets; runtime validation is pending.

### Evaluator

Runs only after all active runs in the group are finalized, in a single container with 2 vCPU and 2 GiB, and grades the suites sequentially.

### Exclusive phases

Evaluation and execution are never concurrent; the 4 vCPU covers whichever is running. Dispatch stays held until the evaluator exits and cleanup is verified.

### Peak sizing

The demo execution phase (2 agent containers + 2 check containers + the host reserve) needs 4 vCPU and 5 GiB; evaluation (the evaluator + the host reserve) needs 3 vCPU and 4 GiB. Execution is the larger phase, so the VM is an e2-standard-4 (4 vCPU, 16 GiB). This fit is on paper only, and CPU limits are caps.

### Resizing

We resize to an e2-standard-8 only when sustained CPU pressure correlates with queueing, slower checks or acknowledgement misses. Model-bound waiting doesn't justify a resize. The peak containers, the Coordinator, the demo’s 2 concurrent Pi processes and host overhead, plus headroom, must also fit in memory; if they don't, we resize the VM.

### Status

All of these allocations are starting budgets, to be validated by the stress test, not a measured fit.

### Disk

The 20 GiB boot disk gets separate budgets for retained trials, metadata-only logs, Pi’s raw-content store and the database, each with a retention rule. When its free space runs low, new tasks are rejected with a reason.

Each open task keeps one worktree until it is archived. The limit of 4 open tasks per group bounds their number. A separate task disk holds the git repository, worktrees, build output, check scratch space and Docker’s images, writable layers and caches. Its size is set by the stress test, so task writes can’t fill the boot disk. If a new worktree would exceed it, the task stays queued and the bot says why.

### Context

The model-call boundary checks the fully assembled input: instructions, history, tool definitions and tool results. Any request estimated above 48K tokens is refused before it is sent, and the run stops with a clear reason.

### Follow-up context

Steered follow-ups add to the run’s input, so the same 48K check on the fully assembled input covers them.

### Provisional resource budgets (not measured)

Demo budget on 4 vCPU / 16 GiB. Execution and evaluation are exclusive phases, not simultaneous allocations. Runtime validation is pending.

Execution · CPU

Host: 1 vCPUAgents ×2: 1 vCPUChecks ×2: 2 vCPU

Evaluation · CPU

Host: 1 vCPUEvaluator: 2 vCPUUnallocated: 1 vCPU

Execution · memory

Host: 2 GiBAgents ×2: 1 GiBChecks ×2: 2 GiBUnallocated: 11 GiB

Evaluation · memory

Host: 2 GiBEvaluator: 2 GiBUnallocated: 12 GiB

Execution allocates 4 vCPU / 5 GiB; evaluation allocates 3 vCPU / 4 GiB. Unallocated capacity is not a validated concurrency allowance. Evaluation holds dispatch until it exits and cleanup is verified.

## Concurrency and Resource Limits

### Queue

At most one task runs per agent, and every dispatch also needs a deployment-wide execution slot. Queue bounds are configured independently of the number of available agents. The demo allows:

* 2 waiting tasks per agent.
* 4 waiting tasks per group.
* 4 waiting tasks per user.

Each group can also have up to 4 open tasks, counting those running or waiting for review. Queued tasks don’t count toward it; they wait until the group has fewer than 4 open tasks. A follow-up run on a task in review reuses its worktree, so it doesn’t count as another open task, though it still needs an execution slot. Submissions beyond a queue bound are rejected immediately with “queue full”; an accepted submission is acknowledged with its queue position.

### Waiting

Waits of about 20 minutes are a healthy-operation estimate, not a guarantee. Freezes, restarts, sealing and tasks waiting for review can make waits longer. A queued task never expires on its own: it waits until it starts or its creator or the group owner cancels it, and the bot tells the user when it is waiting for reviews to finish.

### Fixed limits

| Limit                       | Value                                     | Enforced by                                                                              |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| Model requests              | 30 per run, retries included              | Model relay; a run and its successor run share the count.                                |
| Retries                     | At most 2 per call                        | Pi durable retry; provider retries are disabled.                                         |
| Run deadline                | 10 minutes                                | Independent watchdog.                                                                    |
| Check deadline              | 60 seconds                                | run\_check container time limit.                                                         |
| Input / output              | 48K input / 16K output tokens per request | Model-call boundary and configured request limits.                                       |
| Project token ceiling       | Owner-set                                 | Atomic reservation before requests; unknown usage keeps its reservation.                 |
| Waiting queue (demo)        | 2 per agent / 4 per group / 4 per user    | Coordinator admission; excess submissions rejected.                                      |
| Open tasks (demo)           | 4 per group, running or in review         | Coordinator dispatch; queued tasks don’t count.                                          |
| Follow-ups                  | 5 per task; 4,000 characters each         | Coordinator checks before saving.                                                        |
| Concurrent execution (demo) | 2 deployment-wide; 1 per agent            | Atomic slot reservation before every dispatch, including follow-up runs and merge tests. |
| Merges                      | 1 at a time per repository                | Coordinator merge lock.                                                                  |

### Steering doesn't reset budgets

A steered follow-up stays within the active run’s 10 minutes, 30 model requests and token budget.

### Follow-up runs are admitted like new work

A follow-up run before the merge is admitted like any new task and counts toward the per-agent, per-group and per-user caps and the owner's token ceiling. While it waits it holds no execution slot and does no model or tool work.

### Token budget reservation

Before each model request, its input allowance plus maximum output is reserved against the project ceiling, atomically. Retries and follow-up runs reserve too. Actual usage is reconciled afterward, and the reservation is kept when usage is unknown.

[PreviousRequirements](requirements.html)[NextArchitecture](architecture.html)

On this page

[Expected Workload](#2-1-expected-workload "Expected Workload")[Resource Estimates](#2-2-resource-estimates "Resource Estimates")[Concurrency and Limits](#2-3-concurrency-and-resource-limits "Concurrency and Resource Limits")
