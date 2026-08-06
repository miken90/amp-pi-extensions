// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/prompt-editor.ts
// Changes: extracted from single-file extension into a multi-module directory
// (modes-store.ts, modes.ts, index.ts) following this repo's convention;
// uses real getAgentDir() from the SDK instead of the reference's best-effort
// duplicate. Licensed under Apache-2.0 as a derived work — see NOTICE in
// README.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CustomEditor, ModelSelectorComponent, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
	type ModesFile,
	type ModeSpec,
	type ModeName,
	type ThinkingLevel,
	DEFAULT_MODE_ORDER,
	CUSTOM_MODE_NAME,
	getGlobalModesPath,
	resolveModesPath,
	withFileLock,
	cloneModesFile,
	computeModesPatch,
	applyModesPatch,
	ensureDefaultModeEntries,
	loadModesFile,
	saveModesFile,
	orderedModeNames,
	isDefaultModeName,
	isReservedModeName,
	validateModeNameOrError,
	renameModesRecord,
	getMtimeMs,
} from "./modes-store.ts";
import { inferModeFromSelection, cycleModeName } from "./modes.ts";

type ModeRuntime = {
	filePath: string;
	fileMtimeMs: number | null;
	baseline: ModesFile | null;
	data: ModesFile;
	lastRealMode: string;
	currentMode: string;
	applying: boolean;
};

const runtime: ModeRuntime = {
	filePath: "",
	fileMtimeMs: null,
	baseline: null,
	data: { version: 1, currentMode: "default", modes: {} },
	lastRealMode: "default",
	currentMode: "default",
	applying: false,
};

let customOverlay: ModeSpec | null = null;
let requestEditorRender: (() => void) | undefined;
let lastObservedModel: { provider?: string; modelId?: string } = {};

const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
const THINKING_UNSET_LABEL = "(don't change)";
const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";

function getCurrentSelectionSpec(pi: ExtensionAPI): ModeSpec {
	return {
		provider: lastObservedModel.provider,
		modelId: lastObservedModel.modelId,
		thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
	};
}

async function ensureRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const agentDir = getAgentDir();
	const filePath = await resolveModesPath(ctx.cwd, agentDir);

	const mtimeMs = await getMtimeMs(filePath);
	const filePathChanged = runtime.filePath !== filePath;
	const fileChanged = filePathChanged || runtime.fileMtimeMs !== mtimeMs;

	if (fileChanged) {
		runtime.filePath = filePath;
		runtime.fileMtimeMs = mtimeMs;

		const loaded = await loadModesFile(filePath, ctx.model, pi.getThinkingLevel() as ThinkingLevel);
		ensureDefaultModeEntries(loaded, ctx.model, pi.getThinkingLevel() as ThinkingLevel);
		runtime.data = loaded;
		runtime.baseline = cloneModesFile(runtime.data);

		if (filePathChanged && runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.currentMode = runtime.data.currentMode;
			runtime.lastRealMode = runtime.currentMode;
		}
	}

	if (runtime.currentMode !== CUSTOM_MODE_NAME) {
		if (!runtime.currentMode || !(runtime.currentMode in runtime.data.modes)) {
			runtime.currentMode = runtime.data.currentMode;
		}
		if (!runtime.lastRealMode || !(runtime.lastRealMode in runtime.data.modes)) {
			runtime.lastRealMode = runtime.currentMode;
		}
	}
}

async function persistRuntime(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!runtime.filePath) return;

	runtime.baseline ??= cloneModesFile(runtime.data);
	const patch = computeModesPatch(runtime.baseline, runtime.data, false);
	if (!patch) return;

	await withFileLock(runtime.filePath, async () => {
		const latest = await loadModesFile(runtime.filePath, ctx.model, pi.getThinkingLevel() as ThinkingLevel);
		applyModesPatch(latest, patch);
		ensureDefaultModeEntries(latest, ctx.model, pi.getThinkingLevel() as ThinkingLevel);
		await saveModesFile(runtime.filePath, latest);

		runtime.data = latest;
		runtime.baseline = cloneModesFile(latest);
		runtime.fileMtimeMs = await getMtimeMs(runtime.filePath);
	});
}

