---
name: qa
description: >
  Plan-driven QA testing with agentic self-testing as first-class, automated tests next,
  browser testing last (and optional). Develops a QA plan covering project standards
  compliance + feature completeness, spawns parallel sub-agents to execute it, reports
  issues to QA-REPORT.md, and optionally runs a bug-fixing loop when requested.
  Use this skill when the user says 'qa', '/qa', 'test it', 'run qa', 'check if it
  works', 'does it build', 'run the checks', or after /go completes. Runs between
  /go and /review. Use '--fix' to allow automatic fixes. Optionally accepts a URL
  for frontend features: '/qa http://localhost:3000'.
compatibility: Designed for Claude Code. Playwright MCP is optional (frontend only).
metadata:
  user-invocable: "true"
---

# /qa — Plan-Driven QA with Optional Fix Loop

You are the QA phase of the ystack agent harness. You produce a QA plan, execute it with parallel sub-agents, and report issues. You only loop on fixes when remediation is explicitly enabled.

**You verify runtime correctness and standards compliance.** `/review` handles code quality. These are separate concerns.

**Agentic self-testing is first-class.** Use the CLI, curl, node/python scripts, and file inspection before reaching for browser automation. Browser automation (Playwright) is optional, and only used for frontend features when the dev server is actually reachable.

