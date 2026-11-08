import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { NEW_REPLY, newReply, startOf } from "../../src/channel/commands/new.ts";
import { check } from "../helpers/property.ts";

test("P-new-reply: /new names every dropped message by count and shows at most five starts", (t) => {
	const dropped = fc.record({ running: fc.boolean(), queued: fc.array(fc.string(), { maxLength: 12 }) });
	check(t, dropped, (d) => {
		const text = newReply({ running: d.running, queued: d.queued.map(startOf) });
		const lines = text.split("\n");
		assert.equal(lines[0], NEW_REPLY);
		assert.equal(text.includes("The request in progress was stopped."), d.running);
		assert.equal(text.includes(`Dropped without an answer (${d.queued.length})`), d.queued.length > 0);
		if (d.queued.length === 0 && !d.running) assert.equal(text, NEW_REPLY);
	});
});

test("P-start-of: the start of a queued input is one short line", (t) => {
	const part = fc.oneof(
		fc.record({ type: fc.constant("text"), text: fc.string() }),
		fc.record({ type: fc.constant("image"), data: fc.string() }),
	);
	check(t, fc.oneof(fc.string(), fc.array(part, { maxLength: 4 })), (content) => {
		const start = startOf(content);
		assert.ok(start.length > 0 && [...start].length <= 40);
		assert.ok(!/\s{2,}|\n/.test(start));
	});
});
