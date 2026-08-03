#!/usr/bin/env bun
/**
 * Post-update repair for the hd-agent `amp-pi`/`pi` launcher.
 *
 * Herdr (v0.7.5) recognizes a foreground process as a promptable agent when the
 * process-group leader exports `HERDR_AGENT`. The hd-agent wrapper spawns the
 * real Pi CLI via `Bun.spawn` and forwards `...process.env` plus `AMP_PI_CLI`,
 * but not `HERDR_AGENT`, so wrapper-launched Pi sessions are not Herdr-promptable
 * unless the user manually prefixes `HERDR_AGENT=pi`. This script idempotently
 * adds `HERDR_AGENT: "pi"` to that env object.
 *
 * Safety contract:
 *  - Locates the global hd-agent launcher and verifies it looks like one.
 *  - No-ops when the env already exports `HERDR_AGENT` (upstream fixed).
 *  - Only patches the exact supported hd-agent 0.9.x shape.
 *  - Refuses unknown shapes (prints the offending line), exits non-zero.
 *  - Creates a reversible backup before writing; `--restore` rolls back.
 *  - Idempotent: a second run detects "already-fixed" and changes nothing.
 *
 * Usage (from any cwd):
 *   bun run /path/to/pi-extensions/scripts/repair-herdr-agent.ts            # apply
 *   bun run /path/to/pi-extensions/scripts/repair-herdr-agent.ts --check    # dry-run
 *   bun run /path/to/pi-extensions/scripts/repair-herdr-agent.ts --restore  # rollback
 *   bun run ... --launcher /explicit/path/to/pim.ts                         # override target
 */

import {
  copyFileSync,
  existsSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const HERDR_AGENT_VALUE = "pi";

/** Matches the `env: { ...process.env, AMP_PI_CLI: piCli }` Bun.spawn option. */
const ENV_LINE_RE = /env:\s*\{[^}]*\.\.\.process\.env[^}]*\}/;
/** The env object already carries a HERDR_AGENT key — upstream fixed. */
const ALREADY_FIXED_RE = /env:\s*\{[^}]*\bHERDR_AGENT\b[^}]*\}/;
/** The exact hd-agent 0.9.x shape we know how to patch. */
const SUPPORTED_RE =
  /env:\s*\{\s*\.\.\.process\.env,\s*AMP_PI_CLI:\s*piCli\s*,?\s*\}/;
/** Markers confirming a file is the hd-agent launcher (not a random .ts). */
const LAUNCHER_MARKERS = ["AMP_PI_CLI", "Bun.spawn"];

export type LauncherStatus =
  | { kind: "already-fixed"; path: string; line: string }
  | { kind: "supported"; path: string; line: string }
  | { kind: "unsupported"; path: string; line: string | null; reason: string }
  | { kind: "not-found"; path: string };

/** Classify launcher content without touching the filesystem. */
export function analyzeContent(content: string, path = "<memory>"): LauncherStatus {
  const match = content.match(ENV_LINE_RE);
  if (!match) {
    return {
      kind: "unsupported",
      path,
      line: null,
      reason: "no `env: { ...process.env … }` Bun.spawn option found",
    };
  }
  const line = match[0];
  if (ALREADY_FIXED_RE.test(content)) {
    return { kind: "already-fixed", path, line };
  }
  if (SUPPORTED_RE.test(content)) {
    return { kind: "supported", path, line };
  }
  return {
    kind: "unsupported",
    path,
    line,
    reason:
      "env line does not match the expected hd-agent 0.9.x shape `{ ...process.env, AMP_PI_CLI: piCli }`",
  };
}

/** Return patched content with `HERDR_AGENT: \"pi\"` injected into the env object. */
export function applyPatch(content: string): string {
  return content.replace(SUPPORTED_RE, (line) => {
    const head = line.replace(/[\s,]*\}\s*$/, "");
    return `${head}, HERDR_AGENT: "${HERDR_AGENT_VALUE}" }`;
  });
}

function isLauncherFile(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    return LAUNCHER_MARKERS.every((m) => content.includes(m));
  } catch {
    return false;
  }
}

/** Resolve the global hd-agent launcher path, or null if not found. */
export function findLauncher(): string | null {
  const override = process.env["HERDR_LAUNCHER"];
  if (override && isLauncherFile(override)) return resolve(override);

  const home = homedir();
  // 1. The bun global bin symlink (~/.bun/bin/amp-pi → …/hd-agent/bin/pim.ts).
  const symlink = join(home, ".bun", "bin", "amp-pi");
  if (existsSync(symlink)) {
    try {
      const real = realpath(symlink);
      if (isLauncherFile(real)) return real;
    } catch {
      /* fall through */
    }
  }

  // 2. The canonical global install location.
  const canonical = join(
    home,
    ".bun",
    "install",
    "global",
    "node_modules",
    "hd-agent",
    "bin",
    "pim.ts",
  );
  if (isLauncherFile(canonical)) return canonical;

  return null;
}

