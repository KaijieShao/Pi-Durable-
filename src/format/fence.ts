/** A fenced code block opener line, e.g. "```ts". */
export type FenceOpener = { readonly marker: string; readonly line: string; readonly lang: string };

const fenceLine = /^ {0,3}(`{3,}|~{3,})([^`]*)$/;

/** Opener of `line` when it starts a fence. */
export function parseFenceOpener(line: string): FenceOpener | undefined {
	const match = fenceLine.exec(line);
	if (match === null) return undefined;
	const marker = match[1] ?? "```";
	return { marker, line: line.trim(), lang: (match[2] ?? "").trim() };
}

/** Whether `line` closes a fence opened with `opener`. */
export function closesFence(line: string, opener: FenceOpener): boolean {
	const trimmed = line.trim();
	return trimmed.length >= opener.marker.length && /^(`+|~+)$/.test(trimmed) && trimmed[0] === opener.marker[0];
}

/** Fence state after reading `text` that starts in `state` (undefined: outside any fence). */
export function fenceStateAfter(text: string, state: FenceOpener | undefined): FenceOpener | undefined {
	let current = state;
	for (const line of text.split("\n")) {
		if (current === undefined) current = parseFenceOpener(line);
		else if (closesFence(line, current)) current = undefined;
	}
	return current;
}
