// Codex invoices R4 (REVISE, 3 findings: two P1, one P2).
//
// #1: an old "Check again" established that an earlier payment had expired and then removed whatever record was
// stored, including a newer payment's begun meanwhile in another tab. #2: a payment whose record storage refused was
// sent anyway, so after a lost answer and a reload nothing held back a second payment (the cancellation likewise).
// #3: two tabs could both read no record before either wrote one, and payBy/cancelBy as the identity let one
// attempt's outcome clear the other's record. Now (src/lib/invoices/attempt.ts) every payment and cancellation is
// begun under the invoice's Web Lock, only when no record is there, and read back before anything is signed; each
// has its own id (kept beside the last ledger, which stays where it was); a record is removed only by its own
// attempt, or by a check that established that exact attempt can no longer land.
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

/** This browser's storage; `refuse`: setItem throws (blocked, or full). */
function storage(kept: Map<string, string>, extra: object = {}, refuse = false) {
  vi.stubGlobal("window", {
    ...extra,
    localStorage: {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (refuse) throw new Error("QuotaExceededError");
        kept.set(k, v);
      },
      removeItem: (k: string) => void kept.delete(k),
    },
  });
}

/** Another tab of this browser holds every lock: requests with ifAvailable get none. */
function lockHeldElsewhere() {
  vi.stubGlobal("navigator", { locks: { request: async (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) => cb(null) } });
}

function stubReact(states: unknown[]) {
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
      useEffect: () => {},
    };
  });
  return { setters };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v as { kind: string; text?: string; checkFirst?: boolean } | number | null | undefined;

afterEach(() => {
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

type Inv = { amount: bigint; status: "open" | "paid" | "cancelled" };
const OPEN: Inv = { amount: usdc(150), status: "open" };
const shownOpen = { kind: "invoice", invoice: OPEN, txHash: null };

async function payPage(states: unknown[], opts: { kept: Map<string, string>; outcome?: unknown; readAt?: number; duringCheck?: () => void; refuse?: boolean }) {
  storage(opts.kept, {}, opts.refuse);
  const r = stubReact(states);
  const pay = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      latestLedger: async () => 1000,
      readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }),
      readInvoice: async () => OPEN,
      readInvoiceAt: async () => {
        opts.duringCheck?.();
        return { invoice: OPEN, ledger: opts.readAt };
      },
      readUsdcBalance: async () => usdc(1000),
      findPaymentTx: async () => HASH,
      payInvoice: (...a: unknown[]) => (pay(...a), Promise.resolve(opts.outcome)),
    };
  });
  vi.doMock("@/lib/stellar/kit", () => ({ getKit: async () => ({ events: {}, connectWallet: async () => ({ contractId: PAYER }) }) }));
  const mod = await import("../src/app/pay/[split]/[ref]/pay-client");
  return { tree: mod.default({ split: SPLIT, invoiceRef: REF }), pay, ...r };
}

const row = (over: Partial<Row> = {}): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000, ...over }) as Row;
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

async function invoicesPage(kept: Map<string, string>, outcome: unknown, refuse = false) {
  storage(kept, { location: { replace: vi.fn(), origin: "https://caracal.test" } }, refuse);
  const r = stubReact([ready([row()])]);
  const cancel = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: (...a: unknown[]) => (cancel(...a), Promise.resolve(outcome)) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [row()] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), cancel, ...r };
}
const LOST = { kind: "unknown", message: "Relayer request failed with status 504" };
const DONE = { kind: "done", hash: HASH };
const noticeText = (p: { tree: unknown; setters: { i: number; v: unknown }[] }) => p.setters.map((s) => (typeof s.v === "string" ? s.v : typeof s.v === "object" && s.v !== null && "text" in s.v ? String((s.v as { text: unknown }).text) : "")).join(" | ");

describe("Codex invoices R4 #1: an old 'Check again' never removes a newer payment's record", () => {
  it("control: 'Check again' settles the earlier attempt it read once the invoice is read open past its last ledger", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, 1060], { kept, readAt: 1061 });
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    expect(kept.has(PAY_KEY)).toBe(false);
  });

  it("a newer payment begun while the old check runs keeps its record, and Pay stays held for it", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    // While this tab's check reads the invoice, another tab settles the old attempt itself and begins a new one.
    const duringCheck = () => {
      kept.set(`${PAY_KEY}.id`, "other-tab-attempt");
      kept.set(PAY_KEY, "1090");
    };
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, 1060], { kept, readAt: 1061, duringCheck });
    await button(p.tree, "Check again")!.props!.onClick!();
    await settle();
    expect(kept.get(PAY_KEY), "the newer payment's record was removed by the old check").toBe("1090");
    const said = last(p.setters, 2) as { text?: string; checkFirst?: boolean };
    expect(said.checkFirst).toBe(true);
    expect(said.text).toMatch(/ledger 1090/);
  });
});

