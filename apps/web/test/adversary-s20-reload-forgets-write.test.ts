// Adversary s20: a page loaded after a write ended has no memory of it, so a lagging RPC node's pots from before the
// write are shown with every write offered.
//
// page.tsx remembers an earlier write's closeBy or landing ledger only in component state (`guardBy`), or through the
// localStorage record while the write may still land. A write that was CONFIRMED removes its record at once
// (write-guard.ts `finish`), and a write that ended "unknown" has its record removed by `clearPassed` once the network
// passes closeBy. Neither leaves anything in storage. A page opened afterwards (a reload, or another tab) starts with
// `guardBy = null` and no record, and its first read (the effect that calls `loadSplit`) is taken as it comes: it is not
// gated against anything. s19 closed the lagging-node hole for the page that sent the write; the same lagging node
// (the sessions's goal 5, "RPC nodes answering at different ledgers") answers the first read of the reloaded page.
//
// Spec: page.tsx comment on `guardBy` ("Nothing new is offered until the pots shown were read at a ledger past it"),
// write-guard.ts header ("A passed record does not let the page act at once: the pots must first be read at a ledger
// past its closeBy"), docs/decisions.md Codex split R4 #2 ("the page offers no write until the pots shown were read at a
// ledger past every earlier write's closeBy") and s19 ("the page offers nothing until the pots shown were read at or
// after [the ledger it landed in]"); session goal 2 ("offers a write based on pot balances ... that predate a write that
// may have landed or did land").
//
// Each test runs the page in the same small hooks runtime as adversary-s19 (real state and effects, real write guard,
// real Web Locks stand-in, real localStorage record). The reload is a fresh module registry over the SAME storage, as a
// browser reload is: no module state carries over. The wallet kit, the pots read and the write are fakes.
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
/** The ledger the kit says the confirmed withdrawal was included in. */
const LANDED = 1005;
/** Spend pot before the withdrawal: 0.0075 USDC. After a 0.0005 withdrawal it holds 0.007. */
const SPEND_BEFORE = BigInt(75_000);
const WITHDRAWN = BigInt(5_000);

/** What a browser keeps across a reload: its storage, and the network behind it. */
function world() {
  return {
    local: new Map([["caracal.walletOwner", ME.id]]),
    network: { ledger: START_LEDGER },
    // The ledger the next pots read reports (null: the network's own). A node behind the network answers older.
    lag: { ledger: null as number | null },
    chain: { spend: SPEND_BEFORE, landedAt: Infinity },
  };
}
type World = ReturnType<typeof world>;

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

/** A minimal React with one state store per page instance, over a fresh module registry (a page load). */
async function load(w: World, end: "done" | "unknown" = "done") {
  vi.resetModules();
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
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: w.network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: vi.fn() };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  // The pots as the node that answers shows them: the withdrawal is in them only once that node has reached LANDED.
  const loadSplit = vi.fn(async () => {
    const ledger = w.lag.ledger ?? w.network.ledger;
    const spend = ledger >= w.chain.landedAt ? w.chain.spend : SPEND_BEFORE;
    await sleep(10);
    return { kind: "present", split: SPLIT, pots: { tax: BigInt(10_000), goal: BigInt(15_000), spend }, config: CONFIG, ledger };
  });
  // The write: hands the guarded kit one call, waits for the test, then ends as the test says.
  let openGate = () => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const withdrawToWallet = vi.fn(async (guarded: { signAndSubmit(tx: unknown): Promise<unknown> }) => {
    void guarded.signAndSubmit({ needsNonInvokerSigningBy: () => [WALLET] }).catch(() => {});
    await gate;
    if (end === "done") {
      w.chain.spend = SPEND_BEFORE - WITHDRAWN;
      w.chain.landedAt = LANDED;
      return { kind: "done", hash: "a".repeat(64), ledger: LANDED };
    }
    return { kind: "unknown", message: "no answer within 5 minutes" };
  });
  kit.signAndSubmit.mockImplementation(() => new Promise<never>(() => {}));
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit, withdrawToWallet }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => w.local.get(k) ?? null, setItem: (k: string, v: string) => void w.local.set(k, v), removeItem: (k: string) => void w.local.delete(k) },
  });
  const mod = await import("../src/app/split/page");
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
    openGate: () => openGate(),
  };
}
type Page = Awaited<ReturnType<typeof load>>;
const withdrawDisabled = (p: Page) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;

