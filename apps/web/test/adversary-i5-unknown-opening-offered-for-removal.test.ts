// Adversary i5. Goal 4 (a status that is not the chain's / "did not go through" when it may have) and goal 5
// (a live invoice no one can see or cancel).
//
// Promise (lib/invoices/chain.ts WriteOutcome): for "unknown", "The answer was lost or unclear. It may have
// landed." The invoices page says so right after a lost answer: "the answer was lost, so it may have gone
// through. Do not repeat it yet. Reload this page and check the list first."
//
// But the list it sends the person to is built from the chain read taken at that very moment, and a read that
// finds no invoice is shown as "Not opened on chain (the opening did not finish)" with a "Remove this entry"
// button (rows.ts statusText; invoices/page.tsx). For a lost answer that read proves nothing: the relayer's
// own wait can time out while the transaction is still to be submitted (relay/channels.ts: WAIT_TIMEOUT, "it
// may still submit"), so the invoice can open a few seconds after the page said it did not. If the person
// presses Remove, deleteDetails drops the client's name for an invoice that then opens on chain: it is listed
// nowhere (the list is built from the saved details), so it can no longer be cancelled from the app.
//
// The page is rendered with the repo's usual React-state stub, as test/invoice-page.test.ts and
// adversary-i4-paid-then-unreadable.test.ts do: the state the page set after the lost answer is fed back in.
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
const settle = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

type Row = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; chain: unknown; txHash: string | null };
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

/**
 * States, in order: load, amount, client, description, busy, notice, copied.
 * `chainSays`: what the chain read finds for the new invoice when the list is rebuilt (null: no such invoice yet).
 */
async function render(states: unknown[], o: { outcome?: unknown; chainSays?: null; refs?: string[] } = {}) {
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
  const removed: string[] = [];
  const created: string[] = [];
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      createInvoice: async (_kit: unknown, _split: string, ref: string) => (created.push(ref), o.outcome),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [],
      saveDetails: async () => {},
      deleteDetails: async (_db: unknown, ref: string) => void removed.push(ref),
    };
  });
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    // The rebuilt list: the invoice just attempted is saved in the details, and the chain has nothing for it yet.
    return {
      ...actual,
      loadRows: async (): Promise<Row[]> =>
        created.map((ref) => ({ invoice_ref: ref, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", chain: o.chainSays ?? null, txHash: null })),
    };
  });
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test" } });
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), setters, removed, created };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v;

/** Opens an invoice whose answer is lost, then returns the page as the person is left with it (and the id's removal calls). */
async function afterLostAnswer(outcome: unknown) {
  const r = await render([ready([]), "10", "Ada Ltd", "Logo"], { outcome });
  await submit(r.tree)();
  await settle();
  const load = last(r.setters, 0);
  const notice = last(r.setters, 5);
  vi.resetModules();
  const again = await render([load, "", "", "", null, notice], { outcome, refs: r.created });
  // The second render has its own `created`: the new row's ref comes from the first render.
  return { tree: again.tree, notice, load, removed: again.removed, ref: r.created[0]! };
}

describe("an invoice whose opening answer was lost", () => {
  it("control: after a lost answer the page says it may have gone through, and lists the invoice", async () => {
    const r = await afterLostAnswer({ kind: "unknown", message: "timed out" });
    expect(String(r.notice)).toMatch(/may have gone through. Do not repeat it yet/);
    expect((r.load as { rows: Row[] }).rows.map((x) => x.invoice_ref)).toEqual([r.ref]);
  });

  it("is not called 'did not finish', and cannot be removed, while it may still land", async () => {
    const r = await afterLostAnswer({ kind: "unknown", message: "timed out" });
    // Fails today: the row says "Not opened on chain (the opening did not finish)" and offers "Remove this entry",
    // which deletes the details of an invoice that the notice above has just said may have gone through.
    expect(texts(r.tree)).not.toMatch(/the opening did not finish/);
    expect(() => click(r.tree, "Remove this entry")).toThrow();
  });
});
