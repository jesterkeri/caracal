// Adversary t9: the split contract's USDC balance and its pots are read by two separate simulations
// (chain-payments.ts rpcChainReader.holdings: `balance` of the token, then `balances()` of the contract), and each
// answer names its own ledger. Nothing requires the two to be the same ledger. If the owner withdraws between them,
// the token balance is read BEFORE the withdraw and the pots AFTER it, so held > pots although no USDC ever arrived
// unrecorded. The read then refuses with "some USDC arrived that was never recorded as a payment", which is false.
//
// Promise broken (docs/decisions.md, 2026-11-27 "Tax page fixes" (1)): a split USDC balance above the sum of its
// pots refuses "because Caracal cannot tell what reconciled or unrecorded USDC was". Here there is none: the history
// is held = pots = 1000 at ledger 6000001, then the owner withdraws 500, held = pots = 500 from ledger 6000002 on.
//
// The chain is the repo's t1 harness (answers in the real RPC shapes); only the two holdings simulations come from the
// real rpcChainReader, answered by a fake fetch in the real simulateTransaction shape. No network.
import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SPLIT, TOKENS } from "../src/lib/stellar/config";
import { readSplitPayments, rpcChainReader, type ChainReader } from "../src/lib/tax/chain-payments";
import { CONTRACT, WALLET, chain } from "./adversary-t1-harness";

const want = { contract: CONTRACT, owner: WALLET, token: TOKENS.usdc, wasmHash: SPLIT.wasmHash };
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const pots = (total: bigint) => xdr.ScVal.scvVec([i128(total), i128(BigInt(0)), i128(BigInt(0))]);

type Answer = { ledger: number; value: xdr.ScVal };

/** The chain's events come from the harness; the holdings come from the real reader over scripted simulation answers. */
function withScriptedSimulations(answers: Answer[]): ChainReader {
  const queue = [...answers];
  const real = rpcChainReader("https://rpc.example", (async () => {
    const a = queue.shift();
    if (!a) throw new Error("the read asked for more simulations than the script has");
    return Response.json({ jsonrpc: "2.0", id: 1, result: { latestLedger: a.ledger, results: [{ xdr: a.value.toXDR("base64") }] } });
  }) as never);
  return { ...chain([]), holdings: (contract, token) => real.holdings(contract, token) };
}

describe("the token balance and the pots are one consistent reading", () => {
  it("control: both simulations at the same ledger, balanced, are read", async () => {
    const reader = withScriptedSimulations([
      { ledger: 6_000_002, value: i128(BigInt(500)) },
      { ledger: 6_000_002, value: pots(BigInt(500)) },
    ]);
    const r = await readSplitPayments(reader, want);
    expect(r.kind).toBe("read");
  });

  it("control: real unrecorded USDC (held above pots at one ledger) still refuses", async () => {
    const reader = withScriptedSimulations([
      { ledger: 6_000_002, value: i128(BigInt(501)) },
      { ledger: 6_000_002, value: pots(BigInt(500)) },
    ]);
    await expect(readSplitPayments(reader, want)).rejects.toThrow(/more USDC than its tax, goal and spend pots/);
  });

  it("an owner withdrawal between the two simulations is not unrecorded USDC", async () => {
    // First holdings read: the token balance at ledger 6000001 (1000, before the withdraw of 500), then the pots at
    // ledger 6000002 (500, after it). Every later simulation is at ledger 6000002, where held = pots = 500.
    const reader = withScriptedSimulations([
      { ledger: 6_000_001, value: i128(BigInt(1000)) },
      { ledger: 6_000_002, value: pots(BigInt(500)) },
      { ledger: 6_000_002, value: i128(BigInt(500)) },
      { ledger: 6_000_002, value: pots(BigInt(500)) },
    ]);
    // No unrecorded USDC exists at any ledger in this history, so the read must not say there is: it may repeat
    // the read and succeed, but it must not refuse for USDC that "arrived without a recorded payment".
    const outcome = await readSplitPayments(reader, want).then(
      (r) => ({ ok: true as const, kind: r.kind }),
      (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }),
    );
    expect(outcome).toEqual({ ok: true, kind: "read" });
  });
});
