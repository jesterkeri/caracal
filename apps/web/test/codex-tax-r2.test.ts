// Codex tax R2 #1 (external review of 57781ab): a holdings read whose simulation answers did not name a ledger
// was taken as current. A lagging RPC could answer with an older, balanced holding and no ledger while the event
// scan covers a later ledger holding a direct, unrecorded transfer: the estimate then left that USDC out and still
// gave a number. Both simulations must name a ledger, the same one, at or after the covered ledger.
import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, rpcChainReader, type ChainReader } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, chain } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const zero = () => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("0") }));

/** The real reader over two scripted simulation answers: the token balance, then the three pots. */
function reader(ledgers: (unknown | undefined)[]) {
  const values = [zero(), xdr.ScVal.scvVec([zero(), zero(), zero()])];
  let i = 0;
  return rpcChainReader("https://rpc.example", (async () => {
    const latestLedger = ledgers[i];
    const v = values[i++ % 2];
    return Response.json({ jsonrpc: "2.0", id: 1, result: { ...(latestLedger === undefined ? {} : { latestLedger }), results: [{ xdr: v.toXDR("base64") }] } });
  }) as never);
}

describe("Codex tax R2 #1: a holdings read must name its ledger", () => {
  it("control: two simulations naming the same ledger are read", async () => {
    expect(await reader([6000000, 6000000]).holdings(CONTRACT, TOKENS.usdc)).toEqual({ held: BigInt(0), pots: BigInt(0), ledger: 6000000 });
  });

  it("a simulation answer without a ledger is refused, whichever of the two it is", async () => {
    await expect(reader([undefined, undefined]).holdings(CONTRACT, TOKENS.usdc)).rejects.toThrow(/did not say which ledger/);
    await expect(reader([6000000, undefined]).holdings(CONTRACT, TOKENS.usdc)).rejects.toThrow(/did not say which ledger/);
    await expect(reader([undefined, 6000000]).holdings(CONTRACT, TOKENS.usdc)).rejects.toThrow(/did not say which ledger/);
  });

  it("a ledger that is not a whole positive number is refused", async () => {
    for (const bad of ["6000000", 6000000.5, -1, 0, null]) {
      await expect(reader([bad, bad]).holdings(CONTRACT, TOKENS.usdc)).rejects.toThrow(/did not say which ledger/);
    }
  });

  it("a lagging RPC's balanced holdings with no ledger give no estimate, though the scan covers a later ledger", async () => {
    const base = chain([]);
    const lagging: ChainReader = { ...base, holdings: (async () => ({ held: BigInt(0), pots: BigInt(0) })) as never };
    await expect(readSplitPayments(lagging, want)).rejects.toThrow(/did not say which ledger/);
  });

  it("end to end through the real reader: answers without ledgers give no estimate", async () => {
    const base = chain([]);
    const real = reader([undefined, undefined]);
    await expect(readSplitPayments({ ...base, holdings: (c, t) => real.holdings(c, t) }, want)).rejects.toThrow(/did not say which ledger/);
  });
});
