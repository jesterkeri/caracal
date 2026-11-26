// Adversary r4p: "I already have a wallet" while the Stellar RPC cannot be
// reached tells the person "The wallet may not have been deployed yet", a wrong
// cause, when the truth is that the network could not be reached.
//
// Spec: docs/decisions.md 2026-11-26 (r4a row) "The wallet page names what
// failed ... a wallet that cannot be loaded is 'could not load your saved
// wallet', not a sign-in problem"; the restore path already answers an
// unreachable RPC with "Check your connection" (WALLET_UNCHECKED). Attacker
// goal 3 (a wrong cause for a failure), and goal 5 (the person with a wallet is
// told it may not exist yet, then Create is offered after a reload).
// Cause: smart-account-kit 0.10.0 dist/kit/wallet-ops.js connectWithCredentials
// wraps getContractData in a bare `catch {}` and throws "Smart account contract
// not found on-chain for credential ... The wallet may not have been deployed
// yet." for ANY failure, a refused connection included. wallet/page.tsx
// connect() passes that text on unchanged through failureText().
// Run against the real kit and the real @simplewebauthn/browser; the stand-ins
// are the browser's navigator.credentials.get (a well-formed assertion), the
// kit's storage (MemoryStorage instead of IndexedDB, which Node lacks) and an
// RPC address with nothing listening (https://127.0.0.1:1, refused at once, no
// network use). Rendered with React's state and effects stubbed, as r4o does.
// Any fix that tells the person the network could not be reached (or that does
// not claim the wallet is missing) passes.
import { afterEach, describe, expect, it, vi } from "vitest";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
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

const hadLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("smart-account-kit");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
  if (hadLocalStorage) Object.defineProperty(globalThis, "localStorage", hadLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const A = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 300));

const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer;

/** The person presses "I already have a wallet" and picks a passkey; returns what the page then shows. */
async function connectWith(get: () => Promise<unknown>) {
  const local = new Map<string, string>();
  const storage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  };
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    const init = [{ kind: "idle" }, "", A];
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
  vi.doMock("smart-account-kit", async () => {
    const actual = await vi.importActual<typeof import("smart-account-kit")>("smart-account-kit");
    return { ...actual, IndexedDBStorage: actual.MemoryStorage };
  });
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  // Nothing listens on port 1: the kit's RPC calls are refused at once.
  vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "https://127.0.0.1:1");
  const loc = { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", hostname: "caracal.test", search: "" };
  const PublicKeyCredential = function PublicKeyCredential() {};
  vi.stubGlobal("window", { location: loc, localStorage: storage, PublicKeyCredential });
  vi.stubGlobal("location", loc);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  vi.stubGlobal("PublicKeyCredential", PublicKeyCredential);
  vi.stubGlobal("navigator", { credentials: { get } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  await click(mod.default(), "I already have a wallet")!();
  await settle();
  return setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string } | undefined;
}

/** A well-formed WebAuthn assertion for a passkey, as the browser would return it. */
const assertion = async () => ({
  id: "AQIDBAUGBwg",
  rawId: buf(1, 2, 3, 4, 5, 6, 7, 8),
  type: "public-key",
  authenticatorAttachment: "platform",
  response: {
    authenticatorData: buf(1, 2, 3),
    clientDataJSON: buf(123, 125),
    signature: buf(4, 5, 6),
    userHandle: null,
  },
  getClientExtensionResults: () => ({}),
});

describe("adversary r4p: Connect with the network down does not claim the wallet is missing", () => {
  it("control: a cancelled passkey prompt shows the kit's own message through the real kit", async () => {
    const last = await connectWith(async () => {
      throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
    });
    expect(last?.kind).toBe("error");
    expect(last?.message).toMatch(/timed out or was not allowed/);
  });

  it("the RPC refuses the connection: the page must not say the wallet may not be deployed", async () => {
    const last = await connectWith(assertion);
    expect(last?.kind).toBe("error");
    // Harness: the real kit got past the passkey step and failed reading the chain.
    expect(last?.message, last?.message).toMatch(/Smart account contract|connection|network|reach/i);
    // Defect: the kit's bare catch turns a refused connection into "not deployed yet".
    expect(last?.message, last?.message).not.toMatch(/may not have been deployed/i);
    expect(last?.message, last?.message).toMatch(/connection|network|reach|offline/i);
  });
});
