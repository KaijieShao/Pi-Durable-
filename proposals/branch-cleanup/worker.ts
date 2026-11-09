/** Independent housekeeping. Coordinator databases are opened read-only, never migrated or updated. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { CleanupFailure, type Config, type Evidence, type Job, type Result, runOne } from "./policy.ts";

type Legacy = { branch: string; taskId: number; prNumber: number; reviewedHead: string; mergeCommit: string };
export type Source = {
	repository: string;
	database: string;
	taskDir: string;
	taskPrefix: string;
	secretId: string;
	/** Only for an explicitly authorized, independently verified archive snapshot from another host. */
	archiveAttestation?: { databaseSha256: string; archivedBranches: readonly string[] };
	approvedLegacy?: readonly Legacy[];
};
export type WorkerConfig = { stateDir: string; policy: Config; sources: readonly Source[] };
type TaskMeta = {
	id: number;
	state: string;
	archived: number;
	worktree_path: string | null;
	head_commit: string | null;
	posted_head: string | null;
	tests_passed_head: string | null;
	pr_number: number | null;
	branch: string | null;
};
type MergeMeta = { state: string; head_commit: string; merge_commit: string; approval_id: number };
export type Candidate = { job: Job; source: Source };
type RepositoryInfo = { default_branch: string };
type PullInfo = {
	number: number;
	merged: boolean;
	merged_at: string | null;
	merge_commit_sha: string;
	head: { ref: string; sha: string };
	base: { ref: string; repo: { full_name: string } };
};
type RefInfo = { object: { sha: string } };
type Counts = Pick<Evidence["task"], "activeRuns" | "heldSlots" | "unsettledEffects" | "pendingMergeIntents">;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PREFIX = /^[A-Za-z0-9._-]+\/$/;

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve ordered validation and journal recovery gates for audit.
export function validateConfig(c: WorkerConfig): void {
	if (
		!isAbsolute(c.stateDir) ||
		!Array.isArray(c.sources) ||
		!["disabled", "dry-run", "enabled"].includes(c.policy.mode)
	)
		throw new Error("invalid-cleanup-config");
	for (const s of c.sources) {
		if (
			!REPO.test(s.repository) ||
			!isAbsolute(s.database) ||
			!isAbsolute(s.taskDir) ||
			!PREFIX.test(s.taskPrefix) ||
			!/^[A-Za-z0-9_-]+$/.test(s.secretId)
		)
			throw new Error("invalid-cleanup-source");
		if (resolve(s.database).startsWith(`${resolve(c.stateDir)}/`))
			throw new Error("source-database-is-not-cleanup-journal");
		for (const a of s.approvedLegacy ?? [])
			if (
				a.branch !== s.taskPrefix + a.taskId ||
				!SHA.test(a.reviewedHead) ||
				!SHA.test(a.mergeCommit) ||
				a.prNumber < 1
			)
				throw new Error("invalid-explicit-legacy-approval");
	}
}
function openSource(path: string): DatabaseSync {
	const db = new DatabaseSync(path, { readOnly: true });
	db.exec("PRAGMA query_only=ON");
	return db;
}
const taskColumns = "id,state,archived,worktree_path,head_commit,posted_head,tests_passed_head,pr_number,branch";
function taskOf(db: DatabaseSync, id: number): TaskMeta | undefined {
	return db.prepare(`SELECT ${taskColumns} FROM tasks WHERE id=?`).get(id) as TaskMeta | undefined;
}

export function candidates(source: Source): { jobs: Candidate[]; retained: Record<string, number> } {
	const db = openSource(source.database);
	const jobs: Candidate[] = [];
	const retained: Record<string, number> = {};
	try {
		for (const t of db.prepare(`SELECT ${taskColumns} FROM tasks ORDER BY id`).all() as TaskMeta[]) {
			if (
				t.state !== "merged" ||
				t.archived !== 1 ||
				t.worktree_path !== null ||
				t.branch !== source.taskPrefix + t.id ||
				t.pr_number === null
			) {
				retained[t.state] = (retained[t.state] ?? 0) + 1;
				continue;
			}
			const merges = db
				.prepare(
					"SELECT state,head_commit,merge_commit,approval_id FROM merge_intents WHERE task_id=? AND state='merged'",
				)
				.all(t.id) as MergeMeta[];
			if (merges.length !== 1 || !t.head_commit || !merges[0]?.merge_commit) {
				retained["missing-unique-merge-evidence"] = (retained["missing-unique-merge-evidence"] ?? 0) + 1;
				continue;
			}
			const m = merges[0];
			const key = [source.repository, t.branch, t.pr_number, m.head_commit, m.merge_commit].join(":");
			jobs.push({
				source,
				job: {
					key,
					repository: source.repository,
					taskId: t.id,
					branch: t.branch,
					prNumber: t.pr_number,
					reviewedHead: m.head_commit,
					mergeCommit: m.merge_commit,
					attempts: 0,
				},
			});
		}
		return { jobs, retained };
	} finally {
		db.close();
	}
}

