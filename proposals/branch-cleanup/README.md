# Post-acceptance branch cleanup proposal

Status: **review only, disabled, not deployed, not imported by the Coordinator**. No existing branch deletion is part of this change. The source deployment-preservation PR and current acceptance build stay unchanged.

## Why not the GitHub checkbox?

Keep `delete_branch_on_merge=false`. GitHub's built-in deletion runs when the PR merges; it cannot wait for the Coordinator to finish its durable task transition and archive the worktree. Use a Coordinator-owned housekeeping queue instead, after explicit post-acceptance activation approval. Do not widen the acceptance token or change a repository setting merely to try this proposal.

## Positive eligibility, every time

The exact configured repository, `task/<id>` ref, PR number, approved head and actual merge SHA must agree across the durable task, consumed approval/merged intent and GitHub. Require all of:

1. PR is actually merged into the configured base; its recorded merge is reachable from that base.
2. Task state is `merged`, `archived=1`, `worktree_path=NULL`, and the original worktree is confirmed absent. No run, slot, unresolved effect or pending merge intent remains for the task.
3. No other open PR uses the ref. The ref still points to the exact merged task head.
4. It is not main, the actual repository default/base, a protected branch, or a configured long-lived branch/prefix. Unknown GitHub protection/ruleset status means keep it.
5. Formal acceptance is complete, the owner explicitly approved enabling cleanup, and the PR merged after the recorded activation cutoff. **No historical backfill** by default.

Revalidate immediately before deletion. A read followed by an unconditional REST `DELETE /git/refs/...` is insufficient: a concurrent push could otherwise be lost. The future adapter must issue a remote atomic expected-old-SHA lease, e.g. `git push --force-with-lease=refs/heads/task/42:<approved-head> origin :refs/heads/task/42`, after protection checks. The core only accepts a `deleteRemoteRefWithLease` port. No real deletion adapter is included in this PR.

## Separate journal and failure semantics

Before any effect persist a unique cleanup job keyed by repository/task/PR/head, with merge SHA, activation epoch, state, attempt count, next-attempt time and last categorical outcome. Use a separately reviewed SQLite migration and a single-worker atomic claim/lease. Never reuse or modify a successful `merge_intents` row to track cleanup.

States: disabled / kept / would-delete / pending / deleted / already-absent / retry / needs-attention. Retry scheduling is housekeeping, not task scheduling. Persist the deletion intent before issuing it. Verify remote absence after a successful response. After a timeout or crash, read GitHub first: absent means complete, unchanged eligible head may retry, changed/protected/unknown state retains the branch. Backoff starts at 60 seconds, doubles to a one-hour cap, and stops for operator attention after eight attempts; no busy loop or forced overwrite.

Cleanup ports cannot mutate task, conversation, approval or merge state. A GitHub outage, denied token, protected branch, lease refusal, uncertain deletion or journal-write failure leaves the already-merged task successful. Emit a cleanup warning/attention event and retain/reconcile the independent job; do not freeze the group or report a failed merge merely for housekeeping. A new inconsistency in the underlying merge/worktree evidence is handled by existing safety/recovery paths, never hidden by cleanup.

## Compatibility with current task records and recovery

Source inspection in the frozen baseline:

- `src/coordinator/engine/merge.ts:completeMerge` saves merged intent, actual merge SHA, consumed approval and `tasks.state=merged` before attempting `archiveTask`. Archive failure logs a warning and leaves recovery to retry it. Therefore PR-merged alone is too early.
- `src/coordinator/engine/effects.ts:archiveTask` reconciles effects, removes the worktree, then records `archived=1` and `worktree_path=NULL`. A held archive keeps its branch/worktree and is ineligible.
- `src/coordinator/engine/recovery.ts:pendingMergeIntents/resolveIntent` uses immutable approved head and base containment to reconcile unknown merges. Cleanup is blocked while such an intent is pending. Once settled and archived, those commits remain in main/PR history; branch, head, PR URL and conversation records remain unchanged even if the remote ref later disappears.
- Recovery schedules archive jobs only for ended tasks with a remaining worktree. An intentionally cleaned, merged-and-archived task must not be treated as a deleted active branch or recreated. Follow-ups after merge already require a new task.
- Existing `GitPort.deleteBranch` is local initial-worktree recovery housekeeping, **not** this proposed remote cleanup operation. It is left untouched.

The current code has no cleanup journal/remote adapter and no startup flag wired to this proposal. `config.example.json` describes a future configuration, not an operational environment variable. The reviewed worker core can be tested with fake ports only:

```sh
node --test proposals/branch-cleanup/policy.test.ts
```

## Remaining implementation and approval gates

Before enablement, separately review and test: SQLite queue/atomic claim migration; trusted GitHub protection + ruleset reader; leased remote-delete adapter; periodic worker lifecycle; merge/archive/recovery integration; metrics/alerts; credential scope; crash after delete before journal settlement; inaccessible repository vs genuinely absent ref; branch recreation race; actual GitHub denied/protected/ref-changed cases. Freeze a new build/evaluation series for changes affecting acceptance. These integration cases are **not tested** by the pure worker tests.

Activation sequence: obtain owner approval for the exact repository/cutoff/keep list; complete formal acceptance; deploy only in an authorized later change; dry-run and review candidates; separately approve `enabled`; verify the first cleanup's remote absence and durable task/PR/merge evidence. Rollback is `disabled`: it stops future attempts, preserves journal/audit records, and never rewrites main. Restoring a deleted ref, if needed, is a separate reviewed operation from the retained immutable head, not automatic branch recreation.

Current acceptance/rehearsal: keep all remote refs, all current tasks/evidence, and GitHub's immediate-deletion setting unchanged and off.
