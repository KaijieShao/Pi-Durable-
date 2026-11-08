# Config

## Features
- [x] Env-file loading and validation, one line per problem    → docs/configuration
- [x] Secret scrubbing of the host environment    → docs/security
- [x] Group variables (TELEGRAM_GROUP_CHAT_ID, TOPIC_ID, BOT_USERNAME)    → docs/configuration#optional-group-chat
- [?] PI_CODING_AGENT_DIR (pi home, auth.json and settings defaults)    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/runtime, integration/group, property/{config,pi-home,plugins}.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
