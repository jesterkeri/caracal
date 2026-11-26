// Adversary round 2 on the split receipt (cfb085f). Inputs are the real testnet
// answer test/fixtures/testnet/getTransaction-7b4c51da.json (a live 0.01 USDC
// deposit into split contract CAQ6XR26, captured 2026-11-26), altered with the
// stellar-sdk xdr types only where the attack needs it.
import { readFileSync } from "node:fs";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK } from "../src/lib/stellar/config";
import { readSplitReceipt, type ReceiptDeps } from "../src/lib/stellar/receipt";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const PAYMENT = "7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb";
const SPLIT_CONTRACT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const real = () => JSON.parse(readFileSync(new URL("./fixtures/testnet/getTransaction-7b4c51da.json", import.meta.url), "utf8")).result;

function depsFor(rawTx: unknown): ReceiptDeps {
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx as never);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  return { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase };
}

const isSplitInstance = (c: xdr.LedgerEntryChange) => {
  if (c.switch().name === "ledgerEntryRemoved") return false;
  const cd = (c.value() as xdr.LedgerEntry).data();
  return cd.switch().name === "contractData" && cd.contractData().key().switch().name === "scvLedgerKeyContractInstance";
};

describe("receipt attacks, round 2", () => {
  it("a contract created in this transaction (deployed as other code, forged the event, upgraded itself to Caracal's wasm) is not a Caracal split receipt", async () => {
    // A look-alike deployed in the same transaction and upgraded to Caracal's
    // wasm before it ends leaves ONE ledger change for its instance: "created",
    // with the final wasm. There is no "before" state, so a reader that only
    // checks the states it can see sees only Caracal's wasm, although the event
    // was emitted by other code. Same real deposit, with the split contract's
    // instance changes rewritten that way (state dropped, updated -> created).
    const rawTx = real();
    const meta = xdr.TransactionMeta.fromXDR(rawTx.resultMetaXdr, "base64");
    let rewritten = 0;
    for (const op of meta.v4().operations()) {
      const next: xdr.LedgerEntryChange[] = [];
      for (const c of op.changes()) {
        if (isSplitInstance(c) && c.switch().name === "ledgerEntryState") continue;
        if (isSplitInstance(c) && c.switch().name === "ledgerEntryUpdated") {
          next.push(xdr.LedgerEntryChange.ledgerEntryCreated(c.value() as xdr.LedgerEntry));
          rewritten++;
        } else next.push(c);
      }
      op.changes(next);
    }
    expect(rewritten).toBe(1);
    rawTx.resultMetaXdr = meta.toXDR("base64");

    const r = await readSplitReceipt(PAYMENT, depsFor(rawTx));
    expect(r.kind, `an event from ${SPLIT_CONTRACT} whose instance was created inside this transaction, with no earlier state, does not show that it ran Caracal's split code when it emitted`).toBe("no-split");
  });

  it("an answer whose ledger close time cannot be read gives 'unreadable', not a page that crashes while rendering", async () => {
    const rawTx = real();
    rawTx.createdAt = "not-a-time";
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx);
    const { ReceiptBody } = await import("../src/app/receipt/[hash]/receipt-body");
    // docs/decisions.md 2026-11-26: "Data the RPC returns that cannot be read gives 'could not read this transaction's details' instead of a crash."
    await expect(ReceiptBody({ params: Promise.resolve({ hash: PAYMENT }) })).resolves.toBeDefined();
    const out = await ReceiptBody({ params: Promise.resolve({ hash: PAYMENT }) });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("an answer the SDK cannot parse is 'unreadable', not 'could not reach the Stellar network'", async () => {
    // A meta version this build of the SDK does not know (here 9): the RPC
    // answered, so telling the reader "reload to try again" is false.
    const rawTx = real();
    rawTx.resultMetaXdr = Buffer.from([0, 0, 0, 9, 0, 0, 0, 0]).toString("base64");
    const r = await readSplitReceipt(PAYMENT, depsFor(rawTx));
    expect(r.kind, "the network answered; data that cannot be read is 'unreadable', and the page says 'could not reach the network' only for 'unreachable'").toBe("unreadable");
  });
});