/** The activation cutoff is waived only for the exact tuple separately authorized for historical cleanup. */
export function policyFor(candidate: Candidate, policy: Config): Config {
	const { job: j, source: s } = candidate;
	const legacy = (s.approvedLegacy ?? []).some(
		(a) =>
			a.taskId === j.taskId &&
			a.branch === j.branch &&
			a.prNumber === j.prNumber &&
			a.reviewedHead === j.reviewedHead &&
			a.mergeCommit === j.mergeCommit,
	);
	return { ...policy, repository: s.repository, taskPrefix: s.taskPrefix, ...(legacy ? { notBeforeMs: 1 } : {}) };
}

export class GitHubReads {
	readonly repository: string;
	private readonly token: string;
	private readonly fetcher: typeof fetch;
	constructor(repository: string, token: string, fetcher: typeof fetch = fetch) {
		this.repository = repository;
		this.token = token;
		this.fetcher = fetcher;
	}
	async get<T>(path: string, allowAbsent = false): Promise<T> {
		let r: Response;
		try {
			r = await this.fetcher(`https://api.github.com/repos/${this.repository}${path ? `/${path}` : ""}`, {
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(15000),
			});
		} catch {
			throw new CleanupFailure("transient");
		}
		if (r.status === 404 && allowAbsent) return null as T;
		if (!r.ok) throw new CleanupFailure(r.status === 401 || r.status === 403 ? "denied" : "transient");
		return (await r.json()) as T;
	}
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve ordered validation and journal recovery gates for audit.
	async evidence(candidate: Candidate): Promise<Evidence> {
		const { source, job } = candidate;
		const db = openSource(source.database);
		let t: TaskMeta;
		let m: MergeMeta;
		let counts: Counts;
		try {
			const task = taskOf(db, job.taskId);
			if (!task) throw new Error("missing-task");
			t = task;
			const merges = db
				.prepare(
					"SELECT state,head_commit,merge_commit,approval_id FROM merge_intents WHERE task_id=? AND state='merged'",
				)
				.all(job.taskId) as MergeMeta[];
			if (merges.length !== 1) throw new Error("nonunique-merge");
			const merged = merges[0];
			if (!merged) throw new Error("missing-merge");
			m = merged;
			const approved = db
				.prepare("SELECT head_commit FROM approvals WHERE id=? AND task_id=? AND state='consumed'")
				.get(m.approval_id, job.taskId) as { head_commit: string } | undefined;
			if (
				!approved ||
				approved.head_commit !== job.reviewedHead ||
				t.head_commit !== t.posted_head ||
				t.head_commit !== t.tests_passed_head
			)
				throw new Error("immutable-approval-evidence-mismatch");
			const count = (sql: string) => Number((db.prepare(sql).get(job.taskId) as { n: number }).n);
			counts = {
				activeRuns: count(
					"SELECT COUNT(*) n FROM runs WHERE task_id=? AND state IN ('queued','starting','running','finalizing')",
				),
				heldSlots: count("SELECT COUNT(*) n FROM slots WHERE task_id=?"),
				unsettledEffects: count(
					"SELECT COUNT(*) n FROM effect_intents WHERE task_id=? AND state IN ('pending','unresolved')",
				),
				pendingMergeIntents: count("SELECT COUNT(*) n FROM merge_intents WHERE task_id=? AND state='pending'"),
			};
		} finally {
			db.close();
		}
		let absent = false;
		if (source.archiveAttestation) {
			const digest = createHash("sha256")
				.update(await readFile(source.database))
				.digest("hex");
			absent =
				digest === source.archiveAttestation.databaseSha256 &&
				source.archiveAttestation.archivedBranches.includes(job.branch);
		} else {
			const expected = join(source.taskDir, "worktrees", `task-${job.taskId}`);
			absent = !(await stat(expected).then(
				() => true,
				(err) => {
					if (err.code === "ENOENT") return false;
					throw err;
				},
			));
		}
		const [repo, pr, ref, open] = await Promise.all([
			this.get<RepositoryInfo>(""),
			this.get<PullInfo>(`pulls/${job.prNumber}`),
			this.get<RefInfo | null>(`git/ref/heads/${encodeURIComponent(job.branch)}`, true),
			this.get<unknown[]>(
				"pulls?state=open&head=" +
					encodeURIComponent(`${job.repository.split("/")[0]}:${job.branch}`) +
					"&per_page=100",
			),
		]);
		const [compare, headCommit, mergeCommit] = await Promise.all([
			this.get<{ status: string }>(`compare/${job.mergeCommit}...${encodeURIComponent(repo.default_branch)}`),
			this.get<{ sha: string }>(`git/commits/${job.reviewedHead}`),
			this.get<{ sha: string }>(`git/commits/${job.mergeCommit}`),
		]);
		if (typeof repo.default_branch !== "string") throw new Error("repository-identity-unavailable");
		if (headCommit.sha !== job.reviewedHead || mergeCommit.sha !== job.mergeCommit)
			throw new Error("commit-recovery-evidence-mismatch");
		const branch =
			ref === null ? null : await this.get<{ protected?: boolean }>(`branches/${encodeURIComponent(job.branch)}`);
		return {
			task: {
				id: t.id,
				state: t.state,
				archived: t.archived === 1,
				worktreePath: t.worktree_path,
				worktreeAbsent: absent,
				head: t.head_commit ?? "",
				...counts,
			},
			intent: { state: m.state, approvedHead: m.head_commit, mergeCommit: m.merge_commit },
			pr: {
				repository: pr.base?.repo?.full_name,
				number: pr.number,
				merged: pr.merged === true,
				mergedAtMs: Date.parse(pr.merged_at ?? ""),
				headRef: pr.head?.ref,
				headSha: pr.head?.sha,
				baseRef: pr.base?.ref,
				mergeSha: pr.merge_commit_sha,
			},
			defaultBranch: repo.default_branch,
			mergeReachableFromBase: ["ahead", "identical"].includes(compare.status),
			openPrsUsingHead: Array.isArray(open) ? open.length : 1,
			remote: {
				state: ref === null ? "absent" : "present",
				sha: ref?.object?.sha ?? null,
				protected: branch === null ? null : typeof branch.protected === "boolean" ? branch.protected : null,
			},
		};
	}
}

