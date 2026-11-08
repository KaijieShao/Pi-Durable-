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
| `/task@smule_code_bot <agent> <text>` | A new task for that agent, acknowledged with its id and queue position, or refused with the reason (queue full, unknown agent, group frozen, low disk...) |
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
- **One Pi process per run** (Pi Durable 1.5.0, one SQLite file per conversation). Its model is reached only through
  the Coordinator's local relay with a run key that works only while the run is open; the relay counts requests,
  checks input size and reserves budget. The model's tools are `read`, `edit`, `write` and `run_check` with a fixed
  list of operations. There is no arbitrary shell and no MCP.
- **Docker containers with no network** do the work: an agent container per run sees only its task's worktree (with
  `.git` masked); `run_check`, the setup script and the tests run in separate check containers.
- **Review and merge:** after each run the Coordinator runs the tests, commits a checkpoint, pushes the branch and
  opens or updates the task's pull request. Merges run one at a time; GitHub's "up to date" rule refuses a merge after
  `main` moved, and a moved `main` is combined, retested and approved again; a conflict starts a new admitted run.
- **Recovery:** after a restart nothing in progress resumes. An interrupted run is marked failed, its work is pushed,
  its conversation is quarantined, and a later follow-up starts a fresh conversation. Whenever the Coordinator cannot
  confirm a stop or a GitHub outcome, it freezes the group; only the owner CLI unfreezes it.

## Command line

```sh
pi-durable-telegram run [--env-file <path>]
pi-durable-telegram owner status|unfreeze|failed-events [--env-file <path>]
```

From the sources: `node src/cli/main.ts …` (Node 22 strips the types). `owner` opens the Coordinator's database
directly and may run next to a live Coordinator.

## Model endpoint (OPENAI_BASE_URL)

Pi always uses pi-ai's `openai` provider (`PI_PROVIDER=openai`) pointed at the Coordinator's relay; the relay holds
the real `OPENAI_API_KEY` and forwards to `OPENAI_BASE_URL` (default `https://api.openai.com/v1`). Set
`OPENAI_BASE_URL` to use an API-key-backed, OpenAI-compatible Responses gateway: HTTPS, or HTTP only on localhost,
without credentials, query or fragment. Set `OPENAI_CODEX_GATEWAY=1` only for a gateway backed by the Codex
subscription API: requests then carry top-level instructions, stream, and omit unsupported sampling and cache
settings. The endpoint handling lives in [src/agent/providers.ts](src/agent/providers.ts) and
[src/agent/openai-relay.ts](src/agent/openai-relay.ts).

## Not built yet

Marked `STUB(spec: …)` in the code: sealing and the isolated evaluator; the separate watchdog systemd unit (an
in-process watchdog, self-terminating containers and a self-exiting Pi process stand in); the systemd slice and a
dedicated Pi user; the metadata-server firewall; GCP deploy scripts; the owner CLI's local socket and read-only
inspection of quarantined conversations; reconciliation of uncertain file edits after a crash; task-disk-full
handling beyond the free-space check; trial reset and the stress test. Measurements in the spec are planned, not
results.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test          # node --test; Telegram, GitHub and the model are local fakes on 127.0.0.1
```

## License

[MIT](LICENSE) © smixs
