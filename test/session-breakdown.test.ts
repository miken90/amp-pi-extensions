// Unit tests for session-breakdown: pure parse/aggregate functions tested
// against synthetic JSONL fixtures. No real ~/.pi/agent/sessions access.

import { test, expect } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	parseSessionStartFromFilename,
	extractTokensTotal,
	extractCostTotal,
	todBucketForHour,
	mondayIndex,
	toLocalDayKey,
	localMidnight,
	addDaysLocal,
	walkSessionFiles,
	parseSessionFile,
} from "../extensions/session-breakdown/discovery.ts";
import {
	buildRangeAgg,
	addSessionToRange,
	choosePaletteFromLast30Days,
	graphMetricForRange,
	rangeSummary,
	formatCount,
	formatUsd,
	RANGE_DAYS,
	computeBreakdown,
	type ParsedSession,
} from "../extensions/session-breakdown/breakdown.ts";

test("parseSessionStartFromFilename extracts UTC timestamp", () => {
	const d = parseSessionStartFromFilename("2026-02-02T21-52-28-774Z_abc.jsonl");
	expect(d).not.toBeNull();
	expect(d!.toISOString()).toBe("2026-02-02T21:52:28.774Z");
});

test("parseSessionStartFromFilename returns null for non-matching name", () => {
	expect(parseSessionStartFromFilename("random.jsonl")).toBeNull();
});

test("extractTokensTotal handles various usage shapes", () => {
	expect(extractTokensTotal({ totalTokens: 100 })).toBe(100);
	expect(extractTokensTotal({ total_tokens: 200 })).toBe(200);
	expect(extractTokensTotal({ promptTokens: 30, completionTokens: 70 })).toBe(100);
	expect(extractTokensTotal({ prompt_tokens: 40, completion_tokens: 60 })).toBe(100);
	expect(extractTokensTotal({ inputTokens: 50, outputTokens: 50 })).toBe(100);
	expect(extractTokensTotal({ tokens: { total: 300 } })).toBe(300);
	expect(extractTokensTotal(null)).toBe(0);
	expect(extractTokensTotal({})).toBe(0);
});

test("extractCostTotal handles various cost shapes", () => {
	expect(extractCostTotal({ cost: 0.05 })).toBe(0.05);
	expect(extractCostTotal({ cost: "0.10" })).toBe(0.10);
	expect(extractCostTotal({ cost: { total: 0.15 } })).toBe(0.15);
	expect(extractCostTotal({ cost: { total: "0.20" } })).toBe(0.20);
	expect(extractCostTotal(null)).toBe(0);
});

test("todBucketForHour maps hours correctly", () => {
	expect(todBucketForHour(0)).toBe("after-midnight");
	expect(todBucketForHour(3)).toBe("after-midnight");
	expect(todBucketForHour(6)).toBe("morning");
	expect(todBucketForHour(11)).toBe("morning");
	expect(todBucketForHour(12)).toBe("afternoon");
	expect(todBucketForHour(16)).toBe("afternoon");
	expect(todBucketForHour(17)).toBe("evening");
	expect(todBucketForHour(21)).toBe("evening");
	expect(todBucketForHour(22)).toBe("night");
	expect(todBucketForHour(23)).toBe("night");
});

test("mondayIndex returns Mon=0 .. Sun=6", () => {
	expect(mondayIndex(new Date("2026-08-03"))).toBe(0); // Monday
	expect(mondayIndex(new Date("2026-08-04"))).toBe(1); // Tuesday
	expect(mondayIndex(new Date("2026-08-09"))).toBe(6); // Sunday
});

test("toLocalDayKey formats YYYY-MM-DD", () => {
	expect(toLocalDayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
	expect(toLocalDayKey(new Date(2026, 11, 31))).toBe("2026-12-31");
});

test("localMidnight zeroes time components", () => {
	const d = localMidnight(new Date(2026, 7, 5, 14, 30, 45, 999));
	expect(d.getHours()).toBe(0);
	expect(d.getMinutes()).toBe(0);
	expect(d.getDate()).toBe(5);
});

test("addDaysLocal advances date correctly", () => {
	const d = addDaysLocal(new Date(2026, 7, 5), 10);
	expect(d.getDate()).toBe(15);
});

test("formatCount abbreviates large numbers", () => {
	expect(formatCount(0)).toBe("0");
	expect(formatCount(999)).toBe("999");
	expect(formatCount(10_000)).toBe("10.0K");
	expect(formatCount(1_000_000)).toBe("1.0M");
});

test("formatUsd formats cost with appropriate precision", () => {
	expect(formatUsd(0)).toBe("$0.0000");
	expect(formatUsd(1.5)).toBe("$1.50");
	expect(formatUsd(0.15)).toBe("$0.150");
	expect(formatUsd(0.001)).toBe("$0.0010");
});

// --- Synthetic session file parsing ---

function makeSessionDir(): string {
	return mkdtempSync(join(tmpdir(), "sb-test-"));
}

function writeSessionFile(dir: string, name: string, lines: object[]): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
	return filePath;
}

