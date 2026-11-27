// Adversary t1: the refusal reason for a missing `created` event asserts the
// contract "was created before the RPC's history window". A contract running
// the wasm in config SPLIT.wasmHash has no such event whenever it was created
// (the event exists only in the unuploaded new wasm, docs/decisions.md
// 2026-11-27), so absence proves nothing about its age. The real contract with
// that wasm, CAQ6XR26..., was deployed 2026-11-25 (apps/web/src/lib/stellar/
// config.ts), inside the window the real RPC reported on 2026-11-27 (it starts
// 2026-11-20, fixtures/tax/soroban-testnet-split-events.json).
import { describe, expect, it } from "vitest";
import { runTaxEstimate } from "./tax-classify-harness";
import { chain, deps, payment, req } from "./adversary-t1-harness";

describe("adversary t1: wrong reason for a refusal", () => {
  it("control: the window that starts 2026-11-20 refuses", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], "2026-11-20T14:15:35Z")));
    expect(out.status).toBe("refused");
  });

  it("does not say the contract was created before the window when it runs the wasm that never emits a creation event", async () => {
    const out = await runTaxEstimate(req, deps(chain([payment("2026-11-25T21:17:43Z", 10_000_000_000)], "2026-11-20T14:15:35Z")));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).not.toMatch(/was created before the RPC's history window/);
  });
});
