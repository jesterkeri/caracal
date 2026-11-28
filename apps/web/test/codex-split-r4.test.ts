// Codex split R4 (REVISE, three P1 findings in the write guard), one regression block per finding.
//
// 1. Expired-record cleanup could delete a newer write's record: holdOn removed a passed record while rendering,
//    without the split's Web Lock, so another tab's newer record written between its check and its removal was
//    lost. Now rendering never writes or removes the record; removal happens only under the lock.
// 2. A hold could lift before the pots were refreshed: the buttons came back as soon as a ledger past closeBy was
//    read, and the re-read of the pots was neither awaited nor checked against that ledger. Now nothing new is
//    offered until the pots shown were read at a ledger past every earlier write's closeBy this tab has seen.
// 3. A legacy or unreadable record was given closeBy = the first ledger seen + 720, an expiry inferred, not known.
//    Now it holds at every ledger until the person has checked the pots and clears it.
//
// The page runs in the small hooks runtime of adversary-s12/s13 (real state and effects, real 5 s ledger poll,
// real write guard, real Web Locks stand-in of test/setup-web-locks.ts, real localStorage record). The wallet kit,
// the pots read and the write are fakes; each pots read reports the ledger it was made at, as loadSplit does.
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
const POTS = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_LEDGER = 1000;
const CLOSE_BY = START_LEDGER + 60;

function stubStorage(local: Map<string, string>, getItem?: (k: string) => string | null) {
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: getItem ?? ((k: string) => local.get(k) ?? null), setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
}

describe("Codex split R4 #1: rendering never changes the record; removal only under the lock", () => {
  it("holdOn on a record the network has passed leaves it in place", async () => {
    const local = new Map([[KEY, JSON.stringify({ v: 2, id: "x", closeBy: CLOSE_BY })]]);
    stubStorage(local);
    const { holdOn } = await import("../src/lib/split/write-guard");
    expect(holdOn(SPLIT, CLOSE_BY + 1).held).toBe(false);
    expect(local.has(KEY)).toBe(true);
  });

  it("holdOn on an unreadable record writes nothing", async () => {
    const local = new Map([[KEY, "{not json"]]);
    stubStorage(local);
    const { holdOn } = await import("../src/lib/split/write-guard");
    holdOn(SPLIT, START_LEDGER);
    expect(local.get(KEY)).toBe("{not json");
  });

  it("a newer record written by another tab right after this tab's check is not removed", async () => {
    // Another tab writes its newer record the moment this tab has read the old one a second time (the window
    // between the re-read and the removal on ff06f8b).
    const local = new Map([[KEY, JSON.stringify({ v: 2, id: "old", closeBy: CLOSE_BY })]]);
    let reads = 0;
    const newer = JSON.stringify({ v: 2, id: "newer", closeBy: CLOSE_BY + 100 });
    stubStorage(local, (k) => {
      const v = local.get(k) ?? null;
      if (k === KEY && ++reads === 2) local.set(KEY, newer);
      return v;
    });
    const { holdOn } = await import("../src/lib/split/write-guard");
    holdOn(SPLIT, CLOSE_BY + 1);
    holdOn(SPLIT, CLOSE_BY + 1);
    expect(local.get(KEY)).toBe(newer);
  });

  it("clearPassed does not remove the record of a write that holds the lock, and removes a passed one once free", async () => {
    const local = new Map<string, string>();
    stubStorage(local);
    const { acquireWrite, clearPassed } = await import("../src/lib/split/write-guard");
    const w = await acquireWrite(SPLIT, START_LEDGER);
    if (!w.ok) throw new Error("should begin");
    const mine = local.get(KEY);
    await clearPassed(SPLIT, CLOSE_BY + 1_000_000); // even a ledger far past: the write holds the lock
    expect(local.get(KEY)).toBe(mine);
    w.guard.finish({ kind: "unknown", message: "no answer" });
    await w.guard.lockFree;
    await clearPassed(SPLIT, CLOSE_BY);
    expect(local.get(KEY)).toBe(mine); // not yet passed
    await clearPassed(SPLIT, CLOSE_BY + 1);
    expect(local.has(KEY)).toBe(false);
  });

  it("a certain outcome removes its record while the write still holds the lock", async () => {
    const local = new Map<string, string>();
    stubStorage(local);
    const { acquireWrite } = await import("../src/lib/split/write-guard");
    let atRelease: boolean | undefined;
    const locks = {
      request: (_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) =>
        cb({}).then((v) => {
          atRelease = local.has(KEY);
          return v;
        }),
    };
    const w = await acquireWrite(SPLIT, START_LEDGER, locks as never);
    if (!w.ok) throw new Error("should begin");
    w.guard.finish({ kind: "done", hash: "ab" });
    await w.guard.lockFree;
    expect(atRelease).toBe(false);
  });
});

