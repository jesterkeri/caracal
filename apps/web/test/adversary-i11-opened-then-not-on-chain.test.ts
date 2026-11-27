// Adversary i11. Goal 4 (a person is told something false: "the opening did not finish" for an invoice the page
// has just reported opened) and goal 5 (a control offered that must not be: "Remove this entry" on a live invoice).
//
// Promise (docs/decisions.md, row 2026-11-27 "After an invoice opening's answer is lost, a row not yet on chain
// says it may still appear and offers no 'Remove this entry' for 3 minutes ..." and the i7 row: the record is
// "cleared once its outcome is known (on chain, or proven not sent)"; invoices/page.tsx statusText: "Not opened
// on chain (the opening did not finish)" is for details whose opening did not finish; rows.ts: "null: the
// contract has no such invoice (the details were saved but opening it did not finish)").
//
// After createInvoice answers "done" (the transaction is confirmed: it has a hash), create() calls
// forgetOpening(ref) and then refresh()es the list from the network. A read that has not caught up with the
// ledger that just confirmed the transaction (a load-balanced RPC, one ledger behind) answers "no such
// invoice" (the contract's invoice() returns void). With the guard cleared, the row reads
// "Not opened on chain (the opening did not finish)" and offers "Remove this entry", right under the notice
// "Invoice opened. Copy its pay link below". Removing it deletes the details of an invoice that is on chain:
// the list is built from the saved details, so the invoice is then listed nowhere and cannot be cancelled
// from the app, while its pay link is live.
//
// Harness: the repo's React-state stub (as adversary-i7-reload-mid-opening.test.ts). The chain read is the
// real readInvoice/loadRows over a fake RPC whose simulateTransaction answers void (no such invoice yet);
// only the send (createInvoice) is faked, as every invoice-page test does.
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

describe("an invoice the page has just reported opened, read by a node that has not caught up", () => {
  it("control: when the read sees the invoice, it is listed open with its link and no Remove button", async () => {
    const { notice, tree } = await openAnInvoice("open");
    expect(notice).toMatch(/Invoice opened/);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    expect(texts(tree)).toMatch(/Open, waiting for payment/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });

  it("control: an old saved entry the chain has no invoice for is rightly offered for removal", async () => {
    const saved: Saved[] = [{ invoice_ref: "ab".repeat(16), split: SPLIT, client_name: "Old client", description: "", created_at: "2026-11-20T10:00:00Z" }];
    const ready = { kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [{ ...saved[0]!, chain: null, txHash: null }] };
    const { tree } = await view(saved, { states: [ready], answer: "no-invoice-yet" });
    expect(texts(tree)).toMatch(/the opening did not finish/);
    expect(() => click(tree, "Remove this entry")).not.toThrow();
  });

  it("after 'Invoice opened', a read that has not seen it yet must not say the opening did not finish or offer Remove", async () => {
    const { saved, notice, tree } = await openAnInvoice("no-invoice-yet");
    expect(notice).toMatch(/Invoice opened/); // the page itself says it opened (a confirmed transaction)
    expect(saved).toHaveLength(1);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    // Fails today: forgetOpening(ref) ran on "done", so the row reads
    // "Not opened on chain (the opening did not finish)" and offers "Remove this entry".
    expect(texts(tree)).not.toMatch(/the opening did not finish/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });
});
