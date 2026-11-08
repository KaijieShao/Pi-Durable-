import { type Stt, SttError, type SttErrorKind, type Transcript } from "./stt.ts";

const ENDPOINT = "https://api.deepgram.com/v1/listen?model=nova-3&detect_language=true&smart_format=true";
const TIMEOUT_MS = 60_000;

type DeepgramResponse = {
	results?: { channels?: { detected_language?: string; alternatives?: { transcript?: string }[] }[] };
};

/** Deepgram prerecorded transcription (nova-3, language detection, smart formatting). */
export function createDeepgramStt(apiKey: string, fetchImpl: typeof fetch = fetch, endpoint = ENDPOINT): Stt {
	return {
		async transcribe(bytes, mime, signal): Promise<Transcript> {
			const combined = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
			let response: Response;
			try {
				response = await fetchImpl(endpoint, {
					method: "POST",
					headers: { Authorization: `Token ${apiKey}`, "Content-Type": mime },
					body: bytes,
					signal: combined,
				});
			} catch {
				throw new SttError("unavailable", "speech service unreachable");
			}
			if (!response.ok) throw new SttError(kindForStatus(response.status), `speech service HTTP ${response.status}`);
			return parseTranscript(await response.json().catch(() => undefined));
		},
	};
}

export function kindForStatus(status: number): SttErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 402 || status === 429) return "quota";
	if (status === 400 || status === 415 || status === 422) return "bad_audio";
	return "unavailable";
}

export function parseTranscript(body: unknown): Transcript {
	const channel = (body as DeepgramResponse | undefined)?.results?.channels?.[0];
	if (channel === undefined) throw new SttError("unavailable", "speech service returned no result");
	const text = (channel.alternatives?.[0]?.transcript ?? "").trim();
	const language = channel.detected_language;
	return language === undefined ? { text } : { text, language };
}
