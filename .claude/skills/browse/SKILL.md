---
name: browse
description: >
  Browser automation for QA testing via Playwright MCP. Navigate pages, click elements,
  fill forms, take screenshots, check console errors, and verify page state. Used by /qa
  for visual testing. Use this skill when the user says 'browse', '/browse', 'open browser',
  'check the page', 'screenshot', or when /qa needs to test affected pages.
  Requires Playwright MCP to be registered (see Setup).
compatibility: Designed for Claude Code. Requires Playwright MCP.
metadata:
  user-invocable: "true"
---

# /browse — Browser Automation

You are the browser automation layer of the ystack agent harness. You give the agent eyes — real Chromium browser, real clicks, real screenshots.

**Primary consumer:** The `/qa` skill calls you to test affected pages. You can also be used standalone for ad-hoc browser inspection.

## Setup

### Check if Playwright MCP is available

Look for browser tools in your available tools:

```
browser_navigate, browser_snapshot, browser_click, browser_take_screenshot
```

If these tools are available, Playwright MCP is registered. Proceed.

### If not available — install

Tell the user:

> Playwright MCP is not registered. To enable browser testing, run:
>
> **Project-scoped** (recommended — shared via `.mcp.json`):
> ```bash
> claude mcp add --scope project playwright -- npx @playwright/mcp@latest --headless
> ```
>
> **User-scoped** (available in all projects):
> ```bash
> claude mcp add playwright -- npx @playwright/mcp@latest --headless
> ```
>
> Then restart Claude Code. Browser tools will be available automatically.

For headed mode (visible browser window):
```bash
claude mcp add --scope project playwright -- npx @playwright/mcp@latest
```

With extra capabilities (vision, devtools, storage):
```bash
claude mcp add --scope project playwright -- npx @playwright/mcp@latest --headless --caps vision,devtools,storage
```

**Do not proceed with browser testing if tools aren't available.** Return control to the caller.

## Core Commands

### Navigate

```
browser_navigate({ url: "http://localhost:3000/admin" })
```

Returns page title and URL. Always navigate before other actions.

### Snapshot (accessibility tree)

```
browser_snapshot({})
```

Returns a markdown representation of the page's accessibility tree with element references (`ref="e1"`, `ref="e2"`, etc.). This is your primary way to "see" the page structure.

**Use snapshots to:**
- Understand page layout before interacting
- Find element refs for clicking/filling
- Diff before/after actions to detect changes

### Click

```
browser_click({ element: "Submit button", ref: "e5" })
```

The `element` is a human-readable description, `ref` is the element reference from a snapshot.

### Type / Fill

```
browser_type({ element: "Email input", ref: "e3", text: "test@example.com", submit: true })
```

Set `submit: true` to press Enter after typing.

### Screenshot

```
browser_take_screenshot({ filename: "admin-page.png" })
```

Options:
- `fullPage: true` — capture entire scrollable page
- `element: "...", ref: "e3"` — capture specific element
- `type: "png"` (default) or `"jpeg"`

### Console messages

```
browser_console_messages({})
```

Returns all console output (errors, warnings, logs) since last clear. Critical for catching runtime JS errors.

```
browser_console_clear({})
```

### Network requests

```
browser_network_requests({ filter: "/api/" })
```

Returns captured network requests, filtered by URL pattern. Useful for verifying API calls.

### Wait

```
browser_wait_for({ text: "Payment successful" })
```

Wait for text to appear on page. Also supports:
- `time: 2000` — wait N milliseconds
- `textGone: "Loading..."` — wait for text to disappear

### Evaluate JavaScript

```
browser_evaluate({ function: "() => document.querySelectorAll('.error').length" })
```

Run arbitrary JS in the page context. Returns the result.

### Tabs

```
browser_tabs({ action: "list" })
browser_tabs({ action: "new" })
browser_tabs({ action: "select", index: 0 })
```

### Resize viewport

```
browser_resize({ width: 375, height: 812 })
```

Useful for responsive testing (mobile viewpoints).

## QA Testing Patterns

### Pattern 1: Page health check

```
1. browser_navigate({ url: "<url>" })
2. browser_console_messages({})          → check for errors
3. browser_snapshot({})                  → verify expected elements exist
4. browser_take_screenshot({ filename: "page-name.png" })
```

### Pattern 2: Form interaction

```
1. browser_navigate({ url: "<url>" })
2. browser_snapshot({})                  → find form element refs
3. browser_type({ ref: "e3", text: "value" })
4. browser_click({ ref: "e7" })          → submit
5. browser_wait_for({ text: "Success" }) → verify result
6. browser_console_messages({})          → check for errors
7. browser_take_screenshot({ filename: "form-submitted.png" })
```

### Pattern 3: Before/after comparison

```
1. browser_navigate({ url: "<url>" })
2. browser_snapshot({})                  → save as "before"
3. [perform action]
4. browser_snapshot({})                  → compare with "before"
```

### Pattern 4: Responsive testing

```
1. browser_navigate({ url: "<url>" })
2. browser_take_screenshot({ filename: "desktop.png" })
3. browser_resize({ width: 768, height: 1024 })
4. browser_take_screenshot({ filename: "tablet.png" })
5. browser_resize({ width: 375, height: 812 })
6. browser_take_screenshot({ filename: "mobile.png" })
```

### Pattern 5: API verification via network

```
1. browser_network_clear({})
2. browser_navigate({ url: "<url>" })
3. browser_click({ ref: "e5" })          → trigger API call
4. browser_network_requests({ filter: "/api/payments" })  → verify request/response
```

## Authentication

If the app requires login:

### Option 1: Fill the login form

```
1. browser_navigate({ url: "<login-url>" })
2. browser_snapshot({})
3. browser_type({ ref: "<email-ref>", text: "<email>" })
4. browser_type({ ref: "<password-ref>", text: "<password>" })
5. browser_click({ ref: "<submit-ref>" })
6. browser_wait_for({ text: "Dashboard" })
```

**Important:** Ask the user for credentials. Never guess or use hardcoded values.

### Option 2: Cookie import (if gstack browse available)

If the user has gstack installed, its cookie import is more convenient:
```bash
~/.claude/skills/gstack/browse/dist/browse cookie-import-browser
```

### Option 3: Manual handoff

> The app requires authentication I can't automate. Please:
> 1. Open the app in your browser and log in
> 2. Tell me when you're ready
> 3. I'll use the authenticated session

## Error Handling

### Browser not responding

If a browser command times out or fails:
1. Try `browser_navigate({ url: "about:blank" })` to reset
2. If that fails, the MCP server may need restart
3. Report the issue and continue without browser testing

### Page load failures

If navigation fails (404, 500, network error):
1. Record the failure as a QA finding
2. Check if the dev server is running
3. Try the URL manually and report

### Element not found

If a ref from a snapshot doesn't work:
1. Take a fresh snapshot — the page may have changed
2. Look for the element by a different ref
3. If the element genuinely doesn't exist, record it as a bug

## What This Skill Does NOT Do

- **Does not fix bugs.** That's `/qa`'s job. This skill only observes and reports.
- **Does not run tests.** Use `pnpm test` for that. This skill is for interactive browser testing.
- **Does not manage browser installation.** Playwright MCP handles its own Chromium.
- **Does not store credentials.** Always asks the user for auth details.
