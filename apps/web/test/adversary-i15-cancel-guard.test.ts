// Adversary i15. Goal 3 (a page offers an action, Cancel, while an earlier action of the same kind may still land).
//
// Promise (docs/decisions.md, Codex invoices R3 #2, and the header of apps/web/src/app/invoices/page.tsx
// CANCEL_PENDING_KEY): "a cancellation whose answer was lost ... is kept in this browser (localStorage
// `caracal.invoiceCancelPending`); until the invoice reads cancelled or paid, or open at a ledger past it, the row
// says it may still go through ... and offers neither its pay link nor Cancel". The pay page keeps the same rule on
// every copy of the page ("a press that outruns the render too", and "another tab"): payNow() reads the record again
// at the press and refuses.
//
// cancel() on the invoices page never reads the record at the press. A list that was rendered before the record was
// written (another tab of this browser lost an answer a moment ago, or this tab's own list refresh failed after its
// lost answer, so the old row with its Cancel button stays) still offers Cancel, and pressing it
//   (1) sends a second cancellation while the first may still land, and
//   (2) if that second attempt is then refused before sending (the passkey prompt is closed), erases the record
//       with setCancelPending(ref, null), so the first cancellation, which may still land, is no longer held
//       anywhere: after a reload the row is open with its pay link and Cancel.
//
// Real: the invoices page and src/lib/invoices/*; faked: the network calls, React state (as codex-invoices-r3.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";
import type { Row } from "../src/lib/invoices/rows";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const CANCEL_KEY = "caracal.invoiceCancelPending";
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

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

function stubReact(states: unknown[]) {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : typeof init === "function" ? (init as () => unknown)() : init, () => {}];
      },
      useEffect: () => {},
    };
  });
}

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

// An open invoice as the list was rendered, before any record of a pending cancellation existed.
const openRow = (): Row =>
  ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", opens_by_ledger: 900, chain: { amount: usdc(150), status: "open" }, txHash: null, readAt: 1000 }) as Row;

async function invoicesPage(kept: Map<string, string>, outcome: unknown) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), origin: "https://caracal.test" },
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
  });
  stubReact([{ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows: [openRow()] }]);
  const cancel = vi.fn();
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return { ...actual, readConfig: async () => ({ owner: WALLET, token: TOKENS.usdc }), cancelInvoice: (...a: unknown[]) => (cancel(...a), Promise.resolve(outcome)) };
  });
  vi.doMock("@/lib/invoices/details", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/details")), listDetails: async () => [] }));
  vi.doMock("@/lib/invoices/rows", async () => ({ ...(await vi.importActual<object>("../src/lib/invoices/rows")), loadRows: async () => [openRow()] }));
  vi.doMock("@/lib/auth/wallet-binding", () => ({ browserStore: {}, mayRestoreWallet: async () => true }));
  const auth = { getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: async () => ({ rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, connectWallet: async () => ({ contractId: WALLET }) }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), cancel };
}

describe("adversary i15: a second Cancel while an earlier cancellation of the same invoice may still land", () => {
  it("control: with no earlier cancellation recorded, Cancel sends one, with its last ledger (ledger read + 60)", async () => {
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, { kind: "done", hash: "d".repeat(64) });
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    expect(p.cancel).toHaveBeenCalledTimes(1);
    expect(p.cancel.mock.calls[0].at(-1)).toBe(1060);
  });

  it("an earlier cancellation recorded by another tab holds Cancel back at the press, as the pay page does for Pay", async () => {
    // Another tab of this browser lost its cancellation's answer after this tab drew its list: it may land until ledger 1090.
    // Test change (adversary i16): the record is written after the list is drawn, as described above; written
    // before, the row is now drawn held, with no Cancel to press. The assertions are unchanged.
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, { kind: "done", hash: "d".repeat(64) });
    kept.set(CANCEL_KEY, JSON.stringify({ [REF]: 1090 }));
    expect(texts(p.tree)).toContain("Cancel invoice"); // the stale row still offers it
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    // Nothing may be sent while the earlier one may still land.
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it("a second attempt refused before sending does not erase the record of the earlier one that may still land", async () => {
    // Test change (adversary i16): written after the list is drawn, as in the test above. Assertion unchanged.
    const kept = new Map<string, string>();
    const p = await invoicesPage(kept, { kind: "not-sent", message: "The passkey prompt was closed." });
    kept.set(CANCEL_KEY, JSON.stringify({ [REF]: 1090 }));
    await button(p.tree, "Cancel invoice")!.props!.onClick!();
    await settle();
    // The earlier cancellation (ledger 1090) is still unresolved; its record must survive.
    expect(JSON.parse(kept.get(CANCEL_KEY) ?? "{}")).toEqual({ [REF]: 1090 });
  });
});