/** Clicks Withdraw: the write is being sent (its record is written, its kit call is pending). */
async function startWithdraw(w: World, p: Page) {
  await sleep(150);
  expect(p.text()).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.0005" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  await sleep(100);
  expect(p.text()).toMatch(/Waiting for your passkey/);
  expect(w.local.has(KEY)).toBe(true);
}

describe("adversary s20: a page opened after a write has ended", () => {
  it("control: after a confirmed write, a reload that reads the network at or after the write shows the pots after it and offers Withdraw", async () => {
    const w = world();
    const p = await load(w);
    await startWithdraw(w, p);
    w.network.ledger = LANDED;
    p.openGate();
    await sleep(400);
    expect(p.text()).toMatch(/Your withdrawal went through/);
    p.leave();
    const again = await load(w);
    await sleep(300);
    const offered = !withdrawDisabled(again);
    const text = again.text();
    again.leave();
    expect(text).toMatch(/0\.007\b/);
    expect(text).not.toMatch(/0\.0075/);
    expect(offered).toBe(true);
  }, 30_000);

  it("a confirmed write, then a reload whose first read comes from a node behind it: Withdraw must not be offered on the pots from before the write", async () => {
    const w = world();
    const p = await load(w);
    await startWithdraw(w, p);
    w.network.ledger = LANDED;
    p.openGate(); // the kit reports the withdrawal confirmed, included in ledger LANDED
    await sleep(400);
    expect(p.text()).toMatch(/Your withdrawal went through/);
    expect(p.text()).toMatch(/0\.007\b/); // this page read at LANDED: the pots after the write
    expect(w.local.has(KEY)).toBe(false); // a confirmed write leaves no record
    p.leave();
    // The person reloads. The node that answers the first read is behind the one that confirmed the write.
    w.lag.ledger = LANDED - 2;
    const again = await load(w);
    await sleep(300);
    const text = again.text();
    const disabled = withdrawDisabled(again);
    again.leave();
    // Defect: the new page shows the Spend pot as it was BEFORE the withdrawal (0.0075) and offers Withdraw on it.
    const offeredOnOldPots = !disabled && /0\.0075/.test(text);
    expect(offeredOnOldPots, `Withdraw disabled: ${disabled}; page: ${text.slice(0, 700)}`).toBe(false);
  }, 30_000);

  it("an unknown write whose record the network has passed, then a reload read by a node not yet past closeBy: Withdraw must not be offered", async () => {
    const w = world();
    const p = await load(w, "unknown");
    await startWithdraw(w, p);
    p.openGate(); // the send ends "unknown" (no answer within 5 minutes)
    await sleep(400);
    expect(p.text()).toMatch(/could not confirm whether your withdrawal went through/i);
    // The network passes closeBy; this tab's 5 s poll lets go of the write's lock and removes its record.
    w.network.ledger = CLOSE_BY + 1;
    await sleep(5_600);
    expect(w.local.has(KEY)).toBe(false);
    p.leave();
    // Reload: the first read is answered by a node still AT closeBy, where the unknown write could be landing now.
    w.lag.ledger = CLOSE_BY;
    const again = await load(w);
    await sleep(300);
    const disabled = withdrawDisabled(again);
    const text = again.text();
    again.leave();
    expect(disabled, `Withdraw is offered on pots read at ledger ${CLOSE_BY}, which is not past the unknown write's closeBy ${CLOSE_BY}; page: ${text.slice(0, 500)}`).toBe(true);
  }, 30_000);
});
