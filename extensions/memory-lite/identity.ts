// memory-lite: repository identity resolution.
// Derives a canonical, collision-resistant storage key from Git metadata.
// No session scanning, no transcript access — only .git directory detection
// and remote URL normalization.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

const DOMAIN_SEPARATOR = "amp-pi-memory-lite:v1:";

export interface RepoIdentity {
	key: string;          // full SHA-256 hash (domain-separated)
	shortKey: string;     // first 16 chars for display
	label: string;        // display-only repo name
	storageDir: string;   // <agentDir>/memory-lite/<key>
	source: "remote" | "local-path";
}

export interface IdentityDeps {
	cwd?: string;
	existsSync?: (p: string) => boolean;
	readFileSync?: (p: string) => string | undefined;
	realpathSync?: (p: string) => string;
	statSync?: (p: string) => { isDirectory: () => boolean; isFile: () => boolean };
}

function defaultExistsSync(p: string): boolean {
	try { return existsSync(p); } catch { return false; }
}

function defaultReadFileSync(p: string): string | undefined {
	try { return readFileSync(p, "utf8"); } catch { return undefined; }
}

function defaultRealpathSync(p: string): string {
	try { return realpathSync(p); } catch { return p; }
}

function defaultStatSync(p: string): { isDirectory: () => boolean; isFile: () => boolean } {
	try {
		const st = statSync(p);
		return { isDirectory: () => st.isDirectory(), isFile: () => st.isFile() };
	} catch {
		return { isDirectory: () => false, isFile: () => false };
	}
}

/**
 * Walk upward from cwd to find the nearest .git directory or file.
 * Returns the repository root directory, or null if not found.
 */
function findGitRoot(
	cwd: string,
	exists: (p: string) => boolean,
	stat: (p: string) => { isDirectory: () => boolean; isFile: () => boolean },
): string | null {
	let dir = resolve(cwd);
	while (true) {
		const gitPath = join(dir, ".git");
		if (exists(gitPath)) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

/**
 * Read the remote URL from a Git repository's config.
 * Returns the first fetch remote URL found, or null.
 */
function readRemoteUrl(
	gitRoot: string,
	read: (p: string) => string | undefined,
): string | null {
	const configPath = join(gitRoot, ".git", "config");
	let config: string | undefined;

	// Handle worktree: .git might be a file pointing to the real gitdir
	const gitDir = join(gitRoot, ".git");
	const stat = defaultStatSync(gitDir);
	if (stat.isFile()) {
		const content = read(gitDir);
		if (content) {
			const match = content.match(/^gitdir:\s*(.+)$/m);
			if (match) {
				const realGitDir = match[1]!.trim();
				const altConfig = join(realGitDir, "config");
				config = read(altConfig);
			}
		}
	}

	if (!config) {
		config = read(configPath);
	}

	if (!config) return null;

	// Parse [remote "..."] sections and find the first fetch URL
	const lines = config.split("\n");
	let inRemote = false;
	for (const line of lines) {
		const remoteHeader = line.match(/^\s*\[remote\s+"([^"]+)"\]/);
		if (remoteHeader) {
			inRemote = true;
			continue;
		}
		if (line.match(/^\s*\[/)) {
			inRemote = false;
			continue;
		}
		if (inRemote) {
			const urlMatch = line.match(/^\s*url\s*=\s*(.+)$/);
			if (urlMatch) {
				return urlMatch[1]!.trim();
			}
		}
	}
	return null;
}

/**
 * Normalize a Git remote URL into a canonical host/owner/repo form.
 * Removes git+, .git suffix, trailing slash, credentials, and fragments.
 */
export function normalizeRemoteUrl(url: string): string {
	let u = url.trim();

	// Remove git+ prefix
	u = u.replace(/^git\+/, "");

	// Remove credentials (user:pass@) from URL-style remotes
	u = u.replace(/^(https?:\/\/)[^@]+@/, "$1");
	u = u.replace(/^(ssh:\/\/)[^@]+@/, "$1");

	// Remove trailing slash
	u = u.replace(/\/$/, "");

	// Remove URL fragments and query params
	u = u.replace(/[?#].*$/, "");

	// Remove trailing slash again (in case fragment removal exposed one)
	u = u.replace(/\/$/, "");

	// Remove .git suffix
	u = u.replace(/\.git$/, "");

	// Normalize SSH scp-style format: git@github.com:owner/repo -> github.com/owner/repo
	// Only match if there's no :// (i.e. not a URL-style remote)
	if (!u.includes("://")) {
		// Strip user@ prefix from scp-style: git@github.com:owner/repo
		const scpMatch = u.match(/^([^:@\/+]+)@([^:]+):(.+)$/);
		if (scpMatch && scpMatch[3]!.includes("/")) {
			u = `${scpMatch[2]}/${scpMatch[3]}`;
		}
	}

	// Remove protocol prefix for canonical comparison
	u = u.replace(/^https?:\/\//, "");
	u = u.replace(/^ssh:\/\//, "");

	return u.toLowerCase();
}

function hashKey(input: string): string {
	return createHash("sha256").update(DOMAIN_SEPARATOR + input).digest("hex");
}

function deriveLabel(normalized: string): string {
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length >= 2) {
		return parts.slice(-2).join("/");
	}
	return normalized;
}

/**
 * Resolve the canonical repository identity from cwd.
 * Returns null if no Git boundary is found.
 */
export function resolveIdentity(
	agentDir: string,
	deps?: IdentityDeps,
): RepoIdentity | null {
	const cwd = deps?.cwd ?? process.cwd();
	const exists = deps?.existsSync ?? defaultExistsSync;
	const read = deps?.readFileSync ?? defaultReadFileSync;
	const realpath = deps?.realpathSync ?? defaultRealpathSync;
	const stat = deps?.statSync ?? defaultStatSync;

	const resolvedCwd = realpath(cwd);
	const gitRoot = findGitRoot(resolvedCwd, exists, stat);
	if (!gitRoot) return null;

	const remoteUrl = readRemoteUrl(gitRoot, read);

	if (remoteUrl) {
		const normalized = normalizeRemoteUrl(remoteUrl);
		const key = hashKey(normalized);
		return {
			key,
			shortKey: key.slice(0, 16),
			label: deriveLabel(normalized),
			storageDir: join(agentDir, "memory-lite", key),
			source: "remote",
		};
	}

	// Fallback: hash the real path of the .git metadata directory
	const gitPath = join(gitRoot, ".git");
	const realGitPath = realpath(gitPath);
	const key = hashKey(realGitPath);
	return {
		key,
		shortKey: key.slice(0, 16),
		label: gitRoot.split(sep).filter(Boolean).pop() ?? gitRoot,
		storageDir: join(agentDir, "memory-lite", key),
		source: "local-path",
	};
}
