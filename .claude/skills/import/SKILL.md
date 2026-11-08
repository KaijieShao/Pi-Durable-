---
name: import
description: >
  Analyze an existing codebase and generate a ystack module registry, progress files,
  and a documentation gap report. Use this skill when the user says 'import', '/import',
  'adopt this project', 'onboard this repo', 'scan the codebase', 'set up ystack here',
  or when adding ystack to a project that already has code and possibly docs.
  Supports incremental adoption with --module flag.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /import — Adopt an Existing Project

You analyze an existing codebase and produce a module registry, progress files, and a gap report. This is the on-ramp for projects that already have code.

**You do NOT modify code or docs.** You produce a registry and report. The user decides what to act on.

## Phase 0: Determine Scope

1. Check if `.ystack/config.json` already exists:
   ```bash
   cat .ystack/config.json 2>/dev/null
   ```

2. If a `--module <name>` argument was provided, scope the import to that module only. Otherwise, scan the entire repo.

3. If the config already has modules registered, note which are new vs. already known.

4. Identify the project root — store it as `$PROJECT_ROOT` for the scan agents.

## Phase 1: Scan the Codebase (parallel subagents)

**You MUST use the Agent tool to run these 4 scans in parallel.** Launch all 4 agents in a single message so they execute concurrently. Each agent writes its findings to a file in `.context/import/` so results survive context limits.

Before launching agents, create the output directory:
```bash
mkdir -p .context/import
```

### Launch 4 agents in parallel

Use the Agent tool with `subagent_type: "Explore"` for each. Include the project root path in every agent prompt so they know where to look.

---

**Agent 1 — "structure-scan"**

Prompt the agent with:

> Scan the codebase at `$PROJECT_ROOT` and write findings to `$PROJECT_ROOT/.context/import/scan-structure.md`.
>
> Your job: map the directory tree and identify module boundaries.
>
> 1. Find all package.json files (exclude node_modules), up to depth 3
> 2. List directories under apps/, packages/, src/modules/, src/features/ if they exist
> 3. Check for monorepo config: turbo.json, pnpm-workspace.yaml, lerna.json, nx.json
> 4. Read the root package.json for project name and workspace config
>
> Classify each directory:
> - `apps/*` → app module (UI, server, API)
> - `packages/*` → library package
> - `src/modules/*` or `src/features/*` → feature-based structure
> - Top-level `src/` without sub-packages → single-module project
>
> Write your output as a structured markdown file with:
> - Project name
> - Monorepo tool (if any)
> - A table of directories with: path, type (app/package/feature/single), and a one-line description based on its package.json name/description or directory name
>
> Do NOT modify any files other than the output file.

---

**Agent 2 — "dependency-scan"**

Prompt the agent with:

> Scan the codebase at `$PROJECT_ROOT` and write findings to `$PROJECT_ROOT/.context/import/scan-dependencies.md`.
>
> Your job: map imports and dependencies between packages to build a dependency graph.
>
> 1. For each package.json in apps/ and packages/, extract:
>    - Package name
>    - Dependencies and devDependencies that reference workspace packages (look for `workspace:` protocol or `@<org>/` packages that match other packages in the repo)
> 2. Search for cross-package imports in .ts/.tsx/.js/.jsx files:
>    - `from '@<org>/...'` or `from '<package-name>'` patterns that reference sibling packages
>    - Focus on the import sources, not every file — just which packages import from which
> 3. Identify shared/foundational packages that many others depend on
>
> Write your output as a structured markdown file with:
> - A dependency table: package → depends on [list]
> - A "most depended on" ranking
> - Any circular dependency warnings
>
> Do NOT modify any files other than the output file.

---

**Agent 3 — "schema-scan"**

Prompt the agent with:

> Scan the codebase at `$PROJECT_ROOT` and write findings to `$PROJECT_ROOT/.context/import/scan-schemas.md`.
>
> Your job: identify data models, API routes, and type definitions.
>
> 1. Database schemas — find files matching: `**/schema*.ts`, `**/models/**`, `**/entities/**`, `**/prisma/schema.prisma`, `**/drizzle/**`
> 2. Migrations — find directories matching: `**/migrations/**`
> 3. API routes — find files in: `**/routes/**`, `**/api/**`, `**/app/api/**` (Next.js app router)
> 4. Shared types — find files in: `**/types/**`, `**/*.types.ts`, `**/*.d.ts` (exclude node_modules)
> 5. For each schema/model file found, briefly note what entities/tables it defines (read the file to extract type/interface/table names)
> 6. For each API route directory, list the route files and their HTTP methods if detectable
>
> Write your output as a structured markdown file with:
> - Data models section: file path → entities defined
> - API routes section: route path → methods
> - Shared types section: file path → key types exported
>
> Do NOT modify any files other than the output file.

