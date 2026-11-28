// Adversary t14: a wallet whose split contract runs Caracal's own earlier split wasm (SPLIT.earlierWasmHashes,
// uploaded and sponsored by Caracal, docs/decisions.md 2026-11-28 "Split wasm upgrade") is refused by the tax
// estimate with the message "does not run Caracal's split code, so its payments cannot be trusted". That is false:
// the code is Caracal's, only an older build without the `created` event. The decisions row says these wallets
// "stay refused by the tax page (no `created` event; a payment indexer is needed)", so the person is told a wrong cause.
import { describe, expect, it } from "vitest";
import { SPLIT } from "../src/lib/stellar/config";
import { runTaxEstimate } from "../src/lib/tax/pipeline";
import { chain, deps, req } from "./adversary-t1-harness";

const reasonText = (out: Awaited<ReturnType<typeof runTaxEstimate>>): string =>
  out.status === "refused" ? out.reasons.join(" ") : out.status === "unavailable" || out.status === "no-contract" ? out.message : "";

const withWasm = (hash: string) => ({ ...chain([]), instance: async () => ({ kind: "wasm" as const, hash }) });

describe("adversary t14: earlier split wasm is refused with a false cause", () => {
  it("control: a wasm that really is not Caracal's is refused as not Caracal's code", async () => {
    const out = await runTaxEstimate(req, deps(withWasm("00".repeat(32))));
    expect(out.status).toBe("unavailable");
    expect(reasonText(out)).toMatch(/does not run Caracal's split code/);
  });

  it("control: the current wasm is estimated", async () => {
    const out = await runTaxEstimate(req, deps(withWasm(SPLIT.wasmHash)));
    expect(out.status).toBe("ok");
  });

  it("does not say Caracal's own earlier split wasm is not Caracal's split code", async () => {
    const out = await runTaxEstimate(req, deps(withWasm(SPLIT.earlierWasmHashes[0])));
    expect(out.status).not.toBe("ok");
    expect(reasonText(out)).not.toMatch(/does not run Caracal's split code/);
  });
});
