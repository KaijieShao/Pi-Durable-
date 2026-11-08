// TEST ONLY (test/fixtures/systemd-run-shim.sh with STATE/detached-unit): plays a systemd-run client whose unit runs
// apart from it, as with real systemd, where the unit's process is started by PID 1 and is not in the client's process
// group. Usage: node detached-unit.mjs PIDFILE COMMAND ARGS...
//
// Starts COMMAND in its own session (so killing this client's process group does not reach it), with this process's
// stdin, stdout and stderr (like `--pipe`), records its pid in PIDFILE for the systemctl shim, then waits for it and
// exits with its code (like `--wait`).
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile, command, ...args] = process.argv.slice(2);
if (pidFile === undefined || command === undefined) {
	process.stderr.write("detached-unit: PIDFILE and COMMAND are required\n");
	process.exit(1);
}
const unit = spawn(command, args, { detached: true, stdio: "inherit" });
writeFileSync(pidFile, `${unit.pid}\n`);
unit.once("exit", (code, signal) => process.exit(code ?? (signal === null ? 1 : 137)));
unit.once("error", () => process.exit(1));