---

**Agent 4 — "docs-scan"**

Prompt the agent with:

> Scan the codebase at `$PROJECT_ROOT` and write findings to `$PROJECT_ROOT/.context/import/scan-docs.md`.
>
> Your job: find existing documentation and map it to code modules.
>
> 1. Check for doc frameworks:
>    - Nextra: look for `docs/src/content/_meta.ts` or `docs/_meta.ts`
>    - Fumadocs: look for `content/docs/meta.json`
>    - Docusaurus: look for `docs/` with `docusaurus.config.*`
>    - Mintlify: look for `mint.json`
>    - Generic: look for `docs/`, `README.md`, `CLAUDE.md`, `AGENTS.md`
> 2. If a doc framework is found, read the navigation config (`_meta.ts`, `meta.json`, `mint.json`, `sidebars.*`) to understand the doc site structure
> 3. List all .md and .mdx files in the docs directory
> 4. For each doc section/page, note:
>    - The page path (relative to docs root)
>    - The page title (from frontmatter or first heading)
>    - Which code module it likely corresponds to (by name matching)
> 5. Read CLAUDE.md and AGENTS.md if they exist — extract any project context
>
> Write your output as a structured markdown file with:
> - Docs framework detected
> - Docs root path
> - Navigation structure (sections and pages)
> - A table mapping: doc page → likely code module
> - Any project context from CLAUDE.md/AGENTS.md
>
> Do NOT modify any files other than the output file.

---

### Collect scan results

After all 4 agents complete, read their output files:

```
.context/import/scan-structure.md
.context/import/scan-dependencies.md
.context/import/scan-schemas.md
.context/import/scan-docs.md
```

If `--module <name>` was specified, you may skip agents whose scope doesn't overlap with the target module, but generally it's better to run all 4 and filter in Phase 2.

## Phase 2: Detect Modules

Using the collected scan results from `.context/import/`, group findings into logical modules.

### Grouping rules

1. **Monorepo packages** — each `apps/` and `packages/` directory is a candidate module.

2. **Cross-cutting modules** — some modules span multiple packages. Look for:
   - A package that has schema files in `packages/db/` AND routes in `apps/api/` AND UI in `apps/admin/` → likely one module with scope across all three
   - Shared types that are consumed by multiple packages → the types belong to whichever module defines the domain

3. **Feature modules within a package** — a large package might contain multiple modules:
   - `packages/core/src/features/onboarding/index.ts` → could be its own sub-module
   - Only split if the docs site treats it as a separate section

4. **Infrastructure vs. domain** — separate infrastructure (db, shared, tsconfig) from domain modules (payments, auth, dashboard). Infrastructure packages are usually not their own modules unless the docs site documents them.

### Module detection output

For each detected module, determine:
- **Name** — human-readable identifier
- **Scope** — glob patterns for files that belong to this module
- **Doc page** — matching docs path (if docs exist) or `null`
- **Status** — `implemented` (has code), `documented` (has docs), `both`, or `gap`
- **Features** — key files/exports that represent implemented features
- **Dependencies** — other modules this one imports from

### Present findings

```
## Detected Modules (8)

| Module | Scope | Docs | Status |
|--------|-------|------|--------|
| payments | packages/payments/**, apps/api/src/routes/payments.* | shared/payments | both |
| auth | packages/shared/src/auth/**, apps/api/src/routes/auth.* | shared/authentication | both |
| dashboard | apps/dashboard/** | dashboard | both |
| admin | apps/admin/** | admin-dashboard | docs only (stub) |
| notifications | packages/notifications/** | notifications | both |
| billing | packages/billing/** | billing | code only (no docs) |
| db | packages/db/** | (infrastructure) | — |
| shared | packages/shared/** | shared | partial |

Connections:
  payments → db, shared
  dashboard → payments, billing, notifications, db
  admin → payments, dashboard, billing
  ...

Does this look right? I'll generate the registry from this.
```

**Wait for user confirmation.** The user may want to merge, split, or rename modules.

## Phase 3: Generate Module Registry

Create or update `.ystack/config.json`:

