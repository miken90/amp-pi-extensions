// Config + runtime state for auto-skills.
//
// Config is layered: defaults < settings.json `autoSkills` object. The
// enable/disable commands flip a persisted flag in a small JSON state file
// under the agent config dir, so the choice survives restarts.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AutoSkillsConfig } from "./types.ts";

const STATE_FILE = "auto-skills.json";

/** Read merged config from a parsed settings.json object (or undefined). */
export function readConfig(settings: Record<string, unknown> | undefined): AutoSkillsConfig {
  const merged: AutoSkillsConfig = { ...DEFAULT_CONFIG };
  const block = settings?.autoSkills;
  if (block && typeof block === "object") {
    const b = block as Record<string, unknown>;
    if (typeof b.enabled === "boolean") merged.enabled = b.enabled;
    if (typeof b.maxSelected === "number") merged.maxSelected = b.maxSelected;
    if (typeof b.threshold === "number") merged.threshold = b.threshold;
    if (typeof b.preload === "boolean") merged.preload = b.preload;
    if (typeof b.maxBodyBytes === "number") merged.maxBodyBytes = b.maxBodyBytes;
    if (typeof b.maxTotalBytes === "number") merged.maxTotalBytes = b.maxTotalBytes;
    if (typeof b.enforceAuthority === "boolean") merged.enforceAuthority = b.enforceAuthority;
    if (Array.isArray(b.locations)) {
      merged.locations = b.locations.filter((x) => typeof x === "string") as string[];
    }
  }
  return merged;
}

export interface RuntimeState {
  enabled: boolean;
  lastRefreshAt?: number;
  lastSelected?: Array<{ name: string; score: number }>;
  lastReason?: string;
}

function statePath(agentDir: string): string {
  return join(agentDir, STATE_FILE);
}

export function readState(agentDir: string): RuntimeState {
  const path = statePath(agentDir);
  if (!existsSync(path)) return { enabled: true };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeState>;
    return { enabled: data.enabled ?? true, lastRefreshAt: data.lastRefreshAt, lastSelected: data.lastSelected, lastReason: data.lastReason };
  } catch {
    return { enabled: true };
  }
}

export function writeState(agentDir: string, state: RuntimeState): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(statePath(agentDir), JSON.stringify(state, null, 2));
  } catch {
    // State persistence is best-effort; routing still works in-memory.
  }
}
