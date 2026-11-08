---
name: docs
description: >
  Update documentation for completed work. Only updates docs for features that are
  implemented and verified — never for planned or in-progress work. Use this skill
  when the user says 'docs', '/docs', 'update docs', 'update documentation',
  'sync docs', or after /review passes and before /pr.
compatibility: Designed for Claude Code
metadata:
  user-invocable: "true"
---

# /docs — Update Documentation

You update documentation to reflect completed, verified work. Docs describe what the system IS — never what's planned.

## Phase 0: Detect What Changed

1. Get the diff to understand what code changed:
   ```bash
   # Resolve the repo's default branch dynamically
   BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
   git diff "$BASE"...HEAD --stat
   ```

2. Read `.context/<feature-id>/DECISIONS.md` to understand the feature intent.

3. Read `.context/<feature-id>/PLAN.md` for the success criteria — these tell you what was built.

4. **Read the progress file** — `.ystack/progress/<module>.md` for the affected module. Features marked `[x]` are completed and may need doc updates. Features still `[ ]` must NOT be documented. The progress file is the gate between implementation and documentation.

## Phase 1: Map Changes to Docs

Identify which documentation pages are affected.

1. **Read the module registry** (`.ystack/config.json`) to find the module-to-doc mapping. Match changed file paths against module `scope` globs. If no registry exists, fall back to scanning `docs/src/content/_meta.ts`.

2. **Map changed code paths to doc pages:**

   | Code path pattern | Likely doc page |
   |-------------------|----------------|
   | `packages/<name>/` | `docs/src/content/<module>/` or `docs/src/content/shared/<name>/` |
   | `apps/<name>/` | `docs/src/content/<module>/` |
   | `packages/db/src/schema*` | Data model sections across affected modules |
   | `apps/api/src/routes/` | API module + any module whose API changed |

3. **Read the affected doc pages** before modifying them. Understand what's currently documented.

## Phase 2: Update Affected Pages

For each affected doc page, update ONLY the sections impacted by the new feature.

**What to update:**

| Change type | Doc section to update |
|-------------|----------------------|
| New database column/table | Data Model section — add to table/columns/notes table |
| New API endpoint or field | Dependencies section — update "Provides" list, or relevant sub-module page |
| New UI component or page | Sub-modules table — add or update entry |
| New module dependency | Dependencies section — update "Needs" table |
| Changed flow or behavior | Flows section — update Mermaid diagram and numbered explanation |
| New sub-module | Sub-modules table + create new sub-module page if significant |

**What NOT to update:**
- Sections unrelated to the feature
- "Purpose" section (unless the module's core responsibility changed)
- "Team" section
- "Scope" section (unless something moved in/out of scope)

**Writing rules:**
- Present tense, active voice: "The gateway normalizes messages" not "Messages will be normalized"
- Purpose over implementation: describe what it does and why, not how the code works
- No version language: no "v1", "v2", "Phase 1", "new", "recently added"
- No planning language: no "planned", "coming soon", "TODO", "will be", "in progress"
- Link, don't recap: reference other pages instead of repeating their content
- Use cross-references: `[Module Name](/module-path)` for every module mention

**Diagram rules (if updating Mermaid diagrams):**
- Use the right type: `sequenceDiagram` for multi-actor flows, `graph TB/LR` for architecture, `erDiagram` for data models
- Label edges: `-->|"what flows"|` not just `-->`
- Keep under 20 nodes — split if bigger
- Every diagram needs a text explanation below it

## Phase 3: Update Navigation

If you created a new doc page, update the navigation config for the docs framework in use:

**Nextra** — add to `_meta.ts`:
```typescript
// docs/src/content/<module>/_meta.ts
export default {
  index: "Overview",
  "existing-page": "Existing Page",
  "new-page": "New Page",        // ← add here, object key order = sidebar order
};
```

**Fumadocs** — add to `meta.json` or use frontmatter ordering:
```json
// content/docs/<module>/meta.json
{
  "pages": ["index", "existing-page", "new-page"]
}
```

Check `.ystack/config.json` `docs.framework` to know which format to use.

## Phase 4: Update Structural Files

If the feature changed module responsibilities, dependencies, or structure, also update:

1. **Root `CLAUDE.md`** — if the Structure section or Commands changed
2. **Root `AGENTS.md`** — mirror CLAUDE.md changes

Most features don't require root structural file updates. Only update these if the module's role or boundaries shifted.

## Phase 5: Update Per-Package Context Files

For each module whose code changed in the current diff, update its `AGENTS.md` (and `CLAUDE.md` if `.ystack/config.json` has `"runtime": "claude-code"`).

If the file doesn't exist yet, create it. If it exists, update it.

### What to include

Read the package's actual code and populate:

1. **Key Files** — list the important entry points with one-line descriptions:
   ```markdown
   ## Key Files

   - `src/index.ts` — public API surface
   - `src/schema.ts` — database schema (drizzle)
   - `src/routes/payments.ts` — HTTP handlers
   - `src/errors.ts` — domain error types
   ```

2. **Conventions** — patterns observed in the code, stated as rules:
   ```markdown
   ## Conventions

   - All exports go through `src/index.ts`
   - Error types defined in `src/errors.ts`, re-thrown at API boundary
   - Tests colocated: `src/__tests__/<module>.test.ts`
   - Zod schemas validate all external input
   ```

### Rules

- **References, not explanations.** Point to files and state patterns. Don't explain what the code does — that's what the docs site is for.
- **Max ~30 lines.** If it's longer, you're writing too much.
- **Only update for changed modules.** Don't rewrite every package's context file on every run.
- **No stale content.** If a file was renamed or removed, update the reference. If a convention changed, update the rule.
- **CLAUDE.md mirrors AGENTS.md** unless there are Claude-specific hints to add (e.g., "use Agent tool for parallel execution in /go").

## Phase 6: Verify

1. Check that all cross-reference links point to existing pages:
   ```bash
   # Extract links from updated docs and verify targets exist
   grep -oP '\[.*?\]\((/[^)]+)\)' docs/src/content/<module>/*.mdx
   ```

2. Confirm no planning language leaked in:
   ```bash
   grep -i -E '(coming soon|planned|todo|will be|in progress|phase [0-9])' docs/src/content/<module>/*.mdx
   ```

3. Present a summary of what was updated:
   ```
   ## Documentation Updates

   ### Modified
   - docs/src/content/shared/payments/index.mdx
     - Added `refundReason` to Data Model table
     - Updated Refund Flow sub-module description

   ### Created
   - (none)

   ### Structural files
   - (no changes needed)
   ```

---

## Delegating to Existing Skills

If the project has its own documentation skills (e.g., `docs-update`, `docs-module`, `docs-page`), prefer delegating to them. They know the project-specific conventions.

- **Updating existing pages** → delegate to `docs-update` if available
- **Creating a new module's docs** → delegate to `docs-module` if available
- **Writing a single new page** → delegate to `docs-page` if available

If no project-specific doc skills exist, follow the process above.

---

## What This Skill Does NOT Do

- **Does not document planned features.** Only completed, verified work.
- **Does not rewrite entire pages.** Updates only affected sections.
- **Does not create module scaffolds.** That's `/scaffold`.
- **Does not create PRs.** That's `/pr`.
