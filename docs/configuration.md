# Configuration

The Coordinator reads its configuration from the environment, optionally loaded from a file with
`--env-file <path>` (variables already set in the environment win over the file). Every invalid or missing value
stops it at start with one line per problem and exit code 2; values are never printed. The same file serves the
owner CLI (`owner status|unfreeze|failed-events --env-file <path>`). Start from [.env.example](../.env.example); the
local walkthrough is [RUN-LOCAL.md](../RUN-LOCAL.md).

Secrets (marked below) are held only in the Coordinator's memory: after reading the configuration it removes them
from its environment, the model key goes only to its relay, and the GitHub token only to its git and GitHub calls.
Pi processes and containers never receive them.

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
| `PI_DATA_DIR` | no | `~/.local/state/pi-durable-coordinator` | Coordinator SQLite (`coordinator.sqlite`), one Pi SQLite file per conversation, lock; mode 700 |
| `PI_TASK_DIR` | no | `<PI_DATA_DIR>/tasks` | The task disk: git repository, one worktree per open task, check scratch space |
| `PI_REQUIRE_TASK_MOUNT` | no | off | `1`: refuse to start unless `PI_TASK_DIR` is a mount point (a separate task disk on a server) |

Relative paths are resolved from the current directory.

## Containers

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `AGENT_IMAGE` | no | `pi-durable-agent:demo` | Image of the per-run agent container (file operations) |
| `CHECK_IMAGE` | no | `pi-durable-check:demo` | Image of the check containers; its fixed operation list (`setup`, `test`, `lint`, `build`) is what `run_check` may run |
| `CONTAINER_USER` | no | the Coordinator's `uid:gid` (`65534:65534` when it runs as root) | `uid:gid` the containers run as; uid 0 is refused |
| `PI_SETUP_SCRIPT` | no | `.pi/setup.sh` | Repository path of the setup script, run once per task in a check container with the worktree writable; skipped when absent |
| `DOCKER_BIN` | no | `docker` | The Docker CLI |
| `RELAY_PORT` | no | `0` (any free port) | Port of the relay on 127.0.0.1 |

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
