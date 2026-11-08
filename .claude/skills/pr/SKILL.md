---
name: pr
description: >
  Create a pull request after verification and docs are updated. Runs final checks,
  detects doc gaps, and delegates to the project's pr-draft skill if available.
  Use this skill when the user says 'pr', '/pr', 'ship', 'ship it', 'create pr',
  'open pr', 'ready to merge', 'let's ship', or after /review and /docs complete.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /pr — Ship It

You are the final step of the ystack workflow. You verify everything is ready, then create a pull request.

## Arguments

- `--base <branch>` — the PR's **target branch** (what it merges into). Overrides the
  default-branch auto-detection. Example: `/pr --base staging`. When omitted, the base is
  resolved dynamically from `git symbolic-ref refs/remotes/origin/HEAD` (falling back to
  `main`). The resolved value is reused for both the documentation-check diff and
  `gh pr create --base`.

## Phase 0: Pre-flight Checks

Run all checks before creating the PR. If any fail, stop and report.

### 1. Verification status

Check if `/review` has been run:
```bash
ls .context/*/PLAN.md 2>/dev/null
```

If a PLAN.md exists, check whether all success criteria have been verified. If not:
> Success criteria haven't been verified. Run `/review` first?

### 2. Documentation check

Detect if code changes affect documented modules:

```bash
# Target branch (BASE): the --base <branch> argument if the user gave one (ARG_BASE),
# otherwise the repo's default branch resolved dynamically.
BASE="${ARG_BASE:-$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)}"

# Get changed files
git diff "$BASE"...HEAD --stat

# Check if any changed packages map to doc pages
# Read .ystack/config.json or scan docs structure
```

**If this is a `/quick` change** (`.context/.quick` exists): skip doc check entirely. Quick fixes don't need doc updates.

**If this is a feature** (`.context/<feature>/PLAN.md` exists):

1. Read `.ystack/progress/<module>.md` for newly checked `[x]` items.
2. Check if the linked doc sections still have `<!-- ystack:stub -->`.
3. If stubs remain:
   > Feature **OAuth** is checked off but docs still have stubs. Running `/docs` to fill them in...

   Run `/docs` inline — don't just warn, actually execute the doc update. Then continue with the PR.
4. If no stubs and no doc changes needed, proceed.

**If unsure** (no plan, no quick marker): fall back to a warning:
> Code changes in **payments** but docs weren't updated. Run `/docs` to update, or confirm docs don't need changes.

### 3. Lint and typecheck

```bash
pnpm fix 2>/dev/null    # or the project's lint fix command
pnpm typecheck 2>/dev/null
pnpm check 2>/dev/null
```

If any fail, report the errors and offer to fix.

### 4. Clean working tree

```bash
git status
```

All changes should be committed. If there are unstaged changes, ask the user what to do.

## Phase 1: Create PR

### If project has `pr-draft` skill

Delegate to the project's `pr-draft` skill. It knows the project's PR conventions, monorepo grouping, and section format. Pass the resolved base branch through (the `--base` value) so it opens the PR against the right target.

> Delegating to `pr-draft` for PR creation...

### If no `pr-draft` skill

Create the PR directly:

1. **Ensure branch is pushed:**
   ```bash
   git push -u origin HEAD
   ```

2. **Generate PR title** — Conventional Commits format:
   ```
   feat(payments): add refund reason tracking
   ```

3. **Generate PR body** from the plan and changes:

   ```markdown
   ## Summary

   - [What was built and why, 1-3 bullets from DECISIONS.md]

   ## Changes

   - [Grouped by package/module from the diff]

   ## Verification

   - [Success criteria from PLAN.md, marked as checked]

   ## Test Plan

   - [ ] `pnpm typecheck` passes
   - [ ] `pnpm check` passes
   - [ ] [Feature-specific manual test steps]
   ```

4. **Ask about PR status:**
   > Create as **draft** or **ready for review**?

5. **Create the PR** (target the resolved `$BASE` branch):
   ```bash
   gh pr create --title "<title>" --body "<body>" --base "$BASE" [--draft]
   ```

## Phase 2: Clean Up

After the PR is created:

1. **Verify progress** — confirm all features in scope are checked in `.ystack/progress/<module>.md`.

2. **Archive `.context/`** — don't delete, just note it's done:
   ```
   Feature context at .context/<feature-id>/ can be cleaned up.
   ```

3. **Report:**
   ```
   PR created: <URL>

   ## Summary
   - Feature: <name>
   - Commits: N
   - Files changed: N
   - Docs updated: yes/no
   - All criteria verified: yes
   ```

---

## What This Skill Does NOT Do

- **Does not write code.** That's `/go`.
- **Does not review code.** That's `/review`.
- **Does not update docs.** That's `/docs`. But it DOES check if docs need updating.
- **Does not force-push.** Ever.
- **Does not merge.** Only creates the PR. Merging is a human decision.
