// Codex invoices R1 (external review of 34d2e8a), two P1 findings:
//  1. create() checked the signed-in account, then inserted the details without owner_id. If another tab
//     switched the shared Supabase session in between, the database default (auth.uid()) filed account A's
//     client name and description under account B, and row-level security accepted it.
//  2. The page stopped renewing its "opening may still land" record when its 5 minute wait ended, though the
//     kit's call went on. Once that and the 15 minute created-at hold ran out, another device offered
//     "Remove this entry" while the opening could still be sent and land, leaving an invoice on chain with no
//     saved details. The opening now carries a signature expiry ledger, saved with the details, and an entry
//     is removable only when the network has read it as missing after that ledger.
import { contract, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENING_LEDGERS, createInvoice, readInvoiceAt } from "../src/lib/invoices/chain";
import { cannotOpenAnyMore, loadRows } from "../src/lib/invoices/rows";
import { TOKENS } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const X = "0123456789abcdef0123456789abcdef";

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
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

type Row = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; opens_by_ledger: number; chain: unknown; txHash: string | null; readAt?: number };
const row = (over: Partial<Row> = {}): Row => ({ invoice_ref: X, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 1060, chain: null, txHash: null, ...over });
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;

/**
 * The invoices page (states: load, amount, client, description, busy, notice, copied) over a Supabase fake
 * that applies the table's rules: owner_id defaults to the session's account, and row-level security refuses
 * a row whose owner is not the session's. `switchAfterCheck`: another tab signs in as B right after the page
 * checks the account.
 */
async function render(states: unknown[], o: { switchAfterCheck?: boolean; recheck?: { invoice: unknown; ledger: number | undefined }; rows?: Row[]; runEffect?: boolean } = {}) {
  const setters: { i: number; v: unknown }[] = [];
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
  let session = "A";
  const stored: { owner: string; row: Record<string, unknown> }[] = [];
  const deleted: string[] = [];
  const created: unknown[][] = [];
  const auth = {
    getUser: async () => {
      const id = session;
      if (o.switchAfterCheck) session = "B";
      return { data: { user: { id, email: `${id}@x.ng` } }, error: null };
    },
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const client = {
    auth,
    from: () => ({
      select: () => ({ order: async () => ({ data: [], error: null }) }),
      insert: async (r: Record<string, unknown>) => {
        const owner = (r.owner_id as string | undefined) ?? session; // default auth.uid()
        if (owner !== session) return { error: { message: "new row violates row-level security policy for table \"invoices\"" } };
        stored.push({ owner, row: r });
        return { error: null };
      },
      delete: () => ({ eq: async (_c: string, ref: string) => (deleted.push(ref), { error: null }) }),
    }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => client }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: async (...a: unknown[]) => (created.push(a), { kind: "done", hash: "e".repeat(64) }),
      readInvoiceAt: async () => o.recheck ?? { invoice: null, ledger: 2000 },
    };
  });
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    return { ...actual, loadRows: async () => o.rows ?? [] };
  });
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test" } });
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), setters, stored, deleted, created };
}

/** The page as loaded for real (sign-in, wallet, split, then the list through shown()), then rendered with that list. */
async function loaded(rows: Row[], o: { recheck?: { invoice: unknown; ledger: number | undefined } } = {}) {
  const loading = await render([], { rows, runEffect: true });
  await settle();
  const load = last(loading.setters, 0);
  expect(load).toMatchObject({ kind: "ready" });
  vi.resetModules();
  return render([load], { ...o, rows });
}

