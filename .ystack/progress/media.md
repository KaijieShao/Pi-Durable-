# Media

## Features
- [x] Attachments saved to the inbox and passed to the agent    → docs/how-it-works#features-in-detail
- [x] Voice transcription via Deepgram    → docs/how-it-works#features-in-detail

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/media, integration/{intake,shutdown}, property/safe-name.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
