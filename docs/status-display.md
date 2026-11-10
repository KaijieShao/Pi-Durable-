# Read-only status for a routed Coordinator

`owner status` and Telegram `/status` start with the Coordinator's liveness, configured repository,
group/topic, occupied execution slots, and succeeded/failed/open task counts. Counts apply to the selected
view; slots, watchdog and delivery diagnostics describe this Coordinator/database as a whole.

The **Completed** section comes first. It includes merged tasks and coding runs in review whose current
head passed task tests. An open PR is explicitly marked **awaiting approval**, not merged. The latter is
still counted as open. Task tests do not prove latest-main merge tests, production deployment or formal
quality evaluation. A task summary is one redacted, bounded line. Cancelled tasks remain visibly cancelled;
old failures are a single count, without their historic HTTP/authentication errors. No records are removed.

## Commands

```sh
pi-durable-telegram owner status --env-file /path/to/coordinator.env
pi-durable-telegram owner status --all --env-file /path/to/coordinator.env
pi-durable-telegram owner status --verbose --env-file /path/to/coordinator.env
pi-durable-telegram owner status --all --verbose --env-file /path/to/coordinator.env
```

In Telegram, use `/status@smule_code_bot [task-id] [--all] [--verbose]`. Switches may appear in either order.
`#task-id` remains accepted. `--all` is only a display option; it never approves, cancels, merges or reruns work.
Owner `--all` includes every task in the **selected database**, not other databases on the machine. Telegram
`--all` includes other/unconfirmed routing in **this group only**; it cannot reveal another chat's tasks.
A scoped-out detail request explains how to use `/status <id> --all` instead of silently exposing it.

The default owner report measures filesystem free space and database size without walking worktrees or
raw-content stores. `--verbose` adds the original full storage/retention measurements, execution slots,
watchdog sweeps and evaluation details. Telegram `--verbose` shows recorded diagnostics and heads; use the
owner CLI for host filesystem measurements. Group freezes and delivery problems remain visible in the
compact view. PR open/closed badges reflect recorded task/branch-hold state; status makes no GitHub request
and does not claim a freshly fetched GitHub state.

A stopped Coordinator prints one `Coordinator: not running (read-only snapshot) ...` header, with the
absolute database path below. It still exits **3**. Live success is **0**, refusal/failure **1**, invalid
configuration **2**. Offline status still uses the existing read-only/query-only Store connection and
refuses another schema version; no migration is run. SQLite may create its normal WAL reader lock files,
but status does not write task records or schema. Only Node's SQLite experimental notice is suppressed by
the CLI entry point. Other warnings remain visible.

## Routing history without changing existing databases

The current task schema does not store repository or forum topic. A PR URL can identify a repository but
cannot prove a historic topic, and tasks without PRs cannot be classified that way. Status therefore reads
an operator-verified, external routing history through **`PI_STATUS_SCOPE_FILE`**. It never guesses a topic,
backfills task rows or runs a database migration. Configure the same non-secret path for the Coordinator
and the offline owner environment.

Example (illustrative paths/group; not an instruction to reconfigure a running service):

```json
{
  "version": 1,
  "database": "/var/lib/pi-durable-workshop/coordinator.sqlite",
  "periods": [
    {
      "firstTask": 1,
      "lastTask": null,
      "repository": "KaijieShao/pi-durable-workshop-demo",
      "group": -1004438472775,
      "topic": 124
    }
  ]
}
```

Ranges are inclusive; `null` means the verified current routing continues for future task IDs. Each range
must have independent operator evidence. Close the previous range **before** changing routing, and append
the next verified range starting at the first new task ID. Never include an unknown historical interval
just because a PR has the same repository name. Each database needs its own history. Do not copy a history
onto a different database without verifying every range. Keep the file owner-controlled, non-writable by
coding runners, and replace it atomically after review. It contains no credentials.

The path must bind to the absolute configured database path, ranges must not overlap, and a task's group
and recorded PR repository must agree with its range. Missing/invalid history, unmatched ranges or conflicting
PR URLs leave the task **unconfirmed**. Default status hides it and announces the hidden count and `--all`;
`--all` shows it with `scope unconfirmed`. Failure records remain discoverable and are still aggregated.
This is a conservative display boundary, not a new authorization or execution-routing mechanism.

## Deployment/review checklist

This display PR must be approved before merge or deployment. During review, render offline copies and label
outputs as proposed previews; keep the current always-on Workshop poller on its tested revision.

After approval, verify the chosen database/ranges against the saved routing evidence, install its history
file read-only outside the checkout, set `PI_STATUS_SCOPE_FILE`, and use the established one-poller
pause/restore procedure. Do not start a second poller or switch back to General merely to test status.
Check default, `--all`, `--verbose`, one task detail and the CLI exit codes. Hash protected Tasks 8/9 before
and after; never edit those records, worktrees, branches or PRs. No Terraform is involved.

Demo task requests are prepared for humans only after deployment is verified. Do not submit or approve
them while reviewing this display PR. They will have no task/PR links until submitted by the user.
