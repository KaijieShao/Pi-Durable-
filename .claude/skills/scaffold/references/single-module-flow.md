# Single-Module Flow

Use this flow when adding a new module to an existing project that already has `.ystack/config.json` and a docs site.

**Trigger:** `/scaffold <module-name>` or `/scaffold` with a module-level plan (not a full project plan) in a project with an existing `.ystack/config.json`.

### Step 1: Get the Module Plan

1. If the user provided a module name with no description, ask:
   > Describe the **<module-name>** module — what it does, its features, and what existing modules it connects to. Example:
   >
   > ```markdown
   > ## Notifications
   > - Email notifications (transactional, marketing)
   > - Push notifications (mobile, web)
   > - Notification preferences per user
   > - Connects to: Auth, Payments
   > ```

2. If the user provided a description (inline or file), use that.

### Step 2: Parse and Confirm

Extract from the module plan:
- **Name** and **slug** (e.g., "Notifications" → `notifications`)
- **Type** — `app` or `package`
- **Features** — bullet points
- **Connections** — which existing modules it connects to (verify these exist in `.ystack/config.json`)

Read the existing `.ystack/config.json` to understand what modules already exist.

Present:
```
Adding module to existing project:

  notifications (package) — 3 features
    Connects to: auth, payments

Existing modules: auth, payments, dashboard, api, db

Proceed?
```

**Wait for confirmation.**

### Step 3: Create Doc Page

1. Read the existing docs structure to find the docs root and framework.

2. Create the module overview page using the same template as full-project mode:
   - `<docs-root>/<module-slug>/index.mdx` — overview with Purpose, Scope, Dependencies, Sub-modules
   - `<docs-root>/<module-slug>/_meta.ts` (Nextra) or `meta.json` (Fumadocs)

3. Update top-level navigation to include the new module:
   - Nextra: add entry to `<docs-root>/_meta.ts`
   - Fumadocs: add entry to `<docs-root>/meta.json`

4. Update the project home page (`<docs-root>/index.mdx`):
   - Add the new module to the architecture Mermaid diagram (add node + connection edges)
   - Add row to the modules table

### Step 4: Update Module Registry

Read and update `.ystack/config.json`:

```json
{
  "modules": {
    // ... existing modules ...
    "<module-slug>": {
      "doc": "<module-slug>",
      "scope": ["<apps-or-packages>/<module-slug>/**"]
    }
  }
}
```

### Step 5: Create Progress File

Write `.ystack/progress/<module-slug>.md`:

```markdown
# <Module Name>

## Features
- [ ] <Feature 1>           → <module-slug>#<feature-anchor>
- [ ] <Feature 2>           → <module-slug>#<feature-anchor>

## Decisions
| Date | Feature | Decision |
|------|---------|----------|

## Notes
```

Add dependencies to existing module features where connections exist.
Update `.ystack/progress/_overview.md` to include the new module.

### Step 6: Create Per-Package Context Files

Create `AGENTS.md` (and `CLAUDE.md` if `runtime` is `claude-code` in `.ystack/config.json`) in the module's code directory using the stub template from Phase 6 in the main skill instructions.

### Step 7: Present Summary

```
## Module Added: <Module Name>

### Docs
  <docs-root>/<module-slug>/index.mdx — overview with 3 feature stubs

### Registry
  .ystack/config.json — module added

### Progress
  progress file created, 3 features tracked

### Architecture Diagram
  Updated — <module-slug> connected to auth, payments

### Next Steps
  1. `/build <feature>` to plan the first feature in this module
  2. Doc detail will fill in as features are built via `/docs`
```
