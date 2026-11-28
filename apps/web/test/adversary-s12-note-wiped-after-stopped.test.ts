// Adversary s12: the split page wipes a failed write's message when it re-reads the pots.
//
// page.tsx remembers in a module variable (`heldSeen`) that a hold on writes was shown, and the effect after `hold`
// re-reads the pots with no message ("reread(readyWallet)", said undefined) once the hold lifts, "and drops the hold's
// note" (docs/decisions.md 2026-11-28, adversary s11). But every write on this split records itself in localStorage
// before it is sent (write-guard.ts beginWrite), so while the write runs `holdOn` says "held" and `heldSeen` is set.
// When the write ends with a CERTAIN outcome that sends no re-read (stopped: the passkey prompt was closed; refused:
// the relay said "Nothing was sent"), `guard.finish` removes the record, the hold "lifts", and the effect re-reads the
// pots and calls `setNote({ said: undefined })`: the person's failure message is replaced by nothing a moment later.
//
// Spec: attacker goal 5, "a failure not shown"; docs/decisions.md 2026-11-27 (s4) "The relay's ONCHAIN_FAILED report
// ... is shown as a refusal in red", 2026-11-27 (i2) "a pay or split page could not tell a refused call from a lost
// answer"; the page's own contract that a refusal is "shown" (page.tsx `if (outcome.kind === "refused" || ...) return
// setNote({ said })`).
//
// The page runs here with a small real hooks runtime (state and effects that really re-render and run), because the
// other page tests stub useEffect and so never run this effect. The write guard, Web Locks and localStorage record
// are the real code; the wallet kit, the pots read and the write itself are fakes (the write answers after a delay,
// as a closed passkey prompt does).
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
const POTS = { tax: BigInt(10_000), goal: BigInt(15_000), spend: BigInt(75_000) };
const CONFIG = { owner: WALLET, token: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", taxBps: 1000, goalBps: 1500 };
const ME = { id: "A", email: "a@x.ng" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A minimal React: useState and useEffect that really re-render and run effects when their dependencies change. */
async function mount(outcome: { kind: string; message?: string; hash?: string }, rereadMs: number) {
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
  const kit = { rpc: { getLatestLedger: async () => ({ sequence: 1000 }) }, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }) };
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  const loadSplit = vi.fn(async () => {
    await sleep(rereadMs); // a real read of the network takes a while
    return { kind: "present", split: SPLIT, pots: POTS, config: CONFIG };
  });
  // The write answers after a delay, as a closed passkey prompt or a relay refusal does; the guard around it is real.
  const withdrawToWallet = vi.fn(async () => {
    await sleep(30);
    return outcome;
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
    withdrawToWallet,
    loadSplit,
    unmount: () => {
      unmounted = true;
      cleanups.forEach((c) => c?.());
    },
  };
}

/** Opens the page, types an amount and presses Withdraw, then waits for everything to settle. */
async function withdrawOnce(p: Awaited<ReturnType<typeof mount>>) {
  await sleep(150); // the wallet is restored and the split read
  expect(texts(p.tree()).join(" ")).toMatch(/Withdraw with my passkey/);
  input(p.tree(), "25.00")!.props!.onChange!({ target: { value: "0.5" } });
  await sleep(30);
  button(p.tree(), "Withdraw with my passkey")!.props!.onClick!();
  // The write, its read of the chain if any, and any re-read after: sampled, to tell "never shown" from "shown, then gone".
  const seen: string[] = [];
  for (let i = 0; i < 60; i++) {
    await sleep(10);
    seen.push(texts(p.tree()).join(" "));
  }
  return { final: seen[seen.length - 1], seen };
}

describe("adversary s12: a failed split write's message", () => {
  it("control: a write that went through says so and keeps saying so after every re-read", async () => {
    const p = await mount({ kind: "done", hash: "ab".repeat(32) }, 80);
    const shown = await withdrawOnce(p);
    p.unmount();
    expect(p.withdrawToWallet).toHaveBeenCalledTimes(1);
    expect(shown.final).toMatch(/Your withdrawal went through\./);
  });

  it("a closed passkey prompt is still shown after the pots are read again", async () => {
    const p = await mount({ kind: "stopped", message: "The passkey prompt was closed or timed out." }, 80);
    const shown = await withdrawOnce(p);
    p.unmount();
    expect(p.withdrawToWallet).toHaveBeenCalledTimes(1);
    // The harness works: the message does appear when the write ends ...
    expect(shown.seen.some((t) => /The passkey prompt was closed or timed out\./.test(t))).toBe(true);
    // ... and must still be there when everything has settled.
    expect(shown.final).toMatch(/The passkey prompt was closed or timed out\./);
  });

  it("a relay refusal ('Nothing was sent') is still shown after the pots are read again", async () => {
    const p = await mount({ kind: "refused", message: "Too many requests. Nothing was sent. Try again." }, 80);
    const shown = await withdrawOnce(p);
    p.unmount();
    expect(p.withdrawToWallet).toHaveBeenCalledTimes(1);
    expect(shown.seen.some((t) => /Nothing was sent/.test(t))).toBe(true);
    expect(shown.final).toMatch(/Nothing was sent/);
  });
});
