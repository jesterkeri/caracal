// Adversary s1: /split restores the saved wallet with no deadline. The wallet
// page bounds loading the kit and kit.connectWallet() at 30 s (docs/decisions.md
// 2026-11-26, "Loading the wallet kit and restoring a saved wallet each have a
// 30 s limit, after which the page says it could not load the saved wallet";
// adversary-r4e-restore-hang.test.ts). The split page's restoreWallet awaits both
// bare, so a kit whose storage or RPC never answers leaves /split on
// "Checking for your wallet..." for good: no error, no way forward.
// Attacker goal 5: a page that hangs without bound.
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

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

// SplitPage state order: view, form, note, account
async function renderSplit(getKit: () => Promise<unknown>) {
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
  const user = { id: "A", email: "a@x.ng" };
  const auth = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { user } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>([["caracal.walletOwner", "A"]]); // this account's saved wallet
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const mod = await import("../src/app/split/page");
  mod.default();
  return { effects, setters };
}

const views = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string });

describe("adversary s1: /split restore of a saved wallet", () => {
  it("control: a restore that answers ends the 'Checking' state", async () => {
    const kit = { rpc: {}, disconnect: async () => {}, connectWallet: async () => ({ contractId: WALLET }) };
    const { effects, setters } = await renderSplit(() => Promise.resolve(kit));
    effects.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
    expect(views(setters).length).toBeGreaterThan(0);
  });

  it("a wallet kit whose connectWallet never answers does not leave the page checking forever", async () => {
    vi.useFakeTimers();
    const kit = { rpc: {}, disconnect: async () => {}, connectWallet: () => new Promise<never>(() => {}) };
    const { effects, setters } = await renderSplit(() => Promise.resolve(kit));
    effects.forEach((f) => f());
    // Ten minutes: far past the 30 s the wallet page allows.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    // Defect: the view is never updated from "checking": no error, no way forward.
    expect(views(setters).length).toBeGreaterThan(0);
  });

  it("a wallet kit that never finishes loading does not leave the page checking forever", async () => {
    vi.useFakeTimers();
    const { effects, setters } = await renderSplit(() => new Promise<never>(() => {}));
    effects.forEach((f) => f());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(views(setters).length).toBeGreaterThan(0);
  });
});
