// Unit tests for autocompact-lite: threshold computation, trigger behavior,
// cooldown, fail-open, settings parsing, and non-interference with Pi core.

import { test, expect } from "bun:test";
import {
	checkUsage,
	computeThreshold,
	resolveSettings,
	readSettingsBlock,
	shouldCompact,
	type CompactionSettings,
} from "../extensions/autocompact-lite/usage.ts";
import autoCompactLite, { type AutoCompactDeps } from "../extensions/autocompact-lite/index.ts";

type Handler = (event: any, ctx: any) => Promise<void> | void;

function harness(opts: {
	enabled?: boolean;
	thresholdPercent?: number;
	reserveTokens?: number;
	cooldownTurns?: number;
	tokens?: number | null;
	contextWindow?: number;
	compactThrows?: boolean;
}) {
	const settings = resolveSettings({
		enabled: opts.enabled ?? true,
		thresholdPercent: opts.thresholdPercent,
		reserveTokens: opts.reserveTokens,
		cooldownTurns: opts.cooldownTurns,
	});
	let turnStartHandler: Handler | undefined;
	let turnEndHandler: Handler | undefined;
	let shutdownHandler: Handler | undefined;
	const compactCalls: number[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const notices: Array<{ text: string; level: string }> = [];

	const pi = {
		on: (event: string, fn: Handler) => {
			if (event === "turn_start") turnStartHandler = fn;
			if (event === "turn_end") turnEndHandler = fn;
			if (event === "session_shutdown") shutdownHandler = fn;
		},
	};

	const deps: AutoCompactDeps = {
		getContextUsage: () => ({ tokens: opts.tokens ?? null, contextWindow: opts.contextWindow ?? 128_000, percent: null }),
		compact: () => {
			if (opts.compactThrows) throw new Error("compact failed");
			compactCalls.push(1);
		},
		getCompactionSettings: () => settings,
	};

	autoCompactLite(pi as never, deps);

	const ctx = {
		ui: {
			setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
			notify: (text: string, level: string) => notices.push({ text, level }),
		},
	};

	return {
		fireTurnStart: () => turnStartHandler!({}, ctx),
		fireTurnEnd: () => turnEndHandler!({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx),
		fireShutdown: () => shutdownHandler!({ type: "session_shutdown" }, ctx),
		compactCalls,
		statuses,
		notices,
		settings,
	};
}

// --- computeThreshold ---

test("computeThreshold: 85% of 128K = 108800, reserve 32K → threshold 95232 (min)", () => {
	const settings = resolveSettings({ thresholdPercent: 85, reserveTokens: 32768 });
	const threshold = computeThreshold(128_000, settings);
	// 85% of 128K = 108800; 128K - 32K = 95232; min = 95232
	expect(threshold).toBe(95232);
});

test("computeThreshold: 85% of 200K = 170000, reserve 32K → threshold 167232 (min)", () => {
	const settings = resolveSettings({ thresholdPercent: 85, reserveTokens: 32768 });
	const threshold = computeThreshold(200_000, settings);
	// 85% of 200K = 170000; 200K - 32768 = 167232; min = 167232
	expect(threshold).toBe(167232);
});

test("computeThreshold: 85% of 1M = 850000, reserve 32K → threshold 850000 (percent wins)", () => {
	const settings = resolveSettings({ thresholdPercent: 85, reserveTokens: 32768 });
	const threshold = computeThreshold(1_000_000, settings);
	expect(threshold).toBe(850000);
});

test("computeThreshold: 50% of 64K = 32000, reserve 32K → threshold 31232 (reserve wins)", () => {
	const settings = resolveSettings({ thresholdPercent: 50, reserveTokens: 32768 });
	const threshold = computeThreshold(64_000, settings);
	// 50% of 64K = 32000; 64K - 32768 = 31232; min = 31232
	expect(threshold).toBe(31232);
});

test("computeThreshold: 99% of 128K = 126720, reserve 32K → threshold 95232 (reserve wins)", () => {
	const settings = resolveSettings({ thresholdPercent: 99, reserveTokens: 32768 });
	const threshold = computeThreshold(128_000, settings);
	expect(threshold).toBe(95232);
});

// --- Default 85% behavior across window sizes ---

test("default 85% threshold: small window (64K) triggers at correct point", () => {
	const settings = resolveSettings({ enabled: true });
	// threshold = min(64K*0.85=54400, 64K-32768=31232) = 31232
	expect(computeThreshold(64_000, settings)).toBe(31232);
	expect(shouldCompact(31_231, 64_000, settings)).toBe(false);
	expect(shouldCompact(31_233, 64_000, settings)).toBe(true);
});

test("default 85% threshold: medium window (200K) triggers at correct point", () => {
	const settings = resolveSettings({ enabled: true });
	// threshold = min(200K*0.85=170000, 200K-32768=167232) = 167232
	expect(computeThreshold(200_000, settings)).toBe(167232);
	expect(shouldCompact(167_231, 200_000, settings)).toBe(false);
	expect(shouldCompact(167_233, 200_000, settings)).toBe(true);
});

test("default 85% threshold: large window (1M) triggers at correct point", () => {
	const settings = resolveSettings({ enabled: true });
	// threshold = min(1M*0.85=850000, 1M-32K=967680) = 850000
	expect(computeThreshold(1_000_000, settings)).toBe(850000);
	expect(shouldCompact(849_999, 1_000_000, settings)).toBe(false);
	expect(shouldCompact(850_001, 1_000_000, settings)).toBe(true);
});

// --- Boundary semantics ---

test("shouldCompact: exactly at threshold does NOT trigger (strict >)", () => {
	const settings = resolveSettings({ thresholdPercent: 85, reserveTokens: 32768 });
	const threshold = computeThreshold(200_000, settings);
	expect(shouldCompact(threshold, 200_000, settings)).toBe(false);
	expect(shouldCompact(threshold + 1, 200_000, settings)).toBe(true);
});

test("shouldCompact: contextWindow 0 returns false", () => {
	const settings = resolveSettings({ enabled: true });
	expect(shouldCompact(100_000, 0, settings)).toBe(false);
});

test("shouldCompact: disabled returns false regardless of tokens", () => {
	const settings = resolveSettings({ enabled: false });
	expect(shouldCompact(999_999, 128_000, settings)).toBe(false);
});

// --- Usage already >100% ---

test("shouldCompact: tokens > contextWindow (>100%) still triggers", () => {
	const settings = resolveSettings({ enabled: true });
	// 240K tokens / 200K window = 120% — should trigger
	expect(shouldCompact(240_000, 200_000, settings)).toBe(true);
});

test("checkUsage: >100% usage triggers compaction (no clamping)", () => {
	const settings = resolveSettings({ enabled: true });
	const result = checkUsage({ tokens: 240_000, contextWindow: 200_000, percent: 120.0 }, settings);
	expect(result.shouldCompact).toBe(true);
	expect(result.tokens).toBe(240_000);
});

// --- checkUsage null/undefined ---

test("checkUsage returns shouldCompact=false for null tokens", () => {
	const result = checkUsage({ tokens: null, contextWindow: 128_000, percent: null }, resolveSettings({ enabled: true }));
	expect(result.shouldCompact).toBe(false);
	expect(result.tokens).toBeNull();
});

test("checkUsage returns shouldCompact=false for undefined usage", () => {
	const result = checkUsage(undefined, resolveSettings({ enabled: true }));
	expect(result.shouldCompact).toBe(false);
});

test("checkUsage returns thresholdTokens even when tokens are null", () => {
	const result = checkUsage({ tokens: null, contextWindow: 200_000, percent: null }, resolveSettings({ enabled: true }));
	expect(result.thresholdTokens).toBe(167232);
});

// --- Settings parsing ---

test("resolveSettings: defaults are thresholdPercent=85, reserveTokens=32768, cooldownTurns=2", () => {
	const s = resolveSettings();
	expect(s.thresholdPercent).toBe(85);
	expect(s.reserveTokens).toBe(32768);
	expect(s.cooldownTurns).toBe(2);
	expect(s.enabled).toBe(true);
});

test("resolveSettings: invalid thresholdPercent falls back to default", () => {
	expect(resolveSettings({ thresholdPercent: 0 }).thresholdPercent).toBe(85);
	expect(resolveSettings({ thresholdPercent: 101 }).thresholdPercent).toBe(85);
	expect(resolveSettings({ thresholdPercent: -5 }).thresholdPercent).toBe(85);
	expect(resolveSettings({ thresholdPercent: NaN }).thresholdPercent).toBe(85);
	expect(resolveSettings({ thresholdPercent: "85" as unknown as number }).thresholdPercent).toBe(85);
});

test("resolveSettings: invalid reserveTokens falls back to default", () => {
	expect(resolveSettings({ reserveTokens: 0 }).reserveTokens).toBe(32768);
	expect(resolveSettings({ reserveTokens: -100 }).reserveTokens).toBe(32768);
	expect(resolveSettings({ reserveTokens: 2_000_000 }).reserveTokens).toBe(32768);
});

test("resolveSettings: invalid cooldownTurns falls back to default", () => {
	expect(resolveSettings({ cooldownTurns: -1 }).cooldownTurns).toBe(2);
	expect(resolveSettings({ cooldownTurns: 200 }).cooldownTurns).toBe(2);
});

test("resolveSettings: valid custom values are accepted", () => {
	const s = resolveSettings({ thresholdPercent: 70, reserveTokens: 16384, cooldownTurns: 5, enabled: false });
	expect(s.thresholdPercent).toBe(70);
	expect(s.reserveTokens).toBe(16384);
	expect(s.cooldownTurns).toBe(5);
	expect(s.enabled).toBe(false);
});

test("readSettingsBlock: extracts autoCompactLite block", () => {
	const settings = { autoCompactLite: { thresholdPercent: 75 }, other: "x" };
	const block = readSettingsBlock(settings);
	expect(block?.thresholdPercent).toBe(75);
});

test("readSettingsBlock: returns undefined for missing block", () => {
	expect(readSettingsBlock({ other: "x" })).toBeUndefined();
	expect(readSettingsBlock(undefined)).toBeUndefined();
	expect(readSettingsBlock({ autoCompactLite: "not-an-object" })).toBeUndefined();
});

// --- Trigger behavior ---

test("below-threshold turn_end does not trigger compact", async () => {
	const h = harness({ enabled: true, tokens: 10_000, contextWindow: 128_000 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls).toEqual([]);
});

test("above-threshold turn_end triggers compact once", async () => {
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(1);
	expect(h.statuses.some((s) => s.key === "autocompact-lite")).toBe(true);
});

test("double-trigger within same turn is prevented", async () => {
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(1);
});

test("new turn resets the per-turn guard", async () => {
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000, cooldownTurns: 0 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(2);
});

test("disabled compaction does not trigger", async () => {
	const h = harness({ enabled: false, tokens: 100_000, contextWindow: 128_000 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls).toEqual([]);
});

test("compact failure is reported and does not crash", async () => {
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000, compactThrows: true });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.notices.length).toBe(1);
	expect(h.notices[0].level).toBe("warning");
	expect(h.notices[0].text).toContain("autocompact-lite");
});

test("null tokens does not trigger compact", async () => {
	const h = harness({ enabled: true, tokens: null, contextWindow: 128_000 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls).toEqual([]);
});

test("shutdown clears status", async () => {
	const h = harness({ enabled: true, tokens: 10_000 });
	await h.fireShutdown();
	expect(h.statuses.some((s) => s.key === "autocompact-lite" && s.text === undefined)).toBe(true);
});

// --- Cooldown ---

test("cooldown: prevents re-trigger within cooldownTurns when tokens remain above threshold", async () => {
	// 128K window, threshold = min(128K*0.85=108800, 128K-32768=95232) = 95232
	// 100K tokens > 95232 threshold → triggers
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000, cooldownTurns: 2 });
	// Turn 1: triggers compaction
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(1);

	// Turn 2: tokens still above threshold, cooldown active → skip
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(1);

	// Turn 3: still within cooldown (2 turns) → skip
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(1);

	// Turn 4: cooldown expired (3 turns since compaction) → triggers again
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(2);
});

