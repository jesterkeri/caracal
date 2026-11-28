// The /split page, rendered with React's state stubbed (the way codex-r5.test.ts
// does for the wallet page). The wallet kit and the split calls are fakes; their
// real behaviour is covered by the other split-*.test.ts files.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

type El = { props?: { children?: unknown; onClick?: () => unknown; disabled?: boolean } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function button(node: unknown, text: string): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = button(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  if (typeof (node as El).props?.onClick === "function" && own.includes(text)) return node as El;
  return button(kids, text);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.doUnmock("@/lib/split/actions");
  vi.resetModules();
});

const SPLIT = splitAddressFor(WALLET);
const POTS = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const FORM = { deployTax: "", deployGoal: "", wdPot: "Spend", wdAmount: "", moveFrom: "Spend", moveTo: "Goal", moveAmount: "", newTax: "", newGoal: "" };
const settle = () => new Promise((r) => setTimeout(r, 20));

type Setter = { i: number; v: unknown };

async function render(opts: {
  states?: unknown[];
  user?: { id: string; email: string } | null;
  kit?: Record<string, unknown>;
  actions?: Record<string, unknown>;
  local?: Map<string, string>;
}) {
  const effects: (() => unknown)[] = [];
  const setters: Setter[] = [];
  const states = opts.states ?? [];
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
  const user = opts.user === undefined ? ME : opts.user;
  const auth = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: user ? { user } : null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  // rpc names its latest ledger: a write reads it first to fix its last ledger (Codex split R3 fixture)
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), ...opts.kit };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  if (opts.actions) {
    vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), ...opts.actions }));
  }
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = opts.local ?? new Map<string, string>();
  const replace = vi.fn();
  vi.stubGlobal("window", {
    location: { replace, reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  const mod = await import("../src/app/split/page");
  return { tree: mod.default(), effects, setters, replace, kit };
}
const last = (setters: Setter[], i: number) => setters.filter((s) => s.i === i).at(-1)?.v as { kind?: string; said?: { tone: string; text: string }; message?: string; loaded?: { kind: string } } | undefined;

const ready = (loaded: unknown) => ({ kind: "ready", wallet: WALLET, loaded });

describe("opening the page", () => {
  it("a signed-out visitor goes to sign in", async () => {
    const p = await render({ user: null });
    p.effects[0]();
    await settle();
    expect(p.replace).toHaveBeenCalledWith("/signin");
  });
  it("a browser with no wallet for this account is sent to the wallet page, and nothing is created", async () => {
    const p = await render({ kit: { connectWallet: vi.fn(async () => null) } });
    p.effects[0]();
    await settle();
    expect(last(p.setters, 0)).toEqual({ kind: "no-wallet" });
    expect(p.kit.connectWallet).not.toHaveBeenCalled(); // the saved session belongs to nobody here: not bound to this account
  });
  it("the saved wallet is restored only for the account it is bound to, then its split is looked up", async () => {
    const loadSplit = vi.fn(async () => ({ kind: "absent", split: SPLIT }));
    const local = new Map([["caracal.walletOwner", ME.id]]);
    const p = await render({ actions: { loadSplit }, local });
    p.effects[0]();
    await settle();
    expect(loadSplit).toHaveBeenCalledWith(p.kit.rpc, WALLET);
    expect(last(p.setters, 0)).toEqual({ kind: "ready", wallet: WALLET, loaded: { kind: "absent", split: SPLIT } });
  });
  it("a wallet that cannot be loaded is named as that, not as a missing split", async () => {
    const local = new Map([["caracal.walletOwner", ME.id]]);
    const p = await render({ kit: { connectWallet: vi.fn(async () => Promise.reject(new Error("IndexedDB is blocked"))) }, local });
    vi.spyOn(console, "error").mockImplementation(() => {});
    p.effects[0]();
    await settle();
    expect(last(p.setters, 0)?.message).toMatch(/could not load your wallet/);
  });
});

describe("what is shown", () => {
  it("no split yet: a deploy form, and no withdraw", async () => {
    const p = await render({ states: [ready({ kind: "absent", split: SPLIT }), FORM, {}, ME] });
    const t = texts(p.tree).join(" ");
    expect(t).toMatch(/Deploy my split contract with my passkey/);
    expect(t).toContain(SPLIT);
    expect(t).not.toMatch(/Withdraw/);
  });
  it("a split that exists is shown with its three pots in USDC, and no deploy is offered", async () => {
    const p = await render({ states: [ready({ kind: "present", split: SPLIT, pots: POTS, config: CONFIG }), FORM, {}, ME] });
    const t = texts(p.tree).join(" ");
    expect(t).toMatch(/Tax/);
    expect(t).toContain("0.001"); // 10,000 stroops
    expect(t).toContain("0.0015");
    expect(t).toContain("0.0075");
    expect(t.replace(/\s+%/g, "%").replace(/\(\s+/g, "(").replace(/\s+/g, " ")).toMatch(/10% to Tax, 15% to Goal and the rest \(75%\) to Spend/);
    expect(t).not.toMatch(/Deploy my split contract/);
    expect(t).toMatch(/Withdraw with my passkey/);
    expect(t).not.toContain("—");
  });
  it("an expired split is not redeployed", async () => {
    const p = await render({ states: [ready({ kind: "archived", split: SPLIT }), FORM, {}, ME] });
    const t = texts(p.tree).join(" ");
    expect(t).toMatch(/must be restored/);
    expect(t).not.toMatch(/Deploy my split contract/);
  });
  it("a network failure is shown as one, with a way to try again", async () => {
    const p = await render({ states: [ready({ kind: "error", split: SPLIT, message: "Caracal could not reach the Stellar network to look for your split contract. Check your connection and try again." }), FORM, {}, ME] });
    expect(texts(p.tree).join(" ")).toMatch(/could not reach the Stellar network/);
    expect(button(p.tree, "Try again")).not.toBeNull();
  });
});

describe("acting", () => {
  const present = ready({ kind: "present", split: SPLIT, pots: POTS, config: CONFIG });

  it("deploy: percentages are checked first; nothing is sent for a bad one", async () => {
    const deploySplit = vi.fn();
    const p = await render({ states: [ready({ kind: "absent", split: SPLIT }), { ...FORM, deployTax: "ten", deployGoal: "15" }, {}, ME], actions: { deploySplit } });
    await button(p.tree, "Deploy my split contract")!.props!.onClick!();
    expect(deploySplit).not.toHaveBeenCalled();
    expect(last(p.setters, 2)?.said?.text).toMatch(/tax percentage must be a number/);
  });
  it("deploy: sends the chosen shares in basis points for this wallet, then reads the chain again", async () => {
    const deploySplit = vi.fn(async () => ({ kind: "done", hash: "ab".repeat(32) }));
    const loadSplit = vi.fn(async () => ({ kind: "present", split: SPLIT, pots: { tax: BigInt(0), goal: BigInt(0), spend: BigInt(0) }, config: CONFIG }));
    const p = await render({ states: [ready({ kind: "absent", split: SPLIT }), { ...FORM, deployTax: "10", deployGoal: "12.5" }, {}, ME], actions: { deploySplit, loadSplit } });
    await button(p.tree, "Deploy my split contract")!.props!.onClick!();
    expect(deploySplit).toHaveBeenCalledWith(p.kit, WALLET, 1000, 1250);
    expect(loadSplit).toHaveBeenCalledTimes(1);
    expect(last(p.setters, 0)?.loaded?.kind).toBe("present");
    expect(last(p.setters, 2)?.said).toMatchObject({ tone: "good", text: "Your split contract deployment went through." });
  });
  it("withdraw: the amount is read exactly and goes with the pot the person chose", async () => {
    const withdrawToWallet = vi.fn(async () => ({ kind: "refused", message: "Too many requests. Nothing was sent. Try again." }));
    const loadSplit = vi.fn();
    const p = await render({ states: [present, { ...FORM, wdPot: "Tax", wdAmount: "0.0005" }, {}, ME], actions: { withdrawToWallet, loadSplit } });
    await button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    expect(withdrawToWallet).toHaveBeenCalledWith(p.kit, WALLET, POTS, "Tax", BigInt(5_000));
    // The relay said nothing was sent: the page says so in the relay's words and does not need to re-read.
    expect(last(p.setters, 2)?.said).toEqual({ tone: "bad", text: "Too many requests. Nothing was sent. Try again." });
    expect(loadSplit).not.toHaveBeenCalled();
  });
  it("an outcome nobody can confirm is said so, and the chain is read again", async () => {
    const moveBetweenPots = vi.fn(async () => ({ kind: "unknown", message: "Relayer request timed out" }));
    const loadSplit = vi.fn(async () => ({ kind: "present", split: SPLIT, pots: POTS, config: CONFIG }));
    const p = await render({ states: [present, { ...FORM, moveAmount: "0.0001" }, {}, ME], actions: { moveBetweenPots, loadSplit } });
    await button(p.tree, "Move with my passkey")!.props!.onClick!();
    expect(moveBetweenPots).toHaveBeenCalledWith(p.kit, WALLET, POTS, "Spend", "Goal", BigInt(1_000));
    expect(loadSplit).toHaveBeenCalledTimes(1);
    const said = last(p.setters, 2)?.said;
    expect(said?.tone).toBe("unsure");
    expect(said?.text).not.toMatch(/Nothing was sent/);
  });
  it("change split: 10 and 20 percent become 1000 and 2000 basis points", async () => {
    const changeSplit = vi.fn(async () => ({ kind: "done", hash: "cd".repeat(32) }));
    const loadSplit = vi.fn(async () => ({ kind: "present", split: SPLIT, pots: POTS, config: CONFIG }));
    const p = await render({ states: [present, { ...FORM, newTax: "10", newGoal: "20" }, {}, ME], actions: { changeSplit, loadSplit } });
    await button(p.tree, "Change split with my passkey")!.props!.onClick!();
    expect(changeSplit).toHaveBeenCalledWith(p.kit, WALLET, 1000, 2000);
  });
  it("a second action is not started while one is running", async () => {
    const withdrawToWallet = vi.fn();
    const p = await render({ states: [present, { ...FORM, wdAmount: "1" }, { busy: "Waiting for your passkey" }, ME], actions: { withdrawToWallet } });
    await button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    expect(withdrawToWallet).not.toHaveBeenCalled();
    expect(button(p.tree, "Withdraw with my passkey")!.props!.disabled).toBe(true);
  });
  it("a bad amount is refused with its reason before any passkey prompt", async () => {
    const withdrawToWallet = vi.fn();
    const p = await render({ states: [present, { ...FORM, wdAmount: "1.00000001" }, {}, ME], actions: { withdrawToWallet } });
    await button(p.tree, "Withdraw with my passkey")!.props!.onClick!();
    expect(withdrawToWallet).not.toHaveBeenCalled();
    expect(last(p.setters, 2)?.said?.text).toMatch(/at most 7 decimal places/);
  });
});
