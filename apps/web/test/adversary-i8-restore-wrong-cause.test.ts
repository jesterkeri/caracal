// Adversary i8: the invoices page shows smart-account-kit's raw "not found on-chain" text when the
// saved wallet cannot be restored, a wrong cause when the network is simply unreachable.
//
// Spec: docs/decisions.md 2026-11-27, Adversary r4p row: smart-account-kit 0.10.0 says "Smart account
// contract not found on-chain for credential X. The wallet may not have been deployed yet." for ANY
// failed lookup of the wallet's contract, a network failure included, so "the page no longer shows that
// text" and names only the cause it can prove ("could not reach the Stellar network" when the network
// does not answer). The r4q row adds the same for a saved wallet on restore, with the way forward named.
// Attacker goal 4 (a wrong cause) and 5 (no way forward).
//
// The invoices page restores the saved wallet with kit.connectWallet() (invoices/page.tsx, inside
// `bounded(kit.connectWallet(), "Restoring your saved wallet")`) and passes whatever the kit throws on as
// "Caracal could not load your invoices. <kit text>". It never asks the network what is there
// (credentialInKitError / walletStatus are used by the wallet and pay pages only).
//
// The real smart-account-kit 0.10.0 and the real @stellar/stellar-sdk RPC client run, as in r4q. Stand-ins:
// the kit's storage (MemoryStorage with a saved session, since Node has no IndexedDB), the RPC's answers
// replaced on the SDK's prototype (no network use), React state stubbed as in the other page tests.
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

type St = { kind: string; message?: string };

/** Loads /invoices for account A, whose wallet (bound to A) the kit saved, with the chain answering as given. */
async function loadInvoices(chain: "no-entry" | "network-down"): Promise<St[]> {
  // A fresh module graph, so the mocks below apply to the kit however many loads ran before.
  vi.resetModules();
  const effects: (() => unknown)[] = [];
  const states: St[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      // Slot 0 is the page's `load` state.
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
  const mod = await import("../src/app/invoices/page");
  mod.default();
  effects.forEach((f) => f());
  // The kit is imported on first use, which can take a while: wait for the page to settle on a state.
  for (let t = 0; t < 100 && states.length === 0; t++) await settle();
  return states;
}

describe("adversary i8: the invoices page when the saved wallet cannot be restored", () => {
  it("control: the real kit's restore ran and the page ended in its error view with the kit's own text in the log", async () => {
    const states = await loadInvoices("network-down");
    const last = states.at(-1);
    expect(last?.kind, JSON.stringify(states)).toBe("error");
    expect(logged.join("\n")).toMatch(/Smart account contract not found on-chain/);
    expect(last?.message, last?.message).toMatch(/^Caracal could not load your invoices/);
  });

  it("the network is unreachable: the page must not say the wallet was not found or not deployed", async () => {
    const states = await loadInvoices("network-down");
    const last = states.at(-1);
    expect(last?.kind).toBe("error");
    // Defect: the kit's text for a failed lookup is shown as it is, so a person whose wallet exists and whose
    // network is down is told it "may not have been deployed yet".
    expect(last?.message, last?.message).not.toMatch(/not found on-chain|may not have been deployed/i);
  });

  it("the network answers and has no such wallet: the person is told what to do (sign out), not shown the kit's text", async () => {
    const states = await loadInvoices("no-entry");
    const last = states.at(-1);
    expect(last?.kind).toBe("error");
    expect(last?.message, last?.message).not.toMatch(/not found on-chain|may not have been deployed/i);
    expect(last?.message, last?.message).toMatch(/sign out/i);
  });
});
