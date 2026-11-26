// Adversary r4f: when restoring a saved wallet that this browser has recorded as
// this account's fails (RPC unreachable), /wallet says "could not load your
// saved wallet" and offers "Create wallet with a passkey" beside Connect.
//
// Spec: docs/decisions.md 2026-11-26 (r3e row) "a second passkey and an orphan
// wallet" is the harm to avoid; (r4e row) after an unknown wallet outcome "only
// Connect is offered, not Create". Here a wallet is known to exist (the owner
// binding says so), so a failed load must not lead into a second one.
// Cause: apps/web/src/app/wallet/page.tsx offers Create for every
// `account && (idle || error)` state except the one exact WALLET_MAYBE_CREATED.
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

type El = { props?: { children?: unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}

const A = { id: "A", email: "a@x.ng" };
const quiet = () => ({ data: { subscription: { unsubscribe() {} } } });

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], boundOwner: string | null, connectWallet: () => Promise<unknown>) {
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
  const auth = { getUser: async () => ({ data: { user: A }, error: null }), getSession: async () => ({ data: { session: {} } }), onAuthStateChange: quiet, signOut: async () => ({ error: null }) };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: () => Promise.resolve({ disconnect: async () => {}, connectWallet }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => boundOwner, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

async function shownAfterLoad(boundOwner: string | null, connectWallet: () => Promise<unknown>) {
  const { effects, setters } = await renderWallet([], boundOwner, connectWallet);
  effects.forEach((f) => f());
  await settle();
  const state = setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string; message?: string }).at(-1)!;
  vi.resetModules();
  const { tree } = await renderWallet([state, "", A], boundOwner, connectWallet);
  return { state, shown: texts(tree).join(" | ") };
}

describe("adversary r4f: a saved wallet that fails to load", () => {
  it("control: no saved wallet at all (restore finds nothing) offers Create", async () => {
    const { state, shown } = await shownAfterLoad(null, async () => null);
    expect(state.kind).toBe("idle");
    expect(shown).toContain("Create wallet with a passkey");
  });

  it("a wallet recorded as this account's that cannot be loaded does not offer Create", async () => {
    const { state, shown } = await shownAfterLoad("A", async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(state.kind).toBe("error");
    expect(state.message).toMatch(/could not load your saved wallet/);
    expect(shown).toContain("I already have a wallet");
    // Defect: Create is offered although a wallet for this account exists.
    expect(shown).not.toContain("Create wallet with a passkey");
  });
});
