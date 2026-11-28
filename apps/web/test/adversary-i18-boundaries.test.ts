// Adversary i18: attacks that were run against the invoices component (chain reads, the receipt lookup, error
// wording) and held. Kept as regression tests; none of them failed on 0b3c4fb.
import { Buffer } from "buffer";
import { Address, nativeToScVal, xdr, type rpc } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { findPaymentTx, readInvoice } from "../src/lib/invoices/chain";
import { splitErrorText } from "../src/lib/invoices/errors";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "ab".repeat(16);
const token = (ledger: number, n = 1) => `${(BigInt(ledger) << BigInt(32)).toString().padStart(19, "0")}-${String(n).padStart(10, "0")}`;
const bytes = (hex: string) => xdr.ScVal.scvBytes(Buffer.from(hex, "hex"));
const split = (tx: string, ref: string, extra: object = {}) => ({
  topic: [xdr.ScVal.scvSymbol("split"), xdr.ScVal.scvSymbol("v1")],
  value: xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("invoice_ref"), val: bytes(ref) })]),
  txHash: tx,
  ...extra,
});
function reader(next: (call: number) => { events: unknown[]; cursor: string } | Error, tip = 500_000) {
  const getEvents = vi.fn(async () => {
    const a = next(getEvents.mock.calls.length - 1);
    if (a instanceof Error) throw a;
    return a;
  });
  return { r: { getLatestLedger: async () => ({ sequence: tip }), getEvents } as unknown as Pick<rpc.Server, "getEvents" | "getLatestLedger">, getEvents };
}

describe("the receipt lookup does bounded work and skips what is not the payment", () => {
  it("an RPC whose cursor creeps forward one ledger per empty page costs at most 31 requests", async () => {
    const { r, getEvents } = reader((i) => ({ events: [], cursor: token(100_000 + i) }));
    expect(await findPaymentTx(r, SPLIT, REF)).toBeNull();
    expect(getEvents.mock.calls.length).toBeLessThanOrEqual(31);
  });
  it("events without a topic, with another name, for another reference, or marked failed are skipped; the real payment after them is found", async () => {
    const { r } = reader((i) =>
      i === 0
        ? {
            events: [
              { topic: [], value: xdr.ScVal.scvVoid(), txHash: "NOTOPIC" },
              { topic: [xdr.ScVal.scvU32(1)], value: xdr.ScVal.scvVoid(), txHash: "NOTSYMBOL" },
              split("OTHERREF", "cd".repeat(16)),
              split("FAILED", REF, { inSuccessfulContractCall: false }),
            ],
            cursor: token(300_000),
          }
        : { events: [split("PAID", REF)], cursor: token(499_999) },
    );
    expect(await findPaymentTx(r, SPLIT, REF)).toBe("PAID");
  });
  it("a request that fails after the first page ends in no receipt, never a throw", async () => {
    const { r } = reader((i) => (i === 0 ? { events: [], cursor: token(300_000) } : new Error("rpc 500")));
    expect(await findPaymentTx(r, SPLIT, REF)).toBeNull();
  });
  it("control: a payment on the first page is found with one request", async () => {
    const { r, getEvents } = reader(() => ({ events: [split("PAID", REF)], cursor: token(500_000) }));
    expect(await findPaymentTx(r, SPLIT, REF)).toBe("PAID");
    expect(getEvents).toHaveBeenCalledTimes(1);
  });
});

describe("an invoice read in an unexpected form is an error, never 'no invoice'", () => {
  const read = (retval: xdr.ScVal | undefined) =>
    readInvoice({ simulateTransaction: async () => ({ result: { retval, auth: [] } }) } as unknown as rpc.Server, SPLIT, REF);
  const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
  it("a missing answer, a status past 2, a bare number and a map are refused", async () => {
    await expect(read(undefined)).rejects.toThrow();
    await expect(read(xdr.ScVal.scvVec([i128(BigInt(5)), nativeToScVal(3, { type: "u32" })]))).rejects.toThrow();
    await expect(read(i128(BigInt(5)))).rejects.toThrow();
    await expect(read(xdr.ScVal.scvMap([]))).rejects.toThrow();
  });
  it("control: void is no invoice, and a status 0 to 2 is read", async () => {
    expect(await read(xdr.ScVal.scvVoid())).toBeNull();
    expect(await read(xdr.ScVal.scvVec([i128(BigInt(5)), nativeToScVal(2, { type: "u32" })]))).toEqual({ amount: BigInt(5), status: "cancelled" });
  });
});

describe("a contract error is worded for the contract that raised it", () => {
  const line = (contract: string, n: number) => `[Diagnostic Event] contract:${contract}, topics:[error, Error(Contract, #${n})]`;
  const log = (...lines: string[]) => `HostError: Error(Contract, #${lines.length}0)\nEvent log (newest first):\n${lines.map((l, i) => `   ${i}: ${l}`).join("\n")}`;
  const WALLET_ADDR = new Address(WALLET).toString();
  it("a wallet's own error number never reads as the split's", () => {
    expect(splitErrorText(log(line(WALLET_ADDR, 3002)), SPLIT)).toBeNull();
  });
  it("the USDC contract's #10 is the balance, not the split's 'does not exist'; the split's #12 is the split's", () => {
    expect(splitErrorText(log(line(SPLIT, 10), line(TOKENS.usdc, 10)), SPLIT)).toMatch(/does not hold enough USDC/);
    expect(splitErrorText(log(line(SPLIT, 12)), SPLIT)).toMatch(/cancelled/);
  });
});
