// Parse structured mik-target-v1 assignment prompts so the router scores only
// the primary intent (objective + relevant context), never the generic control
// boilerplate, forbidden_scope, verification, result, or post-work sections.
//
// Ordinary natural-language prompts are passed through unchanged. Detection is
// intentional and conservative: a prompt is "structured" only if it has a
// top-level `objective:` field, which ordinary requests almost never do.

export interface ParsedPrompt {
  /** True when the prompt looks like a mik-target-v1 (or similar) contract. */
  isContract: boolean;
  /** Primary intent text used for routing (objective + context for contracts). */
  routingQuery: string;
  /** The objective section verbatim (used for authority checks). */
  objective: string;
  /** Allowed-scope text (file paths / explicit permissions). */
  allowedScope: string;
  /** Forbidden-scope text — never used as positive routing signal. */
  forbiddenScope: string;
  /** The original prompt. */
  raw: string;
}

/**
 * Split a contract into top-level sections keyed by the first `word:` at the
 * start of a line. Indented lines and list items belong to the current section.
 * Non-contract input yields an empty map and isContract=false upstream.
 */
function splitSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  let currentKey = "";
  let buffer: string[] = [];

  const flush = () => {
    if (currentKey) sections.set(currentKey, buffer.join("\n").trim());
  };

  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([a-z][a-z0-9_]*):\s*(.*)$/);
    if (m && !/^\s/.test(line)) {
      flush();
      currentKey = m[1];
      buffer = m[2] ? [m[2]] : [];
    } else if (currentKey) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function cleanSection(s: string | undefined): string {
  if (!s) return "";
  return s
    .split("\n")
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean)
    .join(" ");
}

/**
 * Parse a user prompt into routing-safe fields.
 *
 * For a structured contract the routing query is the objective plus the
 * context bullets — the cleanest signal of what the user actually wants done.
 * forbidden_scope / control / verification / result / post_work_synchronization
 * are exposed for authority checks but never fed to the scorer.
 */
export function parsePrompt(raw: string): ParsedPrompt {
  const sections = splitSections(raw);
  const objective = cleanSection(sections.get("objective"));
  const isContract = objective.length > 0;

  if (!isContract) {
    return {
      isContract: false,
      routingQuery: raw,
      objective: "",
      allowedScope: "",
      forbiddenScope: "",
      raw,
    };
  }

  const context = cleanSection(sections.get("context"));
  return {
    isContract: true,
    routingQuery: [objective, context].filter(Boolean).join(" "),
    objective,
    allowedScope: cleanSection(sections.get("allowed_scope")),
    forbiddenScope: cleanSection(sections.get("forbidden_scope")),
    raw,
  };
}
