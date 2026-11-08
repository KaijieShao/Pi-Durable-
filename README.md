<p align="right"><b>EN</b> · <a href="./README.ru.md">RU</a> (describes the earlier private-chat bot)</p>

# pi-durable telegram: group Coordinator

**A multi-user Telegram group Coordinator for [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)
coding agents.** People in one Telegram group give tasks to the group's configured coding agents. Each task gets its
own git branch, worktree and GitHub pull request, and reaches `main` only after its creator or the group owner
approves it in Telegram and the tests pass on the result combined with the latest `main`.

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![built on pi-durable](https://img.shields.io/badge/built%20on-pi--durable-4A97BE)](https://github.com/earendil-works/pi/tree/main/packages/durable)

- **Design docs:** [spec/](spec/) (start with [requirements](spec/requirements.md), then
  [architecture](spec/architecture.md)); the build plan is [spec/build-plan.md](spec/build-plan.md).
- **Run it locally** (macOS + Docker Desktop, real group, real GitHub test repository): [RUN-LOCAL.md](RUN-LOCAL.md).
- **Settings:** [.env.example](.env.example) and [docs/configuration.md](docs/configuration.md).

This replaces the earlier single-user, private-chat gateway (one conversation per private chat, a shell tool,
plugins, OAuth login and a patched Pi Durable). That code is removed; Pi Durable 1.5.0 is used unmodified.

## In the group

| Send | What happens |
|---|---|
| `/task@smule_code_bot <agent> <text>` | A new task for that agent, acknowledged with its id and queue position, or refused with the reason (queue full, unknown agent, group frozen, boot disk low...) |
| a reply to one of the bot's messages about a task | A follow-up: steered into the task while it runs; while it is in review, another run on the same branch and pull request. Only the creator or the owner. |
| `/status@smule_code_bot [task]` | Group state, execution slots in use, open and queued tasks with their pull requests; or one task's details |
| `/cancel@smule_code_bot <task>` | Creator or owner: stops the task, pushes its work, closes its pull request, keeps the branch |
| `/approve@smule_code_bot <task>` | Creator or owner: approves the head commit the bot last posted; merged when it is still the head and the tests pass |
| `/help@smule_code_bot` | Commands and limits |

With the bot's privacy mode on, address every command to the bot (`/task@smule_code_bot`); replies always arrive.

## How it works

- **One Coordinator process** polls Telegram, stores every command, task, run, follow-up, approval and outbound
  message in one SQLite database (an accepted command, its change and its acknowledgement in one transaction), and is
  the only part that runs git or calls GitHub.
- **Admission and queues** (demo limits, [capacity](spec/capacity.md#fixed-limits)): 2 concurrent executions
  deployment-wide and 1 per agent; 2 waiting tasks per agent, 4 per group, 4 per user; 4 open tasks per group;
  30 model requests and 10 minutes per run; 48K input / 16K output tokens per request; an owner-set project token
  ceiling; 5 follow-ups per task of 4,000 characters each.
- **Disks** ([configuration](docs/configuration.md#disk-limits)): a new task is refused while the boot disk (the
  database and Pi's stores) is low on free space. A task whose new worktree would not fit on the task disk (its
  free-space floor, or `PI_TASK_DISK_BUDGET`) stays queued without taking a slot, the bot says once why, and it starts
  by itself once another task's worktree is archived. Follow-up runs reuse their worktree and are not held.
- **One Pi process per run** (Pi Durable 1.5.0, one SQLite file per conversation). Its model is reached only through
  the Coordinator's local relay with a run key that works only while the run is open; the relay counts requests,
  checks input size and reserves budget. The model's tools are `read`, `edit`, `write` and `run_check` with a fixed
  list of operations. There is no arbitrary shell and no MCP.
- **Docker containers with no network** do the work: an agent container per run sees only its task's worktree (with
  `.git` masked); `run_check`, the setup script and the tests run in separate check containers.
- **Review and merge:** after each run the Coordinator runs the tests, commits a checkpoint, pushes the branch and
  opens or updates the task's pull request. Merges run one at a time; GitHub's "up to date" rule refuses a merge after
  `main` moved, and a moved `main` is combined, retested and approved again; a conflict starts a new admitted run.
  The Coordinator never force-pushes: if someone changes a task branch on GitHub, the approval is rejected and GitHub
  refuses the Coordinator's next push of it. That is a definite outcome, so only that task waits, its work kept in its
  worktree, until the branch is restored; the group and the other tasks carry on.
- **Recovery:** after a restart nothing in progress resumes. An interrupted run is marked failed and its
  conversation is quarantined; its changes since the last checkpoint stay in the task's worktree, neither committed
  nor pushed, and the bot lists those files. A reply then starts a fresh conversation seeded with them (its review
  pushes them), or `/cancel` archives the task (its final checkpoint pushes them). A run that had not reached Pi yet
  (no run key opened, no Pi process) is queued again in its place. Whenever the Coordinator cannot confirm a stop or a
  GitHub outcome, it freezes the group; only the owner CLI unfreezes it, and only after the Coordinator's recovery
  checks pass again (the group stays frozen while they run, and the CLI names the check that failed).
- **Uncertain file edits:** before an `edit` or `write` runs in the agent container, its intent (the file, its hash
  before, the intended hash) is saved. If the answer never comes (a crash, a client timeout), the run is stopped, and
  once its Pi process and containers are verified gone the Coordinator hashes the file itself (no symlink followed,
  only inside the worktree): the intended result is "applied", the content before is "currently unchanged", anything
  else freezes the group for owner review, naming the task and file (never its content). Dispatch waits until this
  reconciliation is done, and nothing archives or pushes the worktree before it.
- **The watchdog**, a separate process, is the stop path that survives the Coordinator: it kills and verifies every
  leftover Pi process and container before dispatch reopens after any restart, removes what a crashed Coordinator
  left, and enforces each run's deadline on its own; an unconfirmed stop freezes the group.

## Command line

```sh
pi-durable-telegram watchdog [--env-file <path>]
pi-durable-telegram run [--env-file <path>]
pi-durable-telegram owner status|unfreeze [<group>]|resolve <change>...|failed-events [--env-file <path>]
pi-durable-telegram owner conversations [<task>]|inspect <conversation> [--env-file <path>]
```

`watchdog` is the independent stop path, its own process (its own systemd unit and user in production): start it
first. It needs no secret. At every Coordinator start it kills and verifies every leftover Pi process and labelled
container before anything is dispatched, cleans up after a crashed Coordinator, and enforces the run deadline; without
it the Coordinator queues commands but starts no run ([security.md](docs/security.md#the-watchdog)).

From the sources: `node src/cli/main.ts …` (Node 22 strips the types). `owner` talks to the running Coordinator over
its owner-only local socket, `<PI_DATA_DIR>/owner/owner.sock`; run it as the Coordinator's user. `owner unfreeze`
makes the Coordinator repeat its recovery checks and unfreezes the group only if all pass; `owner resolve` records
your review of an uncertain file change; `owner inspect` prints a quarantined conversation's transcript, read without
writing anything. Without a running Coordinator it says so and exits 3 (`owner status` adds a labelled read-only
status from the database) ([RUN-LOCAL.md](RUN-LOCAL.md#owner-cli), [security.md](docs/security.md#the-owner-socket)).

## Model endpoint (OPENAI_BASE_URL)

Pi always uses pi-ai's `openai` provider (`PI_PROVIDER=openai`) pointed at the Coordinator's relay; the relay holds
the real `OPENAI_API_KEY` and forwards to `OPENAI_BASE_URL` (default `https://api.openai.com/v1`). Set
`OPENAI_BASE_URL` to use an API-key-backed, OpenAI-compatible Responses gateway: HTTPS, or HTTP only on localhost,
without credentials, query or fragment. Set `OPENAI_CODEX_GATEWAY=1` only for a gateway backed by the Codex
subscription API: requests then carry top-level instructions, stream, and omit unsupported sampling and cache
settings. The endpoint handling lives in [src/agent/providers.ts](src/agent/providers.ts) and
[src/agent/openai-relay.ts](src/agent/openai-relay.ts).

## Not built yet

Marked `STUB(spec: …)` in the code: sealing and the isolated evaluator; GCP deploy scripts; a task disk that fills up during a
run (only a new worktree is checked against the task disk); size limits and retention rules for the boot disk's
budgets (database, Pi's stores, logs, retained trials: `owner status` only reports their usage); trial reset and the
stress test.
Measurements in the spec are planned, not results. Pi processes run as their own user in a dedicated systemd slice on Linux, and as your own user
on a Mac (the weaker local mode): see [docs/isolation.md](docs/isolation.md).

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test          # node --test; Telegram, GitHub and the model are local fakes on 127.0.0.1
```

## License

[MIT](LICENSE) © smixs