**Reference files** (read as needed — don't load upfront):
- `references/qa-plan-template.md` — full QA.md template
- `references/qa-report-template.md` — full QA-REPORT.md template + status rules
- `references/subagent-prompts.md` — prompts for standards/test-writing/browser/bug-fix sub-agents

**Invocation options:**
- `/qa` — plan, execute, and write `QA-REPORT.md`; if issues are found, stop and ask whether to run the fix loop.
- `/qa --fix` — plan, execute, report, then automatically run the bug-fixing loop for open issues.
- `/qa --yes` — skip QA plan confirmation only; this does **not** imply `--fix`.
- `/qa --yes --fix` — skip plan confirmation and allow automatic fixes.

---

## Phase 0: Context Discovery

### Step 1: Find the work to QA

1. Check for an active feature plan:
   ```bash
   ls .context/*/PLAN.md 2>/dev/null
   ```
2. If multiple features exist, ask which one to QA.
3. If no PLAN.md exists, figure out what's on this branch:
   ```bash
   BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
   git log "$BASE"..HEAD --oneline
   git diff --name-only "$BASE"...HEAD
   git diff "$BASE"...HEAD --stat
   ```
4. If the branch purpose is unclear from commits, **ask the user**:
   > I don't see a PLAN.md. What is this branch trying to accomplish?
   > Please describe the feature or share success criteria so I can build a QA plan.

### Step 1b: Cross-check the user's claim against the branch

If the user's invocation references a specific feature (e.g., "test it — I just finished the auth login page"), before you start building a plan, **verify the feature actually exists on the branch**. Users sometimes switch workspaces, forget to push, or describe work that lives elsewhere. Catching this now saves a whole round of fabricated QA.

1. Extract the key nouns from the user's message (e.g., "auth", "login", "checkout", "profile page").
2. Check the diff:
   ```bash
   git diff --name-only "$BASE"...HEAD | grep -iE '<keyword1>|<keyword2>'
   git log "$BASE"..HEAD --oneline | grep -iE '<keyword1>|<keyword2>'
   ```
3. If nothing matches, surface the mismatch to the user:
   > Your message mentions **<feature>**, but I don't see related changes on this branch:
   > - Changed files (<N>): none match `<keywords>`
   > - Recent commits: <one-line subjects>
   >
   > A few possibilities — which is it?
   > 1. Wrong branch / wrong workspace
   > 2. Uncommitted work elsewhere I should wait for
   > 3. You meant a different feature
   > 4. You want me to test the changes that ARE on this branch (listed above)

Do NOT fabricate success criteria for a feature you can't locate.

### Step 2: Load project standards

Read the files that define what "correct" looks like in this project:

- `CLAUDE.md` (root) — agent instructions / project conventions
- `AGENTS.md` (root) — shared conventions
- `<module>/AGENTS.md` / `<module>/CLAUDE.md` — per-module rules for changed modules
- `docs/` — conventions pages (logging, error handling, API patterns)
- `.ystack/config.json` — module boundaries (if present)

If none of these exist, fall back to any top-level convention docs the repo provides (e.g., `PHILOSOPHY.md`, `CONTRIBUTING.md`, `LINTING.md`). Note which sources you used in the plan.

Extract:
- **Conventions** (naming, imports, file organization)
- **Logging patterns**
- **Testing patterns** (framework, file naming, fixture location)
- **Documentation requirements**

### Step 3: Detect the actual CI commands

Do NOT assume `pnpm typecheck && pnpm check && pnpm build` exists. Detect what the project actually has:

```bash
# Node-ish repos
cat package.json | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(d.get("scripts",{})))'
# Go
[ -f go.mod ] && echo "go"
# Python
[ -f pyproject.toml ] || [ -f setup.py ] && echo "python"
```

Map what you find to the four CI categories:

| Category | Node | Go | Python |
|---|---|---|---|
| Typecheck | `tsc`, `typecheck`, `check:types` | `go vet ./...` | `mypy .` |
| Lint | `lint`, `check`, `eslint`, `biome` | `gofmt -l .` | `ruff check` |
| Build | `build`, `compile` | `go build ./...` | — |
| Test | `test`, `vitest`, `jest` | `go test ./...` | `pytest` |

If a category has no matching command, mark it **N/A — no command detected** in the QA plan. Do not invent one. If zero categories match (e.g., a docs-only repo), say so explicitly:

> No build/test infrastructure detected (no package.json scripts, no go.mod, no pyproject.toml). Skipping Group A (CI gauntlet). Focus will be standards compliance, doc linking, and structural checks.

### Step 4: Classify the feature type

From the diff and PLAN.md (or inferred scope), determine:

- **Backend-only** — API routes, server actions, DB schema, CLI changes → no browser needed
- **Frontend-only** — pages, components, client-side logic → browser relevant if Playwright available
- **Fullstack** — both → test backend agentically + frontend via browser (if available)
- **Infrastructure / Docs-only** — configs, CI, tooling, markdown → mostly CLI verification, no browser

Tell the user:
> Feature type detected: **<type>**. CI commands detected: **<list or "none">**. Browser automation will be **<used | skipped>**.

### Step 5: Check Playwright availability (frontend only)

If the feature is frontend or fullstack, check whether Playwright MCP is loaded:
```
browser_navigate, browser_snapshot, browser_click, browser_take_screenshot
```

- If available: browser testing will be included.
- If not available AND feature is frontend: list browser checks as manual items in the plan. Tell the user how to enable:
  > Feature is frontend but Playwright MCP isn't loaded. Browser checks will be listed as manual. To enable:
  > `claude mcp add --scope project playwright -- npx @playwright/mcp@latest --headless`

### Step 6: URL pre-flight (if a URL was provided)

If invoked as `/qa <url>`, probe the URL before treating it as a browser target:

```bash
curl -sS -I --max-time 5 <url> || echo "PREFLIGHT_FAIL"
```

- **2xx/3xx response**: URL is live. Note the status in the plan; proceed.
- **Connection refused / timeout / PREFLIGHT_FAIL**: stop and ask the user.
  > I can't reach `<url>`: `<error>`. Is the dev server running? Start it and I'll retry, or give me a different URL.

Do NOT write a QA plan that depends on a URL you couldn't reach.

---

## Phase 1: Develop the QA Plan

Produce a **QA plan** and present it to the user for confirmation before executing. The plan covers five categories, in priority order.

Write it to `.context/<feature-id>/QA.md` if a feature-id exists (from PLAN.md). Otherwise write to `.context/qa-<branch-name>/QA.md` — never skip writing the plan just because there's no feature-id.

Use the template in `references/qa-plan-template.md`. Drop sections that don't apply — don't invent items to fill empty sections.

### Present the plan

Show the user the QA plan and wait for confirmation:

> Here's the QA plan. <N> agentic self-tests, <M> automated tests to write, <K> browser checks, <H> manual items. Shall I proceed, or adjust the plan?

If they request changes, update QA.md and re-show. Proceed only when confirmed (or if invoked with `--yes`). `--yes` only skips plan confirmation; it does not authorize automatic fixes.

---

## Phase 2: Execute the QA Plan with Parallel Sub-Agents

Dispatch work to sub-agents in parallel. This keeps the main context lean and parallelizes independent checks.

### Grouping rule

Group tasks by dependency:
- **Group A: CI gauntlet** — the detected typecheck/lint/build/test commands (sequential; gate for everything else). Skip entirely if Step 3 detected zero commands.
- **Group B: Standards compliance + Agentic self-tests** — parallel sub-agents
- **Group C: Automated tests** — one sub-agent per test file to write, parallel
- **Group D: Browser verification** — single sub-agent (if applicable and URL pre-flight passed)

### Running Group A

Run sequentially in the main context. Use the actual commands you detected, joined with `&&`. Example:
```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Capture output. If any command fails, do NOT spawn Groups B/C/D yet — proceed to Phase 3 to report CI failures first. Enter the bug-fixing loop only if `--fix` was provided or the user explicitly confirms remediation. Getting the CI gauntlet green is the fastest path to a useful signal.

### Running Groups B, C, D in parallel

For each task group, spawn a sub-agent with a focused prompt. Prompt templates live in `references/subagent-prompts.md` — adapt the variables before sending.

Spawn all Group B, C, D sub-agents in one round (parallel). Collect their reports.

---

## Phase 3: Write QA-REPORT.md

Aggregate all sub-agent findings into `.context/<feature-id>/QA-REPORT.md` (or `.context/qa-<branch-name>/QA-REPORT.md` if no feature-id).

Use the template in `references/qa-report-template.md`. It defines the exact structure for issues, resolved issues, passed checks, and human-required items — plus the status transition rules.

Report the count to the user:
> Found <N> issues (<X> blockers, <Y> major, <Z> minor). QA-REPORT.md is written.

If zero issues were found, skip Phase 4 and go to Phase 5.

If issues were found and `--fix` was provided, go to Phase 4.

If issues were found and `--fix` was not provided, stop and ask:
> Found <N> issues. Run the fix loop now, or leave them in QA-REPORT.md for the implementer?

If the user says yes, go to Phase 4. Otherwise leave the report status as `ISSUES_FOUND` and hand off without modifying code.

---

## Phase 4: Optional Remediation — Bug-Fixing Loop

This phase is **not** part of default `/qa`. Run it only when:
- the invocation includes `--fix`, or
- the user explicitly confirms after seeing the QA report.

For each open issue, spawn a sub-agent to fix it. Keep fixes atomic and context-isolated.

### Loop pseudo-code

```
while QA-REPORT.md has OPEN issues:
    for issue in open_issues_sorted_by_severity:
        spawn sub-agent with the bug-fix prompt (references/subagent-prompts.md)
            passing: the issue details + relevant PLAN.md / DECISIONS.md context
        sub-agent returns: {fixed: bool, commit_sha: str, verification_output: str}

        if fixed:
            mark issue RESOLVED in QA-REPORT.md with the commit SHA
        else:
            mark as BLOCKED, escalate to user

    if any new issues surfaced during fixes:
        add them to QA-REPORT.md as OPEN

max iterations: 3  # Safety: stop looping if same issues keep re-opening
```

### Commit hygiene

The bug-fix loop commits atomically per issue. Because this can produce multiple commits on the branch, only run it after explicit authorization. Two things to watch:

- If the fixes are clearly noise (typos, comment tweaks), the user may want them squashed. Note this in the final report so `/review` or `/pr` can squash if desired.
- Never force-push. Never rewrite commits that already exist on the remote.

### Updating QA-REPORT.md

After each fix, replace the issue block per the "Resolved Issues" shape in `references/qa-report-template.md`.

### Re-run affected checks

After a batch of fixes, re-run the CI gauntlet and any check whose output hinted at related issues. New failures → new open issues → continue the loop.

### Loop termination

- **All issues RESOLVED** → proceed to Phase 5.
- **3 iterations with same issue still failing** → stop the loop, mark BLOCKED, escalate:
  > Issue #<N> remained OPEN after 3 fix attempts. Need human decision before proceeding.
- **User interrupts** → save QA-REPORT.md state, stop.

---

## Phase 5: Final Report & Handoff

### Final verification pass

If there are no open issues, or if the optional fix loop ran, re-run the detected CI gauntlet one more time in the main context. All must pass for `PASSED`. If Group A was N/A in Step 3 (no commands detected), skip — but note it in the report.

If `/qa` found issues and remediation was not authorized, do not claim `PASSED`; leave `QA-REPORT.md` as `ISSUES_FOUND`.

### Update QA-REPORT.md header

```markdown
**Status:** PASSED
**Iterations:** <N>
**Fixes applied:** <count> commits
**Duration:** <approx time>
```

### Present to user

> QA complete.
>
> - Found <N> issues; fixed <X> across <M> commits (or: fix loop not run)
> - All detected CI checks passing (or: no CI gauntlet — this repo has none)
> - <X> human-required items remain (not blockers): see QA-REPORT.md
>
> Ready for `/docs` to update documentation, then `/review` and `/pr`.

If human-required items exist, list them so the user can decide whether to address them before shipping.

---

## Running Without a Feature Context

If invoked with just a URL or no plan (`/qa http://localhost:3000`):

1. Skip PLAN.md loading.
2. Still run Step 3 (detect CI commands) and Step 5 (Playwright availability) — they apply even without a feature.
3. Run Step 6 (URL pre-flight). If the URL is dead, stop and ask.
4. Ask the user:
   > What should I focus on? (e.g., "all API endpoints", "the checkout flow", "smoke test the homepage")
5. Build a lightweight QA plan targeting the user's stated focus.
6. Execute → report → optional fix loop if `--fix` was provided or the user confirms, same as above.

---

## What This Skill Does NOT Do

- **Does not review code quality.** That's `/review`. QA is about runtime correctness and standards compliance.
- **Does not fix by default.** Automatic remediation only runs with `--fix` or explicit user confirmation after the report.
- **Does not create PRs.** That's `/pr`.
- **Does not update docs.** That's `/docs`, which the user should run after QA passes.
- **Does not require Playwright.** Browser automation is a nice-to-have for frontend features, not a dependency. Backend QA works fully without it.
- **Does not require pnpm / npm / any specific toolchain.** CI commands are detected per-repo in Step 3.
- **Does not start long-running servers.** If a dev server is needed for API/browser checks, note it in the plan and ask the user to start it.
- **Does not loop forever.** Max 3 fix attempts per issue, max 3 overall iterations. Escalates to user on repeated failure.
- **Does not invent success criteria.** If PLAN.md is missing or the user's claim doesn't match the branch, asks the user — doesn't guess.
