// Adversary r4e: restoring a saved wallet has no deadline. Every other wait on
// /wallet is bounded (Supabase 10 s, wallet disconnect 5 s, sign-out steps
// 10 s), but kit.connectWallet() is awaited bare, so a wallet kit whose RPC or
// storage never answers leaves the page on "Checking for a saved wallet..."
// for good: no create, no connect, no error.
// Spec: the person must not be left on a state that never ends (attacker goal 4);
// docs/decisions.md 2026-11-26 (r3d row) bounds the kit's disconnect for the
// same reason ("a stuck wallet kit blocked sign-out").
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

// WalletPage state order: state, name, account
async function renderWallet(auth: unknown, kit: unknown) {
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
        return [init, (v: unknown) => setters.push({ i: at, v })];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>([["caracal.walletOwner", "A"]]); // this account's saved wallet
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const mod = await import("../src/app/wallet/page");
  mod.default();
  return { effects, setters };
}

const auth = {
  getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }),
  getSession: async () => ({ data: { session: {} } }),
  signOut: async () => ({ error: null }),
  onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
};

describe("adversary r4e: /wallet restore of a saved wallet", () => {
  it("control: a restore that answers ends the 'Checking' state", async () => {
    const { effects, setters } = await renderWallet(auth, { disconnect: async () => {}, connectWallet: async () => ({ contractId: "CABC" }) });
    effects.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
    expect(setters.filter((s) => s.i === 0).map((s) => s.v)).toEqual([{ kind: "connected", contractId: "CABC" }]);
  });

  it("a wallet kit that never answers does not leave the page checking forever", async () => {
    vi.useFakeTimers();
    const kit = { disconnect: async () => {}, connectWallet: () => new Promise<never>(() => {}) };
    const { effects, setters } = await renderWallet(auth, kit);
    effects.forEach((f) => f());
    // Ten minutes: far past every other deadline on this page (5 s, 10 s).
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Defect: the state is never updated from "Checking for a saved wallet", no error, no way to create or connect.
    expect(setters.filter((s) => s.i === 0).length).toBeGreaterThan(0);
  });
});
