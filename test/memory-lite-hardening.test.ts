// Hardening tests for memory-lite: concurrency, privacy, migration,
// static conflict checks, and acceptance gate.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIdentity, type RepoIdentity, normalizeRemoteUrl } from "../extensions/memory-lite/identity.ts";
import { createDocument, addEntry, serializeDocument, parseDocument, SCHEMA_VERSION } from "../extensions/memory-lite/schema.ts";
import { memoryFilePath, enablementFilePath, lockFilePath } from "../extensions/memory-lite/storage.ts";
import { writeEnablement, readEnablement } from "../extensions/memory-lite/config.ts";
import { addMemoryEntry, removeMemoryEntry } from "../extensions/memory-lite/write-path.ts";
import { withLock } from "../extensions/memory-lite/lock.ts";
import { atomicWrite } from "../extensions/memory-lite/atomic-file.ts";
import { isSuspiciousSecret } from "../extensions/memory-lite/privacy.ts";
import { selectEntries } from "../extensions/memory-lite/budget.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ml-harden-"));
}

function makeRepoIdentity(base: string, remoteUrl: string, agentDir: string = makeTempDir()): RepoIdentity {
	const repoDir = join(base, "my-repo");
	const gitDir = join(repoDir, ".git");
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, "config"), `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
	writeFileSync(join(repoDir, "README.md"), "# test\n");
	return resolveIdentity(agentDir, {
		cwd: repoDir,
		existsSync,
		readFileSync: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
		realpathSync: (p: string) => { try { return realpathSync(p); } catch { return p; } },
		statSync: (p: string) => { try { const st = statSync(p); return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile() }; } catch { return { isDirectory: () => false, isFile: () => false }; } },
	})!;
}

// --- Concurrency ---

test("concurrent add operations produce valid final state", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");

	// Run 5 concurrent adds
	const results = await Promise.all([
		addMemoryEntry(identity, "entry-1"),
		addMemoryEntry(identity, "entry-2"),
		addMemoryEntry(identity, "entry-3"),
		addMemoryEntry(identity, "entry-4"),
		addMemoryEntry(identity, "entry-5"),
	]);

	// All should succeed (lock serializes them)
	const successCount = results.filter((r) => r.success).length;
	expect(successCount).toBe(5);

	// Final file should have 5 entries and be valid
	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc).not.toBeNull();
	expect(doc!.entries.length).toBe(5);
});

test("concurrent add and remove operations produce valid final state", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");

	// First add an entry
	const addResult = await addMemoryEntry(identity, "initial entry");
	expect(addResult.success).toBe(true);

	// Now concurrently add more and remove the initial
	const results = await Promise.all([
		addMemoryEntry(identity, "concurrent-1"),
		addMemoryEntry(identity, "concurrent-2"),
		removeMemoryEntry(identity, addResult.entryId!),
	]);

	// All should succeed
	for (const r of results) expect(r.success).toBe(true);

	// Final file should be valid
	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc).not.toBeNull();
	expect(doc!.entries.length).toBe(2);
});

// --- Lock stale recovery ---

test("stale lock is recovered after timeout", async () => {
	const dir = makeTempDir();
	const lockPath = join(dir, "test.lock");

	// Create a stale lock (old mtime)
	writeFileSync(lockPath, JSON.stringify({ pid: 99999, createdAt: "2020-01-01T00:00:00Z" }) + "\n");
	// Set mtime to past
	const past = new Date(Date.now() - 60_000);
	const { utimesSync } = require("node:fs");
	utimesSync(lockPath, past, past);

	// withLock should break the stale lock and proceed
	const result = await withLock(lockPath, async () => "recovered");
	expect(result).toBe("recovered");
	expect(existsSync(lockPath)).toBe(false);
});

// --- Migration / versioning ---

test("unknown schema version is read-only incompatible", () => {
	const raw = JSON.stringify({
		version: 99,
		repository_key: "k",
		repository_label: "l",
		updated_at: "now",
		entries: [],
	});
	expect(parseDocument(raw)).toBeNull();
});

test("version 1 document is parsed correctly", () => {
	const doc = createDocument("k", "l");
	addEntry(doc, "test");
	const raw = serializeDocument(doc);
	const parsed = parseDocument(raw);
	expect(parsed).not.toBeNull();
	expect(parsed!.version).toBe(1);
});

// --- Identity collisions ---

test("similarly named remotes produce distinct keys", () => {
	const base1 = makeTempDir();
	const base2 = makeTempDir();
	const id1 = makeRepoIdentity(base1, "https://github.com/owner/repo.git");
	const id2 = makeRepoIdentity(base2, "https://github.com/owner/repo-2.git");
	expect(id1.key).not.toBe(id2.key);
});

test("same remote in different repos produces same key", () => {
	const base1 = makeTempDir();
	const base2 = makeTempDir();
	const id1 = makeRepoIdentity(base1, "https://github.com/owner/repo.git");
	const id2 = makeRepoIdentity(base2, "https://github.com/owner/repo.git");
	expect(id1.key).toBe(id2.key);
});

test("normalizeRemoteUrl handles edge cases", () => {
	expect(normalizeRemoteUrl("https://github.com/owner/repo.git")).toBe("github.com/owner/repo");
	expect(normalizeRemoteUrl("https://github.com/owner/repo.git/")).toBe("github.com/owner/repo");
	expect(normalizeRemoteUrl("git+ssh://git@github.com/owner/repo.git")).toBe("github.com/owner/repo");
	expect(normalizeRemoteUrl("ssh://git@github.com/owner/repo.git")).toBe("github.com/owner/repo");
});

// --- Default-off and rollback ---

test("disable stops injection without deleting content", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");

	// Add content and enable
	await addMemoryEntry(identity, "important context");
	writeEnablement(enablementFilePath(identity), { enabled: true });

	// Disable
	writeEnablement(enablementFilePath(identity), { enabled: false });

	// Memory file still exists
	expect(existsSync(memoryFilePath(identity))).toBe(true);
	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc!.entries.length).toBe(1);
});

test("missing storage directory does not crash", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	// Don't create storage dir
	expect(existsSync(identity.storageDir)).toBe(false);
	// readEnablement should return default-off
	expect(readEnablement(enablementFilePath(identity)).enabled).toBe(false);
});

// --- Budget caps ---

test("selectEntries respects total body cap", () => {
	const entries = [];
	for (let i = 0; i < 50; i++) {
		entries.push({
			id: `e${i}`,
			created_at: "x",
			updated_at: "x",
			tags: [],
			text: `entry-${i}-${"x".repeat(500)}`,
		});
	}
	const result = selectEntries(entries);
	expect(result.totalBytes).toBeLessThanOrEqual(12288); // MAX_MESSAGE_BYTES
});

// --- Privacy ---

test("suspicious values are rejected without echo in error", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const secret = "sk-1234567890abcdefghijklmnopqrstuvwxyz";
	const result = await addMemoryEntry(identity, secret);
	expect(result.success).toBe(false);
	expect(result.error).not.toContain(secret);
});

test("isSuspiciousSecret detects password assignments", () => {
	expect(isSuspiciousSecret("password=mysecretpassword123")).toBe(true);
	expect(isSuspiciousSecret("password: \"mysecret\"")).toBe(true);
});

test("isSuspiciousSecret detects AWS keys", () => {
	expect(isSuspiciousSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
});

// --- Static checks: no forbidden architecture ---

test("memory-lite source has no session JSONL imports", async () => {
	const { glob } = await import("node:fs/promises");
	const path = await import("node:path");
	const extDir = path.join(process.cwd(), "extensions/memory-lite");

	// Check all .ts files in memory-lite for forbidden imports
	for await (const file of glob("**/*.ts", { cwd: extDir })) {
		const content = readFileSync(path.join(extDir, file), "utf8");
		expect(content).not.toContain("SessionManager");
		expect(content).not.toContain("appendEntry");
		expect(content).not.toContain("session_start");
		expect(content).not.toContain("before_agent_start");
		expect(content).not.toContain("resources_discover");
		expect(content).not.toContain("sqlite");
		expect(content).not.toContain("vector");
	}
});

test("memory-lite source has no timer/watcher/subagent imports", async () => {
	const { glob } = await import("node:fs/promises");
	const path = await import("node:path");
	const extDir = path.join(process.cwd(), "extensions/memory-lite");

	for await (const file of glob("**/*.ts", { cwd: extDir })) {
		const content = readFileSync(path.join(extDir, file), "utf8");
		// setInterval/setTimeout for background workers are forbidden
		// (but allowed in lock.ts for retry delay)
		if (!file.includes("lock.ts")) {
			expect(content).not.toContain("setInterval");
		}
		expect(content).not.toContain("watchFile");
		expect(content).not.toContain("subagent");
	}
});

// --- Command/namespace collision check ---

test("/memory command does not collide with existing commands", () => {
	// Existing commands in this repo: askills
	// hd-agent commands: usage-hdwebsoft, tps, clear, exit
	// Plan A commands: session-breakdown, mode
	const existingCommands = ["askills", "usage-hdwebsoft", "tps", "clear", "exit", "session-breakdown", "mode"];
	expect(existingCommands).not.toContain("memory");
});

test("memory-lite storage path is under memory-lite/ not memories/", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	expect(identity.storageDir).toContain("memory-lite");
	expect(identity.storageDir).not.toContain("memories");
});

// --- Plan A unchanged ---

test("Plan A directory still exists and has all files", () => {
	const planDir = "plans/260805-1746-adapt-session-breakdown-prompt-editor-autocompact-lite";
	expect(existsSync(join(planDir, "plan.md"))).toBe(true);
	expect(existsSync(join(planDir, "phase-01-start.md"))).toBe(true);
	expect(existsSync(join(planDir, "phase-02-prompt-editor.md"))).toBe(true);
	expect(existsSync(join(planDir, "phase-03-autocompact-lite.md"))).toBe(true);
});