async function storeSelectionIntoMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string, selection: ModeSpec): Promise<void> {
	if (mode === CUSTOM_MODE_NAME) return;

	await ensureRuntime(pi, ctx);

	const existingTarget = runtime.data.modes[mode] ?? {};
	const next: ModeSpec = { ...existingTarget };

	if (selection.provider && selection.modelId) {
		next.provider = selection.provider;
		next.modelId = selection.modelId;
	}
	if (selection.thinkingLevel) next.thinkingLevel = selection.thinkingLevel;

	runtime.data.modes[mode] = next;
	await persistRuntime(pi, ctx);
}

async function applyMode(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	await ensureRuntime(pi, ctx);

	if (mode === CUSTOM_MODE_NAME) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi);
		if (ctx.hasUI) requestEditorRender?.();
		return;
	}

	const spec = runtime.data.modes[mode];
	if (!spec) {
		if (ctx.hasUI) {
			ctx.ui.notify(`Unknown mode: ${mode}`, "warning");
		}
		return;
	}

	runtime.currentMode = mode;
	runtime.lastRealMode = mode;
	customOverlay = null;

	runtime.applying = true;
	let modelAppliedOk = true;
	try {
		if (spec.provider && spec.modelId) {
			const m = ctx.modelRegistry.find(spec.provider, spec.modelId);
			if (m) {
				const ok = await pi.setModel(m);
				modelAppliedOk = ok;
				if (!ok && ctx.hasUI) {
					ctx.ui.notify(`No API key available for ${spec.provider}/${spec.modelId}`, "warning");
				}
			} else {
				modelAppliedOk = false;
				if (ctx.hasUI) {
					ctx.ui.notify(`Mode "${mode}" references unknown model ${spec.provider}/${spec.modelId}`, "warning");
				}
			}
		}

		if (spec.thinkingLevel) {
			pi.setThinkingLevel(spec.thinkingLevel);
		}
	} finally {
		runtime.applying = false;
	}

	if (!modelAppliedOk) {
		runtime.currentMode = CUSTOM_MODE_NAME;
		customOverlay = getCurrentSelectionSpec(pi);
	}

	if (ctx.hasUI) {
		requestEditorRender?.();
	}
}

function getModeBorderColor(theme: any, pi: ExtensionAPI, mode: string): (text: string) => string {
	const spec = runtime.data.modes[mode];

	if (spec?.color) {
		try {
			theme.getFgAnsi(spec.color as any);
			return (text: string) => theme.fg(spec.color as any, text);
		} catch {
			// fall through
		}
	}

	try {
		return theme.getThinkingBorderColor(pi.getThinkingLevel());
	} catch {
		return theme.getThinkingBorderColor("off");
	}
}

// --- Prompt history ---

interface PromptEntry {
	text: string;
	timestamp: number;
}

const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;

class PromptEditor extends CustomEditor {
	public modeLabelProvider?: () => string;
	public modeLabelColor?: (text: string) => string;
	private lockedBorder = false;
	private _borderColor?: (text: string) => string;

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		theme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, theme, keybindings);
		delete (this as { borderColor?: (text: string) => string }).borderColor;
		Object.defineProperty(this, "borderColor", {
			get: () => this._borderColor ?? ((text: string) => text),
			set: (value: (text: string) => string) => {
				if (this.lockedBorder) return;
				this._borderColor = value;
			},
			configurable: true,
			enumerable: true,
		});
	}

	lockBorderColor() {
		this.lockedBorder = true;
	}

	render(width: number): string[] {
		const lines = super.render(width);
		const mode = this.modeLabelProvider?.();
		if (!mode) return lines;

		const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
		const topPlain = stripAnsi(lines[0] ?? "");

		const scrollPrefixMatch = topPlain.match(/^(─── ↑ \d+ more )/);
		const prefix = scrollPrefixMatch?.[1] ?? "──";

		const labelColor = this.modeLabelColor ?? ((text: string) => this.borderColor(text));
		const isBashMode = this.getText().trimStart().startsWith("!");
		const labelParts: Array<{ text: string; color: (text: string) => string }> = [
			{ text: mode, color: labelColor },
		];
		if (isBashMode) {
			labelParts.push(
				{ text: " ", color: labelColor },
				{ text: "──", color: (text: string) => this.borderColor(text) },
				{ text: " bash", color: labelColor },
			);
		}

		const labelLeftSpace = prefix.endsWith(" ") ? "" : " ";
		const labelRightSpace = " ";
		const minRightBorder = 1;
		const maxLabelLen = Math.max(0, width - prefix.length - labelLeftSpace.length - labelRightSpace.length - minRightBorder);
		if (maxLabelLen <= 0) return lines;

		let labelLen = labelParts.reduce((sum, part) => sum + part.text.length, 0);
		if (labelLen > maxLabelLen) {
			let remainingLen = maxLabelLen;
			for (const part of labelParts) {
				if (remainingLen <= 0) {
					part.text = "";
					continue;
				}
				if (part.text.length > remainingLen) {
					part.text = part.text.slice(0, remainingLen);
					remainingLen = 0;
				} else {
					remainingLen -= part.text.length;
				}
			}
			labelLen = maxLabelLen;
		}

		const labelChunkLen = labelLeftSpace.length + labelLen + labelRightSpace.length;
		const remaining = width - prefix.length - labelChunkLen;
		if (remaining < 0) return lines;

		const right = "─".repeat(Math.max(0, remaining));
		const coloredLabel = labelParts.map((part) => (part.text ? part.color(part.text) : "")).join("");
		lines[0] =
			this.borderColor(prefix) +
			(labelLeftSpace ? labelColor(labelLeftSpace) : "") +
			coloredLabel +
			(labelRightSpace ? labelColor(labelRightSpace) : "") +
			this.borderColor(right);
		return lines;
	}

	public requestRenderNow(): void {
		this.tui.requestRender();
	}
}

