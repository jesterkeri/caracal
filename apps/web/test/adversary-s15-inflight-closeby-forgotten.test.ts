// Adversary s15: a write still being sent when the network passes its closeBy leaves no memory of that closeBy, so the
// buttons come back on pots read before the write could have landed.
//
// write-guard.ts header: "A passed record does not let the page act at once: the pots must first be read at a ledger
// past its closeBy (the page, Codex split R4 #2)." docs/decisions.md, Codex split R4 #2: "the page offers no write
// until the pots shown were read at a ledger past every earlier write's closeBy this tab has seen (`guardBy`,
// remembered even after another tab removes the record; this tab's own write still being sent does not count)".
//
// The page's 5 s poll remembers a record's closeBy with `recordCloseBy`, which returns null for a write of this tab
// that is still being sent (`inFlight`). The same tick then calls `passLedger` (lets go of that write's lock, since
// the network is past closeBy) and `clearPassed` (removes the record). So a write whose send is still pending when
// the network passes closeBy has its record removed and its closeBy never remembered (`guardBy` stays null). The
// send's own limit (SEND_TIMEOUT_MS, 5 minutes) and the write's closeBy (60 ledgers, about 5 minutes) end at about
// the same time, so this is the usual order for an "unknown" outcome by timeout, not a rare one. When the send then
// ends "unknown", the record is gone and nothing is held: the page re-reads the pots once, and if that read is at a
// ledger that is not past closeBy (an RPC that lags the one the poll asked, goal 3: "a slow or lagging RPC"), the
// pots shown may not include the write, `mustPass` is null so the page is not stale, and Withdraw, Move and Change
// are offered again on those pots: a repeat of a withdrawal that may have landed.
//
// The page runs in the small hooks runtime of codex-split-r4.test.ts (real state and effects, real 5 s ledger poll,
// real write guard, real Web Locks stand-in, real localStorage record). The wallet kit, the pots read and the write
// are fakes. The write is gated: it hands the guarded kit one call that never settles (an RPC gone silent), waits for
// the test, then reports what sendSplitCall reports after its 5 minute limit.
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

/** A minimal React: useState and useEffect that really re-render and run effects when their dependencies change. */
async function mount() {
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
    (globalThis as { __hooks?: { reset(): void } }).__hooks = {
      reset: () => {
        s = 0;
        e = 0;
      },
    };
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
  // The ledger the next pots read reports (null: the network's own).
  const pots: { ledger: number | null } = { ledger: null };
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: vi.fn(() => new Promise<never>(() => {})) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    await sleep(10);
    return { kind: "present", split: SPLIT, pots: POTS, config: CONFIG, ledger: pots.ledger ?? network.ledger };
  });
  let openGate = () => {};
  const gate = new Promise<void>((r) => (openGate = r));
  const withdrawToWallet = vi.fn(async (guarded: { signAndSubmit(tx: unknown): Promise<unknown> }) => {
    void guarded.signAndSubmit({ needsNonInvokerSigningBy: () => [WALLET] }).catch(() => {});
    await gate;
    return { kind: "unknown", message: "no answer within 5 minutes" };
  });
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit, withdrawToWallet }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([["caracal.walletOwner", ME.id]]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
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
    openGate,
    unmount: () => {
      unmounted = true;
      cleanups.forEach((c) => c?.());
    },
  };
}
type Page = Awaited<ReturnType<typeof mount>>;
const withdrawDisabled = (p: Page) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;

/** Opens the page and clicks Withdraw; the write is now being sent (its record is written, its kit call never settles). */
async function startWithdraw(p: Page) {
  await sleep(150);
  expect(p.text()).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.5" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  await sleep(100);
  expect(p.text()).toMatch(/Waiting for your passkey/);
  expect(p.local.has(KEY)).toBe(true);
}

describe("adversary s15: a write still being sent when the network passes its closeBy", () => {
  it("control: the send ends unknown BEFORE the poll sees closeBy passed; a lagging pots read keeps the buttons blocked", async () => {
    const p = await mount();
    await startWithdraw(p);
    p.pots.ledger = CLOSE_BY - 3; // the re-read after the outcome is answered by an RPC node that lags
    p.openGate();
    await sleep(300);
    expect(p.text()).toMatch(/could not confirm whether your withdrawal went through/);
    p.network.ledger = CLOSE_BY + 1; // the network passes closeBy only now
    await sleep(5_600);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(true);
  }, 30_000);

  it("the send ends unknown AFTER the poll saw closeBy passed; a lagging pots read must still keep the buttons blocked", async () => {
    const p = await mount();
    await startWithdraw(p);
    p.network.ledger = CLOSE_BY + 1;
    await sleep(5_600); // the poll: the network is past closeBy, so this tab lets go of the write's lock and clears its record
    p.pots.ledger = CLOSE_BY - 3; // the re-read after the outcome is answered by an RPC node that lags: it may not show the write
    p.openGate(); // the send now ends unknown (its 5 minute limit)
    await sleep(300);
    p.unmount();
    expect(p.text()).toMatch(/could not confirm whether your withdrawal went through/);
    // Defect: the buttons are offered on pots read at CLOSE_BY - 3, a ledger the write could still have landed after.
    expect(withdrawDisabled(p)).toBe(true);
  }, 30_000);
});
