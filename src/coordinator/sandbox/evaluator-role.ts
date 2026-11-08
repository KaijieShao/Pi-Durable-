/** One Docker role in an evaluation. Lifecycle and stop evidence come from Docker, never the app's reports. */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Logger } from "../../runtime/log.ts";
import type { Limits } from "../limits.ts";
import { DOCKER_START_MS, dockerEnv, hardeningArgs, runDocker } from "./docker.ts";
import type { EvaluationProcess } from "./evaluator-broker.ts";
import { createScratch, removeScratch, sleep } from "./limits-text.ts";

type Role = "grader" | "app";
type State = { started: boolean; running: boolean; exitCode: number | undefined; oomKilled: boolean };
export type RoleEvidence = {
	graderStarted: boolean;
	unexpectedSubjectExit: boolean;
	stateFailed: boolean;
	cleanupFailed: boolean;
};
export type RoleContext = {
	bin: string;
	imageId: string;
	user: string;
	limits: Limits;
	log: Logger;
	trial: string;
	snapshot: string;
	hidden: string;
	scratchRoot: string;
	deadlineMs: number;
	startedAt: number;
	evidence: RoleEvidence;
};
const liveChild = (child: ChildProcessWithoutNullStreams): boolean =>
	child.exitCode === null && child.signalCode === null;
const docker = (c: RoleContext, args: string[]) => runDocker(c.bin, args, { timeoutMs: DOCKER_START_MS });

async function stateOf(c: RoleContext, name: string): Promise<State | undefined> {
	const output = await docker(c, ["container", "inspect", "--format", "{{json .State}}", name]);
	if (output.code !== 0) return undefined;
	try {
		const state = JSON.parse(output.stdout) as {
			StartedAt?: string;
			Running?: boolean;
			ExitCode?: number;
			OOMKilled?: boolean;
		};
		return {
			started: typeof state.StartedAt === "string" && !state.StartedAt.startsWith("0001-"),
			running: state.Running === true,
			exitCode: state.ExitCode,
			oomKilled: state.OOMKilled === true,
		};
	} catch {
		return undefined;
	}
}

function argsOf(c: RoleContext, role: Role, name: string, scratch: string): string[] {
	const source = role === "grader" ? c.hidden : c.snapshot,
		destination = role === "grader" ? "/eval/hidden" : "/eval/snapshot";
	return [
		"run",
		"-i",
		"--name",
		name,
		"--label",
		"pi-durable.managed=1",
		"--label",
		"pi-durable.kind=evaluator",
		"--label",
		`pi-durable.trial=${c.trial}`,
		"--label",
		`pi-durable.eval-role=${role}`,
		...hardeningArgs({
			user: c.user,
			cpus: c.limits.evaluatorCpus / 2,
			memoryMiB: Math.floor(c.limits.evaluatorMemoryMiB / 2),
			pids: Math.floor(c.limits.evaluatorPids / 2),
		}),
		"--init",
		"--mount",
		`type=bind,src=${source},dst=${destination},readonly`,
		"--mount",
		`type=bind,src=${scratch},dst=/scratch`,
		"-e",
		"HOME=/scratch",
		"-e",
		"TMPDIR=/scratch",
		"-e",
		`PI_EVAL_DEADLINE_MS=${Math.max(1, c.deadlineMs - (Date.now() - c.startedAt)) + 5000}`,
		"-w",
		"/scratch",
		c.imageId,
		"node",
		role === "grader" ? "/opt/pi-eval/run-eval.mjs" : "/opt/pi-eval/eval-app.mjs",
	];
}

async function proxyFor(
	c: RoleContext,
	name: string,
	child: ChildProcessWithoutNullStreams,
): Promise<ChildProcessWithoutNullStreams> {
	const deadline = Date.now() + DOCKER_START_MS;
	while (Date.now() < deadline) {
		if ((await stateOf(c, name))?.running === true)
			return spawn(c.bin, ["exec", "-i", name, "node", "/opt/pi-eval/eval-proxy.mjs"], {
				stdio: ["pipe", "pipe", "pipe"],
				env: dockerEnv(),
				shell: false,
			});
		if (!liveChild(child)) throw new Error("application did not start");
		await sleep(25);
	}
	throw new Error("application startup could not be confirmed");
}

function recordState(
	c: RoleContext,
	role: Role,
	child: ChildProcessWithoutNullStreams,
	state: State | undefined,
): void {
	if (role === "grader") c.evidence.graderStarted = state?.started === true;
	if (state === undefined || state.oomKilled) c.evidence.stateFailed = true;
	if (role === "app" && (state?.running !== true || !liveChild(child))) c.evidence.unexpectedSubjectExit = true;
}