function extractText(content: Array<{ type: string; text?: string }>): string {
	return content
		.filter((item) => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text ?? "")
		.join("")
		.trim();
}

function collectUserPromptsFromEntries(entries: Array<any>): PromptEntry[] {
	const prompts: PromptEntry[] = [];

	for (const entry of entries) {
		if (entry?.type !== "message") continue;
		const message = entry?.message;
		if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
		const text = extractText(message.content);
		if (!text) continue;
		const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
		prompts.push({ text, timestamp });
	}

	return prompts;
}

function getSessionDirForCwd(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return path.join(getAgentDir(), "sessions", safePath);
}

async function readTail(filePath: string, maxBytes = 256 * 1024): Promise<string> {
	let fileHandle: import("node:fs/promises").FileHandle | undefined;
	try {
		const stats = await import("node:fs/promises").then((m) => m.stat(filePath));
		const size = stats.size;
		const start = Math.max(0, size - maxBytes);
		const length = size - start;
		if (length <= 0) return "";

		const buffer = Buffer.alloc(length);
		fileHandle = await import("node:fs/promises").then((m) => m.open(filePath, "r"));
		const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
		if (bytesRead === 0) return "";
		let chunk = buffer.subarray(0, bytesRead).toString("utf8");
		if (start > 0) {
			const firstNewline = chunk.indexOf("\n");
			if (firstNewline !== -1) {
				chunk = chunk.slice(firstNewline + 1);
			}
		}
		return chunk;
	} catch {
		return "";
	} finally {
		await fileHandle?.close();
	}
}

async function loadPromptHistoryForCwd(cwd: string, excludeSessionFile?: string): Promise<PromptEntry[]> {
	const fs = await import("node:fs/promises");
	const sessionDir = getSessionDirForCwd(path.resolve(cwd));
	const resolvedExclude = excludeSessionFile ? path.resolve(excludeSessionFile) : undefined;
	const prompts: PromptEntry[] = [];

	let entries: import("node:fs").Dirent[] = [];
	try {
		entries = await fs.readdir(sessionDir, { withFileTypes: true });
	} catch {
		return prompts;
	}

	const files = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry) => {
				const filePath = path.join(sessionDir, entry.name);
				try {
					const stats = await fs.stat(filePath);
					return { filePath, mtimeMs: stats.mtimeMs };
				} catch {
					return undefined;
				}
			}),
	);

	const sortedFiles = files
		.filter((file): file is { filePath: string; mtimeMs: number } => Boolean(file))
		.sort((a, b) => b.mtimeMs - a.mtimeMs);

	for (const file of sortedFiles) {
		if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude) continue;

		const tail = await readTail(file.filePath);
		if (!tail) continue;
		const lines = tail.split("\n").filter(Boolean);
		for (const line of lines) {
			let entry: any;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry?.message;
			if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
			const text = extractText(message.content);
			if (!text) continue;
			const timestamp = Number(message.timestamp ?? entry.timestamp ?? Date.now());
			prompts.push({ text, timestamp });
			if (prompts.length >= MAX_RECENT_PROMPTS) break;
		}
		if (prompts.length >= MAX_RECENT_PROMPTS) break;
	}

	return prompts;
}

