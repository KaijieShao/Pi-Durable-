/**
 * Trusted host broker. Candidate stdout is an observation transport only, never a grading/report stream.
 * Unexpected app EOF/exit or invalid RPC latches subjectFailed independently of hidden-test assertions.
 */
import { type ChildProcessWithoutNullStreams, execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deserialize, serialize } from "node:v8";

const PREFIX = "\u001ePDAPP3 ";
const MAX_BYTES = 4 * 1024 * 1024;
const PYTHON = fileURLToPath(new URL("../../../deploy/docker/inspect-eval-file.py", import.meta.url));
const ENV = { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", PYTHONNOUSERSITE: "1" };

type Reply = {
	type: "rpc_result";
	id: number;
	ok: boolean;
	payload?: string;
	error?: string;
	infrastructure?: boolean;
};
export type EvaluationProcess = {
	readonly child: ChildProcessWithoutNullStreams;
	/** Separate app-domain proxy; primary process standard streams remain native. */
	readonly transport?: ChildProcessWithoutNullStreams;
	/** Subject scratch only, never shared with the trusted process. */
	readonly scratch: string;
	/** Stop the whole process/container and verify it gone before another subject is launched. */
	stop(): Promise<boolean>;
};
export type PairResult = {
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly subjectFailed: boolean;
	readonly timedOut: boolean;
	readonly aborted: boolean;
	readonly failed: boolean;
};

class ObserverUnavailable extends Error {}
class EvidenceUnavailable extends Error {}

function python(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"python3",
			["-I", "-S", ...args],
			{ env: ENV, timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
			(error, stdout) => {
				if (error !== null) reject(new ObserverUnavailable("trusted file observer unavailable"));
				else resolve(stdout);
			},
		);
	});
}

/** An explicit host dependency, checked before any grading is admitted. */
export async function fileObserverAvailable(): Promise<void> {
	const version = await python([
		"-c",
		"import os; assert os.open in os.supports_dir_fd; assert hasattr(os, 'O_NOFOLLOW'); print('ready')",
	]);
	if (version.trim() !== "ready") throw new Error("Python3 openat file observer is unavailable");
}

export type DecodedEvidence = { kind: "data"; bytes: Buffer } | { kind: "refused" } | { kind: "infrastructure" };
/** Fixed helper taxonomy: operational errors can never masquerade as a successful negative filesystem check. */
export function decodeFileEvidence(text: string): DecodedEvidence {
	try {
		const result = JSON.parse(text) as { ok?: unknown; kind?: unknown; data?: unknown };
		if (result.ok === false && ["missing", "unsafe", "not_regular"].includes(result.kind as string))
			return { kind: "refused" };
		if (result.ok !== true || typeof result.data !== "string") return { kind: "infrastructure" };
		const bytes = Buffer.from(result.data, "base64");
		return bytes.toString("base64") === result.data ? { kind: "data", bytes } : { kind: "infrastructure" };
	} catch {
		return { kind: "infrastructure" };
	}
}
async function observeFile(root: string, payload: string): Promise<string> {
	// The request originates only in the trusted grader. Candidate values are not deserialized on the host.
	const request = deserialize(Buffer.from(payload, "base64")) as { path?: unknown };
	if (typeof request?.path !== "string") throw new ObserverUnavailable("invalid file observation request");
	const result = decodeFileEvidence(await python([PYTHON, join(root, "project"), request.path]));
	if (result.kind === "refused") throw new EvidenceUnavailable("file evidence unavailable or unsafe");
	if (result.kind !== "data") throw new ObserverUnavailable("trusted file observer failed");
	return serialize(result.bytes).toString("base64");
}

function response(id: number, value: unknown): Reply {
	return { type: "rpc_result", id, ok: true, payload: serialize(value).toString("base64") };
}

function failure(id: number, infrastructure = true): Reply {
	return {
		type: "rpc_result",
		id,
		ok: false,
		infrastructure,
		error: "application transport or file evidence unavailable",
	};
}

type Ready = { ready: true };
function appFrame(line: string): Ready | Reply {
	const value = JSON.parse(line) as Record<string, unknown>;
	if (value.ready === true) return { ready: true };
	if (!Number.isSafeInteger(value.id) || typeof value.ok !== "boolean") throw new Error("invalid app frame");
	if (value.ok && (typeof value.payload !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.payload)))
		throw new Error("invalid payload");
	return {
		type: "rpc_result",
		id: value.id as number,
		ok: value.ok,
		payload: value.payload as string | undefined,
		error: typeof value.error === "string" ? value.error.slice(0, 4096) : undefined,
	};
}

