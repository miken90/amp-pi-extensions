// Inspired by darkamenosa/pi-setup's autocompact.ts (Apache-2.0);
// no source lines copied — reimplemented against Pi 0.83's public
// compaction API. See NOTICE in README.md.

import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	checkUsage,
	computeThreshold,
	resolveSettings,
	readSettingsBlock,
	type CompactionSettings,
	type ContextUsage,
} from "./usage.ts";

export interface AutoCompactDeps {
	getContextUsage?: (ctx: ExtensionContext) => ContextUsage | undefined;
	compact?: (ctx: ExtensionContext) => void;
	getCompactionSettings?: () => CompactionSettings;
}

function defaultSettingsFiles(): string[] {
	return [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(process.cwd(), ".pi", "settings.json"),
	];
}

/**
 * Read the `autoCompactLite` block from global then project settings (project wins).
 * Best-effort: invalid/missing values fall back to defaults.
 */
function readAutoCompactSettings(): CompactionSettings {
	const defaults = resolveSettings();
	let block: Partial<CompactionSettings> | undefined;
	for (const file of defaultSettingsFiles()) {
		if (!existsSync(file)) continue;
		try {
			const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			const parsed = readSettingsBlock(raw);
			if (parsed) block = { ...block, ...parsed };
		} catch {
			// Malformed settings.json — skip silently.
		}
	}
	return resolveSettings(block);
}

export default function autoCompactLite(pi: ExtensionAPI, deps?: AutoCompactDeps): void {
	const getContextUsage = deps?.getContextUsage ?? ((ctx) => ctx.getContextUsage());
	const doCompact = deps?.compact ?? ((ctx) => ctx.compact());
	const getSettings = deps?.getCompactionSettings ?? readAutoCompactSettings;

	// In-memory guards (no disk persistence):
	// - compactedThisTurn: prevent double-trigger within the same turn
	// - lastCompactionTurn: track turn index for cooldown enforcement
	// - observedReduction: true if we've seen tokens below threshold since last compaction
	let compactedThisTurn = false;
	let turnIndex = 0;
	let lastCompactionTurn: number | null = null;
	let observedReduction = false;

	pi.on("turn_start", async () => {
		compactedThisTurn = false;
		turnIndex++;
	});

	pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
		if (compactedThisTurn) return;

		const settings = getSettings();
		if (!settings.enabled) return;

		const usage = getContextUsage(ctx);
		const check = checkUsage(usage, settings);

		// Track whether we've observed tokens below the threshold
		// since the last compaction. This enables re-arming: if compaction
		// worked (tokens dropped below threshold), a subsequent rise above
		// threshold should trigger immediately, bypassing cooldown.
		if (check.tokens !== null && check.thresholdTokens > 0 && check.tokens <= check.thresholdTokens) {
			observedReduction = true;
		}

		if (!check.shouldCompact) return;

		// Cooldown: skip if we compacted recently and haven't observed
		// a token reduction below the threshold since.
		if (
			settings.cooldownTurns > 0 &&
			lastCompactionTurn !== null &&
			!observedReduction
		) {
			const turnsSinceCompaction = turnIndex - lastCompactionTurn;
			if (turnsSinceCompaction <= settings.cooldownTurns) return;
		}

		compactedThisTurn = true;
		lastCompactionTurn = turnIndex;
		observedReduction = false;

		try {
			doCompact(ctx);
			ctx.ui.setStatus(
				"autocompact-lite",
				`proactive compaction triggered (${check.tokens}/${check.contextWindow} tokens, threshold ${check.thresholdTokens})`,
			);
		} catch (err) {
			// Fail open: never crash the turn.
			compactedThisTurn = false;
			ctx.ui.notify(
				`autocompact-lite: proactive compaction failed: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("autocompact-lite", undefined);
	});
}
