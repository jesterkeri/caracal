// Codex R4 #2 and #3 on the pages themselves (rendered by calling the
// component with React's state and effects stubbed, as adversary r3j does).
// #2: the wallet page must react when the account changes in another tab, and
//     must not record a new wallet as owned by the account it loaded with.
// #3: the sign-in page must not say "Signed in" for a session Supabase could
//     not verify, and must keep its sign-out control.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

type El = { type: unknown; props: { children?: unknown; onClick?: () => unknown; href?: string } };
type User = { id: string; email?: string | null };

/** Every string and every href in a rendered tree. */
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

async function renderPage(path: "wallet" | "signin", states: unknown[], auth: unknown, kit: unknown = { disconnect: async () => {} }) {
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
  const mod = await import(path === "wallet" ? "../src/app/wallet/page" : "../src/app/signin/page");
  const tree = mod.default();
  return { tree, effects, setters, win, store };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("codex r4 #3: sign-in page", () => {
  it("a stored session Supabase could not verify is not shown as signed in, and keeps Sign out", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    // state order in SignIn: error, signIn, busy
    const { tree } = await renderPage("signin", [null, { kind: "unverified" }, false], auth);
    const all = texts(tree).join(" | ");
    expect(all).not.toMatch(/Signed in/);
    expect(all).not.toMatch(/href:\/wallet/);
    expect(all).toMatch(/could not verify your sign-in/);
    const click = clickHandlerFor(tree, "Sign out");
    expect(click).not.toBeNull();
    await click!();
    expect(auth.signOut).toHaveBeenCalled();
  });

  it("the page's check stores 'unverified' (not an email) when Supabase cannot be reached", async () => {
    const { auth } = browserAuth({ id: "A", email: "a@x.ng" });
    auth.getUser.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    const { effects, setters } = await renderPage("signin", [], auth);
    effects.forEach((f) => f());
    await settle();
    expect(setters.filter((s) => s.i === 1).map((s) => s.v)).toEqual([{ kind: "unverified" }]);
  });
});

describe("codex r4 #2: wallet page", () => {
  it("a sign-out in another tab clears the account shown and reloads the page", async () => {
    const { auth, otherTab } = browserAuth({ id: "A", email: "a@x.ng" });
    const kit = { disconnect: async () => {}, connectWallet: async () => null };
    const { effects, setters, win } = await renderPage("wallet", [], auth, kit);
    effects.forEach((f) => f());
    await settle();
    // state order in WalletPage: state, name, account
    expect(setters.filter((s) => s.i === 2).map((s) => s.v)).toEqual([{ id: "A", email: "a@x.ng" }]);
    otherTab(null);
    expect(setters.filter((s) => s.i === 2).map((s) => s.v).at(-1)).toBeNull();
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("another account signing in, in another tab, reloads the page", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const { effects, win } = await renderPage("wallet", [], auth, { disconnect: async () => {}, connectWallet: async () => null });
    effects.forEach((f) => f());
    await settle();
    otherTab({ id: "B" });
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("loaded as A, B signs in elsewhere, then this tab creates a wallet: it is not recorded as A's", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const disconnect = vi.fn(async () => {});
    const kit = { disconnect, createWallet: async () => ({ contractId: "CNEW", submitResult: { success: true, hash: "ab".repeat(32) } }) };
    // The page has A as its account (its state from load); events were missed.
    const { tree, store, win } = await renderPage("wallet", [{ kind: "idle" }, "", { id: "A", email: null }], auth, kit);
    otherTab({ id: "B" });
    const click = clickHandlerFor(tree, "Create wallet");
    expect(click).not.toBeNull();
    await click!();
    expect(store.get(WALLET_OWNER_KEY)).toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(win.location.reload).toHaveBeenCalledTimes(1);
  });

  it("still A when the wallet is created: recorded as A's", async () => {
    const { auth } = browserAuth({ id: "A" });
    const kit = { disconnect: async () => {}, createWallet: async () => ({ contractId: "CNEW", submitResult: { success: true, hash: "ab".repeat(32) } }) };
    const { tree, store } = await renderPage("wallet", [{ kind: "idle" }, "", { id: "A", email: null }], auth, kit);
    await clickHandlerFor(tree, "Create wallet")!();
    expect(store.get(WALLET_OWNER_KEY)).toBe("A");
  });
});
