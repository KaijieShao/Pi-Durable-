# Post-acceptance remote branch cleanup

The owner-approved policy is to remove merged task feature branches after their tasks complete and their worktrees are archived. The independent worker in `proposals/branch-cleanup/worker.ts` implements this policy. It never approves, cancels or merges a task and never writes a Coordinator database. GitHub's `delete_branch_on_merge` setting stays **false**, because that setting cannot wait for durable task completion and archival.

## Eligibility and retained records

Every attempt checks the configured repository and exact `<taskPrefix><taskId>` ref against the task, one consumed approval, one settled merge intent and the actual GitHub PR. The reviewed, posted, tested and approved head must agree. GitHub must confirm the PR merged into the configured base, the recorded merge is reachable from its current default branch, and both immutable commits are readable. The task must be merged, archived, have no worktree and no active run, slot, unsettled file effect or pending merge intent. The expected worktree directory must be absent. An open PR using the ref, a changed head, protected ref or unknown evidence keeps the branch.

Main, the actual default/base branch, configured long-lived names/prefixes and all open, cancelled, failed or unmerged task branches are retained. The original task, conversation, PR number/URL, head and merge SHAs remain in the Coordinator database. Recovery still reconciles pending merges before cleanup is eligible. Merged tasks cannot accept follow-ups, and cleanup never recreates a branch.

Deletion uses Git's receive-pack ref transaction with an exact old-SHA lease:

```text
git push --force-with-lease=refs/heads/<branch>:<reviewed-head> <repository> :refs/heads/<branch>
```

No unconditional REST ref deletion, force update or protection bypass is used. A push arriving after preflight makes the lease fail. GitHub also enforces its receive-side deletion restrictions. The worker confirms remote absence after the effect and rechecks the immutable evidence.

Commits remain available through main and the PR's head reference. For recovery, fetch `refs/pull/<PR>/head` and verify its SHA against the retained task record. Restoring a remote branch is a separate owner action; the worker does not delete a recreated branch after its journal already recorded deletion.

## Configuration and activation

`proposals/branch-cleanup/config.example.json` is disabled by default. Each source declares its exact repository, absolute Coordinator database/task directory, branch prefix and repository-scoped Secret Manager credential ID. The worker reads only explicit metadata columns using SQLite read-only/query-only mode. Its own `cleanup.sqlite` lives in a separate state directory. The historical snapshot option additionally verifies an immutable database hash and an independently checked list of archived branches.

`acceptanceComplete` means the formal test phase has **finished and its results have been recorded**; it does not assert the project passed. Owner activation approval is required separately. Keep cleanup disabled throughout acceptance/rehearsal. The owner's subsequent policy decision authorizes activation after the phase finishes, including when the report contains failures. A deployment records that boundary and a positive `notBeforeMs` cutoff.

By default, branches merged before that cutoff are kept. Historical backfill requires a separate, exact allowlist of repository/task/branch/PR/reviewed-head/merge tuples. This closeout authorizes only the five already-merged `task/1` through `task/5` branches in `KaijieShao/pi-durable-workshop-demo`; it does not authorize any cancelled branch or Tasks 8/9 in the original repository.

Activation procedure:

1. Finish and preserve the frozen formal evidence, then review/merge the cleanup source PR.
2. Install that merged archive at `/opt/pi-durable-branch-cleanup`. This is a separate release; no Coordinator restart or source change is needed.
3. Configure a `dry-run` worker, precise sources/cutoff/keep list and repository-scoped credentials. Run once and review its positive candidates and retained counts.
4. Set the reviewed configuration to `enabled`; enable the supplied systemd timer. `flock` allows only one worker across timer/manual invocations. The worker has a read-only filesystem except its own state directory.
5. Create and approve a new disposable demo task through Telegram. Verify actual GitHub merge, durable task completion and archive, then automatic leased deletion and the PR page. Historical cleanup uses the same gates.

The credential is fetched from Secret Manager into memory; it is never an argument, config value, journal value or log value. Git receives a short-lived child-only HTTP auth environment with tracing and credential helpers disabled. No new Mac startup service is installed.

## Outcomes, retries and rollback

The independent journal records repository/task/branch/PR/head/merge, result, attempts and timestamps. Persist `pending` before deleting. Read back an uncertain response or restart before retrying. Transient failures start at 60 seconds and double up to one hour; eight attempts require attention. Permission/protection/lease refusal requests attention without forcing deletion. Unknown/changed evidence keeps the branch. Credential acquisition failure emits a categorical warning and is retried on a later timer tick.

A housekeeping failure leaves the successful task and merge unchanged, does not freeze the Telegram group, and does not change a merged task to failed. The timer's journal/logs are the separate place to inspect cleanup problems. `needs-attention` and `kept` outcomes require operator review before a journal retry; no automatic override is made.

Read-only status:

```sh
node /opt/pi-durable-branch-cleanup/proposals/branch-cleanup/worker.ts --config /etc/pi-durable/branch-cleanup.json --report
systemctl status pi-durable-branch-cleanup.timer
journalctl -u pi-durable-branch-cleanup.service
```

Rollback: stop/disable the timer and set mode to `disabled`. Keep the journal and task records. This stops future deletions and never rewrites main or restores a branch automatically.

## Validation and limitations

Run `node --test proposals/branch-cleanup/*.test.ts`. Tests include all positive gates, disabled behavior, metadata-only/read-only scanning, failure/retry semantics, unknown deletion readback, exact historical authorization and a real Git stale-lease/deletion/recovery-object check. Production closeout separately verifies the actual GitHub PR pages and an automatically cleaned Telegram task.

The private-repository plan still blocks strict GitHub branch protection. Upgrade the owner to GitHub Pro (or an organization to a suitable paid plan), then require the trusted latest-main check, fresh approvals and prevent bypass/direct pushes. Making the repository public is not part of this change. Coordinator latest-main/reapproval checks remain enabled, but do not prove GitHub's atomic rejection when main moves between the final check and merge. Cleanup does not resolve that separate acceptance limitation.
