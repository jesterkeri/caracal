// Codex R4 #2: an open wallet page did not react when the app account changed
// in another tab, and recorded a new wallet as owned by the account it loaded
// with. Codex R4 #3: a session stored in this browser that Supabase could not
// verify was shown as "Signed in".
import { describe, expect, it, vi } from "vitest";
import { bindIfStillSignedIn, followAccount, readSignInState, type AccountAuth } from "../src/lib/auth/account";
import { WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";

type User = { id: string; email?: string | null };
/** A Supabase auth client for one browser: tabs share its session, and its events reach every tab's subscribers. */
function browserAuth(user: User | null, opts: { verify?: "ok" | "offline" | "throws" } = {}) {
  let session: { user: User } | null = user ? { user } : null;
  const subscribers = new Set<(event: string, s: { user: User } | null) => void>();
  const auth: AccountAuth = {
    async getUser() {
      if (opts.verify === "throws") throw new TypeError("Failed to fetch");
      if (opts.verify === "offline") return { data: { user: null }, error: new Error("AuthRetryableFetchError") };
      return session ? { data: { user: session.user }, error: null } : { data: { user: null }, error: new Error("Auth session missing!") };
    },
    async getSession() {
      return { data: { session } };
    },
    onAuthStateChange(cb) {
      subscribers.add(cb);
      queueMicrotask(() => cb("INITIAL_SESSION", session));
      return { data: { subscription: { unsubscribe: () => subscribers.delete(cb) } } };
    },
  };
  /** What another tab does: sign out, or sign in as someone else. */
  const otherTab = (next: User | null) => {
    session = next ? { user: next } : null;
    for (const cb of subscribers) cb(next ? "SIGNED_IN" : "SIGNED_OUT", session);
  };
  return { auth, otherTab, subscribers };
}
const memoryStore = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("codex r4 #3: what the sign-in page may claim", () => {
  it("a session Supabase confirms is verified, with its id and email", async () => {
    expect(await readSignInState(browserAuth({ id: "A", email: "a@x.ng" }).auth)).toEqual({ kind: "verified", id: "A", email: "a@x.ng" });
  });
  it.each(["offline", "throws"] as const)("a stored session Supabase cannot confirm (%s) is unverified, never signed in", async (verify) => {
    expect(await readSignInState(browserAuth({ id: "A", email: "a@x.ng" }, { verify }).auth)).toEqual({ kind: "unverified" });
  });
  it("no session at all is signed out", async () => {
    expect(await readSignInState(browserAuth(null).auth)).toEqual({ kind: "signed-out" });
    expect(await readSignInState(browserAuth(null, { verify: "offline" }).auth)).toEqual({ kind: "signed-out" });
  });
  it("a stored session that cannot even be read is unverified (sign-out stays offered)", async () => {
    const { auth } = browserAuth({ id: "A" }, { verify: "throws" });
    auth.getSession = async () => {
      throw new DOMException("storage is blocked", "SecurityError");
    };
    expect(await readSignInState(auth)).toEqual({ kind: "unverified" });
  });
});

describe("codex r4 #2: the wallet page follows the signed-in account", () => {
  it("a sign-out in another tab is reported once", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const changed = vi.fn();
    followAccount(auth, "A", changed);
    await flush(); // INITIAL_SESSION for A: no change
    expect(changed).not.toHaveBeenCalled();
    otherTab(null);
    otherTab(null);
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("another account signing in, in another tab, is reported", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const changed = vi.fn();
    followAccount(auth, "A", changed);
    otherTab({ id: "B" });
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("a change that happened before the page subscribed is reported from the initial session", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    otherTab({ id: "B" });
    const changed = vi.fn();
    followAccount(auth, "A", changed);
    await flush();
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it("unsubscribing stops it", async () => {
    const { auth, otherTab, subscribers } = browserAuth({ id: "A" });
    const changed = vi.fn();
    followAccount(auth, "A", changed)();
    otherTab({ id: "B" });
    expect(changed).not.toHaveBeenCalled();
    expect(subscribers.size).toBe(0);
  });

  it("page loaded as A, B signed in elsewhere, then A's tab creates a wallet: not recorded as A's, and disconnected", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const store = memoryStore();
    const disconnect = vi.fn(async () => {});
    otherTab({ id: "B" });
    expect(await bindIfStillSignedIn(store, auth, { disconnect }, "A")).toBe("account-changed");
    expect(store.m.has(WALLET_OWNER_KEY)).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it("signed out elsewhere before the wallet was created: not recorded, disconnected", async () => {
    const { auth, otherTab } = browserAuth({ id: "A" });
    const store = memoryStore();
    const disconnect = vi.fn(async () => {});
    otherTab(null);
    expect(await bindIfStillSignedIn(store, auth, { disconnect }, "A")).toBe("account-changed");
    expect(store.m.has(WALLET_OWNER_KEY)).toBe(false);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
  it("still the same account: recorded as its own", async () => {
    const { auth } = browserAuth({ id: "A" });
    const store = memoryStore();
    expect(await bindIfStillSignedIn(store, auth, { disconnect: async () => {} }, "A")).toBe("bound");
    expect(store.m.get(WALLET_OWNER_KEY)).toBe("A");
  });
  it("the account cannot be confirmed: nothing recorded (this visit only), wallet kept connected", async () => {
    const { auth } = browserAuth({ id: "A" }, { verify: "offline" });
    const store = memoryStore();
    const disconnect = vi.fn(async () => {});
    expect(await bindIfStillSignedIn(store, auth, { disconnect }, "A")).toBe("not-saved");
    expect(store.m.has(WALLET_OWNER_KEY)).toBe(false);
    expect(disconnect).not.toHaveBeenCalled();
  });
  it("storage refuses the binding: not-saved, no throw", async () => {
    const { auth } = browserAuth({ id: "A" });
    const store = { ...memoryStore(), setItem: () => { throw new DOMException("full", "QuotaExceededError"); } };
    expect(await bindIfStillSignedIn(store, auth, { disconnect: async () => {} }, "A")).toBe("not-saved");
  });
});
