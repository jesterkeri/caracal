// Adversary t15: with no `created` event in the window, the refusal offers two possible causes: "the contract was
// created before that window" or "it runs an older split contract that did not record its creation". Since adversary
// t14 (docs/decisions.md 2026-11-28), a split on Caracal's earlier wasm is refused before this point with its own
// reason, so a contract that reaches this refusal runs the current wasm, whose constructor always emits `created`.
// The second cause cannot be true, yet it is still offered: a wrong cause.
import { describe, expect, it } from "vitest";
import { SPLIT } from "../src/lib/stellar/config";
import { runTaxEstimate } from "./tax-classify-harness";
import { chain, deps, payment, req } from "./adversary-t1-harness";

const WINDOW_START = "2026-11-20T14:15:35Z";
const pay = () => payment("2026-11-25T21:17:43Z", 10_000_000_000);

describe("adversary t15: a refusal offers a cause that cannot be true", () => {
  it("control: a current-wasm split with no creation event in a window starting after 1 January is refused with the creation reason", async () => {
    const out = await runTaxEstimate(req, deps({ ...chain([pay()], WINDOW_START), instance: async () => ({ kind: "wasm", hash: SPLIT.wasmHash }) }));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toMatch(/created before that window/);
  });

  it("does not say the current wasm 'runs an older split contract' (that wasm records its creation, and the earlier wasm is refused first)", async () => {
    const out = await runTaxEstimate(req, deps({ ...chain([pay()], WINDOW_START), instance: async () => ({ kind: "wasm", hash: SPLIT.wasmHash }) }));
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).not.toMatch(/older split contract/);
  });
});
