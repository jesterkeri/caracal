// Adversary r5a. Promise (docs/decisions.md, 2026-11-27, Codex R5 #4 row): after Connect's
// "not found on-chain", "an entry past its live-until ledger means it must be restored (no
// new wallet suggested); a live entry means the wallet exists". And (2026-11-26, r4i/r4j
// rows): the way to a new wallet "is not offered where a wallet is proven (a failed Connect,
// a saved wallet that could not load)". The page's own text for the archived case ends
// "Do not create another wallet."
//
// Defect: an account that has a remembered wallet (caracal.knownWallets, Codex R5 #3) and
// whose Connect then proves the wallet exists (expired data, or live but unreadable, or one
// of the kit's proof errors) is shown the proven-wallet message AND, directly below it,
// "Make a second, new wallet instead", because the remembered-wallet block only tests
// !checkFirst && !createOffered (wallet/page.tsx, the `state.remembered` block).
import { afterEach, describe, expect, it, vi } from "vitest";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
function click(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = click(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return click(kids, text);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const KNOWN = "caracal.knownWallets";
const A = { id: "A", email: "a@x.ng" };
const WALLET_A = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const KIT_NOT_FOUND = "Smart account contract not found on-chain for credential AQIDBAUGBwgJCgsMDQ4PEA. The wallet may not have been deployed yet.";
const settle = () => new Promise((r) => setTimeout(r, 20));

function browser(connectError: Error, rpcFake: unknown) {
  const local = new Map<string, string>();
  const kit = {
    events: { on: (_e: string, _cb: () => void) => () => {} },
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => {
      throw connectError;
    },
    createWallet: async () => ({ contractId: "CX", submitResult: { success: true, hash: "ab".repeat(32) } }),
    rpc: rpcFake as unknown,
  };
  return { local, kit };
}

async function render(b: ReturnType<typeof browser>, states: unknown[] = []) {
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
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(b.kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => b.local.get(k) ?? null, setItem: (k: string, v: string) => void b.local.set(k, v), removeItem: (k: string) => void b.local.delete(k) },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string };

/** What the person sees after pressing "I already have a wallet" on an account that remembers WALLET_A. */
async function afterConnect(b: ReturnType<typeof browser>) {
  b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
  const first = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "", A]);
  await click(first.tree, "I already have a wallet")!();
  await settle();
  const state = lastState(first.setters);
  vi.resetModules();
  const shown = texts((await render(b, [state, "", A])).tree).join(" | ");
  return { state, shown };
}

describe("adversary r5a: no new wallet is offered where Connect proved the wallet exists", () => {
  it("control: Connect finds no contract at the passkey's address, so the second-wallet choice stays (nothing proven)", async () => {
    const b = browser(new Error(KIT_NOT_FOUND), { getLedgerEntries: async () => ({ entries: [], latestLedger: 5 }) });
    const { shown } = await afterConnect(b);
    expect(shown).toMatch(/No wallet was found on Stellar testnet for this passkey/);
    expect(shown).toMatch(/Make a second, new wallet instead/);
  });

  it("the wallet exists but its data expired: 'Do not create another wallet' is not shown next to 'Make a second, new wallet instead'", async () => {
    const b = browser(new Error(KIT_NOT_FOUND), { getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 3 }], latestLedger: 5 }) });
    const { state, shown } = await afterConnect(b);
    expect(state.message).toMatch(/Do not create another wallet/);
    expect(shown).not.toMatch(/Make a second, new wallet instead/);
  });

  it("the wallet exists and is live but could not be loaded: no new wallet is suggested", async () => {
    const b = browser(new Error(KIT_NOT_FOUND), { getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 99 }], latestLedger: 5 }) });
    const { state, shown } = await afterConnect(b);
    expect(state.message).toMatch(/Your wallet exists on Stellar testnet/);
    expect(shown).not.toMatch(/Make a second, new wallet instead/);
  });

  it("the kit proves a wallet at the passkey's address (provenance): no new wallet is suggested", async () => {
    const e = new Error("wallet provenance could not be proven");
    e.name = "WalletProvenanceError";
    const b = browser(e, undefined);
    const { shown } = await afterConnect(b);
    expect(shown).not.toMatch(/Make a second, new wallet instead/);
  });
});
