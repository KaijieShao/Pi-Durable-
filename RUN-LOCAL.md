# Run the group Coordinator locally (macOS + Docker Desktop)

This page starts the Coordinator on a Mac against the real Telegram group (Smule Dev, bot `@smule_code_bot`), a real
GitHub test repository and a real model, for the smoke and acceptance tests in [spec/build-plan.md](spec/build-plan.md)
(items 7, 10 and 11). What runs: one Coordinator process (Telegram polling, relay, outbox, git and GitHub), one Pi
process per run, and Docker containers with no network for file operations and checks. What does not exist yet is
listed in [README.md](README.md#not-built-yet).

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

Build the two container images. They are built from `node:22-slim` (pinned by tag), so pull the base once first:

```sh
docker pull node:22-slim
scripts/build-images.sh
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep pi-durable
# pi-durable-agent:demo
# pi-durable-check:demo
```

The images were last built here from `node:22-slim` with digest
`sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`. Record yours with
`docker image inspect --format '{{index .RepoDigests 0}}' node:22-slim` and rebuild the images whenever it changes.
If either image is missing, the Coordinator still starts but refuses to run tasks (it fails closed) and says so in
the log and the group.

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

Run from the sources (Node 22 strips the TypeScript types; nothing to build, and `dist/` stays untouched):

```sh
node src/cli/main.ts run --env-file .env.local
```

Or from a build: `npm run build && node dist/cli/main.js run --env-file .env.local`. Building replaces `dist/`, which
the old Conductor actions use; prefer the source form locally.

What the log should show (one metadata line per event on stdout, warnings and errors on stderr; never message text,
tokens or URLs with secrets):

- `info coordinator_starting version=… group=-100… topic=1 bot=smule_code_bot agents=alpha,beta model=openai/gpt-5.5
  repo=OWNER/REPO base=main data=… tasks=… agent_image=pi-durable-agent:demo check_image=pi-durable-check:demo`
- the getMe check, with **`can_read_all_group_messages=false`** while the bot's privacy mode is on (see
  [Privacy mode](#privacy-mode));
- the container check (Docker and both images available; otherwise task dispatch is disabled and the reason is
  logged), the git fetch of `main`, restart recovery, the relay on `127.0.0.1`, and polling started;
- `info coordinator_running group=-100… agents=2`.

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
   Then `/approve@smule_code_bot 3` → the approval is rejected because the branch no longer matches the commit the bot
   posted ("Approval rejected: the branch changed after approval." — the bot may first acknowledge the `/approve`
   and reject it when the merge step compares the pull request's head on GitHub). `main` does not change and task 3
   stays in review. Cancel it afterwards with `/cancel@smule_code_bot 3`.

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

Press **Ctrl-C** (SIGINT; SIGTERM does the same). The Coordinator logs `shutdown reason=SIGINT`, stops polling and
dispatch, stops running runs and their containers, and closes the relay, the database and its lock. A run stopped
this way is **not** resumed: on the next start it is marked "interrupted by restart", its work is checkpointed and
pushed, and the task waits in review until someone replies (a fresh conversation). A second Ctrl-C exits at once; a
shutdown that takes longer than 30 seconds exits with code 1.

Check that nothing is left behind:

```sh
docker ps -a --filter label=pi-durable.managed=1     # no rows
pgrep -fl runner/main                                 # no output
```

## Owner CLI

Run with the same env file, in a second terminal while the Coordinator runs or while it is stopped (it opens the
Coordinator's SQLite database directly; the owner socket from the docs is not built yet):

```sh
node src/cli/main.ts owner status --env-file .env.local          # group state, execution slots, tasks and PRs
node src/cli/main.ts owner failed-events --env-file .env.local   # Telegram messages that could not be delivered
node src/cli/main.ts owner unfreeze --env-file .env.local        # frozen group back to normal, recovery rechecked
```

A group **freezes** when the Coordinator cannot confirm a stop or the outcome of a GitHub change. Resolve the cause
first (no leftover containers or Pi processes, see above; GitHub branch and pull request state as expected), then
unfreeze. Unfreezing sets the group to normal with `recheck_required=1`: the Coordinator repeats its recovery checks
before it dispatches queued work again. Nothing that was cancelled resumes.

## Where the data lives

- `PI_DATA_DIR` (default `~/.local/state/pi-durable-coordinator`, mode 700): `coordinator.sqlite` (tasks, runs,
  follow-ups, queue, approvals, merge intents, budget ledger, outbox, Telegram offset), `conversations/` (one Pi SQLite
  file per conversation; raw task content lives here and in `coordinator.sqlite` only), `run-home/` (empty HOME for Pi
  processes) and the lock file.
- `PI_TASK_DIR` (default `<PI_DATA_DIR>/tasks`): `repo.git` (the Coordinator's clone), `worktrees/task-<id>` (one per
  open task; deleted when the task is archived, the branch stays on GitHub), `scratch/` (check scratch space, wiped
  after each check).
- Logs: stdout and stderr of the Coordinator only.

## Reset a local test

1. Stop the Coordinator (Ctrl-C) and check nothing is left behind (see [Stop](#stop)); remove leftovers with
   `docker rm -f $(docker ps -aq --filter label=pi-durable.managed=1)`.
2. Delete the data and task folders: `rm -rf ~/.local/state/pi-durable-coordinator` (or your `PI_DATA_DIR` and
   `PI_TASK_DIR`).
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
- Containers get no network (`--network none`), no credentials and no environment secrets, only the task's worktree
  (its `.git` is masked), a read-only root filesystem, a non-root user and CPU, memory and process limits. There is no
  arbitrary shell: the model has `read`, `edit`, `write` and `run_check` with the fixed operations of the check image.
- Logs are metadata only: ids, counts, outcomes and hashes.