test("cooldown=0 disables cooldown (every turn can trigger)", async () => {
	const h = harness({ enabled: true, tokens: 100_000, contextWindow: 128_000, cooldownTurns: 0 });
	await h.fireTurnStart();
	await h.fireTurnEnd();
	await h.fireTurnStart();
	await h.fireTurnEnd();
	expect(h.compactCalls.length).toBe(2);
});

// --- Re-arming after observed token reduction ---

test("re-arming: compaction fires immediately if tokens drop below threshold then rise again", async () => {
	// 128K window, threshold = 95232. 100K > 95232 → triggers.
	let currentTokens = 100_000;
	const settings = resolveSettings({ enabled: true, cooldownTurns: 5 });
	let turnEndHandler: Handler | undefined;
	let turnStartHandler: Handler | undefined;
	const compactCalls: number[] = [];

	const pi = {
		on: (event: string, fn: Handler) => {
			if (event === "turn_start") turnStartHandler = fn;
			if (event === "turn_end") turnEndHandler = fn;
		},
	};

	const deps: AutoCompactDeps = {
		getContextUsage: () => ({ tokens: currentTokens, contextWindow: 128_000, percent: null }),
		compact: () => compactCalls.push(1),
		getCompactionSettings: () => settings,
	};

	autoCompactLite(pi as never, deps);
	const ctx = { ui: { setStatus: () => {}, notify: () => {} } };

	// Turn 1: triggers compaction (100K > threshold)
	await turnStartHandler!({}, ctx);
	await turnEndHandler!({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	expect(compactCalls.length).toBe(1);

	// Turn 2: tokens dropped below threshold (compaction worked)
	currentTokens = 20_000;
	await turnStartHandler!({}, ctx);
	await turnEndHandler!({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	expect(compactCalls.length).toBe(1);

	// Turn 3: tokens rose above threshold again — should trigger immediately
	// even though cooldown=5, because we observed a reduction below threshold
	currentTokens = 100_000;
	await turnStartHandler!({}, ctx);
	await turnEndHandler!({ type: "turn_end", turnIndex: 0, message: {}, toolResults: [] }, ctx);
	expect(compactCalls.length).toBe(2);
});

// --- Dynamic contextWindow (no hardcoded model names) ---

test("trigger threshold adapts to different contextWindow sizes dynamically", () => {
	const settings = resolveSettings({ enabled: true, thresholdPercent: 85, reserveTokens: 32768 });
	// 200K window (devin/glm-5-2)
	expect(computeThreshold(200_000, settings)).toBe(167232);
	// 1M window
	expect(computeThreshold(1_000_000, settings)).toBe(850000);
	// 128K window
	expect(computeThreshold(128_000, settings)).toBe(95232);
	// 64K window
	expect(computeThreshold(64_000, settings)).toBe(31232);
});

// --- Pi core non-interference ---

test("extension only adds turn_start/turn_end/session_shutdown handlers", () => {
	const registeredEvents: string[] = [];
	const pi = {
		on: (event: string) => { registeredEvents.push(event); },
	};
	autoCompactLite(pi as never);
	expect(registeredEvents).toEqual(["turn_start", "turn_end", "session_shutdown"]);
	expect(registeredEvents).not.toContain("session_before_compact");
	expect(registeredEvents).not.toContain("before_agent_start");
});
