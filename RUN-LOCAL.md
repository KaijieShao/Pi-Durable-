# Run the group Coordinator locally (macOS + Docker Desktop)

This page starts the Coordinator on a Mac against the real Telegram group (Smule Dev, bot `@smule_code_bot`), a real
GitHub test repository and a real model, for the smoke and acceptance tests in [spec/build-plan.md](spec/build-plan.md)
(items 7, 10 and 11). What runs: one Coordinator process (Telegram polling, relay, outbox, git and GitHub), one Pi
process per run (as your own user on a Mac: the weaker local mode, see [docs/isolation.md](docs/isolation.md)),
Docker containers with no network for file operations and checks, and the **watchdog**, a second process that is the
independent stop path (it kills leftover Pi processes and containers and verifies they are gone, and enforces each
run's deadline). What does not exist yet is listed in [README.md](README.md#not-built-yet).

**Before you start:** stop every other process that polls with the same bot token, in particular the old bot started
by Conductor's **Bot** run action (see [Conductor](#conductor)). Telegram allows one `getUpdates` poller per token.

## 1. Prerequisites

- macOS with **Node.js 22.19 or newer** (`node --version`), **git** (`git --version`).
- **Docker Desktop running** (`docker version` prints a Server section). The task folder must be inside a folder
  Docker Desktop shares (Settings → Resources → File sharing; `/Users` is shared by default, and the default
  `PI_TASK_DIR` is under your home folder).
- The bot `@smule_code_bot` is a member of the Smule Dev group (normal member, no admin rights needed).
- A model key for the OpenAI Responses API (or an OpenAI-compatible gateway, see `OPENAI_BASE_URL`).
- A GitHub test repository and a fine-grained token for it ([section 3](#3-github-test-repository)).

## 2. Install and build the images

```sh
npm ci
```

There is no `postinstall` step any more: Pi Durable 1.5.0 is used unmodified. (`npm ci` also replaces a
`node_modules` that an older version of this package had patched.)

Build the three container images (the agent and check images for runs, the evaluator image for a trial evaluation).
They are built from `node:22-slim` (pinned by tag), so pull the base once first:

```sh
docker pull node:22-slim
scripts/build-images.sh
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep pi-durable
# pi-durable-agent:demo
# pi-durable-check:demo
# pi-durable-evaluator:demo
```

The images were last built here from `node:22-slim` with digest
`sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`. Record yours with
`docker image inspect --format '{{index .RepoDigests 0}}' node:22-slim` and rebuild the images whenever it changes.
If the agent or check image is missing, the Coordinator still starts but refuses to run tasks (it fails closed) and
says so in the log and the group; without the evaluator image `owner seal` is refused.

## 3. GitHub test repository

1. Create a repository for the test project (the signup test project), with a `main` branch whose `npm test` runs
   the project's tests. Optional: `AGENTS.md` (project guidance given to every run) and `.pi/setup.sh` (run once per
   task in a check container, with no network).
2. **Protect `main`.** Settings → Branches → Add classic branch protection rule, pattern `main`:
   - **Require a pull request before merging**, with required approvals set to 0 (the Coordinator's token opens the
     pull requests and cannot approve its own; approval happens in Telegram with `/approve`).
   - **Require status checks to pass before merging** → **Require branches to be up to date before merging** (no
     status check needs to be selected). This is what makes GitHub refuse a merge after `main` moved.
   - Keep "Allow merge commits" enabled in Settings → General (the Coordinator merges with a merge commit).

   The same with your own `gh` login (not the Coordinator's token):

   ```sh
   gh api -X PUT repos/OWNER/REPO/branches/main/protection --input - <<'EOF'
   {"required_status_checks":{"strict":true,"contexts":[]},"enforce_admins":false,
    "required_pull_request_reviews":{"required_approving_review_count":0},"restrictions":null}
   EOF
   ```

3. **Create the Coordinator's token.** GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token:
   - Resource owner: the repository's owner. Repository access: **Only select repositories** → the test repository.
   - Repository permissions: **Contents: Read and write**, **Pull requests: Read and write** (Metadata: Read-only is
     added automatically). Nothing else: no Administration, no Workflows (a task that changes
     `.github/workflows/` therefore cannot be pushed), no account permissions.
   - A short expiration. Copy it straight into `.env.local` (step 5); do not paste it anywhere else.

## 4. Find the group chat id and your user id

Use the bot's own `getUpdates`, with the token in an environment variable and only the ids printed. Stop every
process that polls with this token first (otherwise Telegram answers 409 Conflict).

1. In the group (in the topic you want to use, if the group has topics) send `/help@smule_code_bot`. With privacy
   mode on, a command addressed to the bot is delivered to it; plain chatter is not.
2. In a terminal, read the token without echoing it, then print only the ids:

   ```sh
   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN   # paste the token, press Enter; nothing is shown
   node --input-type=module -e '
   const res = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates`);
   const body = await res.json();
   if (!body.ok) { console.log(`getUpdates failed: ${res.status}`); process.exit(1); }
   for (const u of body.result) {
     const m = u.message ?? u.edited_message;
     if (m) console.log(`chat.id=${m.chat.id} type=${m.chat.type} topic=${m.message_thread_id ?? 1} from.id=${m.from?.id}`);
   }'
   ```

   `chat.id` (negative, `-100…` for a supergroup) is `TELEGRAM_GROUP_CHAT_ID`; `topic` is
   `TELEGRAM_GROUP_TOPIC_ID` (1 = General or no topics); your own message's `from.id` is `TELEGRAM_OWNER_ID`.
3. Confirm those updates so the Coordinator does not process them on its first start, then forget the token:

   ```sh
   node --input-type=module -e '
   const base = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
   const { result = [] } = await (await fetch(`${base}/getUpdates`)).json();
   const last = result.at(-1)?.update_id;
   if (last !== undefined) await fetch(`${base}/getUpdates?offset=${last + 1}&timeout=0`);
   console.log(`confirmed ${result.length} pending update(s)`);'
   unset TELEGRAM_BOT_TOKEN
   ```

Alternatives: forward one of your messages to an id bot in a 1:1 chat for your own user id, or temporarily add a
"raw data" bot (such as @RawDataBot) to the group to read the chat id. Caveat: that is a third-party bot that can read
what is sent in the group while it is there; remove it right after, and prefer `getUpdates` above.

## 5. Configure

```sh
cp .env.example .env.local
chmod 600 .env.local
git check-ignore .env.local      # prints .env.local: the file is ignored by git
```

Edit `.env.local` in an editor (not on screen while recording) and fill in at least `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_GROUP_CHAT_ID`, `TELEGRAM_OWNER_ID`, `PI_AGENTS`, `PI_MODEL`, `OPENAI_API_KEY`, `PROJECT_TOKEN_CEILING`,
`GITHUB_TOKEN` and `GITHUB_REPO`. Every setting is explained in `.env.example` and
[docs/configuration.md](docs/configuration.md). Note: in the main Conductor checkout, `.env.local` is the old bot's
configuration file; if you run from there, use another ignored name such as `.env.coordinator.local`.

## 6. Start

Run from the sources (Node 22 strips the TypeScript types; nothing to build, and `dist/` stays untouched).

**First the watchdog, in its own terminal**, and leave it running:

```sh
node src/cli/main.ts watchdog --env-file .env.local
```

It reads only `PI_DATA_DIR`, `TELEGRAM_GROUP_CHAT_ID`, `DOCKER_BIN`, `PI_RUNNER_ISOLATION`, `PI_RUNNER_SLICE`,
`SYSTEMCTL_BIN` and `LOG_LEVEL` from the file; every other line, the tokens and the model key included, is dropped
before it is parsed, and it needs none of them (a file with only `PI_DATA_DIR` and `TELEGRAM_GROUP_CHAT_ID` works
too). Its log shows `watchdog_started`, and `watchdog_waiting_for_database` until the Coordinator has started once.
On the Mac it finds the Pi processes by their command-line markers and the containers by their
`pi-durable.managed=1` label (on the Docker daemon you configured: it removes every such container there whenever the
Coordinator restarts or is gone, so do not run another deployment or the Docker test suites against the same daemon
while it runs). Run one watchdog per data directory: a second one only logs `watchdog_standby` and waits until the
first one is gone.

**Then the Coordinator, in a second terminal:**

```sh
node src/cli/main.ts run --env-file .env.local
```

At every start the Coordinator asks the watchdog to kill and verify every leftover Pi process and labelled container,
and dispatches nothing until the watchdog has answered "verified" (the log shows `watchdog_sweep_answered
verified=true`). **If the watchdog is not running**, the Coordinator waits 30 seconds for it, then starts anyway in a
paused state: commands are still saved, acknowledged and queued, `/status` works, but no task starts, and the group
gets one message: "Task execution is paused: the watchdog (the independent stop path) is not answering, so no run
starts." Start the watchdog then and the queued tasks start by themselves, no restart needed. If the watchdog stops
while the Coordinator runs, runs in progress go on but no new one starts once its heartbeat is older than 15
seconds (the group is told once); start it again to resume.

Or from a build: `npm run build && node dist/cli/main.js run --env-file .env.local`. Building replaces `dist/`, which
the old Conductor actions use; prefer the source form locally.

What the log should show (one metadata line per event on stdout, warnings and errors on stderr; never message text,
tokens or URLs with secrets):

- `info coordinator_starting version=… group=-100… topic=1 bot=smule_code_bot agents=alpha,beta model=openai/gpt-5.5
  repo=OWNER/REPO base=main data=… tasks=… agent_image=pi-durable-agent:demo check_image=pi-durable-check:demo`
- the getMe check, with **`can_read_all_group_messages=false`** while the bot's privacy mode is on (see
  [Privacy mode](#privacy-mode));
- the container check (Docker and the agent and check images available; otherwise task dispatch is disabled and the
  reason is logged; the evaluator image is checked only by `owner seal`), the git fetch of `main`, restart recovery,
  the relay on `127.0.0.1`, and polling started;
- `info coordinator_running group=-100… agents=2`.

The watchdog's terminal shows `info watchdog_database_open`, then for this start `info watchdog_sweep request=…
reason=coordinator_start verified=true processes_killed=0 containers_killed=0`.

A Node `ExperimentalWarning` about SQLite is expected. Exit codes: 2 = configuration problem or a rejected bot token
(each problem is printed, never a value), 3 = the data directory is locked by another running Coordinator, 1 = any
other startup or fatal error (`startup_failed` / `fatal` in the log).

## 7. Smoke test in the group

Always address commands to the bot (`/command@smule_code_bot`); replies to the bot's messages always arrive. Replies
from the bot quote the command or message they answer.

1. `/help@smule_code_bot` → the command list and limits.
2. `/task@smule_code_bot alpha Add a "terms accepted" checkbox to the signup form, with a test` → an acknowledgement
   with the task id and queue position, e.g. "Task 1 accepted for agent alpha. Queue position 1." Then a progress
   message when the run starts on branch `task/1`, and after the run a review message: test result, the pull request
   link, the head commit and the agent's summary. Open the link: one pull request from `task/1` into `main`.
3. **Follow-up.** Reply to one of the bot's messages about task 1:
   - while the task runs: "Follow-up saved; it will be steered into the running task 1…", later "Follow-up
     delivered to task 1.";
   - while it is in review: "Follow-up started another run of task 1 … Queue position N.", then a new review message
     with a new head commit, on the same branch and pull request.
   A reply from a member who is neither the task's creator nor the owner is rejected with the reason.
4. `/status@smule_code_bot` → group state, execution slots in use (x/2), open and queued tasks with their pull
   requests; `/status@smule_code_bot 1` → details of task 1.
5. **Cancel.** `/task@smule_code_bot beta Rename the submit button`, then `/cancel@smule_code_bot 2` → "Task 2
   cancelled." if it had not started, or "Cancelling task 2…" followed by the final message once its run is stopped,
   its work pushed to `task/2` and its pull request closed (the branch is kept).
6. **Approve and merge.** `/approve@smule_code_bot 1` → "Approved task 1 at abc1234; merging when the merge queue
   reaches it…", then "Task 1 merged into main (…)". `main` on GitHub now contains the merge commit.
7. **Approval rejected after the head changes.** Start task 3 and wait for its review message (note its head
   commit). On GitHub, push a commit to branch `task/3` (for example edit a file in the web editor on that branch).
   Then `/approve@smule_code_bot 3` → the bot first acknowledges it ("Approved Task 3 at abc1234…"), then the merge
   step compares the pull request's head on GitHub with the approved head and rejects the approval: "Approval of
   Task 3 rejected; nothing was merged." The message says why (branch `task/3` on GitHub is at the new commit, but the
   approval was for the head the bot posted; the branch changed outside the Coordinator) and what to do. `main` does
   not change and task 3 stays in review.
   - Restore the branch as the message says, from a clone: `git fetch origin`, then
     `git push --force origin <approved sha>:refs/heads/task/3` (the message gives the full sha; this drops the
     commit you pushed). Then `/approve@smule_code_bot 3` again → "Task 3 merged into main (…)" (if `main` moved
     meanwhile: "Main moved; …" and a new approval), or `/cancel@smule_code_bot 3` → "Task 3 cancelled. Pull request
     closed; branch task/3 kept."
   - A follow-up or `/cancel` before the branch is restored does not freeze the group: the Coordinator never
     overwrites a commit on GitHub (it pushes without force), so GitHub refuses its push, a definite outcome, and only
     task 3 waits; the other tasks keep running and merging. A follow-up run's result stays committed in task 3's
     worktree and the bot says so ("Task 3 finished run 2, but GitHub refused the push of its checkpoint. Nothing was
     merged.", with both heads and what to do); `/approve` is rejected until the branch is restored, then the bot
     pushes that checkpoint and posts it for review ("Task 3 is ready for review (run 2)…") and you approve it. A
     `/cancel` closes the pull request but keeps the worktree ("Task 3 cancelled. Its worktree is kept: GitHub
     refused its final push."); once the branch is restored the bot pushes the final checkpoint and archives it
     ("Task 3 cancelled. Pull request closed; branch task/3 kept."). The Coordinator looks at such a branch again
     every 30 seconds; `/status@smule_code_bot 3` and `owner status` show what it waits for.
   - **Deleted published branch or closed original PR:** normal reviews are also checked every 30 seconds, without
     taking an execution slot. Only that task is held and the group is told. Its worktree stays; new follow-ups and
     approvals are rejected until you restore the branch and reopen **the same original PR**. A closed PR found
     after a lost creation response still counts as the task's one PR. The Coordinator never creates a replacement
     or automatically adopts another PR. If the original PR cannot reopen, cancel the task and use a new `/task`.
     Active-task pushes use an existing-ref guard against deletion during the push connection, without force or
     project hooks. Cancellation or failure still saves its final checkpoint before archiving (a terminal task's
     preservation push may recreate its branch); already archived/merged tasks are not monitored or republished.

## Privacy mode

`@smule_code_bot` has **privacy mode on** in Smule Dev. A bot with privacy mode receives only:

- commands addressed to it (`/task@smule_code_bot …`),
- replies to its own messages,
- plain commands (`/task …`) only when it was the last bot to post in the group, which you cannot rely on.

So a plain `/task` may never reach it. **Always use `/task@smule_code_bot …`** (and `/status@…`, `/cancel@…`,
`/approve@…`); follow-ups are replies, which always arrive.

How to check:

- BotFather → `/mybots` → the bot → Bot Settings → **Group Privacy** shows whether privacy mode is enabled.
- The Coordinator logs `can_read_all_group_messages=false` at startup (from `getMe`) while privacy mode is on.
- Send a plain `/task alpha test` and then `/task@smule_code_bot alpha test`. When privacy mode filters the plain one,
  it produces no update or command line in the Coordinator's log and no reply in the group; the addressed one is
  acknowledged.
- Making the bot a group administrator also delivers every message to it; that is not needed and not recommended.
  After changing privacy mode, remove and re-add the bot to the group for it to take effect.

## Stop

Stop the Coordinator first, then the watchdog. Press **Ctrl-C** in the Coordinator's terminal (SIGINT; SIGTERM does
the same). The Coordinator logs `shutdown reason=SIGINT`, stops polling and
dispatch, stops running runs and their containers, and closes the relay, the database and its lock. A run stopped
this way is **not** resumed: on the next start it is marked "interrupted by restart" and nothing of it is committed
or pushed. Its changes since the last checkpoint stay in the task's worktree; once any file change that was in flight
is reconciled (below), the bot lists the changed files (names only) and the task waits in review until someone
replies (a fresh conversation seeded with those changes; its review step commits and pushes them) or sends
`/cancel <id>` (the final checkpoint pushes them). `/approve` is refused meanwhile: no posted head holds those
changes. A run still starting (its run key
not opened and its Pi process not launched yet) is queued again instead, in the same place, and the bot says so; a
first run's worktree is kept only if its setup finished and nothing changed it, otherwise it is recreated from the
latest main. After 3 such returns the next restart fails the task. A second Ctrl-C exits at once; a shutdown that
takes longer than 30 seconds exits with code 1.

**File changes in flight.** Before the Coordinator runs an `edit` or `write` in the agent container, it saves the
change's intent in `coordinator.sqlite` (table `effect_intents`: the file, its hash before, the intended hash). If
the container's answer never came (a stop or crash in between, or a timed-out file operation, which also stops the
run), the Coordinator reconciles it once the run's Pi process and containers are verified gone (after a restart: once
the watchdog's sweep is verified): it hashes the file itself, without following symlinks and only inside the worktree.
The intended result is "applied", the content before is "currently unchanged"; anything else freezes the group, and
the bot names the task and the file (never its content). A `run_check` that was in flight is reported failed. No
queued task starts until this reconciliation has finished, and nothing archives or pushes that worktree before it.

While the watchdog still runs, it notices that no Coordinator holds the data directory's lock any more and removes
whatever is left (log: `watchdog_coordinator_gone`, then `watchdog_sweep reason=coordinator_dead …`); the same
happens after a crash or `kill -9` of the Coordinator, within a few seconds. Then press Ctrl-C in the watchdog's
terminal too.

Check that nothing is left behind:

```sh
docker ps -a --filter label=pi-durable.managed=1     # no rows
pgrep -fl -- --pi-durable-deployment=                # no output (every Pi process carries this marker)
```

## Owner CLI

The owner CLI talks to the running Coordinator over its owner socket, `<PI_DATA_DIR>/owner/owner.sock` (a 0700
directory, the socket and a per-start token 0600; [docs/security.md](docs/security.md#the-owner-socket)). Run it with
the same env file, as the same user as the Coordinator, in a second terminal (it reads only `PI_DATA_DIR`,
`PI_TASK_DIR`, `TELEGRAM_GROUP_CHAT_ID` and the disk sizes from it, never a secret):

```sh
node src/cli/main.ts owner status --env-file .env.local              # group state, slots, the watchdog, tasks, disks
node src/cli/main.ts owner failed-events --env-file .env.local       # Telegram messages that could not be delivered
node src/cli/main.ts owner unfreeze --env-file .env.local            # recovery checks again; unfrozen only if all pass
node src/cli/main.ts owner resolve 7 --env-file .env.local           # accept uncertain file change 7 as it is now
node src/cli/main.ts owner conversations --env-file .env.local       # quarantined conversations (optionally: <task>)
node src/cli/main.ts owner inspect <conversation> --env-file .env.local   # its transcript, opened read-only
node src/cli/main.ts owner seal --trial trial-1 --env-file .env.local     # trial evaluation (see below)
```

Exit codes: 0 done, 1 refused or failed (for example a recovery check failed), 2 configuration error, 3 the
Coordinator is not running. Without a running Coordinator the CLI says so; `owner status` then also prints the status
read from the database, labelled `READ-ONLY STATUS FROM THE DATABASE` (nothing in it is live), and nothing else works:
in particular there is no unfreeze without the Coordinator's recovery checks.

`owner status` also shows the watchdog: its last heartbeat ("stale" when older than 15 s: no new run starts), its
last sweep (reason, verified or not, how many Pi processes and containers it killed) and the requests waiting for it.

A group **freezes** when the Coordinator or the watchdog cannot confirm a stop, or the Coordinator the outcome of a
GitHub change (for example a push whose answer was lost while GitHub could not be read back) or of a file change (the
file matches neither its content before the change nor the intended result). A push GitHub refuses
because a task branch was changed outside the Coordinator is not unknown and does not freeze the group: only that task
waits until the branch is restored (step 7 of the walkthrough; `owner status` lists such held tasks). Resolve the cause
first (no leftover containers or Pi processes, see above; GitHub branch and pull request state as expected; for an
uncertain file change, `owner status` lists the task, the file, its worktree and the change's number: look at the file,
fix it by hand if needed, then record your resolution with `owner resolve <change>`, which accepts the file as it is
now in the worktree), then unfreeze. `owner unfreeze` makes the Coordinator repeat its recovery checks while the group
stays frozen: close every run key, kill and verify leftover Pi processes and containers, a new watchdog sweep
(`reason=recheck`) that must be answered and verified, every saved merge checked against GitHub, every pending file
change reconciled and none unresolved, the relay running, and nothing froze the group again meanwhile (including a
stop the watchdog could not verify). Only if all pass is the group set to normal and dispatch
reopens for queued work; otherwise it stays frozen and the CLI prints every check with the one that failed, for
example:

```
Group -1001234567890 stays frozen (frozen: the merge outcome of Task 1 on GitHub is unknown): the recovery check "merges" failed. Nothing was unfrozen.
Recovery checks, in order (the ones after the failed check did not run):
  ok     runs: nothing of the group is running
  ok     run keys: 0 open run keys closed
  ok     leftovers: 0 leftover Pi processes killed; none left
  ok     watchdog: its sweep verified the Pi slice and every labelled container empty
  FAILED merges: the saved merge of Task 1 is still unknown: GitHub could not be read (merge check)
Resolve the cause, then run owner unfreeze again.
```

A `/cancel` sent while a file change was unresolved goes ahead once it is resolved. Nothing that was cancelled
resumes, and an interrupted run never does.

A run interrupted by a restart leaves its conversation **quarantined**: never written or reused again (a reply starts
a fresh conversation). `owner conversations` lists them with their task and run; `owner inspect <id>` prints the
transcript (inputs, the model's answers and tool calls, tool results) to your terminal only, read without writing
anything to the conversation's files (no `-wal` or `-shm` file is created; a WAL left by a killed Pi process is read
from a private copy that is deleted at once). Control characters are escaped and known secret shapes masked.

## Trial evaluation (sealing)

The trial harness's trigger is the owner CLI: `owner seal` seals the group and has the **isolated evaluator** grade a
snapshot of `main` with the hidden tests ([docs/security.md](docs/security.md#the-isolated-evaluator)). Nothing in
Telegram starts it.

1. **Hidden tests.** Put them in a folder outside `PI_DATA_DIR` and `PI_TASK_DIR` (the Coordinator refuses to start
   otherwise), readable by your user, and point `PI_EVAL_HIDDEN_TESTS_DIR` at it in `.env.local`:

   ```
   hidden-tests/
     modules/signup/signup.test.js
     modules/signup/expected.json
     integration/flow.test.mjs
     integration/expected.json
     baseline/version.test.cjs
     baseline/expected.json
   ```

   Hidden tests remain **native Node tests** (`node:test`, `.test.js`, `.test.mjs`, `.test.cjs`), with full Node
   filesystem, asynchronous and child-process APIs. Each suite also needs an independent versioned manifest:

   ```json
   {"version":3,"tests":[{"id":"accepts-email","file":"signup.test.js","name":"accepts an email"}]}
   ```

   Names are the actual Node test names; IDs must be unique and every test file must be declared. Optional `line`
   disambiguates identical names in one file. Every expected test must execute and pass; skips, todos, missing tests
   (including an accidental `only` selection), duplicate/unplanned results and missing/truncated reports fail closed.

   **Test the application externally; never import its generated source into the trusted test process.** The trusted
   grader physically has no snapshot mount. Its native tests use the provided client instead:

   ```js
   const { test } = require("node:test");
   const assert = require("node:assert/strict");
   const { app } = require(process.env.PI_EVAL_CLIENT_PATH);
   test("accepts an email", async () => {
     assert.equal(await app.call("signup.js", "signup", ["ana@example.com"]), true);
   });
   ```

   `app.evaluate(body, input)` runs unrestricted asynchronous Node code in the **app container**, with `require`,
   `importModule`, `cwd` and `input`; assertions and expected values stay in the trusted hidden test. `app.exec(argv,
   options)` runs a child process there and returns its exit status and Buffer stdout/stderr. Values use native V8
   serialization (including Buffer, Map, BigInt and Date), not a JSON-only DSL. Complex callbacks, constructors and
   stream behavior can be exercised in the application and their observations asserted outside it. This is an
   explicit external-test migration, not transparent compatibility with unknown in-process import tests.

   For filesystem side effects, use `await app.readFile(relativePath)`: the trusted host reads actual app-scratch
   bytes with Python3 `openat` directory FDs and `O_NOFOLLOW`, refusing symlinks, special files and escaping paths.
   An app-reported successful write followed by an app-reported read is not evidence. Likewise, application-owned
   test reports, `exit(0)` or assertions inside `app.evaluate` are not an independent pass decision; keep the actual
   hidden assertions and their expected values in the trusted test process. Python3 on the host PATH,
   with `dir_fd` and `O_NOFOLLOW`, is an explicit requirement; evaluator availability fails closed without it.

   The Coordinator runs **one trusted grader and one separate full-Node application container**. Only the grader
   receives the read-only hidden mount; only the app receives the read-only snapshot; their writable scratch mounts
   are disjoint. Both have no network, credentials, Docker socket or shared PID namespace. Each gets 1 vCPU, 1 GiB
   and 256 PIDs: the total remains 2 vCPU, 2 GiB and 512 PIDs. An app-local Unix socket and a host-started `docker exec`
   proxy carry untrusted business observations; no host-to-Docker-VM Unix socket sharing is assumed. Native stdout,
   stderr and stream callbacks/drain are unchanged; logs cannot enter the trusted grading report.

   Each suite gets a fresh app container and writable snapshot copy only after the prior subject is stopped and
   verified gone. Unexpected app exit, malformed transport or V8 decoding failures latch independently of test
   assertions, so `assert.rejects` cannot swallow an infrastructure failure into a passing trial. Ordinary application
   exceptions and genuinely missing/unsafe file observations remain available for explicit negative tests.

   The fixed **version 3** suite list lives in `deploy/docker/suites.json`; `scripts/build-images.sh` builds it offline
   from the already-local Node image. No QuickJS runtime or restricted-case grading path is included. Migrate every
   prior assertion, rebuild, and freeze a **new separately reported evaluation series** (spec § Frozen Before Trial 1).
   Never pool results from the old in-process runner or the rejected restricted prototype with this build.
2. **Restart the Coordinator** with the new variable, and let the trial's tasks run, get approved and merge.
3. **Seal**, in a second terminal:

   ```sh
   node src/cli/main.ts owner seal --trial trial-1 --env-file .env.local
   # or name the trial's tasks: owner seal --trial trial-1 --tasks 3,4 --env-file .env.local
   ```

   The trial's tasks are those named with `--tasks`, else every task of the group created since the last evaluation.
   The seal is refused (nothing changes) while any of them is not merged, while the group is frozen or already
   sealing, for a trial id that was evaluated before (a trial is evaluated once, never rerun), or without the hidden
   tests or the evaluator image; the CLI says why. Otherwise the group turns **sealing** and the bot says so.
4. **While sealing**, dispatch, merges and follow-up delivery are held across the deployment: `/task` requests are
   accepted and queued ("Waiting: dispatch is held while the group is sealed…"), `/approve` is accepted and its merge
   waits, a reply to a running task is saved but not delivered (when that run completes it starts another run of the
   task, which also waits; if the run fails it expires). Runs and merge tests already in progress finish first.
   `owner status` shows the progress: `Evaluation in progress: trial trial-1, sealing … waiting for 1 active run to
   finish`.
5. Then the Coordinator verifies nothing executes any more (its own kills and the watchdog's sweep), fetches `main`,
   checks it contains every trial task's merge, exports it read-only to `<PI_TASK_DIR>/snapshots/trial-1-<commit>`
   (with `trial-1-<commit>.manifest.json`: commit, git tree, content hash) and starts the trusted evaluator plus its isolated application
   (`pi-durable-evaluator:demo`, no network, aggregate 2 vCPU / 2 GiB, disjoint read-only sources and private scratch
   directories under `<PI_TASK_DIR>/eval-scratch/`). The suites run one after another (30-minute deadline).
6. **The result** is posted to the group, for example `Evaluation of trial trial-1: PASSED. Snapshot of main at
   1a2b3c4. Trial tasks: Task 3, Task 4. Suites (3 of 3 passed): module:signup passed, integration passed, baseline
   passed. Dispatch has reopened.`, and recorded: `owner status` shows `Last evaluation: …` with the per-suite
   outcomes. The database (`evaluations`) also keeps what the trial records: the snapshot's commit and hashes, the
   Pi Durable, scaffold and Node versions (no patches), the image ids, the tool policy version, the container limits
   and the hidden tests' hash. Dispatch reopens only after the evaluator container is verified gone and its scratch
   directory wiped; queued tasks then start.

If the evaluator cannot start, or its cleanup cannot be verified, the group **freezes** instead (the result is still
recorded): check `docker ps -a --filter label=pi-durable.kind=evaluator` and the scratch folder, then `owner
unfreeze`. A restart during the evaluation records it as interrupted (not graded) and reopens dispatch once the
cleanup is verified; seal again with a new trial id. A freeze while sealing ends the sealing without grading.

The controller must run through the host broker; running it alone or importing candidate code into it bypasses the
external test contract and is unsupported. To exercise the packaged path without Telegram or credentials, run:

```sh
node --test test/coordinator/evaluator-docker.test.ts
```

It uses synthetic snapshots and native hidden tests. The trusted plan binds expected IDs; each suite records actual
executed/passed IDs before `done`. Application output is never parsed as a grading report. This separation and its
failure cases are regression-tested, not a proof against kernel/container/Node vulnerabilities, compromised trusted
images or hidden-test authors, or side channels. External tests establish observable behavior; they do not attest
an internal function's identity or rule out hard-coded behavior outside the tested inputs.

## Where the data lives

- `PI_DATA_DIR` (default `~/.local/state/pi-durable-coordinator`, mode 700): `coordinator.sqlite` (tasks, runs,
  follow-ups, queue, approvals, merge intents, file-change intents, budget ledger, outbox, Telegram offset),
  `conversations/` (one Pi SQLite
  file per conversation; raw task content lives here and in `coordinator.sqlite` only), `run-home/` (empty HOME for Pi
  processes), `owner/` (mode 700: the owner socket and its token while the Coordinator runs) and the lock file.
- `PI_TASK_DIR` (default `<PI_DATA_DIR>/tasks`): `repo.git` (the Coordinator's clone), `worktrees/task-<id>` (one per
  open task; deleted when the task is archived, the branch stays on GitHub), `scratch/` (check scratch space, wiped
  after each check), `snapshots/` (the sealed snapshots of trial evaluations, read-only, kept: remove one with
  `chmod -R u+w` first) and `eval-scratch/` (the evaluator's scratch space, wiped after each evaluation).
- Disk limits ([docs/configuration.md](docs/configuration.md#disk-limits)): a new `/task` is refused while the disk
  of `PI_DATA_DIR` has less than 1 GiB free (`PI_BOOT_DISK_MIN_FREE`). A task's worktree is created only if it leaves
  1 GiB free on the disk of `PI_TASK_DIR` (`PI_TASK_DISK_MIN_FREE`), counting its files plus 1 GiB of headroom
  (`PI_WORKTREE_HEADROOM`), and fits in `PI_TASK_DISK_BUDGET` if you set one; otherwise the task waits in the queue
  and the bot says why ("Task 3 stays queued: its new worktree needs about …"). On a Mac both folders are usually on
  the same disk. `owner status` shows both disks and what the database and the conversations take.
- `coordinator.sqlite` is shared with the watchdog (its own connection): sweep requests and answers
  (`watchdog_sweeps`) and its heartbeat. The watchdog creates nothing in `PI_DATA_DIR`.
- Logs: stdout and stderr of the Coordinator and of the watchdog.

## Reset a local test

1. Stop the Coordinator (Ctrl-C), let the watchdog clean up, stop the watchdog, and check nothing is left behind
   (see [Stop](#stop)); remove leftovers with
   `docker rm -f $(docker ps -aq --filter label=pi-durable.managed=1)`.
2. Delete the data and task folders: `chmod -R u+w ~/.local/state/pi-durable-coordinator && rm -rf
   ~/.local/state/pi-durable-coordinator` (or your `PI_DATA_DIR` and `PI_TASK_DIR`; sealed snapshots are read-only).
3. On GitHub, close the test pull requests and delete the `task/*` branches (`gh pr list`, `gh pr close N
   --delete-branch` with your own login); reset `main` of the test repository to the fixture if a test merged into
   it, or recreate the repository.
4. A fresh database starts without a Telegram offset and processes the updates still pending for the bot. To start
   clean, confirm them first with the snippet in [step 4.3](#4-find-the-group-chat-id-and-your-user-id). This is a
   test-only step.

## Conductor

The Conductor actions in `.conductor/settings.toml` (Setup, **Bot**, Doctor, Login) belong to the old private-chat
bot. In this workspace's copy, Setup no longer runs the Bot action automatically (`auto_run_after_setup = false`), and
**Bot** fails at once with a message pointing here instead of starting the old bot (nothing is installed, built or
read). Start the Coordinator from a terminal as above.

Check which settings Conductor actually uses on your Mac: repository-local settings in the main checkout
(`<main checkout>/.conductor/settings.local.toml`) take precedence and may still have `auto_run_after_setup = true`
and a Bot command that runs the main checkout's own `.conductor/workspace.mjs`, which still starts the old bot. Turn
that off too (or stop the Bot run) before a live test, and never run the old bot and the Coordinator with the same
token: Telegram allows one poller per token.

## Security notes

- Never paste a token or key into the group or any chat other than a 1:1 with the person who needs it. Secrets live
  only in `.env.local` (mode 600, ignored by git) and, at run time, in the Coordinator's memory; the Coordinator
  removes them from its environment after reading the configuration.
- Do not show `.env.local`, the `read -rs` step or the GitHub token page on screen while recording.
- The model key is held by the relay inside the Coordinator; each Pi process gets only a run key that the relay
  accepts while that run is open. Only the Coordinator runs git and holds the GitHub token.
- **Pi processes on the Mac run as your own user** (`PI_RUNNER_ISOLATION=process`, the default on macOS): a child
  process of the Coordinator in its own process group, with a minimal environment and an empty private HOME, talking
  over Node IPC. Unlike the Linux deployment there is no separate unprivileged user, no systemd slice, no per-unit
  sandbox or IP filter and no metadata-server firewall; Pi processes are found again by the markers in their command
  line (`--pi-durable-deployment=…`, `--pi-durable-run=…`), not by a slice. Pi still talks only to the relay on
  127.0.0.1 and holds only its run key, but nothing on the Mac enforces the network part. What differs and what is
  verified only on Linux: [docs/isolation.md](docs/isolation.md).
- Containers get no network (`--network none`), no credentials and no environment secrets, only the task's worktree
  (its `.git` is masked), a read-only root filesystem, a non-root user and CPU, memory and process limits. There is no
  arbitrary shell: the model has `read`, `edit`, `write` and `run_check` with the fixed operations of the check image.
- Logs are metadata only: ids, counts, outcomes and hashes.
