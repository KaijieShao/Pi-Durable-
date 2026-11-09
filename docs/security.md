# Security in detail

The design is in [spec/architecture.md](../spec/architecture.md#trust-boundaries) and
[spec/deployment.md](../spec/deployment.md). Trusted: the Coordinator, Pi, the relay, the tool hooks, the expected
test outputs, the watchdog, the evaluator and the GitHub repository settings. Untrusted: model output, tool arguments
and generated code.

- **One group, explicit roles.** Only the configured group (and topic) is served; every other chat is ignored and
  nothing from it is stored or sent to the model. Only a task's creator and the configured owner can follow up on,
  approve or cancel it; `TELEGRAM_MEMBER_IDS` optionally limits who may submit tasks.
- **Secrets stay in the Coordinator.** The bot token, the model key and the GitHub token are read at start and then
  removed from the process environment. The model key is used only by the relay; each Pi process gets a run key that
  the relay accepts only while that run is open, and only for `POST /v1/responses` on 127.0.0.1. Under systemd
  isolation the run key is the first frame on the Pi process's stdin, never in its argv, environment or unit
  properties. Only the Coordinator runs git (with the repository's hooks and local configuration disabled) and calls
  GitHub; the token travels in an environment header, never in a command line, URL or log.
- **Pi processes are isolated** ([isolation.md](isolation.md)). Linux requires `PI_RUNNER_ISOLATION=systemd`;
  the Coordinator and watchdog reject `process` before starting (configuration error, exit 2). Each run is a
  transient unit in the dedicated slice `pi-durable-runs.slice`, as its own unprivileged
  user `pi-runner`: read-only system, no home directories, private /tmp and devices, no new privileges, no
  capabilities, loopback-only network (the relay), memory, task and runtime limits. A host nftables rule drops the
  Pi user's traffic to every metadata address and everything off loopback. Its conversation files are readable by
  the Pi and Coordinator users only. If the slice, systemd or the directory layout is missing, no run starts. On a
  Mac (`process` mode) Pi runs as your user with none of this: the weaker local mode.
- **No arbitrary shell.** The model has `read`, `edit` and `write` inside the task's worktree, and `run_check` with
  the fixed operations of the pinned check image. A policy hook in Pi and the Coordinator both validate every call
  (relative paths inside the worktree, no `..`, no `.git`).
- **Containers.** File operations run in a per-run agent container, checks in a separate check container: no network,
  read-only root filesystem, non-root user, all capabilities dropped, no new privileges, CPU, memory and process
  limits, only the task's worktree mounted with its `.git` masked, no credentials or secret environment.
- **The watchdog: an independent stop path** ([the watchdog](#the-watchdog)). A separate process (its own systemd
  unit and user in production) that survives a Coordinator crash. At every Coordinator start, and during the recovery
  checks of an owner unfreeze, it kills everything in the Pi slice and every container labelled `pi-durable.managed=1`,
  verifies both are empty, and only then does the Coordinator dispatch again. While no Coordinator runs it removes
  whatever was left; it enforces each run's 10-minute deadline on its own.
- **Fail closed.** If Docker or the images are unavailable, or the Pi process isolation (systemd, the slice, the
  host setup), or the watchdog (no verified sweep, or no heartbeat for 15 s), no execution starts; commands are still
  saved and queued. If a stop or a GitHub outcome cannot be confirmed, by the Coordinator or by the watchdog, the group
  freezes until the owner resolves it and unfreezes it with the owner CLI ([the owner socket](#the-owner-socket)): the
  running Coordinator repeats its recovery checks while the group stays frozen and unfreezes it only if every one
  passes. So does a file change whose outcome stays
  unknown: each `edit`/`write` saves its intent (file, hash before, intended hash) before it runs; after an unknown
  outcome the run is stopped and, once its processes and containers are verified gone, the Coordinator hashes the
  file itself (no symlink followed, confined to the worktree): applied or currently unchanged, else frozen. An
  interrupted run's changes are never committed or pushed at recovery. A push GitHub refuses because a task branch
  was changed outside the Coordinator is a known outcome (nothing was pushed): the Coordinator never force-pushes, and
  only that task waits, with its worktree kept, until the branch is restored.
  A deleted published branch or closed original PR likewise holds only its active task: periodic review reads take
  no execution slot, new runs/approvals wait, and restoring requires the original PR. Its number is bound as soon
  as it is observed, including closed history after a lost response; no replacement PR is opened. An active push
  uses a private, fixed Coordinator-owned pre-push guard to reject an absent remote OID advertised by that push;
  receive-pack's old-OID check rejects deletion after advertisement. It is still an ordinary fast-forward push,
  with no force option, and no repository/project hook runs. Terminal final-checkpoint preservation and archive
  behavior are unchanged; completed tasks are never monitored as active reviews.
- **The isolated evaluator** ([the evaluator](#the-isolated-evaluator)) grades a read-only snapshot of main with the
  hidden tests in its own trusted container (no network, no credentials, 2 vCPU / 2 GiB), started only by the
  Coordinator after the owner seals the group, while dispatch is held deployment-wide. The hidden tests are never
  mounted in an agent or check container: their directory must be outside the data and task directories.
- **The owner CLI talks only to the running Coordinator, over an owner-only Unix socket** ([the owner
  socket](#the-owner-socket)): it never writes the database; the transcript of a quarantined conversation goes to the
  owner's terminal only, read without writing anything.
- **Logs are metadata only:** ids, counts, outcomes, denial categories and hashes; never message text, prompts, tool
  output, headers or secrets. Raw task and follow-up text is stored only in the Coordinator's SQLite database (mode
  600; 660 shared with the watchdog's group when `PI_STATE_GROUP` is set) and the Pi conversation stores under `PI_DATA_DIR` (mode 700 locally; under systemd isolation 0660 files in a
  2770 directory shared by the Pi and Coordinator users only).
- **Verified only at deployment on Linux:** the systemd isolation, the polkit rule and the firewall rule
  ([isolation.md](isolation.md#verify-at-deployment)), and the watchdog's slice cleanup against the real cgroup tree
  (`test/watchdog/slice-linux.test.ts`); locally, Pi processes run as your user.

## The watchdog

[spec/deployment.md](../spec/deployment.md) § Processes: "watchdog systemd unit — Independent stop path — Separate
unit; survives a Coordinator crash"; [spec/architecture.md](../spec/architecture.md) § Watchdog. Code:
`src/watchdog/` and `pi-durable-telegram watchdog [--env-file p]`; unit: `deploy/systemd/pi-durable-watchdog.service`.

| | |
|---|---|
| What it holds | No secret: it reads only `PI_DATA_DIR`, `TELEGRAM_GROUP_CHAT_ID`, `DOCKER_BIN`, `PI_RUNNER_ISOLATION`, `PI_RUNNER_SLICE`, `SYSTEMCTL_BIN`, `LOG_LEVEL` (from an env file it takes only these lines) and removes any secret variable from its environment |
| How it talks to the Coordinator | Rows of the Coordinator's SQLite file (its own connection): sweep requests and answers in `watchdog_sweeps`, its heartbeat in `meta`. A freeze it decides is written in the same transaction as its answer, with the group notice in the outbox |
| Pi processes | Systemd isolation: every process in the slice's control group (`systemctl show -p ControlGroup`, then `cgroup.procs` of it and every cgroup below), SIGKILLed and listed again until empty: a process cannot leave its cgroup, so a `setsid` or double-fork escape is still caught. Process isolation (Mac): the runner's command line with this deployment's marker. Both under systemd |
| Containers | Every container labelled `pi-durable.managed=1` (`docker rm -f`, listed again until none is); for a deadline, the run's task and generation labels |
| Verified | Both lists read again and empty, with a bounded retry. Anything left, or a list that cannot be read, is an unverified stop: the group freezes |
| When | Each Coordinator start (recovery step 2, before dispatch reopens) and each owner unfreeze (its recovery checks, while the group is still frozen), on request; on its own when the Coordinator's lock is gone or its owner dead and anything is left; for a run still starting, running or finalizing 60 s past its deadline (an unverified stop there freezes the run's own group, even if the watchdog's `TELEGRAM_GROUP_CHAT_ID` differs: that mismatch is logged as `watchdog_group_mismatch`) |
| Gate | The Coordinator dispatches, merges and runs its recovery checks only after its own verified sweep and while the heartbeat is younger than 15 s; it waits 30 s for an answer at start, then runs paused (commands queued, the group told once) and resumes by itself when the watchdog answers |

Production host setup (after [isolation.md](isolation.md#one-time-host-setup-linux)), as root:

```sh
useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin pi-watchdog
usermod --append --groups pi-watchdog pi-coordinator     # the Coordinator hands its database to this group
setfacl -m u:pi-watchdog:x /var/lib/pi-durable          # traverse the data directory, nothing more
install -m 0644 deploy/systemd/pi-durable-watchdog.service deploy/systemd/pi-durable-coordinator.service \
  /etc/systemd/system/
install -D -m 0644 deploy/systemd/docker.service.d/pi-durable-task-disk.conf \
  /etc/systemd/system/docker.service.d/pi-durable-task-disk.conf
```

- The Coordinator's env file sets `PI_STATE_GROUP=pi-watchdog`: at every start it hands `coordinator.sqlite` (and its
  `-wal`, `-shm`) to that group with mode 0660 and its lock file with 0640. The Pi user must not be in that group
  (the Coordinator refuses to start otherwise); the database holds raw task text. Without `PI_STATE_GROUP` both stay
  owner-only (0600), for a watchdog that runs as the Coordinator's user, as on a Mac.
- The watchdog's unit runs as `pi-watchdog` with `SupplementaryGroups=docker` (the Docker socket),
  `AmbientCapabilities=CAP_KILL` and `CapabilityBoundingSet=CAP_KILL` (SIGKILL of the Pi user's processes, nothing
  else), `NoNewPrivileges`, a read-only system except the data directory, `ProtectControlGroups` (the cgroup tree is
  read only), no network (`RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any`), `Restart=always`.
- The watchdog creates no file in the data directory: after a clean stop of both it opens the database once the
  Coordinator has (re)created its WAL files; meanwhile the Coordinator, if it starts, waits for the answer as above.
- One deployment per Pi slice and per Docker daemon: the watchdog kills everything in the slice and every labelled
  container there, as the deployment design says.
- One watchdog acts per Coordinator database: the one whose pid holds the heartbeat. A second one (started by
  mistake) logs `watchdog_standby`, writes and kills nothing, and takes over only once the first one is gone, stalled
  or stopped (its heartbeat older than 5 s), so a sweep never runs after another watchdog's answer reopened dispatch.

## The owner socket

[spec/interfaces-and-storage.md](../spec/interfaces-and-storage.md) § Interfaces, Owner CLI: "A local socket for
status, frozen-group resolution, failed events and read-only inspection of quarantined conversations"; § Recovery
After a Restart: "The owner unfreezes through the CLI, then recovery checks repeat before dispatch opens for admitted
work" and "Its conversation is quarantined and opened only read-only". Code: `src/coordinator/owner/` (the
Coordinator's side), `src/cli/owner.ts` and `src/cli/owner-client.ts` (the CLI).

| | |
|---|---|
| Where | `<PI_DATA_DIR>/owner/owner.sock`, a Unix domain socket the Coordinator binds right after it opens its database (status answers during startup too; an unfreeze waits until the engine runs) and removes when it stops |
| Files | The directory `owner/` is 0700 and the Coordinator user's (an existing one of its own is tightened; another owner, a symlink or not a directory refuses the start). The socket is 0600, set right after bind and verified (the 0700 directory covers the moment in between). `owner.token`: 32 random bytes in hex, new at every start, 0600, created exclusively and never through a symlink, removed on stop |
| Who may connect | Node exposes no peer credentials of a Unix socket (no SO_PEERCRED or getpeereid), so the peer's uid is not read. What is enforced instead: the client must search the 0700 directory and connect to the 0600 socket (Linux checks write permission on the socket), and every request must carry the token it read from the 0600 file (compared in constant time): only the Coordinator's user and root can do all three. On the VM the owner runs the CLI as that user: `sudo -u pi-coordinator node /opt/pi-durable/src/cli/main.ts owner status --env-file /etc/pi-durable/coordinator.env`. The CLI first checks the directory is its own and not reachable by others; otherwise it sends nothing (no token goes to a socket someone else could have placed) |
| Stale socket | A socket file a crashed Coordinator left behind is removed at the next start, but only if it is a socket and nothing answers on it (the data directory's lock is held already, so no other Coordinator of this deployment runs); a live listener or a file that is not a socket refuses the start |
| Protocol | One connection, one request, one response, each a single line of JSON (`{"v":1,"token":…,"command":…}` → `{"ok":…,"text":…}`). A request is at most 64 KiB and must arrive within 5 s, else it is refused (`too_large`, `timeout`) and the connection closed; anything after the first line is not read; at most 8 connections at a time. Bad requests get their reason (`bad_request`); a missing or wrong token is `unauthorized` and never reaches a command |
| Commands | `status`; `unfreeze [<group>]` (this Coordinator's group only); `resolve <change>...`; `failed-events`; `conversations [<task>]`; `inspect <conversation>`; `seal [<group>] [--trial <id>] [--tasks <id,...>]` ([the evaluator](#the-isolated-evaluator)) |
| Unfreeze | The group stays frozen while the Coordinator repeats the recovery checks, in order: nothing of the group still stopping, every run key closed, its own kills of leftover Pi processes and containers verified, the watchdog's sweep (reason `recheck`) answered and verified, every saved merge intent checked against GitHub, every pending file change reconciled and none unresolved without the owner's `resolve`, the relay running, and no new freeze meanwhile (none by the Coordinator, e.g. a `/cancel`'s archive that could not reach GitHub, and no stop the watchdog could not verify). A task a `/cancel` archives while the checks run gets no recovery job: that archive finishes on its own. Only if all pass does the group turn normal (in one transaction with the recovery jobs found); otherwise it stays frozen and the CLI prints which check failed (exit 1). Nothing interrupted resumes; tasks the freeze cancelled stay cancelled. The CLI never writes the database: without a running Coordinator there is no unfreeze |
| Read-only inspection | Only a quarantined conversation of the group, stored in `<PI_DATA_DIR>/conversations/`, never through a symlink. Without a `-wal` file (or an empty one) the file is opened with SQLite's `mode=ro&immutable=1`: no lock, no `-wal` or `-shm` created. With a `-wal` that holds entries (its Pi process was killed), the file and its WAL are copied (read) into a private scratch directory under `owner/`, the copy is read and deleted at once (and at the next start if a crash left one). Pi Durable's own storage is not opened (its open migrates in a write transaction and its close checkpoints). The transcript goes back over the socket to the owner's terminal only; control characters and bidirectional overrides are escaped, known secret shapes masked |
| Logs | The command, its outcome and duration (`owner_request`), a refused token (`owner_request_refused`), an inspection's conversation id, entry count and source (`owner_inspect`), a resolution's change and task (`owner_effect_resolved`); never the token, a transcript or any text |
| Status identity | Live `owner status` prints the server's configured repository, Telegram group/topic and absolute `coordinator.sqlite` path before its task-state report. Offline status prints the identity from its own non-secret configuration and remains explicitly labelled read-only; an omitted repository is reported as not configured, never guessed from old task PRs |
| Secrets | None in the CLI (Deployment § Secrets: "held only in the Coordinator's memory"): it reads only `PI_DATA_DIR`, `PI_TASK_DIR`, `TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_GROUP_TOPIC_ID`, `GITHUB_REPO` and the disk sizes, and from an env file (the Coordinator's, on the VM) only those lines; the bot token, the model key and the GitHub token are dropped before parsing |
| Without a Coordinator | The CLI says it is not running and exits 3. `owner status` then also prints the status from a read-only, query-only connection to the database (no migration, refused unless the schema is the current one), labelled `READ-ONLY STATUS FROM THE DATABASE` |

## The isolated evaluator

[spec/architecture.md](../spec/architecture.md) § Sealing ("Dispatch is held deployment-wide ... Evaluation and
execution never overlap. Dispatch stays held from sealing until the evaluator has exited and its cleanup is verified")
and § Isolated evaluator ("a separate trusted container, launched only by the Coordinator after sealing, with the
sealed snapshot and hidden tests read-only plus scratch space, and no network or credentials. Agents can't reach it");
[spec/agent-execution.md](../spec/agent-execution.md) § Containers, Evaluator column. Code:
`src/coordinator/engine/seal.ts` (sealing), `src/coordinator/engine/snapshot.ts` (the snapshot),
`src/coordinator/sandbox/evaluator.ts` (the container), `deploy/docker/run-eval.mjs`, `eval-tests.mjs`, `app-client.mjs`, `eval-app.mjs`, `eval-proxy.mjs` and `suites.json`,
plus the trusted host broker/role lifecycle and Python file observer in `src/coordinator/sandbox/evaluator-*.ts`.

| | |
|---|---|
| Trigger | Only the owner CLI (`owner seal`), the trial harness: "Evaluation runs only in the trial harness". Nothing in Telegram starts it |
| Before | Refused unless the group is normal, nothing else is being evaluated, the trial id is new (a trial is evaluated once), the hidden tests are configured and outside `PI_DATA_DIR` and `PI_TASK_DIR` (checked on the resolved paths), the evaluator image answers, and every trial task is merged |
| Hold | From the seal: no dispatch, no merge, no follow-up delivered into a running task, deployment-wide (any group sealing, or any evaluation not finished, holds every group). New `/task` requests and replies are saved and queued |
| Exclusive | The evaluator starts only once no run, merge, execution slot, recovery job, cancel or reconciliation is in flight and the recovery stop step (own kills verified, the watchdog's sweep verified) found nothing left; no agent or check container may be listed then. After a restart before the evaluator ran, restart recovery's jobs finish first and the stop step is verified again; no recovery job starts while the evaluator runs or its cleanup is due |
| Snapshot | The fetched main commit, checked to contain every trial task's merged head, exported without git data under `<PI_TASK_DIR>/snapshots/<trial>-<commit>` (directories 0555, files 0444) with a read-only manifest (commit, tree, content hash); the hash is checked before the evaluator starts and after it ran |
| Container | The user-authorized external-test topology uses one trusted grader and one full-Node app sibling, each non-root, `--network none`, read-only root, caps dropped and no-new-privileges, with 1 vCPU/1 GiB/256 PIDs each (aggregate 2 vCPU/2 GiB/512 PIDs). Both have managed/evaluator/trial labels plus a role; no shared PID namespace, credentials or Docker socket. Grader mounts hidden tests RO + its scratch; app mounts sealed snapshot RO + separate scratch. An app-local Unix socket plus host-started in-container proxy carries observations; no cross-Docker-VM socket mount |
| Grading | Native full Node hidden tests, async integration and baseline suites remain. Immutable version 3 expected manifests declare every test ID/file/name; the trusted Node TestsStream reporter checks actual results, summary totals, skips/todos, duplicates/missing/unplanned tests, clean exit and completion. Candidate code never enters the trusted Node heap. Each suite starts a fresh app container only after verified stop of the previous one; scratch is wiped after stop |
| After | The evaluator container verified gone, the scratch directory wiped and verified gone, the snapshot verified unchanged, the watchdog's sweep verified; then the result (per-suite outcomes, the snapshot, versions, image digests, tool policy version, container limits, the hidden tests' hash) is recorded, posted to the group, and dispatch reopens. An evaluator that cannot start, or a cleanup that cannot be verified, freezes the group instead. A restart during the evaluation records it as interrupted (not graded) |
| Trust | Hidden definitions, assertions, expected values, expected IDs and final verdict stay in the trusted grader; app code executes with full Node capabilities in a separate kernel isolation domain. App data crosses as bounded V8 observations, never report events. Ordinary native stdout/stderr/streams are untouched. Unexpected app exits, malformed framing or V8 decode failures latch independently, even if a hidden negative assertion catches an error. Application exceptions remain ordinary observable behavior. Host Python3 uses pinned openat directory FDs, no-follow/nonblocking opens and regular-file/byte limits to inspect actual filesystem effects; app write/read self-reports do not prove disk changes |
| Logs | Trial id, phase, counts, outcomes and hashes; never test output (the launcher discards it) |

**Contract and limits:** Tests must migrate from unsafe direct candidate imports to the external full-Node client; no restricted JavaScript or JSON-only grading path remains. Full Node filesystem, asynchronous code, child processes, ESM/TLA, stdout callbacks/drain and V8 values are exercised on Docker. Rich application objects/callbacks can be operated on inside the app and observations asserted outside; arbitrary unknown in-process tests are not promised zero-adaptation compatibility. This boundary does not prove freedom from container/kernel/Node vulnerabilities, trusted-image/hidden-author compromise or side channels, or internal function identity. The topology differs from the old single-container wording under the user's explicit instruction, while retaining the aggregate resource ceiling. Any build/grading change requires a new separately reported frozen series; never pool old/rejected prototype results.

Report vulnerabilities privately, see [SECURITY.md](../SECURITY.md).

---

Back to the [README](../README.md).
