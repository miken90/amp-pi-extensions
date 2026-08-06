// Unit tests for memory-lite foundation: identity, schema, storage, config.
// Uses synthetic temporary Git metadata fixtures, not real repository content.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, statSync, readFileSync, symlinkSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { tmpdir } from "node:os";
import {
	resolveIdentity,
	normalizeRemoteUrl,
	type IdentityDeps,
} from "../extensions/memory-lite/identity.ts";
import {
	type MemoryDocument,
	type MemoryEntry,
	createDocument,
	parseDocument,
	serializeDocument,
	validateEntry,
	addEntry,
	removeEntry,
	generateEntryId,
	SCHEMA_VERSION,
	MAX_ENTRY_TEXT_BYTES,
	MAX_ENTRIES,
} from "../extensions/memory-lite/schema.ts";
import { memoryFilePath, enablementFilePath, lockFilePath, tempFilePath } from "../extensions/memory-lite/storage.ts";
import { readEnablement, writeEnablement, type EnablementState } from "../extensions/memory-lite/config.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ml-test-"));
}

function makeGitRepo(base: string, remoteUrl?: string, name: string = "my-repo"): string {
	const repoDir = join(base, name);
	mkdirSync(join(repoDir, ".git"), { recursive: true });
	if (remoteUrl) {
		const config = `[remote "origin"]\n\turl = ${remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;
		writeFileSync(join(repoDir, ".git", "config"), config);
	}
	// Create a file so the repo isn't empty
	writeFileSync(join(repoDir, "README.md"), "# test\n");
	return repoDir;
}

function makeDeps(cwd: string): IdentityDeps {
	return {
		cwd,
		existsSync,
		readFileSync: (p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
		realpathSync: (p: string) => { try { return realpathSync(p); } catch { return p; } },
		statSync: (p: string) => { try { const st = statSync(p); return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile() }; } catch { return { isDirectory: () => false, isFile: () => false }; } },
	};
}

// --- Identity resolution ---

test("resolveIdentity with HTTPS remote", () => {
	const base = makeTempDir();
	const repo = makeGitRepo(base, "https://github.com/owner/repo.git");
	const identity = resolveIdentity("/tmp/agent", makeDeps(repo));
	expect(identity).not.toBeNull();
	expect(identity!.source).toBe("remote");
	expect(identity!.key.length).toBe(64); // SHA-256 hex
	expect(identity!.shortKey.length).toBe(16);
	expect(identity!.label).toBe("owner/repo");
	expect(identity!.storageDir).toContain("memory-lite");
	expect(identity!.storageDir).toContain(identity!.key);
});

test("resolveIdentity with SSH remote", () => {
	const base = makeTempDir();
	const repo = makeGitRepo(base, "git@github.com:owner/repo.git");
	const identity = resolveIdentity("/tmp/agent", makeDeps(repo));
	expect(identity).not.toBeNull();
	expect(identity!.source).toBe("remote");
	expect(identity!.label).toBe("owner/repo");
});

test("resolveIdentity without remote uses local path fallback", () => {
	const base = makeTempDir();
	const repo = makeGitRepo(base);
	const identity = resolveIdentity("/tmp/agent", makeDeps(repo));
	expect(identity).not.toBeNull();
	expect(identity!.source).toBe("local-path");
	expect(identity!.key.length).toBe(64);
});

test("resolveIdentity returns null for non-repository", () => {
	const base = makeTempDir();
	const identity = resolveIdentity("/tmp/agent", makeDeps(base));
	expect(identity).toBeNull();
});

test("resolveIdentity with worktree .git file", () => {
	const base = makeTempDir();
	const mainRepo = makeGitRepo(base, "https://github.com/owner/repo.git");
	const worktreeDir = join(base, "worktree");
	mkdirSync(worktreeDir, { recursive: true });
	// .git file pointing to the main repo's worktree gitdir
	const gitDir = join(mainRepo, ".git", "worktrees", "wt1");
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(join(worktreeDir, ".git"), `gitdir: ${gitDir}\n`);
	writeFileSync(join(gitDir, "config"), `[remote "origin"]\n\turl = https://github.com/owner/repo.git\n`);

	const identity = resolveIdentity("/tmp/agent", makeDeps(worktreeDir));
	expect(identity).not.toBeNull();
	expect(identity!.source).toBe("remote");
});

