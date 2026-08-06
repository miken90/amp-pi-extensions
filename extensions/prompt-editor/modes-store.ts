// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/prompt-editor.ts
// Changes: extracted from single-file extension into a dedicated module;
// uses real getAgentDir() from the SDK instead of the reference's best-effort
// duplicate. Licensed under Apache-2.0 as a derived work — see NOTICE in
// README.md.

import path from "node:path";
import fs from "node:fs/promises";

export type ModeName = string;
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type ModeSpec = {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
	color?: string;
};

export type ModesFile = {
	version: 1;
	currentMode: ModeName;
	modes: Record<ModeName, ModeSpec>;
};

export const DEFAULT_MODE_ORDER = ["default"] as const;
export const CUSTOM_MODE_NAME = "custom" as const;

export function getGlobalModesPath(agentDir: string): string {
	return path.join(agentDir, "modes.json");
}

export function getProjectModesPath(cwd: string): string {
	return path.join(cwd, ".pi", "modes.json");
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

export async function resolveModesPath(cwd: string, agentDir: string): Promise<string> {
	const projectPath = getProjectModesPath(cwd);
	if (await fileExists(projectPath)) return projectPath;
	return getGlobalModesPath(agentDir);
}

async function ensureDirForFile(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function getMtimeMs(p: string): Promise<number | null> {
	try {
		const st = await fs.stat(p);
		return st.mtimeMs;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
	return `${filePath}.lock`;
}

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = getLockPathForFile(filePath);
	await ensureDirForFile(lockPath);

	const start = Date.now();
	while (true) {
		try {
			const handle = await fs.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
					"utf8",
				);
			} catch {
				// ignore
			}

			try {
				return await fn();
			} finally {
				await handle.close().catch(() => {});
				await fs.unlink(lockPath).catch(() => {});
			}
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;

			try {
				const st = await fs.stat(lockPath);
				if (Date.now() - st.mtimeMs > 30_000) {
					await fs.unlink(lockPath);
					continue;
				}
			} catch {
				// ignore
			}

			if (Date.now() - start > 5_000) {
				throw new Error(`Timed out waiting for lock: ${lockPath}`);
			}
			await sleep(40 + Math.random() * 80);
		}
	}
}

