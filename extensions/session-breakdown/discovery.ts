// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/session-breakdown.ts
// Changes: extracted from single-file extension into a dedicated module;
// import paths adjusted for this repo's directory convention. Licensed
// under Apache-2.0 as a derived work — see NOTICE in README.md.

import path from "node:path";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import readline from "node:readline";

export type ModelKey = string; // `${provider}/${model}`
export type CwdKey = string; // normalized cwd path
export type DowKey = string; // "Mon", "Tue", etc.
export type TodKey = string; // "after-midnight", "morning", "afternoon", "evening", "night"

export const DOW_NAMES: DowKey[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const TOD_BUCKETS: { key: TodKey; label: string; from: number; to: number }[] = [
	{ key: "after-midnight", label: "After midnight (0–5)", from: 0, to: 5 },
	{ key: "morning", label: "Morning (6–11)", from: 6, to: 11 },
	{ key: "afternoon", label: "Afternoon (12–16)", from: 12, to: 16 },
	{ key: "evening", label: "Evening (17–21)", from: 17, to: 21 },
	{ key: "night", label: "Night (22–23)", from: 22, to: 23 },
];

export function todBucketForHour(hour: number): TodKey {
	for (const b of TOD_BUCKETS) {
		if (hour >= b.from && hour <= b.to) return b.key;
	}
	return "after-midnight";
}

export function todBucketLabel(key: TodKey): string {
	return TOD_BUCKETS.find((b) => b.key === key)?.label ?? key;
}

export function mondayIndex(date: Date): number {
	return (date.getDay() + 6) % 7;
}

export function toLocalDayKey(d: Date): string {
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function localMidnight(d: Date): Date {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}

export function addDaysLocal(d: Date, days: number): Date {
	const x = new Date(d);
	x.setDate(x.getDate() + days);
	return x;
}

export function countDaysInclusiveLocal(start: Date, end: Date): number {
	let n = 0;
	for (let d = new Date(start); d <= end; d = addDaysLocal(d, 1)) n++;
	return n;
}

export interface ParsedSession {
	filePath: string;
	startedAt: Date;
	dayKeyLocal: string;
	cwd: CwdKey | null;
	dow: DowKey;
	tod: TodKey;
	modelsUsed: Set<ModelKey>;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
}

function modelKeyFromParts(provider?: unknown, model?: unknown): ModelKey | null {
	const p = typeof provider === "string" ? provider.trim() : "";
	const m = typeof model === "string" ? model.trim() : "";
	if (!p && !m) return null;
	if (!p) return m;
	if (!m) return p;
	return `${p}/${m}`;
}

function normalizedLowerString(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isFauxModelReference(parts: { api?: unknown; provider?: unknown; model?: unknown; modelId?: unknown }): boolean {
	const api = normalizedLowerString(parts.api);
	if (api === "faux" || api.startsWith("faux:")) return true;
	if (normalizedLowerString(parts.provider) === "faux") return true;
	const model = normalizedLowerString(parts.model ?? parts.modelId);
	return model === "faux" || model.startsWith("faux-");
}

export function parseSessionStartFromFilename(name: string): Date | null {
	const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
	if (!m) return null;
	const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
	const d = new Date(iso);
	return Number.isFinite(d.getTime()) ? d : null;
}

function extractProviderModelAndUsage(obj: any): { api?: any; provider?: any; model?: any; modelId?: any; usage?: any } {
	const msg = obj?.message;
	return {
		api: obj?.api ?? msg?.api,
		provider: obj?.provider ?? msg?.provider,
		model: obj?.model ?? msg?.model,
		modelId: obj?.modelId ?? msg?.modelId,
		usage: obj?.usage ?? msg?.usage,
	};
}

export function extractCostTotal(usage: any): number {
	if (!usage) return 0;
	const c = usage?.cost;
	if (typeof c === "number") return Number.isFinite(c) ? c : 0;
	if (typeof c === "string") {
		const n = Number(c);
		return Number.isFinite(n) ? n : 0;
	}
	const t = c?.total;
	if (typeof t === "number") return Number.isFinite(t) ? t : 0;
	if (typeof t === "string") {
		const n = Number(t);
		return Number.isFinite(n) ? n : 0;
	}
	return 0;
}

export function extractTokensTotal(usage: any): number {
	if (!usage) return 0;
	const readNum = (v: any): number => {
		if (typeof v === "number") return Number.isFinite(v) ? v : 0;
		if (typeof v === "string") {
			const n = Number(v);
			return Number.isFinite(n) ? n : 0;
		}
		return 0;
	};

	let total = 0;
	total =
		readNum(usage?.totalTokens) ||
		readNum(usage?.total_tokens) ||
		readNum(usage?.tokens) ||
		readNum(usage?.tokenCount) ||
		readNum(usage?.token_count);
	if (total > 0) return total;

	total = readNum(usage?.tokens?.total) || readNum(usage?.tokens?.totalTokens) || readNum(usage?.tokens?.total_tokens);
	if (total > 0) return total;

	const a =
		readNum(usage?.promptTokens) ||
		readNum(usage?.prompt_tokens) ||
		readNum(usage?.inputTokens) ||
		readNum(usage?.input_tokens);
	const b =
		readNum(usage?.completionTokens) ||
		readNum(usage?.completion_tokens) ||
		readNum(usage?.outputTokens) ||
		readNum(usage?.output_tokens);
	const sum = a + b;
	return sum > 0 ? sum : 0;
}

export async function walkSessionFiles(
	root: string,
	startCutoffLocal: Date,
	signal?: AbortSignal,
	onFound?: (found: number) => void,
): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [root];
	while (stack.length) {
		if (signal?.aborted) break;
		const dir = stack.pop()!;
		let entries: Dirent[] = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const ent of entries) {
			if (signal?.aborted) break;
			const p = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				stack.push(p);
				continue;
			}
			if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;

			const startedAt = parseSessionStartFromFilename(ent.name);
			if (startedAt) {
				if (localMidnight(startedAt) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
				continue;
			}

			try {
				const st = await fs.stat(p);
				const approx = new Date(st.mtimeMs);
				if (localMidnight(approx) >= startCutoffLocal) {
					out.push(p);
					if (onFound && out.length % 10 === 0) onFound(out.length);
				}
			} catch {
				// ignore
			}
		}
	}
	onFound?.(out.length);
	return out;
}

export async function parseSessionFile(filePath: string, signal?: AbortSignal): Promise<ParsedSession | null> {
	const fileName = path.basename(filePath);
	let startedAt = parseSessionStartFromFilename(fileName);
	let currentModel: ModelKey | null = null;
	let currentModelIsFaux = false;
	let cwd: CwdKey | null = null;

	const modelsUsed = new Set<ModelKey>();
	let messages = 0;
	let tokens = 0;
	let totalCost = 0;
	const costByModel = new Map<ModelKey, number>();
	const messagesByModel = new Map<ModelKey, number>();
	const tokensByModel = new Map<ModelKey, number>();

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			if (signal?.aborted) {
				rl.close();
				stream.destroy();
				return null;
			}
			if (!line) continue;
			let obj: any;
			try {
				obj = JSON.parse(line);
			} catch {
				continue;
			}

			if (obj?.type === "session") {
				if (!startedAt && typeof obj?.timestamp === "string") {
					const d = new Date(obj.timestamp);
					if (Number.isFinite(d.getTime())) startedAt = d;
				}
				if (typeof obj?.cwd === "string" && obj.cwd.trim()) {
					cwd = obj.cwd.trim();
				}
				continue;
			}

			if (obj?.type === "model_change") {
				if (isFauxModelReference({ api: obj.api, provider: obj.provider, modelId: obj.modelId })) {
					currentModel = null;
					currentModelIsFaux = true;
					continue;
				}

				const mk = modelKeyFromParts(obj.provider, obj.modelId);
				currentModel = mk;
				currentModelIsFaux = false;
				if (mk) {
					modelsUsed.add(mk);
				}
				continue;
			}

			if (obj?.type !== "message") continue;

			const { api, provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
			const explicitMk = modelKeyFromParts(provider, model) ?? modelKeyFromParts(provider, modelId);
			if (isFauxModelReference({ api, provider, model, modelId })) {
				currentModel = null;
				currentModelIsFaux = true;
				continue;
			}
			if (!explicitMk && currentModelIsFaux) continue;

			const mk = explicitMk ?? currentModel ?? "unknown";
			if (explicitMk) {
				currentModel = explicitMk;
				currentModelIsFaux = false;
			}
			modelsUsed.add(mk);

			messages += 1;
			messagesByModel.set(mk, (messagesByModel.get(mk) ?? 0) + 1);

			const tok = extractTokensTotal(usage);
			if (tok > 0) {
				tokens += tok;
				tokensByModel.set(mk, (tokensByModel.get(mk) ?? 0) + tok);
			}

			const cost = extractCostTotal(usage);
			if (cost > 0) {
				totalCost += cost;
				costByModel.set(mk, (costByModel.get(mk) ?? 0) + cost);
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	if (!startedAt || (messages === 0 && modelsUsed.size === 0 && tokens === 0 && totalCost === 0)) return null;
	const dayKeyLocal = toLocalDayKey(startedAt);
	const dow = DOW_NAMES[mondayIndex(startedAt)];
	const tod = todBucketForHour(startedAt.getHours());
	return {
		filePath,
		startedAt,
		dayKeyLocal,
		cwd,
		dow,
		tod,
		modelsUsed,
		messages,
		tokens,
		totalCost,
		costByModel,
		messagesByModel,
		tokensByModel,
	};
}
