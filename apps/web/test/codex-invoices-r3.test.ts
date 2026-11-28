// Codex invoices R3 #1 and #2.
//
// #1: a payment whose answer was lost, then "Check again" reading the invoice open while it was still pending,
// cleared the uncertainty and allowed a second attempt; a later attempt's failure then read as "the payment was not
// made" although the first had landed. Now the payment carries its last ledger, a lost answer is kept in this browser
// until the invoice reads paid or cancelled, or open at a ledger past that one, and a later attempt's failure is said
// of that attempt only, after the invoice is read again.
// #2: a cancellation whose answer was lost left the row open, with its pay link and Cancel, after a refresh read it
// open; the doubt was only in a passing notice. Now the cancellation carries its last ledger, kept in this browser,
// and the row says it may still go through, with no pay link or Cancel, until it is settled.
//
// Real: the two pages and src/lib/invoices/* except the network calls, which are faked; React's state is stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const PAYER = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const HASH = "d".repeat(64);
const usdc = (n: number) => BigInt(Math.round(n * 1e7));
const PAY_KEY = `caracal.payPending.${SPLIT}.${REF}`;
const CANCEL_KEY = "caracal.invoiceCancelPending";

type El = { props?: { children?: unknown; onClick?: () => unknown; href?: string; disabled?: boolean } };
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

function storage(kept: Map<string, string>, extra: object = {}) {
  vi.stubGlobal("window", { ...extra, localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
}

function stubReact(states: unknown[]) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
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
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  return { effects, setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v as { kind: string; text?: string; checkFirst?: boolean; hash?: string | null } | number | null | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/invoices/chain");
  vi.doUnmock("@/lib/invoices/details");
  vi.doUnmock("@/lib/invoices/rows");
  vi.doUnmock("@/lib/auth/wallet-binding");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
});

// ---- #1: the pay page ----------------------------------------------------------------------------------------
type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };
async function payPage(states: unknown[], chain: { invoices: Inv[]; outcome?: unknown; readAt?: number }, kept: Map<string, string>) {
  storage(kept);
  const r = stubReact(states);
  let reads = 0;
  const pay = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    const next = () => chain.invoices[Math.min(reads++, chain.invoices.length - 1)];
    return {
      ...actual,
      latestLedger: async () => 1000,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      readInvoice: async () => next(),
      readInvoiceAt: async () => ({ invoice: chain.invoices[Math.min(reads, chain.invoices.length - 1)], ledger: chain.readAt }),
      readUsdcBalance: async () => usdc(1000),
      findPaymentTx: async () => HASH,
      payInvoice: (...a: unknown[]) => (pay(...a), Promise.resolve(chain.outcome)),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), pay, ...r };
}
const OPEN: Inv = { amount: usdc(150), status: "open" };
const PAID: Inv = { amount: usdc(150), status: "paid" };
const shownOpen = { kind: "invoice", invoice: OPEN, txHash: null };

