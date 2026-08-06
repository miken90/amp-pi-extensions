// memory-lite: write path — command argument validation and CRUD orchestration.
// Read-under-lock, validate, apply operation, serialize, atomic replace, release.

import { readFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import type { RepoIdentity } from "./identity.ts";
import {
	type MemoryDocument,
	parseDocument,
	serializeDocument,
	createDocument,
	addEntry,
	removeEntry,
	MAX_ENTRY_TEXT_BYTES,
	MAX_ENTRIES,
} from "./schema.ts";
import { memoryFilePath, lockFilePath } from "./storage.ts";
import { withLock } from "./lock.ts";
import { atomicWrite } from "./atomic-file.ts";
import { isSuspiciousSecret, safeErrorMessage } from "./privacy.ts";

export interface WriteResult {
	success: boolean;
	error?: string;
	entryId?: string;
}

export interface ReadUnderLockDeps {
	readFileSync?: (p: string, encoding: string) => string | undefined;
	existsSync?: (p: string) => boolean;
}

function defaultReadFileSync(p: string, encoding: string): string | undefined {
	try { return readFileSync(p, encoding); } catch { return undefined; }
}

function defaultExistsSync(p: string): boolean {
	try { return existsSync(p); } catch { return false; }
}

export function validateAddInput(text: string): string | null {
	if (!text || !text.trim()) return "Text cannot be empty";
	const textBytes = Buffer.byteLength(text, "utf8");
	if (textBytes > MAX_ENTRY_TEXT_BYTES) return `Text exceeds ${MAX_ENTRY_TEXT_BYTES} bytes`;
	if (isSuspiciousSecret(text)) return safeErrorMessage("add");
	return null;
}

export async function addMemoryEntry(
	identity: RepoIdentity,
	text: string,
	tags: string[] = [],
): Promise<WriteResult> {
	const validationError = validateAddInput(text);
	if (validationError) return { success: false, error: validationError };

	const memPath = memoryFilePath(identity);
	const lockPath = lockFilePath(memPath);

	mkdirSync(identity.storageDir, { recursive: true });

	try {
		return await withLock(lockPath, async () => {
			let doc: MemoryDocument;

			if (existsSync(memPath)) {
				const raw = readFileSync(memPath, "utf8");
				const parsed = parseDocument(raw);
				if (!parsed) {
					return { success: false, error: "Existing memory file is malformed or unsupported version" };
				}
				if (parsed.repository_key !== identity.key) {
					return { success: false, error: "Memory file repository key mismatch" };
				}
				doc = parsed;
			} else {
				doc = createDocument(identity.key, identity.label);
			}

			if (doc.entries.length >= MAX_ENTRIES) {
				return { success: false, error: `Maximum ${MAX_ENTRIES} entries reached` };
			}

			const entry = addEntry(doc, text.trim(), tags);
			await atomicWrite(memPath, serializeDocument(doc));

			return { success: true, entryId: entry.id };
		});
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export async function removeMemoryEntry(
	identity: RepoIdentity,
	entryId: string,
): Promise<WriteResult> {
	if (!entryId.trim()) return { success: false, error: "Entry id cannot be empty" };

	const memPath = memoryFilePath(identity);
	const lockPath = lockFilePath(memPath);

	if (!existsSync(memPath)) {
		return { success: false, error: "No memory file found" };
	}

	try {
		return await withLock(lockPath, async () => {
			const raw = readFileSync(memPath, "utf8");
			const parsed = parseDocument(raw);
			if (!parsed) {
				return { success: false, error: "Memory file is malformed or unsupported version" };
			}
			if (parsed.repository_key !== identity.key) {
				return { success: false, error: "Memory file repository key mismatch" };
			}

			const removed = removeEntry(parsed, entryId.trim());
			if (!removed) {
				return { success: false, error: `Entry "${entryId}" not found` };
			}

			await atomicWrite(memPath, serializeDocument(parsed));
			return { success: true };
		});
	} catch (err) {
		return { success: false, error: err instanceof Error ? err.message : String(err) };
	}
}
