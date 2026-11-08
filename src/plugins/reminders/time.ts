/** Wall-clock math in an IANA time zone, to the minute, with `Intl` only. */

export type Every = "daily" | "weekdays" | "weekly" | number;
export type Local = { y: number; m: number; d: number; hh: number; mm: number };
export type Schedule = { readonly every?: Every; readonly wall: string; readonly tz: string };

const MINUTE = 60_000;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const formats = new Map<string, Intl.DateTimeFormat>();
const pad = (n: number): string => String(n).padStart(2, "0");
const weekday = (t: Pick<Local, "y" | "m" | "d">): number => new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay();

export function validZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return tz !== "";
	} catch {
		return false;
	}
}

export const serverZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

function format(tz: string): Intl.DateTimeFormat {
	let found = formats.get(tz);
	if (found === undefined) {
		const two = "2-digit" as const;
		const fields = { year: "numeric", month: two, day: two, hour: two, minute: two } as const;
		found = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...fields });
		formats.set(tz, found);
	}
	return found;
}

/** The wall-clock minute of `ms` in `tz`. */
export function zonedParts(ms: number, tz: string): Local {
	const parts = Object.fromEntries(
		format(tz)
			.formatToParts(new Date(ms))
			.map((p) => [p.type, Number(p.value)]),
	);
	return {
		y: parts.year ?? 0,
		m: parts.month ?? 0,
		d: parts.day ?? 0,
		hh: (parts.hour ?? 0) % 24,
		mm: parts.minute ?? 0,
	};
}

const asUtc = (t: Local): number => Date.UTC(t.y, t.m - 1, t.d, t.hh, t.mm);
const offsetAt = (ms: number, tz: string): number => asUtc(zonedParts(ms, tz)) - Math.floor(ms / MINUTE) * MINUTE;

/** The instant of a wall-clock minute; a time inside a forward DST gap lands after the gap. */
export function zonedToUtc(local: Local, tz: string): number {
	const wanted = asUtc(local);
	const first = wanted - offsetAt(wanted, tz);
	return wanted - offsetAt(first, tz);
}

export const sameLocal = (a: Local, b: Local): boolean =>
	a.y === b.y && a.m === b.m && a.d === b.d && a.hh === b.hh && a.mm === b.mm;

/** `YYYY-MM-DD HH:MM[:SS]`, local in `tz` unless it ends with `Z` or an offset. Throws a message for the model. */
export function parseAt(text: string, tz: string): number {
	const match = LOCAL.exec(text.trim());
	if (match === null) throw new Error(`at must look like 2026-10-15T09:00, not ${JSON.stringify(text)}`);
	const [y, m, d, hh, mm] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
	const local = { y, m, d, hh, mm };
	const offset = match[7];
	if (offset !== undefined) {
		const zone = offset.toUpperCase() === "Z" ? "Z" : `${offset.slice(0, 3)}:${offset.slice(-2)}`;
		const ms = Date.parse(`${match.slice(1, 4).join("-")}T${pad(hh)}:${pad(mm)}:00${zone}`);
		if (Number.isNaN(ms)) throw new Error(`at is not a valid date-time: ${text}`);
		return Math.floor(ms / MINUTE) * MINUTE;
	}
	const ms = zonedToUtc(local, tz);
	if (!sameLocal(zonedParts(ms, tz), local)) throw new Error(`${text} does not exist in ${tz} (a clock change)`);
	return ms;
}

/** `daily`, `weekdays`, `weekly` or a whole number of minutes, at least 5. Throws a message for the model. */
export function parseEvery(text: string): Every {
	const value = text.trim().toLowerCase();
	if (value === "daily" || value === "weekdays" || value === "weekly") return value;
	if (/^\d{1,6}$/.test(value) && Number(value) >= 5) return Number(value);
	throw new Error(`every must be daily, weekdays, weekly or a number of minutes from 5, not ${JSON.stringify(text)}`);
}

/** `HH:MM` of `ms` in `tz`: the wall time daily, weekday and weekly reminders keep. */
export function wallOf(ms: number, tz: string): string {
	const t = zonedParts(ms, tz);
	return `${pad(t.hh)}:${pad(t.mm)}`;
}

/** `Thu 2026-10-15 09:00`. */
export function formatLocal(ms: number, tz: string): string {
	const t = zonedParts(ms, tz);
	return `${DAY_NAMES[weekday(t)]} ${t.y}-${pad(t.m)}-${pad(t.d)} ${pad(t.hh)}:${pad(t.mm)}`;
}

const dayKey = (t: Local): number => t.y * 10_000 + t.m * 100 + t.d;

function fits(every: Every, day: number, firstDay: number): boolean {
	if (every === "weekdays") return day >= 1 && day <= 5;
	return every === "weekly" ? day === firstDay : true;
}

/**
 * The first occurrence after both `due` and `now`, or undefined for a one-shot. Missed occurrences collapse into it:
 * an interval stays aligned to `due`, calendar repeats keep `wall` in the schedule's zone.
 */
export function nextOccurrence(schedule: Schedule, due: number, now: number): number | undefined {
	const { every, wall, tz } = schedule;
	if (every === undefined) return undefined;
	if (typeof every === "number") {
		const step = every * MINUTE;
		return due + Math.max(1, Math.floor((now - due) / step) + 1) * step;
	}
	const [hh, mm] = wall.split(":").map(Number) as [number, number];
	const start = zonedParts(Math.max(due, now), tz);
	const dueDay = zonedParts(due, tz);
	const firstDay = weekday(dueDay);
	// One occurrence per local date: the repeated hour of a fall-back day must not bring due's own date back.
	for (let i = dayKey(start) === dayKey(dueDay) ? 1 : 0; i <= 8; i++) {
		const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
		const local = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), hh, mm };
		const ms = zonedToUtc(local, tz);
		if (fits(every, weekday(local), firstDay) && ms > due && ms > now) return ms;
	}
	return undefined;
}
