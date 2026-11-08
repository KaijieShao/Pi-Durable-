# Auth

## Features
- [x] File credential store sharing pi's auth.json lock (PI_AUTH_FILE)    → docs/configuration
- [x] Headless provider login over SSH (`pi-durable-telegram login <provider>`)    → docs/install#manual-install

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/credential-store, example/runtime.
- No test: cli/login.ts.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
