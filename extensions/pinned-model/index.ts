// pinned-model: force every new session (/new) onto a pinned model, ignoring
// whatever model the current session happens to be running.
//
// Pi persists `defaultModel`/`defaultProvider` on every model switch, so those
// fields are really "last used model" and cannot act as a stable default. This
// extension keeps a separate `pinnedModel` block in settings.json and reapplies
// it whenever a session starts with reason "new".
//
// settings.json (global ~/.pi/agent/settings.json or project .pi/settings.json):
//   { "pinnedModel": { "provider": "tuongnguyen-proxy", "model": "glm-5.2" } }
// Project settings override global, so each repo can pin its own model.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PinnedModel {
  provider: string;
  model: string;
}

export interface PinnedModelDeps {
  /** Override the pin lookup (tests inject a fixed value). */
  readPin?: () => PinnedModel | undefined;
  /** Override the agent config dir (default $HOME/.pi/agent). */
  agentDir?: () => string;
}

export default function pinnedModel(pi: ExtensionAPI, deps?: PinnedModelDeps): void {
  const agentDir = (): string => deps?.agentDir?.() ?? join(homedir(), ".pi", "agent");
  const readPin = deps?.readPin ?? (() => readPinFromSettings(agentDir()));

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "new") return;

    const pin = readPin();
    if (!pin) return;
    if (ctx.model?.provider === pin.provider && ctx.model?.id === pin.model) return;

    const model = ctx.modelRegistry.find(pin.provider, pin.model);
    if (!model) {
      ctx.ui.notify(`pinned-model: ${pin.provider}/${pin.model} is not available`, "error");
      return;
    }
    if (await pi.setModel(model)) {
      ctx.ui.notify(`pinned-model: reset to ${pin.provider}/${pin.model}`, "info");
    } else {
      ctx.ui.notify(`pinned-model: no API key for ${pin.provider}/${pin.model}`, "error");
    }
  });
}

// Read the `pinnedModel` block from global then project settings, project wins.
function readPinFromSettings(agentDir: string): PinnedModel | undefined {
  let pin: PinnedModel | undefined;
  for (const file of [join(agentDir, "settings.json"), join(process.cwd(), ".pi", "settings.json")]) {
    if (!existsSync(file)) continue;
    try {
      const block = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>).pinnedModel;
      if (block && typeof block === "object") {
        const { provider, model } = block as Record<string, unknown>;
        if (typeof provider === "string" && typeof model === "string") pin = { provider, model };
      }
    } catch {
      // ignore malformed settings
    }
  }
  return pin;
}
