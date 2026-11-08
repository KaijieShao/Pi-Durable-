---
name: address-review
description: >
  Fetch PR review comments, triage them by priority, and address them. Use this skill when the user says 'address review', '/address-review', 'address comments',
  'fix review comments', 'address feedback', 'handle PR comments', 'review feedback',
  'what do reviewers say', 'check PR comments', or when a PR has review comments that
  need to be addressed.
  Works with comments from human reviewers, AI reviewers, and CI checks.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /address-review — Address Review Comments

You fetch review comments from a PR, triage them by priority and validity, present the triage to the user, then address the approved fixes.

## Phase 0: Find the PR

1. Detect the current PR:
   ```bash
   gh pr view --json number,title,url,state,reviewDecision 2>/dev/null
   ```

2. If no PR is found on the current branch:
   > No PR found for this branch. Provide a PR number or URL, or run `/pr` first.

3. If a PR number or URL was passed as an argument, use that instead.

## Phase 1: Fetch All Comments

Gather every piece of feedback on the PR.

### Review comments (inline on code)
```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments --jq '.[] | {id, path, line: .original_line, body, user: .user.login, created_at}'
```

### Review summaries (top-level reviews)
```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews --jq '.[] | {id, state, body, user: .user.login}'
```

### General PR comments (conversation)
```bash
gh api repos/{owner}/{repo}/issues/{number}/comments --jq '.[] | {id, body, user: .user.login, created_at}'
```

### CI check failures
```bash
gh pr checks --json name,state,description --jq '.[] | select(.state != "SUCCESS")'
```

Combine all sources into a single list of feedback items.

## Phase 2: Triage

For each comment, evaluate and categorize it. Read the actual code the comment refers to before making a judgment.

### Categories

**MUST FIX** — Blocking issues that must be addressed before merge:
- Correctness bugs (logic errors, wrong behavior)
- Security issues (injection, auth bypass, secret exposure)
- Failed CI checks (typecheck, lint, build, tests)
- Reviewer explicitly requested changes (`CHANGES_REQUESTED` review state)
- Missing functionality that was promised in the PR description

**SHOULD FIX** — Valid improvements worth making:
- Accessibility gaps (missing ARIA, no keyboard support)
- Missing error handling at system boundaries
- Naming that doesn't match project conventions
- Performance concerns with evidence
- Suggestions that genuinely improve clarity

**WON'T FIX** — Comments to acknowledge but not act on:
- Style preferences not backed by project rules
- "Consider refactoring" on code outside the PR's scope
- Feature requests disguised as review comments
- Suggestions that contradict the locked decisions from DECISIONS.md
- Nitpicks on unchanged lines (pre-existing issues)

**FALSE POSITIVE** — Incorrect or misguided feedback:
- Reviewer misunderstood the code (explain why)
- Comment about code that doesn't exist (outdated diff)
- Suggestion that would break existing functionality
- CI flake (test passed on re-run, or unrelated to this PR)

### Triage output

Present the triage to the user:

```markdown
## PR Review Triage

### PR: #123 — feat(payments): add refund reason tracking
Reviewers: @sarah (changes requested), @ci-bot (2 checks failed)

---

### MUST FIX (3)

1. **@sarah** on `apps/api/src/routes/payments.ts:92`
   > Missing validation for empty string — `reason: ""` would pass the enum check.
   
   **Assessment:** Valid. Zod enum allows empty string if not explicitly excluded.
   **Fix:** Add `.min(1)` or use `z.enum([...])` which already excludes empty. Quick fix.

2. **CI: typecheck** — FAILED
   > Type 'string' is not assignable to type 'RefundReason'
   
   **Assessment:** Real type error introduced by this PR.
   **Fix:** Update the type cast in `admin/src/app/transactions/[id]/page.tsx`.

3. **@sarah** on `packages/db/src/schema.ts:48`
   > This migration needs a default value for existing rows.
   
   **Assessment:** Valid. Existing transactions have no refundReason. Column should be nullable or have a default.
   **Fix:** Change column to `.default(null)` and update type to `RefundReason | null`.

---

### SHOULD FIX (1)

4. **@sarah** on `apps/admin/src/components/RefundReasonBadge.tsx:12`
   > Badge should have different colors per reason type for visual distinction.
   
   **Assessment:** Good UX suggestion. Not blocking but improves the feature.
   **Fix:** Add variant colors — maps to existing badge color system.

---

### WON'T FIX (1)

5. **@sarah** on `packages/shared/src/types/payments.ts:25`
   > Should we also add a `refundRequestedAt` timestamp?
   
   **Assessment:** Feature request, not in scope. This was explicitly deferred in DECISIONS.md.
   **Response:** Acknowledge and note it's tracked for future work.

---

### FALSE POSITIVE (1)

6. **CI: e2e-tests** — FAILED
   > Timeout on unrelated test: `auth/login.spec.ts`
   
   **Assessment:** Flaky test, not related to this PR. Passed on previous run.
   **Action:** Re-run or ignore.

---

> **Recommended:** Fix items 1-3 (must fix) and item 4 (should fix).
> Skip items 5-6. I'll reply to item 5 explaining it's deferred and re-run CI for item 6.
>
> Proceed?
```

**Wait for the user to confirm** which items to fix and which to skip.

## Phase 3: Apply Fixes

For each approved fix:

1. **Read the file** at the referenced line.

2. **Make the fix.** Follow the same rules as `/go`:
   - Match existing code patterns
   - Minimal change — fix the issue, don't refactor surrounding code
   - Run the linter after changes

3. **Verify the fix** — re-run the check that flagged it:
   - If it was a typecheck error → `pnpm typecheck`
   - If it was a logic bug → check the behavior
   - If it was a style issue → `pnpm check`

4. **Commit.** Group related fixes into logical commits:
   - One commit for all "must fix" code fixes: `fix(<scope>): address review — <summary>`
   - Separate commit if a fix is substantial enough to stand alone
   - Do not amend previous commits — always create new ones

## Phase 4: Respond to Comments

For items marked WON'T FIX or FALSE POSITIVE, draft reply comments:

```markdown
### Suggested Replies

**Comment #5** (@sarah — refundRequestedAt timestamp):
> Good idea — we've deferred this to a follow-up. Tracked in [progress file / issue reference].

**Comment #6** (CI: e2e-tests):
> Flaky test unrelated to this PR — `auth/login.spec.ts` timed out. Re-running CI.
```

Ask the user before posting:
> Want me to post these replies on the PR?

If yes:
```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments/{id}/replies -f body="<reply>"
# or for general comments:
gh pr comment {number} --body "<reply>"
```

## Phase 5: Push and Report

1. **Push fixes:**
   ```bash
   git push
   ```

2. **Re-run failed CI** if applicable:
   ```bash
   gh run rerun {run-id} --failed
   ```

3. **Report:**
   ```markdown
   ## Fix Summary

   ### Applied (N)
   - Fixed empty string validation in payments route
   - Fixed type error in admin page
   - Added nullable default for migration
   - Added color variants to RefundReasonBadge

   ### Replied (N)
   - Acknowledged deferred timestamp feature
   - Re-running flaky CI

   ### Skipped (N)
   - (none)

   Pushed to branch. CI re-running.
   ```

---

## What This Skill Does NOT Do

- **Does not auto-fix without user approval.** The triage is always presented first.
- **Does not argue with reviewers.** WON'T FIX replies are respectful acknowledgments, not rebuttals.
- **Does not refactor beyond the fix.** Fix the comment, not the surrounding code.
- **Does not merge the PR.** That's still a human decision.
- **Does not dismiss reviews.** Even after fixing, the reviewer re-approves manually.
