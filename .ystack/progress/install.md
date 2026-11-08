# Install and deploy

## Features
- [x] curl installer    → docs/install#what-the-installer-does
- [x] systemd user service    → docs/install#manual-install
- [x] Updating and removing    → docs/install#updating
- [x] pi skill to install and run the bot from inside pi    → skills/pi-durable-telegram/SKILL.md
- [x] Conductor workspace actions (setup, bot, doctor, login, archive)    → .conductor/README.md
- [?] Installer variables PDT_ALLOW_ROOT, PDT_ARCHIVE_URL, PDT_TELEGRAM_API    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Tests: example/install (npm pack + clean install), example/hygiene (.gitignore rules). install.sh has no test.
- .conductor/workspace.test.mjs exists but is not part of `npm test` (glob is test/**/*.test.ts), so it did not run.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
