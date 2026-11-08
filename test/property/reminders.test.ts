import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
	type Every,
	formatLocal,
	nextOccurrence,
	parseAt,
	parseEvery,
	wallOf,
	zonedParts,
	zonedToUtc,
} from "../../src/plugins/reminders/time.ts";
import { check } from "../helpers/property.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ZONES = [
	"UTC",
	"Europe/Berlin",
	"America/New_York",
	"Asia/Tashkent",
	"Asia/Kolkata",
	"Australia/Lord_Howe",
	"Pacific/Chatham",
	"America/St_Johns",
	"America/Santiago",
];
const pad = (n: number) => String(n).padStart(2, "0");
const local = fc.record({
	y: fc.integer({ min: 2025, max: 2028 }),
	m: fc.integer({ min: 1, max: 12 }),
	d: fc.integer({ min: 1, max: 28 }),
	hh: fc.integer({ min: 0, max: 23 }),
	mm: fc.integer({ min: 0, max: 59 }),
});
const zone = fc.constantFrom(...ZONES);

test("parseAt examples: local time in the zone, offsets, DST gap and overlap, junk", () => {
	assert.equal(parseAt("2026-10-15T09:00", "Asia/Tashkent"), Date.UTC(2026, 9, 15, 4, 0));
	assert.equal(parseAt("2026-10-15 09:00:30", "Asia/Tashkent"), Date.UTC(2026, 9, 15, 4, 0));
	assert.equal(parseAt("2026-10-15T09:00Z", "Asia/Tashkent"), Date.UTC(2026, 9, 15, 9, 0));
	assert.equal(parseAt("2026-10-15T09:00+0300", "UTC"), Date.UTC(2026, 9, 15, 6, 0));
	assert.equal(parseAt("2026-10-15T09:00-05:30", "UTC"), Date.UTC(2026, 9, 15, 14, 30));
	assert.throws(() => parseAt("2027-03-28T02:30", "Europe/Berlin"), /does not exist in Europe\/Berlin/);
	assert.equal(formatLocal(parseAt("2026-10-25T02:30", "Europe/Berlin"), "Europe/Berlin"), "Sun 2026-10-25 02:30");
	for (const junk of ["tomorrow", "2026-02-30T10:00", "2026-10-15", "2026-13-01T10:00Z", "15.10.2026 09:00"])
		assert.throws(() => parseAt(junk, "UTC"), Error, junk);
	assert.equal(formatLocal(Date.UTC(2026, 9, 14, 7, 2), "Asia/Tashkent"), "Wed 2026-10-14 12:02");
});

test("parseEvery: the fixed words and minutes from 5", () => {
	assert.deepEqual(["daily", " Weekdays ", "weekly", "5", "90"].map(parseEvery), [
		"daily",
		"weekdays",
		"weekly",
		5,
		90,
	]);
	for (const bad of ["4", "0", "-10", "hourly", "1.5", ""]) assert.throws(() => parseEvery(bad), /every must be/);
});

test("nextOccurrence examples: DST fall-back keeps 09:00, missed days collapse, weekdays skip the weekend", () => {
	const berlin = { every: "daily" as const, wall: "09:00", tz: "Europe/Berlin" };
	const due = Date.UTC(2026, 9, 24, 7, 0); // Sat 09:00 CEST
	assert.equal(nextOccurrence(berlin, due, due), Date.UTC(2026, 9, 25, 8, 0)); // Sun 09:00 CET
	assert.equal(nextOccurrence(berlin, due, due + 3 * DAY), Date.UTC(2026, 9, 27, 8, 0)); // that day's 09:00 CET is still ahead
	const fri = Date.UTC(2026, 9, 16, 4, 0); // Fri 09:00 in Tashkent
	const tashkent = { every: "weekdays" as const, wall: "09:00", tz: "Asia/Tashkent" };
	assert.equal(nextOccurrence(tashkent, fri, fri + MINUTE), Date.UTC(2026, 9, 19, 4, 0)); // Mon
	assert.equal(nextOccurrence({ ...tashkent, every: "weekly" }, fri, fri), Date.UTC(2026, 9, 23, 4, 0));
	assert.equal(nextOccurrence({ ...tashkent, every: 30 }, fri, fri + 95 * MINUTE), fri + 120 * MINUTE);
	assert.equal(nextOccurrence({ wall: "09:00", tz: "UTC" }, fri, fri), undefined);
	const firstOfTwo = Date.UTC(2026, 9, 25, 0, 30); // Sun 02:30 CEST; 02:30 CET comes an hour later
	const repeated = { every: "daily" as const, wall: "02:30", tz: "Europe/Berlin" };
	assert.equal(nextOccurrence(repeated, firstOfTwo, firstOfTwo + 1000), Date.UTC(2026, 9, 26, 1, 30)); // Mon, not Sun again
});

