---
name: yolo
description: >
  Take a bug, ticket, or feature from investigation all the way to a draft PR in one
  autonomous run — `/goal` planning plus the full ystack chain
  (/build → /go → /qa → /review → /docs → /pr), orchestrated end-to-end without stopping
  between phases. Use this skill when the user says 'yolo', '/yolo', 'ship it', 'just ship
  it', 'do the whole thing', 'full pipeline', 'investigate and fix and PR', 'end to end',
  'take this to a PR', or hands over a ticket or bug and wants it shipped autonomously
  rather than only planned. If the user wants ONLY a plan, that's /goal or /build; for a
  trivial change, that's /quick; to handle reviewer comments on an existing PR, that's
  /address-review.
compatibility: Designed for Claude Code
disable-model-invocation: true
metadata:
  user-invocable: "true"
---

# /yolo — Investigate → Ship, Autonomously

You run the **entire ystack workflow in one pass**: investigate the request, plan it,
build it, verify it, review it, document it, and open a **draft** pull request — without
stopping between phases. The value is a clean hand-off: the user gives you a ticket or a
bug and gets back a reviewable draft PR, not a pile of half-finished steps.

**You orchestrate; you do not re-implement.** Each phase defers to its command — Claude
Code's `/goal` for planning, then the ystack skills (`/build`, `/go`, `/qa`, `/review`,
`/docs`, `/pr`). Follow each one's own spec — `/yolo` only chains them and keeps moving.

**Proceed autonomously.** Don't ask for confirmation between phases. Surface only the
decisions that genuinely need a human (see Guardrails). When you finish, stop at the draft
PR and summarize.

## When NOT to use

- The user wants **only a plan** → use `/goal` or `/build` and stop.
- The change is a **trivial fix / chore** (typo, bump, config) → use `/quick`.
- The user wants to **address reviewer comments** on an existing PR → use `/address-review`.

---

## Phase 1 — Investigate (evidence-first)

Establish the real requirement and root cause before touching code. First-pass
misdiagnosis is the most common way an autonomous run goes wrong.

1. **If given a ticket reference**, pull it first (e.g. the project's issue tracker / MCP)
   for the actual requirements — don't work from the one-line summary.
2. **Reproduce** the bug or pin down the feature's scope.
3. **Trace it through the code**: confirm the true handler, data path, and boundary.
   Don't guess the event, column, or function — verify against the code and git history.
4. Keep all investigation **read-only** (read-only DB queries, `git log`/`git blame`). No
   writes until the plan exists.

## Phase 2 — Plan (`/goal` → `/build`)

Lead with Claude Code's `/goal` to capture the goal, the approach, and the trade-offs,
then run ystack's `/build` to turn it into a module-scoped plan. `/build` writes
`.context/<feature>/PLAN.md` and `DECISIONS.md` with goal-backward success criteria and
an explicit **no-over-engineering** stance (inline vs. helper, where the source of truth
lives).

Proceed once the plan is written. Pause and ask **only** if the design is genuinely
ambiguous (two reasonable architectures with materially different blast radius).

## Phase 3 — Build (`/go`)

Run `/go`. Implement the plan as **atomic, scoped commits**, one per task. Follow the
plan; if reality deviates, follow `/go`'s deviation rules rather than silently changing
the approach.

## Phase 4 — Verify (`/qa`)

Run `/qa`. Execute the repo's real CI commands (typecheck / lint / tests, as `/qa`
detects them) and any plan-driven checks, then fix anything the change introduced until
the suite is **green**. This gate is non-negotiable: never carry a red or unknown test
state into the next phase. A green-looking phase hiding a broken test is exactly the
failure to prevent.

## Phase 5 — Self-review (`/review`)

Run `/review` on your own diff. Address real P0/P1 findings, verified against the code —
don't invent findings to look thorough, and don't wave away a real one. Re-verify after
any fix.

## Phase 6 — Docs (`/docs`)

Run `/docs`. Update every doc page affected by the **completed** work so docs and reality
stay aligned. Never document planned or in-progress work — ystack's hard rule.

## Phase 7 — PR (`/pr`, draft)

Run `/pr`. Open a **draft** PR off a feature branch targeting the repo's default branch
(resolved dynamically, e.g. `git symbolic-ref refs/remotes/origin/HEAD`). If the user
passed `--base <branch>` to `/yolo`, forward it as `/pr --base <branch>` so the PR targets
that branch instead (e.g. `--base staging`). Write a clear English title (Conventional
Commits) and body (summary, changes, verification, test plan), and proactively answer the
review questions you can predict.

## Phase 8 — Hand back

Stop. Summarize what shipped — feature, commits, files changed, verification status, PR
URL — and surface only the decisions that still need a human.

---

## Guardrails

- **Branch off and target the default branch** (or the `--base <branch>` you were given).
  Never commit to or push the base / release branch directly. `/yolo` ends at a **draft**
  PR — never a merge.
- **Atomic commits**, scoped per task.
- **Never mark a phase done with failing tests or typecheck.** The `/qa` gate is hard.
- **Read-only data access** unless the user explicitly authorizes writes.
- **Hand back on credentialed or external actions** — payment/billing, production data,
  deploys, anything needing secrets you don't have. Don't try to power through an
  auth/env failure; report it and stop. That's where autonomous runs stall.
- **Stop and ask before anything destructive or outward-facing** beyond opening the draft
  PR itself.

## What This Skill Does NOT Do

- **Does not invent its own planning, build, QA, review, doc, or PR logic** — it runs the
  existing skills and follows their specs.
- **Does not merge or publish.** Only opens a draft PR; merging is a human decision.
- **Does not force-push**, and does not touch the default or a release branch.
- **Does not replace `/quick`** for trivial changes or `/address-review` for reviewer
  feedback.