describe("Codex split R4 #3: a record with no closeBy is held until the person clears it", () => {
  it("holds at any ledger, and clearUnknown does nothing while another tab holds the lock", async () => {
    const local = new Map([[KEY, JSON.stringify({ id: "old", beat: 1 })]]);
    stubStorage(local);
    const { holdOn, clearUnknown, KIT_DEFAULT_LEDGERS } = await import("../src/lib/split/write-guard");
    expect(holdOn(SPLIT, START_LEDGER + 10 * KIT_DEFAULT_LEDGERS)).toMatchObject({ held: true, reason: "unknown-expiry" });
    let free = () => {};
    const busy = (navigator as unknown as { locks: { request(n: string, o: unknown, cb: () => Promise<void>): Promise<void> } }).locks.request(KEY, { ifAvailable: true }, () => new Promise<void>((r) => (free = r)));
    expect(await clearUnknown(SPLIT)).toBe(false);
    expect(local.has(KEY)).toBe(true);
    free();
    await busy;
    expect(await clearUnknown(SPLIT)).toBe(true);
    expect(holdOn(SPLIT, START_LEDGER).held).toBe(false);
  });

  it("clearUnknown never removes a readable record", async () => {
    const rec = JSON.stringify({ v: 2, id: "x", closeBy: CLOSE_BY });
    const local = new Map([[KEY, rec]]);
    stubStorage(local);
    const { clearUnknown } = await import("../src/lib/split/write-guard");
    await clearUnknown(SPLIT);
    expect(local.get(KEY)).toBe(rec);
  });
});

// ---- the page ----

type PotsRead = { fail?: boolean; ledger?: number | null };

/** A minimal React: useState and useEffect that really re-render and run effects when their dependencies change. */
async function mount(seed?: [string, string]) {
  const slots: unknown[] = [];
  const effectDeps: (unknown[] | undefined)[] = [];
  const cleanups: ((() => void) | undefined)[] = [];
  let tree: unknown;
  let renderQueued = false;
  let unmounted = false;
  let render: () => void = () => {};
  const pending: (() => void)[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let s = 0;
    let e = 0;
    const hooks = {
      reset: () => {
        s = 0;
        e = 0;
      },
    };
    (globalThis as { __hooks?: typeof hooks }).__hooks = hooks;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = s++;
        if (!(at in slots)) slots[at] = init;
        return [
          slots[at],
          (v: unknown) => {
            slots[at] = typeof v === "function" ? (v as (p: unknown) => unknown)(slots[at]) : v;
            if (!renderQueued && !unmounted) {
              renderQueued = true;
              setTimeout(() => {
                renderQueued = false;
                if (!unmounted) render();
              }, 0);
            }
          },
        ];
      },
      useEffect: (fn: () => unknown, deps?: unknown[]) => {
        const at = e++;
        const before = effectDeps[at];
        const same = before !== undefined && deps !== undefined && before.length === deps.length && before.every((d, i) => Object.is(d, deps[i]));
        if (same) return;
        effectDeps[at] = deps;
        pending.push(() => {
          cleanups[at]?.();
          const c = fn();
          cleanups[at] = typeof c === "function" ? (c as () => void) : undefined;
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
  // How the next pots reads go: failing, or answered at a given ledger (by default the network's own).
  const pots: PotsRead = {};
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: vi.fn(() => Promise.resolve({ success: false, error: new Error("settled") })) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    await sleep(10);
    if (pots.fail) throw new Error("the Stellar network did not answer");
    return { kind: "present", split: SPLIT, pots: POTS, config: CONFIG, ledger: pots.ledger === undefined ? network.ledger : pots.ledger };
  });
  // The write hands the guarded kit one call, then reports what sendSplitCall reports after SEND_TIMEOUT_MS with no answer.
  const withdrawToWallet = vi.fn(async (guarded: { signAndSubmit(tx: unknown): Promise<unknown> }) => {
    void guarded.signAndSubmit({ needsNonInvokerSigningBy: () => [WALLET] }).catch(() => {});
    await sleep(30);
    return { kind: "unknown", message: "no answer within 5 minutes" };
  });
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit, withdrawToWallet }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([["caracal.walletOwner", ME.id]]);
  if (seed) local.set(seed[0], seed[1]);
  stubStorage(local);
  const mod = await import("../src/app/split/page");
  render = () => {
    (globalThis as { __hooks?: { reset(): void } }).__hooks!.reset();
    tree = mod.default();
    const run = pending.splice(0);
    setTimeout(() => run.forEach((f) => f()), 0);
  };
  render();
  return {
    tree: () => tree,
    text: () => texts(tree).join(" "),
    local,
    network,
    pots,
    loadSplit,
    withdrawToWallet,
    unmount: () => {
      unmounted = true;
      cleanups.forEach((c) => c?.());
    },
  };
}
type Page = Awaited<ReturnType<typeof mount>>;
const withdrawDisabled = (p: Page) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;

