// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/session-breakdown.ts
// Changes: extracted from single-file extension into a dedicated module;
// import paths adjusted for this repo's directory convention. Licensed
// under Apache-2.0 as a derived work — see NOTICE in README.md.

import {
	type ModelKey,
	type CwdKey,
	type DowKey,
	type TodKey,
	type ParsedSession,
	DOW_NAMES,
	TOD_BUCKETS,
	toLocalDayKey,
	localMidnight,
	addDaysLocal,
	walkSessionFiles,
	parseSessionFile,
} from "./discovery.ts";

export type BreakdownView = "model" | "cwd" | "dow" | "tod";
export type MeasurementMode = "sessions" | "messages" | "tokens";

export interface DayAgg {
	date: Date;
	dayKeyLocal: string;
	sessions: number;
	messages: number;
	tokens: number;
	totalCost: number;
	costByModel: Map<ModelKey, number>;
	sessionsByModel: Map<ModelKey, number>;
	messagesByModel: Map<ModelKey, number>;
	tokensByModel: Map<ModelKey, number>;
	sessionsByCwd: Map<CwdKey, number>;
	messagesByCwd: Map<CwdKey, number>;
	tokensByCwd: Map<CwdKey, number>;
	costByCwd: Map<CwdKey, number>;
	sessionsByTod: Map<TodKey, number>;
	messagesByTod: Map<TodKey, number>;
	tokensByTod: Map<TodKey, number>;
	costByTod: Map<TodKey, number>;
}

export interface RangeAgg {
	days: DayAgg[];
	dayByKey: Map<string, DayAgg>;
	sessions: number;
	totalMessages: number;
	totalTokens: number;
	totalCost: number;
	modelCost: Map<ModelKey, number>;
	modelSessions: Map<ModelKey, number>;
	modelMessages: Map<ModelKey, number>;
	modelTokens: Map<ModelKey, number>;
	cwdCost: Map<CwdKey, number>;
	cwdSessions: Map<CwdKey, number>;
	cwdMessages: Map<CwdKey, number>;
	cwdTokens: Map<CwdKey, number>;
	dowCost: Map<DowKey, number>;
	dowSessions: Map<DowKey, number>;
	dowMessages: Map<DowKey, number>;
	dowTokens: Map<DowKey, number>;
	todCost: Map<TodKey, number>;
	todSessions: Map<TodKey, number>;
	todMessages: Map<TodKey, number>;
	todTokens: Map<TodKey, number>;
}

export interface RGB {
	r: number;
	g: number;
	b: number;
}

export interface BreakdownData {
	generatedAt: Date;
	ranges: Map<number, RangeAgg>;
	palette: {
		modelColors: Map<ModelKey, RGB>;
		otherColor: RGB;
		orderedModels: ModelKey[];
	};
	cwdPalette: {
		cwdColors: Map<CwdKey, RGB>;
		otherColor: RGB;
		orderedCwds: CwdKey[];
	};
	dowPalette: {
		dowColors: Map<DowKey, RGB>;
		orderedDows: DowKey[];
	};
	todPalette: {
		todColors: Map<TodKey, RGB>;
		orderedTods: TodKey[];
	};
}

export const RANGE_DAYS = [7, 30, 90] as const;

// Dark-ish background and empty cell color (close to GitHub dark)
export const DEFAULT_BG: RGB = { r: 13, g: 17, b: 23 };
export const EMPTY_CELL_BG: RGB = { r: 22, g: 27, b: 34 };

// Default palette (assigned to top models)
const PALETTE: RGB[] = [
	{ r: 64, g: 196, b: 99 }, // green
	{ r: 47, g: 129, b: 247 }, // blue
	{ r: 163, g: 113, b: 247 }, // purple
	{ r: 255, g: 159, b: 10 }, // orange
	{ r: 244, g: 67, b: 54 }, // red
];

// Fixed palette for day-of-week: weekdays get cool tones, weekend gets warm
const DOW_PALETTE: RGB[] = [
	{ r: 47, g: 129, b: 247 },  // Mon – blue
	{ r: 64, g: 196, b: 99 },   // Tue – green
	{ r: 163, g: 113, b: 247 }, // Wed – purple
	{ r: 47, g: 175, b: 200 },  // Thu – teal
	{ r: 100, g: 200, b: 150 }, // Fri – mint
	{ r: 255, g: 159, b: 10 },  // Sat – orange
	{ r: 244, g: 67, b: 54 },   // Sun – red
];

// Fixed palette for time-of-day buckets
const TOD_PALETTE: Map<TodKey, RGB> = new Map([
	["after-midnight", { r: 100, g: 60, b: 180 }],  // deep purple
	["morning", { r: 255, g: 200, b: 50 }],          // golden yellow
	["afternoon", { r: 64, g: 196, b: 99 }],         // green
	["evening", { r: 47, g: 129, b: 247 }],           // blue
	["night", { r: 60, g: 40, b: 140 }],              // dark indigo
]);

