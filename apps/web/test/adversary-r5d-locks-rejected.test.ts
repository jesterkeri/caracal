// Adversary r5d: Create is a silent no-op when the browser's Web Locks request is
// refused. navigator.locks.request() rejects with a SecurityError in a sandboxed
// or opaque-origin frame and where the browser denies site storage (Chromium:
// "Access to the Locks API is denied in this context"). The wallet page awaits
// withCreationLock() with no catch, so the click handler rejects, nothing is
// shown, and the page stays exactly as it was: a failure that is not shown.
//
// Spec: docs/decisions.md 2026-11-27 (r4n row): when the browser refuses site
// storage (a SecurityError, ...) the wallet page says so "on load and on Create
// or Connect"; and (Codex R5 #1 row): a browser that cannot hold the creation lock
// "creates nothing and says so" (LOCKS_UNSUPPORTED). A refused lock request is
// the same situation and must say something too. Attacker goal 4 (a failure that
// is not shown, a control offered that cannot work).
// Cause: apps/web/src/app/wallet/page.tsx create(): `await withCreationLock(...)`
// has no try/catch, and lib/auth/creation-lock.ts only handles a missing
// navigator.locks, not one whose request() rejects.
// The rejecting lock is the only fake; the Web Locks DOMException is constructed
// as the Web Locks spec and Chromium name it (SecurityError). Rendered with
// React's state and effects stubbed, as adversary-r5c does. Any fix that catches
// the rejection and shows a message passes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLedger } from "./fake-ledger";

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

const realLocks = (globalThis.navigator as { locks?: unknown } | undefined)?.locks;

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

async function clickCreate(locks: unknown) {
  const local = new Map<string, string>();
  const createWallet = vi.fn(async (): Promise<unknown> => {
    throw new Error("The operation either timed out or was not allowed.");
  });
  const kit = {
    events: { on: () => () => {} },
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => null,
    createWallet,
    rpc: undefined as unknown,
  };
  const setters: { i: number; v: unknown }[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    const init = [{ kind: "idle" }, "Ada", A];
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
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  });
  vi.stubGlobal("navigator", { locks });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  const create = click(mod.default(), "Create wallet with a passkey");
  expect(create, "the page offers Create here").not.toBeNull();
  let thrown: unknown = null;
  await Promise.resolve(create!()).catch((e: unknown) => (thrown = e));
  const last = setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string } | undefined;
  return { last, thrown, createWallet };
}

describe("adversary r5d: a refused Web Locks request must not make Create a silent no-op", () => {
  it("control: with working locks the click reaches the kit and the page shows its failure", async () => {
    const r = await clickCreate(realLocks);
    expect(r.createWallet).toHaveBeenCalledTimes(1);
    expect(r.thrown).toBeNull();
    expect(r.last?.kind).toBe("error");
  });

  it("control: with no Web Locks at all the page says so (the fail-closed path works)", async () => {
    const r = await clickCreate(undefined);
    expect(r.createWallet).not.toHaveBeenCalled();
    expect(r.last?.kind).toBe("error");
    expect(r.last?.message).toMatch(/only one tab/);
  });

  it("locks.request rejects with a SecurityError: the page says something and the click does not reject", async () => {
    const refused = {
      request: async () => {
        throw new DOMException("Access to the Locks API is denied in this context.", "SecurityError");
      },
    };
    const r = await clickCreate(refused);
    expect(r.createWallet).not.toHaveBeenCalled(); // nothing may be created without the lock
    // Defect: the click handler rejects (unhandled) and no state is set at all.
    expect(r.thrown, String(r.thrown)).toBeNull();
    expect(r.last?.kind, "the page showed nothing").toBe("error");
    expect((r.last?.message ?? "").length).toBeGreaterThan(0);
  });
});
