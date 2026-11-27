// Follow-up to adversary r5e: the escape passes on the wallet the page showed,
// not whatever is remembered at click time. So when another tab records a
// different wallet for this account after the page showed W1, the escape is
// still refused ("created or connected in another tab") and nothing is created.
import { afterEach, describe, expect, it, vi } from "vitest";
import { WALLET_OWNER_KEY, KNOWN_WALLETS_KEY } from "../src/lib/auth/wallet-binding";
import { CREATION_STARTED_AT_KEY, CREATION_UNCONFIRMED_KEY } from "../src/lib/auth/creation-marker";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function clickFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return clickFor(kids, text);
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

const A = { id: "A", email: "a@x.ng" };
const W1 = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const W2 = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
type S = { kind: string; message?: string; checkFirst?: boolean; remembered?: string };

async function render(state: S, local: Map<string, string>, createWallet: () => Promise<unknown>) {
  vi.resetModules();
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    const init = [state, "Ada", A];
    return {
      ...actual,
      default: actual,
      useState: (v: unknown) => {
        const at = i++;
        return [at < init.length ? init[at] : v, (n: unknown) => setters.push({ i: at, v: n })];
      },
      useEffect: () => {},
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const kit = { events: { on: () => () => {} }, disconnect: async () => {}, connectWallet: async () => null, createWallet, rpc: undefined };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), last: () => setters.filter((s) => s.i === 0).at(-1)?.v as S | undefined };
}

describe("the escape after an unknown second-wallet attempt", () => {
  it("is refused when another tab recorded a different wallet for this account since the page showed W1", async () => {
    const local = new Map<string, string>([
      [WALLET_OWNER_KEY, A.id],
      [KNOWN_WALLETS_KEY, JSON.stringify({ [A.id]: W1 })],
      [CREATION_UNCONFIRMED_KEY, A.id],
      [CREATION_STARTED_AT_KEY, String(Date.now() - 4 * 60_000)],
    ]);
    const createWallet = vi.fn(async () => {
      throw new Error("not reached");
    });
    // The page shows the unknown outcome of a second wallet beside W1.
    const page = await render({ kind: "error", message: "An earlier wallet creation for this account could not be confirmed.", checkFirst: true, remembered: W1 }, local, createWallet);
    // Meanwhile another tab created and recorded W2 for this account.
    local.set(KNOWN_WALLETS_KEY, JSON.stringify({ [A.id]: W2 }));
    const escape = clickFor(page.tree, "Start a new one anyway");
    expect(escape).not.toBeNull();
    await escape!();
    expect(createWallet).not.toHaveBeenCalled();
    expect(page.last()?.message ?? "").toMatch(/another tab/);
  });
});
