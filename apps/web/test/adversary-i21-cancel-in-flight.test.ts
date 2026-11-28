// Adversary i21. Goal 3 (a page offers the pay link while an earlier action of the same kind may still land).
//
// Promise (apps/web/src/app/invoices/page.tsx, the comment above cancelPendingOf and heldNow(); decisions Codex
// invoices R3 #2, adversary i16 and R4): once a cancellation of an invoice is recorded (caracal.invoiceCancelPending,
// written by beginAttempt before the passkey is asked), "the row says Cancelling ... and offers neither its pay link
// nor Cancel". i16 made the hold apply "as the row is drawn" so no stale draw offers the link.
//
// Defect: cancel() sets `busy` (a draw), then loads the kit, reads the ledger and calls beginAttempt, which writes
// the record. Nothing sets state after that until the outcome is known (the passkey prompt and the send can take up
// to SEND_TIMEOUT_MS, 5 minutes). So the last draw is the one made BEFORE the record existed: the row is still
// "Open, waiting for payment" with its pay link and "Copy pay link", while the cancellation is recorded and may
// land at any moment. The same row, drawn again for any other reason (typing in the form), is held as "Cancelling".
//
// Real: the invoices page and src/lib/invoices/*. Faked: network, kit, supabase client, cancelInvoice (it never
// answers: the passkey prompt is open), and a small stateful React (a state change draws again one task later; the
// DOM is the last draw).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CANCEL_KEY = "caracal.invoiceCancelPending";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown; onChange?: (e: unknown) => unknown; maxLength?: number } };
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

/** The invoice reads open at ledger 900, before any cancellation's last ledger (1000 + 60). */
const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 800, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 900 }) as Row;

async function mount() {
  const store = new Map<string, string>();
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
  const view = { dom: null as unknown, draws: 0 };
  const draw = () => {
    hook = 0;
    view.dom = mod!.default();
    view.draws++;
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
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      // The passkey prompt is open: the send never answers.
      cancelInvoice: () => new Promise<never>(() => {}),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [openRow()] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    // Reading the ledger is a network call: it takes a moment, so the draw `busy` causes comes before the record exists.
    getKit: async () => ({ rpc: { getLatestLedger: async () => (await wait(20), { sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  mod = await import("../src/app/invoices/page");
  draw();
  await wait(100);
  return { view, store, draw };
}

describe("adversary i21: a cancellation on its way", () => {
  it("control: before Cancel is pressed the row is an ordinary open row with its pay link and Cancel", async () => {
    const { view, store } = await mount();
    const text = texts(view.dom);
    expect(text).toContain("Copy pay link");
    expect(text).toContain("Cancel invoice");
    expect(store.get(CANCEL_KEY) ?? "{}").not.toContain(REF);
  });

  it("control: once the cancellation is recorded, any later draw of the row holds it (no pay link, no Cancel)", async () => {
    const { view, store } = await mount();
    void find(view.dom, (el) => typeof el.props?.onClick === "function" && texts(el.props.children).includes("Cancel invoice"))!.props!.onClick!();
    await wait(100);
    expect(store.get(CANCEL_KEY)).toContain(REF);
    // Typing in the form draws the page again.
    find(view.dom, (el) => el.props?.maxLength === 120)!.props!.onChange!({ target: { value: "x" } });
    await wait(50);
    const text = texts(view.dom);
    expect(text).toMatch(/Cancelling:/);
    expect(text).not.toContain("Copy pay link");
  });

  it("while the cancellation is recorded and on its way, the row on screen does not offer its pay link", async () => {
    const { view, store } = await mount();
    void find(view.dom, (el) => typeof el.props?.onClick === "function" && texts(el.props.children).includes("Cancel invoice"))!.props!.onClick!();
    await wait(100);
    // The cancellation is recorded: it may land the moment the passkey answers.
    expect(store.get(CANCEL_KEY)).toContain(REF);
    // The row the person is looking at (the last draw) must not still offer to share a link that is about to stop working.
    const text = texts(view.dom);
    expect(text).not.toContain("Copy pay link");
  });
});
