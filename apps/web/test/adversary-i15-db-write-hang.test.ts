// Adversary i15. Goal 4 (a page stuck busy, with no way forward) on the invoices page's "Open invoice".
//
// Promise (docs/decisions.md 2026-11-27, adversary i1 and i9): every wait on the pay and invoices pages ends: network
// reads are limited to 20 s, a write's send to 5 minutes, and the list read of the saved invoices is bounded too
// (page.tsx refresh(): bounded(listDetails(db()), "Reading your saved invoices")). After a limit the page says what
// it knows and offers the form again.
//
// create() waits on the database with no limit at two points: saveDetails() before anything is sent, and
// deleteDetails() after an opening is known not to have been sent. Supabase's client has no timeout of its own and a
// browser fetch to a host that accepts the request and never answers does not end. The page then keeps showing
// "Opening the invoice on Stellar. Approve it with your passkey." with the submit button disabled and no notice, for
// ever: in the first case no passkey was ever asked and nothing was sent; in the second the outcome ("did not go
// through") was already known and is never shown.
//
// Real: the invoices page and src/lib/invoices/*; faked: Supabase calls, the chain calls, React state, the clock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);

type El = { props?: { children?: unknown; onSubmit?: (e: { preventDefault(): void }) => unknown } };
function walk(node: unknown, f: (el: El) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, f));
  if (typeof node !== "object" || node === null) return;
  f(node as El);
  walk((node as El).props?.children, f);
}
function form(node: unknown): El["props"] {
  let found: El["props"];
  walk(node, (el) => {
    if (!found && typeof el.props?.onSubmit === "function") found = el.props;
  });
  return found;
}

afterEach(() => {
  vi.useRealTimers();
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

/** The invoices page with a filled form (client "Ada Ltd", 10 USDC). State slots: 4 busy, 5 notice. */
async function invoicesPage(opts: { save: () => Promise<void>; remove?: () => Promise<void>; outcome: unknown }) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test" },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [] }, "10", "Ada Ltd", ""];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : typeof init === "function" ? (init as () => unknown)() : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), createInvoice: async () => opts.outcome };
  });
  vi.doMock("@/lib/invoices/details", async () => ({
    ...(await vi.importActual<object>("../src/lib/invoices/details")),
    listDetails: async () => [],
    saveDetails: opts.save,
    deleteDetails: opts.remove ?? (async () => {}),
  }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), setters };
}
const lastOf = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;
const never = () => new Promise<void>(() => {});

describe("adversary i15: Open invoice waits on the database with no limit", () => {
  it("control: the details are saved, the opening is sent and answers: busy ends and the notice is shown", async () => {
    vi.useFakeTimers();
    const p = await invoicesPage({ save: async () => {}, outcome: { kind: "done", hash: "d".repeat(64) } });
    void form(p.tree)!.onSubmit!({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(lastOf(p.setters, 4)).toBeNull();
    expect(String(lastOf(p.setters, 5))).toMatch(/Invoice opened/);
  });

  it("saving the details never answers: after 5 minutes the page is still busy and nothing was sent", async () => {
    vi.useFakeTimers();
    const p = await invoicesPage({ save: never, outcome: { kind: "done", hash: "d".repeat(64) } });
    void form(p.tree)!.onSubmit!({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    // Every other wait on this page ends within 20 s to 5 minutes; this one must end too (busy cleared, a notice shown).
    expect(lastOf(p.setters, 4)).toBeNull();
    expect(lastOf(p.setters, 5)).toBeTruthy();
  });

  it("removing the details of an opening known not to have been sent never answers: the outcome is never shown", async () => {
    vi.useFakeTimers();
    const p = await invoicesPage({ save: async () => {}, remove: never, outcome: { kind: "not-sent", message: "The passkey prompt was closed." } });
    void form(p.tree)!.onSubmit!({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(lastOf(p.setters, 4)).toBeNull();
    expect(String(lastOf(p.setters, 5))).toMatch(/did not go through/);
  });
});
