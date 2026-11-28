// The invoices page: opening, listing and cancelling invoices on the user's split contract.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { TOKENS } from "../src/lib/stellar/config";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";
const HASH = "e".repeat(64);
const usdc = (n: number) => BigInt(Math.round(n * 1e7));

type El = { props?: { children?: unknown; onClick?: () => unknown; onSubmit?: (e: { preventDefault(): void }) => unknown; href?: string } };
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
const hrefs = (node: unknown) => {
  const out: string[] = [];
  walk(node, (el) => void (el.props?.href && out.push(el.props.href)));
  return out;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const m of ["react", "@/lib/supabase/client", "@/lib/stellar/kit", "@/lib/invoices/chain", "@/lib/invoices/details", "@/lib/invoices/rows", "@/lib/auth/wallet-binding"]) vi.doUnmock(m);
  vi.resetModules();
});

type Row = { invoice_ref: string; split: string; client_name: string; description: string; created_at: string; chain: unknown; txHash: string | null };
const row = (over: Partial<Row> = {}): Row => ({ invoice_ref: REF, split: SPLIT, client_name: "Ada Ltd", description: "Logo", created_at: "2026-11-27T10:00:00Z", chain: { amount: usdc(150), status: "open" }, txHash: null, ...over });
// Fixture fix (2026-11-27, adversary i2): the ready state records the account it was loaded for, and the fake
// auth has onAuthStateChange like the real one, since the page now follows the signed-in account.
const ready = (rows: Row[]) => ({ kind: "ready", account: "A", wallet: WALLET, split: SPLIT, rows });

/** States, in order: load, amount, client, description, busy, notice, copied. */
async function render(states: unknown[], o: { config?: unknown; outcome?: unknown; rows?: Row[] } = {}) {
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
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  const order: string[] = [];
  const calls = { create: vi.fn(), cancel: vi.fn(), save: vi.fn(), remove: vi.fn() };
  vi.doMock("@/lib/invoices/chain", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/chain")>("../src/lib/invoices/chain");
    return {
      ...actual,
      readConfig: async () => ("config" in o ? o.config : { owner: WALLET, token: TOKENS.usdc }),
      createInvoice: (...a: unknown[]) => (order.push("chain"), calls.create(...a), Promise.resolve(o.outcome)),
      cancelInvoice: (...a: unknown[]) => (calls.cancel(...a), Promise.resolve(o.outcome)),
    };
  });
  vi.doMock("@/lib/invoices/details", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/details")>("../src/lib/invoices/details");
    return {
      ...actual,
      listDetails: async () => [],
      saveDetails: async (...a: unknown[]) => (order.push("save"), calls.save(...a)),
      deleteDetails: async (...a: unknown[]) => calls.remove(...a),
    };
  });
  vi.doMock("@/lib/invoices/rows", async () => {
    const actual = await vi.importActual<typeof import("../src/lib/invoices/rows")>("../src/lib/invoices/rows");
    return { ...actual, loadRows: async () => o.rows ?? [] };
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
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { replace, origin: "https://caracal.test" } });
  const mod = await import("../src/app/invoices/page");
  return { tree: mod.default(), effects, setters, calls, order, replace };
}
const last = (s: { i: number; v: unknown }[], i: number) => s.filter((x) => x.i === i).at(-1)?.v as { kind?: string; message?: string } | string;
const settle = () => new Promise((r) => setTimeout(r, 10));
const FORM = (amount: string, client = "Ada Ltd") => [ready([]), amount, client, "Logo"];

describe("loading", () => {
  it("a wallet with a split on chain shows the list", async () => {
    const r = await render([{ kind: "loading" }], { rows: [row()] });
    await r.effects[0]!();
    await settle();
    expect(last(r.setters, 0)).toMatchObject({ kind: "ready", wallet: WALLET, split: SPLIT });
  });
  it("a split that is not on chain yet says so and links to /split", async () => {
    const r = await render([{ kind: "loading" }], { config: null });
    await r.effects[0]!();
    await settle();
    expect(last(r.setters, 0)).toMatchObject({ kind: "no-split", split: SPLIT });
    vi.resetModules();
    const v = await render([{ kind: "no-split", split: SPLIT }]);
    expect(texts(v.tree)).toContain("not on Stellar yet");
    expect(hrefs(v.tree)).toContain("/split");
  });
  it("a contract at the split address that is not a Caracal split owned by this wallet is refused", async () => {
    const r = await render([{ kind: "loading" }], { config: { owner: WALLET, token: TOKENS.xlm } });
    await r.effects[0]!();
    await settle();
    expect(String((last(r.setters, 0) as { message: string }).message)).toMatch(/not a Caracal split/);
  });
});