async function atomicWriteUtf8(filePath: string, content: string): Promise<void> {
	await ensureDirForFile(filePath);

	const dir = path.dirname(filePath);
	const base = path.basename(filePath);
	const tmpPath = path.join(dir, `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);

	await fs.writeFile(tmpPath, content, "utf8");

	try {
		await fs.rename(tmpPath, filePath);
	} catch (err: any) {
		if (err?.code === "EEXIST" || err?.code === "EPERM") {
			await fs.unlink(filePath).catch(() => {});
			await fs.rename(tmpPath, filePath);
		} else {
			await fs.unlink(tmpPath).catch(() => {});
			throw err;
		}
	}
}

export function cloneModesFile(file: ModesFile): ModesFile {
	return JSON.parse(JSON.stringify(file)) as ModesFile;
}

type ModeSpecPatch = {
	provider?: string | null;
	modelId?: string | null;
	thinkingLevel?: ThinkingLevel | null;
	color?: string | null;
};

type ModesPatch = {
	currentMode?: ModeName;
	modes?: Record<ModeName, ModeSpecPatch | null>;
};

export function computeModesPatch(base: ModesFile, next: ModesFile, includeCurrentMode: boolean): ModesPatch | null {
	const patch: ModesPatch = {};

	if (includeCurrentMode && base.currentMode !== next.currentMode) {
		patch.currentMode = next.currentMode;
	}

	const keys = new Set([...Object.keys(base.modes), ...Object.keys(next.modes)]);
	const modesPatch: Record<ModeName, ModeSpecPatch | null> = {};

	for (const k of keys) {
		const a = base.modes[k];
		const b = next.modes[k];

		if (!b) {
			if (a) modesPatch[k] = null;
			continue;
		}
		if (!a) {
			modesPatch[k] = { ...b };
			continue;
		}

		const diff: ModeSpecPatch = {};
		const fields: (keyof ModeSpec)[] = ["provider", "modelId", "thinkingLevel", "color"];
		for (const f of fields) {
			const av = a[f];
			const bv = b[f];
			if (av !== bv) {
				(diff as any)[f] = bv === undefined ? null : bv;
			}
		}
		if (Object.keys(diff).length > 0) {
			modesPatch[k] = diff;
		}
	}

	if (Object.keys(modesPatch).length > 0) {
		patch.modes = modesPatch;
	}

	if (!patch.modes && patch.currentMode === undefined) return null;
	return patch;
}

export function applyModesPatch(target: ModesFile, patch: ModesPatch): void {
	if (patch.currentMode !== undefined) {
		target.currentMode = patch.currentMode;
	}

	if (!patch.modes) return;
	for (const [mode, specPatch] of Object.entries(patch.modes)) {
		if (specPatch === null) {
			delete target.modes[mode];
			continue;
		}

		const targetSpec: Record<string, unknown> = (target.modes[mode] ??= {}) as Record<string, unknown>;
		for (const [k, v] of Object.entries(specPatch)) {
			if (v === null || v === undefined) {
				delete targetSpec[k];
			} else {
				targetSpec[k] = v;
			}
		}
	}
}

function normalizeThinkingLevel(level: unknown): ThinkingLevel | undefined {
	if (typeof level !== "string") return undefined;
	const v = level as ThinkingLevel;
	const allowed: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
	return allowed.includes(v) ? v : undefined;
}

export function sanitizeModeSpec(spec: unknown): ModeSpec {
	const obj = (spec && typeof spec === "object" ? spec : {}) as Record<string, unknown>;
	return {
		provider: typeof obj.provider === "string" ? obj.provider : undefined,
		modelId: typeof obj.modelId === "string" ? obj.modelId : undefined,
		thinkingLevel: normalizeThinkingLevel(obj.thinkingLevel),
		color: typeof obj.color === "string" ? obj.color : undefined,
	};
}

export function createDefaultModes(currentModel?: { provider?: string; id?: string }, currentThinking?: ThinkingLevel): ModesFile {
	const base: ModeSpec = {
		provider: currentModel?.provider,
		modelId: currentModel?.id,
		thinkingLevel: currentThinking,
	};

	return {
		version: 1,
		currentMode: "default",
		modes: {
			default: { ...base },
			fast: { ...base, thinkingLevel: "off" },
		},
	};
}

export function ensureDefaultModeEntries(file: ModesFile, currentModel?: { provider?: string; id?: string }, currentThinking?: ThinkingLevel): void {
	for (const name of DEFAULT_MODE_ORDER) {
		if (!file.modes[name]) {
			const defaults = createDefaultModes(currentModel, currentThinking);
			file.modes[name] = defaults.modes[name];
		}
	}

	if (file.currentMode === CUSTOM_MODE_NAME) {
		file.currentMode = "" as any;
	}

	if (!file.currentMode || !(file.currentMode in file.modes) || file.currentMode === CUSTOM_MODE_NAME) {
		const first = Object.keys(file.modes).find((k) => k !== CUSTOM_MODE_NAME);
		file.currentMode = file.modes.default ? "default" : first || "default";
	}
}

export async function loadModesFile(filePath: string, currentModel?: { provider?: string; id?: string }, currentThinking?: ThinkingLevel): Promise<ModesFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const currentMode = typeof parsed.currentMode === "string" ? parsed.currentMode : "default";
		const modesRaw = parsed.modes && typeof parsed.modes === "object" ? (parsed.modes as Record<string, unknown>) : {};
		const modes: Record<string, ModeSpec> = {};
		for (const [k, v] of Object.entries(modesRaw)) {
			modes[k] = sanitizeModeSpec(v);
		}
		const file: ModesFile = {
			version: 1,
			currentMode,
			modes,
		};
		ensureDefaultModeEntries(file, currentModel, currentThinking);
		return file;
	} catch {
		return createDefaultModes(currentModel, currentThinking);
	}
}

export async function saveModesFile(filePath: string, data: ModesFile): Promise<void> {
	await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

export function orderedModeNames(modes: Record<string, ModeSpec>): string[] {
	return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

export function isDefaultModeName(name: string): boolean {
	return (DEFAULT_MODE_ORDER as readonly string[]).includes(name);
}

export function isReservedModeName(name: string): boolean {
	return name === CUSTOM_MODE_NAME || name === "Configure modes…" || name === "Add mode…" || name === "Back";
}

export function validateModeNameOrError(
	name: string,
	existing: Record<string, ModeSpec>,
	opts?: { allowExisting?: boolean },
): string | null {
	if (!name) return "Mode name cannot be empty";
	if (/\s/.test(name)) return "Mode name cannot contain whitespace";
	if (isReservedModeName(name)) return `Mode name "${name}" is reserved`;
	if (!opts?.allowExisting && existing[name]) return `Mode "${name}" already exists`;
	return null;
}

export function renameModesRecord(modes: Record<string, ModeSpec>, oldName: string, newName: string): Record<string, ModeSpec> {
	const out: Record<string, ModeSpec> = {};
	for (const [k, v] of Object.entries(modes)) {
		if (k === oldName) out[newName] = v;
		else out[k] = v;
	}
	return out;
}

export { getMtimeMs };
