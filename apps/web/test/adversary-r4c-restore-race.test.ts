// Adversary r4c: the wallet page's restore of a saved wallet races the
// account-change event.
// decisions.md 2026-11-26 (Codex R4 #2): "The wallet page follows the account
// through supabase-js auth events, which reach every tab: on a sign-out or a
// different account it clears what it shows and reloads." Restoring a saved
// wallet (provenance check, RPC reads) takes seconds. If another tab changes
// the account in that window, the page clears itself, and then the restore
// finishes and puts the old account's wallet back on screen.
// Rendered by calling the component with React's state and effects stubbed,
// as codex-r4-pages.test.ts does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

type User = { id: string; email?: string | null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

/** One browser's Supabase auth: the session is shared by tabs, and events reach every tab. */
function browserAuth(user: User | null) {
  let session: { user: User } | null = user ? { user } : null;
  const subscribers = new Set<(event: string, s: { user: User } | null) => void>();
  const auth = {
    getUser: vi.fn(async () => (session ? { data: { user: session.user }, error: null } : { data: { user: null }, error: new Error("Auth session missing!") })),
    getSession: vi.fn(async () => ({ data: { session } })),
    signOut: vi.fn(async () => ({ error: null })),
    onAuthStateChange: (cb: (event: string, s: { user: User } | null) => void) => {
      subscribers.add(cb);
      return { data: { subscription: { unsubscribe: () => subscribers.delete(cb) } } };
    },
  };
  const otherTab = (next: User | null) => {
    session = next ? { user: next } : null;
    for (const cb of subscribers) cb(next ? "SIGNED_IN" : "SIGNED_OUT", session);
  };
  return { auth, otherTab };
}

async function renderWallet(auth: unknown, kit: unknown, states: unknown[] = []) {
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
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>();
  const win = {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  };
  vi.stubGlobal("window", win);
  const mod = await import("../src/app/wallet/page");
  const tree = mod.default();
  return { tree, effects, setters, win, store };
}
type El = { props?: { children?: unknown; onClick?: () => unknown } };
/** The onClick of the first element whose own text children include `text`. */
function clickHandlerFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickHandlerFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const el = node as El;
  const kids = el.props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  if (typeof el.props?.onClick === "function" && own.includes(text)) return el.props.onClick;
  return clickHandlerFor(kids, text);
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("adversary r4c: restoring a saved wallet while the account changes in another tab", () => {
  it("after the account changed, a finishing restore does not put the old account's wallet back on screen", async () => {
    const { auth, otherTab } = browserAuth({ id: "A", email: "a@x.ng" });
    let finishRestore: (r: { contractId: string } | null) => void = () => {};
    const kit = {
      disconnect: async () => {},
      connectWallet: () => new Promise<{ contractId: string } | null>((res) => (finishRestore = res)),
    };
    const { effects, setters, win, store } = await renderWallet(auth, kit);
    store.set(WALLET_OWNER_KEY, "A"); // A's wallet was bound to A, so the page restores it
    effects.forEach((f) => f());
    await settle();

    // Another tab signs in B while the restore is still reading the chain.
    otherTab({ id: "B", email: "b@x.ng" });
    expect(win.location.reload).toHaveBeenCalledTimes(1);

    // The restore of A's wallet now finishes.
    finishRestore({ contractId: "CAWALLETOFACCOUNTA" });
    await settle();

    // WalletPage state order: state, name, account. The last thing the page
    // set for `state` must not be A's wallet.
    const lastState = setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; contractId?: string } | undefined;
    expect(lastState?.kind, "the page shows account A's wallet after the account changed to B").not.toBe("connected");
    expect(JSON.stringify(setters.filter((s) => s.i === 0).map((s) => s.v).slice(-1))).not.toContain("CAWALLETOFACCOUNTA");
  });

  it("after Sign out finished, a finishing restore does not put the signed-out account's wallet back on screen", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    let finishRestore: (r: { contractId: string } | null) => void = () => {};
    const kit = {
      disconnect: async () => {},
      connectWallet: () => new Promise<{ contractId: string } | null>((res) => (finishRestore = res)),
    };
    // state order in WalletPage: state, name, account (the Sign out control shows once the account is known)
    const { tree, effects, setters, win, store } = await renderWallet(auth, kit, [{ kind: "busy", label: "Checking for a saved wallet" }, "", { id: "A", email: "a@x.ng" }]);
    store.set(WALLET_OWNER_KEY, "A");
    effects.forEach((f) => f());
    await settle();

    await clickHandlerFor(tree, "Sign out")!();
    expect(auth.signOut).toHaveBeenCalled();
    expect(win.location.replace).toHaveBeenCalledWith("/signin");

    // The old page is still running until /signin replaces it; the restore finishes now.
    finishRestore({ contractId: "CAWALLETOFACCOUNTA" });
    await settle();

    const shown = setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string });
    expect(shown.at(-1)?.kind, "the page shows the wallet of an account that has just signed out").not.toBe("connected");
  });
});