export function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

export function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
	return {
		r: Math.round(lerp(a.r, b.r, t)),
		g: Math.round(lerp(a.g, b.g, t)),
		b: Math.round(lerp(a.b, b.b, t)),
	};
}

function weightedMix(colors: Array<{ color: RGB; weight: number }>): RGB {
	let total = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	for (const c of colors) {
		if (!Number.isFinite(c.weight) || c.weight <= 0) continue;
		total += c.weight;
		r += c.color.r * c.weight;
		g += c.color.g * c.weight;
		b += c.color.b * c.weight;
	}
	if (total <= 0) return EMPTY_CELL_BG;
	return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total) };
}

export function ansiBg(rgb: RGB, text: string): string {
	return `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

export function ansiFg(rgb: RGB, text: string): string {
	return `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[0m`;
}

export function dim(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

export function bold(text: string): string {
	return `\x1b[1m${text}\x1b[0m`;
}

export function formatCount(n: number): string {
	if (!Number.isFinite(n) || n === 0) return "0";
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
	return n.toLocaleString("en-US");
}

export function formatUsd(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.00";
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(4)}`;
}

export function padRight(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? s + " ".repeat(delta) : s;
}

export function padLeft(s: string, n: number): string {
	const delta = n - s.length;
	return delta > 0 ? " ".repeat(delta) + s : s;
}

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
	return [...m.entries()]
		.map(([key, value]) => ({ key, value }))
		.sort((a, b) => b.value - a.value);
}

export function buildRangeAgg(days: number, now: Date): RangeAgg {
	const end = localMidnight(now);
	const start = addDaysLocal(end, -(days - 1));
	const outDays: DayAgg[] = [];
	const dayByKey = new Map<string, DayAgg>();

	for (let i = 0; i < days; i++) {
		const d = addDaysLocal(start, i);
		const dayKeyLocal = toLocalDayKey(d);
		const day: DayAgg = {
			date: d,
			dayKeyLocal,
			sessions: 0,
			messages: 0,
			tokens: 0,
			totalCost: 0,
			costByModel: new Map(),
			sessionsByModel: new Map(),
			messagesByModel: new Map(),
			tokensByModel: new Map(),
			sessionsByCwd: new Map(),
			messagesByCwd: new Map(),
			tokensByCwd: new Map(),
			costByCwd: new Map(),
			sessionsByTod: new Map(),
			messagesByTod: new Map(),
			tokensByTod: new Map(),
			costByTod: new Map(),
		};
		outDays.push(day);
		dayByKey.set(dayKeyLocal, day);
	}

	return {
		days: outDays,
		dayByKey,
		sessions: 0,
		totalMessages: 0,
		totalTokens: 0,
		totalCost: 0,
		modelCost: new Map(),
		modelSessions: new Map(),
		modelMessages: new Map(),
		modelTokens: new Map(),
		cwdCost: new Map(),
		cwdSessions: new Map(),
		cwdMessages: new Map(),
		cwdTokens: new Map(),
		dowCost: new Map(),
		dowSessions: new Map(),
		dowMessages: new Map(),
		dowTokens: new Map(),
		todCost: new Map(),
		todSessions: new Map(),
		todMessages: new Map(),
		todTokens: new Map(),
	};
}

export function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
	const day = range.dayByKey.get(session.dayKeyLocal);
	if (!day) return;

	range.sessions += 1;
	range.totalMessages += session.messages;
	range.totalTokens += session.tokens;
	range.totalCost += session.totalCost;
	day.sessions += 1;
	day.messages += session.messages;
	day.tokens += session.tokens;
	day.totalCost += session.totalCost;

	for (const mk of session.modelsUsed) {
		day.sessionsByModel.set(mk, (day.sessionsByModel.get(mk) ?? 0) + 1);
		range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
	}

	for (const [mk, n] of session.messagesByModel.entries()) {
		day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
		range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
	}

	for (const [mk, n] of session.tokensByModel.entries()) {
		day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
		range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
	}

	for (const [mk, cost] of session.costByModel.entries()) {
		day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
		range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
	}

	const cwd = session.cwd;
	if (cwd) {
		day.sessionsByCwd.set(cwd, (day.sessionsByCwd.get(cwd) ?? 0) + 1);
		range.cwdSessions.set(cwd, (range.cwdSessions.get(cwd) ?? 0) + 1);
		day.messagesByCwd.set(cwd, (day.messagesByCwd.get(cwd) ?? 0) + session.messages);
		range.cwdMessages.set(cwd, (range.cwdMessages.get(cwd) ?? 0) + session.messages);
		day.tokensByCwd.set(cwd, (day.tokensByCwd.get(cwd) ?? 0) + session.tokens);
		range.cwdTokens.set(cwd, (range.cwdTokens.get(cwd) ?? 0) + session.tokens);
		day.costByCwd.set(cwd, (day.costByCwd.get(cwd) ?? 0) + session.totalCost);
		range.cwdCost.set(cwd, (range.cwdCost.get(cwd) ?? 0) + session.totalCost);
	}

	const dow = session.dow;
	range.dowSessions.set(dow, (range.dowSessions.get(dow) ?? 0) + 1);
	range.dowMessages.set(dow, (range.dowMessages.get(dow) ?? 0) + session.messages);
	range.dowTokens.set(dow, (range.dowTokens.get(dow) ?? 0) + session.tokens);
	range.dowCost.set(dow, (range.dowCost.get(dow) ?? 0) + session.totalCost);

	const tod = session.tod;
	day.sessionsByTod.set(tod, (day.sessionsByTod.get(tod) ?? 0) + 1);
	day.messagesByTod.set(tod, (day.messagesByTod.get(tod) ?? 0) + session.messages);
	day.tokensByTod.set(tod, (day.tokensByTod.get(tod) ?? 0) + session.tokens);
	day.costByTod.set(tod, (day.costByTod.get(tod) ?? 0) + session.totalCost);
	range.todSessions.set(tod, (range.todSessions.get(tod) ?? 0) + 1);
	range.todMessages.set(tod, (range.todMessages.get(tod) ?? 0) + session.messages);
	range.todTokens.set(tod, (range.todTokens.get(tod) ?? 0) + session.tokens);
	range.todCost.set(tod, (range.todCost.get(tod) ?? 0) + session.totalCost);
}

export function choosePaletteFromLast30Days(range30: RangeAgg, topN = 4): {
	modelColors: Map<ModelKey, RGB>;
	otherColor: RGB;
	orderedModels: ModelKey[];
} {
	const costSum = [...range30.modelCost.values()].reduce((a, b) => a + b, 0);
	const popularity =
		costSum > 0
			? range30.modelCost
			: range30.totalTokens > 0
				? range30.modelTokens
				: range30.totalMessages > 0
					? range30.modelMessages
					: range30.modelSessions;

	const sorted = sortMapByValueDesc(popularity);
	const orderedModels = sorted.slice(0, topN).map((x) => x.key);
	const modelColors = new Map<ModelKey, RGB>();
	for (let i = 0; i < orderedModels.length; i++) {
		modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
	}
	return {
		modelColors,
		otherColor: { r: 160, g: 160, b: 160 },
		orderedModels,
	};
}

export function chooseCwdPaletteFromLast30Days(range30: RangeAgg, topN = 4): {
	cwdColors: Map<CwdKey, RGB>;
	otherColor: RGB;
	orderedCwds: CwdKey[];
} {
	const costSum = [...range30.cwdCost.values()].reduce((a, b) => a + b, 0);
	const popularity =
		costSum > 0
			? range30.cwdCost
			: range30.totalTokens > 0
				? range30.cwdTokens
				: range30.totalMessages > 0
					? range30.cwdMessages
					: range30.cwdSessions;

	const sorted = sortMapByValueDesc(popularity);
	const orderedCwds = sorted.slice(0, topN).map((x) => x.key);
	const cwdColors = new Map<CwdKey, RGB>();
	for (let i = 0; i < orderedCwds.length; i++) {
		cwdColors.set(orderedCwds[i], PALETTE[i % PALETTE.length]);
	}
	return {
		cwdColors,
		otherColor: { r: 160, g: 160, b: 160 },
		orderedCwds,
	};
}

export function buildDowPalette(): { dowColors: Map<DowKey, RGB>; orderedDows: DowKey[] } {
	const dowColors = new Map<DowKey, RGB>();
	for (let i = 0; i < DOW_NAMES.length; i++) {
		dowColors.set(DOW_NAMES[i], DOW_PALETTE[i]);
	}
	return { dowColors, orderedDows: [...DOW_NAMES] };
}

export function buildTodPalette(): { todColors: Map<TodKey, RGB>; orderedTods: TodKey[] } {
	const todColors = new Map<TodKey, RGB>();
	const orderedTods: TodKey[] = [];
	for (const b of TOD_BUCKETS) {
		const c = TOD_PALETTE.get(b.key);
		if (c) todColors.set(b.key, c);
		orderedTods.push(b.key);
	}
	return { todColors, orderedTods };
}

export function dayMixedColor(
	day: DayAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	view: BreakdownView = "model",
): RGB {
	const parts: Array<{ color: RGB; weight: number }> = [];
	let otherWeight = 0;

	let map: Map<string, number>;
	if (view === "dow") {
		const dowKey = DOW_NAMES[(day.date.getDay() + 6) % 7];
		const c = colorMap.get(dowKey);
		return c ?? otherColor;
	} else if (view === "tod") {
		if (mode === "tokens") {
			map = day.tokens > 0 ? day.tokensByTod : day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
		} else if (mode === "messages") {
			map = day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
		} else {
			map = day.sessionsByTod;
		}
	} else if (view === "cwd") {
		if (mode === "tokens") {
			map = day.tokens > 0 ? day.tokensByCwd : day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
		} else if (mode === "messages") {
			map = day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
		} else {
			map = day.sessionsByCwd;
		}
	} else {
		if (mode === "tokens") {
			map = day.tokens > 0 ? day.tokensByModel : day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
		} else if (mode === "messages") {
			map = day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
		} else {
			map = day.sessionsByModel;
		}
	}

	for (const [mk, w] of map.entries()) {
		const c = colorMap.get(mk);
		if (c) parts.push({ color: c, weight: w });
		else otherWeight += w;
	}
	if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });
	return weightedMix(parts);
}