describe("Codex invoices R3 #1: a payment whose answer was lost", () => {
  it("is kept in this browser with its last ledger, the ledger read + 60", async () => {
    const kept = new Map<string, string>();
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, null], { invoices: [OPEN], outcome: { kind: "unknown", message: "Relayer request failed with status 504" } }, kept);
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(p.pay.mock.calls[0].at(-1)).toBe(1060);
    expect(kept.get(PAY_KEY)).toBe("1060");
    expect(last(p.setters, 3)).toBe(1060);
  });

  it("after a reload, Pay is held back and the page says the earlier payment may still go through", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, 1060], { invoices: [OPEN] }, kept);
    expect(button(p.tree, "Pay")?.props?.disabled).toBe(true);
    expect(texts(p.tree)).toMatch(/may still go through, until the Stellar network passes ledger 1060/);
    // A press that outruns the render is refused too, and nothing is sent.
    await button(p.tree, "Pay")!.props!.onClick!();
    expect(p.pay).not.toHaveBeenCalled();
  });

  it("'Check again' reading the invoice open at or before its last ledger keeps it unresolved", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, 1060], { invoices: [OPEN], readAt: 1060 }, kept);
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    expect(kept.get(PAY_KEY)).toBe("1060");
    expect(last(p.setters, 2)).toMatchObject({ kind: "message", checkFirst: true });
  });

  it("control: read open past its last ledger, it is settled as not gone through, and the payer may pay", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, 1060], { invoices: [OPEN], readAt: 1061 }, kept);
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    expect(kept.has(PAY_KEY)).toBe(false);
    expect(last(p.setters, 3)).toBeNull();
    const said = last(p.setters, 2) as { kind: string; text?: string; checkFirst?: boolean };
    expect(said.text).toMatch(/did not go through, and it can no longer/);
    expect(said.checkFirst).not.toBe(true);
  });

  it("a later attempt that fails while the invoice is now paid shows it paid, not 'not made'", async () => {
    const kept = new Map<string, string>();
    const failed = { kind: "failed", message: "The network rejected the transaction." };
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, null], { invoices: [OPEN, PAID], outcome: failed }, kept);
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(last(p.setters, 2)).toMatchObject({ kind: "paid" });
    expect(kept.has(PAY_KEY)).toBe(false);
  });
});

// ---- #2: the invoices page ---------------------------------------------------------------------------------
const row = (over: Partial<Row> = {}): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000, ...over }) as Row;
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

async function invoicesPage(states: unknown[], kept: Map<string, string>, outcome?: unknown, rows: Row[] = []) {
  storage(kept, { location: { replace: vi.fn(), origin: "https://caracal.test" } });
  const r = stubReact(states);
  const cancel = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: (...a: unknown[]) => (cancel(...a), Promise.resolve(outcome)) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => rows }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), cancel, ...r };
}

describe("Codex invoices R3 #2: a cancellation whose answer was lost", () => {
  it("is kept in this browser with its last ledger, the ledger read + 60", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage([ready([row()])], kept, { kind: "unknown", message: "Relayer request failed with status 504" });
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(p.cancel.mock.calls[0].at(-1)).toBe(1060);
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1060 });
  });

  /** Loads the list as the page does (rows pass through its row logic), then renders the page with what it loaded. */
  async function loaded(r: Row, kept: Map<string, string>) {
    const first = await invoicesPage([{ kind: "loading" }], kept, undefined, [r]);
    await first.effects[0]!();
    await settle();
    const load = first.setters.filter((x) => x.i === 0).at(-1)?.v as { kind: string; rows: unknown[] };
    expect(load.kind).toBe("ready");
    vi.resetModules();
    return invoicesPage([load], kept);
  }

  it("the row read open at or before its last ledger says it may still go through, with no pay link or Cancel", async () => {
    const kept = new Map([[CANCEL_KEY, JSON.stringify({ [REF]: 1060 })]]);
    const p = await loaded(row({ readAt: 1060 }), kept);
    const t = texts(p.tree);
    expect(t).toMatch(/Cancelling: Caracal could not confirm the cancellation/);
    expect(t).not.toContain("/pay/");
    expect(button(p.tree, "Cancel invoice")).toBeNull();
    expect(button(p.tree, "Copy pay link")).toBeNull();
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1060 });
  });

  it("control: read open past its last ledger, or cancelled, the row is shown as the chain says and the record goes", async () => {
    const kept = new Map([[CANCEL_KEY, JSON.stringify({ [REF]: 1060 })]]);
    const p = await loaded(row({ readAt: 1061 }), kept);
    expect(button(p.tree, "Cancel invoice")).not.toBeNull();
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({});
    vi.resetModules();
    const kept2 = new Map([[CANCEL_KEY, JSON.stringify({ [REF]: 1060 })]]);
    const q = await loaded(row({ readAt: 1010, chain: { amount: usdc(150), status: "cancelled" } }), kept2);
    expect(texts(q.tree)).toContain("Cancelled");
    expect(JSON.parse(kept2.get(CANCEL_KEY) ?? "{}")).toEqual({});
  });
});
