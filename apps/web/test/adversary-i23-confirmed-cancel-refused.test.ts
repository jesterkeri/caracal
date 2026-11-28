// Adversary i23. Goal 3 (a page offers the pay link and Cancel for an invoice whose cancellation this browser saw
// confirmed, across a reload, when storage refuses some writes).
//
// Promise (apps/web/src/app/invoices/page.tsx, the comment above CONFIRMED_KEY: "A read right after (an RPC node a
// ledger behind) can still show the invoice ... open; the row then says what was confirmed and offers ... neither its
// pay link nor Cancel (on a cancelled one)"; the comment above cancelPendingOf and attempt.ts: a cancellation's record
// holds its row until the invoice reads cancelled, or open past its last ledger; decisions adversary i11, R3 #2, R4):
// after a cancellation this browser saw confirmed, the row never offers the pay link or Cancel again until a read
// agrees, and a page never shows an invoice open when it is not known.
//
// Defect: cancel() removes the cancellation's own record (endAttempt) as soon as the outcome is "done", and only
// then records the confirmed outcome (setConfirmed), which swallows a storage refusal and keeps the fact in this
// tab's memory only. When storage refuses that write, nothing in storage holds the row any more. After a reload, a
// list read by an RPC node a ledger behind (open, read at a ledger before the cancellation's last ledger) draws the
// invoice as "Open, waiting for payment" with its pay link and "Cancel invoice", although this browser saw it
// cancelled a moment ago. Had the page kept the cancellation's record until the confirmed one was stored, the row
// would stay held.
//
// Real: the invoices page and src/lib/invoices/*. Faked: network, kit, supabase client, cancelInvoice (it answers
// "done"), the list read (loadRows), and a small stateful React (a state change draws again one task later; the DOM
// is the last draw). The browser's storage is a Map that refuses writes to one key, as a full or partly blocked
// storage can.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CONFIRMED_KEY = "caracal.invoiceConfirmed";
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
function find(node: unknown, pick: (el: El) => boolean): El | null {
  let found: El | null = null;
  walk(node, (el) => {
    if (!found && pick(el)) found = el;
  });
  return found;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Draws still queued when a test ends must not run against the next test's (or no) window. */
const stops: (() => void)[] = [];

afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

const row = (status: "open" | "cancelled", readAt: number): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 800, chain: { amount: usdc(150), status }, txHash: null, readAt }) as Row;

/** One page load. `rows` is what each list read answers; `refuse` is a storage key whose writes are refused. */
async function mount(store: Map<string, string>, rows: () => Row[], refuse?: string) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === refuse) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
    },
  });
  const slots: unknown[] = [];
  let hook = 0;
  let mounted = false;
  let mod: { default: () => unknown } | undefined = undefined;
  const view = { dom: null as unknown };
  let stopped = false;
  stops.push(() => {
    stopped = true;
  });
  const draw = () => {
    if (stopped) return;
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
    cancelInvoice: async () => ({ kind: "done", hash: "d".repeat(64) }),
  }));
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => rows() }));
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
  return view;
}

/** Cancels the open invoice (confirmed), then reloads the page: the new load's list read comes from a node a ledger behind. */
async function cancelThenReload(refuse?: string) {
  const store = new Map<string, string>();
  let cancelled = false;
  // First page life: open before Cancel; right after it the node answering is still a ledger behind (open at 1001).
  const first = await mount(store, () => [cancelled ? row("open", 1001) : row("open", 900)], refuse);
  const cancelBtn = find(first.dom, (el) => typeof el.props?.onClick === "function" && texts(el.props.children).includes("Cancel invoice"));
  expect(cancelBtn).not.toBeNull();
  cancelled = true;
  void cancelBtn!.props!.onClick!();
  await wait(150);
  expect(texts(first.dom)).toContain("Invoice cancelled");
  // The reload: a fresh page life (no tab memory), the same browser storage. The RPC node answering is a ledger
  // behind the confirmed cancellation: it reads the invoice open, at ledger 1001, before the cancellation's last
  // ledger (1000 + 60).
  stops.splice(0).forEach((stop) => stop());
  vi.resetModules();
  vi.doUnmock("react");
  const second = await mount(store, () => [row("open", 1001)], refuse);
  return { store, text: texts(second.dom) };
}

describe("adversary i23: a cancellation this browser saw confirmed, then a reload and a node a ledger behind", () => {
  it("control: with storage that keeps the confirmed outcome, the reloaded row offers neither its pay link nor Cancel", async () => {
    const { store, text } = await cancelThenReload();
    expect(store.get(CONFIRMED_KEY)).toContain(REF);
    expect(text).not.toContain("Copy pay link");
    expect(text).not.toContain("Cancel invoice");
  });

  it("storage that refuses the confirmed record's write: the reloaded row still offers neither its pay link nor Cancel", async () => {
    const { store, text } = await cancelThenReload(CONFIRMED_KEY);
    // Storage did refuse it: only this (gone) tab's memory knew the cancellation was confirmed.
    expect(store.get(CONFIRMED_KEY)).toBeUndefined();
    // The invoice was cancelled a moment ago, this browser knows it, and the read is merely behind: the row must not
    // go back to "Open, waiting for payment" with a pay link to share and a Cancel to press.
    expect(text).not.toContain("Open, waiting for payment");
    expect(text).not.toContain("Copy pay link");
    expect(text).not.toContain("Cancel invoice");
  });
});
