// Adversary r4n: the browser blocks site storage (or has no IndexedDB), the real
// wallet kit cannot start, and /wallet tells the person to "check your
// connection and reload", which can never help. Create is not offered either, so
// nothing on the page names the real cause or a way forward.
//
// Spec: docs/decisions.md 2026-11-26 (r4a row): "The wallet page names what
// failed"; the r3j row treats "a browser that blocks site storage" as a case the
// pages must handle. Attacker goals 3 (a wrong cause for a failure) and 4 (no
// way forward).
// Cause: smart-account-kit 0.10.0 reads the global `localStorage` in its
// constructor (dist/kit.js, `typeof localStorage !== "undefined"`), which throws
// a SecurityError when storage is blocked, and its IndexedDBStorage rejects with
// "IndexedDB is not available in this environment" when there is no IndexedDB.
// apps/web/src/app/wallet/page.tsx turns every such failure of getKit() or
// kit.connectWallet() into WALLET_UNCHECKED ("... Check your connection and
// reload the page."), whatever the cause; every earlier test used a fake kit,
// so this was never run against the real one.
// Any fix that names the real cause (storage or IndexedDB) instead of blaming
// the connection passes these tests. Rendered by calling the component with
// React's state and effects stubbed, as adversary-r4m does.
import { afterEach, describe, expect, it, vi } from "vitest";

const hadLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
  if (hadLocalStorage) Object.defineProperty(globalThis, "localStorage", hadLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const CREATE = "Create wallet with a passkey";
const A = { id: "A", email: "a@x.ng" };

type El = { props?: { children?: unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}

type Storage3 = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
function workingStorage(owner: string | null): Storage3 {
  const m = new Map<string, string>(owner ? [["caracal.walletOwner", owner]] : []);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
function blockStorage() {
  const denied = () => {
    throw new DOMException("Failed to read the 'localStorage' property from 'Window': Access is denied for this document.", "SecurityError");
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: denied });
  return denied;
}

/** Page order of useState: state, name, account. Returns what the person reads after the page loaded. */
async function pageAfterLoad(opts: { kit?: unknown; store: "working" | "blocked"; owner: string | null }) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
  let current: unknown[] = [];
  let cursor = 0;
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const at = cursor++;
        return [at < current.length ? current[at] : init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  if (opts.kit) vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(opts.kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const page = {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", hostname: "caracal.test", search: "" },
  } as Record<string, unknown>;
  if (opts.store === "blocked") {
    const denied = blockStorage();
    Object.defineProperty(page, "localStorage", { get: denied });
  } else {
    page.localStorage = workingStorage(opts.owner);
  }
  vi.stubGlobal("window", page);
  vi.stubGlobal("location", page.location);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  mod.default();
  effects.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 200));
  const at = (i: number) => setters.filter((s) => s.i === i).map((s) => s.v).at(-1);
  current = [at(0) ?? { kind: "busy" }, "", at(2) ?? null];
  cursor = 0;
  effects.length = 0;
  const shown = texts(mod.default()).join(" | ");
  return { state: at(0) as { kind: string; message?: string } | undefined, shown };
}

describe("adversary r4n: the real wallet kit cannot start in this browser", () => {
  it("control: with a working kit and nothing saved, the page loads and offers Create", async () => {
    const kit = { disconnect: async () => {}, connectWallet: async () => null };
    const { state, shown } = await pageAfterLoad({ kit, store: "working", owner: null });
    expect(state?.kind).toBe("idle");
    expect(shown).toContain(CREATE);
  });

  it("control: the real getKit() starts when storage works", async () => {
    vi.stubGlobal("window", { location: { origin: "https://caracal.test", hostname: "caracal.test" } });
    vi.stubGlobal("location", { origin: "https://caracal.test", hostname: "caracal.test" });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: workingStorage(null) });
    const { getKit } = await import("../src/lib/stellar/kit");
    await expect(getKit()).resolves.toBeDefined();
  });

  it("storage blocked by the browser: the page names the storage, not the connection", async () => {
    const { state, shown } = await pageAfterLoad({ store: "blocked", owner: null });
    // The kit failed to start (a SecurityError from localStorage), after a verified sign-in.
    expect(state?.kind).toBe("error");
    // Defect: "Check your connection and reload the page." Neither can help.
    expect(shown, shown).not.toMatch(/check your connection/i);
    expect(shown, shown).toMatch(/storage|site data|cookies/i);
  });

  it("no IndexedDB, with this account's wallet recorded: the page names the storage, not the connection", async () => {
    // Real kit, localStorage works, but the browser has no IndexedDB (Node has none, as a locked-down browser).
    const { state, shown } = await pageAfterLoad({ store: "working", owner: "A" });
    expect(state?.kind).toBe("error");
    expect(shown, shown).not.toMatch(/check your connection/i);
    expect(shown, shown).toMatch(/storage|indexeddb|site data|private/i);
  });
});
