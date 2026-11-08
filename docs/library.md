# Using it as a library

pi-durable needs every task definition installed before `Harness.open`, and `resume()` only after the channel is wired,
so the channel has two steps: install `channel.extension`, open the harness, then `channel.start()`.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  buildSafeEnv,
  createFileCredentialStore,
  createPromptExtension,
  createTelegramChannel,
  createWorkspaceTools,
} from "pi-durable-telegram";

const workdir = "/home/me/projects";
const models = createModels({ credentials: createFileCredentialStore("/home/me/.local/state/bot/auth.json") });
models.setProvider(anthropicProvider());

const channel = createTelegramChannel({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  allowedUserIds: [111111111],
  workdir,
  model: { provider: "anthropic", modelId: "claude-opus-5-5" },
  thinkingLevel: "high",
  models,
  rich: true, // rich answers, buttons and native drafts; omit for HTML messages
});

const registry = createRegistry();
registry.install(createWorkspaceTools({ env: buildSafeEnv(process.env) }));
registry.install(createPromptExtension({ instructionsPath: `${workdir}/AGENTS.md`, rich: true }));
registry.install(channel.extension);

const harness = await Harness.open(
  await openNodeSqliteStorage("/home/me/.local/state/bot/durable.sqlite"),
  { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workdir }) },
  BACKGROUND_CONTEXT,
);
await channel.start(harness, BACKGROUND_CONTEXT); // resumes unfinished work, then starts polling

process.once("SIGTERM", async () => {
  await channel.stop();
  await harness.close(BACKGROUND_CONTEXT);
});
```

Do not call `submit`, `wait`, `compact` or `abort` on the harness before `channel.start()`: they start the scheduler,
and resumed runs could then begin before the channel is listening. Keep one process per storage file; the CLI uses a
lock file for that (`acquireDataDirLock`). Updates from another source (for example a webhook) can be passed to
`channel.handleUpdate(update)` after `start(harness, context, { polling: false })`.

Other exports: `openAgent` (the CLI's setup), `parseConfig`, `createDeepgramStt`, `createGrammyPort`,
`markdownToTelegramHtml`, `splitForTelegram`.

## Development

```sh
npm install
npm run typecheck
npm run lint        # Biome lint and format check
npm test            # node --test: property, example, integration and end-to-end tests
npm run build
```

Tests never contact Telegram, model providers or Deepgram: they use pi-ai's faux provider, an in-memory Telegram
fake and a fake Bot API HTTP server. Contributions are welcome, see [CONTRIBUTING.md](../CONTRIBUTING.md).

---

Back to the [README](../README.md).
