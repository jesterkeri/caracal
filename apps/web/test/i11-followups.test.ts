// i11 follow-up (same class as adversary i11, found while fixing it): after "Invoice cancelled. Its pay link no
// longer works.", a read by an RPC node that has not caught up still sees the invoice open. The row must not
// show it as open with its pay link and Cancel button. The harness is adversary-i11's, with cancelInvoice faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
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
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

type Saved = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string };

/** What the fake RPC says to invoice(ref): `void` is the contract's "no such invoice" (as readInvoice reads it). */
type Answer = "no-invoice-yet" | "open";

async function view(saved: Saved[], o: { states?: unknown[]; answer: Answer; createInvoice?: () => Promise<unknown> }) {
  const setters: { i: number; v: unknown }[] = [];
  const states = o.states ?? [];
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
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
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: o.createInvoice ?? (async () => ({ kind: "done", hash: "a".repeat(64) })),
      cancelInvoice: async () => ({ kind: "done", hash: "b".repeat(64) }),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [...saved],
      saveDetails: async (_db: unknown, row: Omit<Saved, "created_at">) => void saved.push({ ...row, created_at: "2026-11-27T10:00:00Z" }),
      deleteDetails: async (_db: unknown, ref: string) => {
        const at = saved.findIndex((r) => r.invoice_ref === ref);
        if (at >= 0) saved.splice(at, 1);
      },
    };
  });
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = {
    getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  // invoice(ref) returns Option<(i128, u32)>: void when there is none, else a vec [amount, status].
  const none = xdr.ScVal.scvVoid();
  const open = xdr.ScVal.scvVec([xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString("0"), lo: xdr.Uint64.fromString("100000000") })), xdr.ScVal.scvU32(0)]);
  const rpc = {
    simulateTransaction: async () => ({ id: "1", latestLedger: 1, events: [], _parsed: true, result: { auth: [], retval: o.answer === "open" ? open : none }, transactionData: {}, minResourceFee: "0" }),
    getLatestLedger: async () => ({ sequence: 1 }),
    getEvents: async () => ({ events: [], cursor: "" }),
  };
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() }, localStorage });
  const mod = await import("../src/app/invoices/page");
  const tree = mod.default();
  await settle();
  return { tree, setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;

/** Fills the form, presses "Open invoice", waits for the page to finish; returns the page as it then reads. */
async function openAnInvoice(answer: Answer) {
  const saved: Saved[] = [];
  const ready = { kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [] };
  const page = await view(saved, { states: [ready, "10", "Ada Ltd", "Logo"], answer });
  void submit(page.tree)();
  await until(() => (last(page.setters, 0) as { kind?: string } | undefined)?.kind === "ready"); // the refresh after the write
  await settle();
  const load = last(page.setters, 0);
  const notice = last(page.setters, 5);
  vi.resetModules();
  const shown = await view(saved, { states: [load, "", "", "", null, notice], answer });
  return { saved, notice, tree: shown.tree };
}


async function cancelAnInvoice(answer: Answer) {
  const ref = "cd".repeat(16);
  const saved: Saved[] = [{ invoice_ref: ref, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z" }];
  const row = { ...saved[0]!, chain: { amount: BigInt(100000000), status: "open" }, txHash: null };
  const ready = { kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [row] };
  const page = await view(saved, { states: [ready], answer });
  void click(page.tree, "Cancel invoice")();
  await until(() => page.setters.some((x) => x.i === 0));
  await settle();
  const load = last(page.setters, 0);
  const notice = last(page.setters, 5);
  vi.resetModules();
  const shown = await view(saved, { states: [load, "", "", "", null, notice], answer });
  return { notice, tree: shown.tree };
}

describe("an invoice the page has just reported cancelled, read by a node that has not caught up", () => {
  it("does not offer its pay link or Cancel again, and says it was cancelled", async () => {
    const { notice, tree } = await cancelAnInvoice("open");
    expect(notice).toMatch(/Invoice cancelled/);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    expect(texts(tree)).toMatch(/Cancelled\. The network has not shown it yet/);
    expect(texts(tree)).not.toMatch(/Open, waiting for payment/);
    expect(() => click(tree, "Copy pay link")).toThrow();
    expect(() => click(tree, "Cancel invoice")).toThrow();
  });
});
