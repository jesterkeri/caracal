// Adversary i17. Goal 3 (a page shows an invoice as open and offers its pay link and Cancel when the page itself
// knows the invoice is cancelled, or that a cancellation may still land).
//
// Promise (docs/decisions.md, Codex invoices R3 #2 and adversary i16; header of apps/web/src/app/invoices/page.tsx,
// shown() and heldNow()): a row whose cancellation is confirmed, or whose cancellation's answer was lost, "offers
// neither its pay link nor Cancel" until a read agrees; i16 made that hold apply "as it is drawn", so a failed list
// refresh cannot leave the old row open.
//
// Two holes, both on the invoices page after a cancellation:
//  (1) The cancellation is confirmed ("Invoice cancelled. Its pay link no longer works.") and the list refresh that
//      follows fails (a network blip). heldNow() looks only at the pending-cancel record, never at the confirmed
//      record that cancel() has just written, so the old row stays drawn as "Open, waiting for payment" with its pay
//      link, "Copy pay link" and "Cancel invoice", under a notice that says it is cancelled.
//  (2) The cancellation's answer is lost and localStorage refuses writes (blocked, or full). The pending-cancel
//      record has no in-memory copy (the opening record and the pay page's pending payment both have one), so the
//      row after the refresh is open with its pay link and Cancel while the cancellation may still land.
//
// Real: the invoices page and src/lib/invoices/*; faked: the network calls, React state (a small stateful hook
// store, so the page can be drawn again after the press), localStorage.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
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

// A stateful useState: each call gets the next slot; a setter writes the slot; draw() is a fresh render.
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

const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000 }) as Row;

/** The page with one open invoice drawn; `outcome` is what cancelInvoice answers, `refresh` what the next list read does. */
async function invoicesPage(opts: { storage: Map<string, string> | "blocked"; outcome: unknown; refresh: "fails" | "lags"; onCancel?: () => void }) {
  const store = opts.storage;
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test" },
    localStorage: {
      getItem: (k: string) => (store === "blocked" ? null : (store.get(k) ?? null)),
      setItem: (k: string, v: string) => {
        if (store === "blocked") throw new Error("QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => {
        if (store !== "blocked") store.delete(k);
      },
    },
  });
  statefulReact([{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [openRow()] }]);
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: async () => (opts.onCancel?.(), opts.outcome) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({
    ...(await vi.importActual<object>("../src/lib/invoices/rows")),
    // "lags": the read succeeds but the node has not caught up (the invoice still reads open at ledger 1000).
    loadRows: async () => {
      if (opts.refresh === "fails") throw new Error("The Stellar network did not answer within 20 s");
      return [openRow()];
    },
  }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  // Each draw is a render: the hook counter restarts.
  return { draw: () => ((hook.i = 0), mod.default()) };
}

const DONE = { kind: "done", hash: "d".repeat(64) };
const LOST = { kind: "unknown", message: "Sending it did not answer within 300 s" };

describe("adversary i17: the row after a cancellation", () => {
  it("control: a confirmed cancellation whose list read succeeds but lags is drawn as cancelled, with no pay link and no Cancel", async () => {
    const p = await invoicesPage({ storage: new Map(), outcome: DONE, refresh: "lags" });
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    const tree = p.draw();
    expect(texts(tree)).toContain("Invoice cancelled");
    expect(texts(tree)).not.toContain("Copy pay link");
    expect(button(tree, "Cancel invoice")).toBeNull();
  });

  it("a confirmed cancellation whose list refresh fails does not leave the row open, with its pay link and Cancel", async () => {
    const p = await invoicesPage({ storage: new Map(), outcome: DONE, refresh: "fails" });
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    const tree = p.draw();
    const said = texts(tree);
    // The page itself says it was cancelled and the list could not be refreshed ...
    expect(said).toContain("Invoice cancelled. Its pay link no longer works.");
    expect(said).toContain("could not be refreshed");
    // ... so the row must not still say Open and offer the dead pay link to share or Cancel again.
    expect(said).not.toContain("Open, waiting for payment");
    expect(said).not.toContain("Copy pay link");
    expect(button(tree, "Cancel invoice")).toBeNull();
  });

  it("control: a lost cancellation with working storage holds the row (no pay link, no Cancel)", async () => {
    const p = await invoicesPage({ storage: new Map(), outcome: LOST, refresh: "lags" });
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    const tree = p.draw();
    expect(texts(tree)).toContain("may still go through until the network passes ledger 1060");
    expect(texts(tree)).not.toContain("Copy pay link");
    expect(button(tree, "Cancel invoice")).toBeNull();
  });

  // Test change (Codex invoices R4 #2, disclosed in docs/decisions.md): this test held a cancellation that was sent
  // although localStorage refused its record. R4 #2 requires that nothing is sent then, so no cancellation exists
  // that could still land, and the row rightly stays as the chain shows it. It now asserts that: Cancel sends
  // nothing, and the page says why. Its first version asserted the row was held after the lost answer.
  it("with localStorage refusing writes, Cancel sends nothing and says why, so no cancellation is left that may still land", async () => {
    const sent = vi.fn();
    const p = await invoicesPage({ storage: "blocked", outcome: LOST, refresh: "lags", onCancel: sent });
    await button(p.draw(), "Cancel invoice")!.props!.onClick!();
    await settle();
    const tree = p.draw();
    expect(sent).not.toHaveBeenCalled();
    expect(texts(tree)).toContain("would not let Caracal keep a record of the cancellation, so nothing was cancelled");
    expect(texts(tree)).not.toContain("Cancelling: Caracal could not confirm the cancellation");
  });
});
