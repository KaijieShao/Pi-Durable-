/**
 * A fatal poller error must not leave a Coordinator that runs without taking commands (Requirements § Availability:
 * "If the Coordinator process crashes, it restarts automatically"). The full stack's poller hits a 401 from
 * getUpdates (a revoked token): it stops and the Coordinator reports the fatal error through deps.onFatal, which the
 * CLI turns into stop + a non-zero exit (test/example/cli-args.test.ts covers that half).
 */
import "../helpers/env.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramError } from "../../src/coordinator/ports.ts";
import { sleep, waitFor } from "../helpers/env.ts";
import { startStack, USER1 } from "./harness.ts";

test("a 401 from getUpdates stops the poller and reports a fatal error to the process", async () => {
	const fatal: { reason: string; error: unknown }[] = [];
	const stack = await startStack({ onFatal: (reason, error) => fatal.push({ reason, error }) });
	try {
		// The stack is healthy first: a command is acknowledged.
		stack.sendCommand(USER1, "/help");
		await stack.waitForBotMessage(/task/i);
		assert.equal(fatal.length, 0);

		stack.bot.failGetUpdates = 401;
		await waitFor(() => fatal.length > 0, { what: "onFatal", timeoutMs: 10_000 });
		assert.equal(fatal.length, 1, "reported once");
		assert.equal(fatal[0]?.reason, "telegram_poller_fatal");
		const error = fatal[0]?.error;
		assert.ok(error instanceof TelegramError && error.kind === "unauthorized", "the 401 is passed on, classified");

		// The poller really stopped: no more getUpdates calls after the fatal error.
		const polls = stack.bot.count("getUpdates");
		await sleep(1500);
		assert.equal(stack.bot.count("getUpdates"), polls, "no polling after the fatal error");
	} finally {
		await stack.stop();
	}
});
