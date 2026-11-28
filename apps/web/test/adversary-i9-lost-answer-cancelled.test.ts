// Adversary i9. Goal 4 (a person is told something false: "may have gone through" when it cannot have) and
// goal 5 (a control offered that cannot work) on the pay page.
//
// Promise (apps/web/src/app/pay/[split]/[ref]/pay-client.tsx payNow, "Unknown: the chain says whether it
// landed"; contracts/split/README.md: a paid invoice "is Paid for good", `deposit` rejects a cancelled one
// with InvoiceCancelled, `cancel_invoice` rejects a paid one with InvoiceAlreadyPaid). The two states are
// exclusive: an invoice the chain reads as Cancelled was never paid, so a payment whose answer was lost
// cannot have gone through.
//
// payNow() settles a lost answer by reading the chain again. For Paid it says paid. For anything else, a
// Cancelled invoice included, it says "Caracal could not confirm whether the payment went through. Do not
// pay again yet: use "Check again" first." and offers "Check again". The chain has just confirmed it, and
// there is nothing to check again: the freelancer cancelled it, and the same page says "Do not pay it".
//
// The page is rendered with the repo's usual React-state stub (test/pay-page.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { memoryStorage } from "./browser-storage";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function walk(node: unknown, f: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, f));
  if (typeof node !== "object" || node === null) return;
  f(node as El);
  walk((node as El).props?.children, f);
}
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
  });
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };

/** States, in order: view, wallet, pay. The first chain read says `before`, every later one `after`. */
async function render(before: Inv, after: Inv) {
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    const states: unknown[] = [{ kind: "invoice", invoice: before, txHash: null }, PAYER];
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
      // Fixture (Codex invoices R3 #1): a payment now reads the newest ledger first, to fix its last ledger.
      latestLedger: async () => 1000,
      readConfig: async () => ({ owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA" }),
      readInvoice: async () => (reads++ === 0 ? before : after),
      readUsdcBalance: async () => usdc(1000),
      findPaymentTx: async () => null,
      // The answer to the payment is lost (a relayer 504, say).
      payInvoice: async () => ({ kind: "unknown", message: "Relayer request failed with status 504" }),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  // Test change (Codex invoices R4 #2, disclosed in docs/decisions.md): the page is given a working localStorage, as
  // every browser has; it now sends no payment or cancellation whose record storage will not keep.
  vi.stubGlobal("window", { localStorage: memoryStorage().localStorage });
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), setters };
}
const pay = (s: { i: number; v: unknown }[]) => s.filter((x) => x.i === 2).at(-1)?.v as { kind: string; text?: string; checkFirst?: boolean };

const OPEN: Inv = { amount: usdc(150), status: "open" };

describe("a payment whose answer was lost", () => {
  it("control: when the chain still shows the invoice open, the payer is told to check before paying again", async () => {
    const r = await render(OPEN, OPEN);
    await click(r.tree, "Pay")();
    await settle();
    expect(pay(r.setters)).toMatchObject({ kind: "message", checkFirst: true });
    expect(pay(r.setters).text).toMatch(/could not confirm whether the payment went through/);
  });

  it("when the chain now reads the invoice cancelled, the payer is not told it may have gone through", async () => {
    const r = await render(OPEN, { amount: usdc(150), status: "cancelled" });
    await click(r.tree, "Pay")();
    await settle();
    const m = pay(r.setters);
    // A cancelled invoice cannot have been paid (contracts/split deposit: InvoiceCancelled), so nothing is left to confirm.
    expect(m.text ?? "").not.toMatch(/could not confirm whether the payment went through/);
    expect(m.checkFirst).not.toBe(true);
  });
});
