/** Untrusted app-domain transport proxy; launched by the host inside the app container, never in the grader. */
import { connect } from "node:net";

const path = process.argv[2] ?? "/scratch/app.sock",
	deadline = Date.now() + 20000;
function start() {
	const socket = connect(path);
	socket.once("connect", () => {
		process.stdin.pipe(socket);
		socket.pipe(process.stdout);
	});
	socket.once("error", () => {
		socket.destroy();
		if (Date.now() < deadline) setTimeout(start, 25);
		else process.exit(70);
	});
	socket.once("end", () => process.exit(0));
}
start();
