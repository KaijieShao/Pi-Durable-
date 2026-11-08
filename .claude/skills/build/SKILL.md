---
name: build
description: >
  Plan a feature by reading documentation and code, surfacing assumptions, capturing
  decisions, and creating an execution plan with goal-backward success criteria. Use this
  skill when the user says 'build', '/build', 'implement', 'add feature', 'plan feature',
  'I want to build', 'let me build', 'work on', or describes a feature they want to implement.
  This is the entry point for the ystack workflow — it produces a PLAN.md that /go executes,
  plus a local plan.html preview for user approval.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /build — Plan a Feature

You are the planning phase of the ystack agent harness. Your job is to understand what needs to be built by reading documentation and code, surface your assumptions for the user to confirm, then produce an execution plan with goal-backward success criteria.

**You do NOT write code.** You produce a plan that `/go` will execute, and a generated HTML preview that helps the user review it.

## Phase 0: Locate the Module

Identify which module(s) this feature belongs to. **Do not skip this phase** — module detection drives everything downstream. `/go` edits files inside the matched module's package; `/qa` runs tests scoped to it. Guessing the module silently causes plans to target wrong files, and the mistake only surfaces after code is written.

1. **Always check for `.ystack/config.json` first.** This is the module registry — if it exists, it's the source of truth for module → scope glob mapping:
   ```bash
   test -f .ystack/config.json && cat .ystack/config.json || echo "MISSING: .ystack/config.json"
   ```
   - **If present:** match the feature to a module by checking `scope` globs. In your response, state the match explicitly: *"Matched to module **<name>** via glob `<pattern>` in `.ystack/config.json`."*
   - **If absent or no glob matches:** say so out loud — *"No `.ystack/config.json` match; falling back to docs navigation."* — then proceed to step 2.

2. If no config exists or no match found, scan the docs directory structure:
   ```bash
   # Find docs root — check common locations
   # Nextra: docs/src/content/
   # Fumadocs: content/docs/
   ls docs/src/content/_meta.ts 2>/dev/null || ls content/docs/meta.json 2>/dev/null || ls docs/_meta.ts 2>/dev/null
   ```

3. Read the navigation config to understand what modules exist:
   - Nextra: `_meta.ts` files (object keys = sidebar order)
   - Fumadocs: `meta.json` files or frontmatter-based ordering

4. Match the user's feature description to a module. If ambiguous, ask:
   > This could belong to **Payments** or **Managed Ads**. Which module should this feature live in?

5. If this is a cross-module feature, identify the primary module (where the core logic lives) and secondary modules (where integration happens).

## Phase 1: Read the Spec

Read the module's documentation page to understand the current design.

1. **Read the module overview** — the `index.mdx` file for the matched module:
   ```
   docs/src/content/<module>/index.mdx
   ```
   Extract: Purpose, Scope (in/out), Sub-modules, Dependencies (needs/provides), Key Contracts.

2. **Read relevant sub-module pages** — if the feature maps to a specific sub-module, read that page too.

3. **Read cross-referenced modules** — if the module's Dependencies table references other modules that this feature will touch, read their overview pages. Follow the cross-reference links in the docs.

4. **Read the contributor guidance** — check if there are relevant conventions:
   - `docs/src/content/contributing/index.mdx` for golden rules
   - Module-specific conventions if they exist

**Important:** Read the actual files. Do not guess what docs contain based on file names. The docs are the spec — they tell you what the system IS.

## Phase 2: Read the Code

Read the relevant source code to understand the current implementation.

1. **Identify code packages** from the module registry or `CLAUDE.md` Structure section.

2. **Read the package's `AGENTS.md`** (or `CLAUDE.md` if it exists) in the module's code directory. This gives you quick orientation — key files, conventions, and patterns specific to that package. If it doesn't exist, proceed without it.

