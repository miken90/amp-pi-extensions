// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/session-breakdown.ts
// Changes: extracted from single-file extension into a multi-module directory
// (discovery.ts, breakdown.ts, render.ts, index.ts) following this repo's
// convention; import paths adjusted. Licensed under Apache-2.0 as a derived
// work — see NOTICE in README.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import os from "node:os";
import path from "node:path";
import {
	type BreakdownData,
	type BreakdownProgressState,
	computeBreakdown,
	rangeSummary,
	formatCount,
} from "./breakdown.ts";
import { BreakdownComponent } from "./render.ts";

const SESSION_ROOT = path.join(os.homedir(), ".pi", "agent", "sessions");

function setBorderedLoaderMessage(loader: BorderedLoader, message: string) {
	const inner = (loader as any)["loader"];
	if (inner && typeof inner.setMessage === "function") {
		inner.setMessage(message);
	}
}

export default function sessionBreakdownExtension(pi: ExtensionAPI): void {
	pi.registerCommand("session-breakdown", {
		description: "Interactive breakdown of last 7/30/90 days of ~/.pi session usage (sessions/messages/tokens + cost by model)",
		handler: async (_args, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				const data = await computeBreakdown(SESSION_ROOT);
				const range = data.ranges.get(30)!;
				pi.sendMessage(
					{
						customType: "session-breakdown",
						content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}`,
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			let aborted = false;
			const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
				const baseMessage = "Analyzing sessions (last 90 days)…";
				const loader = new BorderedLoader(tui, theme, baseMessage);

				const startedAt = Date.now();
				const progress: BreakdownProgressState = {
					phase: "scan",
					foundFiles: 0,
					parsedFiles: 0,
					totalFiles: 0,
					currentFile: undefined,
				};

				const renderMessage = (): string => {
					const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
					if (progress.phase === "scan") {
						return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
					}
					if (progress.phase === "parse") {
						return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
					}
					return `${baseMessage}  finalizing · ${elapsed}s`;
				};

				let intervalId: ReturnType<typeof setInterval> | null = null;
				const stopTicker = () => {
					if (intervalId) {
						clearInterval(intervalId);
						intervalId = null;
					}
				};

				setBorderedLoaderMessage(loader, renderMessage());
				intervalId = setInterval(() => {
					setBorderedLoaderMessage(loader, renderMessage());
				}, 500);

				loader.onAbort = () => {
					aborted = true;
					stopTicker();
					done(null);
				};

				computeBreakdown(SESSION_ROOT, loader.signal, (update) => Object.assign(progress, update))
					.then((d) => {
						stopTicker();
						if (!aborted) done(d);
					})
					.catch((err) => {
						stopTicker();
						console.error("session-breakdown: failed to analyze sessions", err);
						if (!aborted) done(null);
					});

				return loader;
			});

			if (!data) {
				ctx.ui.notify(aborted ? "Cancelled" : "Failed to analyze sessions", aborted ? "info" : "error");
				return;
			}

			await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
				return new BreakdownComponent(data, tui, done);
			});
		},
	});
}
