// Adversary s21: after "I have checked the pots", the page says the earlier write "can no longer land".
//
// A write record with no closeBy (one from an older version of Caracal, or one this browser cannot read) holds every
// write until the person checks the pots and presses "I have checked the pots" (write-guard.ts header: "no ledger seen
// later proves when its write stopped being able to land (Codex split R4 #3) ... nothing is inferred for it").
// `checkedPots` then removes the record and asks for a fresh pots read as of the ledger read now (page.tsx
// `setGuardBy(ledger - 1)`). Until that read comes back, the page shows the STALE notice, which states as fact:
// "The earlier withdrawal, move or change can no longer land." For this record that is exactly what nothing proves:
// the older write may still land (kit 0.10.0's default expiry is 720 ledgers), and the person only said they checked.
//
// Spec: the standing product rule "the page never claims an outcome it does not know", and write-guard.ts's own
// "nothing is inferred for it"; session goal 3 ("states something false about an outcome").
//
// Same small hooks runtime as adversary-s19/s20 (real page, real guard, real localStorage record, real Web Locks
// stand-in); the kit, the pots read and the browser are fakes. The record is seeded in the shape an older version wrote.
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

/** What a browser keeps: its storage, and the network behind it. */
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

describe("adversary s21: the notice after the person has checked the pots for a record with no closeBy", () => {
  it("control: with such a record the page holds writes and offers the button; nothing says the write can no longer land", async () => {
    const w = world();
    w.local.set(KEY, JSON.stringify({ v: 1, id: "older-version", at: 1 }));
    const p = await load(w);
    await sleep(300);
    const text = p.text();
    p.leave();
    expect(text).toMatch(/I have checked the pots/);
    expect(text).not.toMatch(/can no longer land/);
  }, 30_000);

  it("after pressing it, while the pots are read again, the page must not state that the earlier write can no longer land", async () => {
    const w = world();
    w.local.set(KEY, JSON.stringify({ v: 1, id: "older-version", at: 1 }));
    const p = await load(w);
    await sleep(300);
    expect(button(p.tree(), "I have checked the pots")).toBeTruthy();
    // The network has moved on; the node that answers the pots read is a little behind it, so the new read is not enough yet.
    w.network.ledger = 1010;
    w.lag.ledger = 1005;
    await button(p.tree(), "I have checked the pots")!.props!.onClick!();
    await sleep(400);
    const text = p.text();
    p.leave();
    expect(w.local.has(KEY)).toBe(false); // the record is gone, as the person asked
    expect(text).not.toMatch(/can no longer land/);
  }, 30_000);
});
