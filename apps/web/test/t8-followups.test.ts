// Follow-ups to adversary t8 (the fix's own checks): the holdings are read after the covered ledger is fixed,
// so a holdings read an RPC node made at an OLDER ledger cannot be taken as agreeing with the payments; and the
// real reader names the ledger its two simulations were made at.
import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, rpcChainReader } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, chain } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const zero = () => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("0") }));

describe("t8 follow-ups", () => {
  it("control: holdings read at the covered ledger or later are accepted", async () => {
    const base = chain([]);
    const at = (await base.eventsAfter(CONTRACT, "x", 1)).latestLedger;
    const r = await readSplitPayments({ ...base, holdings: async () => ({ held: BigInt(0), pots: BigInt(0), ledger: at }) }, want);
    expect(r.kind).toBe("read");
  });

  it("holdings read at an older ledger than the covered one are refused", async () => {
    const base = chain([]);
    const at = (await base.eventsAfter(CONTRACT, "x", 1)).latestLedger;
    await expect(readSplitPayments({ ...base, holdings: async () => ({ held: BigInt(0), pots: BigInt(0), ledger: at - 1 }) }, want)).rejects.toThrow(/older ledger than its payments/);
  });

  it("the real reader names the older of its two simulations' ledgers", async () => {
    const answers = [
      { latestLedger: 91, v: zero() },
      { latestLedger: 90, v: xdr.ScVal.scvVec([zero(), zero(), zero()]) },
    ];
    const real = rpcChainReader("https://rpc.example", (async () => {
      const a = answers.shift()!;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { latestLedger: a.latestLedger, results: [{ xdr: a.v.toXDR("base64") }] } });
    }) as never);
    expect(await real.holdings(CONTRACT, TOKENS.usdc)).toEqual({ held: BigInt(0), pots: BigInt(0), ledger: 90 });
  });
});
