// memory-lite: versioned document schema.
// Version 1 with frontmatter envelope and human-readable entries.
// Rejects malformed and unknown versions without mutation.

export interface MemoryEntry {
	id: string;
	created_at: string;  // ISO-8601 UTC
	updated_at: string;  // ISO-8601 UTC
	tags: string[];
	text: string;
}

export interface MemoryDocument {
	version: 1;
	repository_key: string;
	repository_label: string;
	updated_at: string;  // ISO-8601 UTC
	entries: MemoryEntry[];
}

export const SCHEMA_VERSION = 1;

export const MAX_ENTRY_TEXT_BYTES = 2048;   // 2 KiB per entry
export const MAX_ENTRIES = 100;
export const MAX_TOTAL_BODY_BYTES = 8192;   // 8 KiB total injected body
export const MAX_MESSAGE_BYTES = 12288;     // 12 KiB total message

export function createDocument(repositoryKey: string, repositoryLabel: string): MemoryDocument {
	const now = new Date().toISOString();
	return {
		version: SCHEMA_VERSION,
		repository_key: repositoryKey,
		repository_label: repositoryLabel,
		updated_at: now,
		entries: [],
	};
}

export function validateEntry(entry: unknown): MemoryEntry | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;

	if (typeof e.id !== "string" || !e.id.trim()) return null;
	if (typeof e.created_at !== "string") return null;
	if (typeof e.updated_at !== "string") return null;
	if (!Array.isArray(e.tags) || e.tags.some((t) => typeof t !== "string")) return null;
	if (typeof e.text !== "string") return null;

	const textBytes = Buffer.byteLength(e.text, "utf8");
	if (textBytes > MAX_ENTRY_TEXT_BYTES) return null;

	return {
		id: e.id,
		created_at: e.created_at,
		updated_at: e.updated_at,
		tags: e.tags as string[],
		text: e.text,
	};
}

export function parseDocument(raw: string): MemoryDocument | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;

	// Reject unknown versions without mutation
	if (obj.version !== SCHEMA_VERSION) return null;

	if (typeof obj.repository_key !== "string") return null;
	if (typeof obj.repository_label !== "string") return null;
	if (typeof obj.updated_at !== "string") return null;
	if (!Array.isArray(obj.entries)) return null;

	const entries: MemoryEntry[] = [];
	for (const entry of obj.entries) {
		const validated = validateEntry(entry);
		if (!validated) continue; // skip invalid entries
		entries.push(validated);
	}

	return {
		version: SCHEMA_VERSION,
		repository_key: obj.repository_key,
		repository_label: obj.repository_label,
		updated_at: obj.updated_at,
		entries,
	};
}

export function serializeDocument(doc: MemoryDocument): string {
	return JSON.stringify(doc, null, 2) + "\n";
}

export function generateEntryId(): string {
	const ts = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 8);
	return `${ts}-${rand}`;
}

export function addEntry(doc: MemoryDocument, text: string, tags: string[] = []): MemoryEntry {
	const now = new Date().toISOString();
	const entry: MemoryEntry = {
		id: generateEntryId(),
		created_at: now,
		updated_at: now,
		tags,
		text,
	};
	doc.entries.push(entry);
	doc.updated_at = now;
	return entry;
}

export function removeEntry(doc: MemoryDocument, id: string): boolean {
	const idx = doc.entries.findIndex((e) => e.id === id);
	if (idx === -1) return false;
	doc.entries.splice(idx, 1);
	doc.updated_at = new Date().toISOString();
	return true;
}
