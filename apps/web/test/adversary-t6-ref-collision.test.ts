// Adversary t6: two different invoices paid in one transaction for the same
// amount are refused as "the same payment listed twice" when one invoice ref is
// raw bytes and the other is the ASCII text of that bytes' hex form.
//
// Promise: the contract allows any 1 to 64 byte `invoice_ref`, one deposit per
// ref (contracts/split/README.md `create_invoice`, `deposit`), and the tax page
// must not refuse when every fact is proven (docs/decisions.md 2026-11-27: "two
// invoices of the same amount paid in one transaction are two payments").
// chain-payments.ts `refText` shows a non-printable ref as "0x" + hex, which
// is also how the printable ASCII text "0x0102" reads, so two distinct refs
// (bytes 01 02, and the six characters 0x0102) become the same `paymentRef` and
// the engine's duplicate guard (packages/tax/src/estimate.ts `paymentKeys`)
// takes them for one payment.
//
// Events are CONSTRUCTED in the real RPC wire format with the same encoder as
// the t1 harness; the CBN rates are the real captured rows.
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { runTaxEstimate } from "./tax-classify-harness";
import { WALLET, chain, deps, payment, type Item } from "./adversary-t1-harness";

const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const entry = (k: string, v: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

/** `item` with its invoice_ref replaced by `ref`, in the same transaction as `sameTxAs` (when given). */
function withRef(item: Item, ref: Buffer, units: bigint, sameTxAs?: Item): Item {
  const value = xdr.ScVal.scvMap([
    entry("amount", i128(units)),
    entry("from", Address.fromString(TOKENS.xlm).toScVal()),
    entry("goal", i128(BigInt(0))),
    entry("invoice_ref", xdr.ScVal.scvBytes(ref)),
    entry("owner", Address.fromString(WALLET).toScVal()),
    entry("spend", i128(units)),
    entry("tax", i128(BigInt(0))),
    entry("token", Address.fromString(TOKENS.usdc).toScVal()),
  ]);
  const event = { ...item.event, value: value.toXDR("base64") };
  if (!sameTxAs) return { event, tx: item.tx };
  return { event: { ...event, txHash: sameTxAs.event.txHash, ledger: sameTxAs.event.ledger, ledgerClosedAt: sameTxAs.event.ledgerClosedAt }, tx: sameTxAs.tx };
}

describe("adversary t6: two distinct invoice refs never become one payment reference", () => {
  const closedAt = "2026-11-25T10:00:00Z";
  const req = { wallet: WALLET, otherIncome: { kind: "all-in-caracal" as const } };
  const units = BigInt(10_000_000_000); // 1,000 USDC

  it("control: two ordinary text refs of the same amount in one transaction are two payments", async () => {
    const a = withRef(payment(closedAt, 1), Buffer.from("INV-1"), units);
    const b = withRef(payment(closedAt, 1), Buffer.from("INV-2"), units, a);
    const out = await runTaxEstimate(req, deps(chain([a, b])));
    expect(out.status).toBe("ok");
    expect(out.status === "ok" && out.estimate.incomeLines).toHaveLength(2);
  });

  it("counts raw bytes 01 02 and the text 0x0102 (two refs the contract keeps apart) as two payments", async () => {
    const a = withRef(payment(closedAt, 1), Buffer.from([0x01, 0x02]), units);
    const b = withRef(payment(closedAt, 1), Buffer.from("0x0102"), units, a);
    const out = await runTaxEstimate(req, deps(chain([a, b])));
    expect(out.status === "refused" ? out.reasons.join(" ") : "").not.toMatch(/same payment listed twice/);
    expect(out.status).toBe("ok");
  });
});
