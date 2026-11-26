// Adversary r4i: "I already have a wallet" fails with an error that proves a
// wallet exists at the person's passkey's address, and /wallet still offers
// "Create wallet with a passkey" under it.
//
// Spec: docs/decisions.md 2026-11-26 (r4g row, #44): "Create is offered only
// where the page knows this account has no wallet yet: after the restore found
// none, after a passkey prompt that failed (nothing sent), or after the relay
// said 'Nothing was sent'." A failed Connect is none of the three. Goal 5: a
// person is led into creating a second wallet when one may already exist.
// Cause: apps/web/src/app/wallet/page.tsx connect(): the catch sets
// `createAllowed: couldCreate`, the value from before the person said they
// have a wallet. smart-account-kit 0.10.0 connectWallet({ fresh: true })
// (dist/kit/wallet-ops.js connectWithCredentials) throws WalletProvenanceError
// (indexer incomplete or stale: routine on a second device, which has no local
// credential), WalletAmbiguousError, WalletOwnershipError or
// WalletCodeNotAcceptedError only AFTER rpc.getContractData found a contract at
// the passkey's derived address. Each one means a wallet exists.
// The errors are the kit's own classes. Rendered by calling the component with
// React's state and effects stubbed, as adversary-r4g does.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletAmbiguousError, WalletProvenanceError } from "smart-account-kit";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const CREATE = "Create wallet with a passkey";
const CONNECT = "I already have a wallet";
// Any valid contract strkey: it only appears in the kit's error text.
const DERIVED = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
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
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const click = (node as El).props?.onClick;
  if (typeof click === "function" && own.trim() === text) return click;
  return clickHandlerFor(kids, text);
}

const A = { id: "A", email: "a@x.ng" };
type S = { kind: string; message?: string; createAllowed?: boolean; knownWallet?: boolean };

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], connectWallet: (o?: unknown) => Promise<unknown>) {
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
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: () => Promise.resolve({ disconnect: async () => {}, connectWallet }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), setters };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

/** This account has no saved wallet here (Create offered). The person clicks "I already have a wallet" and Connect throws `err`. */
async function shownAfterFailedConnect(err: Error) {
  const connectWallet = vi.fn(async () => {
    throw err;
  });
  const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], connectWallet);
  expect(texts(tree).join(" | "), "harness: Create is offered before Connect").toContain(CREATE);
  await clickHandlerFor(tree, CONNECT)!();
  await settle();
  expect(connectWallet).toHaveBeenCalledWith({ fresh: true });
  const state = setters.filter((s) => s.i === 0).map((s) => s.v as S).at(-1)!;
  vi.resetModules();
  const { tree: after } = await renderWallet([state, "", A], connectWallet);
  return { state, shown: texts(after).join(" | ") };
}

describe("adversary r4i: a failed Connect that proves a wallet exists", () => {
  it("control: a Connect that fails shows its error and keeps Connect", async () => {
    const { state, shown } = await shownAfterFailedConnect(new Error("The passkey prompt was closed"));
    expect(state.kind).toBe("error");
    expect(shown).toContain("The passkey prompt was closed");
    expect(shown).toContain(CONNECT);
  });

  it("the indexer could not vouch for the wallet at the passkey's address: Create is not offered", async () => {
    const { state, shown } = await shownAfterFailedConnect(
      new WalletProvenanceError(DERIVED, "The indexer did not return one complete schema-2 birth claim."),
    );
    expect(state.kind).toBe("error");
    expect(shown).toContain("indexer");
    expect(shown).toContain(CONNECT);
    // Defect: a contract exists at the address (the kit read it before throwing),
    // and Create is offered right under the error.
    expect(shown).not.toContain(CREATE);
  });

  it("several wallets match this passkey: Create is not offered", async () => {
    const { shown } = await shownAfterFailedConnect(new WalletAmbiguousError([DERIVED, "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"]));
    expect(shown).not.toContain(CREATE);
  });
});
