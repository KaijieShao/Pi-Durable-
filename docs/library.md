# Using it as a library, and development

The package entry point (`src/index.ts`, built to `dist/index.js`) exports the Coordinator's building blocks:

- `startCoordinator(config, deps?)`: start the Coordinator; resolves to a handle with `stop()`. `deps` replaces
  Telegram, GitHub, git, the container sandbox, the Pi launcher, limits, the clock or the logger (tests use fakes).
- `loadCoordinatorConfig({ envFile?, env? })`, `parseCoordinatorConfig(env, defaults?)`, `describeConfig(config)`
  (a secret-free summary) and `ConfigError` (`problems`: one `{ variable, message }` per problem, never a value).
- `Store`: the Coordinator's SQLite database (WAL, synchronous=FULL, `tx()` = one synchronous `BEGIN IMMEDIATE`).
- `DEMO_LIMITS`, the fixed demo limits; `createLogger`, `silentLogger`, `errorSummary` (metadata-only logs).
- The interfaces of the outside world (`TelegramApi`, `GitHubApi`, `Sandbox`, `RunLauncher`) and the OpenAI endpoint
  helpers kept from the earlier package (`loadProvider`, `createAgentModels`, `codexGatewayPayload`).

## Development

```sh
npm ci
npm run typecheck
npm run lint        # Biome lint and format check
npm test            # node --test --test-concurrency=1 "test/**/*.test.ts"
```

TypeScript runs directly on Node 22 (type stripping: erasable syntax only, `.ts` import suffixes). Tests never
contact Telegram, GitHub or a model provider: they use fakes listening on 127.0.0.1. Contributions are welcome, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

---

Back to the [README](../README.md).
