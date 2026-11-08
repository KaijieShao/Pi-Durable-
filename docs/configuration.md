# Configuration

The Coordinator reads its configuration from the environment, optionally loaded from a file with
`--env-file <path>` (variables already set in the environment win over the file). Every invalid or missing value
stops it at start with one line per problem and exit code 2; values are never printed. The same file serves the
owner CLI (`owner status|unfreeze|resolve|failed-events|conversations|inspect --env-file <path>`), which talks to the
running Coordinator over `<PI_DATA_DIR>/owner/owner.sock` ([security.md](security.md#the-owner-socket)) and reads
only `PI_DATA_DIR`, `PI_TASK_DIR`, `TELEGRAM_GROUP_CHAT_ID` and the disk sizes (`PI_BOOT_DISK_MIN_FREE`,
`PI_TASK_DISK_MIN_FREE`, `PI_TASK_DISK_BUDGET`, `PI_WORKTREE_HEADROOM`): the file's other lines, secrets included, are
dropped before parsing, so no secret reaches it. The watchdog (`watchdog --env-file <path>`)
reads only its own few variables, see [Watchdog](#watchdog). Start from [.env.example](../.env.example); the local
walkthrough is [RUN-LOCAL.md](../RUN-LOCAL.md).

Secrets (marked below) are held only in the Coordinator's memory: after reading the configuration it removes them
from its environment, the model key goes only to its relay, and the GitHub token only to its git and GitHub calls.
Pi processes, containers, the watchdog and the owner CLI never receive them.

## Telegram

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes, secret | | Bot token from @BotFather |
| `TELEGRAM_BOT_USERNAME` | yes | | Exact bot username without `@` (e.g. `smule_code_bot`); checked against `getMe` at start |
| `TELEGRAM_GROUP_CHAT_ID` | yes | | The one group served: a negative chat id (`-100…` for supergroups). Every other chat is ignored |
| `TELEGRAM_GROUP_TOPIC_ID` | no | `1` | Forum topic listened to and answered in; `1` is General or a group without topics |
| `TELEGRAM_OWNER_ID` | yes | | The group owner's numeric user id: may cancel, follow up on and approve any task |
| `TELEGRAM_MEMBER_IDS` | no | any group member | Comma-separated user ids allowed to submit `/task` (the owner always may). Follow-ups, `/approve` and `/cancel` stay limited to a task's creator and the owner |
| `TELEGRAM_API_ROOT` | no | `https://api.telegram.org` | Bot API server (tests use a local fake) |

## Agents and model

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_AGENTS` | yes | | Comma-separated agent ids, unique ignoring case, stored lower-case: a letter, then letters, digits, `-` or `_`, at most 32 characters |
| `PI_PROVIDER` | no | `openai` | Must be `openai`: Pi reaches the model only through the Coordinator's OpenAI-compatible relay |
| `PI_MODEL` | yes | | The pinned model id of pi-ai's `openai` catalog, e.g. `gpt-5.5` |
| `PI_THINKING` | no | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; checked against the model |
| `OPENAI_API_KEY` | yes, secret | | The real model key, held by the relay only; each Pi process gets a run key instead |
| `OPENAI_BASE_URL` | no | `https://api.openai.com/v1` | Where the relay forwards requests: an HTTPS Responses-compatible gateway (or HTTP on localhost), without credentials, query or fragment; applies to every model request |
| `OPENAI_CODEX_GATEWAY` | no | off | Set to `1` only for a custom endpoint backed by Codex: sends top-level instructions, streams responses and omits unsupported sampling/cache settings |
| `PROJECT_TOKEN_CEILING` | yes | | Owner-set token ceiling of the budget ledger. Each request reserves its estimated input plus 16,000 output tokens; reported usage is reconciled, unknown usage keeps its reservation |

## GitHub and git

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `GITHUB_TOKEN` | yes, secret | | Fine-grained token for this repository only: Contents read/write and Pull requests read/write |
| `GITHUB_REPO` | yes | | `owner/name` of the project repository; `main` must require pull requests that are up to date before merging |
| `GITHUB_BASE_BRANCH` | no | `main` | Branch tasks start from and merge into |
| `GITHUB_API_URL` | no | `https://api.github.com` | GitHub REST endpoint |
| `GIT_BRANCH_PREFIX` | no | `task/` | Task branches are `<prefix><task id>`, e.g. `task/12` |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | no | `pi-durable coordinator`, `pi-durable-coordinator@users.noreply.github.com` | Author of checkpoint commits |

## Storage

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_DATA_DIR` | no | `~/.local/state/pi-durable-coordinator` | Coordinator SQLite (`coordinator.sqlite`, mode 600; 660 with `PI_STATE_GROUP`), one Pi SQLite file per conversation, lock, and `owner/` (mode 700: the owner socket `owner.sock` and its token, 600, while the Coordinator runs); mode 700 (0710 with systemd isolation: the Pi group may only traverse it). `<PI_DATA_DIR>/owner/owner.sock` must fit in a socket path (103 bytes; 107 on Linux), else the Coordinator does not start (exit 2) |
| `PI_TASK_DIR` | no | `<PI_DATA_DIR>/tasks` | The task disk: git repository, one worktree per open task, check scratch space |
| `PI_REQUIRE_TASK_MOUNT` | no | off | `1`: refuse to start unless `PI_TASK_DIR` is a mount point (a separate task disk on a server) |
| `PI_STATE_GROUP` | no | unset (owner-only) | A group (name, or gid) the Coordinator hands its database (0660) and lock file (0640) to at every start, so the watchdog can run as its own user (production: `pi-watchdog`, [security.md](security.md#the-watchdog)). Never `PI_RUNNER_GROUP` or root's; the Coordinator must be a member and the Pi user must not, else it refuses to start |

Relative paths are resolved from the current directory.

## Disk limits

[Capacity § Disk](../spec/capacity.md#disk): the boot disk holds `PI_DATA_DIR` (the database, the outbox, Pi's
conversation stores); the task disk holds `PI_TASK_DIR` (the git repository, one worktree per open task, check
scratch space, and on the VM Docker's data). Sizes are bytes, or a number with `K`, `M`, `G` or `T` (powers of 1024;
`GiB` and `GB` mean the same).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_BOOT_DISK_MIN_FREE` | no | `1GiB` | A new `/task` is rejected while the filesystem of `PI_DATA_DIR` has less free; the reply names the boot disk, its free space and this amount. Follow-ups, `/status`, `/cancel` and `/approve` still work. Free space that cannot be read rejects new tasks too |
| `PI_TASK_DISK_MIN_FREE` | no | `1GiB` | Before a task's worktree is created, it must leave at least this much free on the task disk |
| `PI_TASK_DISK_BUDGET` | no | unset | The task disk's usage plus a new worktree must stay within this. Usage is the filesystem's when `PI_TASK_DIR` is a mount point (Docker's data included), else everything under `PI_TASK_DIR`. Unset: the task disk's own size is the budget, so only `PI_TASK_DISK_MIN_FREE` applies (on the VM the task disk is a disk of its own) |
| `PI_WORKTREE_HEADROOM` | no | `1GiB` | A new worktree is estimated at its checked-out files (each rounded up to 4 KiB) plus this, for dependencies and build output. `0` allowed |

The check runs before main is fetched (sized at the main fetched last, so nothing is written to a disk without room)
and again right before the worktree is created. A task whose worktree does not fit is accepted and stays queued at its
position: its slot is released, nothing is created, and while new worktrees are held no task takes a slot for one.
The bot says once why it waits (which limit, how much the worktree needs, how much is free or left). Its
acknowledgement and `/status` show the same note while new worktrees are held. The Coordinator measures again every
30 s and at once when a worktree is archived (a task merged, cancelled or failed), and starts the oldest waiting task
when there is room. Follow-up and conflict-fix runs reuse their task's worktree and are not held. A measurement that
fails holds new worktrees (fails closed). `owner status` shows both disks, the limits in use and what the database
and Pi's stores take. The defaults are provisional: the stress test sets the task disk's size.

## Containers

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `AGENT_IMAGE` | no | `pi-durable-agent:demo` | Image of the per-run agent container (file operations) |
| `CHECK_IMAGE` | no | `pi-durable-check:demo` | Image of the check containers; its fixed operation list (`setup`, `test`, `lint`, `build`) is what `run_check` may run |
| `CONTAINER_USER` | no | the Coordinator's `uid:gid` (`65534:65534` when it runs as root) | `uid:gid` the containers run as; uid 0 is refused |
| `PI_SETUP_SCRIPT` | no | `.pi/setup.sh` | Repository path of the setup script, run once per task in a check container with the worktree writable; skipped when absent |
| `DOCKER_BIN` | no | `docker` | The Docker CLI |
| `RELAY_PORT` | no | `0` (any free port) | Port of the relay on 127.0.0.1 |

## Trial evaluation

Used only when the owner seals the group for a trial (`owner seal`, [RUN-LOCAL.md](../RUN-LOCAL.md#trial-evaluation-sealing)).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_EVAL_HIDDEN_TESTS_DIR` | no (sealing is refused without it) | unset | Native `*.test.js`/`.mjs`/`.cjs` hidden tests under `modules/<module>/`, `integration/`, `baseline/`; each suite has independent version 3 `expected.json` IDs/file/name declarations. Full Node tests observe a separate full Node application through the external client; assertions stay in the trusted grader, which never mounts candidate source. See RUN-LOCAL.md for migration. Hidden files are mounted read-only only in the trusted grader, outside `PI_DATA_DIR`/`PI_TASK_DIR`, readable by the Coordinator and `CONTAINER_USER` but not the Pi user |
| `EVALUATOR_IMAGE` | no | `pi-durable-evaluator:demo` | The trusted evaluator image (`scripts/build-images.sh`): its launcher and fixed suite list (`/opt/pi-eval/suites.json`) grade the snapshot one suite after another. Both roles run as `CONTAINER_USER` without network/credentials/shared PIDs. Disjoint mounts; each 1 vCPU/1 GiB/256 PIDs, aggregate 2 vCPU/2 GiB/512 PIDs. Host Python3 with openat/dir_fd is required for independent file evidence |

Fixed, not configurable: the evaluation's 30-minute deadline (each suite also has its own bound in the image's suite
list), the evaluator's container limits (2 vCPU, 2 GiB without swap, 512 processes), and where the sealed snapshots
are kept (`<PI_TASK_DIR>/snapshots/`).

## Pi processes

How each run's Pi process is isolated; see [isolation.md](isolation.md) for both modes and the one-time host setup.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_RUNNER_ISOLATION` | no | `systemd` on Linux, `process` elsewhere | Linux requires `systemd`: one transient unit per run as the Pi user in the Pi slice, sandboxed, loopback-only network; without the host setup no task runs (fails closed). Linux refuses `process` at startup (exit 2). On Mac, `process` is a child as the Coordinator's own user, the weaker local mode |
| `PI_RUNNER_USER` | no | `pi-runner` | The Pi user (systemd only); never `root` or the Coordinator's own user |
| `PI_RUNNER_GROUP` | no | `pi-durable` | Group shared by the Pi user and the Coordinator user for `<PI_DATA_DIR>/conversations` |
| `PI_RUNNER_SLICE` | no | `pi-durable-runs.slice` | The slice of the Pi units ([deploy/systemd](../deploy/systemd/pi-durable-runs.slice)); must be installed |
| `SYSTEMD_RUN_BIN`, `SYSTEMCTL_BIN` | no | `systemd-run`, `systemctl` | The systemd CLIs: absolute paths or names on `PATH` |

## Watchdog

The watchdog (`pi-durable-telegram watchdog [--env-file <path>]`, [security.md](security.md#the-watchdog)) reads only
these variables, from the environment or the env file (the environment wins). Every other variable is ignored,
whatever its value, and an env file's other lines (secrets included) are dropped before they are parsed. It needs
no secret at all; any secret variable in its environment is removed at start. Problems exit with code 2.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PI_DATA_DIR` | no | `~/.local/state/pi-durable-coordinator` | The Coordinator's data directory, resolved exactly as the Coordinator resolves it (so the deployment marker of the Pi processes is the same) |
| `TELEGRAM_GROUP_CHAT_ID` | yes | | The group it freezes when a stop cannot be verified |
| `DOCKER_BIN` | no | `docker` | The Docker CLI it lists and removes the labelled containers with |
| `PI_RUNNER_ISOLATION` | no | `systemd` on Linux, `process` elsewhere | Where it looks for Pi processes: the Pi slice's cgroup tree (and marked processes), or marked processes only. Use the Coordinator's value; Linux refuses `process` (exit 2), requiring the slice |
| `PI_RUNNER_SLICE`, `SYSTEMCTL_BIN` | no | `pi-durable-runs.slice`, `systemctl` | The Pi slice, and the systemctl that shows its control group |
| `LOG_LEVEL` | no | `info` | As for the Coordinator |

Fixed, not configurable: a pass every second, its heartbeat every second, a run's deadline enforced 60 s after the
10-minute limit; the Coordinator waits 30 s for the watchdog's answer at start and dispatches only while the heartbeat
is younger than 15 s.

## Logs

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. Logs are metadata only: ids, counts, outcomes and hashes, never message text, prompts, tool output or secrets |

## Fixed limits

Not configurable in the demo deployment ([capacity](../spec/capacity.md)): 2 concurrent executions deployment-wide and
1 per agent; 2 waiting tasks per agent, 4 per group and 4 per user; 4 open tasks per group; 30 model requests per
run, retries included (at most 2 Pi retries per call, provider retries disabled); a 10-minute run deadline and a
60-second check deadline; 48K input / 16K output tokens per request; 5 follow-ups per task, 4,000 characters each;
one merge at a time. They live in `src/coordinator/limits.ts` (`DEMO_LIMITS`).

---

Back to the [README](../README.md).
