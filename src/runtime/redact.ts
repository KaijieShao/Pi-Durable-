/** Last line of defense: masks secrets in any string before it is logged. */
const patterns: readonly [RegExp, string][] = [
	// Bot API URLs carry the token after "bot".
	[/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, "bot<redacted>"],
	// Bare bot tokens.
	[/\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g, "<redacted-bot-token>"],
	// Anthropic keys and OAuth tokens.
	[/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-<redacted>"],
	// Generic provider keys.
	[/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-<redacted>"],
	// Authorization headers.
	[/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>"],
	// JSON or query fields that name a secret.
	[
		/("?(?:access_token|refresh_token|api_key|apiKey|token|refresh|access|password|secret)"?\s*[:=]\s*"?)[^"\s,&}]{6,}/gi,
		"$1<redacted>",
	],
];

export function redact(text: string): string {
	let result = text;
	for (const [pattern, replacement] of patterns) result = result.replace(pattern, replacement);
	return result;
}
