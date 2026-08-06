// Unit tests for prompt-editor: ModesFile CRUD, schema round-trip,
// project-over-global precedence, and pinned-model non-interference.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	type ModesFile,
	type ModeSpec,
	type ThinkingLevel,
	DEFAULT_MODE_ORDER,
	CUSTOM_MODE_NAME,
	getGlobalModesPath,
	getProjectModesPath,
	resolveModesPath,
	withFileLock,
	cloneModesFile,
	computeModesPatch,
	applyModesPatch,
	sanitizeModeSpec,
	createDefaultModes,
	ensureDefaultModeEntries,
	loadModesFile,
	saveModesFile,
	orderedModeNames,
	isDefaultModeName,
	isReservedModeName,
	validateModeNameOrError,
	renameModesRecord,
} from "../extensions/prompt-editor/modes-store.ts";
import { inferModeFromSelection, cycleModeName } from "../extensions/prompt-editor/modes.ts";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pe-test-"));
}

const SAMPLE_MODE: ModeSpec = {
	provider: "openai",
	modelId: "gpt-4",
	thinkingLevel: "medium",
};

test("createDefaultModes includes default and fast", () => {
	const file = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	expect(file.version).toBe(1);
	expect(file.currentMode).toBe("default");
	expect("default" in file.modes).toBe(true);
	expect("fast" in file.modes).toBe(true);
	expect(file.modes.fast?.thinkingLevel).toBe("off");
});

test("sanitizeModeSpec filters invalid fields", () => {
	expect(sanitizeModeSpec({ provider: 123, modelId: "gpt-4" })).toEqual({ provider: undefined, modelId: "gpt-4", thinkingLevel: undefined, color: undefined });
	expect(sanitizeModeSpec({ thinkingLevel: "invalid" })).toEqual({ provider: undefined, modelId: undefined, thinkingLevel: undefined, color: undefined });
	expect(sanitizeModeSpec({ thinkingLevel: "high" })).toEqual({ provider: undefined, modelId: undefined, thinkingLevel: "high", color: undefined });
});

test("ensureDefaultModeEntries adds missing default", () => {
	const file: ModesFile = { version: 1, currentMode: "default", modes: {} };
	ensureDefaultModeEntries(file, { provider: "openai", id: "gpt-4" }, "medium");
	expect("default" in file.modes).toBe(true);
});

test("ensureDefaultModeEntries resets invalid currentMode", () => {
	const file: ModesFile = {
		version: 1,
		currentMode: "nonexistent",
		modes: { default: SAMPLE_MODE },
	};
	ensureDefaultModeEntries(file);
	expect(file.currentMode).toBe("default");
});

test("ensureDefaultModeEntries clears custom as currentMode", () => {
	const file: ModesFile = {
		version: 1,
		currentMode: CUSTOM_MODE_NAME,
		modes: { default: SAMPLE_MODE },
	};
	ensureDefaultModeEntries(file);
	expect(file.currentMode).not.toBe(CUSTOM_MODE_NAME);
});

test("orderedModeNames excludes custom", () => {
	const modes = { default: SAMPLE_MODE, fast: SAMPLE_MODE, [CUSTOM_MODE_NAME]: SAMPLE_MODE };
	expect(orderedModeNames(modes)).toEqual(["default", "fast"]);
});

test("isDefaultModeName identifies defaults", () => {
	for (const name of DEFAULT_MODE_ORDER) {
		expect(isDefaultModeName(name)).toBe(true);
	}
	expect(isDefaultModeName("fast")).toBe(false);
});

test("isReservedModeName catches reserved names", () => {
	expect(isReservedModeName(CUSTOM_MODE_NAME)).toBe(true);
	expect(isReservedModeName("Configure modes…")).toBe(true);
	expect(isReservedModeName("Add mode…")).toBe(true);
	expect(isReservedModeName("Back")).toBe(true);
	expect(isReservedModeName("my-mode")).toBe(false);
});

test("validateModeNameOrError rejects empty, whitespace, reserved, duplicate", () => {
	const existing = { default: SAMPLE_MODE };
	expect(validateModeNameOrError("", existing)).not.toBeNull();
	expect(validateModeNameOrError("has space", existing)).not.toBeNull();
	expect(validateModeNameOrError(CUSTOM_MODE_NAME, existing)).not.toBeNull();
	expect(validateModeNameOrError("default", existing)).not.toBeNull();
	expect(validateModeNameOrError("default", existing, { allowExisting: true })).toBeNull();
	expect(validateModeNameOrError("new-mode", existing)).toBeNull();
});

test("cloneModesFile produces independent copy", () => {
	const file = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const clone = cloneModesFile(file);
	clone.modes.default!.provider = "changed";
	expect(file.modes.default!.provider).toBe("openai");
});

test("computeModesPatch detects added/modified/deleted modes", () => {
	const base = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const next = cloneModesFile(base);
	next.modes["review"] = { provider: "anthropic", modelId: "claude" };

	const patch = computeModesPatch(base, next, false);
	expect(patch).not.toBeNull();
	expect(patch!.modes).toBeDefined();
	expect(patch!.modes!["review"]).toEqual({ provider: "anthropic", modelId: "claude", thinkingLevel: undefined, color: undefined });
});

test("computeModesPatch returns null for no changes", () => {
	const base = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const next = cloneModesFile(base);
	expect(computeModesPatch(base, next, false)).toBeNull();
});

