// Adversary c22: a number the anchor publishes in its /info answer crashes the cash-out page's render.
//
// Spec: attacker goals 2 and 5 (the anchor gains a power over the Caracal page; a person is left with a
// page that does not work), and docs/decisions.md 2026-11-27 row c1 (3): "every anchor request (toml, info,
// sign-in, withdraw start, status) has a 20 s deadline ... ending in a shown error". An anchor answer that
// the page cannot use must end in a shown error, never in a thrown exception.
// Cause: src/lib/anchor/sep24.ts previewWithdraw() turns the anchor's fee_percent into micro-percent with
// BigInt(Math.round(info.feePercent * 1e7)). parseInfo() accepts any finite number, and a finite
// fee_percent of 1e302 or more makes the product Infinity, so BigInt(Infinity) throws a RangeError.
// src/app/cashout/page.tsx runs `previewWithdraw(amountText, info, balance)` in the component body on every
// render once the person types an amount, with no try/catch and no error boundary in src/app, so the page
// shows Next's "client-side exception" screen and the person cannot cash out or even read the anchor's limits.
//
// Real: loadInfo (through a fake fetch that serves the anchor's /info shape), parseInfo and previewWithdraw.
// The /info body is constructed (the real testanchor answer is in test/fixtures/anchor/sep24-info.json and
// has no fee_percent); only fee_percent differs from it. Only a hostile or broken anchor sends such a number,
// the SDF test anchor does not, so this is an availability defect, not a loss of funds.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadInfo, previewWithdraw } from "../src/lib/anchor/sep24";

const real = JSON.parse(readFileSync(new URL("./fixtures/anchor/sep24-info.json", import.meta.url), "utf8")) as { withdraw: { USDC: Record<string, unknown> } };
const SERVER = "https://testanchor.stellar.org/sep24";

const serving = (usdc: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify({ ...real, withdraw: { ...real.withdraw, USDC: { ...real.withdraw.USDC, ...usdc } } }))) as unknown as typeof fetch;

describe("adversary c22: an anchor-published fee_percent that overflows", () => {
  it("control: a sane published fee (10 percent, as the spike's anchor charged) previews fee 0.2 and arrives 1.8 on 2 USDC", async () => {
    const info = await loadInfo(SERVER, serving({ fee_percent: 10 }));
    const p = previewWithdraw("2", info, null);
    expect(p).toEqual({ ok: true, amount: BigInt(20_000_000), fee: BigInt(2_000_000), arrives: BigInt(18_000_000) });
  });

  it("fee_percent 1e302 does not make the preview throw (it runs in the page's render body)", async () => {
    const info = await loadInfo(SERVER, serving({ fee_percent: 1e302 }));
    expect(info.feePercent).toBe(1e302); // parseInfo accepted it as a finite number
    expect(() => previewWithdraw("2", info, null)).not.toThrow();
  });
});
