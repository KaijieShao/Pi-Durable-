# Telegram

## Features
- [x] grammY Bot API port with per-method retry (429 retry_after, capped at 30 s)    → docs/how-it-works#what-durable-means-here
- [x] Attachment download with size limit    → docs/how-it-works#features-in-detail
- [x] telegram_send_file tool    → docs/how-it-works#features-in-detail
- [x] TELEGRAM_API_ROOT and group topic routing for sends    → docs/configuration
- [?] send_file limits: photos over 10 MB, 1024-character captions    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/{media,outcome,preview,retry}, integration/{delivery,group,rich,upgrade}.
- No direct test: telegram/send-file.ts.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
