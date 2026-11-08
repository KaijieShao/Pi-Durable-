import type { TestContext } from "node:test";
import fc from "fast-check";

/** Run a fast-check property with a printed seed; `FC_SEED` reproduces a failure. */
export function check<T>(
	t: TestContext,
	arbitrary: fc.Arbitrary<T>,
	predicate: (value: T) => boolean | undefined,
	numRuns = 300,
): void {
	const seed =
		process.env.FC_SEED === undefined ? Date.now() ^ (Math.random() * 0x7fffffff) : Number(process.env.FC_SEED);
	t.diagnostic(`seed=${seed}`);
	fc.assert(fc.property(arbitrary, predicate), { seed, numRuns });
}
