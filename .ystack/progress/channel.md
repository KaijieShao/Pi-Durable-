# Channel

## Features
- [x] Allowlisted private chats (TELEGRAM_ALLOWED_USER_IDS)    → docs/security
- [x] Opt-in group/topic: exact group, topic, bot address and allowlisted sender    → docs/configuration#optional-group-chat
- [x] One durable conversation per chat; redelivered updates admitted once    → docs/how-it-works#features-in-detail
- [x] Commands /new, /stop, /compact, /status, /help    → docs/how-it-works#features-in-detail
- [x] Buttons (tg-button taps admitted as messages)    → docs/how-it-works#features-in-detail
- [x] Forwarded-content provenance marker    → docs/security
- [x] Resume of unfinished work at start (harness.resume)    → docs/how-it-works#what-durable-means-here
- [?] /task in private chats; other addressed commands and @mention admission in the group    → (needs docs)
      ⚠️ Code exists but no doc section found
- [?] Group reply context from other members passed to the model without a third-party marker    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/access, integration/{commands,delivery,group,intake,reminders,tools}, property/{dedup,new-reply}; status: example/runtime.
- No direct test: channel/commands/{compact,list,start-help,status,stop}.ts, channel/{extension,intake,tap}.ts (covered indirectly).
- docs/security.md is stale: it says groups are unsupported.
- Inherited behaviour the spec removes: auto-resume after restart (src/channel/create.ts:197); any allowlisted user may /stop or /new; one shared conversation per group.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
