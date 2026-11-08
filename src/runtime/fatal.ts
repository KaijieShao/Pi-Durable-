import { SessionFailed } from "@earendil-works/pi-durable";

/** Errors after which the Session cannot commit again; the process must restart and reopen it. */
export function isFatalHarnessError(error: unknown): boolean {
	return error instanceof SessionFailed;
}

/** Called when the service cannot continue; the CLI shuts down and exits with `exitCode` (default 1). */
export type FatalHandler = (reason: string, error?: unknown, exitCode?: number) => void;
