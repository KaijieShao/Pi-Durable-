# Changelog

## Unreleased

- **Sealing and the isolated evaluator** (the trial harness): `owner seal [<group>] [--trial <id>] [--tasks <id,...>]`
  seals the group once the trial's tasks (named, or every task since the last evaluation) have merged. Dispatch,
  merges and follow-up delivery are then held deployment-wide (new `/task` requests and replies are saved and queued),
  the runs and merge tests in progress finish, execution is verified stopped, and a read-only snapshot of main (with a
  manifest and content hash, under `<PI_TASK_DIR>/snapshots/`) is graded by the new trusted evaluator image
  (`pi-durable-evaluator:demo`, built by `scripts/build-images.sh`): no network, no credentials, 2 vCPU / 2 GiB, the
  snapshot and the hidden tests read-only plus scratch, each module's hidden tests, the integration test and the
  baseline suite one after another. The per-suite result and what the trial records (versions, image digests, tool
  policy version, container limits) are stored and posted, and dispatch reopens only after the evaluator has exited
  and its cleanup is verified; an evaluator that cannot start or a cleanup that cannot be verified freezes the group.
  New `PI_EVAL_HIDDEN_TESTS_DIR` (outside the data and task directories) and `EVALUATOR_IMAGE`; `owner status` shows
  the sealing progress and the last evaluation. Schema version 4 (table `evaluations`).

- **Breaking: the private-chat gateway is replaced by a multi-user group Coordinator.** One configured Telegram group
  (and optional topic) submits `/task <agent> <text>` to configured agent ids; replies to the bot's task messages are
  follow-ups (steered while a run is busy, another run while the task is in review); `/status`, `/cancel` and
  `/approve` complete the set. Each task gets one branch, one worktree and one GitHub pull request and merges only
  after its creator or the owner approves the posted head commit and the tests pass on the result combined with the
  latest main. Private chats and every other chat are ignored. Bounded queues and fixed demo limits apply to every
  run. See [README.md](README.md), [RUN-LOCAL.md](RUN-LOCAL.md) and the design docs in [spec/](spec/).
- New CLI: `run [--env-file p]` and `owner status|unfreeze|failed-events [--env-file p]`; `login` is removed. New
  configuration (`TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_OWNER_ID`, `PI_AGENTS`, `GITHUB_*`, `PROJECT_TOKEN_CEILING`,
  container images...), see [docs/configuration.md](docs/configuration.md); `TELEGRAM_ALLOWED_USER_IDS`,
  `PI_WORKDIR`, `PI_PLUGINS`, `PI_AUTH_FILE`, `TELEGRAM_RICH`, `DEEPGRAM_API_KEY` and the other private-chat settings
  are gone. `PI_PROVIDER` must be `openai`: Pi reaches the model only through the Coordinator's relay.
- Removed with the old gateway: the `bash` tool (the model now has `read`, `edit`, `write` and `run_check` in
  containers without network), plugins and MCP, voice and file intake, rich drafts and buttons, OAuth login and the
  credential store, automatic resume of interrupted runs (an interrupted run is now failed and never resumed), and
  the `postinstall` patch of Pi Durable's 401 retry (Pi Durable 1.5.0 is used unmodified; upstream 400/401 responses
  end the run instead of being retried). Existing private-chat SQLite data is not migrated.

- Pi processes run as their own unprivileged user in a dedicated systemd slice on Linux (`PI_RUNNER_ISOLATION=systemd`,
  the default there): one sandboxed transient unit per run with loopback-only network, the run key passed as the
  first stdin frame, and no run started unless systemd, the slice and the host setup are in place. macOS keeps the
  child-process mode as your own user (`process`, the weaker local mode). New `PI_RUNNER_USER`, `PI_RUNNER_GROUP`,
  `PI_RUNNER_SLICE`, `SYSTEMD_RUN_BIN`, `SYSTEMCTL_BIN`; deploy files for the slice, a polkit rule and the
  metadata-server firewall rule; see [docs/isolation.md](docs/isolation.md). Restart cleanup (and the recheck after an
  unfreeze) now kills and verifies every Pi process of the deployment, whatever run it served (its units in the
  slice, or its marked processes locally), not only those of the runs recorded in progress; the Coordinator database
  is created owner-only (0600).

