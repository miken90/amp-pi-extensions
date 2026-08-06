// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/session-breakdown.ts
// Changes: extracted from single-file extension into a dedicated module;
// import paths adjusted for this repo's directory convention. Licensed
// under Apache-2.0 as a derived work — see NOTICE in README.md.

import os from "node:os";
import {
	Key,
	matchesKey,
	type Component,
	type TUI,
	truncateToWidth,
	visibleWidth,
	sliceByColumn,
} from "@earendil-works/pi-tui";
import {
	DOW_NAMES,
	TOD_BUCKETS,
	todBucketLabel,
	toLocalDayKey,
	addDaysLocal,
	countDaysInclusiveLocal,
	mondayIndex,
	type ModelKey,
	type CwdKey,
	type DowKey,
	type TodKey,
} from "./discovery.ts";
import {
	type RangeAgg,
	type RGB,
	type BreakdownData,
	type BreakdownView,
	type MeasurementMode,
	type DayAgg,
	RANGE_DAYS,
	DEFAULT_BG,
	EMPTY_CELL_BG,
	clamp01,
	mixRgb,
	ansiFg,
	dim,
	bold,
	formatCount,
	formatUsd,
	padRight,
	padLeft,
	dayMixedColor,
	graphMetricForRange,
	rangeSummary,
} from "./breakdown.ts";

function abbreviatePath(p: string, maxWidth = 40): string {
	const home = os.homedir();
	let display = p;
	if (display.startsWith(home)) {
		display = "~" + display.slice(home.length);
	}
	if (display.length <= maxWidth) return display;

	const parts = display.split("/").filter(Boolean);
	if (parts.length <= 2) return display;

	const prefix = parts[0];
	for (let keep = parts.length - 1; keep >= 1; keep--) {
		const tail = parts.slice(parts.length - keep);
		const candidate = prefix + "/…/" + tail.join("/");
		if (candidate.length <= maxWidth || keep === 1) return candidate;
	}
	return display;
}

function displayModelName(modelKey: string): string {
	const idx = modelKey.indexOf("/");
	return idx === -1 ? modelKey : modelKey.slice(idx + 1);
}

function weeksForRange(range: RangeAgg): number {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;
	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	return Math.ceil(totalGridDays / 7);
}

function renderGraphLines(
	range: RangeAgg,
	colorMap: Map<string, RGB>,
	otherColor: RGB,
	mode: MeasurementMode,
	options?: { cellWidth?: number; gap?: number },
	view: BreakdownView = "model",
): string[] {
	const days = range.days;
	const start = days[0].date;
	const end = days[days.length - 1].date;

	const gridStart = addDaysLocal(start, -mondayIndex(start));
	const gridEnd = addDaysLocal(end, 6 - mondayIndex(end));
	const totalGridDays = countDaysInclusiveLocal(gridStart, gridEnd);
	const weeks = Math.ceil(totalGridDays / 7);

	const cellWidth = Math.max(1, Math.floor(options?.cellWidth ?? 1));
	const gap = Math.max(0, Math.floor(options?.gap ?? 1));
	const block = "█".repeat(cellWidth);
	const gapStr = " ".repeat(gap);

	const metric = graphMetricForRange(range, mode);
	const denom = metric.denom;

	const labelByRow = new Map<number, string>([
		[0, "Mon"],
		[2, "Wed"],
		[4, "Fri"],
	]);

	const lines: string[] = [];
	for (let row = 0; row < 7; row++) {
		const label = labelByRow.get(row);
		let line = label ? padRight(label, 3) + " " : "    ";

		for (let w = 0; w < weeks; w++) {
			const cellDate = addDaysLocal(gridStart, w * 7 + row);
			const inRange = cellDate >= start && cellDate <= end;
			const colGap = w < weeks - 1 ? gapStr : "";
			if (!inRange) {
				line += " ".repeat(cellWidth) + colGap;
				continue;
			}

			const key = toLocalDayKey(cellDate);
			const day = range.dayByKey.get(key);
			const value =
				metric.kind === "tokens"
					? (day?.tokens ?? 0)
					: metric.kind === "messages"
						? (day?.messages ?? 0)
						: (day?.sessions ?? 0);

			if (!day || value <= 0) {
				line += ansiFg(EMPTY_CELL_BG, block) + colGap;
				continue;
			}

			const hue = dayMixedColor(day, colorMap, otherColor, mode, view);
			let t = denom > 0 ? Math.log1p(value) / denom : 0;
			t = clamp01(t);
			const minVisible = 0.2;
			const intensity = minVisible + (1 - minVisible) * t;
			const rgb = mixRgb(DEFAULT_BG, hue, intensity);
			line += ansiFg(rgb, block) + colGap;
		}

		lines.push(line);
	}

	return lines;
}

function renderModelTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perModel: Map<ModelKey, number>;
	let total = 0;
	let label = kind;

	if (kind === "tokens") {
		perModel = range.modelTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perModel = range.modelMessages;
		total = range.totalMessages;
	} else {
		perModel = range.modelSessions;
		total = range.sessions;
	}

	const sorted = [...perModel.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
	const rows = sorted.slice(0, maxRows);

	const valueWidth = kind === "tokens" ? 10 : 8;
	const modelWidth = Math.min(52, Math.max("model".length, ...rows.map((r) => r.key.length)));

	const lines: string[] = [];
	lines.push(`${padRight("model", modelWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(modelWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);

	for (const r of rows) {
		const value = perModel.get(r.key) ?? 0;
		const cost = range.modelCost.get(r.key) ?? 0;
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(r.key.slice(0, modelWidth), modelWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
		);
	}

	if (sorted.length === 0) {
		lines.push(dim("(no model data found)"));
	}

	return lines;
}

function renderCwdTable(range: RangeAgg, mode: MeasurementMode, maxRows = 8): string[] {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perCwd: Map<CwdKey, number>;
	let total = 0;
	let label = kind;

	if (kind === "tokens") {
		perCwd = range.cwdTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perCwd = range.cwdMessages;
		total = range.totalMessages;
	} else {
		perCwd = range.cwdSessions;
		total = range.sessions;
	}

	const sorted = [...perCwd.entries()].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value);
	const rows = sorted.slice(0, maxRows);

	const valueWidth = kind === "tokens" ? 10 : 8;
	const displayPaths = rows.map((r) => abbreviatePath(r.key, 40));
	const cwdWidth = Math.min(42, Math.max("directory".length, ...displayPaths.map((p) => p.length)));

	const lines: string[] = [];
	lines.push(`${padRight("directory", cwdWidth)}  ${padLeft(label, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(cwdWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);

	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const value = perCwd.get(r.key) ?? 0;
		const cost = range.cwdCost.get(r.key) ?? 0;
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(displayPaths[i].slice(0, cwdWidth), cwdWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
		);
	}

	if (sorted.length === 0) {
		lines.push(dim("(no directory data found)"));
	}

	return lines;
}

function dowMetricForRange(
	range: RangeAgg,
	mode: MeasurementMode,
): { kind: "sessions" | "messages" | "tokens"; perDow: Map<DowKey, number>; total: number } {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	if (kind === "tokens") {
		return { kind, perDow: range.dowTokens, total: range.totalTokens };
	}
	if (kind === "messages") {
		return { kind, perDow: range.dowMessages, total: range.totalMessages };
	}
	return { kind, perDow: range.dowSessions, total: range.sessions };
}

function renderDowDistributionLines(
	range: RangeAgg,
	mode: MeasurementMode,
	dowColors: Map<DowKey, RGB>,
	width: number,
): string[] {
	const { kind, perDow, total } = dowMetricForRange(range, mode);
	const dayWidth = 3;
	const pctWidth = 4;
	const valueWidth = kind === "tokens" ? 10 : 8;
	const showValue = width >= dayWidth + 1 + 10 + 1 + pctWidth + 1 + valueWidth;
	const fixedWidth = dayWidth + 1 + 1 + pctWidth + (showValue ? 1 + valueWidth : 0);
	const barWidth = Math.max(1, width - fixedWidth);
	const fallbackColor: RGB = { r: 160, g: 160, b: 160 };

	const lines: string[] = [];
	for (const dow of DOW_NAMES) {
		const value = perDow.get(dow) ?? 0;
		const share = total > 0 ? value / total : 0;
		let filled = share > 0 ? Math.round(share * barWidth) : 0;
		if (share > 0) filled = Math.max(1, filled);
		filled = Math.min(barWidth, filled);
		const empty = Math.max(0, barWidth - filled);

		const color = dowColors.get(dow) ?? fallbackColor;
		const filledBar = filled > 0 ? ansiFg(color, "█".repeat(filled)) : "";
		const emptyBar = empty > 0 ? ansiFg(EMPTY_CELL_BG, "█".repeat(empty)) : "";
		const pct = padLeft(`${Math.round(share * 100)}%`, pctWidth);

		let line = `${padRight(dow, dayWidth)} ${filledBar}${emptyBar} ${pct}`;
		if (showValue) line += ` ${padLeft(formatCount(value), valueWidth)}`;
		lines.push(line);
	}

	return lines;
}

function renderDowTable(range: RangeAgg, mode: MeasurementMode): string[] {
	const { kind, perDow, total } = dowMetricForRange(range, mode);
	const valueWidth = kind === "tokens" ? 10 : 8;
	const dowWidth = 5;

	const lines: string[] = [];
	lines.push(`${padRight("day", dowWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(dowWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);

	for (const dow of DOW_NAMES) {
		const value = perDow.get(dow) ?? 0;
		const cost = range.dowCost.get(dow) ?? 0;
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(dow, dowWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
		);
	}

	return lines;
}

function renderTodTable(range: RangeAgg, mode: MeasurementMode): string[] {
	const metric = graphMetricForRange(range, mode);
	const kind = metric.kind;

	let perTod: Map<TodKey, number>;
	let total = 0;

	if (kind === "tokens") {
		perTod = range.todTokens;
		total = range.totalTokens;
	} else if (kind === "messages") {
		perTod = range.todMessages;
		total = range.totalMessages;
	} else {
		perTod = range.todSessions;
		total = range.sessions;
	}

	const valueWidth = kind === "tokens" ? 10 : 8;
	const todWidth = 22;

	const lines: string[] = [];
	lines.push(`${padRight("time of day", todWidth)}  ${padLeft(kind, valueWidth)}  ${padLeft("cost", 10)}  ${padLeft("share", 6)}`);
	lines.push(`${"-".repeat(todWidth)}  ${"-".repeat(valueWidth)}  ${"-".repeat(10)}  ${"-".repeat(6)}`);

	for (const b of TOD_BUCKETS) {
		const value = perTod.get(b.key) ?? 0;
		const cost = range.todCost.get(b.key) ?? 0;
		const share = total > 0 ? `${Math.round((value / total) * 100)}%` : "0%";
		lines.push(
			`${padRight(b.label, todWidth)}  ${padLeft(formatCount(value), valueWidth)}  ${padLeft(formatUsd(cost), 10)}  ${padLeft(share, 6)}`,
		);
	}

	return lines;
}

function fitRight(text: string, width: number): string {
	if (width <= 0) return "";
	let w = visibleWidth(text);
	let t = text;
	if (w > width) {
		t = sliceByColumn(t, w - width, width, true);
		w = visibleWidth(t);
	}
	return " ".repeat(Math.max(0, width - w)) + t;
}

export class BreakdownComponent implements Component {
	private data: BreakdownData;
	private tui: TUI;
	private onDone: () => void;
	private rangeIndex = 1;
	private measurement: MeasurementMode = "sessions";
	private view: BreakdownView = "model";
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
		this.data = data;
		this.tui = tui;
		this.onDone = onDone;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data.toLowerCase() === "q") {
			this.onDone();
			return;
		}

		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")) || data.toLowerCase() === "t") {
			const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
			const idx = Math.max(0, order.indexOf(this.measurement));
			const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
			this.measurement = order[(idx + order.length + dir) % order.length] ?? "sessions";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		const prev = () => {
			this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};
		const next = () => {
			this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
			this.invalidate();
			this.tui.requestRender();
		};

		if (matchesKey(data, Key.left) || data.toLowerCase() === "h") prev();
		if (matchesKey(data, Key.right) || data.toLowerCase() === "l") next();

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || data.toLowerCase() === "j" || data.toLowerCase() === "k") {
			const views: BreakdownView[] = ["model", "cwd", "dow", "tod"];
			const idx = views.indexOf(this.view);
			const dir = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
			this.view = views[(idx + views.length + dir) % views.length] ?? "model";
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (data === "1") {
			this.rangeIndex = 0;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "2") {
			this.rangeIndex = 1;
			this.invalidate();
			this.tui.requestRender();
		}
		if (data === "3") {
			this.rangeIndex = 2;
			this.invalidate();
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const selectedDays = RANGE_DAYS[this.rangeIndex];
		const range = this.data.ranges.get(selectedDays)!;
		const metric = graphMetricForRange(range, this.measurement);

		const tab = (days: number, idx: number): string => {
			const selected = idx === this.rangeIndex;
			const label = `${days}d`;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const metricTab = (mode: MeasurementMode, label: string): string => {
			const selected = mode === this.measurement;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const viewTab = (v: BreakdownView, label: string): string => {
			const selected = v === this.view;
			return selected ? bold(`[${label}]`) : dim(` ${label} `);
		};

		const header =
			`${bold("Session breakdown")}  ${tab(7, 0)}${tab(30, 1)}${tab(90, 2)}  ` +
			`${metricTab("sessions", "sess")}${metricTab("messages", "msg")}${metricTab("tokens", "tok")}  ` +
			`${viewTab("model", "model")}${viewTab("cwd", "cwd")}${viewTab("dow", "dow")}${viewTab("tod", "tod")}`;

		let activeColorMap: Map<string, RGB>;
		let activeOtherColor: RGB = { r: 160, g: 160, b: 160 };
		const legendItems: string[] = [];

		if (this.view === "model") {
			activeColorMap = this.data.palette.modelColors;
			activeOtherColor = this.data.palette.otherColor;
			for (const mk of this.data.palette.orderedModels) {
				const c = activeColorMap.get(mk);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${displayModelName(mk)}`);
			}
			legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
		} else if (this.view === "cwd") {
			activeColorMap = this.data.cwdPalette.cwdColors;
			activeOtherColor = this.data.cwdPalette.otherColor;
			for (const cwd of this.data.cwdPalette.orderedCwds) {
				const c = activeColorMap.get(cwd);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${abbreviatePath(cwd, 30)}`);
			}
			legendItems.push(`${ansiFg(activeOtherColor, "█")} other`);
		} else if (this.view === "dow") {
			activeColorMap = this.data.dowPalette.dowColors;
			for (const dow of this.data.dowPalette.orderedDows) {
				const c = activeColorMap.get(dow);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${dow}`);
			}
		} else {
			activeColorMap = this.data.todPalette.todColors;
			for (const tod of this.data.todPalette.orderedTods) {
				const c = activeColorMap.get(tod);
				if (c) legendItems.push(`${ansiFg(c, "█")} ${todBucketLabel(tod)}`);
			}
		}

		const graphDescriptor = this.view === "dow" ? `share of ${metric.kind} by weekday` : `${metric.kind}/day`;
		const summary = rangeSummary(range, selectedDays, metric.kind) + dim(`   (graph: ${graphDescriptor})`);

		let graphLines: string[];
		if (this.view === "dow") {
			graphLines = renderDowDistributionLines(range, this.measurement, this.data.dowPalette.dowColors, width);
		} else {
			const maxScale = selectedDays === 7 ? 4 : selectedDays === 30 ? 3 : 2;
			const weeks = weeksForRange(range);
			const leftMargin = 4;
			const gap = 1;
			const graphArea = Math.max(1, width - leftMargin);
			const idealCellWidth = Math.floor((graphArea + gap) / Math.max(1, weeks)) - gap;
			const cellWidth = Math.min(maxScale, Math.max(1, idealCellWidth));

			graphLines = renderGraphLines(
				range,
				activeColorMap,
				activeOtherColor,
				this.measurement,
				{ cellWidth, gap },
				this.view,
			);
		}
		const tableLines =
			this.view === "model" ? renderModelTable(range, metric.kind, 8)
			: this.view === "cwd" ? renderCwdTable(range, metric.kind, 8)
			: this.view === "dow" ? renderDowTable(range, metric.kind)
			: renderTodTable(range, metric.kind);

		const lines: string[] = [];
		lines.push(truncateToWidth(header, width));
		lines.push(truncateToWidth(dim("←/→ range · ↑/↓ view · tab metric · q to close"), width));
		lines.push("");
		lines.push(truncateToWidth(summary, width));
		lines.push("");

		if (this.view === "dow") {
			for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
		} else {
			const graphWidth = Math.max(0, ...graphLines.map((l) => visibleWidth(l)));
			const sep = 2;
			const legendWidth = width - graphWidth - sep;
			const showSideLegend = legendWidth >= 22;

			if (showSideLegend) {
				const legendBlock: string[] = [];
				const legendTitle =
					this.view === "model" ? "Top models (30d palette):"
					: this.view === "cwd" ? "Top directories (30d palette):"
					: "Time of day:";
				legendBlock.push(dim(legendTitle));
				legendBlock.push(...legendItems);
				const maxLegendRows = graphLines.length;
				let legendLines = legendBlock.slice(0, maxLegendRows);
				if (legendBlock.length > maxLegendRows) {
					const remaining = legendBlock.length - (maxLegendRows - 1);
					legendLines = [...legendBlock.slice(0, maxLegendRows - 1), dim(`+${remaining} more`)];
				}
				while (legendLines.length < graphLines.length) legendLines.push("");

				const padRightAnsi = (s: string, target: number): string => {
					const w = visibleWidth(s);
					return w >= target ? s : s + " ".repeat(target - w);
				};

				for (let i = 0; i < graphLines.length; i++) {
					const left = padRightAnsi(graphLines[i] ?? "", graphWidth);
					const right = truncateToWidth(legendLines[i] ?? "", Math.max(0, legendWidth));
					lines.push(truncateToWidth(left + " ".repeat(sep) + right, width));
				}
			} else {
				for (const gl of graphLines) lines.push(truncateToWidth(gl, width));
				lines.push("");
				const legendTitleBelow =
					this.view === "model" ? "Top models (30d palette):"
					: this.view === "cwd" ? "Top directories (30d palette):"
					: "Time of day:";
				lines.push(truncateToWidth(dim(legendTitleBelow), width));
				for (const it of legendItems) lines.push(truncateToWidth(it, width));
			}
		}

		lines.push("");
		for (const tl of tableLines) lines.push(truncateToWidth(tl, width));

		this.cachedWidth = width;
		this.cachedLines = lines.map((l) => (visibleWidth(l) > width ? truncateToWidth(l, width) : l));
		return this.cachedLines;
	}
}