test("applyModesPatch applies add, modify, delete", () => {
	const target = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const patch = {
		modes: {
			review: { provider: "anthropic", modelId: "claude" } as ModeSpec,
			default: null,
		},
	};
	applyModesPatch(target, patch);
	expect("review" in target.modes).toBe(true);
	expect("default" in target.modes).toBe(false);
});

test("renameModesRecord renames correctly", () => {
	const modes = { default: SAMPLE_MODE, old: SAMPLE_MODE };
	const renamed = renameModesRecord(modes, "old", "new");
	expect("old" in renamed).toBe(false);
	expect("new" in renamed).toBe(true);
	expect("default" in renamed).toBe(true);
});

// --- File I/O round-trip ---

test("saveModesFile and loadModesFile round-trip", async () => {
	const dir = makeTempDir();
	const filePath = join(dir, "modes.json");
	const original = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	original.modes["review"] = { provider: "anthropic", modelId: "claude", thinkingLevel: "high" };

	await saveModesFile(filePath, original);
	const loaded = await loadModesFile(filePath, { provider: "openai", id: "gpt-4" }, "medium");

	expect(loaded.modes["review"]).toEqual({ provider: "anthropic", modelId: "claude", thinkingLevel: "high", color: undefined });
	expect(loaded.modes["default"]).toEqual(original.modes["default"]);
});

test("loadModesFile returns defaults for missing file", async () => {
	const dir = makeTempDir();
	const file = await loadModesFile(join(dir, "nonexistent.json"), { provider: "openai", id: "gpt-4" }, "medium");
	expect(file.modes.default).toBeDefined();
});

test("resolveModesPath prefers project over global", async () => {
	const dir = makeTempDir();
	const projectPath = getProjectModesPath(dir);
	mkdirSync(join(dir, ".pi"), { recursive: true });
	writeFileSync(projectPath, JSON.stringify({ version: 1, currentMode: "default", modes: {} }));

	const resolved = await resolveModesPath(dir, "/tmp/global-agent");
	expect(resolved).toBe(projectPath);
});

test("resolveModesPath falls back to global when no project file", async () => {
	const dir = makeTempDir();
	const globalPath = getGlobalModesPath("/tmp/global-agent");
	const resolved = await resolveModesPath(dir, "/tmp/global-agent");
	expect(resolved).toBe(globalPath);
});

// --- File locking ---

test("withFileLock allows sequential operations", async () => {
	const dir = makeTempDir();
	const filePath = join(dir, "modes.json");

	const result1 = await withFileLock(filePath, async () => {
		await saveModesFile(filePath, createDefaultModes({ provider: "a", id: "1" }, "off"));
		return "first";
	});

	const result2 = await withFileLock(filePath, async () => {
		return "second";
	});

	expect(result1).toBe("first");
	expect(result2).toBe("second");
});

// --- inferModeFromSelection ---

test("inferModeFromSelection finds exact match with thinking", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	data.modes["fast"] = { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" };

	const inferred = inferModeFromSelection(data, "openai", "gpt-4", "off", true);
	expect(inferred).toBe("fast");
});

test("inferModeFromSelection returns null for no match", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const inferred = inferModeFromSelection(data, "anthropic", "claude", "high", true);
	expect(inferred).toBeNull();
});

test("inferModeFromSelection without thinking support picks first candidate", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "off");
	data.modes["fast"] = { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" };

	const inferred = inferModeFromSelection(data, "openai", "gpt-4", "off", false);
	expect(inferred).not.toBeNull();
});

// --- cycleModeName ---

test("cycleModeName cycles forward", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	data.modes["fast"] = { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" };
	data.modes["review"] = { provider: "anthropic", modelId: "claude" };

	const next = cycleModeName(data, "default", "default", 1);
	expect(next).toBe("fast");
});

test("cycleModeName wraps around", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	data.modes["fast"] = { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" };

	const names = orderedModeNames(data.modes);
	const last = names[names.length - 1]!;
	const next = cycleModeName(data, last, last, 1);
	expect(next).toBe(names[0]);
});

test("cycleModeName uses lastRealMode when in custom", () => {
	const data = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	data.modes["fast"] = { provider: "openai", modelId: "gpt-4", thinkingLevel: "off" };

	const next = cycleModeName(data, CUSTOM_MODE_NAME, "default", 1);
	expect(next).toBe("fast");
});

// --- Pinned-model non-interference regression ---

test("prompt-editor modes.json never contains pinnedModel/defaultProvider/defaultModel keys", () => {
	const file = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const json = JSON.stringify(file);
	expect(json).not.toContain("pinnedModel");
	expect(json).not.toContain("defaultProvider");
	expect(json).not.toContain("defaultModel");
});

test("computeModesPatch never emits pinnedModel/defaultProvider/defaultModel", () => {
	const base = createDefaultModes({ provider: "openai", id: "gpt-4" }, "medium");
	const next = cloneModesFile(base);
	next.modes["test"] = { provider: "a", modelId: "b" };
	const patch = computeModesPatch(base, next, false);
	const patchJson = JSON.stringify(patch);
	expect(patchJson).not.toContain("pinnedModel");
	expect(patchJson).not.toContain("defaultProvider");
	expect(patchJson).not.toContain("defaultModel");
});
