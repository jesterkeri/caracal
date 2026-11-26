// The split receipt, read from real testnet answers captured on 2026-11-26
// (test/fixtures/testnet/getTransaction-*.json, raw JSON-RPC results):
// - 7b4c51da: a live 0.01 USDC deposit into split contract CAQ6XR26 for
//   invoice INV-DAY2-2 (README, "Payment arrives"): tax 0.001, goal 0.0015,
//   spend 0.0075; the payer (CLI account) paid its own fee;
// - a186e2af: a wallet deployment through the relay (no split event);
// - notfound: the RPC's answer for a hash it does not have.
import { readFileSync } from "node:fs";
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractNotFound } from "../src/lib/relay/policy";
import { NETWORK, SPLIT } from "../src/lib/stellar/config";
import { formatUsdc, formatXlm, readSplitReceipt, type ReceiptDeps } from "../src/lib/stellar/receipt";

afterEach(() => vi.restoreAllMocks());

const PAYMENT = "7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb";
const DEPLOY = "a186e2af2da95fe8e22c5d24ef2e5bef3cb83fd59fb054626affe4993513320e";
const SPLIT_CONTRACT = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const CLI = "GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX";
const raw = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/testnet/getTransaction-${name}.json`, import.meta.url), "utf8")).result;

/** The SDK's own parsing of a captured RPC answer. */
function deps(name: string, lookupWasm: ReceiptDeps["lookupWasm"] = async () => SPLIT.wasmHash): ReceiptDeps {
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw(name));
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  return { getTransaction: (h) => server.getTransaction(h), lookupWasm, networkPassphrase: NETWORK.passphrase };
}

describe("split receipt from the chain", () => {
  it("the live deposit: exact amounts as the contract recorded them, invoice, payer, owner, fee payer", async () => {
    const lookups: string[] = [];
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", async (id) => (lookups.push(id), SPLIT.wasmHash)));
    expect(r.kind).toBe("found");
    if (r.kind !== "found") return;
    expect(r.ledger).toBe(5923564);
    expect(r.receipts).toEqual([
      { splitContract: SPLIT_CONTRACT, invoiceRef: "INV-DAY2-2", from: CLI, owner: CLI, amount: BigInt(100000), tax: BigInt(10000), goal: BigInt(15000), spend: BigInt(75000) },
    ]);
    expect(lookups).toEqual([SPLIT_CONTRACT]);
    expect(r.feePayer).toBe(CLI); // not sponsored: the CLI account paid its own fee
    expect(r.feeCharged > BigInt(0)).toBe(true);
  });

  it("an event named split from a contract running other code is not a receipt", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", async () => "aa".repeat(32)));
    expect(r.kind).toBe("no-split");
  });

  it("a split contract the RPC cannot return is not confirmed, so no receipt", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", async (id) => {
      throw new ContractNotFound(id);
    }));
    expect(r.kind).toBe("no-split");
  });

  it("an RPC failure while confirming the contract is 'unreachable', not 'no split'", async () => {
    const r = await readSplitReceipt(PAYMENT, deps("7b4c51da", async () => {
      throw new Error("getLedgerEntries did not answer within 20000 ms");
    }));
    expect(r.kind).toBe("unreachable");
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
      lookupWasm: async () => SPLIT.wasmHash,
      networkPassphrase: NETWORK.passphrase,
    });
    expect(r.kind).toBe("unreachable");
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
    const { rpcContractLookup } = await import("../src/lib/relay/wasm-lookup");
    const server = new rpc.Server(NETWORK.rpcUrl);
    const r = await readSplitReceipt(PAYMENT, { getTransaction: (h) => server.getTransaction(h), lookupWasm: rpcContractLookup(NETWORK.rpcUrl).wasm, networkPassphrase: NETWORK.passphrase });
    expect(["found", "not-found"]).toContain(r.kind);
    if (r.kind === "found") expect(r.receipts[0]!.spend).toBe(BigInt(75000));
  }, 30_000);
});
