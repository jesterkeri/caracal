// Adversary i9. Goal 4 (a person is told something false) on the invoices page.
//
// Promise (apps/web/src/app/invoices/page.tsx removeUnopened, doc comment: "An entry the chain has no
// invoice for ... can be removed from the list"; decisions 2026-11-27, adversary i4: "After a payment that
// landed, a failed re-read keeps the invoice on screen marked paid ... instead of replacing it with a network
// error"): the page's words about a write are about that write, and a failed re-read of the list afterwards
// is not allowed to rewrite what happened.
//
// removeUnopened() runs deleteDetails() and refresh() inside ONE try block, and its catch says "Caracal could
// not remove that entry." So when the delete succeeded and only the list read that follows failed (the
// Stellar RPC did not answer within 20 s, say), the person is told the entry was not removed. It was: a
// reload shows it gone. (Opening an invoice has the same shape: create() ends with refresh().catch(listFailed),
// and listFailed() replaces the notice "Invoice opened. Copy its pay link..." with "The invoice list could not
// be refreshed", so the person is never told the invoice reached the chain and may open it a second time.)
//
// The page is rendered with the repo's usual React-state stub (test/invoice-page.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const X = "0123456789abcdef0123456789abcdef";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown; onSubmit?: (e: { preventDefault(): void }) => unknown } };
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
function submit(node: unknown): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onSubmit === "function") found = () => el.props!.onSubmit!({ preventDefault() {} });
  });
  if (!found) throw new Error("no form");
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

// opens_by_ledger and readAt (Codex invoices R1 #2 fixture): an old entry, read long after its last ledger.
type Row = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; chain: unknown; txHash: string | null; opens_by_ledger: number; readAt?: number };
const row = (over: Partial<Row> = {}): Row => ({ invoice_ref: X, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", chain: null, txHash: null, opens_by_ledger: 900, readAt: 2000, ...over });
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

/** States, in order: load, amount, client, description, busy, notice, copied. */
async function render(states: unknown[], o: { deleteFails?: boolean; listFails?: boolean }) {
  const setters: { i: number; v: unknown }[] = [];
  const calls = { deleted: vi.fn() };
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
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: async () => ({ kind: "done", hash: "e".repeat(64) }),
      // The check before removing reads the entry again: still no invoice, at a ledger past its last one.
      readInvoiceAt: async () => ({ invoice: null, ledger: 2000 }),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [],
      saveDetails: async () => {},
      deleteDetails: async (...a: unknown[]) => {
        calls.deleted(...a);
        if (o.deleteFails) throw new Error("Supabase did not answer in time");
      },
    };
  });
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    return {
      ...actual,
      // The list read after the write: the Stellar RPC does not answer.
      loadRows: async () => {
        if (o.listFails) throw new Error("The Stellar network did not answer within 20 s");
        return [];
      },
    };
  });
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test" } });
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), setters, calls };
}
const notice = (s: { i: number; v: unknown }[]) => String(s.filter((x) => x.i === 5).at(-1)?.v ?? "");

describe("removing an entry the chain has no invoice for", () => {
  it("control: when the delete itself fails, the person is told the entry could not be removed", async () => {
    const r = await render([ready([row()])], { deleteFails: true });
    await click(r.tree, "Remove this entry")();
    await settle();
    expect(r.calls.deleted).toHaveBeenCalledTimes(1);
    expect(notice(r.setters)).toMatch(/could not remove that entry/);
  });

  it("when the delete worked and only the list read after it failed, the person is not told it could not be removed", async () => {
    const r = await render([ready([row()])], { listFails: true });
    await click(r.tree, "Remove this entry")();
    await settle();
    expect(r.calls.deleted).toHaveBeenCalledTimes(1); // the entry's saved details are gone
    expect(notice(r.setters)).not.toMatch(/could not remove that entry/);
  });
});

describe("opening an invoice that reached the chain", () => {
  const FORM = [ready([]), "10", "Bob Ltd", "Site"];

  it("control: with a list that can be read, the person is told the invoice was opened", async () => {
    const r = await render(FORM, {});
    await submit(r.tree)();
    await settle();
    expect(notice(r.setters)).toMatch(/Invoice opened/);
  });

  it("when only the list read after it fails, the person is still told the invoice was opened", async () => {
    const r = await render(FORM, { listFails: true });
    await submit(r.tree)();
    await settle();
    expect(notice(r.setters)).toMatch(/opened/i);
  });
});
