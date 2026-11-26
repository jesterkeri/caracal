// Adversary r4a on the pages (rendered by calling the component with React's
// state and effects stubbed, as codex-r4-pages and adversary r3j do).
//
// 1. decisions.md 2026-11-26 (r3h row): "a wrong RPC setting is named as such,
//    not mistaken for a sign-in problem". The wallet page's catch-all still
//    blames the sign-in for every other failure after the sign-in was verified.
// 2. decisions.md 2026-11-26 (Codex R4 #2 row): the wallet page "follows the
//    account ... on a sign-out ... it clears what it shows and reloads". The
//    person's OWN sign-out is such an event too (supabase-js emits SIGNED_OUT
//    from signOut), so the page reloads in the middle of the sign-out, cutting
//    off the wallet disconnect that wallet-binding.ts promises ("Signing out
//    disconnects the wallet too"), and tells them another tab changed the account.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

type El = { type: unknown; props: { children?: unknown; onClick?: () => unknown; href?: string } };
type User = { id: string; email?: string | null };

function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (el.props?.href) out.push(`href:${el.props.href}`);
    texts(el.props?.children, out);
  }
  return out;
}
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

/** One browser's Supabase auth. Like supabase-js, signOut() emits SIGNED_OUT to every subscriber, this tab's too. */
function browserAuth(user: User) {
  let session: { user: User } | null = { user };
  const subscribers = new Set<(event: string, s: { user: User } | null) => void>();
  const auth = {
    getUser: vi.fn(async () => (session ? { data: { user: session.user }, error: null } : { data: { user: null }, error: new Error("Auth session missing!") })),
    getSession: vi.fn(async () => ({ data: { session } })),
    signOut: vi.fn(async () => {
      session = null;
      for (const cb of subscribers) cb("SIGNED_OUT", null);
      return { error: null };
    }),
    onAuthStateChange: (cb: (event: string, s: { user: User } | null) => void) => {
      subscribers.add(cb);
      return { data: { subscription: { unsubscribe: () => subscribers.delete(cb) } } };
    },
  };
  return { auth };
}

async function renderWallet(states: unknown[], auth: unknown, kit: unknown) {
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
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("adversary r4a: the wallet page names the failure it actually had", () => {
  it("Supabase confirmed the sign-in, but the wallet kit failed to restore the saved wallet: the page does not say the sign-in could not be checked", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    const kit = {
      disconnect: async () => {},
      // smart-account-kit's connectWallet reads the wallet from the Stellar RPC; the RPC is down.
      connectWallet: async () => {
        throw new Error("RPC request failed: 503 Service Unavailable");
      },
    };
    const { effects, setters, store } = await renderWallet([], auth, kit);
    store.set(WALLET_OWNER_KEY, "A");
    effects.forEach((f) => f());
    await settle();
    // Supabase verified the account (the page shows it) ...
    expect(setters.filter((s) => s.i === 2).map((s) => s.v)).toEqual([{ id: "A", email: "a@x.ng" }]);
    // ... so a failure after that point must not be reported as a sign-in problem.
    const shown = setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string; message?: string });
    const err = shown.find((s) => s.kind === "error");
    expect(err?.message).toBeDefined();
    expect(err!.message).not.toMatch(/check your sign-in/i);
  });
});

describe("adversary r4a: signing out from this tab", () => {
  it("does not reload the page while the wallet disconnect is still running", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    let disconnected = false;
    const kit = {
      disconnect: async () => {
        await new Promise((r) => setTimeout(r, 60));
        disconnected = true;
      },
      connectWallet: async () => null,
    };
    const { tree, effects, win, store } = await renderWallet([{ kind: "idle" }, "", { id: "A", email: "a@x.ng" }], auth, kit);
    store.set(WALLET_OWNER_KEY, "A");
    effects.forEach((f) => f());
    await settle();
    let reloadedWhileDisconnecting = false;
    win.location.reload.mockImplementation(() => {
      if (!disconnected) reloadedWhileDisconnecting = true;
    });
    await clickHandlerFor(tree, "Sign out")!();
    expect(auth.signOut).toHaveBeenCalled();
    expect(reloadedWhileDisconnecting).toBe(false);
  });

  it("does not tell the person another tab changed their account", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    const kit = { disconnect: async () => {}, connectWallet: async () => null };
    const { tree, effects, setters, store } = await renderWallet([{ kind: "idle" }, "", { id: "A", email: "a@x.ng" }], auth, kit);
    store.set(WALLET_OWNER_KEY, "A");
    effects.forEach((f) => f());
    await settle();
    setters.length = 0;
    await clickHandlerFor(tree, "Sign out")!();
    const labels = setters.filter((s) => s.i === 0).map((s) => (s.v as { label?: string }).label ?? "");
    expect(labels.join(" | ")).not.toMatch(/another tab/i);
    expect(texts(tree).join(" ")).not.toMatch(/another tab/i);
  });
});
