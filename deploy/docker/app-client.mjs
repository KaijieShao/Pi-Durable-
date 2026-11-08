/** Trusted hidden-test client. Expected values/assertions stay here; app observations are never test outcomes. */
import { deserialize, serialize } from "node:v8";

const pending = new Map();
let next = 0;
let infrastructureFailed = false;
export const hadInfrastructureFailure = () => infrastructureFailed;
function infrastructureFailure() {
	infrastructureFailed = true;
	try {
		process.send?.({ kind: "infrastructure_failure" });
	} catch {
		/* missing final IPC report still fails closed */
	}
}
process.on("message", (message) => {
	if (message?.kind !== "rpc_result") return;
	const reply = pending.get(message.id);
	if (reply === undefined) return;
	pending.delete(message.id);
	if (pending.size === 0) process.channel?.unref();
	if (message.ok !== true) {
		if (message.infrastructure === true) infrastructureFailure();
		return reply.reject(new Error(message.error ?? "application observation failed"));
	}
	try {
		reply.resolve(deserialize(Buffer.from(message.payload, "base64")));
	} catch {
		infrastructureFailure();
		reply.reject(new Error("invalid application observation"));
	}
});

process.channel?.unref();

function request(op, value) {
	if (process.send === undefined) {
		infrastructureFailure();
		return Promise.reject(new Error("app client requires the trusted test runner"));
	}
	return new Promise((resolve, reject) => {
		const id = ++next;
		pending.set(id, { resolve, reject });
		process.channel?.ref();
		try {
			const payload = serialize(value).toString("base64");
			if (payload.length > 4 * 1024 * 1024) throw new Error("request exceeds transport bound");
			process.send({ kind: "rpc", id, op, payload }, (error) => {
				if (error === null || error === undefined) return;
				infrastructureFailure();
				pending.delete(id);
				if (pending.size === 0) process.channel?.unref();
				reject(new Error("application transport failed"));
			});
		} catch {
			infrastructureFailure();
			pending.delete(id);
			if (pending.size === 0) process.channel?.unref();
			reject(new Error("application request could not be sent"));
		}
	});
}

export const app = Object.freeze({
	/** Full asynchronous Node code, in the app container only; return values use V8 structured serialization. */
	evaluate: (code, input) => request("evaluate", { code, input }),
	call: (module, name, args = []) =>
		request("evaluate", {
			code: "const m = await importModule(input.module); const value = m[input.name]; return typeof value === 'function' ? await Reflect.apply(value,m,input.args) : value;",
			input: { module, name, args },
		}),
	/** Spawns a process in the app container, never on the host or in the trusted test container. */
	exec: (argv, options = {}) => request("exec", { argv, ...options }),
	/** Actual host-side file evidence from app scratch, opened with pinned directory FDs and O_NOFOLLOW. */
	readFile: (path) => request("read_file", { path }),
});
