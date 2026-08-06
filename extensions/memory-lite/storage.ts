// memory-lite: storage path derivation.
// Actual atomic mutation is in write-path (Phase 4).

import { join } from "node:path";
import type { RepoIdentity } from "./identity.ts";

export function memoryFilePath(identity: RepoIdentity): string {
	return join(identity.storageDir, "memory.md");
}

export function enablementFilePath(identity: RepoIdentity): string {
	return join(identity.storageDir, "enablement.json");
}

export function lockFilePath(filePath: string): string {
	return `${filePath}.lock`;
}

export function tempFilePath(filePath: string): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(16).slice(2);
	const base = filePath.split("/").pop() ?? filePath;
	return `${filePath}.tmp.${ts}.${rand}`;
}