describe("finding 1: the details go into the checked account's rows or nowhere", () => {
  const FORM = [ready([]), "10", "Ada Ltd (A's private client)", "Logo for A"];

  it("control: with A still signed in, the details are saved under A and the invoice is opened", async () => {
    const r = await render(FORM);
    await submit(r.tree)();
    await settle();
    expect(r.stored.map((s) => s.owner)).toEqual(["A"]);
    expect(r.created).toHaveLength(1);
  });

  it("a session switched to B between the check and the insert files nothing under B, and opens nothing", async () => {
    const r = await render(FORM, { switchAfterCheck: true });
    await submit(r.tree)();
    await settle();
    expect(r.stored.filter((s) => s.owner === "B")).toEqual([]);
    expect(r.stored).toEqual([]);
    expect(r.created).toEqual([]);
    expect(String(last(r.setters, 5))).toMatch(/could not save the client's name, so nothing was opened/);
  });

  it("the insert names A as the owner", async () => {
    const r = await render(FORM);
    await submit(r.tree)();
    await settle();
    expect(r.stored[0]?.row).toMatchObject({ owner_id: "A", client_name: "Ada Ltd (A's private client)" });
  });
});

describe("finding 2: an entry is removable only once its opening can no longer land", () => {
  it("the opening's last ledger is saved with the details and given to the send as the signature expiry", async () => {
    const r = await render([ready([]), "10", "Ada Ltd", "Logo"]);
    await submit(r.tree)();
    await settle();
    expect(r.stored[0]?.row).toMatchObject({ opens_by_ledger: 1000 + OPENING_LEDGERS });
    expect(r.created[0]?.[4]).toBe(1000 + OPENING_LEDGERS);
  });

  it("createInvoice asks the kit to sign with that expiry ledger", async () => {
    vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({ simulation: undefined } as never);
    const signAndSubmit = vi.fn(async () => ({ success: true, hash: "a".repeat(64) }));
    await createInvoice({ rpc: {}, signAndSubmit } as never, SPLIT, X, BigInt(5), 1060);
    expect(signAndSubmit).toHaveBeenCalledWith(expect.anything(), { expiration: 1060 });
  });

  it("another device, an hour later, does not offer Remove while the network has not been read past that ledger", async () => {
    // Saved an hour ago (past every time-based hold), its kit call still pending on the first device, and the
    // read made at ledger 1060: the opening may still land at that ledger.
    const r = await loaded([row({ created_at: new Date(Date.now() - 3_600_000).toISOString(), readAt: 1060 })]);
    expect(() => click(r.tree, "Remove this entry")).toThrow();
    expect(texts(r.tree)).toMatch(/may still appear/);
  });

  it("a read with no ledger does not make the entry removable", async () => {
    const r = await loaded([row({ created_at: "2026-11-20T10:00:00Z", readAt: undefined })]);
    expect(() => click(r.tree, "Remove this entry")).toThrow();
  });

  it("control: read as missing after that ledger, the entry is offered for removal and removed", async () => {
    const r = await loaded([row({ created_at: "2026-11-20T10:00:00Z", readAt: 1061 })]);
    await click(r.tree, "Remove this entry")();
    await settle();
    expect(r.deleted).toEqual([X]);
  });

  it("Remove reads the entry again first, and keeps it if the fresh read is not past the ledger", async () => {
    const r = await loaded([row({ created_at: "2026-11-20T10:00:00Z", readAt: 1061 })], { recheck: { invoice: null, ledger: 1050 } });
    await click(r.tree, "Remove this entry")();
    await settle();
    expect(r.deleted).toEqual([]);
    expect(String(last(r.setters, 5))).toMatch(/could not confirm that this invoice can no longer be opened/);
  });

  it("Remove keeps the entry if the fresh read finds the invoice opened", async () => {
    const r = await loaded([row({ created_at: "2026-11-20T10:00:00Z", readAt: 1061 })], { recheck: { invoice: { amount: BigInt(5), status: "open" }, ledger: 2000 } });
    await click(r.tree, "Remove this entry")();
    await settle();
    expect(r.deleted).toEqual([]);
  });

  it("the list's rows carry the ledger the network read them at", async () => {
    const answer = (latestLedger?: number) => ({
      simulateTransaction: async () => ({ id: "1", ...(latestLedger === undefined ? {} : { latestLedger }), events: [], _parsed: true, result: { auth: [], retval: xdr.ScVal.scvVoid() }, transactionData: {}, minResourceFee: "0" }),
      getLatestLedger: async () => ({ sequence: 2000 }),
      getEvents: async () => ({ events: [], cursor: "" }),
    });
    const saved = [{ invoice_ref: X, split: SPLIT, client_name: "Ada Ltd", description: "", created_at: "2026-11-20T10:00:00Z", opens_by_ledger: 1060 }];
    const [read] = await loadRows(answer(2000) as never, saved, SPLIT);
    expect(read).toMatchObject({ chain: null, readAt: 2000 });
    expect(cannotOpenAnyMore(read!)).toBe(true);
    const [blind] = await loadRows(answer() as never, saved, SPLIT);
    expect(cannotOpenAnyMore(blind!)).toBe(false);
    expect(await readInvoiceAt(answer(1060) as never, SPLIT, X)).toEqual({ invoice: null, ledger: 1060 });
    expect(cannotOpenAnyMore({ chain: null, readAt: 1060, opens_by_ledger: 1060 })).toBe(false);
  });
});
