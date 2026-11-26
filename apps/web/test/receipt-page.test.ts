// The receipt page, rendered as a server component against the real testnet
// answers in test/fixtures/testnet (see receipt.test.ts).
import { readFileSync } from "node:fs";
import { rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

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
async function render(hash: string) {
  const { ReceiptBody } = await import("../src/app/receipt/[hash]/receipt-body");
  return texts(await ReceiptBody({ params: Promise.resolve({ hash }) })).join(" | ");
}

describe("receipt page", () => {
  it("the live deposit: amount, invoice, the three parts, who paid the fee, links", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
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
    expect(await render(PAYMENT.toUpperCase())).toContain("INV-DAY2-2");
  });

  it("a split event from a contract that was not running Caracal's wasm in that transaction shows no amounts", async () => {
    const r = raw("7b4c51da");
    const m = xdr.TransactionMeta.fromXDR(r.resultMetaXdr, "base64");
    for (const op of m.v4().operations())
      for (const c of op.changes()) {
        if (c.switch().name === "ledgerEntryRemoved") continue;
        const d = (c.value() as xdr.LedgerEntry).data();
        if (d.switch().name === "contractData" && d.contractData().val().switch().name === "scvContractInstance")
          d.contractData().val().instance().executable(xdr.ContractExecutable.contractExecutableWasm(Buffer.alloc(32, 0xaa)));
      }
    r.resultMetaXdr = m.toXDR("base64");
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(r);
    const page = await render(PAYMENT);
    expect(page).toMatch(/could not confirm this transaction as a payment into a Caracal split contract/);
    expect(page).not.toContain("0.0075");
  });

  it("the fee line appears once and states the payer paid it (this deposit was not sponsored)", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    const page = await render(PAYMENT);
    expect(page.match(/Network fee/g)?.length).toBe(1);
    expect(page).toMatch(/0\.0138034 XLM, paid by the payer/);
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

describe("rcpt3 follow-ups", () => {
  it("the payer and the freelancer are shown in full, so a look-alike address cannot pass for theirs", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(raw("7b4c51da"));
    const page = await render(PAYMENT);
    expect(page).toContain("GDO5SPZ7UYT3M6S4WQ4SM5UQ7XGKIKTXWMPG2SONWFD2LULZXBEULKGX");
  });
  it("a close time in the future is not believed", async () => {
    const r = raw("7b4c51da");
    r.createdAt = String(Math.floor(Date.now() / 1000) + 30 * 86_400);
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(r);
    expect(await render(PAYMENT)).toMatch(/could not read this transaction's details/);
  });
  it("a status the reader does not know is not stated as a failure", async () => {
    const r = raw("7b4c51da");
    r.status = "PENDING";
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(r);
    expect(await render(PAYMENT)).not.toMatch(/no payment was made/);
  });
  it("the RPC not answering (stellar-sdk's axios error) is still 'could not reach'", async () => {
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockRejectedValue(Object.assign(new Error("fetch failed"), { name: "AxiosError", isAxiosError: true }));
    expect(await render(PAYMENT)).toMatch(/could not reach the Stellar network/);
  });
});
