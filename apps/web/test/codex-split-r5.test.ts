// Codex split R5 (REVISE, 2 findings, both P1).
//
// #1: run() checked that the pots on screen were read past every earlier write's closeBy (readPastBy), then awaited
// acquireWrite, and never checked again once the lock was granted. Another tab's confirmed write could end in
// between and keep a newer read-after ledger, and this tab then sent a withdrawal or move validated against pots from
// before that write. Now the check is made again under the split's Web Lock (acquireWrite / beginWrite take the
// ledger the pots on screen were read at), and a write whose pots are too old is refused with the STALE notice.
//
// #2: rememberReadAfter swallowed a storage refusal, while the record it was meant to outlive was removed anyway: a
// confirmed write's record (finish), a passed record (clearPassed), a passed record replaced by a new write
// (beginWrite) and a record with no closeBy cleared after the person's check (clearUnknown). A reload or another tab
// could then offer writes on a lagging RPC's pots from before the write. Now each of these keeps the read-after ledger
// first, and when it cannot, the record stays (its closeBy still gates every page) or the write is refused.
//
// Harness: as adversary-s19/s20/s21 (real page, real guard, real localStorage record, the shared Web Locks stand-in);
// the kit, the pots read and the browser are fakes.
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

const READ_AFTER = `caracal.split.readAfter.${SPLIT}`;
const LOCK = `caracal.split.write.${SPLIT}`;

describe("Codex split R5 #1: the read-past check is made again once the split's lock is granted", () => {
  it("control: with nothing kept, Withdraw is sent", async () => {
    const w = world();
    const p = await load(w);
    await sleep(300);
    input(p.tree(), "25.00")?.props?.onChange?.({ target: { value: "0.0005" } });
    await sleep(50);
    expect(withdrawDisabled(p)).toBe(false);
    void button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
    await sleep(100);
    expect(w.local.has(KEY)).toBe(true); // the write began and its record is kept
    p.openGate();
    await sleep(300);
    p.leave();
  });

  it("another tab's confirmed write ends just before this tab is granted the lock: nothing is sent and the pots are read again", async () => {
    const w = world();
    const p = await load(w);
    await sleep(300);
    input(p.tree(), "25.00")?.props?.onChange?.({ target: { value: "0.0005" } });
    await sleep(50);
    expect(withdrawDisabled(p)).toBe(false);
    // The other tab's withdrawal landed at ledger 1005 and it kept 1004 as the ledger the pots must be read past, in
    // the moment between this tab's check and its lock being granted.
    const locks = (navigator as unknown as { locks: { request: (...a: unknown[]) => Promise<unknown> } }).locks;
    const real = locks.request.bind(locks);
    let injected = false;
    vi.spyOn(locks, "request").mockImplementation((name: unknown, ...rest: unknown[]) => {
      if (name === LOCK && !injected) {
        injected = true;
        w.local.set(READ_AFTER, JSON.stringify(LANDED - 1));
      }
      return real(name, ...rest);
    });
    void button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
    await sleep(300);
    expect(injected).toBe(true);
    expect(w.local.has(KEY), "a write record was kept: the withdrawal began on pots read before the other tab's write").toBe(false);
    expect(p.text()).toContain("Caracal is reading the pots again");
    p.leave();
  });
});

/** A browser whose storage refuses to keep the read-after ledger (full, or a policy), but keeps everything else. */
function refusingReadAfter(kept = new Map<string, string>()) {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k === READ_AFTER) throw new Error("QuotaExceededError");
        kept.set(k, v);
      },
      removeItem: (k: string) => void kept.delete(k),
    },
  });
  return kept;
}

describe("Codex split R5 #2: a read-after ledger that cannot be kept never leaves a page free to act on older pots", () => {
  it("with storage that keeps it, the guard itself keeps a confirmed write's landed ledger less one as the read-after ledger", async () => {
    vi.resetModules();
    const kept = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
    const { acquireWrite, readPastBy } = await import("../src/lib/split/write-guard");
    const begun = await acquireWrite(SPLIT, START_LEDGER, undefined, START_LEDGER);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    begun.guard.finish({ kind: "done", hash: "a".repeat(64), ledger: LANDED });
    await begun.guard.lockFree;
    expect(kept.has(KEY)).toBe(false);
    expect(readPastBy(SPLIT)).toBe(LANDED - 1);
  });

  it("a confirmed write whose read-after ledger is refused keeps its record, so a page opened later still reads past it", async () => {
    vi.resetModules();
    refusingReadAfter();
    const { acquireWrite, readPastBy } = await import("../src/lib/split/write-guard");
    const begun = await acquireWrite(SPLIT, START_LEDGER, undefined, START_LEDGER);
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    begun.guard.finish({ kind: "done", hash: "a".repeat(64), ledger: LANDED });
    await begun.guard.lockFree;
    expect(readPastBy(SPLIT) ?? 0, "nothing in this browser asks a reload or another tab to read the pots past the write").toBeGreaterThanOrEqual(LANDED - 1);
  });

  it("clearPassed keeps a passed record whose closeBy cannot be kept as the read-after ledger", async () => {
    vi.resetModules();
    const kept = refusingReadAfter(new Map([[KEY, JSON.stringify({ v: 2, id: "earlier", closeBy: CLOSE_BY })]]));
    const { clearPassed, readPastBy } = await import("../src/lib/split/write-guard");
    await clearPassed(SPLIT, CLOSE_BY + 40);
    expect(kept.has(KEY)).toBe(true);
    expect(readPastBy(SPLIT)).toBe(CLOSE_BY);
  });

  it("a new write does not replace a passed record whose closeBy cannot be kept as the read-after ledger", async () => {
    vi.resetModules();
    const kept = refusingReadAfter(new Map([[KEY, JSON.stringify({ v: 2, id: "earlier", closeBy: CLOSE_BY })]]));
    const { acquireWrite, readPastBy } = await import("../src/lib/split/write-guard");
    const begun = await acquireWrite(SPLIT, CLOSE_BY + 40, undefined, CLOSE_BY + 40);
    expect(begun.ok).toBe(false);
    expect(JSON.parse(kept.get(KEY)!).id).toBe("earlier");
    expect(readPastBy(SPLIT)).toBe(CLOSE_BY);
  });

  it("after the person's check, a record with no closeBy stays when the ledger of that check cannot be kept", async () => {
    vi.resetModules();
    const kept = refusingReadAfter(new Map([[KEY, JSON.stringify({ v: 1, id: "older-version", at: 1 })]]));
    const { clearUnknown } = await import("../src/lib/split/write-guard");
    expect(await clearUnknown(SPLIT, undefined, 1499)).toBe(false);
    expect(kept.has(KEY)).toBe(true);
  });

  it("the page's 'I have checked the pots' does not let new writes in when the ledger of the check cannot be kept", async () => {
    const w = world();
    w.local.set(KEY, JSON.stringify({ v: 1, id: "older-version", at: 1 }));
    const p = await load(w);
    // The page's storage now refuses the read-after key.
    const ls = (window as unknown as { localStorage: { setItem: (k: string, v: string) => void } }).localStorage;
    const set = ls.setItem;
    ls.setItem = (k: string, v: string) => {
      if (k === READ_AFTER) throw new Error("QuotaExceededError");
      set(k, v);
    };
    await sleep(300);
    void button(p.tree(), "I have checked the pots")!.props!.onClick!();
    await sleep(300);
    expect(w.local.has(KEY), "the record with no closeBy was removed though nothing kept the ledger of the person's check").toBe(true);
    p.leave();
  });
});
