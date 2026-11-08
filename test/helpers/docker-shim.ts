/**
 * TEST ONLY: a docker CLI stand-in for the watchdog's container reaper (test/fixtures/docker-shim.sh): containers are
 * files with their labels, `ps` filters by label, `rm -f` deletes. Production code has no knob for it: tests point
 * DOCKER_BIN (or the reaper's `bin`) at the wrapper script. Every container here belongs to this stand-in only, so a
 * test never touches a real container.
 */
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("../fixtures/docker-shim.sh", import.meta.url));

export type DockerShim = {
	/** The wrapper script to use as DOCKER_BIN. */
	readonly bin: string;
	/** A container with these labels (pi-durable.managed=1 unless given); returns its id. */
	addContainer(labels: Readonly<Record<string, string | number>>): Promise<string>;
	/** Ids of the containers that exist. */
	containers(): string[];
	/** Every call so far, as one argument string each. */
	calls(): Promise<string[]>;
	/** `ps-fails`: listing fails (daemon unreachable). `rm-misses`: removal does nothing. */
	set(flag: "ps-fails" | "rm-misses", on: boolean): Promise<void>;
};

let nextId = 1;

export async function createDockerShim(dir: string): Promise<DockerShim> {
	const state = join(dir, "state");
	const containersDir = join(state, "containers");
	await mkdir(containersDir, { recursive: true });
	const bin = join(dir, "docker");
	if (`${bin}${state}${FIXTURE}`.includes("'")) throw new Error("shim paths must not contain quotes");
	await writeFile(bin, `#!/bin/sh\nexec /bin/sh '${FIXTURE}' '${state}' "$@"\n`);
	await chmod(bin, 0o755);
	return {
		bin,
		async addContainer(labels) {
			const id = `${(nextId++).toString(16).padStart(12, "0")}${"ab".repeat(26)}`;
			const lines = Object.entries({ "pi-durable.managed": 1, ...labels }).map(([key, value]) => `${key}=${value}`);
			await writeFile(join(containersDir, id), `${lines.join("\n")}\n`);
			return id;
		},
		containers: () => (existsSync(containersDir) ? readdirSync(containersDir).sort() : []),
		calls: async () =>
			(await readFile(join(state, "docker.argv"), "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
		async set(flag, on) {
			const path = join(state, flag);
			if (on) await writeFile(path, "");
			else await rm(path, { force: true });
		},
	};
}
