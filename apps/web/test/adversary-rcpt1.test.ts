// Adversary attacks on the split receipt (da980ee). Inputs are the real testnet
// answer test/fixtures/testnet/getTransaction-7b4c51da.json (a live 0.01 USDC
// deposit into split contract CAQ6XR26, captured 2026-11-26), altered with the
// stellar-sdk xdr types only where the attack needs it.
import { readFileSync } from "node:fs";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK, SPLIT } from "../src/lib/stellar/config";
import { readSplitReceipt, type ReceiptDeps } from "../src/lib/stellar/receipt";

afterEach(() => vi.restoreAllMocks());

const PAYMENT = "7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb";
const real = () => JSON.parse(readFileSync(new URL("./fixtures/testnet/getTransaction-7b4c51da.json", import.meta.url), "utf8")).result;

// Harness note (2026-11-26): the reader no longer takes a wasm lookup (the fix
// reads the wasm from the transaction itself), so the second argument is ignored.
function depsFor(rawTx: unknown, _lookupWasm?: unknown): ReceiptDeps {
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx as never);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  return { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase };
}

describe("receipt attacks", () => {
  it("a contract that ran other code in this transaction and runs Caracal's wasm only today is not a Caracal split receipt", async () => {
    // The contract at the event's address is told, by the transaction's own
    // ledger changes, to have run the wasm EVIL when the event was emitted. Today
    // it runs Caracal's split wasm (an upgradeable contract can swap to it after
    // forging an event). The doc comment's "its wasm today is its wasm then" holds
    // only for a genuine split contract, not for a look-alike that upgraded.
    const evil = Buffer.from("ee".repeat(32), "hex");
    const rawTx = real();
    const meta = xdr.TransactionMeta.fromXDR(rawTx.resultMetaXdr, "base64");
    let swapped = 0;
    for (const op of meta.v4().operations()) {
      for (const c of op.changes()) {
        const entry = (c as unknown as { value(): xdr.LedgerEntry | xdr.LedgerKey }).value();
        if (!("data" in entry)) continue;
        const d = (entry as xdr.LedgerEntry).data();
        if (d.switch().name !== "contractData") continue;
        const val = d.contractData().val();
        if (val.switch().name !== "scvContractInstance") continue;
        val.instance().executable(xdr.ContractExecutable.contractExecutableWasm(evil));
        swapped++;
      }
    }
    expect(swapped).toBeGreaterThan(0); // the fixture's meta does carry the instance entry
    rawTx.resultMetaXdr = meta.toXDR("base64");

    const r = await readSplitReceipt(PAYMENT, depsFor(rawTx, async () => SPLIT.wasmHash));
    expect(r.kind, "a payment emitted by a contract that was not running Caracal's split wasm at that ledger must not be shown as a Caracal split receipt").toBe("no-split");
  });

  it("the payer who paid their own fee through a muxed source account is not told the network fee was none for them", async () => {
    // Same real transaction, but its source is the payer's account as a muxed
    // (M...) address. The fee payer is still that account.
    const rawTx = real();
    const env = xdr.TransactionEnvelope.fromXDR(rawTx.envelopeXdr, "base64");
    const tx = env.v1().tx();
    const key = tx.sourceAccount().ed25519();
    tx.sourceAccount(xdr.MuxedAccount.keyTypeMuxedEd25519(new xdr.MuxedAccountMed25519({ id: xdr.Uint64.fromString("7"), ed25519: key })));
    rawTx.envelopeXdr = env.toXDR("base64");

    const r = await readSplitReceipt(PAYMENT, depsFor(rawTx, async () => SPLIT.wasmHash));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    // (2026-11-26) The precondition "feePayer starts with M" was removed: it
    // contradicts the assertion below under any fix (an M... value can never
    // equal the G... payer). The transaction source is still muxed above.
    const payer = r.receipts[0]!.from;
    // receipt-body.tsx prints "paid by the payer" only when feePayer === from.
    expect(r.feePayer === payer, "the payer's own (muxed) source account paid the fee, so it is the payer").toBe(true);
  });
});
