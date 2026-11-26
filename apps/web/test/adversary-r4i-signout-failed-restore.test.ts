// Adversary r4i: a Sign out that fails while the saved wallet is still being
// restored.
// Spec: docs/decisions.md 2026-11-26 (r3b, row 24): sign-out "reports failure
// if the session survives"; Goal 4: "a failure that is not shown".
// Cause: apps/web/src/app/wallet/page.tsx stale() is `gone || accountMoved ||
// signingOutHere`. signOut() clears signingOutHere in its catch, so a restore
// that is still pending when a Sign out FAILS is no longer stale, and when it
// finishes it replaces the "Sign-out did not finish" error with a connected
// wallet, although signOutEverywhere already disconnected that wallet and
// forgot its owner. The person is shown a connected wallet, no failure, and
// a wallet that will not be restored on the next load.
// Rendered by calling the component with React's state and effects stubbed,
// as adversary-r4c-restore-race.test.ts does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function clickHandlerFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickHandlerFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const click = (node as El).props?.onClick;
  if (typeof click === "function" && own.includes(text)) return click;
  return clickHandlerFor(kids, text);
}

const A = { id: "A", email: "a@x.ng" };
const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const settle = () => new Promise((r) => setTimeout(r, 20));

async function renderWallet(states: unknown[], offline: boolean, kit: unknown) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = i++;
        return [at < states.length ? states[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    // offline: neither the revoke nor the local sign-out can finish, the session survives
    signOut: async () => (offline ? { error: new Error("offline") } : { error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>([[WALLET_OWNER_KEY, "A"]]);
  const win = {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  };
  vi.stubGlobal("window", win);
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters, win, store };
}

type S = { kind: string; message?: string; contractId?: string };

async function run(offline: boolean) {
  let finishRestore: (r: { contractId: string } | null) => void = () => {};
  const disconnect = vi.fn(async () => {});
  const kit = { disconnect, connectWallet: () => new Promise<{ contractId: string } | null>((res) => (finishRestore = res)) };
  // WalletPage state order: state, name, account
  const { tree, effects, setters, win, store } = await renderWallet([{ kind: "busy", label: "Checking for a saved wallet" }, "", A], offline, kit);
  effects.forEach((f) => f());
  await settle(); // verified; restore of A's saved wallet is now pending
  await clickHandlerFor(tree, "Sign out")!();
  finishRestore({ contractId: WALLET });
  await settle();
  const states = setters.filter((s) => s.i === 0).map((s) => s.v as S);
  return { states, last: states.at(-1)!, win, store, disconnect };
}

describe("adversary r4i: Sign out fails while the saved wallet is still being restored", () => {
  it("control: a Sign out that succeeds leaves the page not showing the wallet (existing r4c behaviour)", async () => {
    const { states, win } = await run(false);
    expect(win.location.replace).toHaveBeenCalledWith("/signin");
    expect(states.some((s) => s.kind === "connected")).toBe(false);
  });

  it("control: the failed Sign out sets its error and disconnects the wallet and forgets its owner", async () => {
    const { states, store, disconnect } = await run(true);
    expect(states.some((s) => s.kind === "error" && /Sign-out did not finish/.test(s.message ?? ""))).toBe(true);
    expect(disconnect).toHaveBeenCalled();
    expect(store.has(WALLET_OWNER_KEY)).toBe(false);
  });

  it("a restore that finishes after a FAILED Sign out does not replace the failure with a connected wallet", async () => {
    const { last } = await run(true);
    // Defect: the last thing shown is { kind: "connected", contractId }, with the
    // sign-out failure gone, for a wallet already disconnected and unbound.
    expect(last.kind, "the sign-out failure is replaced by a connected wallet").not.toBe("connected");
    expect(last.message ?? "").toMatch(/Sign-out did not finish/);
  });
});
