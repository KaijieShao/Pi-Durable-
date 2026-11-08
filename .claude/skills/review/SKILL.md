---
name: review
description: >
  Code review with multi-agent parallel analysis and confidence-based scoring.
  Use this skill when the user says 'review', '/review', 'check my work', 'verify',
  'did it work', 'is it done', 'review the changes', or after /go completes and
  the user wants to verify the implementation before shipping.
  Also supports reviewing external PRs by URL (e.g., '/review owner/repo#123').
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /review — QA-Aware Multi-Agent Code Review

You are the quality gate of the ystack agent harness. You combine:

1. **QA-aware goal check** — consume `/qa` evidence and only verify what QA did not cover
2. **Multi-agent code review** — parallel specialized agents with confidence scoring

You do NOT trust summaries or task completion claims. You check the actual code.

When `QA-REPORT.md` exists, do not repeat runtime checks, CI checks, browser checks, or success criteria already verified by `/qa` with evidence. Use `/review` for diff-only code risks: security, edge cases, architectural violations, historical context, and maintainability risks that QA would not naturally catch.

---

## Step 1: Determine Review Target

**If a PR URL or reference is provided** (e.g., `owner/repo#123`, a GitHub URL):
- This is an **external PR review**. Skip to Step 3 (no plan verification needed).
- Use `gh pr view <ref>` and `gh pr diff <ref>` to get the PR details and diff.

**If no PR is specified** (reviewing current work):
- Proceed to Step 2 for the QA-aware goal check, then Step 3 for code review.

## Step 2: QA-Aware Goal Check (current work only)

1. Find the active plan:
   ```bash
   ls .context/*/PLAN.md 2>/dev/null
   ```

2. If multiple features exist, ask which to review. If only one, proceed.

3. Read:
   - `.context/<feature-id>/PLAN.md` — the success criteria
   - `.context/<feature-id>/DECISIONS.md` — the locked decisions
   - `.context/<feature-id>/QA-REPORT.md` — what `/qa` verified (if exists)

4. If `QA-REPORT.md` exists, parse its status and open issues before doing any additional verification:

   | QA status | Review behavior |
   |---|---|
   | `PASSED` | Trust QA evidence for covered criteria. Do not re-run those checks. Verify only criteria not covered by QA, then continue to code review. |
   | `ISSUES_FOUND` | Carry open QA issues into the final verdict as blockers or warnings. Do not re-prove them. Continue code review only for additional diff-only risks. |
   | `FAILED` | Stop before multi-agent code review unless the user explicitly asks for review anyway. Report that QA remediation failed and list the open issues. |
   | `BLOCKED` | Stop before multi-agent code review. Report the blocking QA issue and ask for a human decision. |
   | `IN_PROGRESS` | Stop and ask the user to finish `/qa` first, or confirm they want a review against an incomplete QA report. |

   If `QA-REPORT.md` has open issues, preserve them in the final result under `QA Gate`. Do not downgrade or hide them just because code review finds no new issues.

5. Get the diff:
   ```bash
   BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
   git diff "$BASE"...HEAD --stat
   git diff "$BASE"...HEAD
   ```

6. For each success criterion in PLAN.md, verify against the actual codebase only when QA did not already verify it with evidence:

   **If QA-REPORT.md exists:** Trust criteria that `/qa` already verified with evidence. In the table, mark those rows as `QA-PASS` and cite the QA evidence instead of re-checking. Focus direct review effort on criteria that are absent, inconclusive, or explicitly failed in QA.

   **If QA-REPORT.md does not exist:** Perform a lightweight goal check from the code and diff. Do not run the full QA suite; suggest `/qa` if runtime confidence is needed.

   **Output a goal check table:**

   ```markdown
   ## Goal Check

   | # | Criterion | Status | Evidence |
   |---|-----------|--------|----------|
   | 1 | `refundReason` column exists | QA-PASS | `QA-REPORT.md`: schema check passed |
   | 2 | POST /api/refund accepts `reason` | REVIEW-PASS | `apps/api/src/routes/payments.ts:92` |
   | 3 | Admin detail shows refund badge | QA-FAIL | `QA-REPORT.md`: component exists but is not imported |
   ```

   **Include file path and line number for direct review evidence.** For QA-derived rows, cite the QA report evidence. "PASS" without evidence is not acceptable.

## Step 3: Eligibility Check

Use a fast agent to check if the PR:
- (a) is closed
- (b) is a draft
- (c) doesn't need review (automated PR, trivially obvious change)
- (d) already has a code review from you

If any of these are true, stop and report why.

## Step 4: Gather Context

Run these in parallel:

1. **Collect CLAUDE.md files** — find all relevant CLAUDE.md files: root CLAUDE.md plus any in directories modified by the PR.
2. **Summarize the change** — view the PR and produce a brief summary of what it does.

## Step 5: Multi-Agent Parallel Review

Launch **5 parallel agents** to independently review the change. Each agent returns a list of issues with the reason each was flagged:

| Agent | Focus | Method |
|-------|-------|--------|
| **#1: CLAUDE.md compliance** | Audit changes against CLAUDE.md rules | Read CLAUDE.md files, check each rule against the diff. Note: CLAUDE.md is guidance for writing code — not all instructions apply during review. |
| **#2: Shallow bug scan** | Obvious bugs in the changes only | Read the diff. Focus on large bugs. Avoid nitpicks. No extra context beyond the changes. |
| **#3: Historical context** | Bugs visible via git history | Read `git blame` and `git log` of modified files. Find bugs the diff alone wouldn't reveal. |
| **#4: Prior PR patterns** | Recurring issues from past reviews | Read previous PRs touching these files. Check if past review comments apply here. |
| **#5: Code comment compliance** | Respect in-code guidance | Read code comments (TODOs, NOTEs, warnings) in modified files. Check the changes comply. |