test("resolveIdentity with symlinked cwd uses resolved real path", () => {
	const base = makeTempDir();
	const repo = makeGitRepo(base, "https://github.com/owner/repo.git");
	const symlinkDir = join(base, "symlink");
	symlinkSync(repo, symlinkDir);
	const identity = resolveIdentity("/tmp/agent", makeDeps(symlinkDir));
	expect(identity).not.toBeNull();
	expect(identity!.source).toBe("remote");
});

test("resolveIdentity with submodule stops at submodule boundary", () => {
	const base = makeTempDir();
	const parentRepo = makeGitRepo(base, "https://github.com/parent/owner.git", "parent-repo");
	const subDir = join(parentRepo, "submodule");
	mkdirSync(subDir, { recursive: true });
	mkdirSync(join(subDir, ".git"), { recursive: true });
	writeFileSync(join(subDir, ".git", "config"), `[remote "origin"]\n\turl = https://github.com/sub/repo.git\n`);
	writeFileSync(join(subDir, "file.txt"), "sub\n");

	const identity = resolveIdentity("/tmp/agent", makeDeps(subDir));
	expect(identity).not.toBeNull();
	expect(identity!.label).toBe("sub/repo");
});

test("two distinct repos produce distinct keys", () => {
	const base = makeTempDir();
	const repo1 = makeGitRepo(base, "https://github.com/owner/repo1.git", "repo1");
	const repo2 = makeGitRepo(base, "https://github.com/owner/repo2.git", "repo2");
	const id1 = resolveIdentity("/tmp/agent", makeDeps(repo1));
	const id2 = resolveIdentity("/tmp/agent", makeDeps(repo2));
	expect(id1!.key).not.toBe(id2!.key);
});

test("labels never determine the key", () => {
	const base = makeTempDir();
	const repo = makeGitRepo(base, "https://github.com/owner/my-cool-repo.git");
	const identity = resolveIdentity("/tmp/agent", makeDeps(repo));
	expect(identity!.key).not.toContain("my-cool-repo");
	expect(identity!.key).not.toContain("owner");
});

// --- normalizeRemoteUrl ---

test("normalizeRemoteUrl removes credentials", () => {
	expect(normalizeRemoteUrl("https://user:pass@github.com/owner/repo.git"))
		.toBe("github.com/owner/repo");
});

test("normalizeRemoteUrl removes git+ prefix", () => {
	expect(normalizeRemoteUrl("git+https://github.com/owner/repo.git"))
		.toBe("github.com/owner/repo");
});

test("normalizeRemoteUrl removes .git suffix and trailing slash", () => {
	expect(normalizeRemoteUrl("https://github.com/owner/repo.git/"))
		.toBe("github.com/owner/repo");
});

test("normalizeRemoteUrl normalizes SSH format", () => {
	expect(normalizeRemoteUrl("git@github.com:owner/repo.git"))
		.toBe("github.com/owner/repo");
});

test("normalizeRemoteUrl removes fragments and query", () => {
	expect(normalizeRemoteUrl("https://github.com/owner/repo.git#branch?tab=readme"))
		.toBe("github.com/owner/repo");
});

// --- Schema ---

test("createDocument creates valid v1 document", () => {
	const doc = createDocument("key123", "label");
	expect(doc.version).toBe(SCHEMA_VERSION);
	expect(doc.repository_key).toBe("key123");
	expect(doc.entries).toEqual([]);
});

test("parseDocument round-trips through serialize", () => {
	const doc = createDocument("key123", "label");
	addEntry(doc, "test entry", ["tag1"]);
	const raw = serializeDocument(doc);
	const parsed = parseDocument(raw);
	expect(parsed).not.toBeNull();
	expect(parsed!.version).toBe(1);
	expect(parsed!.entries.length).toBe(1);
	expect(parsed!.entries[0]!.text).toBe("test entry");
	expect(parsed!.entries[0]!.tags).toEqual(["tag1"]);
});

test("parseDocument rejects malformed JSON", () => {
	expect(parseDocument("not json")).toBeNull();
});

test("parseDocument rejects unsupported future version", () => {
	const raw = JSON.stringify({ version: 99, repository_key: "k", repository_label: "l", updated_at: "now", entries: [] });
	expect(parseDocument(raw)).toBeNull();
});

