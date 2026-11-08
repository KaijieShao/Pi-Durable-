---
title: "Pi Durable Agents"
slug: pi-durable-agents-0rrc3e
version: 64
htmlUrl: https://pi-durable-agents-0rrc3e.artifactcafe.dev/v64/deployment.html
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

OperationsDeployment

# Deployment

What runs on GCP, and how it’s secured and observed.

## Topology

This deployment is the demo sizing configuration, not a fixed agent roster. Available agents and execution capacity are separate settings; additional agents do not automatically launch more containers. Raising concurrent execution requires re-budgeting and validating the host resources described in Capacity.

What runs on the VM

What runs on the VMOne e2-standard-4 VM with a private IPv4 address only. Inside: the watchdog unit, the coordinator unit (Telegram poller, relay, outbox, owner socket), the Pi slice, and agent and check containers with no network. After sealing, a single evaluator container (2 vCPU, 2 GiB, no network) runs; it does not run alongside execution. Dispatch stays held until it exits and cleanup is verified. The watchdog stop path reaches the Pi slice and both agent and check containers. The coordinator reaches Telegram, and the relay reaches the model API, outbound through public Cloud NAT. The operator reaches SSH port 22 only through IAP from 35.235.240.0/20\. Secret Manager supplies the model key, Telegram token and GitHub token only to the Coordinator, through the VM service account. IAP and Secret Manager are separate from NAT.E2-STANDARD-4 VM · PRIVATE IPV4 ONLYwatchdog unitseparate stop pathstops slice, containerscoordinator unitpoller · relay · outboxowner socketPi slicePi processes, own unprivileged userAgent containersno networkCheck containersno networkEVALUATION PHASE · AFTER SEALINGEvaluator container2 vCPU, 2 GiB, no network; not alongside executionstopPublic Cloud NAToutbound onlyTelegram, GitHubCoordinator onlyModel APIrelay onlyoutboundSecret Manager3 secretsto Coordinator onlyOperatorIAP35.235.240.0/20SSH port 22 only

Cloud NAT carries only outbound traffic: the Coordinator to Telegram and GitHub, and the relay to the model API. IAP ingress and Secret Manager are separate paths. Containers have no network. The evaluator runs only after sealing, not alongside the agent and check containers. Dispatch stays held until the evaluator exits and cleanup is verified.

One **e2-standard-4** Compute Engine VM in one zone, with a private IPv4 address only and Docker for the containers. It runs continuously, so no command waits for a server to start.

### No public application ingress

SSH port 22 is allowed only from IAP's range `35.235.240.0/20`.

**Public Cloud NAT** provides outbound access to Telegram, GitHub and the model API.

### Sizing