describe("Codex invoices R4 #2: nothing is sent when this browser will not keep the record", () => {
  it("control: with working storage the payment is recorded with its id before it is sent, and a certain outcome removes both", async () => {
    const kept = new Map<string, string>();
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, null], { kept, outcome: { kind: "not-sent", message: "The passkey prompt was closed." } });
    let seen: [string | undefined, string | undefined] = [undefined, undefined];
    p.pay.mockImplementation(() => (seen = [kept.get(PAY_KEY), kept.get(`${PAY_KEY}.id`)]));
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(p.pay).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe("1060");
    expect(seen[1]).toBeTruthy();
    expect(kept.has(PAY_KEY)).toBe(false);
    expect(kept.has(`${PAY_KEY}.id`)).toBe(false);
  });

  it("a payment is not sent when storage refuses its record, and the page says why", async () => {
    const kept = new Map<string, string>();
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, null], { kept, outcome: LOST, refuse: true });
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(p.pay).not.toHaveBeenCalled();
    expect((last(p.setters, 2) as { text?: string }).text).toMatch(/would not let Caracal keep a record of the payment, so nothing was sent/);
  });

  it("a cancellation is not sent when storage refuses its record, and the page says why", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, LOST, true);
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(p.cancel).not.toHaveBeenCalled();
    expect(noticeText(p)).toMatch(/would not let Caracal keep a record of the cancellation, so nothing was cancelled/);
  });
});

describe("Codex invoices R4 #3: the record is checked and written under the invoice's lock", () => {
  it("a payment started while another tab holds the invoice's lock sends nothing", async () => {
    const kept = new Map<string, string>();
    const p = await payPage([shownOpen, PAYER, { kind: "idle" }, null], { kept, outcome: DONE });
    lockHeldElsewhere();
    await button(p.tree, "Pay")!.props!.onClick!();
    await settle();
    expect(p.pay).not.toHaveBeenCalled();
    expect((last(p.setters, 2) as { text?: string; checkFirst?: boolean }).text).toMatch(/Another tab of this browser is starting a payment/);
  });

  it("a cancellation started while another tab holds the lock sends nothing", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, DONE);
    lockHeldElsewhere();
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(p.cancel).not.toHaveBeenCalled();
    expect(noticeText(p)).toMatch(/Another tab of this browser is starting a cancellation/);
  });

  it("control: a cancellation whose answer is lost is recorded with its id, as before with its last ledger", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, LOST);
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(p.cancel).toHaveBeenCalledTimes(1);
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1060 });
    expect(typeof JSON.parse(kept.get(`${CANCEL_KEY}.ids`) ?? "{}")[REF]).toBe("string");
  });
});

describe("Codex invoices R4: the attempt record itself", () => {
  async function guard(kept: Map<string, string>) {
    storage(kept);
    return import("../src/lib/invoices/attempt");
  }

  it("a second attempt is held while the first is recorded, and only the first's own end removes it", async () => {
    const kept = new Map<string, string>();
    const g = await guard(kept);
    const slot = g.paySlot(SPLIT, REF);
    const a = await g.beginAttempt(slot, 1060);
    expect(a.ok).toBe(true);
    const b = await g.beginAttempt(slot, 1060);
    expect(b).toMatchObject({ ok: false, held: { by: 1060 } });
    await g.endAttempt(slot, "some-other-attempt"); // another attempt's end leaves this record alone
    expect(kept.get(PAY_KEY)).toBe("1060");
    if (a.ok) expect(await g.endAttempt(slot, a.attempt.id)).toBe(true);
    expect(kept.has(PAY_KEY)).toBe(false);
  });

  it("a record an earlier version wrote (a bare ledger) is read as an attempt and held", async () => {
    const kept = new Map([[PAY_KEY, "1060"]]);
    const g = await guard(kept);
    const slot = g.paySlot(SPLIT, REF);
    expect(g.attemptIn(slot)).toEqual({ id: "legacy-1060", by: 1060 });
    expect(await g.beginAttempt(slot, 1100)).toMatchObject({ ok: false, held: { by: 1060 } });
  });

  it("without Web Locks nothing is begun", async () => {
    const kept = new Map<string, string>();
    const g = await guard(kept);
    vi.stubGlobal("navigator", {});
    expect(await g.beginAttempt(g.paySlot(SPLIT, REF), 1060)).toEqual({ ok: false, refused: "unsupported" });
    expect(kept.size).toBe(0);
  });
});