export function graphMetricForRange(
	range: RangeAgg,
	mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; max: number; denom: number } {
	if (mode === "tokens") {
		const maxTokens = Math.max(0, ...range.days.map((d) => d.tokens));
		if (maxTokens > 0) return { kind: "tokens", max: maxTokens, denom: Math.log1p(maxTokens) };
		mode = "messages";
	}

	if (mode === "messages") {
		const maxMessages = Math.max(0, ...range.days.map((d) => d.messages));
		if (maxMessages > 0) return { kind: "messages", max: maxMessages, denom: Math.log1p(maxMessages) };
		mode = "sessions";
	}

	const maxSessions = Math.max(0, ...range.days.map((d) => d.sessions));
	return { kind: "sessions", max: maxSessions, denom: Math.log1p(maxSessions) };
}

export function rangeSummary(range: RangeAgg, days: number, mode: MeasurementMode): string {
	const avg = range.sessions > 0 ? range.totalCost / range.sessions : 0;
	const costPart = range.totalCost > 0 ? `${formatUsd(range.totalCost)} · avg ${formatUsd(avg)}/session` : `$0.0000`;

	if (mode === "tokens") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalTokens)} tokens · ${costPart}`;
	}
	if (mode === "messages") {
		return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${formatCount(range.totalMessages)} messages · ${costPart}`;
	}
	return `Last ${days} days: ${formatCount(range.sessions)} sessions · ${costPart}`;
}

