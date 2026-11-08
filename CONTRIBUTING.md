# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- For anything larger than a small fix, open an issue first and describe the problem and the change you have in mind.
- pi-durable is experimental and pinned to exact versions here. A version bump of `@earendil-works/*` packages is its
  own change with its own tests.

## Development

```sh
npm install
npm run typecheck
npm run lint        # Biome lint and format check
npm test            # node --test on the TypeScript sources
npm run build
```

Node.js 22.19 or newer is required. Tests never contact Telegram, model providers or Deepgram; keep it that way and use
the fakes in `test/helpers` and `test/fixtures`.

## Rules for changes

- One logical change per commit, with a conventional prefix (`feat:`, `fix:`, `test:`, `docs:`, `chore:`). The message
  says what changed in the code.
- Every behaviour change comes with a test. Parsers, formatters and state invariants get property-based tests
  (fast-check); restart, retry and duplicate-delivery cases get integration tests.
- Keep functions small (cyclomatic complexity of 10 or less, enforced by Biome).
- No secrets, tokens or machine-specific paths in code, tests or docs.
- Update `CHANGELOG.md` under the unreleased section and the README when behaviour visible to users changes.
