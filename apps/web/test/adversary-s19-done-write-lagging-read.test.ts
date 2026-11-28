// Adversary s19: a write the network CONFIRMED does not gate the pots read after it, so a lagging RPC node's answer
// puts the pots from before the write on screen with every write offered.
//
// run() in src/app/split/page.tsx remembers a write's closeBy (`guardBy`) only when its outcome is "unknown"
// (`if (outcome.kind === "unknown") setGuardBy(...)`). After "done" it calls reread() and shows whatever pots come back,
// with no check that they were read at a ledger past the write. Codex split R4 #2 and adversary s16/s18 closed that for
// unknown writes, but the RPC the page reads from can be several ledgers behind the node that confirmed the write
// (the same situation s16 and s18 use). The page then says "Your withdrawal went through." while showing the Spend
// pot as it was BEFORE the withdrawal, and Withdraw, Move and Change stay enabled on it.
//
// Spec: page.tsx comment on `guardBy` ("Nothing new is offered until the pots shown were read at a ledger past it"),
// write-guard.ts header ("the page reads the pots at a ledger past its closeBy before it acts"), docs/decisions.md
// 2026-11-27 s1 row and README's promise that what is shown is read from the network; session goal 2 ("the page offers a
// write based on pot balances ... that predate a write that did land").
//
// The page runs in the same small hooks runtime as adversary-s16 (real state and effects). The write guard, the Web
// Locks stand-in and the localStorage record are real. The wallet kit, the chain reads and the write are fakes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

type El = { props?: { children?: unknown; onClick?: () => unknown; onChange?: (e: unknown) => unknown; placeholder?: string; disabled?: boolean } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function find(node: unknown, pred: (e: El) => boolean): El | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = find(n, pred);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  if (pred(node as El)) return node as El;
  return find((node as El).props?.children, pred);
}
const button = (tree: unknown, text: string) => find(tree, (e) => typeof e.props?.onClick === "function" && texts(e.props?.children).join("").includes(text));
const input = (tree: unknown, placeholder: string) => find(tree, (e) => e.props?.placeholder === placeholder);

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
const KEY = `caracal.split.write.${SPLIT}`;
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_LEDGER = 1000;
const CLOSE_BY = START_LEDGER + 60;
/** Spend pot before the withdrawal: 0.0075 USDC. After a 0.0005 withdrawal it holds 0.007. */
const SPEND_BEFORE = BigInt(75_000);
const WITHDRAWN = BigInt(5_000);

type Inst = {
  slots: unknown[];
  effectDeps: (unknown[] | undefined)[];
  cleanups: ((() => void) | undefined)[];
  pending: (() => void)[];
  dead: boolean;
  renderQueued: boolean;
  tree: unknown;
  render: () => void;
};

