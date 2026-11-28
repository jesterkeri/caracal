// Adversary s23: while the pots shown are older than an earlier write, the page's 5 s ledger poll starts a new read of the
// pots every time the ledger moves, and each new read drops the one before it, so a read that takes longer than the poll
// never lands and Withdraw, Move and Change stay blocked for good (a Refresh press starts yet another read, so it is dropped the same way).
//
// page.tsx: the effect at the `stale && seenLedger > mustPass` line calls `reread(readyWallet, undefined, true)` whenever
// `seenLedger` changes, and the poll changes it every 5 s while the page is stale (the ledger advances about every 5 s).
// reread() takes `++readSeq` and drops its result when `mine !== readSeq` (so does the Refresh button's read). The effect's
// cleanup only cancels its 0 ms timer, never the read already under way. loadSplit is up to four round trips, each allowed
// 15 s (READ_TIMEOUT_MS in lib/split/chain.ts), so a read that takes 7 s on a slow link is within what the code accepts,
// yet with a read started every 5 s none is ever the newest when it finishes.
//
// Spec: STALE_TEXT in write-guard.ts ("nothing new can be sent until it has read them as of a later ledger ... If this
// stays, press Refresh"): the person's way forward is a read that completes; decisions 2026-11-28 Codex split R4 #2 ("A
// failed or lagging read keeps everything blocked ... and the poll keeps reading until it is resolved"); session goal 4 (a
// hold with no way forward that the person cannot clear).
//
// The page runs in the same small hooks runtime as adversary-s19, on fake timers. The write guard, the Web Locks stand-in
// and the localStorage values are real; the wallet kit and the chain reads are fakes. The earlier write is represented by
// the ledger this browser keeps for it (`caracal.split.readAfter.<split>`, which a confirmed write leaves, adversary s20).
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

afterEach(() => {
  vi.useRealTimers();
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
const READ_AFTER = `caracal.split.readAfter.${SPLIT}`;
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The ledger an earlier write that went through landed after: pots must be read past it. */
const MUST_PASS = 1100;

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

/** `readMs`: how long one read of the pots takes after the first (the first is quick and answered by a node behind the write). */
async function mount(readMs: number) {
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
  // The network moves on: every ledger read finds it one ledger further, as testnet does between two polls.
  const network = { ledger: MUST_PASS + 100 };
  const kit = {
    rpc: { getLatestLedger: async () => ({ sequence: ++network.ledger }) },
    disconnect: async () => {},
    connectWallet: async () => ({ contractId: WALLET }),
    signAndSubmit: vi.fn(),
  };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  let reads = 0;
  const completed: number[] = [];
  const loadSplit = vi.fn(async () => {
    const n = ++reads;
    // The first read is answered by a node still behind the earlier write; later ones by the network as it is when they end.
    if (n === 1) {
      await sleep(100);
      return { kind: "present", split: SPLIT, pots: { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) }, config: CONFIG, ledger: MUST_PASS - 50 };
    }
    await sleep(readMs);
    completed.push(n);
    return { kind: "present", split: SPLIT, pots: { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(70_000) }, config: CONFIG, ledger: network.ledger };
  });
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([
    ["caracal.walletOwner", ME.id],
    [READ_AFTER, String(MUST_PASS)],
  ]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
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
    completed,
    leave: () => {
      inst.dead = true;
      inst.cleanups.forEach((c) => c?.());
    },
  };
}

const withdrawDisabled = (p: { tree(): unknown }) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;

/** Runs the page for `seconds` of fake time, with nobody pressing anything: only the page's own poll reads. */
async function runFor(p: Awaited<ReturnType<typeof mount>>, seconds: number) {
  for (let t = 0; t < seconds; t += 1) await vi.advanceTimersByTimeAsync(1_000);
}

describe("adversary s23: reads started by the ledger poll", () => {
  it("control: a read that takes 2 s completes before the next poll, so the pots are read past the earlier write and Withdraw comes back", async () => {
    vi.useFakeTimers();
    const p = await mount(2_000);
    await runFor(p, 40);
    const blocked = withdrawDisabled(p);
    const text = p.text();
    p.leave();
    expect(text).toMatch(/0\.007\b/);
    expect(blocked).toBe(false);
  }, 30_000);

  it("a read that takes 7 s (within the 15 s a read is allowed) must still end the hold while the poll runs", async () => {
    vi.useFakeTimers();
    const p = await mount(7_000);
    await runFor(p, 120);
    const blocked = withdrawDisabled(p);
    const completedReads = p.completed.length;
    const text = p.text();
    p.leave();
    // Defect: every read is dropped by the next one the poll starts, so the pots shown stay the ones read before the earlier
    // write, and Withdraw stays disabled however long the person waits.
    expect(blocked, `Withdraw still disabled after 120 s; reads that ended: ${completedReads}, none applied; page: ${text.slice(0, 500)}`).toBe(false);
  }, 30_000);
});
