# Security in detail

The design is in [spec/architecture.md](../spec/architecture.md#trust-boundaries) and
[spec/deployment.md](../spec/deployment.md). Trusted: the Coordinator, Pi, the relay, the tool hooks, the expected
test outputs, the watchdog and the GitHub repository settings. Untrusted: model output, tool arguments and generated code.

- **One group, explicit roles.** Only the configured group (and topic) is served; every other chat is ignored and
  nothing from it is stored or sent to the model. Only a task's creator and the configured owner can follow up on,
  approve or cancel it; `TELEGRAM_MEMBER_IDS` optionally limits who may submit tasks.
- **Secrets stay in the Coordinator.** The bot token, the model key and the GitHub token are read at start and then
  removed from the process environment. The model key is used only by the relay; each Pi process gets a run key that
  the relay accepts only while that run is open, and only for `POST /v1/responses` on 127.0.0.1. Under systemd
  isolation the run key is the first frame on the Pi process's stdin, never in its argv, environment or unit
  properties. Only the Coordinator runs git (with the repository's hooks and local configuration disabled) and calls
  GitHub; the token travels in an environment header, never in a command line, URL or log.
- **Pi processes are isolated** ([isolation.md](isolation.md)). On Linux (`PI_RUNNER_ISOLATION=systemd`, the
  default there) each run is a transient unit in the dedicated slice `pi-durable-runs.slice`, as its own unprivileged
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
  unit and user in production) that survives a Coordinator crash. At every Coordinator start, and at the recheck after
  an owner unfreeze, it kills everything in the Pi slice and every container labelled `pi-durable.managed=1`,
  verifies both are empty, and only then does the Coordinator dispatch again. While no Coordinator runs it removes
  whatever was left; it enforces each run's 10-minute deadline on its own.
- **Fail closed.** If Docker or the images are unavailable, or the Pi process isolation (systemd, the slice, the
  host setup), or the watchdog (no verified sweep, or no heartbeat for 15 s), no execution starts; commands are still
  saved and queued. If a stop or a GitHub outcome cannot be confirmed, by the Coordinator or by the watchdog, the group
  freezes until the owner resolves it and unfreezes it with the owner CLI. A push GitHub refuses because a task branch
  was changed outside the Coordinator is a known outcome (nothing was pushed): the Coordinator never force-pushes, and
  only that task waits, with its worktree kept, until the branch is restored.
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
| When | Each Coordinator start (recovery step 2, before dispatch reopens) and each recheck after an unfreeze, on request; on its own when the Coordinator's lock is gone or its owner dead and anything is left; for a run still starting, running or finalizing 60 s past its deadline (an unverified stop there freezes the run's own group, even if the watchdog's `TELEGRAM_GROUP_CHAT_ID` differs: that mismatch is logged as `watchdog_group_mismatch`) |
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

Report vulnerabilities privately, see [SECURITY.md](../SECURITY.md).

---

Back to the [README](../README.md).