### What each agent checks

**Security:**
- SQL injection, XSS, auth bypass, secrets in code
- `target="_blank"` without `rel="noopener"`

**Type safety:**
- `any` usage (should be `unknown` or specific type)
- Type assertions (`as`) avoidable with narrowing

**Logic:**
- Off-by-one errors, null dereference, race conditions
- Missing error handling at API boundaries

**Accessibility** (UI changes only):
- Semantic HTML (`<button>` not `<div onClick>`)
- ARIA labels, alt text, keyboard navigation

## Step 6: Confidence Scoring

For **each issue** found in Step 5, score it 0-100 for confidence:

| Score | Meaning |
|-------|---------|
| **0** | False positive. Doesn't hold up to scrutiny, or is a pre-existing issue. |
| **25** | Might be real, but could be a false positive. Couldn't verify. If stylistic, not explicitly called out in CLAUDE.md. |
| **50** | Verified real, but a nitpick or unlikely in practice. Not very important relative to the rest of the PR. |
| **75** | Very likely real. Double-checked. Will be hit in practice. Existing PR approach is insufficient. Directly mentioned in CLAUDE.md. |
| **100** | Definitely real. Confirmed. Will happen frequently. Evidence directly proves it. |

For issues flagged due to CLAUDE.md, double-check that the CLAUDE.md **actually** calls out that issue specifically.

**Filter out anything scoring below 80.** If nothing remains, report "no issues found."

### False Positives — Do NOT Flag These

- Pre-existing issues (bugs that existed before this PR)
- Things that look like bugs but aren't
- Issues already recorded in `QA-REPORT.md` unless you add new code-level evidence or a different root cause
- Pedantic nitpicks a senior engineer wouldn't call out
- Issues a linter, typechecker, or compiler would catch (formatting, imports, type errors, broken tests) — assume CI runs these separately
- General code quality issues (test coverage, documentation) unless explicitly required in CLAUDE.md
- Issues explicitly silenced in code (lint-ignore comments, etc.)
- Intentional functionality changes related to the broader PR purpose
- Real issues on lines the user **did not modify**
- Code that wasn't changed in this PR

## Step 7: Report

### For current work:

```markdown
## Review Results

### QA Gate

<QA-REPORT.md status, open issue count, and whether review continued or stopped>

### Goal Check: X/Y PASS

[Goal check table from Step 2]

### Code Review: N issues (confidence >= 80)

1. **[SEVERITY]** brief description (CLAUDE.md says "<...>" / bug due to <context>)

   https://github.com/OWNER/REPO/blob/FULL_SHA/path/to/file.ts#L10-L15

2. ...

### Overall Verdict

**PASS** — QA passed or had no open issues, all uncovered criteria met, and no blocking code review issues. Ready for `/pr`.

or

**NEEDS FIX** — QA has open issues, N criteria failed, or M code review issues were found.
```

### For external PR review:

Post a comment via `gh pr comment` with this format:

```markdown
### Code review

Found N issues:

1. <brief description> (CLAUDE.md says "<...>")

   https://github.com/OWNER/REPO/blob/FULL_SHA/path/to/file.ts#L10-L15

2. <brief description> (bug due to <file and code snippet>)

   https://github.com/OWNER/REPO/blob/FULL_SHA/path/to/file.ts#L20-L25

Generated with [Claude Code](https://claude.ai/code)
```

Or if no issues:

```markdown
### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.

Generated with [Claude Code](https://claude.ai/code)
```

**GitHub link requirements:**
- Full git SHA (not `$(git rev-parse HEAD)` — raw Markdown rendering)
- `#L[start]-L[end]` line range format
- At least 1 line of context before and after the issue line
- Repo name must match the repo being reviewed

**Severity levels:**
- **BLOCK** — Must fix before shipping. Security issues, failed criteria, broken types.
- **WARN** — Should fix. Missing accessibility, weak error handling, CLAUDE.md violations.
- **NOTE** — Consider fixing. Minor improvements, not blocking.

## Step 8: Offer Fixes (current work only)

If there are BLOCK or WARN issues:

> Found N issues. Want me to fix them?
>
> **Blocking:**
> 1. RefundReasonBadge not imported in page.tsx
>
> **Warnings:**
> 1. Missing aria-label on badge component

If the user says yes, fix directly, re-verify, and commit with `fix(<scope>): <description>`.

If all criteria PASS and no BLOCK issues:

> All clear. Ready for `/pr`.

---

## What This Skill Does NOT Do

- **Does not trust SUMMARY.md.** It reads the actual code.
- **Does not repeat `/qa`.** It consumes `QA-REPORT.md`, trusts evidenced QA checks, and focuses on uncovered criteria plus diff-only code risks.
- **Does not check build/typecheck/lint.** Assume CI runs those separately.
- **Does not review code outside the diff.** Only changed lines.
- **Does not update docs.** That's `/docs`.
- **Does not create PRs.** That's `/pr`.
- **Does not rewrite working code.** If it passes criteria and has no issues, it's done.
