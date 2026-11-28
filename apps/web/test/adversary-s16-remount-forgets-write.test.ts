// Adversary s16: leaving the split page while a write is being sent, and coming back, loses what the page knew about
// that write.
//
// src/app/split/page.tsx keeps a write's progress in module-level variables (`writing`) and in the guard's module-level
// `inFlight` set (write-guard.ts), which survive a client-side navigation, but the facts the page acts on (`guardBy`,
// the note, the pots read) are component state, which a navigation throws away. The new page then:
//   (a) skips this tab's own in-flight record (`recordCloseBy` returns null for an id in `inFlight`), so once the write
//       ends it has no reason to re-read the pots: it keeps offering Withdraw on pots read before the write, with no
//       note at all (the old page's setNote and reread went to the unmounted page);
//   (b) when the write ends "unknown" after the poll cleared its record (adversary s15's timing), `setGuardBy` went to
//       the unmounted page too, so a pots read from a lagging RPC node frees the buttons again;
//   (c) offers Withdraw/Refresh as enabled while `writing` is still true, so a click does nothing and says nothing.
//
// Spec: page.tsx comment on `guardBy` ("Nothing new is offered until the pots shown were read at a ledger past it"),
// docs/decisions.md Codex split R4 #2 and adversary s15 ("The page now remembers the closeBy of this tab's own write
// whenever it ends 'unknown', and the pots must be read past it as for any other"), write-guard.ts header ("the page
// reads the pots at a ledger past its closeBy before it acts"), and the s1 row ("a write drops any read already under
// way ... so an older read never shows earlier pots") plus README's promise that what is shown is read from the network.
//
// The page runs in a small hooks runtime (real state and effects, per page instance, so a navigation can unmount one
// and mount another while the module stays loaded, as in the browser). The write guard, the Web Locks stand-in and the
// localStorage record are real. The wallet kit, the chain reads and the write itself are fakes.
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
    const read = { pots: { tax: BigInt(10_000), goal: BigInt(15_000), spend: chain.spend }, ledger: lag.ledger ?? network.ledger };
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

describe("adversary s16: leaving the split page during a write and coming back", () => {
  it("control: staying on the page, the pots are read again after the write went through", async () => {
    const h = await mount();
    const p = h.open();
    await startWithdraw(h, p);
    h.openGate();
    await sleep(400);
    p.leave();
    expect(p.text()).toMatch(/Your withdrawal went through/);
    expect(p.text()).toMatch(/0\.007\b/);
    expect(p.text()).not.toMatch(/0\.0075/);
  }, 30_000);

  it("the write goes through while another visit of the page is open: that page must not keep offering Withdraw on the pots from before it", async () => {
    const h = await mount();
    const first = h.open();
    await startWithdraw(h, first);
    first.leave(); // the person follows a link to another page ...
    const back = h.open(); // ... and returns: a new page instance, the module (and the write) lives on
    await sleep(300);
    expect(back.text()).toMatch(/0\.0075/); // read while the write is still being sent
    h.openGate(); // the write is confirmed on the network: the spend pot now holds 0.007
    await sleep(5_800); // the page's own 5 s tick runs
    back.leave();
    // Defect: no record, no note, no re-read: the buttons are offered on the 0.0075 read before the write, so the
    // person sees a balance the network no longer has, and a repeat of the withdrawal looks fine.
    const offeredOnOldPots = !withdrawDisabled(back) && /0\.0075/.test(back.text());
    expect(offeredOnOldPots, `Withdraw disabled: ${withdrawDisabled(back)}; page: ${back.text().slice(0, 700)}`).toBe(false);
  }, 30_000);

  it("the write ends unknown after the network passed its closeBy: a lagging pots read must still keep Withdraw blocked on the page the person came back to", async () => {
    const h = await mount();
    h.endAs("unknown");
    const first = h.open();
    await startWithdraw(h, first);
    first.leave();
    const back = h.open();
    await sleep(300);
    h.network.ledger = CLOSE_BY + 1;
    await sleep(5_800); // the poll: the network is past closeBy, so the lock is let go and the record is removed
    h.lag.ledger = CLOSE_BY - 3; // any later pots read is answered by an RPC node that lags: it may not show the write
    h.openGate(); // the send ends unknown (its 5 minute limit)
    await sleep(6_000);
    back.leave();
    // Defect: the earlier page's guardBy went to the unmounted page; this one offers Withdraw on pots read at 1000 or
    // at CLOSE_BY - 3, ledgers the write could still have landed after.
    expect(withdrawDisabled(back), `page: ${back.text().slice(0, 700)}`).toBe(true);
  }, 30_000);

  it("a page offering Withdraw as enabled while this tab's write is still being sent says something when it is clicked", async () => {
    const h = await mount();
    h.endAs("unknown");
    const first = h.open();
    await startWithdraw(h, first);
    first.leave();
    const back = h.open();
    await sleep(300);
    h.network.ledger = CLOSE_BY + 1;
    await sleep(5_800); // the record is gone (the network passed closeBy) while the write is still being sent
    input(back.tree(), "25.00")!.props!.onChange!({ target: { value: "0.0005" } });
    await sleep(30);
    const before = back.text();
    const calls = h.withdrawToWallet.mock.calls.length;
    const enabled = !withdrawDisabled(back);
    await button(back.tree(), "Withdraw with my passkey")!.props!.onClick!();
    await sleep(400);
    const after = back.text();
    back.leave();
    // A control that is offered must act or explain: either it is disabled, or the click starts a write, or it says why not.
    const acted = h.withdrawToWallet.mock.calls.length > calls || after !== before;
    expect(!enabled || acted, `Withdraw enabled: ${enabled}; a write was started: ${h.withdrawToWallet.mock.calls.length > calls}; the page said something new: ${after !== before}`).toBe(true);
  }, 30_000);
});
