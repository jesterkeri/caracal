// Adversary c25: a fee the anchor publishes in /info is silently dropped, and the preview shows a smaller one.
//
// Spec: attacker goal 4 (a person is told an amount that is not the anchor's) and
// docs/research/anchor-spike-2026-11-27.md section 5: "Anchor fee shown in the page is the anchor's own quote,
// never computed by Caracal unless `/info` publishes it". When /info publishes fee_fixed and fee_percent, the
// preview's "Anchor fee" and "Arrives" must reflect both, or say the fee is not shown.
// Cause: src/lib/anchor/sep24.ts stroopsOf() = toStroops(String(n)). A JSON number the anchor computed in
// floating point (0.1 + 0.2 is 0.30000000000000004) has more than 7 decimals, so toStroops returns null and
// parseInfo() records feeFixed = null, exactly as if the anchor had published no fixed fee. previewWithdraw()
// then computes the fee from fee_percent alone and shows it as the anchor's fee, with a matching "Arrives".
// The same happens for a number JavaScript prints in exponent form (1e-7). Nothing says a fee was ignored.
//
// Real: loadInfo (through a fake fetch that serves the anchor's /info shape), parseInfo and previewWithdraw.
// The /info body is constructed from the real testanchor answer (test/fixtures/anchor/sep24-info.json), which
// publishes no fee; only fee_fixed and fee_percent are added. The SDF test anchor publishes no fee today, so
// this concerns an anchor that does; the confirm screen later shows the anchor's real quote before any USDC
// leaves, so it is a wrong preview, not lost money.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadInfo, previewWithdraw } from "../src/lib/anchor/sep24";

const real = JSON.parse(readFileSync(new URL("./fixtures/anchor/sep24-info.json", import.meta.url), "utf8")) as { withdraw: { USDC: Record<string, unknown> } };
const SERVER = "https://testanchor.stellar.org/sep24";

/** A /info answer whose USDC withdraw entry carries `fee` as raw JSON text, so a float's own spelling is kept. */
const serving = (fee: string) =>
  (async () => {
    const usdc = JSON.stringify({ ...real.withdraw.USDC, fee_fixed: "@@FIXED@@", fee_percent: 1 }).replace('"@@FIXED@@"', fee);
    return new Response(`{"withdraw":{"USDC":${usdc}}}`);
  }) as unknown as typeof fetch;

describe("adversary c25: a published fixed fee the page cannot parse is ignored, not refused", () => {
  it("control: fee_fixed 0.3 and fee_percent 1 on 2 USDC preview a fee of 0.32 (0.3 fixed + 1 percent of 2)", async () => {
    const info = await loadInfo(SERVER, serving("0.3"));
    expect(info.feeFixed).toBe(BigInt(3_000_000));
    expect(previewWithdraw("2", info, null)).toEqual({ ok: true, amount: BigInt(20_000_000), fee: BigInt(3_200_000), arrives: BigInt(16_800_000) });
  });

  it("fee_fixed 0.30000000000000004 (a float's 0.1 + 0.2) is not dropped: the previewed fee is at least the 0.3 fixed fee, or none is shown", async () => {
    const info = await loadInfo(SERVER, serving(String(0.1 + 0.2)));
    expect(info.feePercent).toBe(1); // the rest of the fee was read
    const p = previewWithdraw("2", info, null);
    // Any fix passes: round to 7 places (fee 0.32), show no fee (null), or refuse with a reason. Today: fee 0.02.
    if (p.ok && p.fee !== null) expect(p.fee >= BigInt(3_000_000), `previewed fee ${p.fee} stroops, below the published fixed fee of 3000000`).toBe(true);
  });
});
