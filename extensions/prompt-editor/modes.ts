// Adapted from darkamenosa/pi-setup (Apache-2.0):
// https://github.com/darkamenosa/pi-setup/blob/main/extensions/prompt-editor.ts
// Changes: extracted pure CRUD logic into a separate testable module.
// Licensed under Apache-2.0 as a derived work — see NOTICE in README.md.

import type { ModesFile, ModeSpec, ModeName, ThinkingLevel } from "./modes-store.ts";
import { orderedModeNames, CUSTOM_MODE_NAME } from "./modes-store.ts";

export function inferModeFromSelection(
	data: ModesFile,
	provider: string | undefined,
	modelId: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	supportsThinking: boolean,
): string | null {
	if (!provider || !modelId) return null;

	const names = orderedModeNames(data.modes);

	if (supportsThinking) {
		for (const name of names) {
			const spec = data.modes[name];
			if (!spec) continue;
			if (spec.provider !== provider || spec.modelId !== modelId) continue;
			if ((spec.thinkingLevel ?? undefined) !== thinkingLevel) continue;
			return name;
		}
		return null;
	}

	const candidates: string[] = [];
	for (const name of names) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (spec.provider !== provider || spec.modelId !== modelId) continue;
		candidates.push(name);
	}
	if (candidates.length === 0) return null;

	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if ((spec.thinkingLevel ?? "off") === thinkingLevel) return name;
	}

	for (const name of candidates) {
		const spec = data.modes[name];
		if (!spec) continue;
		if (!spec.thinkingLevel) return name;
	}

	return candidates[0] ?? null;
}

export function cycleModeName(data: ModesFile, currentMode: string, lastRealMode: string, direction: 1 | -1 = 1): string | null {
	const names = orderedModeNames(data.modes);
	if (names.length === 0) return null;

	const baseMode = currentMode === CUSTOM_MODE_NAME ? lastRealMode : currentMode;
	const idx = Math.max(0, names.indexOf(baseMode));
	return names[(idx + direction + names.length) % names.length] ?? names[0] ?? null;
}