function buildHistoryList(currentSession: PromptEntry[], previousSessions: PromptEntry[]): PromptEntry[] {
	const all = [...currentSession, ...previousSessions];
	all.sort((a, b) => a.timestamp - b.timestamp);

	const seen = new Set<string>();
	const deduped: PromptEntry[] = [];
	for (const prompt of all) {
		const key = `${prompt.timestamp}:${prompt.text}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(prompt);
	}

	return deduped.slice(-MAX_HISTORY_ENTRIES);
}

let loadCounter = 0;

function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i += 1) {
		if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp) return false;
	}
	return true;
}

function setEditor(pi: ExtensionAPI, ctx: ExtensionContext, history: PromptEntry[]) {
	const uiTheme = ctx.ui.theme;
	ctx.ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = new PromptEditor(tui, theme, keybindings);
		requestEditorRender = () => editor.requestRenderNow();
		editor.modeLabelProvider = () => runtime.currentMode;
		editor.modeLabelColor = (text: string) => uiTheme.fg("dim", text);
		const borderColor = (text: string) => {
			const isBashMode = editor.getText().trimStart().startsWith("!");
			if (isBashMode) {
				return uiTheme.getBashModeBorderColor()(text);
			}
			return getModeBorderColor(uiTheme, pi, runtime.currentMode)(text);
		};

		editor.borderColor = borderColor;
		editor.lockBorderColor();
		for (const prompt of history) {
			editor.addToHistory?.(prompt.text);
		}
		return editor;
	});
}

function applyEditor(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;

	const sessionFile = ctx.sessionManager.getSessionFile();
	const currentEntries = ctx.sessionManager.getBranch();
	const currentPrompts = collectUserPromptsFromEntries(currentEntries);
	const immediateHistory = buildHistoryList(currentPrompts, []);

	const currentLoad = ++loadCounter;
	const initialText = ctx.ui.getEditorText();
	setEditor(pi, ctx, immediateHistory);

	void (async () => {
		const previousPrompts = await loadPromptHistoryForCwd(ctx.cwd, sessionFile ?? undefined);
		if (currentLoad !== loadCounter) return;
		if (ctx.ui.getEditorText() !== initialText) return;
		const history = buildHistoryList(currentPrompts, previousPrompts);
		if (historiesMatch(history, immediateHistory)) return;
		setEditor(pi, ctx, history);
	})();
}

// --- UI handlers ---

async function handleModeChoiceUI(pi: ExtensionAPI, ctx: ExtensionContext, choice: string): Promise<void> {
	if (runtime.currentMode === CUSTOM_MODE_NAME && choice !== CUSTOM_MODE_NAME) {
		const action = await ctx.ui.select(`Mode "${choice}"`, ["use", "store"]);
		if (!action) return;

		if (action === "use") {
			await applyMode(pi, ctx, choice);
			return;
		}

		await ensureRuntime(pi, ctx);
		const overlay = customOverlay ?? getCurrentSelectionSpec(pi);
		await storeSelectionIntoMode(pi, ctx, choice, overlay);
		await applyMode(pi, ctx, choice);
		ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into "${choice}"`, "info");
		return;
	}

	await applyMode(pi, ctx, choice);
}

async function selectModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select(`Mode (current: ${runtime.currentMode})`, [...names, MODE_UI_CONFIGURE]);
		if (!choice) return;

		if (choice === MODE_UI_CONFIGURE) {
			await configureModesUI(pi, ctx);
			continue;
		}

		await handleModeChoiceUI(pi, ctx, choice);
		return;
	}
}

async function configureModesUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	while (true) {
		await ensureRuntime(pi, ctx);
		const names = orderedModeNames(runtime.data.modes);
		const choice = await ctx.ui.select("Configure modes", [...names, MODE_UI_ADD, MODE_UI_BACK]);
		if (!choice || choice === MODE_UI_BACK) return;

		if (choice === MODE_UI_ADD) {
			const created = await addModeUI(pi, ctx);
			if (created) {
				await editModeUI(pi, ctx, created);
			}
			continue;
		}

		await editModeUI(pi, ctx, choice);
	}
}