test("P-parse-at: a local time round-trips, or it is refused only next to a clock change", (t) => {
	check(t, fc.tuple(local, zone), ([at, tz]) => {
		const text = `${at.y}-${pad(at.m)}-${pad(at.d)}T${pad(at.hh)}:${pad(at.mm)}`;
		let ms: number;
		try {
			ms = parseAt(text, tz);
		} catch (error) {
			assert.match(String(error), /does not exist/);
			const wanted = Date.UTC(at.y, at.m - 1, at.d, at.hh, at.mm);
			const offset = (x: number) => Date.UTC(...toArgs(zonedParts(x, tz))) - x;
			assert.notEqual(offset(wanted - DAY), offset(wanted + DAY), "refused away from a transition");
			return true;
		}
		assert.deepEqual(zonedParts(ms, tz), { ...at });
		assert.equal(ms % MINUTE, 0);
		assert.equal(parseAt(`${text}Z`, tz), Date.UTC(at.y, at.m - 1, at.d, at.hh, at.mm));
		return true;
	});
});

const toArgs = (p: { y: number; m: number; d: number; hh: number; mm: number }) =>
	[p.y, p.m - 1, p.d, p.hh, p.mm] as const;

const every = fc.oneof(fc.constantFrom<Every>("daily", "weekdays", "weekly"), fc.integer({ min: 5, max: 20_000 }));

function fits(rule: Every, day: number, firstDay: number): boolean {
	if (rule === "weekdays") return day >= 1 && day <= 5;
	return rule === "weekly" ? day === firstDay : true;
}

const dayOf = (ms: number, tz: string) => {
	const p = zonedParts(ms, tz);
	return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
};

const dateOf = (ms: number, tz: string) => {
	const p = zonedParts(ms, tz);
	return p.y * 10_000 + p.m * 100 + p.d;
};

/** The qualifying occurrence before `result`, stepping back over local dates. */
function previous(rule: Every, result: number, wall: string, tz: string, firstDay: number): number {
	const p = zonedParts(result, tz);
	const [hh, mm] = wall.split(":").map(Number) as [number, number];
	for (let i = 1; ; i++) {
		const date = new Date(Date.UTC(p.y, p.m - 1, p.d - i));
		const at = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), hh, mm };
		if (fits(rule, date.getUTCDay(), firstDay)) return zonedToUtc(at, tz);
	}
}

test("P-next-occurrence: after now and due, the first such, aligned, on the right days at the wall time", (t) => {
	const input = fc.tuple(local, zone, every, fc.integer({ min: -DAY, max: 40 * DAY }), fc.constantFrom(0, 30, 60));
	check(t, input, ([at, tz, rule, delta, back]) => {
		const later = zonedToUtc(at, tz);
		// Also the earlier of two equal wall times on a fall-back day, which zonedToUtc never returns.
		const earlier = later - back * MINUTE;
		const due = wallOf(earlier, tz) === wallOf(later, tz) && dayOf(earlier, tz) === dayOf(later, tz) ? earlier : later;
		const wall = wallOf(due, tz);
		const now = due + delta;
		const next = nextOccurrence({ every: rule, wall, tz }, due, now);
		assert.ok(next !== undefined && next > now && next > due);
		const base = Math.max(now, due);
		if (typeof rule === "number") {
			assert.equal((next - due) % (rule * MINUTE), 0);
			assert.ok(next - rule * MINUTE <= base, "the first one");
			return true;
		}
		const firstDay = dayOf(due, tz);
		assert.ok(fits(rule, dayOf(next, tz), firstDay), `day ${dayOf(next, tz)}`);
		if (wallOf(next, tz) !== wall) {
			const p = zonedParts(next, tz);
			assert.throws(() => parseAt(`${p.y}-${pad(p.m)}-${pad(p.d)}T${wall}`, tz), /does not exist/);
		}
		assert.ok(dateOf(next, tz) > dateOf(due, tz), "one occurrence per local date");
		assert.ok(previous(rule, next, wall, tz, firstDay) <= Math.max(base, later), "no earlier qualifying day");
		assert.ok(next - base <= 7 * DAY + 3 * HOUR, "within a period");
		return true;
	});
});
