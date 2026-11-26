// The receipt page, rendered as a server component against the real testnet
// answers in test/fixtures/testnet (see receipt.test.ts).
import { readFileSync } from "node:fs";
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContractNotFound } from "../src/lib/relay/policy";
import { SPLIT } from "../src/lib/stellar/config";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const raw = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/testnet/getTransaction-${name}.json`, import.meta.url), "utf8")).result;
const PAYMENT = "7b4c51da532d16c49ff331b808b4decc7e02ddfe9ac0bc6c3d8f0260e48634fb";

type El = { props?: { children?: unknown; href?: string } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (el.props?.href) out.push(`href:${el.props.href}`);
    texts(el.props?.children, out);
  }
  return out;
}
/** The contract instance lookup the page makes, answered with this wasm (or none). */
function splitWasm(wasm: string | null) {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (...keys: import("@stellar/stellar-sdk").xdr.LedgerKey[]) => {
    const { xdr } = await import("@stellar/stellar-sdk");
    if (wasm === null) return { latestLedger: 1, entries: [] };
    const k = keys[0]!;
    const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")), storage: [] });
    const data = new xdr.ContractDataEntry({ ext: new xdr.ExtensionPoint(0), contract: k.contractData().contract(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(), val: xdr.ScVal.scvContractInstance(inst) });
    return { latestLedger: 1, entries: [{ key: k, val: xdr.LedgerEntryData.contractData(data), liveUntilLedgerSeq: 9_999_999 }] };
  }) as never);
}
async function render(hash: string) {
  const { ReceiptBody } = await import("../src/app/receipt/[hash]/receipt-body");
  return texts(await ReceiptBody({ params: Promise.resolve({ hash }) })).join(" | ");
}

describe("receipt page", () => {
  it("the live deposit: amount, invoice, the three parts, who paid the fee, links", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    splitWasm(SPLIT.wasmHash);
    const page = await render(PAYMENT);
    expect(page).toContain("0.01");
    expect(page).toContain("INV-DAY2-2");
    expect(page).toMatch(/Set aside for tax \| 0\.001\s*\|\s+USDC/);
    expect(page).toMatch(/Savings goal \| 0\.0015\s*\|\s+USDC/);
    expect(page).toMatch(/Available to spend \| 0\.0075\s*\|\s+USDC/);
    expect(page).toMatch(/not tax advice/);
    expect(page).toMatch(/paid by the payer/); // this one was not sponsored, and must not claim to be
    expect(page).toContain(`href:https://stellar.expert/explorer/testnet/tx/${PAYMENT}`);
  });

  it("upper-case hash in the link still works", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    splitWasm(SPLIT.wasmHash);
    expect(await render(PAYMENT.toUpperCase())).toContain("INV-DAY2-2");
  });

  it("a split event from a contract that is not Caracal's shows no amounts", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    splitWasm("aa".repeat(32));
    const page = await render(PAYMENT);
    expect(page).toMatch(/not a payment into a Caracal split contract/);
    expect(page).not.toContain("0.0075");
  });

  it("a split contract the RPC cannot return shows no amounts", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    splitWasm(null);
    expect(await render(PAYMENT)).not.toContain("0.0075");
    expect(ContractNotFound).toBeDefined();
  });

  it("a hash the network does not have: says so, mentions the history window, links the explorer", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("notfound"));
    const page = await render("00".repeat(32));
    expect(page).toMatch(/could not find this payment/);
    expect(page).toMatch(/about a week of history/);
    expect(page).toContain("href:https://stellar.expert/explorer/testnet/tx/" + "00".repeat(32));
  });

  it("not a transaction hash at all: no network call, no explorer link", async () => {
    const spy = vi.spyOn(rpc.Server.prototype, "_getTransaction");
    const page = await render("<script>alert(1)</script>");
    expect(spy).not.toHaveBeenCalled();
    expect(page).toMatch(/could not find this payment/);
    expect(page).not.toMatch(/href:/);
  });

  it("the network cannot be reached", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockRejectedValue(new TypeError("fetch failed"));
    expect(await render(PAYMENT)).toMatch(/could not reach the Stellar network/);
  });
});
