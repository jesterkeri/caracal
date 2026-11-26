// Adversary r4q: a saved wallet that is no longer on the chain is reported as a
// connection problem, forever, with no way forward.
//
// Spec: docs/decisions.md 2026-11-27 r4p row: smart-account-kit says "Smart
// account contract not found on-chain" for ANY failed lookup, so the page asks
// the kit's RPC for the latest ledger and names the cause it can prove ("No
// wallet was found" when the network answers, "could not reach" when it does
// not). Attacker goals 3 (a wrong cause) and 4 (no way forward).
// The restore path on load (wallet/page.tsx, kit.connectWallet() with no
// options) gets the same kit error, but is not given that check: it always
// shows WALLET_UNCHECKED, "Check your connection and reload the page", even
// when the network answers. A kit session lives 7 days
// (DEFAULT_SESSION_EXPIRY_MS), so a wallet that vanished inside that window
// (a testnet reset, say) leaves the person on that message after every reload:
// the owner binding stays, restore throws again, Create is never offered (a
// saved wallet that cannot be loaded keeps Create hidden), and Connect only
// says "no wallet found" and also keeps Create hidden.
//
// The real smart-account-kit 0.10.0 and the real @stellar/stellar-sdk RPC
// client run. Stand-ins: the kit's storage (MemoryStorage instead of
// IndexedDB, which Node lacks) holding a saved session, and the RPC's two
// answers (getLedgerEntries: no entry; getLatestLedger: a ledger) replaced on
// the SDK's prototype, so there is no network use. React's state and effects
// are stubbed as in r4e and r4p. Any fix that does not blame the connection
// when the network answers, and leaves a way forward, passes.
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("smart-account-kit");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
});

const A = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 50));

const logged: string[] = [];

type St = { kind: string; message?: string; createAllowed?: boolean; knownWallet?: boolean };

/** Loads /wallet for account A, whose wallet (bound to A) was saved by the kit, with the chain answering as given. */
async function loadWallet(chain: "no-entry" | "network-down"): Promise<St[]> {
  const effects: (() => unknown)[] = [];
  const states: St[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (v: unknown) => {
        const at = i++;
        return [v, (n: St) => at === 0 && states.push(n)];
      },
      useEffect: (fn: () => unknown) => void effects.push(fn),
    };
  });
  vi.doMock("smart-account-kit", async () => {
    const actual = await vi.importActual<typeof import("smart-account-kit")>("smart-account-kit");
    class Saved extends actual.MemoryStorage {
      constructor() {
        super();
        // What the kit saved when this person created or connected their wallet (7 day session).
        void this.saveSession({ contractId: "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX", credentialId: "AQIDBAUGBwg", connectedAt: Date.now(), expiresAt: Date.now() + 3 * 24 * 3600_000 });
      }
    }
    return { ...actual, IndexedDBStorage: Saved };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "https://rpc.test.invalid");
  if (chain === "no-entry") {
    // The RPC answers, and has no instance entry for the saved wallet's address.
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValue({ entries: [], latestLedger: 100 } as never);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockResolvedValue({ id: "x", sequence: 100, protocolVersion: 25 } as never);
  } else {
    const refused = () => Promise.reject(new Error("connect ECONNREFUSED"));
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation(refused as never);
    vi.spyOn(rpc.Server.prototype, "getLatestLedger").mockImplementation(refused as never);
  }
  const local = new Map<string, string>([["caracal.walletOwner", "A"]]);
  const loc = { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", hostname: "caracal.test", search: "" };
  vi.stubGlobal("window", {
    location: loc,
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  vi.stubGlobal("location", loc);
  logged.length = 0;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(" ")));
  const mod = await import("../src/app/wallet/page");
  mod.default();
  effects.forEach((f) => f());
  // The kit is imported on first use, which can take a while: wait for the page to settle on a state.
  for (let t = 0; t < 100 && states.length === 0; t++) await settle();
  return states;
}

describe("adversary r4q: a saved wallet that is no longer on the chain", () => {
  it("control: with the network down the page asks for a connection check (real kit, real restore)", async () => {
    const states = await loadWallet("network-down");
    const last = states.at(-1);
    expect(last?.kind).toBe("error");
    expect(last?.message, last?.message).toMatch(/check your connection/i);
  });

  it("the network answers and has no such wallet: the page must not blame the connection", async () => {
    const states = await loadWallet("no-entry");
    const last = states.at(-1);
    expect(last?.kind, JSON.stringify(states)).toBe("error");
    // Harness: the real kit's restore read the chain, found no instance entry, and the page reported a failure to load.
    expect(logged.join("\n")).toMatch(/Smart account contract not found on-chain/);
    expect(last?.message, last?.message).toMatch(/saved wallet/i);
    // Defect: the same kit error as in Connect, but the connection is blamed.
    expect(last?.message, last?.message).not.toMatch(/check your connection/i);
  });

  it("the network answers and has no such wallet: the person is left a way forward", async () => {
    const states = await loadWallet("no-entry");
    const last = states.at(-1) as St;
    const createOffered = (last.kind === "idle" && !last.knownWallet) || (last.kind === "error" && last.createAllowed === true);
    // Neither Create nor an instruction that works (Sign out and in drops the stale binding).
    expect(createOffered || /sign out/i.test(last.message ?? ""), JSON.stringify(last)).toBe(true);
  });
});
