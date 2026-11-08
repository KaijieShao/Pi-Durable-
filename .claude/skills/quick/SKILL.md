---
name: quick
description: >
  Fast path for bug fixes, chores, and small changes that don't need full planning.
  Skips /build planning, progress tracking, and /docs. Use this skill when the user
  says 'quick', '/quick', 'quick fix', 'just fix', 'small fix', 'hotfix', 'chore',
  'bump', 'typo', 'quick change', or describes a change that's clearly a bug fix,
  dependency update, config tweak, or other small change that doesn't represent a
  new feature or architectural change.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /quick — Fast Path for Small Changes

You are the lightweight path for bug fixes, chores, and small changes. No planning ceremony, no progress tracking, no doc updates. Just fix it and commit.

**Use this when:**
- Bug fixes (typos, wrong values, missing null checks)
- Dependency bumps (`pnpm update`, version changes)
- Config tweaks (env vars, build config, lint rules)
- Refactors that don't change behavior (rename, extract, inline)
- Chores (cleanup, removing dead code, fixing warnings)

**Do NOT use this when:**
- Adding a new feature (use `/build`)
- Changing module boundaries or architecture (use `/build`)
- Work that should appear in documentation (use `/build` → `/docs`)
- Work that has a checklist item in `.ystack/progress/` (use `/build` → `/go`)

---

## Step 1: Understand the Change

Read the relevant code. For bug fixes, understand what's broken and why. Keep scope tight — fix the bug, nothing more.

If `.ystack/config.json` exists, check if the affected files fall under a module scope. This is informational only — `/quick` doesn't update progress files.

## Step 2: Make the Change

Write the code. Follow existing patterns in the files you're modifying.

Rules:
- Fix only what's asked. No drive-by refactors.
- Match existing code style.
- Run the linter if available: `pnpm fix` or equivalent.

## Step 3: Verify

Run the appropriate checks:

```bash
pnpm typecheck 2>/dev/null
pnpm check 2>/dev/null
```

For bug fixes, confirm the fix addresses the reported issue. A quick grep or read of the changed code is sufficient — no formal success criteria needed.

## Step 4: Commit

Use Conventional Commits:

```
fix(<scope>): <what was fixed>
chore(<scope>): <what was cleaned up>
refactor(<scope>): <what was refactored>
```

## Step 5: Mark Quick Mode

Create the quick mode marker so hooks know to skip progress warnings:

```bash
mkdir -p .context
touch .context/.quick
```

This marker is cleaned up automatically when the session ends or when `/pr` runs.

## Step 6: Done

Report what was changed:

```
## Quick Fix

- Fixed: <what>
- Files: <list>
- Commit: <hash>

Ready for /pr when you want to ship, or keep working.
```

---

## When /quick Escalates to /build

If during Step 1 you discover the change is bigger than expected, say so:

> This looks bigger than a quick fix — it touches the data model / requires a migration / affects multiple modules. Want me to switch to `/build` for proper planning?

Don't silently turn a `/quick` into a multi-file feature implementation.

---

## What This Skill Does NOT Do

- **Does not create plans.** No PLAN.md, no DECISIONS.md.
- **Does not update progress files.** Quick changes aren't tracked features.
- **Does not update docs.** If it needs docs, it's not a quick change.
- **Does not skip verification.** Typecheck and lint still run.
