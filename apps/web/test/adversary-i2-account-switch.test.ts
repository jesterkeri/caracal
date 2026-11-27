// Adversary i2: the invoices page never follows the signed-in account. A second
// tab signing in as another person (the "second tab signing in with another
// account" journey of docs/fix-day.md) leaves this tab showing the first
// person's wallet and split, and the next "Open invoice" files the first
// person's client name and description in the SECOND person's account.
//
// Spec: supabase/migrations/20261127000000_invoice_details.sql ("the human part
// of an invoice ... stays here, in the freelancer's own rows"; "A user sees and
// changes only their own rows") and src/lib/invoices/details.ts ("kept in the
// freelancer's own Supabase rows"). The wallet and signin pages call
// followAccount (src/lib/auth/account.ts) for exactly this; invoices/page.tsx
// never does, and create() (page.tsx) does not re-read the account before
// saveDetails(db(), ...). supabase-js reads the session from shared browser
// storage on every request, so the insert goes out with the new account's token.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);

type El = { props?: { children?: unknown; onSubmit?: (e: { preventDefault(): void }) => unknown } };
function walk(node: unknown, f: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, f));
  if (typeof node !== "object" || node === null) return;
  f(node as El);
  walk((node as El).props?.children, f);
}
function submit(node: unknown): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onSubmit === "function") found = () => el.props!.onSubmit!({ preventDefault() {} });
  });
  if (!found) throw new Error("no form");
  return found;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

type Listener = (event: string, session: { user: { id: string } } | null) => void;

/** The invoices page on A's wallet, with a Supabase whose signed-in account can change under it. */
async function render() {
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    // States, in order: load, amount, client, description, busy, notice, copied.
    // Fixture fix (2026-11-27): the ready state now records the account it was loaded for (A).
    const states: unknown[] = [{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [] }, "25", "Ada Ltd (A's private client)", "A's private job"];
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
  let current = "A";
  const listeners: Listener[] = [];
  const inserts: { account: string; row: Record<string, unknown> }[] = [];
  const auth = {
    getUser: async () => ({ data: { user: { id: current, email: `${current}@x.ng` } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: (cb: Listener) => (listeners.push(cb), { data: { subscription: { unsubscribe() {} } } }),
  };
  const client = {
    auth,
    from: () => ({
      select: () => ({ order: async () => ({ data: [], error: null }) }),
      // supabase-js sends whatever session is in browser storage: the account signed in NOW.
      insert: async (row: Record<string, unknown>) => (inserts.push({ account: current, row }), { error: null }),
      delete: () => ({ eq: async () => ({ error: null }) }),
    }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => client }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: {}, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, createInvoice: async () => ({ kind: "done", hash: "e".repeat(64) }) };
  });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const location = { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test" };
  vi.stubGlobal("window", { location });
  const mod = await import("../src/app/invoices/page");
  return {
    tree: mod.default(),
    inserts,
    setters,
    location,
    switchAccountTo: (id: string) => {
      current = id;
      listeners.forEach((cb) => cb("SIGNED_IN", { user: { id } }));
    },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("invoices page and a second tab signing in as another account", () => {
  it("control: with account A still signed in, the details are filed under A", async () => {
    const r = await render();
    await submit(r.tree)();
    await settle();
    expect(r.inserts).toHaveLength(1);
    expect(r.inserts[0]).toMatchObject({ account: "A", row: { split: SPLIT, client_name: "Ada Ltd (A's private client)" } });
  });

  it("after another account signs in, A's client name is not filed under that account", async () => {
    const r = await render();
    r.switchAccountTo("B");
    await settle();
    // The page followed the account change (reloaded, or left the form): nothing more to check.
    const followed = r.location.reload.mock.calls.length + r.location.replace.mock.calls.length > 0 || r.setters.some((s) => s.i === 0);
    if (!followed) {
      await submit(r.tree)();
      await settle();
    }
    expect(r.inserts.filter((i) => i.account !== "A")).toEqual([]);
  });
});
