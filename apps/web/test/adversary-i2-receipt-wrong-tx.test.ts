// Adversary i2: after a payment whose answer was lost, the pay page links the
// receipt to the transaction the payer SENT, not to the one the chain says paid
// the invoice. When a colleague (or the same client in another tab) paid the
// invoice first and this payer's transaction timed out and then failed, the
// page says "This invoice is paid. View the receipt" and the link opens the
// payer's own failed transaction.
//
// Spec: apps/web/src/lib/invoices/chain.ts findPaymentTx ("The transaction that
// paid `ref`, found in the contract's `split` events") and
// contracts/split/README.md Invoices ("Anyone may pay it, so a client's
// colleague can settle it"). Goal 4: a receipt link to the wrong transaction.
// Cause: pay-client.tsx payNow(), the unknown branch:
//   setPay({ kind: "paid", hash: outcome.hash ?? after.txHash })
// prefers the sent hash over the event-proven one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const SENT_BY_THIS_PAYER = "a".repeat(64);
const THAT_PAID_THE_INVOICE = "b".repeat(64);
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || n === null) return;
    const el = n as El;
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
    walk(el.props?.children);
  };
  walk(node);
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

/** The pay page with a wallet connected; the chain says open before paying and paid after, with `eventTx` as the paying transaction. */
async function payWithLostAnswer(sentHash: string | undefined, eventTx: string) {
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [{ kind: "invoice", invoice: { amount: usdc(150), status: "open" }, txHash: null }, PAYER];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => {},
    };
  });
  let reads = 0;
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }),
      readInvoice: async () => ({ amount: usdc(150), status: reads++ === 0 ? "open" : "paid" }),
      readUsdcBalance: async () => usdc(1000),
      findPaymentTx: async () => eventTx,
      // "Transaction confirmation timed out", with the hash the payer's own transaction had.
      payInvoice: async () => ({ kind: "unknown", message: "Transaction confirmation timed out", hash: sentHash }),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  const tree = mod.default({ split: SPLIT, invoiceRef: REF });
  await click(tree, "Pay")();
  await new Promise((r) => setTimeout(r, 10));
  return setters.filter((s) => s.i === 2).at(-1)?.v as { kind: string; hash?: string | null };
}

describe("the receipt link after a lost answer", () => {
  it("control: when the payer's own transaction is the one that paid, the link is that transaction", async () => {
    expect(await payWithLostAnswer(SENT_BY_THIS_PAYER, SENT_BY_THIS_PAYER)).toMatchObject({ kind: "paid", hash: SENT_BY_THIS_PAYER });
  });
  it("when the events show another transaction paid the invoice, the link is that one, not the payer's sent hash", async () => {
    const shown = await payWithLostAnswer(SENT_BY_THIS_PAYER, THAT_PAID_THE_INVOICE);
    expect(shown.kind).toBe("paid");
    expect(shown.hash).toBe(THAT_PAID_THE_INVOICE);
  });
});