async function withdrawToUnknown(p: Page) {
  await sleep(150);
  expect(p.text()).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.5" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  await sleep(300);
  expect(p.text()).toMatch(/could not confirm whether your withdrawal went through/);
  expect(p.local.has(KEY)).toBe(true);
}

describe("Codex split R4 #2: nothing new is offered until the pots are read past closeBy", () => {
  it("control: once the network is past closeBy and the pots are read there, the buttons come back", async () => {
    const p = await mount();
    await withdrawToUnknown(p);
    expect(withdrawDisabled(p)).toBe(true);
    p.network.ledger = CLOSE_BY + 1;
    await sleep(5_600);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(false);
    expect(p.text()).not.toMatch(/may still go through|reading the pots again/);
  }, 30_000);

  it("stays blocked while the pots cannot be read after the hold lifts", async () => {
    const p = await mount();
    await withdrawToUnknown(p);
    p.network.ledger = CLOSE_BY + 1;
    p.pots.fail = true;
    await sleep(5_600);
    expect(withdrawDisabled(p)).toBe(true);
    // The person can still refresh; a read past closeBy then frees the buttons.
    p.pots.fail = false;
    button(p.tree(), "Refresh")!.props!.onClick!();
    await sleep(100);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(false);
  }, 30_000);

  it("stays blocked while the pots are read at a ledger not past closeBy (a lagging read)", async () => {
    const p = await mount();
    await withdrawToUnknown(p);
    p.network.ledger = CLOSE_BY + 1;
    p.pots.ledger = CLOSE_BY;
    await sleep(5_600);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(true);
    expect(p.text()).toMatch(/reading the pots again/);
  }, 30_000);

  it("stays blocked when another tab removes the record before this tab has read the pots past it", async () => {
    const p = await mount();
    await withdrawToUnknown(p);
    p.pots.fail = true;
    await sleep(5_600); // one poll: the record's closeBy is remembered
    p.local.delete(KEY); // another tab removed it
    await sleep(5_600);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(true);
  }, 30_000);
});

describe("Codex split R4 #3 on the page: the person clears a record with no closeBy", () => {
  it("is held with a way forward, and the buttons come back only after the person's check and a fresh pots read", async () => {
    const p = await mount([KEY, JSON.stringify({ id: "old", beat: 1 })]);
    await sleep(150);
    p.network.ledger = START_LEDGER + 10_000;
    await sleep(5_600);
    expect(withdrawDisabled(p)).toBe(true);
    expect(p.local.get(KEY)).toBe(JSON.stringify({ id: "old", beat: 1 })); // nothing inferred, nothing written
    const reads = p.loadSplit.mock.calls.length;
    button(p.tree(), "I have checked the pots")!.props!.onClick!();
    await sleep(200);
    p.unmount();
    expect(p.local.has(KEY)).toBe(false);
    expect(p.loadSplit.mock.calls.length).toBeGreaterThan(reads);
    expect(withdrawDisabled(p)).toBe(false);
  }, 30_000);
});
