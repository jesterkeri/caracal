// Adversary round 3 on the split receipt (eec25e4). Inputs are the real testnet
// answer test/fixtures/testnet/getTransaction-7b4c51da.json (a live 0.01 USDC
// deposit into split contract CAQ6XR26, captured 2026-11-26), altered with the
// stellar-sdk xdr types or by dropping/replacing a field only where the attack
// needs it.
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
const real = () => JSON.parse(readFileSync(new URL("./fixtures/testnet/getTransaction-7b4c51da.json", import.meta.url), "utf8")).result;

function depsFor(rawTx: unknown): ReceiptDeps {
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx as never);
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  return { getTransaction: (h) => server.getTransaction(h), networkPassphrase: NETWORK.passphrase };
}

type El = { type?: unknown; props?: { children?: unknown; className?: string } };
/** The <strong> element after "paid for invoice", as text plus its class, the way a browser would lay it out. */
function findStrong(node: unknown): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = findStrong(n);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const el = node as El;
  if (el.type === "strong") return el;
  return findStrong(el.props?.children);
}
const flat = (n: unknown): string => (Array.isArray(n) ? n.map(flat).join("") : typeof n === "string" || typeof n === "number" ? String(n) : typeof n === "object" && n !== null ? flat((n as El).props?.children) : "");

/** What a reader sees for the invoice: HTML collapses runs of spaces unless the element preserves them. */
async function visibleInvoice(ref: Buffer): Promise<string> {
  const rawTx = real();
  const meta = xdr.TransactionMeta.fromXDR(rawTx.resultMetaXdr, "base64");
  let edited = 0;
  for (const op of meta.v4().operations()) {
    for (const ev of op.events()) {
      const body = ev.body().v0();
      if (body.topics().length !== 2 || body.topics()[0]!.sym().toString() !== "split") continue;
      for (const entry of body.data().map()!) {
        if (entry.key().sym().toString() === "invoice_ref") {
          entry.val(xdr.ScVal.scvBytes(ref));
          edited++;
        }
      }
    }
  }
  expect(edited).toBe(1);
  rawTx.resultMetaXdr = meta.toXDR("base64");
  vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx);
  const { ReceiptBody } = await import("../src/app/receipt/[hash]/receipt-body");
  const strong = findStrong(await ReceiptBody({ params: Promise.resolve({ hash: PAYMENT }) }));
  expect(strong, "a receipt was shown").not.toBeNull();
  const text = flat(strong!.props?.children);
  return /whitespace-pre/.test(strong!.props?.className ?? "") ? text : text.replace(/[ \t\r\n]+/g, " ");
}

describe("receipt attacks, round 3", () => {
  it("an answer whose close time is a number too large for a date is 'unreadable', not a page that crashes while rendering", async () => {
    // 9000000000000000 is a safe integer, so it passes the ledger/close-time check,
    // but times 1000 it is not a valid Date and toISOString() throws a RangeError.
    const rawTx = real();
    rawTx.createdAt = "9000000000000000";
    vi.spyOn(rpc.Server.prototype, "_getTransaction").mockResolvedValue(rawTx);
    const { ReceiptBody } = await import("../src/app/receipt/[hash]/receipt-body");
    // docs/decisions.md 2026-11-26 (adversary rcpt2): "An unreadable close time or ledger ... gives 'could not read this transaction's details', not a crash".
    await expect(ReceiptBody({ params: Promise.resolve({ hash: PAYMENT }) })).resolves.toBeDefined();
  });

  it("an answer with a successful status but no meta is 'unreadable', not 'could not reach the Stellar network'", async () => {
    const rawTx = real();
    delete rawTx.resultMetaXdr;
    const r = await readSplitReceipt(PAYMENT, depsFor(rawTx));
    expect(r.kind, "the network answered; an answer that cannot be read is 'unreadable', and the page says 'could not reach the network' only for 'unreachable'").toBe("unreadable");
  });

  it("two different invoice references that differ only in a run of spaces do not look alike on the page", async () => {
    const two = await visibleInvoice(Buffer.from("INV  1", "latin1"));
    const three = await visibleInvoice(Buffer.from("INV   1", "latin1"));
    expect(two, "references 'INV  1' (2 spaces) and 'INV   1' (3 spaces) are different invoices but the page shows the same text").not.toBe(three);
  });
});
