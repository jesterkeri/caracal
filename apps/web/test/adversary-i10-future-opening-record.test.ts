// Adversary i10. Goals 5 and 4 (a person left with no way forward, and told "it may still appear" when it
// cannot), on the invoices page, from a clock that was set back.
//
// Promise (docs/decisions.md, row 2026-11-27 "After an invoice opening's answer is lost, a row not yet on chain
// says it may still appear and offers no 'Remove this entry' for 3 minutes (kept in the tab and in localStorage
// caracal.invoiceOpeningUnknown; the relay builds each transaction with a 25 s time bound within 60 s of
// receiving it, so a later landing cannot happen)", and invoices/page.tsx OPENING_SETTLE_MS: "3 * 60_000").
//
// The record is a wall-clock stamp, and mayStillOpen() holds "still opening" while
// Date.now() - stamp < OPENING_SETTLE_MS. A stamp that is in the future (the device clock was ahead when the
// opening was sent, then was corrected by the network or by the person) makes that difference negative, so
// the row stays "may still appear" and offers no "Remove this entry" until the clock catches up with the
// stamp: an hour for an hour of skew, though the opening can no longer land after about 85 seconds. Nothing
// ever re-records a future stamp (rememberUnknownOpening only writes on a new attempt).
//
// The same fault was proven and fixed on the wallet page (test/adversary-r4l-future-start-time.test.ts,
// decisions row 2026-11-26 r4l: "A recorded start time in the future (the clock was set back) is recorded again
// as now, so the 3-minute wait always ends"). This is the invoices page's twin.
//
// A fix that re-records a future stamp as "now" on first sight (as r4l did) still passes this test: the
// second look is 3 minutes and 1 second after the first. So does one that treats a future stamp as expired.
//
// Harness: the repo's React-state stub, as test/adversary-i7-reload-mid-opening.test.ts, with Date.now
// controlled by the test (timers stay real).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "ab".repeat(16);
const KEY = "caracal.invoiceOpeningUnknown";
const HOUR = 60 * 60_000;

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
function click(node: unknown, text: string): () => unknown {
  let found: (() => unknown) | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el.props.onClick;
  });
  if (!found) throw new Error(`no button "${text}"`);
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

/** The browser's storage and the person's saved rows: they outlive a page. One saved row, never on chain. */
function browser(stamp: number) {
  const store = new Map<string, string>([[KEY, JSON.stringify({ [REF]: stamp })]]);
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const saved = [{ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z" }];
  return { localStorage, saved };
}

async function view(b: ReturnType<typeof browser>, o: { runEffect: boolean; states?: unknown[] }) {
  const setters: { i: number; v: unknown }[] = [];
  const states = o.states ?? [];
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
      useEffect: (f: () => unknown) => {
        if (o.runEffect) void f();
      },
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }) };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return { ...actual, listDetails: async () => [...b.saved] };
  });
  // The chain has no invoice for the saved row: its opening never landed.
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    return { ...actual, loadRows: async (_s: unknown, details: typeof b.saved) => details.map((d) => ({ ...d, chain: null, txHash: null })) };
  });
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = {
    getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: {}, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() }, localStorage: b.localStorage });
  const mod = await import("../src/app/invoices/page");
  const tree = mod.default();
  await settle();
  return { tree, setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;

/** The page as a person finds it after reloading: loads for real, then is rendered with the list it built. */
async function reloaded(b: ReturnType<typeof browser>) {
  vi.resetModules();
  const loading = await view(b, { runEffect: true });
  const load = last(loading.setters, 0);
  expect(load).toMatchObject({ kind: "ready" });
  vi.resetModules();
  return (await view(b, { runEffect: false, states: [load] })).tree;
}

/** Date.now() is `real + offset`; the test moves `offset`. */
function clock() {
  const real = Date.now.bind(Date);
  const t = { offset: 0 };
  vi.spyOn(Date, "now").mockImplementation(() => real() + t.offset);
  return t;
}

describe("an opening's 'may still appear' record, read after the clock was set back", () => {
  it("control: a record made now holds 'Remove this entry' back at first and offers it once 3 minutes have passed", async () => {
    const t = clock();
    const b = browser(Date.now());
    const early = await reloaded(b);
    expect(texts(early)).toMatch(/may still appear/);
    expect(() => click(early, "Remove this entry")).toThrow();
    t.offset += 3 * 60_000 + 1000;
    const later = await reloaded(b);
    expect(() => click(later, "Remove this entry")).not.toThrow();
  });

  it("a record stamped an hour ahead of the (corrected) clock still lets the entry be removed 3 minutes after the page first saw it", async () => {
    const t = clock();
    // The opening was recorded when the device clock ran an hour fast; the clock has since been corrected.
    const b = browser(Date.now() + HOUR);
    // The first look: whether it says "may still appear" is not asserted (a future stamp proves nothing either way).
    await reloaded(b);
    // The second look is 3 minutes and 1 second later: even counted from the first look, the 3 minutes are over.
    t.offset += 3 * 60_000 + 1000;
    const tree = await reloaded(b);
    // Fails today: Date.now() - stamp is about -57 minutes, below the 3-minute limit, so the row still says
    // "may still appear" and offers no way to remove the unfinished entry (for an hour, until the clock catches up).
    expect(texts(tree)).not.toMatch(/may still appear/);
    expect(() => click(tree, "Remove this entry")).not.toThrow();
  });
});