The e2-standard-4 is sized for the execution phase (4 vCPU and 5 GiB allocated, against 3 vCPU and 4 GiB for evaluation). These are starting budgets, to be validated by the stress test (see [Resource Estimates](capacity.html#2-2-resource-estimates)).

### Evaluation exclusivity

Evaluation runs only in the trial harness. Dispatch stays held from sealing until the evaluator has exited and its cleanup is verified. New `/task` commands may be accepted and queued within the usual limits, and they wait until dispatch reopens. Execution and evaluation never overlap.

## Processes

| Process / workload       | Role                                             | Isolation / lifetime                                                                       |
| ------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| coordinator systemd unit | Telegram poller, relay, outbox and owner socket. | One process, restarted automatically by systemd; run-scoped keys and durable SQLite state. |
| watchdog systemd unit    | Independent stop path.                           | Separate unit; survives a Coordinator crash.                                               |
| Pi processes             | One process per run.                             | Own unprivileged user; dedicated systemd slice.                                            |
| Agent / check containers | Untrusted tools and approved checks.             | Docker labels carry task ID and generation; no network.                                    |
| Evaluator container      | Grades the sealed snapshot.                      | Trusted, exclusive phase after sealing; no network.                                        |

Every container carries Docker labels for the task ID and generation. Pi processes run as their own unprivileged user in a dedicated systemd slice.

**On any Coordinator restart**, the watchdog (still running):

1. kills everything in the slice and every labeled container
2. verifies both are empty
3. only then lets admission reopen, via the [restart recovery steps](interfaces-and-storage.html#4-4-recovery-after-a-restart)

## Network

* **Containers:** no network.
* **Model traffic:** only the relay holds the real model key, and Pi gets only its run key.
* **The Coordinator** reaches Telegram and GitHub through NAT. Only the Coordinator runs git or holds the GitHub token.
* **The metadata server** is blocked for the Pi user by a host firewall rule covering every configured metadata address. This is verified at deployment.

## Secrets

The model key, the Telegram token and the GitHub token are in Secret Manager. The GitHub token is fine-grained, limited to this repository, with access to contents and pull requests only.

A dedicated VM service account has `secretAccessor` on **only those three secrets**, with the `cloud-platform` scope. There's no downloaded key file.

The secrets are held only in the Coordinator's memory.

## Disk and Data

A 20 GiB boot disk holds the Coordinator database, the outbox, Pi’s stores and the logs. A separate persistent task disk holds the git repository, one worktree per open task, build output, check scratch space and Docker’s data. Both are budgeted as in Capacity. If the task disk isn’t mounted at startup, Docker and the Coordinator don’t start, so task writes can never land on the boot disk.

On GitHub, a rule on the main branch requires pull requests to be up to date before merging, and only the Coordinator’s token merges.

**No backup of the VM disk is claimed**, since local durability covers a process crash only. Merged work and pushed checkpoints also live on GitHub.

## Logs

### Metadata only, with allowlisted fields

IDs, counts, tokens, outcomes, denial categories and hashes. They hold no raw prompts, tool output, headers or free-text error details.

Raw content lives only in Pi's store, readable only by the Pi and Coordinator users, and kept for the trial and then deleted.

## Measurements (stress test and SPOF report)

| Metric                                      | Source to record                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| p95 acknowledgement latency and queue depth | Telegram timestamps and confirmation; Coordinator acceptance / queue records. |
| Model latency                               | Relay request timing.                                                         |
| Outstanding token reservations              | Budget ledger.                                                                |
| CPU, memory, disk usage and free space      | VM and container resource measurements.                                       |
| Container out-of-memory and kill counts     | Container / watchdog stop evidence.                                           |
| Relay refusals                              | Relay refusal outcomes.                                                       |
| Freezes                                     | Coordinator group-state transitions.                                          |
| Watchdog health                             | Watchdog checks and verified stop evidence.                                   |

These are planned measurements for the stress test and SPOF report, not collected results. Metadata logs retain only allowlisted fields.

## Trial Reset (test workspace only, destructive)

1. Pause submissions.
2. Export the results.
3. Close pending work with explicit outcomes.
4. Stop the Coordinator and revoke all keys.
5. The watchdog terminates and verifies all workloads, and only then is the watchdog stopped.
6. Wipe the test databases, worktrees and test repository, close the test pull requests, and reinstall the fixture.
7. Start fresh, skipping old Telegram updates. This is a deliberate test-only step, never part of normal recovery.

## Accepted SPOFs

| Failure / dependency           | Effect                                                                                                                 | Recovery boundary                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| VM                             | All local processes and stores are unavailable; disk / VM loss is not covered; work already pushed to GitHub survives. | Process restart recovery does not provide VM-loss recovery. VM-loss recovery time is “not tested”.                       |
| Zone                           | The single-zone deployment becomes unavailable.                                                                        | No cross-zone failover is built. Zone recovery time is “not tested”.                                                     |
| Coordinator (including relay)  | Routing, model admission and replies stop.                                                                             | The watchdog stops and verifies workloads; restart reconciliation precedes new dispatch. Interrupted runs do not resume. |
| Model provider                 | New model responses are unavailable or throttled.                                                                      | Bounded retries and run limits apply; model faults are injected at the relay. No provider failover is built.             |
| GitHub                         | Reviews and merges stop; runs continue, and their branches wait to be pushed.                                          | Push and merge calls retry with backoff; GitHub’s state is checked before any retry. No alternative remote is built.     |
| Telegram                       | Commands or replies may be delayed or unavailable.                                                                     | Durable polling offset and outbox; retry transient delivery failures. Delivery is at-least-once.                         |
| Person resolving frozen groups | A frozen group cannot dispatch while resolution is pending.                                                            | Owner review, explicit unfreeze, then repeated recovery checks. No automatic resolution.                                 |

Recovery times must be reported from tests; no measurements are claimed here. See [Evaluation’s failure report](evaluation.html#7-6-spof-and-bottleneck-report) for evidence requirements.

**Deployment checks:** tests must show that the slice and label cleanup survives escape and restart, and that the metadata block holds.

[PreviousAgent Execution](agent-execution.html)[NextEvaluation](evaluation.html)

On this page

[Topology](#6-1-topology "Topology")[Processes](#6-2-processes "Processes")[Network](#6-3-network "Network")[Secrets](#6-4-secrets "Secrets")[Disk and Data](#6-5-disk-and-data "Disk and Data")[Logs](#6-6-logs "Logs")[Measurements](#6-7-measurements-stress-test-and-spof-report "Measurements (stress test and SPOF report)")[Trial Reset](#6-8-trial-reset-test-workspace-only-destructive "Trial Reset (test workspace only, destructive)")[Accepted SPOFs](#6-9-accepted-spofs "Accepted SPOFs")
