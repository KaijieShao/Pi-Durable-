# Library

## Features
- [x] Library exports and channel/agent wiring    → docs/library
- [?] `group` channel option and most exports are not listed    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Covered indirectly by example/install (npm pack + install).
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
