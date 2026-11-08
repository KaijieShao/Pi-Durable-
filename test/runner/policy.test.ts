import "../helpers/env.ts";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confinePath, describeCall, evaluateToolCall, toFsRequest } from "../../src/runner/policy.ts";
import { capToolResult, truncateUtf8 } from "../../src/runner/tools.ts";

const ops = { checkOps: ["test", "lint", "build"] } as const;

describe("confinePath", () => {
	it("accepts relative paths and normalizes them", () => {
		assert.deepEqual(confinePath("src/app.js"), { ok: true, path: "src/app.js" });
		assert.deepEqual(confinePath("./src//app.js"), { ok: true, path: "src/app.js" });
		assert.deepEqual(confinePath("a/./b/c.txt"), { ok: true, path: "a/b/c.txt" });
		assert.deepEqual(confinePath(".gitignore"), { ok: true, path: ".gitignore" });
		assert.deepEqual(confinePath("docs/.github/x.md"), { ok: true, path: "docs/.github/x.md" });
		assert.deepEqual(confinePath("ünïcode/naïve.txt"), { ok: true, path: "ünïcode/naïve.txt" });
	});

	const rejected: [string, unknown][] = [
		["absolute", "/etc/passwd"],
		["absolute proc alias", "/proc/self/root/etc/passwd"],
		["parent", "../x"],
		["parent inside", "src/../../x"],
		["parent at end", "src/.."],
		["git dir", ".git/config"],
		["git dir nested", "a/.git/HEAD"],
		["git dir upper case", ".GIT/config"],
		["git dir trailing dot", ".git./config"],
		["git dir trailing space", "a/.git /x"],
		["NUL", "a\0b"],
		["control char", "a\nb"],
		["zero-width joiner", ".g\u200dit/config"],
		["backslash", "src\\..\\..\\x"],
		["drive", "C:/Windows/x"],
		["home", "~/x"],
		["home user", "~root/.ssh/id_rsa"],
		["empty", ""],
		["root only", "./"],
		["dot only", "."],
		["not a string", 42],
		["undefined", undefined],
		["leading space segment", " src/x"],
		["decomposed unicode", "cafe\u0301.txt"],
		["too long", "a/".repeat(3000)],
		["segment too long", "x".repeat(300)],
	];
	for (const [name, path] of rejected) {
		it(`rejects ${name}`, () => {
			const decision = confinePath(path);
			assert.equal(decision.ok, false, `${JSON.stringify(path)} should be rejected`);
		});
	}
});

describe("evaluateToolCall", () => {
	it("allows the four tools with confined paths and normalizes arguments", () => {
		assert.deepEqual(evaluateToolCall("read", { path: "./a.js", offset: 3, limit: 10 }, ops), {
			allowed: true,
			call: { tool: "read", args: { path: "a.js", offset: 3, limit: 10 } },
		});
		assert.deepEqual(evaluateToolCall("write", { path: "new/file.txt", content: "" }, ops), {
			allowed: true,
			call: { tool: "write", args: { path: "new/file.txt", content: "" } },
		});
		assert.deepEqual(evaluateToolCall("edit", { path: "a.js", oldText: "x", newText: "y", replaceAll: true }, ops), {
			allowed: true,
			call: { tool: "edit", args: { path: "a.js", oldText: "x", newText: "y", replaceAll: true } },
		});
		assert.deepEqual(evaluateToolCall("run_check", { operation: "test" }, ops), {
			allowed: true,
			call: { tool: "run_check", args: { operation: "test" } },
		});
	});

	it("denies every other tool", () => {
		for (const name of ["bash", "shell", "exec", "Read", "git", "", "__proto__", 7]) {
			const decision = evaluateToolCall(name, { path: "a" }, ops);
			assert.equal(decision.allowed, false, `${String(name)} should be denied`);
		}
	});

	it("denies unlisted run_check operations and everything when the list is empty", () => {
		assert.equal(evaluateToolCall("run_check", { operation: "deploy" }, ops).allowed, false);
		assert.equal(evaluateToolCall("run_check", { operation: "test; rm -rf /" }, ops).allowed, false);
		assert.equal(evaluateToolCall("run_check", { operation: ["test"] }, ops).allowed, false);
		assert.equal(evaluateToolCall("run_check", { operation: "test" }, { checkOps: [] }).allowed, false);
	});

	it("denies bad paths and malformed arguments", () => {
		const cases: [string, unknown][] = [
			["read", { path: "../secret" }],
			["read", { path: "/etc/passwd" }],
			["write", { path: ".git/hooks/pre-commit", content: "x" }],
			["edit", { path: "a\0b", oldText: "x", newText: "y" }],
			["read", { path: "a.js", offset: -1 }],
			["read", { path: "a.js", limit: 0 }],
			["read", { path: "a.js", limit: 1.5 }],
			["read", { path: "a.js", extra: true }],
			["write", { path: "a.js" }],
			["write", { path: "a.js", content: 5 }],
			["write", { path: "a.js", content: "x".repeat(1024 * 1024 + 1) }],
			["edit", { path: "a.js", oldText: "", newText: "y" }],
			["edit", { path: "a.js", oldText: "x", newText: "y", replaceAll: "yes" }],
			["read", null],
			["read", ["a.js"]],
			["read", "a.js"],
		];
		for (const [name, args] of cases) {
			const decision = evaluateToolCall(name, args, ops);
			assert.equal(decision.allowed, false, `${name} ${JSON.stringify(args)?.slice(0, 80)} should be denied`);
			if (!decision.allowed) assert.ok(decision.reason.length > 0);
		}
	});

	it("fails closed when arguments throw on access", () => {
		const hostile = {
			get path(): string {
				throw new Error("boom");
			},
		};
		assert.equal(evaluateToolCall("read", hostile, ops).allowed, false);
	});

	it("maps allowed file calls to container file operations", () => {
		const read = evaluateToolCall("read", { path: "a.js" }, ops);
		assert.ok(read.allowed);
		assert.deepEqual(toFsRequest(read.call), { op: "read", path: "a.js" });
		const check = evaluateToolCall("run_check", { operation: "lint" }, ops);
		assert.ok(check.allowed);
		assert.equal(toFsRequest(check.call), undefined);
		assert.equal(describeCall(check.call), "run_check lint");
	});
});

describe("tool result cap", () => {
	it("keeps results within the cap and marks truncation", () => {
		const small = { output: [{ type: "text" as const, text: "hello" }] };
		assert.equal(capToolResult(small, 100), small);
		const big = capToolResult({ output: [{ type: "text", text: "x".repeat(1000) }], isError: true }, 100);
		const text = big.output?.[0]?.type === "text" ? big.output[0].text : "";
		assert.ok(Buffer.byteLength(text) <= 100);
		assert.match(text, /\[truncated: \d+ bytes dropped\]$/);
		assert.equal(big.isError, true);
	});

	it("never splits a multi-byte character", () => {
		assert.equal(truncateUtf8("héllo", 2), "h");
		assert.equal(truncateUtf8("€€€", 4), "€");
		const capped = capToolResult({ output: [{ type: "text", text: "€".repeat(500) }] }, 64);
		const text = capped.output?.[0]?.type === "text" ? capped.output[0].text : "";
		assert.ok(Buffer.byteLength(text) <= 64);
		assert.ok(!text.includes("\uFFFD"));
	});
});
