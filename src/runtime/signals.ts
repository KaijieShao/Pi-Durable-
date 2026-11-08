import type { Logger } from "./log.ts";

export type Shutdown = (code: number, reason: string) => Promise<void>;

/**
 * Route SIGTERM/SIGINT and fatal errors into one shutdown. The first call runs `shutdown`; a second signal exits at
 * once with code 1; a watchdog exits with code 1 if shutdown hangs.
 */
export function createShutdownController(options: {
	readonly log: Logger;
	readonly shutdown: (code: number) => Promise<void>;
	readonly watchdogMs?: number;
	readonly exit?: (code: number) => void;
}): { trigger: Shutdown; install(): void } {
	const exit = options.exit ?? ((code: number) => process.exit(code));
	let started = false;
	const trigger: Shutdown = async (code, reason) => {
		if (started) {
			options.log.warn("shutdown_forced", { reason });
			exit(1);
			return;
		}
		started = true;
		options.log.info("shutdown", { reason, code });
		const watchdog = setTimeout(() => {
			options.log.error("shutdown_timeout");
			exit(1);
		}, options.watchdogMs ?? 20_000);
		watchdog.unref();
		try {
			await options.shutdown(code);
			exit(code);
		} catch (error) {
			options.log.error("shutdown_failed", { error });
			exit(1);
		}
	};
	const install = () => {
		process.on("SIGTERM", () => void trigger(0, "SIGTERM"));
		process.on("SIGINT", () => void trigger(0, "SIGINT"));
	};
	return { trigger, install };
}
