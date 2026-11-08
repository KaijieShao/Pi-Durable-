// TEST ONLY stand-in for the runner (test/runner/systemd.test.ts): records what a Pi process started by the systemd
// launcher receives (its arguments, its whole environment and its first two stdin frames) into $HOME/recorded.json,
// then answers one `finished` frame and exits.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const lines = [];
const input = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
input.on("line", (line) => {
	lines.push(line);
	if (lines.length < 2) return;
	input.close();
	const record = { argv: process.argv.slice(2), env: { ...process.env }, cwd: process.cwd(), lines };
	writeFileSync(join(process.env.HOME ?? ".", "recorded.json"), JSON.stringify(record));
	const finished = {
		type: "finished",
		outcome: "answered",
		answer: "recorded",
		delivered: [],
		unconsumed: [],
		answered: [],
	};
	process.stdout.write(`${JSON.stringify(finished)}\n`, () => process.exit(0));
});
