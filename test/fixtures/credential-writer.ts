// Child process for the cross-process mutex test: increments a counter credential N times.
import { FileCredentialStore } from "../../src/auth/credential-store.ts";

const [path, times] = process.argv.slice(2);
const store = new FileCredentialStore(path ?? "");
for (let i = 0; i < Number(times); i++) {
	await store.modify("count", async (current) => ({
		type: "api_key",
		key: String(Number(current?.type === "api_key" ? current.key : 0) + 1),
	}));
}
