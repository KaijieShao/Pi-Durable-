import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { INTAKE_RING_SIZE, messageKey, pushRing } from "../../src/channel/docs.ts";
import { check } from "../helpers/property.ts";
import { DATE } from "../helpers/updates.ts";

test("P-dedup: with redeliveries inside the ring window every key admits once, in order", (t) => {
	const scenario = fc.array(fc.tuple(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 40 })), {
		minLength: 1,
		maxLength: 300,
	});
	check(t, scenario, (steps) => {
		const delivered = deliveries(steps);
		const ring: string[] = [];
		const admitted = delivered.filter((key) => pushRing(ring, key, INTAKE_RING_SIZE));
		assert.deepEqual(admitted, [...new Set(delivered)]);
		assert.ok(ring.length <= INTAKE_RING_SIZE);
	});
});

/** Each step is a new message followed by redeliveries of it or of a recent message (Telegram re-runs a batch). */
function deliveries(steps: readonly [number, number][]): string[] {
	const delivered: string[] = [];
	steps.forEach(([copies, lookBack], index) => {
		const fresh = messageKey(7, index + 1, DATE + index);
		delivered.push(fresh);
		for (let copy = 1; copy < copies; copy++)
			delivered.push(delivered[Math.max(0, delivered.length - 1 - lookBack)] ?? fresh);
	});
	return delivered;
}

test("ring drops the oldest key beyond its size", () => {
	const ring: string[] = [];
	for (let i = 0; i < 5; i++) pushRing(ring, `k${i}`, 3);
	assert.deepEqual(ring, ["k2", "k3", "k4"]);
	assert.equal(pushRing(ring, "k4", 3), false);
	assert.equal(pushRing(ring, "k0", 3), true);
});

test("P-key-reset: message ids that start again under a new bot get new keys; the same message keeps its key", (t) => {
	const message = fc.record({ id: fc.integer({ min: 1, max: 600 }), date: fc.integer({ min: 1, max: 2_000_000_000 }) });
	check(t, fc.tuple(message, message), ([a, b]) => {
		const same = a.id === b.id && a.date === b.date;
		assert.equal(messageKey(7, a.id, a.date) === messageKey(7, b.id, b.date), same);
	});
});

test("P-legacy: a key of an earlier version never matches a new key", (t) => {
	check(t, fc.tuple(fc.integer({ min: 1 }), fc.integer({ min: 1 })), ([id, date]) => {
		const legacy = `tg:7:${id}`;
		const ring = [legacy];
		assert.equal(pushRing(ring, messageKey(7, id, date), INTAKE_RING_SIZE), true);
	});
});
