// The real daemon (`runDaemon`) with a scripted faux model, for end-to-end tests. Config comes from the environment.
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runDaemon } from "../../src/cli/run.ts";
import { loadConfig } from "../../src/config/load.ts";
import { createLogger } from "../../src/runtime/log.ts";

const mode = process.env.FAKE_MODE ?? "fast";
const faux = fauxProvider(mode === "slow" ? { tokensPerSecond: 25 } : {});
const long = Array.from({ length: 800 }, (_, i) => `token${i}`).join(" ");
faux.setResponses(mode === "slow" ? [fauxAssistantMessage(`Partial ${long}`)] : [fauxAssistantMessage("final answer")]);
const models = createModels();
models.setProvider(faux.provider);
const config = await loadConfig();
await runDaemon(config, { models, log: createLogger({ level: "debug" }) });
