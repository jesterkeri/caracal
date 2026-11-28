// Codex invoices R3 #3: the receipt lookup stopped at the first page shorter than 200 events, but an RPC can answer
// a short or empty page while its cursor is still below the newest ledger, so a payment on a later page was missed;
// and it dropped every event without inSuccessfulContractCall, which newer RPCs no longer set.
import { Buffer } from "buffer";
import { xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { cursorLedger, findPaymentTx } from "../src/lib/invoices/chain";
import { SPLIT_ID as SPLIT } from "./relay-fixtures";

const REF = "ab".repeat(16);
const token = (ledger: number, n = 1) => `${(BigInt(ledger) << BigInt(32)).toString().padStart(19, "0")}-${String(n).padStart(10, "0")}`;
const payment = (tx: string, extra: object = {}) => ({
  topic: [xdr.ScVal.scvSymbol("split"), xdr.ScVal.scvSymbol("v1")],
  value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("invoice_ref"), val: xdr.ScVal.scvBytes(Buffer.from(REF, "hex")) })]),
  txHash: tx,
  ...extra,
});
function reader(pages: { events: unknown[]; cursor: string }[], tip = 500_000) {
  const getEvents = vi.fn(async () => pages[Math.min(getEvents.mock.calls.length - 1, pages.length - 1)]);
  return { r: { getLatestLedger: async () => ({ sequence: tip }), getEvents } as unknown as Pick<rpc.Server, "getEvents" | "getLatestLedger">, getEvents };
}

describe("Codex invoices R3 #3: the receipt lookup reaches a recent payment", () => {
  it("reads the ledger in a paging token", () => {
    expect(cursorLedger(token(380_000, 7))).toBe(380_000);
    expect(cursorLedger(String(BigInt(12) << BigInt(32)))).toBe(12);
    expect(cursorLedger("c")).toBeNull();
    expect(cursorLedger(undefined)).toBeNull();
  });

  it("an empty first page whose cursor is below the newest ledger does not end the scan", async () => {
    const { r } = reader([
      { events: [], cursor: token(390_000) },
      { events: [payment("PAID")], cursor: token(499_990) },
    ]);
    expect(await findPaymentTx(r, SPLIT, REF)).toBe("PAID");
  });

  it("an event with no inSuccessfulContractCall (newer RPCs) counts; one marked failed does not", async () => {
    expect(await findPaymentTx(reader([{ events: [payment("NEW")], cursor: token(500_000) }]).r, SPLIT, REF)).toBe("NEW");
    expect(await findPaymentTx(reader([{ events: [payment("FAILED", { inSuccessfulContractCall: false })], cursor: token(500_000) }]).r, SPLIT, REF)).toBeNull();
  });

  it("control: it stops once the cursor reaches the newest ledger, or stops moving", async () => {
    const atTip = reader([{ events: [], cursor: token(500_000) }]);
    expect(await findPaymentTx(atTip.r, SPLIT, REF)).toBeNull();
    expect(atTip.getEvents).toHaveBeenCalledTimes(1);
    const stuck = reader([{ events: [], cursor: token(390_000) }]);
    expect(await findPaymentTx(stuck.r, SPLIT, REF)).toBeNull();
    expect(stuck.getEvents).toHaveBeenCalledTimes(2);
  });
});