async function addModeUI(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;
	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input("New mode name", "e.g. docs, review, planning");
		if (raw === undefined) return undefined;

		const name = (raw ?? "").trim();
		const err = validateModeNameOrError(name, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		const selection = customOverlay ?? getCurrentSelectionSpec(pi);
		runtime.data.modes[name] = {
			provider: selection.provider,
			modelId: selection.modelId,
			thinkingLevel: selection.thinkingLevel,
		};
		await persistRuntime(pi, ctx);
		ctx.ui.notify(`Added mode "${name}"`, "info");
		return name;
	}
}

async function editModeUI(pi: ExtensionAPI, ctx: ExtensionContext, mode: string): Promise<void> {
	if (!ctx.hasUI) return;

	let modeName = mode;

	while (true) {
		await ensureRuntime(pi, ctx);
		const spec = runtime.data.modes[modeName];
		if (!spec) return;

		const modelLabel = spec.provider && spec.modelId ? `${spec.provider}/${spec.modelId}` : "(no model)";
		const thinkingLabel = spec.thinkingLevel ?? THINKING_UNSET_LABEL;

		const actions = ["Change name", "Change model", "Change thinking level"];
		if (!isDefaultModeName(modeName)) actions.push("Delete mode");
		actions.push(MODE_UI_BACK);

		const action = await ctx.ui.select(
			`Edit mode "${modeName}"  model: ${modelLabel}  thinking: ${thinkingLabel}`,
			actions,
		);
		if (!action || action === MODE_UI_BACK) return;

		if (action === "Change name") {
			const renamed = await renameModeUI(pi, ctx, modeName);
			if (renamed) modeName = renamed;
			continue;
		}

		if (action === "Change model") {
			const selected = await pickModelForModeUI(ctx, spec);
			if (!selected) continue;
			spec.provider = selected.provider;
			spec.modelId = selected.modelId;
			runtime.data.modes[modeName] = spec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated model for "${modeName}"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Change thinking level") {
			const level = await pickThinkingLevelForModeUI(ctx, spec.thinkingLevel);
			if (level === undefined) continue;

			if (level === null) {
				delete spec.thinkingLevel;
			} else {
				spec.thinkingLevel = level;
			}

			runtime.data.modes[modeName] = spec;
			await persistRuntime(pi, ctx);
			ctx.ui.notify(`Updated thinking level for "${modeName}"`, "info");

			if (runtime.currentMode === modeName) {
				await applyMode(pi, ctx, modeName);
			}
			continue;
		}

		if (action === "Delete mode") {
			const ok = await ctx.ui.confirm("Delete mode", `Delete mode "${modeName}"?`);
			if (!ok) continue;

			delete runtime.data.modes[modeName];
			await persistRuntime(pi, ctx);

			if (runtime.currentMode === modeName) {
				runtime.currentMode = CUSTOM_MODE_NAME;
				customOverlay = getCurrentSelectionSpec(pi);
			}
			if (runtime.lastRealMode === modeName) {
				runtime.lastRealMode = "default";
			}
			requestEditorRender?.();
			ctx.ui.notify(`Deleted mode "${modeName}"`, "info");
			return;
		}
	}
}

async function renameModeUI(pi: ExtensionAPI, ctx: ExtensionContext, oldName: string): Promise<string | undefined> {
	if (!ctx.hasUI) return undefined;

	if (isDefaultModeName(oldName)) {
		ctx.ui.notify(`Cannot rename default mode "${oldName}"`, "warning");
		return oldName;
	}

	await ensureRuntime(pi, ctx);

	while (true) {
		const raw = await ctx.ui.input(`Rename mode "${oldName}"`, oldName);
		if (raw === undefined) return undefined;

		const newName = (raw ?? "").trim();
		if (!newName || newName === oldName) return oldName;

		const err = validateModeNameOrError(newName, runtime.data.modes);
		if (err) {
			ctx.ui.notify(err, "warning");
			continue;
		}

		runtime.data.modes = renameModesRecord(runtime.data.modes, oldName, newName);
		await persistRuntime(pi, ctx);

		if (runtime.currentMode === oldName) runtime.currentMode = newName;
		if (runtime.lastRealMode === oldName) runtime.lastRealMode = newName;
		requestEditorRender?.();

		ctx.ui.notify(`Renamed "${oldName}" → "${newName}"`, "info");
		return newName;
	}
}