type CommandResult = { code: number; stdout: string; stderr: string };
async function command(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const p = spawn("git", argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let out = "",
			err = "";
		p.stdout.on("data", (b) => {
			if (out.length < 65536) out += b.toString();
		});
		p.stderr.on("data", (b) => {
			if (err.length < 65536) err += b.toString();
		});
		const timer = setTimeout(() => p.kill("SIGKILL"), 45000);
		p.once("error", () => {
			clearTimeout(timer);
			reject(new CleanupFailure("unknown"));
		});
		p.once("close", (code) => {
			clearTimeout(timer);
			resolve({ code: code ?? -1, stdout: out, stderr: err });
		});
	});
}

/** Git's expected-old-SHA lease is enforced by the receive-pack ref transaction; no unconditional DELETE API. */
export async function deleteWithLease(
	remoteUrl: string,
	fullRef: string,
	expected: string,
	token: string,
	gitDir: string,
): Promise<void> {
	if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(fullRef) || !SHA.test(expected)) throw new CleanupFailure("denied");
	await mkdir(gitDir, { recursive: true, mode: 0o700 });
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: gitDir,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_TRACE: "0",
		GIT_CURL_VERBOSE: "0",
		LC_ALL: "C",
		GIT_CONFIG_COUNT: "2",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
		GIT_CONFIG_KEY_1: "credential.helper",
		GIT_CONFIG_VALUE_1: "",
	};
	try {
		if (!existsSync(join(gitDir, "HEAD"))) {
			const init = await command(["init", "--bare", gitDir], env, gitDir);
			if (init.code !== 0) throw new CleanupFailure("transient");
		}
		const r = await command(
			[
				"--git-dir",
				gitDir,
				"push",
				"--porcelain",
				`--force-with-lease=${fullRef}:${expected}`,
				remoteUrl,
				`:${fullRef}`,
			],
			env,
			gitDir,
		);
		if (r.code === 0) return;
		if (/stale info|\[rejected\]|cannot lock ref|failed to update ref/i.test(`${r.stdout}\n${r.stderr}`))
			throw new CleanupFailure("changed");
		if (/protected|permission|authentication|403|401|denied/i.test(r.stderr)) throw new CleanupFailure("denied");
		throw new CleanupFailure("unknown");
	} finally {
		delete env.GIT_CONFIG_VALUE_0;
		delete env.GIT_CONFIG_VALUE_1;
	}
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve ordered validation and journal recovery gates for audit.
export async function runWorker(
	config: WorkerConfig,
	tokenForSecret: (id: string) => Promise<string>,
	log: (x: unknown) => void = console.log,
): Promise<void> {
	validateConfig(config);
	if (config.policy.mode === "disabled") {
		log({ event: "branch_cleanup_disabled" });
		return;
	}
	await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(join(config.stateDir, "cleanup.sqlite"));
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cleanup_jobs(job_key TEXT PRIMARY KEY,job TEXT NOT NULL,result TEXT NOT NULL,checked_at INTEGER NOT NULL,deleted_at INTEGER)",
	);
	try {
		for (const source of config.sources) {
			const found = candidates(source);
			log({
				event: "branch_cleanup_scan",
				repository: source.repository,
				database: source.database,
				retained: found.retained,
				candidates: found.jobs.length,
			});
			let reads: GitHubReads | undefined;
			let token: string | undefined;
			for (const candidate of found.jobs) {
				const previous = db.prepare("SELECT result FROM cleanup_jobs WHERE job_key=?").get(candidate.job.key) as
					| { result: string }
					| undefined;
				const prior = previous ? (JSON.parse(previous.result) as Result) : undefined;
				if (prior && ["deleted", "already-absent", "needs-attention", "kept"].includes(prior.state)) continue;
				if (prior?.nextAttemptAtMs && prior.nextAttemptAtMs > Date.now()) continue;
				const job = { ...candidate.job, attempts: prior?.attempts ?? 0 };
				const policy = policyFor(candidate, config.policy);
				if (!token) {
					try {
						token = await tokenForSecret(source.secretId);
						reads = new GitHubReads(source.repository, token);
					} catch {
						log({ event: "branch_cleanup_credential_unavailable", repository: source.repository });
						break;
					}
				}
				const result = await runOne(
					job,
					{
						now: Date.now,
						readEvidence: () => {
							if (!reads) throw new Error("missing-reader");
							return reads.evidence({ ...candidate, job });
						},
						deleteRemoteRefWithLease: (_repo, ref, sha) =>
							deleteWithLease(
								`https://github.com/${source.repository}.git`,
								ref,
								sha,
								token ?? "",
								join(config.stateDir, "git", createHash("sha256").update(source.repository).digest("hex").slice(0, 16)),
							),
						async record(j, r) {
							db.exec("BEGIN IMMEDIATE");
							try {
								db.prepare(
									"INSERT INTO cleanup_jobs(job_key,job,result,checked_at,deleted_at) VALUES(?,?,?,?,?) ON CONFLICT(job_key) DO UPDATE SET result=excluded.result,checked_at=excluded.checked_at,deleted_at=COALESCE(cleanup_jobs.deleted_at,excluded.deleted_at)",
								).run(
									j.key,
									JSON.stringify(j),
									JSON.stringify(r),
									Date.now(),
									["deleted", "already-absent"].includes(r.state) ? Date.now() : null,
								);
								db.exec("COMMIT");
							} catch (e) {
								db.exec("ROLLBACK");
								throw e;
							}
						},
					},
					policy,
				);
				log({
					event: "branch_cleanup_result",
					repository: source.repository,
					task: job.taskId,
					branch: job.branch,
					pr: job.prNumber,
					head: job.reviewedHead,
					merge: job.mergeCommit,
					...result,
				});
			}
		}
	} finally {
		db.close();
	}
}

