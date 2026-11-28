// Adversary i23. Goal 3 (a page offers sharing the pay link while a cancellation of the invoice may still land,
// across tabs, where a real browser draws only after a state change).
//
// Promise (apps/web/src/app/invoices/page.tsx, the comment above cancelPendingOf and heldNow(); decisions adversary
// i16 "or another tab", Codex invoices R3 #2 and R4): once a cancellation of an invoice is recorded in this browser
// (caracal.invoiceCancelPending), its row "offers neither its pay link nor Cancel", whichever tab recorded it.
//
// Defect: another tab records a cancellation (the passkey prompt is open there). This tab draws nothing (no state
// changes, and the page listens to no `storage` event), so its last draw still shows "Copy pay link", and the
// copy handler does not look at the record when it is pressed (heldNow runs only while drawing). Cancel is safe
// (beginAttempt reads the record under the lock), but the link of an invoice that is being cancelled is put on the
// clipboard to be sent to a client.
//
// Real: the invoices page and src/lib/invoices/*. Faked: network, kit, supabase client, the list read, the clipboard
// and a small stateful React (a state change draws again one task later; the DOM is the last draw). A `storage`
// event is delivered to every listener the page registered, as a browser does to the other tabs.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CANCEL_KEY = "caracal.invoiceCancelPending";
const CANCEL_IDS = `${CANCEL_KEY}.ids`;
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
function find(node: unknown, pick: (el: El) => boolean): El | null {
  let found: El | null = null;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== "object" || n === null) return;
    if (!found && pick(n as El)) found = n as El;
    walk((n as El).props?.children);
  };
  walk(node);
  return found;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Draws still queued when a test ends must not run against the next test's (or no) window. */
let stopDrawing = () => {};

afterEach(() => {
  stopDrawing();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 800, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 900 }) as Row;

async function mount() {
  const store = new Map<string, string>();
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const copied: string[] = [];
  vi.stubGlobal("navigator", { locks: (globalThis.navigator as { locks?: unknown }).locks, clipboard: { writeText: async (t: string) => void copied.push(t) } });
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() },
    addEventListener: (type: string, fn: (e: unknown) => void) => void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const slots: unknown[] = [];
  let hook = 0;
  let mounted = false;
  let mod: { default: () => unknown } | undefined = undefined;
  const view = { dom: null as unknown };
  let stopped = false;
  stopDrawing = () => {
    stopped = true;
  };
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
  }));
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [openRow()] }));
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
  /** What another tab's write does here: the record is in storage, and the browser tells this tab with a storage event. */
  const otherTabRecordsCancellation = async () => {
    store.set(CANCEL_IDS, JSON.stringify({ [REF]: "other-tab-attempt" }));
    store.set(CANCEL_KEY, JSON.stringify({ [REF]: 1060 }));
    for (const fn of listeners.get("storage") ?? []) fn({ key: CANCEL_KEY });
    await wait(50);
  };
  return { view, copied, otherTabRecordsCancellation };
}

describe("adversary i23: another tab records a cancellation of the invoice this tab shows open", () => {
  it("control: with no cancellation recorded, Copy pay link copies the link", async () => {
    const { view, copied } = await mount();
    const btn = find(view.dom, (el) => typeof el.props?.onClick === "function" && texts(el.props.children).includes("Copy pay link"));
    expect(btn).not.toBeNull();
    await btn!.props!.onClick!();
    expect(copied).toEqual([`https://caracal.test/pay/${SPLIT}/${REF}`]);
  });

  it("after another tab records a cancellation, this tab does not hand out the pay link (the button is gone, or it refuses)", async () => {
    const { view, copied, otherTabRecordsCancellation } = await mount();
    await otherTabRecordsCancellation();
    // Whatever this tab shows now (the last draw) may offer Copy pay link; pressing it must not put the link of an
    // invoice that is being cancelled on the clipboard.
    const btn = find(view.dom, (el) => typeof el.props?.onClick === "function" && texts(el.props.children).includes("Copy pay link"));
    if (btn) await btn.props!.onClick!();
    expect(copied).toEqual([]);
  });
});
