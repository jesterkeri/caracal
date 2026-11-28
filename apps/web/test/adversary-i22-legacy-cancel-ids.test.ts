// Adversary i22. Goal 3 (a page offers the pay link and Cancel while an earlier cancellation of the same kind may
// still land).
//
// Promise (apps/web/src/lib/invoices/attempt.ts header: "a record an earlier version wrote is still read, as an
// attempt of its own", named `legacy-<ledger>`; apps/web/src/app/invoices/page.tsx, the comment above settledCancels:
// "An attempt settled here is no longer held ... a cancellation recorded since has its own id"; decisions Codex
// invoices R3 #2 and R4 #1): a lost cancellation of an invoice holds that invoice's row ("Cancelling", no pay link,
// no Cancel) until a read settles THAT attempt.
//
// Defect: settledCancels is one page-wide Set of attempt ids, but a record an earlier version wrote has no id of its
// own, so its id is `legacy-<last ledger>`: two invoices cancelled in the same ledger window by that version share
// one id. When a list read settles invoice A's record (A reads cancelled), `legacy-<ledger>` goes into the Set and
// invoice B's record, still able to land (B reads open, at a ledger before its last ledger), is no longer held: B is
// drawn open with its pay link and Cancel.
//
// Real: the invoices page and src/lib/invoices/*. Faked: network, kit, supabase client, the list read (loadRows),
// and a small stateful React (a state change draws again one task later; the DOM is the last draw).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF_A = "0123456789abcdef0123456789abcdef";
const REF_B = "fedcba9876543210fedcba9876543210";
const CANCEL_KEY = "caracal.invoiceCancelPending";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
/** The text of the <article> of one invoice (its client name picks it out). */
function articleOf(node: unknown, client: string): string {
  let found = "";
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || n === null) return;
    const el = n as { type?: unknown; props?: { children?: unknown } };
    if (el.type === "article" && texts(el.props?.children).includes(client)) found = texts(el.props?.children);
    walk(el.props?.children);
  };
  walk(node);
  return found;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

const row = (ref: string, client: string, status: "open" | "cancelled"): Row =>
  ({ invoice_ref: ref, split: SPLIT, client_name: client, description: "", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 800, chain: { amount: usdc(150), status }, txHash: null, readAt: 900 }) as Row;

async function mount(rows: Row[], stored: Record<string, number>) {
  // What an earlier version wrote: { ref: last ledger } and nothing beside it (no ids).
  const store = new Map<string, string>([[CANCEL_KEY, JSON.stringify(stored)]]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const slots: unknown[] = [];
  let hook = 0;
  let mounted = false;
  let mod: { default: () => unknown } | undefined = undefined;
  const view = { dom: null as unknown };
  const draw = () => {
    hook = 0;
    view.dom = mod!.default();
  };
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = hook++;
        if (!(at in slots)) slots[at] = typeof init === "function" ? (init as () => unknown)() : init;
        return [slots[at], (v: unknown) => {
          slots[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[at]) : v;
          setTimeout(draw, 0);
        }];
      },
      useEffect: (fn: () => unknown) => {
        if (mounted) return;
        mounted = true;
        void fn();
      },
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => ({
    ...(await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain")),
    readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
  }));
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => rows }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  mod = await import("../src/app/invoices/page");
  draw();
  await wait(150);
  return { view, store };
}

describe("adversary i22: two lost cancellations an earlier version recorded with the same last ledger", () => {
  it("control: one lost cancellation of an open invoice (read before its last ledger) holds its row", async () => {
    const { view } = await mount([row(REF_B, "Bravo Ltd", "open")], { [REF_B]: 1060 });
    const b = articleOf(view.dom, "Bravo Ltd");
    expect(b).toMatch(/Cancelling:/);
    expect(b).not.toContain("Copy pay link");
    expect(b).not.toContain("Cancel invoice");
  });

  it("control: a lost cancellation of an invoice that reads cancelled does not hold it", async () => {
    const { view } = await mount([row(REF_A, "Alpha Ltd", "cancelled")], { [REF_A]: 1060 });
    expect(articleOf(view.dom, "Alpha Ltd")).not.toMatch(/Cancelling:/);
  });

  it("invoice A's record settling (A reads cancelled) does not release invoice B's record (B reads open, before the last ledger)", async () => {
    const { view } = await mount([row(REF_A, "Alpha Ltd", "cancelled"), row(REF_B, "Bravo Ltd", "open")], { [REF_A]: 1060, [REF_B]: 1060 });
    // B's cancellation was recorded and its last ledger (1060) is still ahead of the ledger B was read at (900):
    // it may still land, so B must not offer its pay link or Cancel.
    const b = articleOf(view.dom, "Bravo Ltd");
    expect(b).toMatch(/Cancelling:/);
    expect(b).not.toContain("Copy pay link");
    expect(b).not.toContain("Cancel invoice");
  });
});
