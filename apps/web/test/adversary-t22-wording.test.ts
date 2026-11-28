// Adversary t22: two refusals whose stated reason does not match the cause (no number is shown in either case).
//
// (1) Clock. The estimate's `asOf` is the server's clock; the account's sync time is the close time of the newest
// ledger the RPC names. A server clock a few seconds behind that ledger makes the engine say 'Account "Your Caracal
// split contract (Stellar testnet)" says it was synced at ..., which is after .... That cannot be right.' The t20 fix
// reworded the other two engine sync reasons for the split contract (docs/decisions.md 2026-11-28, adversary t20:
// "The pipeline now rewords both engine sync reasons for the split contract"; the person "has no account to sync")
// but not this one: it still names a linked account and gives no way forward.
//
// (2) Typed naira. A person who writes naira the usual Nigerian way ("2,500,000", "600,000", "N600000") is refused
// with "give that amount in naira with at most 2 decimal places" / "naira with at most 2 decimal places": the amount
// has no decimal places, so the stated reason is false, and nothing says what to change. Promise: pipeline.ts header
// "Everything that can fail refuses; ..." with a plain reason, and the t20/t21 rule that a refusal names its real
// cause. The README says naira typed by the person is trimmed then parsed strictly: "600000.5" and " 600000 " are fine.
//
// Real pipeline through the classify harness (it answers "income" for the listed payment, as the page does). Chain
// answers are CONSTRUCTED in the real Soroban RPC wire format (the t1 harness encoder); the CBN rates are the real
// captured rows in fixtures/tax/cbn-nfem-rates.json.
import { describe, expect, it } from "vitest";
import { chain, deps, payment, req } from "./adversary-t1-harness";
import { runTaxEstimate } from "./tax-classify-harness";

// The harness's newest ledger closes at 2026-11-27T14:59:30Z.
const items = () => [payment("2026-11-26T10:00:00Z", 10_000_000_000)];
const withClock = (iso: string) => ({ ...deps(chain(items())), now: () => new Date(iso) });

describe("adversary t22 (1): a server clock behind the newest ledger", () => {
  it("control: a clock at the newest ledger's close time gives an estimate", async () => {
    const out = await runTaxEstimate(req, withClock("2026-11-27T14:59:30Z"));
    expect(out.status).toBe("ok");
  });

  it("a clock 10 seconds behind it is not blamed on a linked account that cannot be fixed", async () => {
    const out = await runTaxEstimate(req, withClock("2026-11-27T14:59:20Z"));
    if (out.status === "ok") return; // accepting a small skew is also a fix
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    const shown = out.reasons.join(" ");
    expect(shown).not.toMatch(/Account "/);
    expect(shown).not.toMatch(/cannot be right/i);
    expect(shown).toMatch(/clock|try again/i);
  });
});

describe("adversary t22 (2): naira written with a thousands comma or an N sign", () => {
  const rent = (annualRentNgn: string) => runTaxEstimate({ ...req, annualRentNgn }, deps(chain(items())));
  const elsewhere = (amountNgn: string) => runTaxEstimate({ ...req, otherIncome: { kind: "elsewhere", amountNgn } }, deps(chain(items())));

  it("control: digits only, and a kobo fraction, are taken; a real third decimal place is refused for decimal places", async () => {
    expect((await rent("600000")).status).toBe("ok");
    expect((await rent(" 600000.5 ")).status).toBe("ok");
    expect((await elsewhere("2500000")).status).toBe("ok");
    const three = await rent("600000.555");
    expect(three.status).toBe("refused");
    if (three.status === "refused") expect(three.reasons.join(" ")).toMatch(/decimal places/);
  });

  it.each(["600,000", "N600000"])("rent %s is taken, or the reason says what is wrong with it", async (typed) => {
    const out = await rent(typed);
    if (out.status === "ok") return;
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    // "decimal places" alone is false for an amount with none.
    expect(out.reasons.join(" ")).toMatch(/comma|digits|separator|letters|symbol|"N"/i);
  });

  it("income elsewhere 2,500,000 is taken, or the reason says what is wrong with it", async () => {
    const out = await elsewhere("2,500,000");
    if (out.status === "ok") return;
    expect(out.status).toBe("refused");
    if (out.status !== "refused") return;
    expect(out.reasons.join(" ")).toMatch(/comma|digits|separator|letters|symbol/i);
  });
});
