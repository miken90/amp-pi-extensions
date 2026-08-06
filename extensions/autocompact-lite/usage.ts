// Inspired by darkamenosa/pi-setup's autocompact.ts (Apache-2.0);
// no source lines copied — reimplemented against Pi 0.83's public
// compaction API. See NOTICE in README.md.

export interface CompactionSettings {
	enabled: boolean;
	/** Compact when context tokens exceed contextWindow * thresholdPercent / 100. */
	thresholdPercent: number;
	/** Safety reserve: also compact when context tokens exceed contextWindow - reserveTokens. */
	reserveTokens: number;
	keepRecentTokens: number;
	/** Minimum turns between proactive compaction triggers. 0 = no cooldown. */
	cooldownTurns: number;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	thresholdPercent: 85,
	reserveTokens: 32768,
	keepRecentTokens: 16384,
	cooldownTurns: 2,
};

export interface UsageCheck {
	tokens: number | null;
	contextWindow: number;
	shouldCompact: boolean;
	/** The threshold (in tokens) that would trigger compaction. */
	thresholdTokens: number;
}

/**
 * Compute the effective compaction threshold as:
 *   min(contextWindow * thresholdPercent / 100, contextWindow - reserveTokens)
 *
 * This combines a percentage-based trigger (consistent across model window sizes)
 * with a reserve-token safety net (ensures room for the model's response).
 * Raw percentage is never clamped — only the trigger calculation uses it.
 */
export function computeThreshold(contextWindow: number, settings: CompactionSettings): number {
	const percentThreshold = Math.floor(contextWindow * settings.thresholdPercent / 100);
	const reserveThreshold = contextWindow - settings.reserveTokens;
	return Math.min(percentThreshold, reserveThreshold);
}

/**
 * Determine whether compaction should fire.
 * Triggers when contextTokens > computeThreshold(...).
 * Percentage is never clamped — values >100% are valid overload signals.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	const threshold = computeThreshold(contextWindow, settings);
	return contextTokens > threshold;
}

export function checkUsage(
	usage: ContextUsage | undefined,
	settings: CompactionSettings,
): UsageCheck {
	const contextWindow = usage?.contextWindow ?? 0;
	if (!usage || usage.tokens === null) {
		return { tokens: null, contextWindow, shouldCompact: false, thresholdTokens: contextWindow > 0 ? computeThreshold(contextWindow, settings) : 0 };
	}

	const result = shouldCompact(usage.tokens, contextWindow, settings);
	return {
		tokens: usage.tokens,
		contextWindow,
		shouldCompact: result,
		thresholdTokens: contextWindow > 0 ? computeThreshold(contextWindow, settings) : 0,
	};
}

// --- Settings parsing ---

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
	if (typeof val !== "number" || !Number.isFinite(val) || val < min || val > max) return fallback;
	return val;
}

/**
 * Parse settings from a raw settings.json object, reading the `autoCompactLite` block.
 * Invalid values silently fall back to defaults — no throws.
 */
export function resolveSettings(partial?: Partial<CompactionSettings>): CompactionSettings {
	return {
		enabled: partial?.enabled ?? DEFAULT_COMPACTION_SETTINGS.enabled,
		thresholdPercent: clampNumber(partial?.thresholdPercent, 1, 100, DEFAULT_COMPACTION_SETTINGS.thresholdPercent),
		reserveTokens: clampNumber(partial?.reserveTokens, 1024, 1_000_000, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
		keepRecentTokens: clampNumber(partial?.keepRecentTokens, 1024, 1_000_000, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens),
		cooldownTurns: clampNumber(partial?.cooldownTurns, 0, 100, DEFAULT_COMPACTION_SETTINGS.cooldownTurns),
	};
}

/**
 * Read the `autoCompactLite` block from a parsed settings.json object.
 * Returns undefined if the block is absent or not an object.
 */
export function readSettingsBlock(settings: Record<string, unknown> | undefined): Partial<CompactionSettings> | undefined {
	if (!settings) return undefined;
	const block = settings.autoCompactLite;
	if (!block || typeof block !== "object") return undefined;
	return block as Partial<CompactionSettings>;
}
