import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as BG } from "@earendil-works/chord/context";
import { createModels, type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { type Agent, type OpenAgentDeps, openAgent } from "../../src/agent/open.ts";
import { parseConfig } from "../../src/config/schema.ts";
import { createLogger } from "../../src/runtime/log.ts";
import type { FakeTelegram } from "./fake-telegram.ts";

export const CHAT = 111;
export const TOKEN = `123456:${"a".repeat(35)}`;

export async function tempDir(prefix = "pdt-"): Promise<{ dir: string; cleanup(): Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function testConfig(dir: string, extra: Record<string, string> = {}) {
	return parseConfig(
		{
			TELEGRAM_BOT_TOKEN: TOKEN,
			TELEGRAM_ALLOWED_USER_IDS: String(CHAT),
			PI_PROVIDER: "faux",
			PI_MODEL: "faux-1",
			PI_THINKING: "off",
			PI_WORKDIR: join(dir, "work"),
			PI_DATA_DIR: join(dir, "data"),
			TELEGRAM_RICH: "never",
			...extra,
		},
		{ cwd: dir, home: dir },
	);
}

export type TestAgent = { agent: Agent; logs: string[]; fatal: string[]; close(): Promise<void> };

/** Open the real agent on `dir` with a faux model and a fake Telegram, started without polling. */
export async function startTestAgent(options: {
	dir: string;
	faux: FauxProviderHandle;
	port: FakeTelegram;
	deps?: Omit<OpenAgentDeps, "models" | "port" | "log">;
	config?: Record<string, string>;
}): Promise<TestAgent> {
	const config = testConfig(options.dir, options.config);
	await mkdir(config.workdir, { recursive: true });
	const models = createModels();
	models.setProvider(options.faux.provider);
	const logs: string[] = [];
	const fatal: string[] = [];
	const log = createLogger({ level: "debug", sink: (_level, line) => logs.push(line) });
	const agent = await openAgent(config, {
		models,
		port: options.port,
		log,
		previewIntervalMs: 50,
		onFatal: (reason) => fatal.push(reason),
		shellEnv: { PATH: process.env.PATH, HOME: options.dir },
		...options.deps,
	});
	await agent.channel.start(agent.harness, BG, { polling: false, plugins: agent.plugins.report });
	return {
		agent,
		logs,
		fatal,
		close: async () => {
			await agent.channel.stop();
			await agent.harness.close(BG);
			await agent.plugins.close();
		},
	};
}

export function newFaux(options: Parameters<typeof fauxProvider>[0] = {}): FauxProviderHandle {
	return fauxProvider(options);
}
