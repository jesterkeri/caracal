// Adversary i12. Goal 4 (a person is told something false: "the opening did not finish" for an invoice whose
// opening is on its way) and goal 5 (a control offered that must not be: "Remove this entry" on an invoice
// that is about to be live), when the opening was started on another device or browser of the same account.
//
// Promise (invoices/page.tsx create(): "The details are saved first, so an invoice that reached the chain
// always has its client name here."; docs/decisions.md rows 2026-11-27 i5, i7 and i11: a row not yet on chain
// offers no "Remove this entry" while its opening can still land, because removing the details of an invoice
// that then lands leaves a live invoice listed nowhere and impossible to cancel from the app; statusText:
// "Not opened on chain (the opening did not finish)" is for an opening that did not finish).
//
// The only thing that holds "Remove this entry" back is a record in THIS browser's localStorage
// (caracal.invoiceOpeningUnknown, kept by rememberUnknownOpening). The details row itself is saved in the
// account's Supabase rows BEFORE anything is sent, and carries created_at (supabase/migrations/
// 20261127000000_invoice_details.sql), so any other device or browser signed in to the same account sees a
// row a few seconds old whose invoice is still in the passkey prompt or in the relay. That page has no
// record, reads "no such invoice" from the chain, and says "Not opened on chain (the opening did not
// finish)" with "Remove this entry". Pressing it deletes the details; the opening then lands, and the
// invoice is live on chain with a working pay link and listed nowhere.
//
// Harness: the repo's React-state stub (as adversary-i11-opened-then-not-on-chain.test.ts), but the page's
// own load effect is run, so the rows come from the real loadRows/readInvoice/shown path over a fake RPC that
// answers void (no such invoice). Only the saved rows (Supabase) and the kit are faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";

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

type Saved = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; opens_by_ledger: number };
type Answer = "no-invoice-yet" | "open";

/**
 * Renders the invoices page, runs its load effect and returns the tree as it reads once loaded.
 * `localStorage` starts empty: this browser has no record of any opening (it is another device's).
 */
async function loadedPage(saved: Saved[], answer: Answer) {
  const setters: { i: number; v: unknown }[] = [];
  const effects: (() => unknown)[] = [];
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  const doReact = async (states: unknown[]) => {
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
        useEffect: (fn: () => unknown) => void effects.push(fn),
      };
    });
  };
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }) };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [...saved],
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
    simulateTransaction: async () => ({ id: "1", latestLedger: 2000, events: [], _parsed: true, result: { auth: [], retval: answer === "open" ? open : none }, transactionData: {}, minResourceFee: "0" }),
    getLatestLedger: async () => ({ sequence: 2000 }),
    getEvents: async () => ({ events: [], cursor: "" }),
  };
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: async () => ({ rpc, connectWallet: async () => ({ contractId: WALLET }) }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), origin: "https://caracal.test", reload: vi.fn() }, localStorage });

  await doReact([]);
  let mod = await import("../src/app/invoices/page");
  mod.default();
  await effects[0]!(); // the page's load: sign-in, wallet, config, then the saved rows joined with the chain
  await until(() => (setters.filter((s) => s.i === 0).at(-1)?.v as { kind?: string } | undefined)?.kind === "ready");
  const load = setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; rows?: unknown[] } | undefined;
  expect(load?.kind).toBe("ready");

  // Render again with the loaded state, as React would after setLoad.
  vi.resetModules();
  await doReact([load]);
  mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), saved };
}

// opens_by_ledger (Codex invoices R1 #2 fixture): a row saved within the hour can still open after the ledger read now
// (2000); one saved a week ago could open only up to a ledger long past.
const row = (created_at: string): Saved => ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at, opens_by_ledger: Date.now() - Date.parse(created_at) < 3_600_000 ? 2060 : 1000 });

describe("a row saved moments ago by another device, whose opening is still on its way", () => {
  it("control: when the read sees the invoice, it is listed open with its link and no Remove button", async () => {
    const { tree } = await loadedPage([row(new Date().toISOString())], "open");
    expect(texts(tree)).toMatch(/Ada Ltd/);
    expect(texts(tree)).toMatch(/Open, waiting for payment/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });

  it("control: a row saved a week ago that the chain has no invoice for is rightly offered for removal", async () => {
    const { tree } = await loadedPage([row("2026-11-20T10:00:00Z")], "no-invoice-yet");
    expect(texts(tree)).toMatch(/the opening did not finish/);
    expect(() => click(tree, "Remove this entry")).not.toThrow();
  });

  it("a row created seconds ago, not yet on chain, must not say the opening did not finish or offer Remove", async () => {
    const { tree, saved } = await loadedPage([row(new Date(Date.now() - 20_000).toISOString())], "no-invoice-yet");
    expect(saved).toHaveLength(1);
    expect(texts(tree)).toMatch(/Ada Ltd/);
    // Fails today: with no record in this browser's localStorage the row reads
    // "Not opened on chain (the opening did not finish)" and offers "Remove this entry",
    // although its details were saved 20 s ago, before the opening was sent.
    expect(texts(tree)).not.toMatch(/the opening did not finish/);
    expect(() => click(tree, "Remove this entry")).toThrow();
  });
});