/** A minimal React with one state store per page instance, so a navigation can unmount a page and mount another. */
async function mount() {
  let cur!: Inst;
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let s = 0;
    let e = 0;
    (globalThis as { __hooks?: { reset(): void } }).__hooks = { reset: () => ((s = 0), (e = 0)) };
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const my = cur;
        const at = s++;
        if (!(at in my.slots)) my.slots[at] = init;
        return [
          my.slots[at],
          (v: unknown) => {
            my.slots[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(my.slots[at]) : v;
            if (!my.renderQueued && !my.dead) {
              my.renderQueued = true;
              setTimeout(() => {
                my.renderQueued = false;
                if (!my.dead) my.render();
              }, 0);
            }
          },
        ];
      },
      useEffect: (fn: () => unknown, deps?: unknown[]) => {
        const my = cur;
        const at = e++;
        const before = my.effectDeps[at];
        const same = before !== undefined && deps !== undefined && before.length === deps.length && before.every((d, i) => Object.is(d, deps[i]));
        if (same) return;
        my.effectDeps[at] = deps;
        my.pending.push(() => {
          my.cleanups[at]?.();
          const c = fn();
          my.cleanups[at] = typeof c === "function" ? (c as () => void) : undefined;
        });
      },
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: ME }, error: null }),
    getSession: async () => ({ data: { session: { user: ME } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  const network = { ledger: START_LEDGER };
  // The ledger the next pots read reports (null: the network's own).
  const lag: { ledger: number | null } = { ledger: null };
  const chain = { spend: SPEND_BEFORE };
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: vi.fn() };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    const read = { pots: { tax: BigInt(10_000), goal: BigInt(15_000), spend: lag.ledger !== null && lag.ledger <= START_LEDGER ? SPEND_BEFORE : chain.spend }, ledger: lag.ledger ?? network.ledger };
    await sleep(10);
    return { kind: "present", split: SPLIT, pots: read.pots, config: CONFIG, ledger: read.ledger };
  });
  // The write: hands the guarded kit one call, waits for the test, then ends as the test says.
  let end: "done" | "unknown" = "done";
  let openGate = () => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const withdrawToWallet = vi.fn(async (guarded: { signAndSubmit(tx: unknown): Promise<unknown> }) => {
    void guarded.signAndSubmit({ needsNonInvokerSigningBy: () => [WALLET] }).catch(() => {});
    await gate;
    if (end === "done") {
      chain.spend -= WITHDRAWN;
      return { kind: "done", hash: "a".repeat(64) };
    }
    return { kind: "unknown", message: "no answer within 5 minutes" };
  });
  kit.signAndSubmit.mockImplementation(() => (end === "done" ? gate.then(() => ({ success: true })) : new Promise<never>(() => {})));
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit, withdrawToWallet }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([["caracal.walletOwner", ME.id]]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  const mod = await import("../src/app/split/page");

  /** A navigation to the page: a new page instance with fresh state, the same loaded modules. */
  function open() {
    const inst: Inst = { slots: [], effectDeps: [], cleanups: [], pending: [], dead: false, renderQueued: false, tree: null, render: () => {} };
    inst.render = () => {
      cur = inst;
      (globalThis as { __hooks?: { reset(): void } }).__hooks!.reset();
      inst.tree = mod.default();
      const run = inst.pending.splice(0);
      setTimeout(() => run.forEach((f) => f()), 0);
    };
    inst.render();
    return {
      tree: () => inst.tree,
      text: () => texts(inst.tree).join(" "),
      leave: () => {
        inst.dead = true;
        inst.cleanups.forEach((c) => c?.());
      },
    };
  }
  return {
    open,
    local,
    network,
    lag,
    chain,
    loadSplit,
    withdrawToWallet,
    endAs: (k: "done" | "unknown") => (end = k),
    openGate: () => openGate(),
  };
}
type Harness = Awaited<ReturnType<typeof mount>>;
type Page = ReturnType<Harness["open"]>;
const withdrawDisabled = (p: Page) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;

/** Opens the page and clicks Withdraw: the write is being sent (its record is written, its kit call is pending). */
async function startWithdraw(h: Harness, p: Page) {
  await sleep(150);
  expect(p.text()).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.0005" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  await sleep(100);
  expect(p.text()).toMatch(/Waiting for your passkey/);
  expect(h.local.has(KEY)).toBe(true);
}

describe("adversary s19: pots read after a confirmed write", () => {
  it("control: a read past the write's closeBy shows the pots after the withdrawal and offers Withdraw", async () => {
    const h = await mount();
    const p = h.open();
    await startWithdraw(h, p);
    h.network.ledger = CLOSE_BY + 1;
    h.openGate();
    await sleep(400);
    const offered = !withdrawDisabled(p);
    p.leave();
    expect(p.text()).toMatch(/Your withdrawal went through/);
    expect(p.text()).toMatch(/0\.007\b/);
    expect(p.text()).not.toMatch(/0\.0075/);
    expect(offered).toBe(true);
  }, 30_000);

  it("the write is confirmed but the pots come back from a node behind it: Withdraw must not be offered on the pots from before the write", async () => {
    const h = await mount();
    const p = h.open();
    await startWithdraw(h, p);
    h.lag.ledger = START_LEDGER - 5; // the read after the write is answered by a node that is behind the write
    h.openGate(); // the kit reports the withdrawal confirmed ("done")
    await sleep(400);
    const text = p.text();
    const disabled = withdrawDisabled(p);
    p.leave();
    expect(text).toMatch(/Your withdrawal went through/);
    // Defect: the page says it went through, shows the 0.0075 from before it, and offers Withdraw on that.
    const offeredOnOldPots = !disabled && /0\.0075/.test(text);
    expect(offeredOnOldPots, `Withdraw disabled: ${disabled}; page: ${text.slice(0, 700)}`).toBe(false);
  }, 30_000);
});
