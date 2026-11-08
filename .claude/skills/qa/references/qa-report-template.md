# QA Report Template

Use this template when writing `QA-REPORT.md` in Phase 3, and when updating it during the optional bug-fix loop in Phase 4.

```markdown
# QA Report: <Feature Name>

**Status:** <IN_PROGRESS | PASSED | ISSUES_FOUND | FAILED | BLOCKED>
**Iteration:** <N>
**Date:** <YYYY-MM-DD>

## Summary
- Standards: <passed>/<total>
- Feature completeness: <passed>/<total>
- Agentic tests: <passed>/<total>
- Automated tests: <written and passing>/<total proposed>
- Browser: <passed>/<total> (or "N/A — not applicable" / "N/A — Playwright unavailable" / "N/A — URL pre-flight failed")
- Human-required items: <count> (listed below, not blocking)

## Open Issues

### Issue #1: <short title>
- **Category:** Standards | Feature | Agentic | Automated | Browser
- **Severity:** Blocker | Major | Minor
- **What:** <description>
- **Where:** `<file>:<line>` or `<url>` or `<command>`
- **Evidence:** <excerpt or screenshot filename>
- **Proposed fix:** <brief>
- **Status:** OPEN

### Issue #2: ...

## Resolved Issues

### Issue #1: <short title>
- **Status:** RESOLVED in `<commit-sha>`
- **Fix:** <what changed>
- **Verified:** <output of re-run check>

## Passed Checks
<collapsed table of everything that passed — just item + evidence>

## Human-Required Checklist
<items from "Cannot Test" section of QA.md — not issues, not blockers>
```

## Status transitions

- `IN_PROGRESS`: plan executing or optional fix loop active
- `PASSED`: all items passed, zero open issues, CI gauntlet green
- `ISSUES_FOUND`: QA execution found open issues and remediation was not requested or not yet confirmed
- `FAILED`: remediation was requested, but at least one open blocker/major issue remains after the fix loop exits
- `BLOCKED`: an issue remained open after 3 fix attempts — needs human decision
