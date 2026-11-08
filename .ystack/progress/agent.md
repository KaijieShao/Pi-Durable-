# Agent

## Features
- [x] Durable Pi harness with SQLite storage    → docs/how-it-works
- [x] Workspace tools: read, write, edit, bash with secrets stripped    → docs/how-it-works#features-in-detail
- [x] Instructions from AGENTS.md / PI_INSTRUCTIONS, re-read each request    → docs/how-it-works#features-in-detail
- [x] Any pi-ai model via PI_PROVIDER, PI_MODEL, PI_THINKING    → docs/configuration
- [x] OpenAI-compatible endpoint: OPENAI_BASE_URL, OPENAI_CODEX_GATEWAY    → docs/configuration
- [x] Provider-error retry policy (5 retries, 5/10/20/40/60 s) and INF-18 401 auth-rotation patch    → docs/formal/README
- [?] PI_CONTEXT_CAP minimum and window rule; AGENTS.md 64 KB truncation    → (needs docs)
      ⚠️ Code exists but no doc section found
- [?] Provider API-key variables (ANTHROPIC_API_KEY, OPENAI_API_KEY) have no configuration row    → (needs docs)
      ⚠️ Code exists but no doc section found

## Decisions
| Date       | Feature | Decision                              |
|------------|---------|---------------------------------------|
| pre-import | All     | Pre-existing — detected by /import    |

## Notes
- Checks: 2026-11-07: `npm run typecheck` passed and `npm test` passed 207/207 (log: `.context/import/test.log`).
- Direct tests: example/prompt, example/provider-endpoint, example/runtime, property/image-probe, property/settings, integration/shutdown; all integration tests boot it via startTestAgent.
- No direct test: agent/empty-answer.ts, agent/tools/image-read.ts, agent/tools/workspace-tools.ts (covered only indirectly).
- Inherited behaviour the spec removes: the INF-18 401 retry (scripts/patch-pi-durable.mjs) and maxRetries 5 (spec: 2). The relay drops max_output_tokens for Codex gateways (spec: 16K cap).
- Target-spec gaps and conflicts are tracked in the /import gap report, not here (`spec/` is the target, not built work).
