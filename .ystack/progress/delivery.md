# Delivery

## Features
- [x] Durable tg.deliver task per admitted message (survives crash and restart)    → docs/how-it-works#what-durable-means-here
- [x] Streaming drafts, tool hints and stop button    → docs/how-it-works#features-in-detail
- [x] Steering: a message sent during a run steers it at the next tool boundary    → docs/how-it-works#features-in-detail
- [x] Rich answers with HTML fallback and 4096-character chunking    → docs/how-it-works#features-in-detail
- [x] Compaction report for /compact    → docs/how-it-works#features-in-detail

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/{outcome,preview}, integration/helpers; format: property/{format,rich}, integration/{restart,rich,upgrade,delivery}.
- No direct test: delivery/{compact-report,live-frame,phase-guard,send-phase,task,types,typing,wait-phase}.ts (covered indirectly).
- Inherited behaviour the spec changes: steering every busy message; a chunk in flight at restart is skipped (spec: at-least-once).
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