export type BreakdownProgressPhase = "scan" | "parse" | "finalize";

export interface BreakdownProgressState {
	phase: BreakdownProgressPhase;
	foundFiles: number;
	parsedFiles: number;
	totalFiles: number;
	currentFile?: string;
}

export async function computeBreakdown(
	sessionRoot: string,
	signal?: AbortSignal,
	onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
	const now = new Date();
	const ranges = new Map<number, RangeAgg>();
	for (const d of RANGE_DAYS) ranges.set(d, buildRangeAgg(d, now));
	const range90 = ranges.get(90)!;
	const start90 = range90.days[0].date;

	onProgress?.({ phase: "scan", foundFiles: 0, parsedFiles: 0, totalFiles: 0, currentFile: undefined });

	const candidates = await walkSessionFiles(sessionRoot, start90, signal, (found) => {
		onProgress?.({ phase: "scan", foundFiles: found });
	});

	const totalFiles = candidates.length;
	onProgress?.({
		phase: "parse",
		foundFiles: totalFiles,
		totalFiles,
		parsedFiles: 0,
		currentFile: totalFiles > 0 ? candidates[0] : undefined,
	});

	let parsedFiles = 0;
	for (const filePath of candidates) {
		if (signal?.aborted) break;
		parsedFiles += 1;
		onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: filePath });

		const session = await parseSessionFile(filePath, signal);
		if (!session) continue;

		const sessionDay = localMidnight(session.startedAt);
		for (const d of RANGE_DAYS) {
			const range = ranges.get(d)!;
			const start = range.days[0].date;
			const end = range.days[range.days.length - 1].date;
			if (sessionDay < start || sessionDay > end) continue;
			addSessionToRange(range, session);
		}
	}

	onProgress?.({ phase: "finalize", currentFile: undefined });

	const palette = choosePaletteFromLast30Days(ranges.get(30)!, 4);
	const cwdPalette = chooseCwdPaletteFromLast30Days(ranges.get(30)!, 4);
	const dowPalette = buildDowPalette();
	const todPalette = buildTodPalette();
	return { generatedAt: now, ranges, palette, cwdPalette, dowPalette, todPalette };
}
