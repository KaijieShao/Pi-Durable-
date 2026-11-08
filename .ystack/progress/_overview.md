# Project Progress

## Module Status

| Module | Done | Total | Gaps | Status |
|--------|------|-------|------|--------|
| agent | 6 | 8 | 2 | docs gaps |
| auth | 2 | 2 | 0 | complete |
| channel | 7 | 9 | 2 | docs gaps |
| delivery | 5 | 5 | 0 | complete |
| telegram | 4 | 5 | 1 | docs gaps |
| media | 2 | 2 | 0 | complete |
| plugins | 6 | 7 | 1 | docs gaps |
| config | 3 | 4 | 1 | docs gaps |
| daemon | 4 | 5 | 1 | docs gaps |
| library | 1 | 2 | 1 | docs gaps |
| install | 5 | 6 | 1 | docs gaps |

## Dependencies

agent → auth, channel, config, daemon (runtime), delivery, media, plugins, telegram
channel → agent, config, daemon (runtime), delivery, media, plugins, telegram
delivery → channel, daemon (runtime), telegram
telegram → agent, channel, daemon (runtime), delivery (format)
plugins → agent, channel, config, daemon (runtime), delivery
config → daemon (runtime)
daemon → agent, auth, channel, config
library → (re-exports agent, auth, channel, config, delivery, media, plugins, daemon, telegram)
install → daemon (runs the CLI)
auth, media → (none)

Cycle: agent, channel, delivery, plugins and telegram import each other (one package, layered directories).

## Ready Front

_No planned items are tracked here: ystack tracks built work only. The target design is `spec/`; see the /import gap report for what it still needs._

## Documentation Gaps

- agent: PI_CONTEXT_CAP minimum and window rule; AGENTS.md 64 KB truncation
- agent: Provider API-key variables (ANTHROPIC_API_KEY, OPENAI_API_KEY) have no configuration row
- channel: /task in private chats; other addressed commands and @mention admission in the group
- channel: Group reply context from other members passed to the model without a third-party marker
- telegram: send_file limits: photos over 10 MB, 1024-character captions
- plugins: MCP 300 s tool-call timeout and 64-character tool names
- config: PI_CODING_AGENT_DIR (pi home, auth.json and settings defaults)
- daemon: CLI --help, --version and --env-file=<path> forms
- library: `group` channel option and most exports are not listed
- install: Installer variables PDT_ALLOW_ROOT, PDT_ARCHIVE_URL, PDT_TELEGRAM_API
- docs/security.md: says groups are unsupported (stale)

## Not registered

- `src/coordinator/` and `src/runner/` appeared during /import (2026-11-07 20:18-20:22, created outside this setup session). They are in progress, untested and not in any module scope. Re-run `/import --module coordinator` once that work settles.
