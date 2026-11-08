/** Untrusted full-Node application, the container's main workload. Native standard streams are untouched. */
import { spawn } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { deserialize, serialize } from "node:v8";

const snapshot = process.argv[2] ?? "/eval/snapshot",
	scratch = process.argv[3] ?? "/scratch";
const project = join(scratch, "project"),
	socket = process.argv[4] ?? join(scratch, "app.sock");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
function copyTree(source, target) {
	const entry = lstatSync(source);
	if (entry.isSymbolicLink()) return symlinkSync(readlinkSync(source), target);
	if (entry.isFile()) return writeFileSync(target, readFileSync(source), { mode: entry.mode & 0o111 ? 0o755 : 0o644 });
	if (!entry.isDirectory()) return undefined;
	mkdirSync(target, { mode: 0o755 });
	for (const name of readdirSync(source)) copyTree(join(source, name), join(target, name));
	return undefined;
}

mkdirSync(scratch, { recursive: true });
rmSync(project, { recursive: true, force: true });
copyTree(snapshot, project);
process.chdir(project);
async function evaluate(value) {
	const require = createRequire(join(project, "__app_entry__.cjs"));
	const importModule = async (path) => {
		const target = resolve(project, path);
		if (target.endsWith(".mjs")) return import(pathToFileURL(target).href);
		try {
			return require(target);
		} catch (error) {
			if (["ERR_REQUIRE_ESM", "ERR_REQUIRE_ASYNC_MODULE"].includes(error?.code))
				return import(pathToFileURL(target).href);
			throw error;
		}
	};
	return new AsyncFunction("require", "importModule", "input", "cwd", value.code)(
		require,
		importModule,
		value.input,
		project,
	);
}

function execute(value) {
	return new Promise((resolveResult, reject) => {
		if (!Array.isArray(value.argv) || value.argv.length === 0) return reject(new Error("missing command"));
		const child = spawn(value.argv[0], value.argv.slice(1), {
			cwd: project,
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout = [],
			stderr = [];
		let bytes = 0;
		const append = (target, chunk) => {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) child.kill("SIGKILL");
			else target.push(chunk);
		};
		child.stdout.on("data", (chunk) => append(stdout, chunk));
		child.stderr.on("data", (chunk) => append(stderr, chunk));
		child.on("error", reject);
		child.on("close", (exitCode, signal) =>
			resolveResult({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }),
		);
		child.stdin.end(value.input ?? "");
	});
}

rmSync(socket, { force: true });
createServer((connection) => {
	const respond = (event) => connection.write(`\u001ePDAPP3 ${JSON.stringify(event)}\n`);
	createInterface({ input: connection }).on("line", async (line) => {
		let message;
		try {
			message = JSON.parse(line);
			const value = deserialize(Buffer.from(message.payload, "base64"));
			const result = message.op === "exec" ? await execute(value) : await evaluate(value);
			respond({ id: message.id, ok: true, payload: serialize(result).toString("base64") });
		} catch (error) {
			respond({ id: message?.id, ok: false, error: String(error?.message ?? "application error").slice(0, 4096) });
		}
	});
	connection.on("error", () => {});
	respond({ ready: true });
}).listen(socket);