async function googleSecret(id: string): Promise<string> {
	const m = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", {
		headers: { "Metadata-Flavor": "Google" },
		signal: AbortSignal.timeout(10000),
	});
	if (!m.ok) throw new Error("metadata-unavailable");
	const identity = (await m.json()) as { access_token: string };
	const project = process.env.GOOGLE_CLOUD_PROJECT;
	if (!project || !/^[A-Za-z0-9_-]+$/.test(project)) throw new Error("project-not-configured");
	const r = await fetch(
		`https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${id}/versions/latest:access`,
		{ headers: { Authorization: `Bearer ${identity.access_token}` }, signal: AbortSignal.timeout(10000) },
	);
	if (!r.ok) throw new Error("credential-unavailable");
	const p = (await r.json()) as { payload: { data: string } };
	return Buffer.from(p.payload.data, "base64").toString("utf8");
}

async function main() {
	const args = process.argv.slice(2);
	const at = args.indexOf("--config");
	const configPath = at < 0 ? undefined : args[at + 1];
	if (!configPath) throw new Error("config-required");
	const config = JSON.parse(await readFile(resolve(configPath), "utf8")) as WorkerConfig;
	validateConfig(config);
	if (args.includes("--report")) {
		const path = join(config.stateDir, "cleanup.sqlite");
		if (!existsSync(path)) {
			console.log(JSON.stringify({ jobs: [] }));
			return;
		}
		const db = new DatabaseSync(path, { readOnly: true });
		try {
			db.exec("PRAGMA query_only=ON");
			console.log(JSON.stringify({ jobs: db.prepare("SELECT * FROM cleanup_jobs ORDER BY checked_at DESC").all() }));
		} finally {
			db.close();
		}
		return;
	}
	await runWorker(config, googleSecret, (x) => console.log(JSON.stringify(x)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main().catch(() => {
		console.error("branch_cleanup_worker_failed; task states unchanged; sensitive error details suppressed");
		process.exitCode = 1;
	});
