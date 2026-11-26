// The split receipt, read from real testnet answers captured on 2026-11-26
// (test/fixtures/testnet/getTransaction-*.json, raw JSON-RPC results):
// - 7b4c51da: a live 0.01 USDC deposit into split contract CAQ6XR26 for
//   invoice INV-DAY2-2 (README, "Payment arrives"): tax 0.001, goal 0.0015,
//   spend 0.0075; the payer (CLI account) paid its own fee;
// - a186e2af: a wallet deployment through the relay (no split event);
// - notfound: the RPC's answer for a hash it does not have.
import { readFileSync } from "node:fs";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK, SPLIT } from "../src/lib/stellar/config";
import { formatUsdc, formatXlm, instanceStates as metaInstances, readSplitReceipt, type ReceiptDeps } from "../src/lib/stellar/receipt";

afterEach(() => vi.restoreAllMocks());

const PAYMENT = "7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb";
const DEPLOY = "a186e2af2da95fe8e22c5d24ef2e5bef3cb83fd59fb054626affe4993513320e";
const SPLIT_CONTRACT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const CLI = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";
const raw = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/testnet/getTransaction-${name}.json`, import.meta.url), "utf8")).result;

/** The SDK's own parsing of a captured RPC answer, optionally with its ledger changes edited. */
function deps(name: string, editMeta?: (m: xdr.TransactionMeta) => void): ReceiptDeps {
  const r = raw(name);
  if (editMeta && r.resultMetaXdr) {
    const m = xdr.TransactionMeta.fromXDR(r.resultMetaXdr, "base64");
    editMeta(m);
    r.resultMetaXdr = m.toXDR("base64");
  }
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(r);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  return { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase };
}
/** Every contract-instance state in the meta, with a way to change its wasm. */
function instanceStates(m: xdr.TransactionMeta) {
  const v4 = m.v4();
  const all = [...v4.txChangesBefore(), ...v4.txChangesAfter(), ...v4.operations().flatMap((o) => o.changes())];
  return all.filter((c) => {
    if (c.switch().name === "ledgerEntryRemoved") return false;
    const d = (c.value() as xdr.LedgerEntry).data();
    return d.switch().name === "contractData" && d.contractData().val().switch().name === "scvContractInstance";
  });
}
const setWasm = (c: xdr.LedgerEntryChange, hex: string) =>
  (c.value() as xdr.LedgerEntry).data().contractData().val().instance().executable(xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hex, "hex")));

describe("split receipt from the chain", () => {
  it("the live deposit: exact amounts as the contract recorded them, invoice, payer, owner, fee payer", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da"));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.ledger).toBe(5923564);
    expect(r.receipts).toEqual([
      { splitContract: SPLIT_CONTRACT, invoiceRef: "INV-DAY2-2", from: CLI, owner: CLI, amount: BigInt(100000), tax: BigInt(10000), goal: BigInt(15000), spend: BigInt(75000) },
    ]);
    expect(r.feePayer).toBe(CLI); // not sponsored: the CLI account paid its own fee
    expect(r.feeCharged).toBe(BigInt(138034)); // Horizon fee_charged for this transaction
  });

  it("the real meta shows the split contract's instance before and after, both on Caracal's wasm", () => {
    const m = xdr.TransactionMeta.fromXDR(raw("7b4c51da").resultMetaXdr, "base64");
    const seen = metaInstances(m).get(SPLIT_CONTRACT);
    expect(seen?.wasms.length).toBeGreaterThanOrEqual(2);
    expect(seen?.before).toBeGreaterThanOrEqual(1);
    expect(seen?.wasms.every((w) => w === SPLIT.wasmHash)).toBe(true);
  });

  it("a contract that switched to Caracal's wasm during the transaction (before: other code) is not a receipt", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", (m) => setWasm(instanceStates(m)[0]!, "ee".repeat(32))));
    expect(r.kind).toBe("no-split");
  });

  it("an event whose contract instance does not appear in the transaction's changes is not a receipt", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", (m) => {
      const v4 = m.v4();
      for (const op of v4.operations()) op.changes(op.changes().filter((c) => !instanceStates(m).includes(c)));
      v4.txChangesBefore(v4.txChangesBefore().filter((c) => !instanceStates(m).includes(c)));
      v4.txChangesAfter(v4.txChangesAfter().filter((c) => !instanceStates(m).includes(c)));
    }));
    expect(r.kind).toBe("no-split");
  });

  it("a transaction with no split event (a wallet deployment)", async () => {
    expect((await readSplitReceipt(DEPLOY, deps("a186e2af"))).kind).toBe("no-split");
  });

  it("a hash the RPC does not have", async () => {
    expect((await readSplitReceipt("00".repeat(32), deps("notfound"))).kind).toBe("not-found");
  });

  it("the RPC cannot be reached", async () => {
    const r = await readSplitReceipt(PAYMENT, {
      getTransaction: async () => {
        throw new TypeError("fetch failed");
      },
      networkPassphrase: NETWORK.passphrase,
    });
    expect(r.kind).toBe("unreachable");
  });

  it("a meta version this reader does not know is 'unreadable', not a crash or a receipt", async () => {
    const d = deps("7b4c51da");
    const parsed = await d.getTransaction(PAYMENT);
    const r = await readSplitReceipt(PAYMENT, {
      getTransaction: async () => ({ ...parsed, resultMetaXdr: new (xdr.TransactionMeta as unknown as new (s: number, v: unknown) => xdr.TransactionMeta)(0, []) }) as never,
      networkPassphrase: NETWORK.passphrase,
    });
    expect(r.kind).toBe("unreadable");
  });
});

describe("amounts", () => {
  it.each([
    [BigInt(100000), "0.01"],
    [BigInt(10000), "0.001"],
    [BigInt(15000), "0.0015"],
    [BigInt(75000), "0.0075"],
    [BigInt(1_000_000_000), "100.00"],
    [BigInt(12_345_678_901_234), "1,234,567.8901234"],
    [BigInt(1), "0.0000001"],
    [BigInt(0), "0.00"],
  ])("%s units of USDC is %s", (u, s) => expect(formatUsdc(u)).toBe(s));
  it("XLM fees are exact", () => {
    expect(formatXlm(BigInt(100))).toBe("0.00001");
    expect(formatXlm(BigInt(10_000_000))).toBe("1");
  });
});

// Hits the real testnet RPC. Run with CARACAL_NETWORK_TESTS=1. The deposit
// leaves the RPC's history window about a week after 2026-11-25; then this
// expects the honest "not-found".
describe.runIf(process.env.CARACAL_NETWORK_TESTS === "1")("split receipt on testnet", () => {
  it("reads the live deposit, or says the RPC no longer has it", async () => {
    const server = new rpc.Server(NETWORK.rpcUrl);
    const r = await readSplitReceipt(PAYMENT, { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase });
    expect(["found", "not-found"]).toContain(r.kind);
    if (r.kind === "found") expect(r.receipts[0]!.spend).toBe(BigInt(75000));
  }, 30_000);
});

describe("rcpt2 follow-ups", () => {
  it("an RPC answer without the events field: the events are read from the meta, so the real deposit is still found", async () => {
    const r = raw("7b4c51da");
    delete r.events;
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(r);
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    const got = await readSplitReceipt(PAYMENT, { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase });
    expect(got.kind).toBe("found");
  });
});
