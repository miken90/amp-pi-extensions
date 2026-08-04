// Unit tests for pinned-model: /new must always land on the pinned model,
// regardless of the model the previous session was running.

import { test, expect } from "bun:test";
import pinnedModel from "../extensions/pinned-model/index.ts";

type Handler = (event: { reason: string }, ctx: unknown) => Promise<void> | void;

function harness(opts: {
  pin?: { provider: string; model: string };
  current?: { provider: string; id: string };
  available?: boolean;
  authorized?: boolean;
}) {
  let handler: Handler | undefined;
  const setCalls: Array<{ provider: string; id: string }> = [];
  const notices: Array<{ text: string; level: string }> = [];
  const pi = {
    on: (_event: string, fn: Handler) => {
      handler = fn;
    },
    setModel: async (m: { provider: string; id: string }) => {
      setCalls.push(m);
      return opts.authorized ?? true;
    },
  };
  pinnedModel(pi as never, { readPin: () => opts.pin });
  const ctx = {
    model: opts.current,
    modelRegistry: {
      find: (provider: string, id: string) => ((opts.available ?? true) ? { provider, id } : undefined),
    },
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) },
  };
  return { fire: (reason: string) => handler!({ reason }, ctx), setCalls, notices };
}

const PIN = { provider: "tuongnguyen-proxy", model: "glm-5.2" };

test("resets to the pinned model on a new session", async () => {
  const h = harness({ pin: PIN, current: { provider: "hdwebsoft-proxy", id: "claude-opus-5" } });
  await h.fire("new");
  expect(h.setCalls).toEqual([{ provider: "tuongnguyen-proxy", id: "glm-5.2" }]);
});

test("ignores session starts other than new", async () => {
  const h = harness({ pin: PIN, current: { provider: "hdwebsoft-proxy", id: "claude-opus-5" } });
  for (const reason of ["startup", "resume", "fork", "reload"]) await h.fire(reason);
  expect(h.setCalls).toEqual([]);
});

test("no-ops when no pin is configured", async () => {
  const h = harness({ current: { provider: "hdwebsoft-proxy", id: "claude-opus-5" } });
  await h.fire("new");
  expect(h.setCalls).toEqual([]);
  expect(h.notices).toEqual([]);
});

test("no-ops when already on the pinned model", async () => {
  const h = harness({ pin: PIN, current: { provider: "tuongnguyen-proxy", id: "glm-5.2" } });
  await h.fire("new");
  expect(h.setCalls).toEqual([]);
});

test("reports an unavailable pinned model without switching", async () => {
  const h = harness({ pin: PIN, current: { provider: "hdwebsoft-proxy", id: "claude-opus-5" }, available: false });
  await h.fire("new");
  expect(h.setCalls).toEqual([]);
  expect(h.notices[0].level).toBe("error");
});

test("reports a missing API key for the pinned model", async () => {
  const h = harness({ pin: PIN, current: { provider: "hdwebsoft-proxy", id: "claude-opus-5" }, authorized: false });
  await h.fire("new");
  expect(h.notices[0].text).toContain("no API key");
  expect(h.notices[0].level).toBe("error");
});
