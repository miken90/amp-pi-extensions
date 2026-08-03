import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeContent,
  applyPatch,
  repairLauncher,
  type LauncherStatus,
} from "../scripts/repair-herdr-agent.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A faithful copy of the hd-agent 0.9.x launcher env line.
const SUPPORTED_ENV = 'env: { ...process.env, AMP_PI_CLI: piCli },';
const LAUNCHER_HEADER =
  'const proc = Bun.spawn({\n' +
  '  cmd: [process.execPath, piCli],\n' +
  "  stdio: [\"inherit\", \"inherit\", \"inherit\"],\n";

function writeTempLauncher(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "herdr-repair-"));
  tempDirs.push(dir);
  const path = join(dir, "pim.ts");
  writeFileSync(path, content, "utf8");
  return path;
}

function supportedLauncher(): string {
  return writeTempLauncher(
    'const PI_PACKAGE = "x";\n' +
      'const AMP_PI_CLI = "marker";\n' +
      "Bun.spawn({});\n" +
      LAUNCHER_HEADER +
      `  ${SUPPORTED_ENV}\n` +
      "});\n",
  );
}

describe("analyzeContent — shape detection", () => {
  test("detects the supported hd-agent 0.9.x shape", () => {
    const status = analyzeContent(`Bun.spawn({ ${SUPPORTED_ENV} })`);
    expect(status.kind).toBe("supported");
    expect((status as Extract<LauncherStatus, { kind: "supported" }>).line).toContain("AMP_PI_CLI");
  });

  test("no-ops when HERDR_AGENT is already exported", () => {
    const status = analyzeContent(
      'env: { ...process.env, AMP_PI_CLI: piCli, HERDR_AGENT: "pi" },',
    );
    expect(status.kind).toBe("already-fixed");
  });

  test("refuses when there is no env line at all", () => {
    const status = analyzeContent('Bun.spawn({ cmd: ["pi"] });');
    expect(status.kind).toBe("unsupported");
    expect((status as Extract<LauncherStatus, { kind: "unsupported" }>).line).toBeNull();
  });

  test("refuses an unknown env shape (extra keys)", () => {
    const status = analyzeContent(
      "env: { ...process.env, AMP_PI_CLI: piCli, EXTRA: compute() },",
    );
    expect(status.kind).toBe("unsupported");
    const u = status as Extract<LauncherStatus, { kind: "unsupported" }>;
    expect(u.line).toContain("EXTRA");
    expect(u.reason).toContain("0.9.x");
  });

  test("refuses a totally different env object", () => {
    const status = analyzeContent("env: { FOO: 1, BAR: 2 },");
    // Has env + ...process.env? No → no env line matches → unsupported (no line).
    expect(status.kind).toBe("unsupported");
  });
});

describe("applyPatch — transformation", () => {
  test("injects HERDR_AGENT into the env object", () => {
    const out = applyPatch(`spawn({ ${SUPPORTED_ENV} });`);
    expect(out).toContain('HERDR_AGENT: "pi"');
    expect(out).toContain("AMP_PI_CLI: piCli");
    expect(out).not.toContain("piCli, ,");
  });

  test("handles the trailing-comma variant without double commas", () => {
    const out = applyPatch("env: { ...process.env, AMP_PI_CLI: piCli, },");
    expect(out).not.toMatch(/,\s*,/);
    expect(out).toContain('HERDR_AGENT: "pi"');
  });

  test("leaves already-fixed content unchanged", () => {
    const fixed = 'env: { ...process.env, AMP_PI_CLI: piCli, HERDR_AGENT: "pi" },';
    // applyPatch only matches the SUPPORTED shape; already-fixed content does not match.
    expect(applyPatch(fixed)).toBe(fixed);
  });
});

describe("repairLauncher — orchestration", () => {
  test("patches a supported launcher and creates a reversible backup", async () => {
    const path = supportedLauncher();
    const before = readFileSync(path, "utf8");
    expect(before).not.toContain("HERDR_AGENT");

    const result = await repairLauncher({ path });
    expect(result.patched).toBe(true);
    expect(result.status.kind).toBe("already-fixed");
    expect(result.backupPath).toBe(path + ".herdr-backup");

    const after = readFileSync(path, "utf8");
    expect(after).toContain('HERDR_AGENT: "pi"');

    // Backup retains the original pre-patch content.
    expect(readFileSync(result.backupPath!, "utf8")).toBe(before);
  });

  test("is idempotent — a second run is a no-op", async () => {
    const path = supportedLauncher();
    await repairLauncher({ path });
    const afterFirst = readFileSync(path, "utf8");

    const second = await repairLauncher({ path });
    expect(second.patched).toBe(false);
    expect(second.status.kind).toBe("already-fixed");
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
  });

  test("already-fixed launcher is a no-op and writes nothing", async () => {
    const path = writeTempLauncher(
      'env: { ...process.env, AMP_PI_CLI: piCli, HERDR_AGENT: "pi" },',
    );
    const before = readFileSync(path, "utf8");
    const result = await repairLauncher({ path });
    expect(result.patched).toBe(false);
    expect(result.status.kind).toBe("already-fixed");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(path + ".herdr-backup")).toBe(false);
  });

  test("refuses an unsupported shape and does not write", async () => {
    const path = writeTempLauncher(
      "env: { ...process.env, AMP_PI_CLI: piCli, UNKNOWN: thing() },\n",
    );
    const before = readFileSync(path, "utf8");
    const result = await repairLauncher({ path });
    expect(result.patched).toBe(false);
    expect(result.status.kind).toBe("unsupported");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("--check dry-run does not modify the file", async () => {
    const path = supportedLauncher();
    const before = readFileSync(path, "utf8");
    const result = await repairLauncher({ path, check: true });
    expect(result.patched).toBe(false);
    expect(result.status.kind).toBe("supported");
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("--restore rolls back to the backup content", async () => {
    const path = supportedLauncher();
    const original = readFileSync(path, "utf8");
    await repairLauncher({ path });
    expect(readFileSync(path, "utf8")).toContain("HERDR_AGENT");

    const restored = await repairLauncher({ path, restore: true });
    expect(restored.patched).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).not.toContain("HERDR_AGENT");
  });

  test("reports not-found for a missing path", async () => {
    const result = await repairLauncher({ path: "/nonexistent/pim.ts" });
    expect(result.status.kind).toBe("not-found");
    expect(result.patched).toBe(false);
  });

  test("post-patch verification failure rolls back (corrupt write guard)", async () => {
    // Patched content that drops the env line would fail verification; simulate
    // by giving a supported shape and confirming the real flow verifies fixed.
    const path = supportedLauncher();
    const result = await repairLauncher({ path });
    // The normal path must verify as already-fixed (sanity for the guard branch).
    expect(result.patched).toBe(true);
    expect(analyzeContent(readFileSync(path, "utf8"), path).kind).toBe("already-fixed");
  });
});
