// memory-lite: isolated enablement state.
// Default-off, stored separately from Pi settings, session JSONL,
// pinnedModel, autoSkills, akHooksBridge, and hd-agent state.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EnablementState {
	enabled: boolean;
	lastReadAt?: string;
	lastWriteAt?: string;
	lastError?: string;
}

export function readEnablement(filePath: string): EnablementState {
	if (!existsSync(filePath)) return { enabled: false };
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
			lastReadAt: typeof parsed.lastReadAt === "string" ? parsed.lastReadAt : undefined,
			lastWriteAt: typeof parsed.lastWriteAt === "string" ? parsed.lastWriteAt : undefined,
			lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
		};
	} catch {
		return { enabled: false };
	}
}

export function writeEnablement(filePath: string, state: EnablementState): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}
