// memory-lite: manual per-repository curated context.
// Default-off, read-only injection through Pi 0.83's context event.
// No session scanning, embedded databases, model calls, delegated agents, timers,
// or background workers.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveIdentity, type RepoIdentity } from "./identity.ts";
import { memoryFilePath, enablementFilePath } from "./storage.ts";
import { readEnablement, writeEnablement } from "./config.ts";
import { parseDocument, createDocument, addEntry, removeEntry, serializeDocument, SCHEMA_VERSION } from "./schema.ts";
import { makeContextHandler, freshRead } from "./read-path.ts";
import { formatStatusText, type MemoryStatus } from "./status.ts";
import { addMemoryEntry, removeMemoryEntry } from "./write-path.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface MemoryLiteDeps {
	agentDir?: () => string;
	resolveIdentity?: (agentDir: string) => RepoIdentity | null;
	existsSync?: (p: string) => boolean;
	readFileSync?: (p: string, encoding: string) => string | undefined;
}

export default function memoryLite(pi: ExtensionAPI, deps?: MemoryLiteDeps): void {
	const agentDir = deps?.agentDir ?? (() => getAgentDir());
	const resolveId = deps?.resolveIdentity ?? ((ad: string) => resolveIdentity(ad));

	// Register context handler (default-off; handler checks enablement fresh each time)
	const contextHandler = makeContextHandler(
		() => resolveId(agentDir()),
		{ existsSync: deps?.existsSync, readFileSync: deps?.readFileSync },
	);
	pi.on("context", contextHandler);

	// /memory command
	pi.registerCommand("memory", {
		description: "memory-lite: manage per-repository curated context (status, show, list, add, remove, enable, disable)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const identity = resolveId(agentDir());

			switch (sub) {
				case "":
				case "status": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository (no .git boundary found)", "warning");
						return;
					}
					const enablement = readEnablement(enablementFilePath(identity));
					const memPath = memoryFilePath(identity);
					let entryCount = 0;
					let byteCount = 0;
					let truncated = false;
					let lastError: string | undefined;

					if (existsSync(memPath)) {
						try {
							const raw = readFileSync(memPath, "utf8");
							const doc = parseDocument(raw);
							if (doc) {
								entryCount = doc.entries.length;
								byteCount = Buffer.byteLength(raw, "utf8");
							} else {
								lastError = "malformed or unsupported version";
							}
						} catch (e) {
							lastError = e instanceof Error ? e.message : String(e);
						}
					}

					const status: MemoryStatus = {
						enabled: enablement.enabled,
						repoLabel: identity.label,
						repoKeyPrefix: identity.shortKey,
						schemaVersion: SCHEMA_VERSION,
						entryCount,
						byteCount,
						truncated,
						storagePath: identity.storageDir,
						lastReadAt: enablement.lastReadAt,
						lastWriteAt: enablement.lastWriteAt,
						lastError: enablement.lastError ?? lastError,
					};
					ctx.ui.notify(formatStatusText(status), "info");
					return;
				}

				case "show": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const memPath = memoryFilePath(identity);
					if (!existsSync(memPath)) {
						ctx.ui.notify("memory-lite: no memory file found", "info");
						return;
					}
					try {
						const raw = readFileSync(memPath, "utf8");
						const doc = parseDocument(raw);
						if (!doc) {
							ctx.ui.notify("memory-lite: malformed or unsupported memory file", "warning");
							return;
						}
						ctx.ui.notify(`memory-lite: ${doc.entries.length} entries\n${serializeDocument(doc)}`, "info");
					} catch (e) {
						ctx.ui.notify(`memory-lite: failed to read: ${e instanceof Error ? e.message : String(e)}`, "error");
					}
					return;
				}

				case "list": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const memPath = memoryFilePath(identity);
					if (!existsSync(memPath)) {
						ctx.ui.notify("memory-lite: no memory file found", "info");
						return;
					}
					try {
						const raw = readFileSync(memPath, "utf8");
						const doc = parseDocument(raw);
						if (!doc) {
							ctx.ui.notify("memory-lite: malformed memory file", "warning");
							return;
						}
						if (doc.entries.length === 0) {
							ctx.ui.notify("memory-lite: no entries", "info");
							return;
						}
						const lines = doc.entries.map((e) => {
							const tags = e.tags.length > 0 ? ` [${e.tags.join(", ")}]` : "";
							const preview = e.text.length > 60 ? e.text.slice(0, 60) + "…" : e.text;
							return `  ${e.id} ${tags} ${preview}`;
						});
						ctx.ui.notify(`memory-lite: ${doc.entries.length} entries\n${lines.join("\n")}`, "info");
					} catch (e) {
						ctx.ui.notify(`memory-lite: failed to read: ${e instanceof Error ? e.message : String(e)}`, "error");
					}
					return;
				}

				case "add": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const text = rest.join(" ");
					if (!text && ctx.hasUI) {
						const input = await ctx.ui.input("Memory entry text", "Enter the context to remember");
						if (!input) return;
						const result = await addMemoryEntry(identity, input);
						if (result.success) {
							ctx.ui.notify(`memory-lite: added entry ${result.entryId}`, "info");
						} else {
							ctx.ui.notify(`memory-lite: ${result.error}`, "error");
						}
						return;
					}
					if (!text) {
						ctx.ui.notify("usage: /memory add <text>", "info");
						return;
					}
					// Parse tags from --tag=value or --tag value syntax
					const tagMatch = text.match(/--tags?\s+(\S+)/);
					const tags = tagMatch ? tagMatch[1]!.split(",").map((t) => t.trim()).filter(Boolean) : [];
					const cleanText = text.replace(/--tags?\s+\S+/, "").trim();
					const result = await addMemoryEntry(identity, cleanText, tags);
					if (result.success) {
						ctx.ui.notify(`memory-lite: added entry ${result.entryId}`, "info");
					} else {
						ctx.ui.notify(`memory-lite: ${result.error}`, "error");
					}
					return;
				}

				case "remove": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const entryId = rest[0];
					if (!entryId) {
						ctx.ui.notify("usage: /memory remove <id>", "info");
						return;
					}
					const result = await removeMemoryEntry(identity, entryId);
					if (result.success) {
						ctx.ui.notify(`memory-lite: removed entry ${entryId}`, "info");
					} else {
						ctx.ui.notify(`memory-lite: ${result.error}`, "error");
					}
					return;
				}

				case "enable": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const enablementPath = enablementFilePath(identity);
					mkdirSync(dirname(enablementPath), { recursive: true });
					writeEnablement(enablementPath, { enabled: true, lastWriteAt: new Date().toISOString() });
					ctx.ui.notify("memory-lite: enabled for this repository", "info");
					return;
				}

				case "disable": {
					if (!identity) {
						ctx.ui.notify("memory-lite: not a repository", "warning");
						return;
					}
					const enablementPath = enablementFilePath(identity);
					if (existsSync(enablementPath)) {
						const current = readEnablement(enablementPath);
						writeEnablement(enablementPath, { ...current, enabled: false, lastWriteAt: new Date().toISOString() });
					}
					ctx.ui.notify("memory-lite: disabled for this repository", "info");
					return;
				}

				default:
					ctx.ui.notify("usage: /memory [status|show|list|add|remove|enable|disable]", "info");
			}
		},
	});
}