3. **Read key files** — focus on:
   - Schema files (database tables, types)
   - API routes (endpoints, request/response shapes)
   - Public interfaces (exported functions, tool definitions)
   - Existing tests (what's already tested)

4. **Do NOT read everything.** Read only what's relevant to the feature. Use the docs to guide which code matters — if the docs say "Payments uses Stripe Customer Balance", read the Stripe integration code, not the entire payments package.

## Phase 3: Surface Assumptions

Present your understanding of how to build this feature. Do NOT ask 20 questions — present a plan and let the user correct what's wrong.

Format your assumptions as:

```
Based on the docs and code, here's how I'd approach this:

1. [First concrete step with specific files/tables/endpoints]
2. [Second step]
3. [Third step]

**Assumptions:**
- [Specific technical assumption — e.g., "Column goes on the `transactions` table, not a new table"]
- [Design assumption — e.g., "Enum values: duplicate, fraud, requested, other"]
- [Scope assumption — e.g., "Admin detail view only, not the list view"]

**Out of scope** (deferring these):
- [Thing that's related but not part of this feature]

Correct anything that's wrong, or confirm to proceed.
```

**Rules for assumptions:**
- Be specific, not vague. "Add a column to the transactions table" not "update the database".
- Reference actual file paths from the code you read.
- Reference actual doc sections that inform your approach.
- If the docs explicitly define a contract or scope boundary, follow it — don't assume differently.
- If something is listed as "Out of Scope" in the module docs, it's out of scope for this feature too.

**Wait for the user to confirm or correct before proceeding to Phase 4.**

## Phase 4: Capture Decisions

After the user confirms (or corrects) your assumptions, write the decisions file.

Create the directory and file:
```
.context/<feature-id>/DECISIONS.md
```

Use a short, descriptive ID for the feature (e.g., `refund-reason`, `oauth-support`, `dashboard-charts`).

**DECISIONS.md format:**

```markdown
# Decisions: <Feature Name>

## Module
<primary module> (+ secondary modules if cross-module)

## Locked
- [Decision 1 — specific, actionable]
- [Decision 2]
- [Decision 3]

## Claude's Discretion
- [Things the agent can decide — naming, file organization, minor implementation details]

## Deferred
- [Related work explicitly not part of this feature]

## References
- [Doc page read: docs/src/content/<module>/index.mdx]
- [Doc page read: docs/src/content/<module>/<sub>.mdx]
- [Code read: packages/<module>/src/<file>.ts]
```

## Phase 5: Create the Plan

Write an execution plan with goal-backward success criteria.

Create:
```
.context/<feature-id>/PLAN.md
```

**PLAN.md format:**

```markdown
# Plan: <Feature Name>

## Success Criteria

What must be TRUE in the codebase when this feature is done. Each criterion is independently verifiable — a grep, a typecheck, a file existence check, or a test run.

- [ ] [Criterion 1 — specific and checkable, e.g., "`refundReason` column exists on `transactions` table"]
- [ ] [Criterion 2 — e.g., "POST /api/payments/refund accepts `reason` field and validates with Zod"]
- [ ] [Criterion 3 — e.g., "Admin transaction detail page renders `RefundReasonBadge` component"]
- [ ] [Criterion 4 — e.g., "Types exported from `@acme/shared`"]

## Tasks

### task-1: <Short description>
**Files:** [list of files to read and modify]
**Do:** [What to implement — specific enough that a fresh agent with no prior context can do it]
**Verify:** [How to check this task is done — e.g., "pnpm typecheck passes", "column exists in schema"]

### task-2: <Short description>
**Files:** [list of files]
**Do:** [What to implement]
**Verify:** [How to check]
**Depends on:** task-1

### task-3: <Short description>
**Files:** [list of files]
**Do:** [What to implement]
**Verify:** [How to check]
**Depends on:** task-1, task-2
```

**Rules for plans:**

1. **Tasks describe intent, not implementation.** A plan is not a diff. Describe *what* to build in prose; let `/go` figure out *how*. This isn't stylistic — pre-writing code in the plan wastes tokens, can drift from actual conventions (wrong import paths, outdated APIs), and makes the executor second-guess whether to follow your snippet or write fresh.

   **Good** (`Do:` fields):
   - "Add a `refundReason` enum column to the `transactions` table. Values: duplicate, fraud, requested, other. Follow existing enum patterns in `packages/db/src/schema.ts`."
   - "Extend `POST /api/payments/refund` to accept an optional `reason` field, validated as one of the enum values. Return 400 if invalid."

   **Bad** (don't do this):
   - Code fences (```` ```ts ````), function bodies, SQL, schema DSL, import statements
   - Type definitions written out (reference existing types by name instead)
   - Config file contents

   OK to include: file paths, function/type/table names as references, enum values as data, commands to run for verification.

2. **2-4 tasks.** If you need more, the feature should be split. Each task must fit in a fresh agent context.

3. **File targets are explicit.** Every task lists exactly which files to read and modify. A fresh agent with no prior context should know exactly where to look.

4. **Verification is concrete.** Not "verify it works" — rather "run `pnpm typecheck` and confirm no errors" or "grep for `refundReason` in `schema.ts`".

5. **Dependencies are explicit.** If task-3 needs types from task-1, say so. Tasks without dependencies can run in parallel.

6. **No scope reduction.** Every locked decision from DECISIONS.md must be covered by at least one task. If a decision can't be delivered, STOP and tell the user — don't silently simplify.

7. **Each task produces a commit.** The task description should correspond to a single atomic commit. "Add column and update 3 API endpoints and redesign the UI" is too big.

8. **Reference the docs.** If a task implements something described in the docs (a contract, a data model, an API shape), reference the doc page so the executor can read it.

## Phase 6: Create the Plan Preview

Create a local HTML preview for user approval:
```
.context/<feature-id>/plan.html
```

This page is a generated view of `DECISIONS.md` and `PLAN.md`. It is not canonical, and `/go` must still execute from `PLAN.md`.

**Preview generation workflow:**

1. Read [references/plan-preview-style.md](references/plan-preview-style.md).

2. **Copy the template first, then `Edit` placeholders in place — do not write the file end-to-end.** The template skeleton (CSS, layout, tab script — ~600 lines of static markup) costs zero output tokens this way; only substituted content does. Concretely:

   ```bash
   cp skills/build/templates/plan-preview.html .context/<feature-id>/plan.html
   ```

   Then `Read` the copy once (required before `Edit`), then issue one `Edit` call per `{{...}}` placeholder. Using the `Write` tool to emit the entire HTML end-to-end is explicitly disallowed because it duplicates the static skeleton on every plan.

3. Required placeholders the generator must populate:
   - `{{FEATURE_TITLE}}` — escaped plain text title (also appears inside the `<title>` tag, prefixed with `ystack · /build preview · `)
   - `{{FEATURE_SUMMARY}}` — escaped plain text summary
   - `{{APPROVAL_STATE}}` — usually `Awaiting Approval`
   - `{{SUMMARY_CHIPS}}` — the always-visible chip strip directly under the header. Must include count chips (success criteria, tasks) and one chip per applicable impact category (e.g., `Migrations`, `Critical Changes`). Omit impact chips when no impact category applies. Use existing tokens; no new colors or icons.
   - `{{CONTEXT_SECTION}}` — rendered `Context` HTML section
   - `{{DECISIONS_AND_CRITERIA_SECTION}}` — rendered HTML section
   - `{{IMPACT_SECTIONS}}` — zero or more rendered impact sections, or empty string when none apply
   - `{{TASKS_SECTION}}` — rendered HTML section
   - `{{FOOTER_NOTE}}` — must be prefixed with `Generated by the ystack /build skill.` followed by the per-feature note
   - `{{DECISIONS_MARKDOWN_HTML}}` — rendered Markdown from `DECISIONS.md`
   - `{{PLAN_MARKDOWN_HTML}}` — rendered Markdown from `PLAN.md`

4. Render the `DECISIONS.md` and `PLAN.md` tabs as read-only rendered Markdown. Because the preview is opened as a local file, do not use browser-side `fetch()` to import sibling Markdown files. Convert the exact generated Markdown contents to safe HTML at generation time and inline the rendered output into the preview.

5. Populate the `Visual Review` tab using the template's section structure:
   - Context
   - Decisions + Success Criteria
   - Impact Review, only when at least one impact category applies
   - Tasks

6. Do not generate a separate top-level flow strip, table of contents, stepper, or duplicated row that summarizes `Context → Decisions → Criteria → Tasks`.

7. If the preview reveals a missing decision, criterion, task, migration, environment variable, or docs update, update `DECISIONS.md` or `PLAN.md` first, then re-run the copy + `Edit` workflow on `plan.html`.

## Phase 7: Plan Check

Before presenting the plan to the user, self-check. The five checks below are the fast-path version; for the full coverage-table format and extended scope-reduction heuristics, see [references/plan-checker.md](references/plan-checker.md).

1. **Coverage check:** Read DECISIONS.md. For each locked decision, confirm at least one task delivers it. If any decision is uncovered, add a task or flag the gap.

2. **Scope reduction check:** Re-read your plan. Are you delivering exactly what was decided, or a simplified version? Look for red flags:
   - "Simplified version" / "basic implementation" / "v1" / "placeholder"
   - Missing a decision from the locked list
   - A task that says "will be wired later" or "can be added in a follow-up"
   If any of these appear, revise the plan or split into phases.

3. **Size check:** Each task should touch 1-5 files. If a task lists more than 5 files, split it.

4. **Fresh agent test:** For each task, ask: "Could a fresh agent with no conversation history execute this task from the description alone?" If not, add more detail to the task description.

5. **Code leak check:** Scan every task's `Do:` field for code fences (```` ``` ````), function bodies, SQL, or import statements. If found, rewrite as prose — describe the change, don't pre-write it. The executor reads the actual codebase for patterns; a snippet in the plan either duplicates that or contradicts it.

6. **Preview check:** Run [references/plan-preview-checklist.md](references/plan-preview-checklist.md), then open `.context/<feature-id>/plan.html` locally and confirm the preview renders the same decisions, success criteria, impact review, and tasks as the Markdown files.

## Phase 8: Open the Preview and Present the Plan

After `DECISIONS.md`, `PLAN.md`, and `plan.html` are written and the plan check passes, open the preview for the user:

```bash
open "$(pwd)/.context/<feature-id>/plan.html"
```

If `open` is unavailable, print the absolute path to `.context/<feature-id>/plan.html` so the user can open it from the workspace.

Show the user:

1. The success criteria (what will be TRUE when done)
2. The task breakdown (what each task does, in what order)
3. Impact review items that require attention, if any
4. Total number of tasks and estimated commits
5. The path to `.context/<feature-id>/plan.html`

Ask:
> Plan ready. I opened `.context/<feature-id>/plan.html` for review. Confirm to proceed, or let me know what to adjust.

**Small task detection:** If the plan has only 1 task touching 3 or fewer files, offer:
> This is a small change. Want me to just do it now? (Skips /go, executes inline.)

If the user confirms inline execution, execute the single task directly — make the changes, run the verification step, and commit. No need for `/go`.

---

## What This Skill Does NOT Do

- **Does not write code.** That's `/go`.
- **Does not create PRs.** That's `/pr`.
- **Does not update docs.** That's `/docs`.
- **Does not run without user confirmation.** The plan is always presented for approval.
- **Does not invent architecture.** It reads docs and code to understand what exists, then plans within those boundaries.
