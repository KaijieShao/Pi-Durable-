/** Only the CLI opts out of Node's SQLite experimental notice; other warnings remain observable. */
const original = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...details: unknown[]) => {
	const message = typeof warning === "string" ? warning : warning.message;
	const options = details[0];
	const type =
		warning instanceof Error
			? warning.name
			: typeof options === "string"
				? options
				: typeof options === "object" && options !== null
					? (options as { type?: string }).type
					: undefined;
	if (type === "ExperimentalWarning" && /^SQLite is an experimental feature(?:\b|$)/.test(message)) return;
	Reflect.apply(original, process, [warning, ...details]);
}) as typeof process.emitWarning;