function framed(buffer: string): { frames: string[]; rest: string } {
	const frames: string[] = [];
	for (;;) {
		const start = buffer.indexOf(PREFIX);
		if (start < 0) return { frames, rest: buffer.slice(-PREFIX.length) };
		buffer = buffer.slice(start);
		const end = buffer.indexOf("\n", PREFIX.length);
		if (end < 0) return { frames, rest: buffer };
		frames.push(buffer.slice(PREFIX.length, end));
		buffer = buffer.slice(end + 1);
	}
}
function exited(child: ChildProcessWithoutNullStreams): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

class SubjectChannel {
	private buffer = "";
	private nextId = 0;
	private ready = false;
	private stopped = false;
	private closed = false;
	private resolveReady: (ok: boolean) => void = () => {};
	private readonly waiting = new Map<number, (reply: Reply) => void>();
	readonly readiness: Promise<boolean>;
	private readonly transport: ChildProcessWithoutNullStreams;
	readonly process: EvaluationProcess;
	private readonly broken: () => void;
	constructor(process: EvaluationProcess, broken: () => void) {
		this.process = process;
		this.broken = broken;
		this.transport = process.transport ?? process.child;
		this.readiness = new Promise((resolve) => {
			this.resolveReady = resolve;
		});
		this.attach();
	}
	private attach(): void {
		if (this.transport !== this.process.child) {
			this.process.child.stdout.resume();
			this.process.child.stderr.resume();
		}
		this.transport.stdout.on("data", (chunk) => this.consume(chunk));
		this.transport.stderr.resume();
		for (const child of new Set([this.transport, this.process.child])) {
			child.on("error", () => this.breakChannel());
			child.on("close", () => this.breakChannel());
		}
		this.transport.stdin.on("error", () => this.breakChannel());
		this.transport.stdout.on("end", () => this.breakChannel());
	}
	private breakChannel(): void {
		if (this.closed) return;
		this.closed = true;
		if (!this.stopped) this.broken();
		this.resolveReady(false);
		for (const [id, reply] of this.waiting) reply(failure(id));
		this.waiting.clear();
		void this.process.stop().then(
			(ok) => {
				if (!ok) this.broken();
			},
			() => this.broken(),
		);
	}
	private receive(line: string): void {
		const value = appFrame(line);
		if ("ready" in value) {
			if (this.ready) throw new Error("duplicate readiness");
			this.ready = true;
			this.resolveReady(true);
			return;
		}
		const reply = this.waiting.get(value.id);
		if (reply === undefined) throw new Error("unexpected response");
		this.waiting.delete(value.id);
		reply(value);
	}
	private consume(chunk: Buffer): void {
		if (this.closed) return;
		try {
			this.buffer += chunk.toString("utf8");
			if (this.buffer.length > MAX_BYTES) throw new Error("output bound");
			const batch = framed(this.buffer);
			this.buffer = batch.rest;
			for (const line of batch.frames) this.receive(line);
		} catch {
			this.breakChannel();
		}
	}
	async request(op: string, payload: string): Promise<Reply> {
		if (!(await this.readiness) || this.closed || this.stopped || exited(this.process.child)) return failure(0);
		return new Promise((resolve) => {
			const id = ++this.nextId;
			this.waiting.set(id, resolve);
			this.transport.stdin.write(`${JSON.stringify({ id, op, payload })}\n`);
		});
	}
	async stop(): Promise<boolean> {
		if (!this.stopped && (exited(this.process.child) || exited(this.transport) || this.transport.stdout.readableEnded))
			this.broken();
		this.stopped = true;
		this.breakChannel();
		return this.process.stop();
	}
}

type PairOptions = {
	readonly grader: EvaluationProcess;
	readonly launchSubject: () => Promise<EvaluationProcess>;
	readonly deadlineMs: number;
	readonly signal?: AbortSignal;
	/** Code-only trusted test dependency; never selectable through environment or application data. */
	readonly fileObserver?: (root: string, payload: string) => Promise<string>;
};
type Request = { id: number; op: string; payload: string };
function trustedRequest(value: Record<string, unknown>): Request {
	if (
		!Number.isSafeInteger(value.id) ||
		typeof value.payload !== "string" ||
		value.payload.length > MAX_BYTES ||
		typeof value.op !== "string"
	)
		throw new Error("invalid trusted request");
	return { id: value.id as number, op: value.op, payload: value.payload };
}