describe("opening an invoice", () => {
  it("saves the details first, then opens it on chain with the exact amount and a fresh 32 character id", async () => {
    const r = await render(FORM("150.50"), { outcome: { kind: "done", hash: HASH } });
    await submit(r.tree)();
    await settle();
    expect(r.order.slice(0, 2)).toEqual(["save", "chain"]);
    const [, split, ref, amount] = r.calls.create.mock.calls[0];
    expect(split).toBe(SPLIT);
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(amount).toBe(usdc(150.5));
    // The same id is the one the details are filed under, and nothing but the id and amount goes on chain.
    expect(r.calls.save.mock.calls[0][1]).toMatchObject({ invoice_ref: ref, split: SPLIT, client_name: "Ada Ltd" });
    // Changed with Codex invoices R1 #2: a 5th argument, the last ledger the opening can land at (its passkey
    // signature's expiry), which is not a contract argument and carries no client detail.
    expect(r.calls.create.mock.calls[0]).toHaveLength(5);
    expect(r.calls.create.mock.calls[0][4]).toBe(1000 + 60);
  });
  it("a bad amount or an empty client name sends nothing", async () => {
    for (const [amount, client, say] of [["abc", "Ada", /Enter the amount/], ["0", "Ada", /Enter the amount/], ["10", "  ", /client's name/]]) {
      const r = await render(FORM(amount as string, client as string), { outcome: { kind: "done", hash: HASH } });
      await submit(r.tree)();
      await settle();
      expect(r.calls.create).not.toHaveBeenCalled();
      expect(r.calls.save).not.toHaveBeenCalled();
      expect(String(last(r.setters, 5))).toMatch(say as RegExp);
      vi.resetModules();
    }
  });
  it("when nothing reached the chain the saved details are removed again", async () => {
    const r = await render(FORM("10"), { outcome: { kind: "not-sent", message: "The passkey prompt was closed." } });
    await submit(r.tree)();
    await settle();
    expect(r.calls.remove).toHaveBeenCalledWith(expect.anything(), r.calls.create.mock.calls[0][2]);
    expect(String(last(r.setters, 5))).toMatch(/did not go through.*passkey prompt was closed/);
  });
  it("a lost answer keeps the details and tells the user not to repeat it", async () => {
    const r = await render(FORM("10"), { outcome: { kind: "unknown", message: "timed out" } });
    await submit(r.tree)();
    await settle();
    expect(r.calls.remove).not.toHaveBeenCalled();
    expect(String(last(r.setters, 5))).toMatch(/may have gone through. Do not repeat it yet/);
  });
});

describe("the list", () => {
  it("an open invoice shows the amount from the chain, a pay link with only the contract and id, and Cancel", async () => {
    const r = await render([ready([row()])]);
    const t = texts(r.tree);
    expect(t).toMatch(/150.00\s+USDC/);
    expect(t).toContain("Open, waiting for payment");
    expect(t).toContain(`https://caracal.test/pay/${SPLIT}/${REF}`);
    expect(t).not.toContain("?");
    expect(() => click(r.tree, "Copy pay link")).not.toThrow();
  });
  it("Cancel invoice cancels that id on the user's split", async () => {
    const r = await render([ready([row()])], { outcome: { kind: "done", hash: HASH } });
    await click(r.tree, "Cancel invoice")();
    await settle();
    expect(r.calls.cancel.mock.calls[0].slice(1)).toEqual([SPLIT, REF]);
  });
  it("a paid invoice links to the receipt; a cancelled one has no pay link or Cancel", async () => {
    const paid = await render([ready([row({ chain: { amount: usdc(150), status: "paid" }, txHash: HASH })])]);
    expect(hrefs(paid.tree)).toContain(`/receipt/${HASH}`);
    vi.resetModules();
    const cancelled = await render([ready([row({ chain: { amount: usdc(150), status: "cancelled" } })])]);
    expect(texts(cancelled.tree)).toContain("Cancelled");
    expect(texts(cancelled.tree)).not.toContain("/pay/");
    expect(() => click(cancelled.tree, "Cancel invoice")).toThrow();
  });
  it("an invoice the chain does not know and one that cannot be read are different things", async () => {
    const none = await render([ready([row({ chain: null })])]);
    expect(texts(none.tree)).toContain("Not opened on chain");
    vi.resetModules();
    const down = await render([ready([row({ chain: "unreadable" })])]);
    expect(texts(down.tree)).toContain("Status unknown");
    expect(() => click(down.tree, "Remove this entry")).toThrow(); // only a proven absence can be removed
    expect(() => click(none.tree, "Remove this entry")).not.toThrow();
  });
});