- The watchdog, the independent stop path, as its own process: `pi-durable-telegram watchdog [--env-file p]` and
  `deploy/systemd/pi-durable-watchdog.service` (its own user, CAP_KILL, the Docker socket, no network, no secret; it
  reads only `PI_DATA_DIR`, `TELEGRAM_GROUP_CHAT_ID`, `DOCKER_BIN`, `PI_RUNNER_ISOLATION`, `PI_RUNNER_SLICE`,
  `SYSTEMCTL_BIN`, `LOG_LEVEL`). At every Coordinator start and every recheck after an unfreeze it kills everything in
  the Pi slice (by cgroup membership: escaped children too) or every marked Pi process, and every container labelled
  `pi-durable.managed=1`, verifies both are empty, and only then does the Coordinator dispatch. It also cleans up
  after a dead Coordinator (stale or missing lock) and enforces each run's deadline independently; any unverified
  stop freezes the group with a notice (for a run's deadline, the run's own group). **Breaking for running the
  Coordinator:** it dispatches nothing (no run, merge or recovery check) until the watchdog has verified its start
  sweep, and nothing new while the watchdog's heartbeat is older than 15 s (without a watchdog it waits 30 s at
  start, then queues commands and tells the group once). Store schema v2 (a real
  v1 → v2 migration: the `watchdog_sweeps` table and `runs.dispatched_at`); `owner status` shows the watchdog's
  heartbeat and last sweep. New `PI_STATE_GROUP` shares the database and lock with the watchdog's user;
  `deploy/systemd/pi-durable-coordinator.service` (after the watchdog, `RequiresMountsFor=` the task disk) and a
  Docker drop-in for the task disk.

- A task branch changed on GitHub outside the Coordinator no longer freezes the group. GitHub refusing the
  Coordinator's push of it (a follow-up run's checkpoint, the combination with main, or the final push of `/cancel` or
  a limit) is a definite outcome: only that task waits, its work kept committed in its worktree (a cancelled task keeps
  its worktree too), `/approve` is rejected with both heads and what to do, and once the branch is restored the
  Coordinator pushes without force and posts the kept head for review (or archives the cancelled task). `/status`,
  the review reminder and `owner status` show held tasks. A push whose outcome stays unknown still freezes the group.

- Disk limits (Capacity § Disk). A new `/task` is rejected while the boot disk (`PI_DATA_DIR`) has less free than
  `PI_BOOT_DISK_MIN_FREE` (default 1 GiB), with the free and required amounts; follow-ups, `/status`, `/cancel` and
  `/approve` still work, and unreadable free space rejects too. **Changed:** a low task disk no longer rejects a
  `/task`. Instead, before main is fetched and again right before a task's worktree is created, its size (checked-out
  files + `PI_WORKTREE_HEADROOM`, default 1 GiB) must leave `PI_TASK_DISK_MIN_FREE` (default 1 GiB) free and, if set,
  fit in `PI_TASK_DISK_BUDGET`;
  otherwise the task stays queued at its position without a slot, the bot says once why, and it starts by itself
  once there is room (measured again every 30 s and when a worktree is archived). Follow-up runs are not held.
  `owner status` shows both disks, the limits and what the database and Pi's stores take.

- Uncertain file edits are reconciled (Agent Execution § Uncertain Effects). Before an `edit` or `write` runs in the
  agent container, its intent (the file, its hash before, the intended hash) is saved in the new `effect_intents`
  table (store schema v3); a `run_check` is saved too. An answer that leaves the outcome unknown (a timed-out file
  operation) stops the run; after a restart, or once a run's Pi process and containers are verified gone, every
  intent still pending is reconciled by hashing the file on the host (no symlink followed, confined to the worktree):
  the intended result is "applied", the content before "currently unchanged", a `run_check` is reported failed, and
  anything else freezes the group, naming the task and the file (never its content). Dispatch waits for this, and
  nothing archives, reviews or pushes the task's worktree before it. The owner records the resolution with
  `owner resolve <change>`; `owner status` lists the files waiting for review. **Changed:** a run interrupted by a restart is no longer
  tested, checkpointed and pushed at recovery. Its changes since the last checkpoint stay uncommitted in the worktree,
  the bot lists them, `/approve` is refused, and only a reply (a fresh run seeded with them, untracked files included
  in its diff) or `/cancel` (the final checkpoint) moves them on.

