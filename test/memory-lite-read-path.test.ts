// Unit tests for memory-lite read path: bounded injection, dedupe,
// fail-open, default-off, and context composition.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
	resolveIdentity,
	type RepoIdentity,
} from "../extensions/memory-lite/identity.ts";
import {
	createDocument,
	addEntry,
	serializeDocument,
} from "../extensions/memory-lite/schema.ts";
import { memoryFilePath, enablementFilePath } from "../extensions/memory-lite/storage.ts";
import { writeEnablement } from "../extensions/memory-lite/config.ts";
import { freshRead, makeContextHandler } from "../extensions/memory-lite/read-path.ts";
import { selectEntries, MAX_TOTAL_BODY_BYTES } from "../extensions/memory-lite/budget.ts";
import { formatStatusText, rateLimitedWarning, type MemoryStatus } from "../extensions/memory-lite/status.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ml-rp-test-"));
}

function makeRepoIdentity(base: string, remoteUrl: string, agentDir: string = makeTempDir()): RepoIdentity {
	const repoDir = join(base, "my-repo");
	const gitDir = join(repoDir, ".git");
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(gitDir, "config"), `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
	writeFileSync(join(repoDir, "README.md"), "# test\n");

	const identity = resolveIdentity(agentDir, {
		cwd: repoDir,
		existsSync,
		readFileSync: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
		realpathSync: (p: string) => { try { return realpathSync(p); } catch { return p; } },
		statSync: (p: string) => { try { const st = statSync(p); return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile() }; } catch { return { isDirectory: () => false, isFile: () => false }; } },
	});
	return identity!;
}

function setupMemoryFile(identity: RepoIdentity, entries: Array<{ text: string; tags?: string[] }>) {
	mkdirSync(identity.storageDir, { recursive: true });
	const doc = createDocument(identity.key, identity.label);
	for (const e of entries) {
		addEntry(doc, e.text, e.tags ?? []);
	}
	writeFileSync(memoryFilePath(identity), serializeDocument(doc));
}

function setupEnabled(identity: RepoIdentity) {
	mkdirSync(identity.storageDir, { recursive: true });
	writeEnablement(enablementFilePath(identity), { enabled: true });
}

// --- selectEntries / budget ---

test("selectEntries returns all entries when under cap", () => {
	const entries = [
		{ id: "1", created_at: "x", updated_at: "x", tags: ["a"], text: "first" },
		{ id: "2", created_at: "x", updated_at: "x", tags: [], text: "second" },
	];
	const result = selectEntries(entries);
	expect(result.entryCount).toBe(2);
	expect(result.truncated).toBe(false);
	expect(result.body).toContain("first");
	expect(result.body).toContain("second");
});

test("selectEntries truncates at entry boundary when over cap", () => {
	const entries = [];
	for (let i = 0; i < 100; i++) {
		entries.push({ id: `e${i}`, created_at: "x", updated_at: "x", tags: [], text: `entry-${i}-${"x".repeat(200)}` });
	}
	const result = selectEntries(entries);
	expect(result.truncated).toBe(true);
	expect(result.entryCount).toBeLessThan(100);
	expect(result.body).toContain("[truncated");
});

test("selectEntries returns empty for no entries", () => {
	const result = selectEntries([]);
	expect(result.entryCount).toBe(0);
	expect(result.body).toBe("");
});

test("selectEntries orders newest first", () => {
	const entries = [
		{ id: "old", created_at: "x", updated_at: "x", tags: [], text: "oldest" },
		{ id: "new", created_at: "x", updated_at: "x", tags: [], text: "newest" },
	];
	const result = selectEntries(entries);
	expect(result.body.indexOf("newest")).toBeLessThan(result.body.indexOf("oldest"));
});

// --- freshRead ---

test("freshRead returns null when disabled", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupMemoryFile(identity, [{ text: "test" }]);
	// Not enabling — default-off
	const result = freshRead(identity);
	expect(result).toBeNull();
});

test("freshRead returns null when no memory file", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	// No memory file created
	const result = freshRead(identity);
	expect(result).toBeNull();
});

test("freshRead returns content when enabled with valid file", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	setupMemoryFile(identity, [{ text: "test entry", tags: ["arch"] }]);
	const result = freshRead(identity);
	expect(result).not.toBeNull();
	expect(result!.body).toContain("test entry");
	expect(result!.entryCount).toBe(1);
});

test("freshRead returns null for malformed file", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	mkdirSync(identity.storageDir, { recursive: true });
	writeFileSync(memoryFilePath(identity), "not valid json");
	const result = freshRead(identity);
	expect(result).toBeNull();
});

test("freshRead returns null for unsupported version", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	mkdirSync(identity.storageDir, { recursive: true });
	writeFileSync(memoryFilePath(identity), JSON.stringify({ version: 99, repository_key: identity.key, repository_label: "l", updated_at: "x", entries: [] }));
	const result = freshRead(identity);
	expect(result).toBeNull();
});

test("freshRead returns null for wrong repository key", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	mkdirSync(identity.storageDir, { recursive: true });
	const doc = createDocument("wrong-key", "wrong-label");
	addEntry(doc, "test");
	writeFileSync(memoryFilePath(identity), serializeDocument(doc));
	const result = freshRead(identity);
	expect(result).toBeNull();
});

// --- makeContextHandler ---

test("context handler appends one memory message when enabled", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	setupMemoryFile(identity, [{ text: "test entry" }]);

	const handler = makeContextHandler(() => identity);
	const input = [
		{ role: "user", content: "hello", timestamp: 1 },
	];
	const result = handler({ messages: input as any });
	expect(result).toBeDefined();
	expect(result!.messages.length).toBe(2);
	expect(result!.messages[1]!.role).toBe("user");
	const content = result!.messages[1]!.content as string;
	expect(content).toContain("test entry");
});

test("context handler returns undefined when disabled", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupMemoryFile(identity, [{ text: "test entry" }]);
	// Not enabled

	const handler = makeContextHandler(() => identity);
	const result = handler({ messages: [{ role: "user", content: "hello", timestamp: 1 }] as any });
	expect(result).toBeUndefined();
});

test("context handler returns undefined for non-repository", () => {
	const handler = makeContextHandler(() => null);
	const result = handler({ messages: [{ role: "user", content: "hello", timestamp: 1 }] as any });
	expect(result).toBeUndefined();
});

test("context handler dedupes on repeated calls", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	setupMemoryFile(identity, [{ text: "test entry" }]);

	const handler = makeContextHandler(() => identity);
	const input = [
		{ role: "user", content: "hello", timestamp: 1 },
	];

	const result1 = handler({ messages: input as any });
	expect(result1!.messages.length).toBe(2);

	// Second call with the result from first (which includes the memory message)
	const result2 = handler({ messages: result1!.messages as any });
	expect(result2!.messages.length).toBe(2); // replaced, not appended
});

test("context handler preserves original messages", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	setupEnabled(identity);
	setupMemoryFile(identity, [{ text: "test entry" }]);

	const handler = makeContextHandler(() => identity);
	const input = [
		{ role: "user", content: "first", timestamp: 1 },
		{ role: "assistant", content: "second", timestamp: 2 },
		{ role: "tool", content: "third", timestamp: 3 },
	];

	const result = handler({ messages: input as any });
	expect(result!.messages[0]!.content).toBe("first");
	expect(result!.messages[1]!.content).toBe("second");
	expect(result!.messages[2]!.content).toBe("third");
	expect(result!.messages.length).toBe(4);
});

test("context handler fails open on error", () => {
	const handler = makeContextHandler(() => { throw new Error("unexpected"); });
	const result = handler({ messages: [{ role: "user", content: "hello", timestamp: 1 }] as any });
	expect(result).toBeUndefined();
});

// --- Status ---

test("formatStatusText produces non-sensitive output", () => {
	const status: MemoryStatus = {
		enabled: true,
		repoLabel: "owner/repo",
		repoKeyPrefix: "abc123",
		schemaVersion: 1,
		entryCount: 5,
		byteCount: 1024,
		truncated: false,
		storagePath: "/tmp/agent/memory-lite/abc123",
	};
	const text = formatStatusText(status);
	expect(text).toContain("enabled");
	expect(text).toContain("owner/repo");
	expect(text).toContain("5");
	expect(text).not.toContain("secret");
	expect(text).not.toContain("password");
});

test("formatStatusText shows disabled state", () => {
	const status: MemoryStatus = {
		enabled: false,
		repoLabel: "owner/repo",
		repoKeyPrefix: "abc123",
		schemaVersion: 1,
		entryCount: 0,
		byteCount: 0,
		truncated: false,
		storagePath: "/tmp/agent/memory-lite/abc123",
	};
	const text = formatStatusText(status);
	expect(text).toContain("disabled");
});

test("rateLimitedWarning suppresses repeated messages", () => {
	const msg = "malformed file";
	expect(rateLimitedWarning(msg)).toBe(msg);
	expect(rateLimitedWarning(msg)).toBeNull(); // suppressed
});

// --- Default-off means zero reads ---

test("default-off means no memory file read and no injected message", () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	// Create memory file but do NOT enable
	setupMemoryFile(identity, [{ text: "test entry" }]);

	const handler = makeContextHandler(() => identity);
	const result = handler({ messages: [{ role: "user", content: "hello", timestamp: 1 }] as any });
	expect(result).toBeUndefined();
});
