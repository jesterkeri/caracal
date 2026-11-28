// Adversary s17: a write record whose closeBy no ledger can ever reach holds every write for ever, with no way forward.
//
// write-guard.ts header: "A record this browser cannot read, or one from an older version of Caracal, carries no
// closeBy ... It holds every write until the person checks the pots and says so (clearUnknown)", and "The record is
// removed only when the outcome is certain ... " / the hold lifts "once an RPC shows a ledger past its closeBy".
// docs/decisions.md, Codex split R4 #3: a record with no usable closeBy gets the button "I have checked the pots".
//
// read() accepts any positive safe integer as closeBy. A record whose closeBy is beyond u32 (the kit refuses to sign
// an expiry that does not fit in u32, so no write of this app can have produced it; odd or damaged localStorage
// contents can) is "readable", so it is treated as a normal record: the hold says "it checks every few seconds" and
// waits for a ledger past 2^32, which the network never reaches, and the page offers no "I have checked the pots"
// button (that is shown only for reason unknown-expiry). Withdraw, Move, Change and Deploy stay disabled for good.
//
// The page runs in the small hooks runtime of test/adversary-s15-inflight-closeby-forgotten.test.ts (real state and
// effects, real 5 s ledger poll, real write guard, real Web Locks stand-in, real localStorage record). The wallet
// kit and the pots read are fakes; nothing is sent.
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

/** A minimal React: useState and useEffect that really re-render and run effects when their dependencies change. */
async function mount(record: string | null) {
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
        if (!(at in slots)) slots[at] = typeof init === "function" ? (init as () => unknown)() : init;
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
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: network.ledger }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }), signAndSubmit: vi.fn(() => new Promise<never>(() => {})) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    await sleep(10);
    return { kind: "present", split: SPLIT, pots: POTS, config: CONFIG, ledger: network.ledger };
  });
  vi.doMock("@/lib/split/actions", async () => ({ ...(await vi.importActual<object>("@/lib/split/actions")), loadSplit }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const local = new Map([["caracal.walletOwner", ME.id]]);
  if (record !== null) local.set(KEY, record);
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
    unmount: () => {
      unmounted = true;
      cleanups.forEach((c) => c?.());
    },
  };
}
type Page = Awaited<ReturnType<typeof mount>>;
const withdrawDisabled = (p: Page) => button(p.tree(), "Withdraw with my passkey")?.props?.disabled === true;
/** The person has a way forward: the write buttons are on, or the page offers to clear a record it cannot place. */
const wayForward = (p: Page) => !withdrawDisabled(p) || button(p.tree(), "I have checked the pots") !== null;

describe("adversary s17: a record whose closeBy no ledger can reach", () => {
  it("control: a record with no closeBy holds, and offers 'I have checked the pots'", async () => {
    const p = await mount(JSON.stringify({ v: 2, id: "damaged" }));
    await sleep(300);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(true);
    expect(button(p.tree(), "I have checked the pots")).not.toBeNull();
  });

  it("control: a record with a closeBy just ahead holds, then lifts once the network passes it", async () => {
    const p = await mount(JSON.stringify({ v: 2, id: "real", closeBy: START_LEDGER + 60 }));
    await sleep(300);
    expect(withdrawDisabled(p)).toBe(true);
    p.network.ledger = START_LEDGER + 61;
    await sleep(5_600);
    await sleep(300);
    p.unmount();
    expect(withdrawDisabled(p)).toBe(false);
  }, 30_000);

  it("a record whose closeBy is beyond u32 (no ledger will ever pass it) leaves the person a way forward", async () => {
    const p = await mount(JSON.stringify({ v: 2, id: "damaged", closeBy: 2 ** 32 + 1000 }));
    await sleep(5_600);
    await sleep(300);
    p.unmount();
    // Defect: Withdraw, Move and Change stay disabled, the text promises "it checks every few seconds", and no
    // "I have checked the pots" button is offered, whatever the network does.
    expect(wayForward(p), `held for good, page says: ${p.text().match(/An earlier withdrawal.{0,330}/)?.[0]}; withdraw disabled: ${withdrawDisabled(p)}`).toBe(true);
  }, 30_000);
});