```json
{
  "project": "<detected-project-name>",
  "docs": {
    "root": "<detected-docs-root>",
    "framework": "<nextra|fumadocs|unknown>"
  },
  "modules": {
    "payments": {
      "doc": "shared/payments",
      "scope": [
        "packages/payments/**",
        "packages/db/src/schema/transactions.*",
        "apps/api/src/routes/payments.*"
      ]
    }
  }
}
```

For each module:
- `doc` — the matching docs path, or `null` if no docs exist
- `scope` — glob patterns covering all files that belong to this module

If the config already exists, merge new modules — don't overwrite existing entries.

## Phase 4: Create Progress Files

Create a progress file per module in `.ystack/progress/`:

For each module, write `.ystack/progress/<module-slug>.md`:

```markdown
# <Module Name>

## Features
- [x] <Implemented Feature 1>    → <doc-path>#<anchor>
- [x] <Implemented Feature 2>    → <doc-path>#<anchor>
- [?] <Feature with code but no docs>  → (needs docs)
      ⚠️ Code exists but no doc section found
- [ ] <Planned Feature>          → <doc-path>#<anchor>

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
```

For already-implemented features, mark as `[x]`.
For features with code but missing docs, mark as `[?]` with a warning annotation.
For planned features (docs exist but no code), mark as `[ ]`.

Create `.ystack/progress/_overview.md`:

```markdown
# Project Progress

## Module Status

| Module | Done | Total | Gaps | Status |
|--------|------|-------|------|--------|
| payments | 5 | 5 | 0 | complete |
| auth | 2 | 4 | 1 | in progress |
| admin | 4 | 5 | 1 | in progress |

## Dependencies

auth → db
payments → auth, db
admin → payments, auth

## Ready Front

- auth/oauth (sessions complete, ready to build)
- admin/team-settings (no dependencies)

## Documentation Gaps

- auth/oauth: code exists, no doc section
- admin/team-settings: code exists, no doc section
```

## Phase 5: Generate Gap Report

Analyze the delta between code and docs:

```markdown
## Import Report

### Project: <name>
### Modules: N detected, M documented

---

### Fully Documented (N)
- payments — docs match implementation
- auth — docs match implementation

### Code Without Docs (N)
- billing — 5 features implemented, no doc pages
  - Invoice generation
  - Subscription management
  - Usage metering
  - Refund processing
  - Payment method CRUD

### Docs Without Code (N)
- admin/analytics — doc page exists but feature not implemented

### Stale Docs (N)
- shared/storage — docs reference old S3 API, code uses R2 SDK
  Evidence: docs mention `@aws-sdk/client-s3`, code imports `@acme/shared/storage`

### Missing Cross-References (N)
- dashboard/index.mdx mentions "Payments" but doesn't link to /shared/payments
- billing has no doc page, so nothing can link to it

---

### Recommended Next Steps
1. Run `/scaffold` or `/docs` to create docs for billing (5 undocumented features)
2. Update shared/storage docs (stale — S3 → R2 migration)
3. Add cross-reference links in dashboard/index.mdx
4. `/build` for any new features — the registry is ready
```

### Stale docs detection

Compare code and docs for inconsistencies:
- **Imports in docs vs. code** — do docs reference packages the code no longer uses?
- **API routes** — do docs describe endpoints that don't exist (or miss ones that do)?
- **Schema fields** — do data model tables in docs match actual schema files?
- **Module names** — do docs use old names for renamed modules?

Only flag clear mismatches. Don't flag vague prose that's technically correct.

## Phase 6: Summary

```
## Import Complete

### Registry
  .ystack/config.json — N modules registered

### Progress
  N progress files created, M features tracked (K checked as implemented)

### Documentation
  N pages found, M gaps detected

### Next Steps
  - Fix N doc gaps with /docs or /scaffold
  - Run /build to start new feature work
  - The module registry connects code ↔ docs ↔ progress
```

---

## Incremental Adoption

With `--module <name>`:

1. Only scan files matching the specified module name or path
2. Only create one module entry in the registry
3. Only create one progress file
4. Gap report scoped to that module

This is useful for large repos where a full scan is too slow, or when onboarding one team at a time.

---

## What This Skill Does NOT Do

- **Does not modify code.** Read-only scan.
- **Does not modify existing docs.** Reports gaps, doesn't fix them.
- **Does not install tooling.** No Turborepo, Ultracite, Nextra — that's `npx ystack init` or `create`.
- **Does not create doc pages.** Reports what's missing — `/docs` or `/scaffold` creates them.
- **Does not guess features.** Only reports what it can detect from code structure, exports, and file names.
