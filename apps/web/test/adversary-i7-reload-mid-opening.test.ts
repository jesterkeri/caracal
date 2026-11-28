// Adversary i7. Goals 4 and 5 (a control offered that must not be, and a live invoice no one can see or cancel).
//
// Promise (docs/decisions.md, row 2026-11-27 "After an invoice opening's answer is lost, a row not yet on chain
// says it may still appear and offers no 'Remove this entry' for 3 minutes (kept in the tab and in localStorage
// caracal.invoiceOpeningUnknown; the relay builds each transaction with a 25 s time bound within 60 s of
// receiving it...)", and invoices/page.tsx OPENING_SETTLE_MS).
//
// The most common way an opening's answer is lost is that the page itself goes away while the opening is in
// flight: the person reloads, closes the tab or loses the connection while "Opening the invoice on Stellar"
// is on screen. The page writes its "may still appear" record (rememberUnknownOpening) only when createInvoice
// RETURNS an unknown outcome, so a page that is gone before then leaves no record. The details row was saved
// before the call (saveDetails), the transaction may still land for up to about a minute, and the reloaded page
// reads "no such invoice on chain yet" and offers "Remove this entry". Removing it deletes the client's name of
// an invoice that then opens on chain: it is listed nowhere (the list is built from the saved details), so it
// can no longer be cancelled from the app.
//
// Harness: the repo's React-state stub (as test/adversary-i5-unknown-opening-offered-for-removal.test.ts), with
// useEffect run once so the page's real load path (restore, read config, refresh) builds the list, and one
// shared in-memory localStorage that survives the "reload" (a fresh module registry, the same browser storage).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);

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
const settle = () => new Promise((r) => setTimeout(r, 20));
/** Waits (up to 3 s) until `done()`, so a slow machine cannot turn a timing gap into a result. */
async function until(done: () => boolean) {
  for (let i = 0; i < 150 && !done(); i++) await settle();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

/** The browser's storage and the person's saved rows: they outlive a page. */
function browser() {
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const saved: { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; opens_by_ledger: number }[] = [];
  return { localStorage, saved };
}

/**
 * One page view. `runEffect`: run the page's load path. `states`: initial useState values in order
 * (load, amount, client, description, busy, notice, copied). `createInvoice`: what the chain call does.
 */
async function view(b: ReturnType<typeof browser>, o: { runEffect: boolean; states?: unknown[]; createInvoice?: () => Promise<unknown> }) {
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
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: o.createInvoice ?? (async () => ({ kind: "done", hash: "a".repeat(64) })),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [...b.saved],
      saveDetails: async (_db: unknown, row: (typeof b.saved)[number]) => void b.saved.push({ ...row, created_at: "2026-11-27T10:00:00Z" }),
      deleteDetails: async (_db: unknown, ref: string) => {
        const at = b.saved.findIndex((r) => r.invoice_ref === ref);
        if (at >= 0) b.saved.splice(at, 1);
      },
    };
  });
  // The chain has no invoice for any saved row: the opening has not landed (yet).
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    // Read at ledger 1000, the fake kit's newest (Codex invoices R1 #2 fixture).
    return { ...actual, loadRows: async (_s: unknown, details: typeof b.saved) => details.map((d) => ({ ...d, chain: null, txHash: null, readAt: 1000 })) };
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
    getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
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

/** Fills the form and presses "Open invoice"; `createInvoice` is what the chain call then does. */
async function openAnInvoice(b: ReturnType<typeof browser>, createInvoice: () => Promise<unknown>) {
  const ready = { kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [] };
  const page = await view(b, { runEffect: false, states: [ready, "10", "Ada Ltd", "Logo"], createInvoice });
  void submit(page.tree)();
  await until(() => b.saved.length > 0); // the details are saved before the chain call
  await settle();
  return page;
}

describe("an invoice opening that is still in flight when the page goes away", () => {
  it("control: after an answer that was lost inside the page, a reload does not offer to remove the unfinished entry", async () => {
    const b = browser();
    await openAnInvoice(b, async () => ({ kind: "unknown", message: "timed out" }));
    expect(b.saved).toHaveLength(1); // the details were saved before the call
    await until(() => b.localStorage.getItem("caracal.invoiceOpeningUnknown") !== null);
    const tree = await reloaded(b);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    expect(texts(tree)).toMatch(/may still appear/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });

  it("control: an entry that was never sent (no attempt on record) is rightly offered for removal", async () => {
    const b = browser();
    b.saved.push({ invoice_ref: "ab".repeat(16), split: SPLIT, client_name: "Old client", description: "", created_at: "2026-11-20T10:00:00Z", opens_by_ledger: 900 });
    const tree = await reloaded(b);
    expect(() => click(tree, "Remove this entry")).not.toThrow();
  });

  it("the person reloads while the opening is on its way: the reloaded page must not offer 'Remove this entry' at once", async () => {
    const b = browser();
    await openAnInvoice(b, () => new Promise(() => {})); // never answers: the page is gone first
    expect(b.saved).toHaveLength(1); // saved, and the transaction has been (or is about to be) sent
    const tree = await reloaded(b);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    // Fails today: nothing was recorded, so the row reads "Not opened on chain (the opening did not finish)"
    // with a "Remove this entry" button, seconds before the transaction can land.
    expect(texts(tree)).not.toMatch(/the opening did not finish/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });
});