function realpath(path: string): string {
  // Resolve a chain of symlinks to the final file path.
  const seen = new Set<string>();
  let current = path;
  while (seen.size < 40) {
    seen.add(current);
    let link: string | null = null;
    try {
      link = readlinkSync(current);
    } catch {
      return current; // not a symlink — done
    }
    current = resolve(dirname(current), link);
    if (seen.has(current)) return current; // cycle guard
  }
  return current;
}

export type RepairResult = {
  status: LauncherStatus;
  backupPath?: string;
  patched: boolean;
};

export type RepairOptions = {
  path?: string; // explicit launcher path (skips discovery)
  check?: boolean; // dry-run: analyze only, write nothing
  restore?: boolean; // roll back from backup
};

const BACKUP_SUFFIX = ".herdr-backup";

/** Back up a file (first-patch wins: keep the original pre-patch content). */
function ensureBackup(path: string): string {
  const backup = path + BACKUP_SUFFIX;
  if (!existsSync(backup)) copyFileSync(path, backup);
  return backup;
}

/** Orchestrate the full repair against a launcher file. Pure I/O, no globals. */
export async function repairLauncher(
  options: RepairOptions = {},
): Promise<RepairResult> {
  const path = options.path ?? findLauncher();
  if (!path || !existsSync(path)) {
    return {
      status: { kind: "not-found", path: path ?? "<missing>" },
      patched: false,
    };
  }

  if (options.restore) {
    const backup = path + BACKUP_SUFFIX;
    if (!existsSync(backup)) {
      return {
        status: {
          kind: "unsupported",
          path,
          line: null,
          reason: `no backup at ${backup}; nothing to restore`,
        },
        patched: false,
      };
    }
    copyFileSync(backup, path);
    return { status: analyzeContent(readFileSync(path, "utf8"), path), patched: false };
  }

  const content = readFileSync(path, "utf8");
  const status = analyzeContent(content, path);

  if (status.kind !== "supported" || options.check) {
    return { status, patched: false };
  }

  const backupPath = ensureBackup(path);
  const patched = applyPatch(content);
  // Guard: the patch must change content and the result must read as fixed.
  if (patched === content) {
    return { status, patched: false };
  }
  writeFileSync(path, patched, "utf8");
  const verify = analyzeContent(readFileSync(path, "utf8"), path);
  if (verify.kind !== "already-fixed") {
    // Roll back on verification failure.
    copyFileSync(backupPath, path);
    return {
      status: {
        kind: "unsupported",
        path,
        line: verify.kind === "unsupported" ? verify.line : status.line,
        reason: `post-patch verification failed (${verify.kind}); rolled back`,
      },
      patched: false,
    };
  }

  return { status: verify, backupPath, patched: true };
}

function arg(name: string): boolean {
  return process.argv.includes(name);
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

async function main(): Promise<number> {
  const launcherArg = argValue("--launcher");
  const result = await repairLauncher({
    path: launcherArg,
    check: arg("--check"),
    restore: arg("--restore"),
  });
  const { status, patched } = result;

  switch (status.kind) {
    case "not-found":
      console.error(
        `repair-herdr-agent: launcher not found.\n` +
          `Set --launcher <path> or HERDR_LAUNCHER=<path>, or install hd-agent globally.`,
      );
      return 2;
    case "unsupported":
      console.error(
        `repair-herdr-agent: ${status.reason}\n` +
          (status.line ? `  env line: ${status.line}\n` : "") +
          `  file: ${status.path}\n` +
          `Refusing to patch an unknown launcher shape. Inspect the file and patch manually.`,
      );
      return 1;
    case "already-fixed":
      console.log(
        `repair-herdr-agent: already Herdr-ready (env exports HERDR_AGENT) — no-op.\n` +
          `  file: ${status.path}`,
      );
      return 0;
    case "supported":
      if (patched) {
        console.log(
          `repair-herdr-agent: patched HERDR_AGENT="${HERDR_AGENT_VALUE}".\n` +
            `  file: ${status.path}\n` +
            `  backup: ${result.backupPath}\n` +
            `A fresh amp-pi/pi session will now be Herdr-promptable. Roll back with --restore.`,
        );
      } else {
        console.log(
          `repair-herdr-agent: supported shape detected (dry-run, no changes).\n` +
            `  file: ${status.path}\n` +
            `  env line: ${status.line}\n` +
            `Re-run without --check to apply.`,
        );
      }
      return 0;
  }
}

if (import.meta.main) {
  const exit = await main();
  process.exit(exit);
}
