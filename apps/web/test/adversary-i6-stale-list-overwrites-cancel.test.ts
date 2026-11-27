// Adversary i6. Goal 4 (a status that is not the chain's) and goal 1 (a cancelled invoice's pay link is
// offered again).
//
// Promise (lib/invoices/rows.ts): "The chain is the truth for amount and status", and the list after a write
// is rebuilt from the chain (invoices/page.tsx create() and cancel() each end in refresh()).
//
// But refresh() is not ordered. After "Open invoice" the page clears its busy flag BEFORE it re-reads the
// list, so for as long as that read takes (every row is read from the network, each read allowed 20 s,
// lib/invoices/chain.ts READ_TIMEOUT_MS) the Cancel buttons are live. If the freelancer cancels an invoice in
// that time, the cancel's own refresh finishes first and shows it cancelled, and then the older read finishes
// and setLoad() puts the earlier list back: the cancelled invoice is shown "Open, waiting for payment" with
// its pay link and a Cancel button again. The same class was found and fixed on the split page
// (decisions 2026-11-27, "a read that finishes after a newer one began is dropped"; test
// adversary-s1-refresh-race on feat/split-setup); the invoices page has no such guard.
//
// The page is rendered with the repo's usual React-state stub (test/invoice-page.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const X = "0123456789abcdef0123456789abcdef";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

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

type Row = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; chain: unknown; txHash: string | null };
const row = (over: Partial<Row> = {}): Row => ({ invoice_ref: X, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", chain: { amount: usdc(150), status: "open" }, txHash: null, ...over });
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

/** States, in order: load, amount, client, description, busy, notice, copied. `reads` answers each list read in turn. */
async function render(states: unknown[], reads: (() => Promise<Row[]>)[]) {
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
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: async () => ({ kind: "done", hash: "e".repeat(64) }),
      cancelInvoice: async () => ({ kind: "done", hash: "f".repeat(64) }),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return { ...actual, listDetails: async () => [], saveDetails: async () => {}, deleteDetails: async () => {} };
  });
  let n = 0;
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    return { ...actual, loadRows: () => reads[n++]!() };
  });
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: {}, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test" } });
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v as { rows: Row[] };

const OPEN = [row({ chain: { amount: usdc(150), status: "open" } })];
const CANCELLED = [row({ chain: { amount: usdc(150), status: "cancelled" } })];
const FORM = (rows: Row[]) => [ready(rows), "10", "Bob Ltd", "Site"];

describe("the list after an invoice is opened, then another is cancelled", () => {
  it("control: when the reads finish in the order they began, the list ends with the cancel's result", async () => {
    let first!: (r: Row[]) => void;
    const slow = () => new Promise<Row[]>((res) => (first = res));
    const r = await render(FORM(OPEN), [slow, async () => CANCELLED]);
    await submit(r.tree)(); // opens an invoice; its list read (slow) is now under way
    await settle();
    first(OPEN); // the slow read ends first...
    await settle();
    await click(r.tree, "Cancel invoice")(); // ...then the cancel and its read
    await settle();
    expect((last(r.setters, 0).rows[0]!.chain as { status: string }).status).toBe("cancelled");
  });

  it("an older, slower list read does not put a cancelled invoice back as open", async () => {
    let first!: (r: Row[]) => void;
    const slow = () => new Promise<Row[]>((res) => (first = res));
    const r = await render(FORM(OPEN), [slow, async () => CANCELLED]);
    await submit(r.tree)(); // opens an invoice; busy is cleared, its list read is under way and has seen X open
    await settle();
    await click(r.tree, "Cancel invoice")(); // the freelancer cancels X while that read is still running
    await settle();
    expect((last(r.setters, 0).rows[0]!.chain as { status: string }).status).toBe("cancelled");
    first(OPEN); // the older read finishes last, with X as it was before the cancel
    await settle();
    // Fails today: the stale list overwrites the newer one, so X is "Open, waiting for payment" again, with its pay link.
    expect((last(r.setters, 0).rows[0]!.chain as { status: string }).status).toBe("cancelled");
  });
});
