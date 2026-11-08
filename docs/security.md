# Security in detail

The design is in [spec/architecture.md](../spec/architecture.md#trust-boundaries) and
[spec/deployment.md](../spec/deployment.md). Trusted: the Coordinator, Pi, the relay, the tool hooks, the expected
test outputs and the GitHub repository settings. Untrusted: model output, tool arguments and generated code.

- **One group, explicit roles.** Only the configured group (and topic) is served; every other chat is ignored and
  nothing from it is stored or sent to the model. Only a task's creator and the configured owner can follow up on,
  approve or cancel it; `TELEGRAM_MEMBER_IDS` optionally limits who may submit tasks.
- **Secrets stay in the Coordinator.** The bot token, the model key and the GitHub token are read at start and then
  removed from the process environment. The model key is used only by the relay; each Pi process gets a run key that
  the relay accepts only while that run is open, and only for `POST /v1/responses` on 127.0.0.1. Only the Coordinator
  runs git (with the repository's hooks and local configuration disabled) and calls GitHub; the token travels in an
  environment header, never in a command line, URL or log.
- **No arbitrary shell.** The model has `read`, `edit` and `write` inside the task's worktree, and `run_check` with
  the fixed operations of the pinned check image. A policy hook in Pi and the Coordinator both validate every call
  (relative paths inside the worktree, no `..`, no `.git`).
- **Containers.** File operations run in a per-run agent container, checks in a separate check container: no network,
  read-only root filesystem, non-root user, all capabilities dropped, no new privileges, CPU, memory and process
  limits, only the task's worktree mounted with its `.git` masked, no credentials or secret environment.
- **Fail closed.** If Docker or the images are unavailable, no execution starts. If a stop or a GitHub outcome cannot
  be confirmed, the group freezes until the owner resolves it and unfreezes it with the owner CLI.
- **Logs are metadata only:** ids, counts, outcomes, denial categories and hashes; never message text, prompts, tool
  output, headers or secrets. Raw task and follow-up text is stored only in the Coordinator's SQLite database and the
  Pi conversation stores under `PI_DATA_DIR` (mode 700).
- **Not built yet:** the separate watchdog unit, the systemd slice with its own Pi user, and the metadata-server
  firewall from the deployment design. Locally, Pi processes run as your user.

Report vulnerabilities privately, see [SECURITY.md](../SECURITY.md).

---

Back to the [README](../README.md).