async function killSubject(c: RoleContext, name: string): Promise<void> {
	const killed = await docker(c, ["kill", "--signal", "SIGKILL", name]);
	if (killed.code !== 0) c.evidence.unexpectedSubjectExit = true;
	const deadline = Date.now() + 5000;
	let state = await stateOf(c, name);
	while (state?.running === true && Date.now() < deadline) {
		await sleep(25);
		state = await stateOf(c, name);
	}
	if (state === undefined || state.running || state.exitCode !== 137) c.evidence.unexpectedSubjectExit = true;
}

async function gone(c: RoleContext, name: string): Promise<boolean> {
	const listed = await docker(c, ["ps", "-a", "--format", "{{.Names}}", "--filter", `name=^/${name}$`]);
	return listed.code === 0 && listed.stdout.trim() === "";
}

function killClient(child: ChildProcessWithoutNullStreams | undefined): void {
	if (child !== undefined && liveChild(child)) child.kill("SIGKILL");
}

async function removeRole(
	c: RoleContext,
	name: string,
	child: ChildProcessWithoutNullStreams,
	transport: ChildProcessWithoutNullStreams | undefined,
): Promise<boolean> {
	await docker(c, ["rm", "-f", name]);
	killClient(child);
	killClient(transport);
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		await docker(c, ["rm", "-f", name]);
		if (await gone(c, name)) return true;
		await sleep(100);
	}
	c.evidence.cleanupFailed = true;
	return false;
}

async function wipeRole(c: RoleContext, name: string, scratch: string): Promise<boolean> {
	if (await removeScratch(scratch)) return true;
	const cleanup = `${name}-clean`;
	const limits = hardeningArgs({
		user: c.user,
		cpus: c.limits.evaluatorCpus / 2,
		memoryMiB: Math.min(256, Math.floor(c.limits.evaluatorMemoryMiB / 2)),
		pids: Math.floor(c.limits.evaluatorPids / 2),
	});
	const args = [
		"run",
		"--rm",
		"--name",
		cleanup,
		"--label",
		"pi-durable.managed=1",
		"--label",
		"pi-durable.kind=evaluator",
		"--label",
		`pi-durable.trial=${c.trial}`,
		"--label",
		"pi-durable.eval-role=cleanup",
		...limits,
		"--mount",
		`type=bind,src=${scratch},dst=/scratch`,
		c.imageId,
		"find",
		"/scratch",
		"-mindepth",
		"1",
		"-delete",
	];
	const output = await docker(c, args);
	return output.code === 0 && (await gone(c, cleanup)) && (await removeScratch(scratch));
}

async function stopRole(
	c: RoleContext,
	role: Role,
	name: string,
	child: ChildProcessWithoutNullStreams,
	transport: ChildProcessWithoutNullStreams | undefined,
	scratch: string,
): Promise<boolean> {
	const state = await stateOf(c, name);
	recordState(c, role, child, state);
	if (role === "app" && transport !== undefined && !liveChild(transport)) c.evidence.unexpectedSubjectExit = true;
	if (role === "app" && state?.running === true) await killSubject(c, name);
	const stopped = await removeRole(c, name, child, transport);
	if (!stopped) return false;
	return wipeRole(c, name, scratch);
}

export async function launchEvaluationRole(c: RoleContext, role: Role): Promise<EvaluationProcess> {
	const scratch = await createScratch(c.scratchRoot, c.user),
		name = `pd-e-${role}-${randomBytes(6).toString("hex")}`;
	const child = spawn(c.bin, argsOf(c, role, name, scratch), {
		stdio: ["pipe", "pipe", "pipe"],
		env: dockerEnv(),
		shell: false,
	});
	child.on("error", () => {
		c.evidence.stateFailed = true;
	});
	let transport: ChildProcessWithoutNullStreams | undefined;
	try {
		if (role === "app") transport = await proxyFor(c, name, child);
	} catch (error) {
		await stopRole(c, role, name, child, undefined, scratch);
		throw error;
	}
	let stopPromise: Promise<boolean> | undefined;
	const stop = (): Promise<boolean> => {
		stopPromise ??= stopRole(c, role, name, child, transport, scratch);
		return stopPromise;
	};
	c.log.info("evaluator_role_started", { trial: c.trial, role, container: name });
	return { child, scratch, stop, ...(transport === undefined ? {} : { transport }) };
}