test("parseDocument rejects missing required fields", () => {
	expect(parseDocument(JSON.stringify({ version: 1 }))).toBeNull();
	expect(parseDocument(JSON.stringify({ version: 1, repository_key: "k" }))).toBeNull();
});

test("parseDocument skips invalid entries but keeps valid ones", () => {
	const raw = JSON.stringify({
		version: 1,
		repository_key: "k",
		repository_label: "l",
		updated_at: "now",
		entries: [
			{ id: "valid", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", tags: [], text: "valid" },
			{ id: "", created_at: "x", updated_at: "y", tags: [], text: "invalid" },
			"not an object",
		],
	});
	const parsed = parseDocument(raw);
	expect(parsed).not.toBeNull();
	expect(parsed!.entries.length).toBe(1);
	expect(parsed!.entries[0]!.id).toBe("valid");
});

test("validateEntry rejects oversize text", () => {
	const longText = "x".repeat(MAX_ENTRY_TEXT_BYTES + 1);
	expect(validateEntry({ id: "x", created_at: "x", updated_at: "x", tags: [], text: longText })).toBeNull();
});

test("validateEntry rejects invalid tags", () => {
	expect(validateEntry({ id: "x", created_at: "x", updated_at: "x", tags: ["valid", 123], text: "x" })).toBeNull();
});

test("validateEntry rejects empty id", () => {
	expect(validateEntry({ id: "", created_at: "x", updated_at: "x", tags: [], text: "x" })).toBeNull();
});

test("addEntry and removeEntry work correctly", () => {
	const doc = createDocument("k", "l");
	const entry = addEntry(doc, "test", ["tag"]);
	expect(doc.entries.length).toBe(1);
	expect(entry.id).toBeTruthy();
	expect(removeEntry(doc, entry.id)).toBe(true);
	expect(doc.entries.length).toBe(0);
	expect(removeEntry(doc, "nonexistent")).toBe(false);
});

test("generateEntryId produces unique-ish ids", () => {
	const ids = new Set<string>();
	for (let i = 0; i < 100; i++) ids.add(generateEntryId());
	expect(ids.size).toBe(100);
});

// --- Storage paths ---

test("memoryFilePath and enablementFilePath are under storageDir", () => {
	const identity = {
		key: "abc123",
		shortKey: "abc123",
		label: "test",
		storageDir: "/tmp/agent/memory-lite/abc123",
		source: "remote" as const,
	};
	expect(memoryFilePath(identity)).toBe("/tmp/agent/memory-lite/abc123/memory.md");
	expect(enablementFilePath(identity)).toBe("/tmp/agent/memory-lite/abc123/enablement.json");
});

test("lockFilePath and tempFilePath are adjacent to target", () => {
	const fp = "/tmp/agent/memory-lite/abc/memory.md";
	expect(lockFilePath(fp)).toBe("/tmp/agent/memory-lite/abc/memory.md.lock");
	expect(tempFilePath(fp)).toContain(".tmp.");
});

// --- Config / enablement ---

test("readEnablement returns default-off for missing file", () => {
	const state = readEnablement("/tmp/nonexistent-ml-test/enablement.json");
	expect(state.enabled).toBe(false);
});

test("readEnablement returns default-off for malformed file", () => {
	const dir = makeTempDir();
	const fp = join(dir, "enablement.json");
	writeFileSync(fp, "not json");
	const state = readEnablement(fp);
	expect(state.enabled).toBe(false);
});

test("writeEnablement and readEnablement round-trip", () => {
	const dir = makeTempDir();
	const fp = join(dir, "enablement.json");
	const state: EnablementState = { enabled: true, lastWriteAt: "2026-01-01T00:00:00Z" };
	writeEnablement(fp, state);
	const read = readEnablement(fp);
	expect(read.enabled).toBe(true);
	expect(read.lastWriteAt).toBe("2026-01-01T00:00:00Z");
});

test("enablement state is isolated from Pi settings keys", () => {
	const dir = makeTempDir();
	const fp = join(dir, "enablement.json");
	const state: EnablementState = { enabled: true };
	writeEnablement(fp, state);
	const raw = readFileSync(fp, "utf8");
	expect(raw).not.toContain("pinnedModel");
	expect(raw).not.toContain("autoSkills");
	expect(raw).not.toContain("akHooksBridge");
	expect(raw).not.toContain("defaultProvider");
	expect(raw).not.toContain("defaultModel");
});
