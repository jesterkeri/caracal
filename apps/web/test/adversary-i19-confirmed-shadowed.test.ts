// Adversary i19. Goal 3 (a page shows an invoice as open, with its pay link and Cancel, when this browser itself
// knows the invoice is cancelled), across tabs.
//
// Promise (docs/decisions.md, adversary i17 row and apps/web/src/app/invoices/page.tsx, CONFIRMED_KEY and heldNow()):
// "Invoices whose opening or cancelling this browser saw confirmed ... A read right after (an RPC node a ledger
// behind) can still show the invoice ... open; the row then says what was confirmed and offers neither its pay link
// nor Cancel." The record is kept in localStorage so that it covers the whole browser, other tabs included.
//
// Defect: confirmedOf() answers from the tab's in-memory Map as soon as it holds ANY value for the invoice, and
// setConfirmed(ref, null), called when a list read first agrees with a confirmed "opened", stores null there. From
// then on this tab never looks at localStorage again for that invoice. So when another tab of the same browser
// cancels the invoice (it writes "cancelled" to localStorage and says "Invoice cancelled. Its pay link no longer
// works."), this tab, which saw the invoice open earlier, keeps drawing the row as "Open, waiting for payment" with
// its pay link, "Copy pay link" and "Cancel invoice", and a list read by a node that is a ledger behind keeps it so.
// A tab that never saw the invoice caught up shows it as cancelled. The invoice's status in the chain is not
// changed by any of this; the contract refuses a payment on a cancelled invoice, so the harm is a dead pay link
// shared, not money.
//
// Real: the invoices page and src/lib/invoices/*; faked: the network calls, React state (a small stateful hook
// store, as adversary i17), localStorage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CONFIRMED_KEY = "caracal.invoiceConfirmed";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

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

const hook = { i: 0 };
function statefulReact(initial: unknown[]) {
  const slots: unknown[] = [...initial];
  hook.i = 0;
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = hook.i++;
        if (!(at in slots) || slots[at] === undefined) slots[at] = typeof init === "function" ? (init as () => unknown)() : init;
        return [slots[at], (v: unknown) => void (slots[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[at]) : v)];
      },
      useEffect: () => {},
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.doUnmock("@/lib/invoices/details");
  vi.doUnmock("@/lib/invoices/rows");
  vi.doUnmock("@/lib/auth/wallet-binding");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
});

/** The invoice reads open at ledger 1000: what a node a ledger behind says right after another tab cancelled it. */
const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000 }) as Row;

async function invoicesPage(store: Map<string, string>) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  statefulReact([{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [openRow()] }]);
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    // The cancellation this tab presses is refused before sending (nothing changes); it is only a way to make the page read the list.
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: async () => ({ kind: "not-sent", message: "The network refused the call when it was tried." }) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [openRow()] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { draw: () => ((hook.i = 0), mod.default()) };
}

/** What setConfirmed() writes: { ref: "opened" | "cancelled" } as JSON. */
const confirmed = (what: "opened" | "cancelled") => JSON.stringify({ [REF]: what });

describe("adversary i19: a cancellation another tab confirmed", () => {
  it("control: a tab that never saw the invoice caught up draws it as cancelled, with no pay link and no Cancel", async () => {
    // Another tab of this browser cancelled the invoice and wrote it down; this tab's list is a ledger behind.
    const p = await invoicesPage(new Map([[CONFIRMED_KEY, confirmed("cancelled")]]));
    const tree = p.draw();
    expect(texts(tree)).toContain("Cancelled. The network has not shown it yet");
    expect(texts(tree)).not.toContain("Copy pay link");
    expect(button(tree, "Cancel invoice")).toBeNull();
  });

  it("a tab that saw the invoice caught up earlier still draws it as cancelled once another tab confirms the cancellation", async () => {
    const store = new Map([[CONFIRMED_KEY, confirmed("opened")]]);
    const p = await invoicesPage(store);
    // This tab opened the invoice earlier ("opened" is recorded); its list read now agrees, so the record is dropped.
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(store.has(CONFIRMED_KEY) && store.get(CONFIRMED_KEY)!.includes(REF)).toBe(false);
    // Another tab cancels the invoice: "Invoice cancelled. Its pay link no longer works." is said there.
    store.set(CONFIRMED_KEY, confirmed("cancelled"));
    const tree = p.draw();
    expect(texts(tree)).not.toContain("Open, waiting for payment");
    expect(texts(tree)).not.toContain("Copy pay link");
    expect(button(tree, "Cancel invoice")).toBeNull();
    expect(texts(tree)).toContain("Cancelled. The network has not shown it yet");
  });

  it("and a list read by a node a ledger behind does not put the open row back either", async () => {
    const store = new Map([[CONFIRMED_KEY, confirmed("opened")]]);
    const p = await invoicesPage(store);
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    store.set(CONFIRMED_KEY, confirmed("cancelled"));
    // Any action that reads the list again (here a second press that is refused before sending) redraws from a lagging read.
    await button(p.draw(), "Cancel invoice")?.props?.onClick?.();
    await settle();
    const tree = p.draw();
    expect(texts(tree)).not.toContain("Copy pay link");
    expect(texts(tree)).toContain("Cancelled. The network has not shown it yet");
  });
});
