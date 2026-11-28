// Adversary i16. Goal 3 (a page offers an action while an earlier action of the same kind may still land; a page shows
// an invoice as open and payable when that is not known).
//
// Promises (docs/decisions.md, Codex invoices R3 #1 and #2, and adversary i15):
//  - #2 / header of apps/web/src/app/invoices/page.tsx (CANCEL_PENDING_KEY): after a cancellation whose answer was lost,
//    "until the invoice reads cancelled or paid, or open at a ledger past it, the row says 'Cancelling ... Do not share
//    its pay link meanwhile' and offers neither its pay link nor Cancel".
//  - #1 / pay-client.tsx PENDING_KEY: a lost payment is kept in this browser "so a reload or another tab still holds back
//    a second payment", and a press "that outruns the render" is held too. i15 made the same point for a cancellation: an
//    attempt "clears only its own record".
//
// Defect 1 (invoices page): cancel() puts the held state on the row only through refresh(). When the list read that
// follows a lost answer fails (the RPC does not answer, the database does not answer), listFailed() only changes the
// notice. The page keeps drawing the old row: "Open, waiting for payment", the pay link, Copy pay link and Cancel invoice,
// while the cancellation may still land (record caracal.invoiceCancelPending is already in localStorage).
//
// Defect 2 (pay page): payNow() reads the lost-payment record once at the press, then waits (invoice re-read, balance,
// ledger, kit) and only then writes its own record, unconditionally replacing any, and removes it unconditionally on a
// not-sent or failed outcome. A second tab whose payment's answer was lost in that window has its record overwritten (or,
// with a later ledger, erased by this attempt's own "not sent"), so after this the earlier payment, which may still land,
// is no longer held back anywhere.
//
// Real: the two pages and src/lib/invoices/*; faked: network calls, the kit, React state (as codex-invoices-r3.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));
const CANCEL_KEY = "caracal.invoiceCancelPending";
const PAY_KEY = `caracal.payPending.${SPLIT}.${REF}`;

type El = { props?: { children?: unknown; onClick?: () => unknown; disabled?: boolean } };
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
function button(node: unknown, text: string): El | null {
  let found: El | null = null;
  walk(node, (el) => {
    if (!found && typeof el.props?.onClick === "function" && texts(el.props.children).includes(text)) found = el;
  });
  return found;
}
const settle = () => new Promise((r) => setTimeout(r, 10));

// React state stub whose setters are recorded, and whose states can be replaced to draw the page again.
let states: unknown[] = [];
let slot = 0;
const setters: { i: number; v: unknown }[] = [];
function stubReact() {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = slot++;
        return [at < states.length ? states[at] : typeof init === "function" ? (init as () => unknown)() : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: () => {},
    };
  });
}
const lastSet = (i: number) => setters.filter((x) => x.i === i).at(-1)?.v;

function storage(kept: Map<string, string>, extra: object = {}) {
  vi.stubGlobal("window", { ...extra, localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding", "@/lib/supabase/client"]) vi.doUnmock(m);
  vi.resetModules();
  setters.length = 0;
  slot = 0;
});

// ---- defect 1: the invoices page ------------------------------------------------------------------------------
const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000 }) as Row;

async function invoicesPage(kept: Map<string, string>, o: { outcome: unknown; listFails: boolean }) {
  storage(kept, { location: { replace: vi.fn(), origin: "https://caracal.test" } });
  states = [{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [openRow()] }];
  slot = 0;
  stubReact();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: async () => o.outcome };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({
    ...(await vi.importActual<object>("../src/lib/invoices/rows")),
    // The list read after the write: the Stellar RPC does not answer (or, when it does, still reads the invoice open).
    loadRows: async () => {
      if (o.listFails) throw new Error("The Stellar network did not answer within 20 s");
      return [openRow()];
    },
  }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { mod, first: mod.default() };
}

/** The page drawn again with the state the setters left it in (the load state is slot 0). */
function redraw(mod: { default: () => unknown }, initial: unknown) {
  states = [lastSet(0) ?? initial, "", "", "", lastSet(4) ?? null, lastSet(5) ?? null];
  slot = 0;
  return mod.default();
}

describe("adversary i16 (1): an unconfirmed cancellation, then a list read that fails", () => {
  it("control: when the list read after a lost cancellation works, the row is held (no pay link, no Cancel)", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, { outcome: { kind: "unknown", message: "Relayer request failed with status 504" }, listFails: false });
    const initial = p.first;
    await button(initial, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1060 }); // the cancellation may still land until ledger 1060
    const after = redraw(p.mod, undefined);
    expect(texts(after)).toMatch(/Cancelling: Caracal could not confirm the cancellation/);
    expect(button(after, "Cancel invoice")).toBeNull();
    expect(texts(after)).not.toMatch(/Copy pay link/);
  });

  it("when the list read after a lost cancellation fails, the row is still held, not drawn as open with its pay link and Cancel", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, { outcome: { kind: "unknown", message: "Relayer request failed with status 504" }, listFails: true });
    await button(p.first, "Cancel invoice")!.props!.onClick!();
    await settle();
    // The earlier cancellation is on record: it may still go through until ledger 1060.
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1060 });
    const after = redraw(p.mod, { kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [openRow()] });
    const text = texts(after);
    expect(text).not.toMatch(/Open, waiting for payment/);
    expect(text).not.toMatch(/Copy pay link/);
    expect(button(after, "Cancel invoice")).toBeNull();
  });
});

// ---- defect 2: the pay page -------------------------------------------------------------------------------------
type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };
const OPEN: Inv = { amount: usdc(150), status: "open" };

async function payPage(kept: Map<string, string>, o: { onLedgerRead?: () => void; outcome: unknown }) {
  storage(kept);
  states = [{ kind: "invoice", invoice: OPEN, txHash: null }, PAYER, { kind: "idle" }, null];
  slot = 0;
  stubReact();
  const pay = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      latestLedger: async () => {
        o.onLedgerRead?.();
        return 1000;
      },
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      readInvoice: async () => OPEN,
      readInvoiceAt: async () => ({ invoice: OPEN, ledger: 1000 }),
      readUsdcBalance: async () => usdc(1000),
      findPaymentTx: async () => null,
      payInvoice: (...a: unknown[]) => (pay(...a), Promise.resolve(o.outcome)),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), pay };
}

describe("adversary i16 (2): a payment of the same invoice whose answer another tab lost while this tab was preparing its own", () => {
  const NOT_SENT = { kind: "not-sent", message: "The passkey prompt was closed." };

  it("control: with no other record, a not-sent attempt leaves no record", async () => {
    const kept = new Map<string, string>();
    const p = await payPage(kept, { outcome: NOT_SENT });
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(p.pay).toHaveBeenCalledTimes(1);
    expect(kept.has(PAY_KEY)).toBe(false);
  });

  it("the other tab's record (its payment may land until ledger 1090) is not erased by this attempt's own not-sent outcome", async () => {
    const kept = new Map<string, string>();
    // The press found no record. While this tab reads the ledger, the other tab's payment goes out and its answer is lost.
    const p = await payPage(kept, { outcome: NOT_SENT, onLedgerRead: () => void kept.set(PAY_KEY, "1090") });
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    // Whatever this tab did, the other payment may still land until ledger 1090 and must still be held back.
    const stored = Number(kept.get(PAY_KEY) ?? 0);
    expect(stored).toBeGreaterThanOrEqual(1090);
  });
});
