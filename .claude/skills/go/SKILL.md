---
name: go
description: >
  Execute a plan created by /build. Runs each task with a fresh subagent, produces
  atomic commits, and updates progress files. Use this skill when the user says
  'go', '/go', 'execute', 'run the plan', 'execute the plan', 'start building',
  'let's do it', or confirms a plan and wants to proceed with implementation.
  Requires a PLAN.md from a prior /build run.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /go — Execute the Plan

You are the execution phase of the ystack agent harness. You take a PLAN.md produced by `/build` and execute each task, producing atomic commits per task.

**Your job is to implement, not to redesign.** Follow the plan. If something doesn't work as planned, follow the deviation rules — don't silently change the approach.

## Phase 0: Load the Plan

1. Find the active plan. Look for `.context/` directories with a PLAN.md:
   ```bash
   ls .context/*/PLAN.md 2>/dev/null
   ```

2. If multiple plans exist, list them and ask which to execute:
   > Found plans for:
   > - `refund-reason` — Add refund reason to payments (3 tasks)
   > - `oauth-support` — Add OAuth to auth module (4 tasks)
   >
   > Which plan should I execute?

3. If no plan exists:
   > No plan found. Run `/build <feature>` first to create one.

4. Read the full PLAN.md and DECISIONS.md for context:
   ```
   .context/<feature-id>/PLAN.md
   .context/<feature-id>/DECISIONS.md
   ```

5. Parse the plan: extract success criteria, tasks, file targets, dependencies, and verification steps.

## Phase 1: Compute Execution Order

Determine which tasks can run and in what order.

1. **Build the dependency graph** from `Depends on:` fields in each task.

2. **Group into waves:**
   - **Wave 1:** Tasks with no dependencies (can run in parallel)
   - **Wave 2:** Tasks that depend only on Wave 1 tasks
   - **Wave 3:** Tasks that depend on Wave 1 or 2 tasks
   - etc.

3. **Present the execution order:**
   ```
   Execution order:
     Wave 1: task-1 (Schema and types)
     Wave 2: task-2 (API endpoint), task-3 (Validation)
     Wave 3: task-4 (Admin UI) — depends on task-2
   ```

4. Proceed immediately — no confirmation needed (the user already approved the plan in `/build`).

## Phase 2: Execute Tasks

For each wave, execute all tasks in the wave. Within a wave, tasks are independent and can run in parallel (if the runtime supports subagents).

### Per-task execution:

**Step 1: Read context**

Read ONLY the files listed in the task's `Files:` field. If the task references a doc page, read that too. Do not read unrelated files — the plan already scoped what matters.

Also read:
- DECISIONS.md — for the locked decisions relevant to this task
- Any files produced by prior tasks in earlier waves (new types, new schemas)

**Step 2: Implement**

Follow the task's `Do:` field exactly. Write the code.

Rules:
- Implement what the task says. Not more, not less.
- Follow existing code patterns in the files you're modifying. Match style, naming, imports.
- If the task references a doc page contract (e.g., "API shape defined in docs"), implement exactly what the docs specify.
- Run the project linter if available (`pnpm fix`, `ultracite fix`, or equivalent) after making changes.

**Step 3: Verify**

Run the task's `Verify:` step. Common verification patterns:

- `pnpm typecheck` — types compile
- `pnpm check` — lint passes
- Grep for expected patterns — `grep -r "refundReason" packages/db/src/schema.ts`
- File existence — `ls packages/shared/src/types/payments.ts`
- Test execution — `pnpm test --filter=<package>`

If verification fails, fix the issue and re-verify. Do not skip verification.

**Step 4: Commit**

Create an atomic commit for this task. Use Conventional Commits format:

```
<type>(<scope>): <description>
```

Where:
- `type` = `feat`, `fix`, `refactor`, `chore`, `test` (match the nature of the change)
- `scope` = the package or module affected (e.g., `db`, `api`, `admin`, `shared`)
- `description` = what changed, in imperative mood

Stage the code files AND the progress file together, then commit as one atomic operation:

```bash
git add <code-files> .ystack/progress/<module>.md
git commit -m "<type>(<scope>): <description>"
```

**Step 5: Update progress (before committing)**

Before running `git commit` in Step 4, update the module's progress file at `.ystack/progress/<module>.md`:
- Check the box for the completed feature: `- [ ]` → `- [x]`
- Add a row to the Decisions table if any implementation decisions were made

The progress update and code change are staged and committed together — one commit includes both.

### Subagent execution (Tier 1 runtimes)

On runtimes that support subagents (Claude Code, Gemini CLI), each task SHOULD be executed by a fresh subagent. This prevents context rot — the subagent gets a clean context window with only the task description and file targets.

Spawn the subagent with:
- The task description (Do, Files, Verify fields)
- The relevant locked decisions from DECISIONS.md
- Any doc page references from the task
- The executor agent prompt from `references/executor.md`

After the subagent completes, verify its work in the orchestrator context before moving to the next wave.

### Inline execution (Tier 2+ runtimes or small plans)

On runtimes without subagent support, or when the plan has only 1-2 tasks, execute tasks directly in the current context. Same steps, just no context isolation.

## Phase 3: Handle Deviations

During execution, you may encounter situations the plan didn't anticipate. Follow these rules strictly:

### Rule 1: Auto-fix — Minor bugs in existing code
> While modifying `payments.ts`, you notice an unused import.

**Action:** Fix it silently. Include in the same commit. Not worth stopping for.

### Rule 2: Auto-fix — Missing critical functionality
> The task says "add Zod validation" but the file doesn't import Zod yet.

**Action:** Add the import. This is implied by the task. Include in the same commit.

### Rule 3: Auto-fix — Blocking issues in adjacent code
> The task depends on a type that has a typo in its definition, causing typecheck to fail.

**Action:** Fix the typo. Note it in the commit message. It's blocking your task.

### Rule 4: STOP — Architectural decisions
> The task says "add column to transactions table" but you discover transactions is actually a view, not a table.

**Action:** STOP execution. Report the issue to the user:
> **Deviation detected in task-2:**
> The plan assumes `transactions` is a table, but it's a view over `transaction_log`.
> Adding a column requires modifying the underlying table instead.
>
> Options:
> 1. Add the column to `transaction_log` and update the view
> 2. Revise the plan
> 3. Skip this task and continue with others

Wait for user decision before proceeding.

### Rule 5: STOP — Scope change
> While implementing, you realize the feature needs a database migration that wasn't in the plan.

**Action:** STOP. Report to the user. A migration is a significant scope addition — the user should decide.

## Phase 4: Report Results

After all tasks complete (or if execution stops due to a deviation), report:

```
## Execution Summary

### Completed
- task-1: Schema and types ✓ (commit: abc1234)
- task-2: API endpoint ✓ (commit: def5678)
- task-3: Admin UI ✓ (commit: ghi9012)

### Verification
- pnpm typecheck: PASS
- pnpm check: PASS

### Notes
- [Any deviations, auto-fixes, or observations worth mentioning]

### Next Steps
- Run /review to verify against success criteria
- Run /docs if documentation needs updating
```

Write this summary to `.context/<feature-id>/SUMMARY.md`.

---

## What This Skill Does NOT Do

- **Does not create plans.** That's `/build`. If no PLAN.md exists, say so.
- **Does not redesign.** Follow the plan. Deviations go through the deviation rules.
- **Does not update docs.** That's `/docs`.
- **Does not create PRs.** That's `/pr`.
- **Does not skip verification.** Every task's Verify step must run.