- The owner CLI talks to the running Coordinator over a local socket (Interfaces and Storage § Owner CLI),
  `<PI_DATA_DIR>/owner/owner.sock`: an owner-only directory (0700), socket and per-start token (0600), the token on
  every request (Node exposes no peer credentials), one line of JSON each way, bounded in size and time; a socket a
  crash left is replaced, and it is removed on stop. **Breaking:** the CLI no longer opens the database to change it.
  `owner unfreeze [<group>]` makes the Coordinator repeat its recovery checks while the group stays frozen (runs
  stopped, run keys closed, its own kills and the watchdog's sweep verified, saved merges checked against GitHub,
  pending file changes reconciled and none unresolved, the relay running, no new freeze) and unfreezes it only if all
  pass, else it names the failed check (exit 1); it no longer resolves uncertain file changes by itself: the new
  `owner resolve <change>...` records that review. New `owner conversations [<task>]` lists quarantined conversations
  and `owner inspect <conversation>` prints one's transcript to the owner's terminal, opened without writing anything
  (SQLite immutable, or a private copy when its WAL holds entries). Without a running Coordinator the CLI says so and
  exits 3; `owner status` then adds a labelled read-only status from the database. A database an earlier CLI unfroze
  directly (`recheck_required=1`) is still rechecked before dispatch. **Changed:** the owner CLI reads only
  `PI_DATA_DIR`, `PI_TASK_DIR`, `TELEGRAM_GROUP_CHAT_ID` and the disk sizes (even from the Coordinator's env file), so
  it needs no secret and never holds one.

- Honor `OPENAI_BASE_URL` for API-key-backed OpenAI-compatible Responses gateways, including after secret scrubbing.
  The Coordinator's relay forwards to it; `OPENAI_CODEX_GATEWAY=1` adapts requests for a Codex-backed gateway.

- Add macOS Conductor setup, automatic bot startup, configuration checks, provider login and graceful archive.
  Keep bot credentials in the main checkout's ignored local env file and preserve per-workspace SQLite history.
  (These Conductor actions run the earlier private-chat bot; start the Coordinator as described in RUN-LOCAL.md.)

## 0.1.10 (2026-11-03)

- Messages received while busy steer the current run at its next boundary, including tool rounds.
- Provider rate limits retry five times with 5/10/20/40/60 second backoffs.
- A stale draft stop button is silent while idle and logs `draft_stop_idle_ignored`.
- Install a version- and checksum-pinned pi-durable 1.5.0 patch automatically: OAuth rotation failures retry up to three times at 10/20/40 seconds. The external credential owner still performs refresh; the gateway waits and reads credentials again on the next request.

## 0.1.9 (2026-11-03)

- Upgrade all Earendil packages to exactly 1.5.0, including the new pi-schema tool builders.
- Adapt document checkpoints, live watches and failure reports to the new durable API.
- Persist Telegram retry backoffs and reminder waits as durable sleeps; cancelling a reminder ends its sleeping task immediately.
- SQLite storage upgrades automatically to schema v2. Before deployment, stop the service and back up the data directory; rolling back to pi 1.3.0 or earlier requires restoring that backup.

## 0.1.8 (2026-10-24)

- Replies carry the original message text or media caption as context; selected Telegram quotes take priority.

## 0.1.7 (2026-10-21)

- Fixed: a tap disables only its own button row, other questions in the same message stay answerable. A button
  outside any `<tg-button-row>` still disables every choice of the message.

## 0.1.6 (2026-10-19)

- Fix: after the bot (its token) changed, new messages were dropped as duplicates: Telegram starts message ids again,
  and the intake ring still held the old ids. The intake key is now `tg:<chat>:<message>:<date>`; a redelivered update
  keeps its date and is still dropped once. Keys written by earlier versions stay in the ring and match no new key.
- `update_duplicate` logs its reason: `redelivered` (info) when the same update was seen, `other_update` (warn) when
  only the message key was known, which means a message may have been lost.
- `/new` no longer drops queued messages silently: its reply says that the running request was stopped and lists the
  first words of each message dropped without an answer.

## 0.1.5 (2026-10-14)

- `helpers`: the `helper` tool hands a self-contained task to a helper agent with the same tools (without `helper`
  itself) and returns its final answer. Several calls in one answer run at once, up to `PI_HELPERS_MAX` (default 4)
  per chat; `PI_HELPER_MODEL` and `PI_HELPER_THINKING` pick the helpers' model. `/stop` and the draft's stop button
  stop helpers with the answer; after a restart a helper goes on where it was without getting its task twice.
- `reminders`: the `remind` tool adds (at a local time in `PI_TIMEZONE` or in minutes, once or `daily`, `weekdays`,
  `weekly` or every N minutes), lists and cancels reminders. A due reminder wakes the agent with its text in the chat,
  once per due time even across restarts; one missed while the service was down fires once after start, marked late.
  Reminders of a plugin that is off, or of a user taken off the allow-list, are dropped at their due time and never
  block startup. `cancel` ends a reminder at once; a calendar repeat fires once per local date, also when the clock
  goes back.
- Plugins get `models` and `now()` in their context. Plugins still cannot define tasks.

## 0.1.4 (2026-10-14)

- Plugins, off by default: `PI_PLUGINS` lists built-in plugins, local folders or npm packages installed in
  `<PI_DATA_DIR>/plugins`. A plugin that fails to load, returns an invalid extension or reuses a core name or section
  is skipped: the daemon starts, the log says why, each allowed user gets one line in the chat and `/status` lists
  loaded and failed plugins. A tool call left unfinished by a removed or broken plugin comes back to the model as an
  error and never blocks startup.
- `search`: the `web_search` tool over Tavily, Exa, Brave or Parallel. Results are marked as untrusted web data.
- `mcp`: tools of the MCP servers in `.mcp.json` (stdio and HTTP), named `mcp__<server>__<tool>`. A server that fails
  to start or does not answer in `PI_MCP_TIMEOUT` seconds is reported while the others load; MCP servers get no
  secrets unless their config names them.
- `skills`: one prompt section lists the skills in `<PI_WORKDIR>/skills`, pi's skills folder and `PI_SKILLS_DIRS`;
  the agent reads a skill's `SKILL.md` when a task matches.

## 0.1.3 (2026-10-14)

- Published on npm: `npm install -g pi-durable-telegram`, and `pi install npm:pi-durable-telegram` for the setup skill.
- Answers are Telegram rich messages: tables, task lists, headings and `<details>` folds render natively. Long
  answers are split within Telegram's limits; a refused rich message falls back to HTML. `TELEGRAM_RICH=never` keeps
  the old HTML messages.
- Buttons: the model can end a question with buttons; a tap is your next message, and the pressed button is marked.
- Answers stream as native Telegram drafts with a stop button that works like `/stop`; where drafts are refused the
  edited preview message is used as before.
- pi-durable, pi-ai and chord 1.2.0.

## 0.1.2 (2026-10-11)

- Nothing an allowed user sends is refused any more. Videos, animations and stickers are saved and handed to the
  agent like photos and documents. A file over 20 MB or a failed download is reported to the agent with its name,
  size and the reason. A location, contact, poll or any other message without text or a file arrives as its own
  fields. A voice note without a transcript (no Deepgram key, or the speech service failed) is saved as an audio
  file with the reason, where the bot used to answer "not supported" or "not configured" itself.

## 0.1.1 (2026-10-11)

- One-command installer: `curl -fsSL https://raw.githubusercontent.com/smixs/pi-durable-telegram/main/install.sh | bash`
  installs the official pi, opens it for `/login`, connects the bot, finds your Telegram id from your first message,
  takes the model pi runs, installs the daemon and starts the service. Run it again to update.
- The installer and the setup skill write the provider and model into the env file: a fresh pi saves no default the
  daemon could read, and the service used to stop with "not logged in" for another provider.
- The systemd unit no longer restarts in a loop on exit codes 2, 3 and 4 (bad config, data directory in use, not
  logged in).
- README rewritten in plain language; technical reference moved to `docs/` (install, configuration, how it works,
  security, library).

## 0.1.0 (2026-10-11)

First release.

- Telegram channel for `@earendil-works/pi-durable` 1.1.0: library (`createTelegramChannel`, two-step lifecycle) and
  the `pi-durable-telegram` CLI (`run`, `login <provider>`).
- One durable conversation per allowed private chat in SQLite; unfinished runs resume after a crash and their answers
  are still delivered. Delivery progress is durable, redelivered updates are dropped, a data-directory lock keeps a
  single owner.
- Streaming by editing one message (about one edit per second, 429-aware), Markdown to Telegram HTML with a plain-text
  fallback, splitting at 4096 characters.
- Messages during a run are queued and answered in order; `/new`, `/stop`, `/compact`, `/status`, `/help`.
- Forwarded messages reach the model marked as third-party content; a forwarded command is not run.
- Photos and documents saved to `<workdir>/inbox/`, images viewable by the model through `read`; `telegram_send_file`
  tool; voice, audio and video notes transcribed with Deepgram (optional).
- Workspace tools: `read` (with images), `write`, `edit`, `bash` without the service's secrets in its environment.
- `login <provider>` over SSH with pi-ai's OAuth flow, for machines without pi; credentials mode 600.
- Pi package: `pi install git:github.com/smixs/pi-durable-telegram` adds the `pi-durable-telegram` skill. Run it in pi on the server: it
  asks for a bot token, finds your Telegram id, installs and checks the systemd service.
- Shares pi's login and defaults: credentials come from pi's `auth.json` under pi's own lock (`PI_AUTH_FILE`
  overrides), and unset `PI_PROVIDER`, `PI_MODEL`, `PI_THINKING` follow pi's settings. A `<data dir>/auth.json`
  from an earlier build keeps working.
