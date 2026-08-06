// memory-lite: budget caps and complete-entry selection.

import { MAX_ENTRY_TEXT_BYTES, MAX_TOTAL_BODY_BYTES, MAX_MESSAGE_BYTES, type MemoryEntry } from "./schema.ts";

export interface BudgetResult {
	body: string;
	truncated: boolean;
	entryCount: number;
	totalBytes: number;
}

/**
 * Select entries deterministically under byte and character caps.
 * Truncate only at complete entry boundaries, then add a visible truncated marker.
 * Ordering: newest first (reverse of document order).
 */
export function selectEntries(entries: MemoryEntry[]): BudgetResult {
	const reversed = [...entries].reverse();
	const lines: string[] = [];
	let totalBytes = 0;
	let entryCount = 0;
	let truncated = false;

	for (const entry of reversed) {
		const line = formatEntryLine(entry);
		const lineBytes = Buffer.byteLength(line, "utf8");

		if (totalBytes + lineBytes > MAX_TOTAL_BODY_BYTES) {
			truncated = true;
			break;
		}

		lines.push(line);
		totalBytes += lineBytes;
		entryCount++;
	}

	let body = lines.join("\n");

	if (truncated) {
		body += "\n[truncated — more entries exist]";
	}

	// Hard message cap check
	const bodyBytes = Buffer.byteLength(body, "utf8");
	if (bodyBytes > MAX_MESSAGE_BYTES) {
		// Re-select with fewer entries
		while (lines.length > 0 && Buffer.byteLength(lines.join("\n"), "utf8") > MAX_MESSAGE_BYTES) {
			lines.pop();
			truncated = true;
		}
		body = lines.join("\n") + (truncated ? "\n[truncated — more entries exist]" : "");
	}

	return {
		body,
		truncated,
		entryCount: lines.length,
		totalBytes: Buffer.byteLength(body, "utf8"),
	};
}

function formatEntryLine(entry: MemoryEntry): string {
	const tags = entry.tags.length > 0 ? ` [${entry.tags.join(", ")}]` : "";
	return `- ${tags} ${entry.text}`.trim();
}

export { MAX_ENTRY_TEXT_BYTES, MAX_TOTAL_BODY_BYTES, MAX_MESSAGE_BYTES };
