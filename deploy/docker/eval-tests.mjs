/** Trusted full-Node test process. It never mounts or imports candidate source. Reports travel on private IPC. */
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { run } from "node:test";
import { hadInfrastructureFailure } from "./app-client.mjs";

const { root, tests, files } = JSON.parse(process.argv[2]);
const executedTests = [],
	passedTests = [];
let invalid = false,
	summary;
const events = run({ files, isolation: "none", concurrency: 1 });
for await (const event of events) {
	if (event.type === "test:summary") summary = event.data;
	if (!["test:pass", "test:fail"].includes(event.type) || event.data.details?.type === "suite") continue;
	const data = event.data;
	const file = typeof data.file === "string" ? relative(realpathSync(root), data.file) : "";
	const matches = tests.filter(
		(test) => test.file === file && test.name === data.name && (test.line === undefined || test.line === data.line),
	);
	if (matches.length !== 1) {
		invalid = true;
		continue;
	}
	const id = matches[0].id;
	if (executedTests.includes(id) || passedTests.includes(id)) {
		invalid = true;
		continue;
	}
	if (data.skip) {
		invalid = true;
		continue;
	}
	executedTests.push(id);
	if (event.type === "test:pass" && !data.todo) passedTests.push(id);
	else invalid = true;
}
const counts = summary?.counts;
const complete =
	!invalid &&
	!hadInfrastructureFailure() &&
	summary?.success === true &&
	counts?.tests === tests.length &&
	counts?.passed === tests.length &&
	counts?.failed === 0 &&
	counts?.cancelled === 0 &&
	counts?.skipped === 0 &&
	counts?.todo === 0 &&
	executedTests.length === tests.length &&
	passedTests.length === tests.length;
process.send?.({ kind: "test_result", complete, executedTests, passedTests });
process.exitCode = complete ? 0 : 1;
process.disconnect?.();
