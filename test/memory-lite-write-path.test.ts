// Unit tests for memory-lite write path: add/remove, atomic persistence,
// lock behavior, privacy checks, and error handling.

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveIdentity, type RepoIdentity } from "../extensions/memory-lite/identity.ts";
import { createDocument, addEntry, serializeDocument, parseDocument, MAX_ENTRY_TEXT_BYTES, MAX_ENTRIES } from "../extensions/memory-lite/schema.ts";
import { memoryFilePath, lockFilePath } from "../extensions/memory-lite/storage.ts";
import { writeEnablement, readEnablement } from "../extensions/memory-lite/config.ts";
import { addMemoryEntry, removeMemoryEntry, validateAddInput } from "../extensions/memory-lite/write-path.ts";
import { isSuspiciousSecret, safeErrorMessage } from "../extensions/memory-lite/privacy.ts";
import { withLock } from "../extensions/memory-lite/lock.ts";
import { atomicWrite } from "../extensions/memory-lite/atomic-file.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "ml-wp-test-"));
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

// --- validateAddInput ---

test("validateAddInput rejects empty text", () => {
	expect(validateAddInput("")).not.toBeNull();
	expect(validateAddInput("   ")).not.toBeNull();
});

test("validateAddInput rejects oversize text", () => {
	const longText = "x".repeat(MAX_ENTRY_TEXT_BYTES + 1);
	expect(validateAddInput(longText)).not.toBeNull();
});

test("validateAddInput accepts normal text", () => {
	expect(validateAddInput("This is a normal memory entry")).toBeNull();
});

// --- Privacy checks ---

test("isSuspiciousSecret detects API keys", () => {
	expect(isSuspiciousSecret("sk-1234567890abcdefghijklmnopqrstuvwxyz")).toBe(true);
	expect(isSuspiciousSecret("api_key=abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
});

test("isSuspiciousSecret detects bearer tokens", () => {
	expect(isSuspiciousSecret("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toBe(true);
});

test("isSuspiciousSecret detects private keys", () => {
	expect(isSuspiciousSecret("-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA")).toBe(true);
});

test("isSuspiciousSecret detects GitHub tokens", () => {
	expect(isSuspiciousSecret("ghp_1234567890abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
});

test("isSuspiciousSecret rejects normal text", () => {
	expect(isSuspiciousSecret("The API uses REST endpoints for CRUD operations")).toBe(false);
	expect(isSuspiciousSecret("Remember to use the deployment workflow")).toBe(false);
});

test("safeErrorMessage does not echo input", () => {
	const msg = safeErrorMessage("add");
	expect(msg).toContain("rejected");
	expect(msg).not.toContain("sk-");
	expect(msg).not.toContain("password");
});

// --- addMemoryEntry ---

test("addMemoryEntry creates new document when no file exists", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const result = await addMemoryEntry(identity, "test entry", ["arch"]);
	expect(result.success).toBe(true);
	expect(result.entryId).toBeTruthy();

	// Verify file was created and can be parsed
	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc).not.toBeNull();
	expect(doc!.entries.length).toBe(1);
	expect(doc!.entries[0]!.text).toBe("test entry");
	expect(doc!.entries[0]!.tags).toEqual(["arch"]);
});

test("addMemoryEntry appends to existing document", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");

	// Add first entry
	await addMemoryEntry(identity, "first entry");
	// Add second entry
	const result = await addMemoryEntry(identity, "second entry");
	expect(result.success).toBe(true);

	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc!.entries.length).toBe(2);
});

test("addMemoryEntry rejects suspicious secret input", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const result = await addMemoryEntry(identity, "sk-1234567890abcdefghijklmnopqrstuvwxyz");
	expect(result.success).toBe(false);
	expect(result.error).toContain("rejected");
	expect(result.error).not.toContain("sk-");
});

test("addMemoryEntry rejects empty text", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const result = await addMemoryEntry(identity, "");
	expect(result.success).toBe(false);
});

// --- removeMemoryEntry ---

test("removeMemoryEntry removes by exact id", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const addResult = await addMemoryEntry(identity, "test entry");
	expect(addResult.success).toBe(true);

	const removeResult = await removeMemoryEntry(identity, addResult.entryId!);
	expect(removeResult.success).toBe(true);

	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc!.entries.length).toBe(0);
});

test("removeMemoryEntry fails for nonexistent id", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	await addMemoryEntry(identity, "test entry");
	const result = await removeMemoryEntry(identity, "nonexistent-id");
	expect(result.success).toBe(false);
	expect(result.error).toContain("not found");
});

test("removeMemoryEntry fails when no file exists", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const result = await removeMemoryEntry(identity, "some-id");
	expect(result.success).toBe(false);
	expect(result.error).toContain("No memory file");
});

test("removeMemoryEntry preserves other entries", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	const r1 = await addMemoryEntry(identity, "first");
	const r2 = await addMemoryEntry(identity, "second");

	await removeMemoryEntry(identity, r1.entryId!);

	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc!.entries.length).toBe(1);
	expect(doc!.entries[0]!.text).toBe("second");
});

// --- Atomic file write ---

test("atomicWrite creates file with correct content", async () => {
	const dir = makeTempDir();
	const filePath = join(dir, "test.json");
	await atomicWrite(filePath, '{"test":true}\n');
	expect(readFileSync(filePath, "utf8")).toBe('{"test":true}\n');
});

test("atomicWrite overwrites existing file", async () => {
	const dir = makeTempDir();
	const filePath = join(dir, "test.json");
	writeFileSync(filePath, "old content");
	await atomicWrite(filePath, "new content");
	expect(readFileSync(filePath, "utf8")).toBe("new content");
});

// --- Lock behavior ---

test("withLock allows sequential operations on same file", async () => {
	const dir = makeTempDir();
	const lockPath = join(dir, "test.lock");
	const r1 = await withLock(lockPath, async () => "first");
	const r2 = await withLock(lockPath, async () => "second");
	expect(r1).toBe("first");
	expect(r2).toBe("second");
});

test("withLock cleans up lock file after operation", async () => {
	const dir = makeTempDir();
	const lockPath = join(dir, "test.lock");
	await withLock(lockPath, async () => "done");
	expect(existsSync(lockPath)).toBe(false);
});

// --- Enable/disable ---

test("enable then disable preserves memory content", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");

	// Add entry
	await addMemoryEntry(identity, "important context");

	// Enable
	const enablementPath = join(identity.storageDir, "enablement.json");
	writeEnablement(enablementPath, { enabled: true });
	expect(readEnablement(enablementPath).enabled).toBe(true);

	// Disable
	writeEnablement(enablementPath, { enabled: false, lastWriteAt: new Date().toISOString() });
	expect(readEnablement(enablementPath).enabled).toBe(false);

	// Memory file still exists with content
	const raw = readFileSync(memoryFilePath(identity), "utf8");
	const doc = parseDocument(raw);
	expect(doc!.entries.length).toBe(1);
});

// --- No Pi settings/session writes ---

test("write path never writes to Pi settings keys", async () => {
	const base = makeTempDir();
	const identity = makeRepoIdentity(base, "https://github.com/owner/repo.git");
	await addMemoryEntry(identity, "test");

	const memRaw = readFileSync(memoryFilePath(identity), "utf8");
	expect(memRaw).not.toContain("pinnedModel");
	expect(memRaw).not.toContain("defaultProvider");
	expect(memRaw).not.toContain("defaultModel");
	expect(memRaw).not.toContain("autoSkills");
	expect(memRaw).not.toContain("akHooksBridge");
});