test("parseSessionFile parses a valid session with messages and usage", async () => {
	const dir = makeSessionDir();
	const filePath = writeSessionFile(dir, "2026-08-01T10-30-00-000Z_test.jsonl", [
		{ type: "session", timestamp: "2026-08-01T10:30:00.000Z", cwd: "/home/user/project" },
		{ type: "model_change", provider: "openai", modelId: "gpt-4" },
		{ type: "message", provider: "openai", model: "gpt-4", usage: { totalTokens: 500, cost: { total: 0.02 } } },
		{ type: "message", provider: "openai", model: "gpt-4", usage: { totalTokens: 300, cost: { total: 0.01 } } },
	]);

	const session = await parseSessionFile(filePath);
	expect(session).not.toBeNull();
	expect(session!.messages).toBe(2);
	expect(session!.tokens).toBe(800);
	expect(session!.totalCost).toBe(0.03);
	expect(session!.cwd).toBe("/home/user/project");
	expect(session!.modelsUsed.has("openai/gpt-4")).toBe(true);
});

test("parseSessionFile returns null for empty file", async () => {
	const dir = makeSessionDir();
	const filePath = writeSessionFile(dir, "2026-08-01T10-30-00-000Z_empty.jsonl", []);
	const session = await parseSessionFile(filePath);
	expect(session).toBeNull();
});

test("parseSessionFile filters faux model references", async () => {
	const dir = makeSessionDir();
	const filePath = writeSessionFile(dir, "2026-08-01T10-30-00-000Z_faux.jsonl", [
		{ type: "session", timestamp: "2026-08-01T10:30:00.000Z", cwd: "/test" },
		{ type: "model_change", provider: "faux", modelId: "faux-1" },
		{ type: "message", provider: "faux", model: "faux-1", usage: { totalTokens: 100 } },
	]);

	const session = await parseSessionFile(filePath);
	expect(session).toBeNull();
});

// --- walkSessionFiles ---

test("walkSessionFiles finds JSONL files within date range", async () => {
	const dir = makeSessionDir();
	writeSessionFile(dir, "2026-08-01T10-30-00-000Z_a.jsonl", [{ type: "session" }]);
	writeSessionFile(dir, "2026-08-02T10-30-00-000Z_b.jsonl", [{ type: "session" }]);
	writeSessionFile(dir, "not-jsonl.txt", [{ type: "session" }]);

	const cutoff = localMidnight(addDaysLocal(new Date(), -90));
	const files = await walkSessionFiles(dir, cutoff);
	expect(files.length).toBe(2);
	expect(files.every((f) => f.endsWith(".jsonl"))).toBe(true);
});

test("walkSessionFiles handles missing directory gracefully", async () => {
	const files = await walkSessionFiles(join(tmpdir(), "nonexistent-sb-dir"), localMidnight(new Date()));
	expect(files).toEqual([]);
});

// --- Range aggregation ---

test("buildRangeAgg creates correct number of days", () => {
	const now = new Date();
	for (const days of RANGE_DAYS) {
		const range = buildRangeAgg(days, now);
		expect(range.days.length).toBe(days);
		expect(range.dayByKey.size).toBe(days);
	}
});

test("addSessionToRange accumulates metrics", () => {
	const now = new Date();
	const range = buildRangeAgg(7, now);
	const session: ParsedSession = {
		filePath: "/test.jsonl",
		startedAt: now,
		dayKeyLocal: toLocalDayKey(now),
		cwd: "/home/test",
		dow: "Mon",
		tod: "morning",
		modelsUsed: new Set(["openai/gpt-4"]),
		messages: 5,
		tokens: 1000,
		totalCost: 0.05,
		costByModel: new Map([["openai/gpt-4", 0.05]]),
		messagesByModel: new Map([["openai/gpt-4", 5]]),
		tokensByModel: new Map([["openai/gpt-4", 1000]]),
	};

	addSessionToRange(range, session);
	expect(range.sessions).toBe(1);
	expect(range.totalMessages).toBe(5);
	expect(range.totalTokens).toBe(1000);
	expect(range.totalCost).toBe(0.05);
});

test("graphMetricForRange falls back from tokens to messages to sessions", () => {
	const now = new Date();
	const range = buildRangeAgg(7, now);
	// Empty range: tokens=0, messages=0, sessions=0 → falls back to sessions
	const metric = graphMetricForRange(range, "tokens");
	expect(metric.kind).toBe("sessions");
});

test("rangeSummary formats correctly for each mode", () => {
	const now = new Date();
	const range = buildRangeAgg(7, now);
	range.sessions = 10;
	range.totalMessages = 100;
	range.totalTokens = 5000;
	range.totalCost = 2.50;

	expect(rangeSummary(range, 7, "sessions")).toContain("10 sessions");
	expect(rangeSummary(range, 7, "messages")).toContain("100 messages");
	expect(rangeSummary(range, 7, "tokens")).toContain("5,000 tokens");
});

test("choosePaletteFromLast30Days assigns colors to top models", () => {
	const now = new Date();
	const range = buildRangeAgg(30, now);
	range.modelSessions.set("openai/gpt-4", 100);
	range.modelSessions.set("anthropic/claude", 50);

	const palette = choosePaletteFromLast30Days(range, 4);
	expect(palette.orderedModels.length).toBe(2);
	expect(palette.modelColors.has("openai/gpt-4")).toBe(true);
	expect(palette.modelColors.has("anthropic/claude")).toBe(true);
});

// --- Zero-file edge case ---

test("computeBreakdown with empty session directory produces empty ranges", async () => {
	const dir = makeSessionDir();
	const data = await computeBreakdown(dir);
	for (const days of RANGE_DAYS) {
		const range = data.ranges.get(days)!;
		expect(range.sessions).toBe(0);
		expect(range.totalMessages).toBe(0);
	}
});