async function pickModelForModeUI(
	ctx: ExtensionContext,
	spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
	if (!ctx.hasUI) return undefined;

	const settingsManager = SettingsManager.inMemory();
	const currentModel = spec.provider && spec.modelId ? ctx.modelRegistry.find(spec.provider, spec.modelId) : ctx.model;

	const scopedModels: Array<{ model: any; thinkingLevel: string }> = [];

	return ctx.ui.custom<{ provider: string; modelId: string } | undefined>((tui, _theme, _keybindings, done) => {
		const selector = new ModelSelectorComponent(
			tui,
			currentModel,
			settingsManager,
			ctx.modelRegistry as any,
			scopedModels as any,
			(model) => done({ provider: model.provider, modelId: model.id }),
			() => done(undefined),
		);
		return selector;
	});
}

async function pickThinkingLevelForModeUI(
	ctx: ExtensionContext,
	current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | null | undefined> {
	if (!ctx.hasUI) return undefined;

	const defaultValue = current ?? "off";
	const options = [...ALL_THINKING_LEVELS, THINKING_UNSET_LABEL];
	const ordered = [defaultValue, ...options.filter((x) => x !== defaultValue)];

	const choice = await ctx.ui.select("Thinking level", ordered);
	if (!choice) return undefined;
	if (choice === THINKING_UNSET_LABEL) return null;
	if (ALL_THINKING_LEVELS.includes(choice as ThinkingLevel)) return choice as ThinkingLevel;
	return undefined;
}

async function cycleMode(pi: ExtensionAPI, ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
	if (!ctx.hasUI) return;
	await ensureRuntime(pi, ctx);
	const next = cycleModeName(runtime.data, runtime.currentMode, runtime.lastRealMode, direction);
	if (next) await applyMode(pi, ctx, next);
}

export default function promptEditorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("mode", {
		description: "Select prompt mode",
		handler: async (args, ctx) => {
			const tokens = args.split(/\s+/).map((x) => x.trim()).filter(Boolean);

			if (tokens.length === 0) {
				await selectModeUI(pi, ctx);
				return;
			}

			if (tokens[0] === "store") {
				await ensureRuntime(pi, ctx);

				let target = tokens[1];
				if (!target) {
					if (!ctx.hasUI) return;
					const names = orderedModeNames(runtime.data.modes);
					target = await ctx.ui.select("Store current selection into mode", names);
					if (!target) return;
				}

				if (target === CUSTOM_MODE_NAME) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot store into "${CUSTOM_MODE_NAME}"`, "warning");
					return;
				}

				const selection = customOverlay ?? getCurrentSelectionSpec(pi);
				await storeSelectionIntoMode(pi, ctx, target, selection);
				if (ctx.hasUI) ctx.ui.notify(`Stored current selection into "${target}"`, "info");
				return;
			}

			await applyMode(pi, ctx, tokens[0]!);
		},
	});

	pi.registerShortcut("ctrl+shift+m", {
		description: "Select prompt mode",
		handler: async (ctx) => {
			await selectModeUI(pi, ctx);
		},
	});

	pi.registerShortcut("ctrl+space", {
		description: "Cycle prompt mode",
		handler: async (ctx) => {
			await cycleMode(pi, ctx, 1);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		lastObservedModel = { provider: ctx.model?.provider, modelId: ctx.model?.id };
		await ensureRuntime(pi, ctx);
		customOverlay = null;

		const inferred = inferModeFromSelection(
			runtime.data,
			ctx.model?.provider,
			ctx.model?.id,
			pi.getThinkingLevel() as ThinkingLevel,
			Boolean(ctx.model?.reasoning),
		);
		if (inferred) {
			runtime.currentMode = inferred;
			runtime.lastRealMode = inferred;
		} else {
			runtime.currentMode = CUSTOM_MODE_NAME;
			customOverlay = getCurrentSelectionSpec(pi);
		}

		applyEditor(pi, ctx);
	});

	pi.on("model_select", async (event, ctx) => {
		lastObservedModel = { provider: event.model.provider, modelId: event.model.id };

		if (runtime.applying) return;

		await ensureRuntime(pi, ctx);
		if (runtime.currentMode !== CUSTOM_MODE_NAME) {
			runtime.lastRealMode = runtime.currentMode;
		}
		runtime.currentMode = CUSTOM_MODE_NAME;

		customOverlay = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel() as ThinkingLevel,
		};

		if (ctx.hasUI) {
			requestEditorRender?.();
		}
	});
}