class PairBroker {
	private subject: SubjectChannel | undefined;
	private subjectFailed = false;
	private failed = false;
	private timedOut = false;
	private aborted = false;
	private stopping = false;
	private stdout = "";
	private buffer = "";
	private launching: Promise<EvaluationProcess> | undefined;
	private stopPromise: Promise<void> | undefined;
	private resets = Promise.resolve();
	private readonly options: PairOptions;
	constructor(options: PairOptions) {
		this.options = options;
	}
	private send(reply: Reply): void {
		if (!this.stopping && !this.options.grader.child.stdin.destroyed)
			this.options.grader.child.stdin.write(`${JSON.stringify(reply)}\n`);
	}
	private broken(): void {
		this.subjectFailed = true;
	}
	private async useCreated(created: EvaluationProcess): Promise<void> {
		if (this.stopping) {
			if (!(await created.stop())) this.failed = true;
			throw new Error("stopping");
		}
		this.subject = new SubjectChannel(created, () => this.broken());
		if (!(await this.subject.readiness)) throw new Error("app startup unverified");
	}
	private async reset(): Promise<void> {
		if (this.subject !== undefined && !(await this.subject.stop())) {
			this.failed = true;
			throw new Error("unverified stop");
		}
		if (this.stopping) throw new Error("stopping");
		this.launching = this.options.launchSubject();
		const created = await this.launching;
		this.launching = undefined;
		await this.useCreated(created);
	}
	private async observe(request: Request): Promise<Reply> {
		if (this.subject === undefined) throw new Error("app unavailable");
		if (request.op === "read_file")
			return {
				type: "rpc_result",
				id: request.id,
				ok: true,
				payload: await (this.options.fileObserver ?? observeFile)(this.subject.process.scratch, request.payload),
			};
		if (!["evaluate", "exec"].includes(request.op)) throw new Error("unsupported operation");
		return { ...(await this.subject.request(request.op, request.payload)), id: request.id };
	}
	private async dispatch(request: Request): Promise<Reply> {
		if (request.op === "subject_failure") {
			this.broken();
			return response(request.id, true);
		}
		if (request.op === "reset") {
			await this.reset();
			return response(request.id, true);
		}
		return this.observe(request);
	}
	private async rpc(message: Record<string, unknown>): Promise<void> {
		try {
			this.send(await this.dispatch(trustedRequest(message)));
		} catch (error) {
			const business = error instanceof EvidenceUnavailable;
			if (!business) this.failed = true;
			this.send(failure(message.id as number, !business));
		}
	}
	private line(line: string): void {
		const message = JSON.parse(line) as Record<string, unknown>;
		if (message.type === "rpc") {
			if (message.op === "reset") this.resets = this.resets.then(() => this.rpc(message));
			else void this.rpc(message);
			return;
		}
		if (this.stdout.length + line.length > MAX_BYTES) throw new Error("report bound");
		this.stdout += `${line}\n`;
	}
	private consume(chunk: Buffer): void {
		try {
			this.buffer += chunk.toString("utf8");
			if (this.buffer.length > MAX_BYTES) throw new Error("report bound");
			const lines = this.buffer.split("\n");
			this.buffer = lines.pop() ?? "";
			for (const line of lines) this.line(line);
		} catch {
			this.failed = true;
			void this.stop();
		}
	}
	private async terminate(): Promise<void> {
		this.stopping = true;
		const tasks = [this.options.grader.stop()];
		if (this.subject !== undefined) tasks.push(this.subject.stop());
		if (this.launching !== undefined) tasks.push(this.launching.then((created) => created.stop()));
		const results = await Promise.allSettled(tasks);
		if (results.some((result) => result.status !== "fulfilled" || result.value !== true)) this.failed = true;
	}
	private stop(): Promise<void> {
		this.stopPromise ??= this.terminate();
		return this.stopPromise;
	}
	private async ended(): Promise<number | undefined> {
		const child = this.options.grader.child;
		return new Promise((resolve) => {
			child.on("error", () => {
				this.failed = true;
				resolve(undefined);
			});
			child.on("close", (code) => resolve(code ?? undefined));
		});
	}
	private noteTail(): void {
		if (this.buffer.trim() !== "") {
			this.failed = true;
			this.stdout += this.buffer;
		}
		if (this.subject !== undefined && exited(this.subject.process.child) && !this.stopping) this.broken();
	}
	async run(): Promise<PairResult> {
		const child = this.options.grader.child;
		child.stdout.on("data", (chunk) => this.consume(chunk));
		child.stderr.resume();
		child.stdin.on("error", () => {
			this.failed = true;
		});
		const abort = () => {
			this.aborted = true;
			void this.stop();
		};
		const timer = setTimeout(() => {
			this.timedOut = true;
			void this.stop();
		}, this.options.deadlineMs);
		this.options.signal?.addEventListener("abort", abort, { once: true });
		if (this.options.signal?.aborted) abort();
		const exitCode = await this.ended();
		clearTimeout(timer);
		this.options.signal?.removeEventListener("abort", abort);
		this.noteTail();
		await this.stop();
		return {
			exitCode,
			stdout: this.stdout,
			subjectFailed: this.subjectFailed,
			failed: this.failed,
			timedOut: this.timedOut,
			aborted: this.aborted,
		};
	}
}
export const runEvaluationPair = (options: PairOptions): Promise<PairResult> => new PairBroker(options).run();
