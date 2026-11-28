// Adversary s11: an EMPTY answer to the split's code lookup is called proof that the contract is not Caracal's.
//
// loadSplit (src/lib/split/actions.ts) first looks the split's instance entry up (walletStatus) and, if it is
// live, looks it up a second time to read the wasm hash (readInstanceCode, src/lib/split/verify.ts). When that
// second answer is `entries: []`, readInstanceCode returns { kind: "absent" } and loadSplit says:
//   "The contract at your split address does not run Caracal's split code, so Caracal will not show its
//    balances or use it."
// But the entry was found a moment earlier by the first lookup, so an empty second answer proves nothing about
// the code: it is an RPC that has not caught up (a node behind a load balancer, right after a deployment) or
// one that left the entry out. Nothing usable was returned.
//
// Spec:
// - attacker goal 4: "a wrong cause for a failure".
// - docs/decisions.md 2026-11-27 (Codex split R1, loadSplit): "A lookup that fails, times out (15 s) or
//   returns nothing usable says 'could not check' and shows nothing; it is never a pass."
// - src/lib/split/verify.ts: `unchecked` is "the lookup failed, timed out or returned something unreadable".
// - docs/decisions.md 2026-11-27 (Day1 merge, Codex R6 #2): "An empty getLedgerEntries answer is 'not-found',
//   never proof" (written for wallets; the same reasoning applies to the split's own lookup).
//
// Real parts: loadSplit with its real readPots, readConfig, walletStatus and readInstanceCode, reading answers
// built with stellar-sdk's own XDR types (the same fixtures as test/codex-split-r1.test.ts).
import { Address, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { loadSplit } from "../src/lib/split/actions";
import { SPLIT as SPLIT_CFG, TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

const SPLIT = splitAddressFor(WALLET);
const BALANCES = "AAAAEAAAAAEAAAADAAAACgAAAAAAAAAAAAAAAAAAJxAAAAAKAAAAAAAAAAAAAAAAAAA6mAAAAAoAAAAAAAAAAAAAAAAAAST4";
const config = xdr.ScVal.scvVec([nativeToScVal(Address.fromString(WALLET)), nativeToScVal(Address.fromString(TOKENS.usdc)), xdr.ScVal.scvU32(1000), xdr.ScVal.scvU32(1500)]);
const ok = (v: xdr.ScVal) => ({ result: { retval: v, auth: [] }, latestLedger: 1 }) as unknown as rpc.Api.SimulateTransactionResponse;
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

/** The first lookup (does it exist?) finds a live entry; the second (which code?) answers with `second`. */
function network(second: () => { val?: xdr.LedgerEntryData }[]) {
  let first = true;
  return {
    async simulateTransaction(tx: { operations: { func: xdr.HostFunction }[] }) {
      const fn = tx.operations[0].func.invokeContract().functionName().toString();
      return fn === "balances" ? ok(xdr.ScVal.fromXDR(BALANCES, "base64")) : ok(config);
    },
    async getLedgerEntries() {
      if (first) {
        first = false;
        return { entries: [{ liveUntilLedgerSeq: 500 }], latestLedger: 100 };
      }
      return { entries: second(), latestLedger: 100 };
    },
  } as never;
}

describe("adversary s11: the split's code lookup answers with no entry after the existence lookup found one", () => {
  it("control: when the second lookup returns the split's instance, the split is shown", async () => {
    const l = await loadSplit(network(() => [{ val: wasmInstance }]), WALLET);
    expect(l.kind).toBe("present");
  });

  it("control: an unreadable second answer is 'could not check' (the harness reads the message)", async () => {
    const l = await loadSplit(network(() => [{}]), WALLET);
    expect(l.kind === "error" && l.message).toMatch(/could not check/);
  });

  it("an empty second answer is 'could not check', not a claim that the contract runs other code", async () => {
    const l = await loadSplit(network(() => []), WALLET);
    expect(l.kind).toBe("error");
    const message = l.kind === "error" ? l.message : "";
    // Defect: "The contract at your split address does not run Caracal's split code, so Caracal will not show
    // its balances or use it." A lagging RPC node is blamed on the person's contract.
    expect(message).not.toMatch(/does not run Caracal's split code/);
    expect(message).toMatch(/could not check/);
  });
});
