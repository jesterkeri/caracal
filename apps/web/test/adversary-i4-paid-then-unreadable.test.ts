// Adversary i4. Promise (pay-client.tsx payNow; chain.ts WriteOutcome "done": "Landed and succeeded"): a payer
// whose payment landed is told it is paid (pay page copy "This invoice is paid. View the receipt"). Goal 4/5:
// a person is told the truth about money and is not left without an answer.
//
// After a "done" outcome the page sets pay = paid and then reloads the invoice (reload().then(setView)).
// The "This invoice is paid" line and the receipt link render only inside the view.kind === "invoice"
// branch. If that reload cannot read the chain (a flaky RPC right after the payment, a 20 s read limit), the
// view becomes { kind: "error" }, the page shows only "could not reach the Stellar network to read this
// invoice ... reload the page", and the payer, whose money has moved and whose transaction hash the page
// holds, is never told the payment went through and gets no receipt link.
//
// The same React-state stub as pay-page.test.ts; the chain functions are replaced (the second invoice read
// fails, as when the network drops after the payment).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import { memoryStorage } from "./browser-storage";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const HASH = "d".repeat(64);

type El = { props?: { children?: unknown; onClick?: () => unknown; href?: string } };
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
const hrefs = (node: unknown) => {
  const out: string[] = [];
  walk(node, (el) => void (el.props?.href && out.push(el.props.href)));
  return out;
};
const settle = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

/** `readsAfterPay`: what the invoice reads after the payment give: the chain's answer, or "down". */
async function render(states: unknown[], readsAfterPay: "paid" | "down") {
  const setters: { i: number; v: unknown }[] = [];
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
  let invoiceReads = 0;
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      // Fixture (Codex invoices R3 #1): a payment now reads the newest ledger first, to fix its last ledger.
      latestLedger: async () => 1000,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      // read 1: payNow's fresh read (open). read 2: the reload after the payment landed.
      readInvoice: async () => {
        if (invoiceReads++ === 0) return { amount: BigInt(1_500_000_000), status: "open" };
        if (readsAfterPay === "down") throw new Error("fetch failed");
        return { amount: BigInt(1_500_000_000), status: "paid" };
      },
      readUsdcBalance: async () => BigInt(10_000_000_000),
      findPaymentTx: async () => HASH,
      payInvoice: async () => ({ kind: "done", hash: HASH }),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Test change (Codex invoices R4 #2, disclosed in docs/decisions.md): the page is given a working localStorage, as
  // every browser has; it now sends no payment or cancellation whose record storage will not keep.
  vi.stubGlobal("window", { localStorage: memoryStorage().localStorage });
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;
const open = { kind: "invoice", invoice: { amount: BigInt(1_500_000_000), status: "open" }, txHash: null };

/** Pays, then renders the page again in the state the person is left in (view, wallet, pay). */
async function afterPaying(readsAfterPay: "paid" | "down") {
  const r = await render([open, PAYER], readsAfterPay);
  await click(r.tree, "Pay")();
  await settle();
  const view = last(r.setters, 0);
  const pay = last(r.setters, 2);
  vi.resetModules();
  const again = await render([view, PAYER, pay], readsAfterPay);
  return { pay, view, tree: again.tree };
}

describe("a payment that landed, then a read of the chain that fails", () => {
  it("control: when the chain can be read after the payment, the page says paid and links the receipt", async () => {
    const r = await afterPaying("paid");
    expect(r.pay).toMatchObject({ kind: "paid", hash: HASH });
    expect(texts(r.tree)).toContain("This invoice is paid");
    expect(hrefs(r.tree)).toContain(`/receipt/${HASH}`);
  });

  it("the payer is still told it is paid, with the receipt for the transaction the page holds, when that read fails", async () => {
    const r = await afterPaying("down");
    // The page knows the payment landed (it holds the hash)...
    expect(r.pay).toMatchObject({ kind: "paid", hash: HASH });
    // ...so the person must be told, not left with only "could not reach the network".
    expect(texts(r.tree), texts(r.tree)).toContain("This invoice is paid");
    expect(hrefs(r.tree)).toContain(`/receipt/${HASH}`);
  });
});
