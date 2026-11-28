// Adversary i21. Goal 4 (a page stuck busy, work with no bound).
//
// Promise (docs/decisions.md, 2026-11-27 Day 1 / invoices row on timeouts): "Every network read on the pay and
// invoices pages (simulations, event pages, building a call) is limited to 20 s, and loading the kit and restoring the
// saved wallet on the invoices page to 30 s". The invoices page bounds the list read ("Reading your saved invoices"),
// the kit, the wallet restore, and (create()) the sign-in re-check ("Checking your sign-in", adversary i15).
//
// Defect: the first thing the page does on load is `await readSignInState(auth)` (apps/web/src/app/invoices/page.tsx),
// which awaits supabase's auth.getUser(), a network request a browser never times out. A server that accepts the
// request and never answers leaves the page on "Loading your invoices." for ever: no error, no sign-out link, no way
// on except a reload that meets the same silence. (create() bounds the same call; the load does not.)
//
// Real: the invoices page and src/lib/auth/account.ts. Faked: network, kit, supabase auth client, and a small
// stateful React (a state change draws again one task later; the DOM is the last draw).
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

type El = { props?: { children?: unknown } };
function texts(node: unknown, out: string[] = []): string {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out.join(" ");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
});

/** Mounts the invoices page; `getUser` is what the sign-in check's network request does. */
async function mount(getUser: () => Promise<unknown>) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() },
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
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
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser, getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: {}, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  mod = await import("../src/app/invoices/page");
  draw();
  return view;
}

describe("adversary i21: the invoices page waits for the sign-in check without end", () => {
  it("control: when the sign-in check answers, the page leaves 'Loading your invoices.'", async () => {
    vi.useFakeTimers();
    const view = await mount(async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(texts(view.dom)).not.toContain("Loading your invoices.");
    expect(texts(view.dom)).toContain("New invoice");
  });

  it("control: when the sign-in check fails, the page leaves 'Loading your invoices.'", async () => {
    vi.useFakeTimers();
    const view = await mount(async () => {
      throw new Error("Failed to fetch");
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(texts(view.dom)).not.toContain("Loading your invoices.");
  });

  it("a sign-in check that never answers ends in a message within ten minutes, not in 'Loading your invoices.' for ever", async () => {
    vi.useFakeTimers();
    const view = await mount(() => new Promise<never>(() => {}));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(texts(view.dom)).not.toContain("Loading your invoices.");
  });
});
