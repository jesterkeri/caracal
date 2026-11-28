// Adversary i15. Goal 3 (a page tells a payer a payment was not made when that is not known) on the pay page's
// "Check again".
//
// Promise (docs/decisions.md, Codex invoices R3 #1): "'Check again' settles it only when the invoice reads paid or
// cancelled, or open at a ledger past N (readInvoiceAt), and then says the earlier payment can no longer go through."
// The ledger and the status that decide it must come from the same answer: "open at a ledger past N".
//
// checkAgain() (pay-client.tsx) reads the ledger from one request (readInvoiceAt) and the status from a second,
// separate request (reload(), which reads the invoice again). The first answer's invoice is thrown away. The public
// testnet RPC is a pool of nodes that may be a few ledgers apart, so the two answers can disagree: the first, from a
// current node at ledger 1061, says the invoice is PAID (the earlier payment landed at or before ledger 1060); the
// second, from a node that is behind, still says OPEN. The page then takes "ledger 1061 > 1060" from the first and
// "open" from the second, clears the held payment, and tells the payer "The earlier payment did not go through ...
// You can pay now" although the answer it already holds says it did.
//
// Real: the pay page and src/lib/invoices/*; faked: the network reads (as codex-invoices-r3.test.ts), React state.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const HASH = "d".repeat(64);
const PAY_KEY = `caracal.payPending.${SPLIT}.${REF}`;
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };
const OPEN: Inv = { amount: usdc(150), status: "open" };
const PAID: Inv = { amount: usdc(150), status: "paid" };

type El = { props?: { children?: unknown; onClick?: () => unknown; disabled?: boolean } };
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
function button(node: unknown, text: string): El | null {
  let found: El | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el;
  });
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.resetModules();
});

/** The pay page with a payment held back (ledger 1060). `withLedger` answers the ledger read; `reloaded` the page's own re-read. */
async function payPage(kept: Map<string, string>, withLedger: { invoice: Inv; ledger: number }, reloaded: Inv) {
  vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [{ kind: "invoice", invoice: OPEN, txHash: null }, PAYER, { kind: "idle" }, 1060];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : typeof init === "function" ? (init as () => unknown)() : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      latestLedger: async () => 1000,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      readInvoice: async () => reloaded,
      readInvoiceAt: async () => withLedger,
      findPaymentTx: async () => HASH,
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), setters };
}
const lastPay = (s: { i: number; v: unknown }[]) => s.filter((x) => x.i === 2).at(-1)?.v as { kind: string; text?: string };

describe("adversary i15: Check again takes the ledger from one read and the status from another", () => {
  it("control: both reads agree the invoice is open past the held payment's last ledger, so it did not go through", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage(kept, { invoice: OPEN, ledger: 1061 }, OPEN);
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    expect(lastPay(p.setters).text).toMatch(/did not go through, and it can no longer/);
    expect(kept.has(PAY_KEY)).toBe(false);
  });

  it("the read at ledger 1061 says PAID; a second read from a node that is behind says open: it is not told 'did not go through'", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage(kept, { invoice: PAID, ledger: 1061 }, OPEN);
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    const said = lastPay(p.setters);
    // The payer must not be told the payment did not go through, nor that paying again is fine, when the answer
    // the page itself holds (ledger 1061) says the invoice is paid.
    expect(`${said.kind} ${said.text ?? ""}`).not.toMatch(/did not go through|You can pay now/);
  });
});
