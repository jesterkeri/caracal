// Adversary s13: a write the network has passed still holds its split's Web Lock, so another tab is refused with a
// false reason.
//
// write-guard.ts: `live` is documented as "A write lets go of [the Web Lock] once its outcome is certain or its kit
// call has settled, and also once the network passes its closeBy, since nothing it could still send can land then".
// But the only code that lets go of a passed write's lock is `passLedger`, and its only caller is `acquireWrite` in
// the SAME tab, when that tab itself starts its next write. The page (page.tsx) reads the ledger every 5 s while it
// holds a write record, sees the network pass closeBy, lifts its own hold (the record is removed, the buttons are
// enabled, the pots are read again) and never calls `passLedger`. So while this tab's kit call is still unsettled
// (the kit's relayer waits up to 6 minutes and its rpc client has no timeout, the s4 case; the write's closeBy is
// about 5 minutes), the lock stays held, and a SECOND TAB of the same browser, which cannot see this tab's `live` map,
// gets `lock === null` from the Web Locks API. holdOn in that tab says "no hold" (the record is gone), so it offers the
// buttons, and a click is answered "An earlier withdrawal, move or change may still go through ... nothing new can be
// sent until Caracal reads on the Stellar network that it can no longer land", which is false: the network was read
// past closeBy by the first tab. It stays false until the first tab's kit call settles or that tab is closed.
//
// Spec:
// - write-guard.ts, the comment on `live` (quoted above), and the header: "acquireWrite takes this split's Web Lock
//   first ... and holds it for as long as the write may still be sent from this tab".
// - docs/decisions.md 2026-11-28 (adversary s11): "(2) A write's Web Lock was held until its kit call settled, so a
//   call that never settled ... refused every later write with 'nothing new can be sent until...' although the hold
//   had lifted." The s11 fix lets go only for the tab that is about to write itself.
// - attacker goals 4 ("a person is told something false") and 5 ("no way forward").
//
// The page runs here in the small hooks runtime of adversary-s12-note-wiped-after-stopped.test.ts (real effects,
// real 5 s ledger poll, real write guard, real Web Locks stand-in of test/setup-web-locks.ts, real localStorage
// record). The wallet kit, the pots read and the write are fakes: the write calls the guarded kit's signAndSubmit
// (which never answers, as an RPC that goes silent does) and returns the 5 minute "unknown" outcome. The second tab
// is a second copy of write-guard.ts (its own `live` map) sharing the same localStorage and Web Locks.
import { afterEach, describe, expect, it, vi } from "vitest";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

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

type El = { props?: { children?: unknown; onClick?: () => unknown; onChange?: (e: unknown) => unknown; placeholder?: string } };
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

const SPLIT = splitAddressFor(WALLET);
const POTS = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START_LEDGER = 1000;
/** The write's closeBy: the ledger read when it starts plus WRITE_LEDGERS (60). */
const CLOSE_BY = START_LEDGER + 60;

/** A minimal React: useState and useEffect that really re-render and run effects when their dependencies change. */
async function mount(kitCallSettles: boolean) {
  const slots: unknown[] = [];
  const effectDeps: (unknown[] | undefined)[] = [];
  const cleanups: ((() => void) | undefined)[] = [];
  let tree: unknown;
  let renderQueued = false;
  let unmounted = false;
  let render: () => void = () => {};
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
  const pending: (() => void)[] = [];
  const auth = {
    getUser: async () => ({ data: { user: ME }, error: null }),
    getSession: async () => ({ data: { session: { user: ME } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  // The network's latest ledger, which the test moves.
  const network = { ledger: START_LEDGER };
  // The kit's own signAndSubmit: it never answers (an RPC gone silent), or answers at once in the control.
  const underlying = vi.fn((): Promise<unknown> => (kitCallSettles ? Promise.resolve({ success: false, error: new Error("settled") }) : new Promise(() => {})));
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: underlying };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    await sleep(10);
    return { kind: "present", split: SPLIT, pots: POTS, config: CONFIG };
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
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  const mod = await import("../src/app/split/page");
  render = () => {
    (globalThis as { __hooks?: { reset(): void } }).__hooks!.reset();
    tree = mod.default();
    // Effects run after the render, as React runs them after commit.
    const run = pending.splice(0);
    setTimeout(() => run.forEach((f) => f()), 0);
  };
  render();
  return {
    tree: () => tree,
    local,
    network,
    underlying,
    unmount: () => {
      unmounted = true;
      cleanups.forEach((c) => c?.());
    },
  };
}

/** Opens the page, withdraws once (the write ends "unknown" as at the 5 minute limit), and returns once the page has settled. */
async function withdrawToUnknown(p: Awaited<ReturnType<typeof mount>>) {
  await sleep(150); // the wallet is restored and the split read
  expect(texts(p.tree()).join(" ")).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.5" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  await sleep(300);
  expect(texts(p.tree()).join(" ")).toMatch(/could not confirm whether your withdrawal went through/);
  expect(p.local.has(`caracal.split.write.${SPLIT}`)).toBe(true); // the record of the unknown write
}

/** The second tab of this browser: its own copy of write-guard.ts, the same localStorage and Web Locks. */
async function secondTab() {
  vi.resetModules();
  return import("../src/lib/split/write-guard");
}

/** Lets the first tab's 5 s ledger poll run: it reads the ledger, lifts its own hold and re-reads the pots. */
async function letThePollRun(p: Awaited<ReturnType<typeof mount>>) {
  await sleep(5_600);
  expect(p.local.has(`caracal.split.write.${SPLIT}`)).toBe(false); // the first tab's own hold has lifted: the record is gone
}

describe("adversary s13: the Web Lock of a write the network has passed", () => {
  it("control: before closeBy, a second tab is refused", async () => {
    const p = await mount(false);
    await withdrawToUnknown(p);
    p.network.ledger = CLOSE_BY; // the network is AT closeBy: the write can still land
    const other = await secondTab();
    const b = await other.acquireWrite(SPLIT, CLOSE_BY);
    p.unmount();
    expect(b.ok).toBe(false);
  }, 30_000);

  it("control: the same flow with a kit call that settled lets the second tab write once the network is past closeBy", async () => {
    const p = await mount(true);
    await withdrawToUnknown(p);
    expect(p.underlying).toHaveBeenCalledTimes(1);
    p.network.ledger = CLOSE_BY + 1;
    await letThePollRun(p);
    const other = await secondTab();
    const b = await other.acquireWrite(SPLIT, CLOSE_BY + 1);
    p.unmount();
    expect(b.ok).toBe(true);
  }, 30_000);

  it("a kit call that has not settled does not keep a second tab out once the first tab has seen the network pass closeBy", async () => {
    const p = await mount(false);
    await withdrawToUnknown(p);
    expect(p.underlying).toHaveBeenCalledTimes(1);
    p.network.ledger = CLOSE_BY + 1; // past closeBy: the passkey signature has expired, nothing this write holds can land
    await letThePollRun(p); // the first tab reads this and lifts its own hold (record removed, buttons enabled)
    expect(texts(p.tree()).join(" ")).not.toMatch(/may still go through/); // no hold is shown in the first tab
    const other = await secondTab();
    const b = await other.acquireWrite(SPLIT, CLOSE_BY + 1);
    p.unmount();
    // Defect: refused with reason "earlier-write" (until: null), the text "nothing new can be sent until Caracal reads
    // on the Stellar network that it can no longer land", although the network is past closeBy and was just read so.
    expect(b).toMatchObject({ ok: true });
  }, 30_000);
});
