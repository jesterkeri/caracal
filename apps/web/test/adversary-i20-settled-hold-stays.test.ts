// Adversary i20. Goal 3 (a page offers or withholds an action on a state it does not know): a cancellation hold that
// the page itself has just settled is still drawn, and nothing draws the row again.
//
// Promise (apps/web/src/app/invoices/page.tsx, the comment above cancelPendingOf, and decisions Codex invoices R3 #2 and
// R4): "Until the invoice reads cancelled or paid, or open at a ledger past that one [the cancellation's last ledger],
// its row says the cancellation may still go through and offers neither its pay link nor Cancel." Once the list read
// says the invoice is open at a ledger past it, the row must be an ordinary open row again.
//
// Defect: shown() settles such a record with `void endAttempt(...)`, which takes the record's Web Lock (an
// asynchronous request in a browser) and removes the record some time after shown() returned. The row is returned
// as a plain open row, but heldNow() runs when the row is drawn and reads the record again (cancelPendingOf), which
// is still there when React draws the list a task after setLoad, before the browser grants the lock. So the first
// draw says "Cancelling: ... may still go through until ledger 1000 ... Do not share its pay link" with no pay link and
// no Cancel, for an invoice read as open at ledger 1100. No state changes after endAttempt finishes, so the page is
// not drawn again: the stale hold stays on screen (until a reload, or until anything else makes the page draw again,
// such as typing in the form).
//
// The repo's test Web Locks (test/setup-web-locks.ts) grant a lock in the same tick, which hides this. A browser's
// navigator.locks.request calls its callback from a later task (the grant comes back from the browser process), so
// the fake below grants after 5 ms. React draws after a state change in the next task, so the draw here follows
// each state change by one task.
//
// Real: the invoices page, src/lib/invoices/*, src/lib/auth/account.ts. Faked: network, kit, supabase client, and a
// small stateful React (a state change draws again one task later; the DOM is the last draw).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CANCEL_KEY = "caracal.invoiceCancelPending";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

/** The invoice reads open at ledger 1100, past the lost cancellation's last ledger (1000). */
const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1100 }) as Row;

/**
 * Mounts the invoices page with a lost cancellation on record (last ledger 1000). `lockDelayMs`: how long the Web
 * Lock takes to be granted (0: in the same tick, as the repo's test locks do).
 */
async function mount(lockDelayMs: number) {
  const store = new Map<string, string>([
    [CANCEL_KEY, JSON.stringify({ [REF]: 1000 })],
    [`${CANCEL_KEY}.ids`, JSON.stringify({ [REF]: "earlier-attempt" })],
  ]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  if (lockDelayMs > 0) {
    vi.stubGlobal("navigator", {
      locks: { request: (name: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => new Promise((res, rej) => setTimeout(() => cb({ name, mode: "exclusive" }).then(res, rej), lockDelayMs)) },
    });
  }

  // A small React: state changes draw again one task later; `dom` is the last draw; `draws` counts them.
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
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [openRow()] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: {}, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  mod = await import("../src/app/invoices/page");
  draw(); // mount: runs the effect, which loads the list and sets the state
  await wait(150); // the load, every draw it causes, and any lock grant
  return { view, store };
}

describe("adversary i20: a cancellation hold the list read has settled", () => {
  it("control: the invoice reads open at 1100, past the lost cancellation's last ledger 1000, and the record goes", async () => {
    const { store } = await mount(0);
    expect(store.get(CANCEL_KEY) ?? "{}").not.toContain(REF);
  });

  it("control: with a lock granted in the same tick (the repo's test locks) the row ends as an ordinary open row", async () => {
    const { view } = await mount(0);
    const text = texts(view.dom);
    expect(text).not.toMatch(/Cancelling:/);
    expect(text).toContain("Copy pay link");
  });

  it("with a lock granted a task later (a browser's), the row on screen is an ordinary open row once the record is settled", async () => {
    const { view, store } = await mount(5);
    // The record is settled and removed by the page itself...
    expect(store.get(CANCEL_KEY) ?? "{}").not.toContain(REF);
    // ...so the last thing drawn must not still say the cancellation may go through, or withhold the pay link.
    const text = texts(view.dom);
    expect(text).not.toMatch(/Cancelling:/);
    expect(text).toContain("Copy pay link");
  });
});
