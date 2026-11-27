// Adversary r4o: a passkey prompt that fails with a WebAuthn SecurityError (the
// site is opened on an IP address such as 127.0.0.1, or inside a frame that may
// not use passkeys) is reported on /wallet as "This browser is blocking site
// storage", a wrong cause that sends the person to browser settings that cannot
// help, and hides the real one.
//
// Spec: docs/decisions.md 2026-11-26 (r4a row) "The wallet page names what
// failed", and 2026-11-27 (r4n row): the storage message is for "when the
// browser refuses site storage (a SecurityError, or the wallet kit's IndexedDB
// or localStorage failing)". Attacker goal 3 (a wrong cause for a failure).
// Cause: apps/web/src/app/wallet/page.tsx storageBlocked() treats every error
// named "SecurityError" as blocked storage, and connect() runs every failure
// through failureText(). @simplewebauthn/browser 13.3.0 (startAuthentication,
// identifyAuthenticationError) turns a SecurityError from
// navigator.credentials.get() into a WebAuthnError whose name is copied from
// the cause, "SecurityError", with the message "127.0.0.1 is an invalid domain"
// (code ERROR_INVALID_DOMAIN). The kit hands it on unchanged.
// Run against the real kit (getKit) and the real simplewebauthn; only the
// browser's navigator.credentials.get is a stand-in. Rendered with React's
// state and effects stubbed, as adversary-r4k does. Any fix that shows a
// passkey SecurityError's own message instead of the storage text passes.
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

const hadLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
  if (hadLocalStorage) Object.defineProperty(globalThis, "localStorage", hadLocalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const A = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 50));
const STORAGE_TEXT = /blocking site storage/i;

/** The person presses "I already have a wallet"; the passkey prompt fails with `fail`. Returns what the page shows. */
async function connectFailsWith(hostname: string, fail: () => Error) {
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
  const auth = {
    getUser: async () => ({ data: { user: A }, error: null }),
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const loc = { replace: vi.fn(), reload: vi.fn(), origin: `https://${hostname}`, hostname, search: "" };
  vi.stubGlobal("window", { location: loc, localStorage: storage });
  vi.stubGlobal("location", loc);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  // The browser's WebAuthn entry point, the only fake: the real kit and the real
  // @simplewebauthn/browser run on top of it.
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", {
    locks: (globalThis.navigator as { locks?: unknown } | undefined)?.locks, // harness: a real browser has Web Locks (added for Codex R5 #1)
    credentials: {
      get: async () => {
        throw fail();
      },
    },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  await click(mod.default(), "I already have a wallet")!();
  await settle();
  const last = setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string } | undefined;
  return last;
}

describe("adversary r4o: a passkey SecurityError is not blocked site storage", () => {
  it("control: a cancelled passkey prompt shows the kit's own message through the real kit", async () => {
    const last = await connectFailsWith("caracal.test", () => new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
    expect(last?.kind).toBe("error");
    expect(last?.message).toMatch(/timed out or was not allowed/);
  });

  it("site opened on an IP address (invalid WebAuthn domain): the page names the domain, not storage", async () => {
    const last = await connectFailsWith("127.0.0.1", () => new DOMException("The relying party ID is not a registrable domain suffix of, nor equal to the current domain.", "SecurityError"));
    expect(last?.kind).toBe("error");
    // Harness: the real simplewebauthn produced its own explanation of the cause.
    // Defect: the page replaces it with the storage message.
    expect(last?.message, last?.message).not.toMatch(STORAGE_TEXT);
    expect(last?.message, last?.message).toMatch(/invalid domain/);
  });

  it("passkeys not allowed in this frame (valid domain): the page shows that, not storage", async () => {
    const last = await connectFailsWith("caracal.test", () => new DOMException("The 'publickey-credentials-get' feature is not enabled in this document.", "SecurityError"));
    expect(last?.kind).toBe("error");
    expect(last?.message, last?.message).not.toMatch(STORAGE_TEXT);
    expect(last?.message, last?.message).toMatch(/publickey-credentials-get/);
  });
});
