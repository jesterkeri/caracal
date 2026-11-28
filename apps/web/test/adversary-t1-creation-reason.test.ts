// Adversary t1: the refusal reason for a missing `created` event asserted the contract "was created before the
// RPC's history window", although a contract running a wasm that never emits that event has none whenever it was
// created, so absence proves nothing about its age.
// Restated 2026-11-28 with the split wasm upgrade (docs/decisions.md, "Split wasm upgrade", "Adversary t14", "Adversary
// t15"): the pinned wasm (SPLIT.wasmHash) now always emits `created`, and the wasm that never emits it is Caracal's
// earlier one (SPLIT.earlierWasmHashes). The promise is unchanged: a split on that wasm is never told it was created
// before the window. It now gets its own reason, as an unavailable estimate (before: a refusal); the assertion on the
// status changed with that, and the text check is broader (any "created before").
import { describe, expect, it } from "vitest";
import { SPLIT } from "../src/lib/stellar/config";
import { runTaxEstimate } from "./tax-classify-harness";
import { chain, deps, payment, req } from "./adversary-t1-harness";

describe("adversary t1: wrong reason for a refusal", () => {
  it("control: the window that starts 2026-11-20 refuses", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], "2026-11-20T14:15:35Z")));
    expect(out.status).toBe("refused");
  });

  it("does not say the contract was created before the window when it runs the wasm that never emits a creation event", async () => {
    const earlier = { ...chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], "2026-11-20T14:15:35Z"), instance: async () => ({ kind: "wasm" as const, hash: SPLIT.earlierWasmHashes[0] }) };
    const out = await runTaxEstimate(req, deps(earlier));
    expect(out.status).toBe("unavailable");
    if (out.status !== "unavailable") return;
    expect(out.message).not.toMatch(/created before/);
    expect(out.message).toMatch(/earlier version of Caracal's split code, which does not record when the split was opened/);
  });
});
