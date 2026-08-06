// memory-lite: status reporting (non-sensitive).

export interface MemoryStatus {
	enabled: boolean;
	repoLabel: string;
	repoKeyPrefix: string;
	schemaVersion: number;
	entryCount: number;
	byteCount: number;
	truncated: boolean;
	storagePath: string;
	lastReadAt?: string;
	lastWriteAt?: string;
	lastError?: string;
}

export function formatStatusText(status: MemoryStatus): string {
	const lines = [
		`memory-lite: ${status.enabled ? "enabled" : "disabled"}`,
		`  repository: ${status.repoLabel} (${status.repoKeyPrefix}…)`,
		`  schema: v${status.schemaVersion}`,
		`  entries: ${status.entryCount}`,
		`  bytes: ${status.byteCount}${status.truncated ? " (truncated)" : ""}`,
		`  storage: ${status.storagePath}`,
	];
	if (status.lastReadAt) lines.push(`  last read: ${status.lastReadAt}`);
	if (status.lastWriteAt) lines.push(`  last write: ${status.lastWriteAt}`);
	if (status.lastError) lines.push(`  last error: ${status.lastError}`);
	return lines.join("\n");
}

let lastWarning: string | null = null;
let lastWarningTime = 0;
const WARNING_COOLDOWN_MS = 30_000;

export function rateLimitedWarning(message: string): string | null {
	const now = Date.now();
	if (lastWarning === message && now - lastWarningTime < WARNING_COOLDOWN_MS) {
		return null;
	}
	lastWarning = message;
	lastWarningTime = now;
	return message;
}
