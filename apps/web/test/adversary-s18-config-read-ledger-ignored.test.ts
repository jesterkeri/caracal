// Adversary s18: the ledger loadSplit reports for what it shows is the POTS read's ledger only, though the
// split's settings (config()) are read by a separate simulation that may be answered at an older ledger.
//
// write-guard.ts header: "A passed record does not let the page act at once: the pots must first be read at a
// ledger past its closeBy". docs/decisions.md, Codex split R4 #2: "`loadSplit` now returns the ledger its answer was
// read at ... and the page offers no write until the pots shown were read at a ledger past every earlier write's
// closeBy", because "a lagging read" of "pots or a split configuration" must not free Withdraw, Move and Change.
//
// loadSplit (src/lib/split/actions.ts) runs readPotsAt and readConfig in parallel as two simulateTransaction calls.
// The soroban RPC is usually several nodes behind one URL, so the two answers can come from nodes at different
// ledgers. loadSplit keeps readPotsAt's `ledger` and drops readConfig's (chain.ts `readConfig` discards it), so the
// page believes the whole answer, config included, was read at the pots' ledger. After an unknown set_split write
// (closeBy = 1500) a config answered at ledger 1000 (before the write could land) is therefore shown as current
// ("New payments split 10% to Tax, 15% to Goal ..." and the placeholders of "Change the split"), with the guard
// satisfied by pots read at 2000, and Withdraw, Move and Change are offered on it.
//
// Real parts: loadSplit with its real readPotsAt, readConfig, walletStatus and readInstanceCode, reading answers
// built with stellar-sdk's own XDR types (the fixtures of test/adversary-s11-empty-code-lookup.test.ts). Only the
// network answers are faked. Nothing is sent.
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { loadSplit } from "../src/lib/split/actions";
import { SPLIT as SPLIT_CFG, TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const BALANCES = "AAAAEAAAAAEAAAADAAAACgAAAAAAAAAAAAAAAAAAJxAAAAAKAAAAAAAAAAAAAAAAAAA6mAAAAAoAAAAAAAAAAAAAAAAAAST4";
const config = xdr.ScVal.scvVec([nativeToScVal(Address.fromString(WALLET)), nativeToScVal(Address.fromString(TOKENS.usdc)), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)]);
const ok = (v: xdr.ScVal, ledger: number) => ({ result: { retval: v, auth: [] }, latestLedger: ledger }) as unknown as rpc.Api.SimulateTransactionResponse;
const wasmInstance = xdr.LedgerEntryData.contractData(
  new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: new Address(SPLIT).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(
      new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT_CFG.wasmHash, "hex")), storage: null }),
    ),
  }),
);

/** balances() is answered at `potsAt`, config() at `configAt` (two nodes behind one RPC URL). Lookups answer at `lookupAt`. */
function network(potsAt: number, configAt: number, lookupAt = 2000) {
  return {
    async simulateTransaction(tx: { operations: { func: xdr.HostFunction }[] }) {
      const fn = tx.operations[0].func.invokeContract().functionName().toString();
      return fn === "balances" ? ok(xdr.ScVal.fromXDR(BALANCES, "base64"), potsAt) : ok(config, configAt);
    },
    async getLedgerEntries() {
      return { entries: [{ liveUntilLedgerSeq: 5000, val: wasmInstance }], latestLedger: lookupAt };
    },
  } as never;
}

describe("adversary s18: the ledger of what loadSplit shows ignores the ledger config() was read at", () => {
  it("control: when pots and config are read at the same ledger, that is the ledger reported", async () => {
    const l = await loadSplit(network(2000, 2000), WALLET);
    expect(l.kind).toBe("present");
    expect(l.kind === "present" && l.ledger).toBe(2000);
  });

  it("control: when the pots were read at the older ledger, the older ledger is reported", async () => {
    const l = await loadSplit(network(1000, 2000), WALLET);
    expect(l.kind === "present" && l.ledger).toBe(1000);
  });

  it("reports no ledger later than the one the settings were read at (a lagging config() read is not 'as of 2000')", async () => {
    const l = await loadSplit(network(2000, 1000), WALLET);
    expect(l.kind).toBe("present");
    if (l.kind !== "present") return;
    // The page treats `ledger` as "everything shown was read at or after this". The settings were read at 1000,
    // before a write with closeBy 1500 could have landed, so a ledger of 2000 here lets stale settings through the
    // page's guard (page.tsx: shownLedger > mustPass). Any later-than-1000 value is the defect; null (unknown)
    // or 1000 is a correct report.
    expect(l.ledger ?? 0).toBeLessThanOrEqual(1000);
  });
});
