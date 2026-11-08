# Plugins

## Features
- [x] Plugin loader (PI_PLUGINS: builtin, npm, path)    → docs/plugins
- [x] Web search plugin    → docs/plugins#web-search-search
- [x] MCP servers plugin    → docs/plugins#mcp-servers-mcp
- [x] Skills plugin    → docs/plugins#skills-skills
- [x] Helpers plugin (sub-agent models)    → docs/plugins#helpers-helpers
- [x] Reminders plugin    → docs/plugins#reminders-reminders
- [?] MCP 300 s tool-call timeout and 64-character tool names    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/{search,skills}, integration/{mcp,reminders,plugins}, property/{plugins,reminders}.
- No direct test: plugins/helpers.ts, plugins/reminders/index.ts.
- Known doc/code mismatch: helpers ignore OPENAI_BASE_URL after secret scrubbing (src/plugins/helpers.ts:48).
- The spec says no MCP and no compaction.
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
