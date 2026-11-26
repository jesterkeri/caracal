// Adversary r4d: the sign-in page's "Checking your sign-in" state has no exit
// after a failed Sign out. Spec: docs/decisions.md 2026-11-26 (r4c row): "While
// the sign-in page is still checking, it shows 'Checking your sign-in' with
// Sign out ... a check that ends after Sign out does not undo it." A check that
// has ended must not leave the page saying it is still checking, and a sign-out
// that failed (the session survives, Sign out failed message shown) must leave
// the person able to see their real state (signed in: Go to your wallet).
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

type El = { props?: { children?: unknown; onClick?: () => unknown } };
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
  if (typeof click === "function" && own.includes(text)) return click;
  return clickHandlerFor(kids, text);
}

async function renderSignIn(auth: unknown) {
  const effects: (() => unknown)[] = [];
  const setters: { i: number; v: unknown }[] = [];
  const states: unknown[] = [null, null, false]; // error, signIn, busy
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
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve({ disconnect: async () => {} }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/signin/page");
  return { tree: mod.default(), effects, setters };
}

const A = { id: "A", email: "a@x.ng" };
const noEvents = () => ({ data: { subscription: { unsubscribe() {} } } });

describe("adversary r4d: sign-in page, check ends after a failed Sign out", () => {
  it("control: without Sign out, a finished check leaves the checking state (signIn is set)", async () => {
    let finish: (v: unknown) => void = () => {};
    const auth = {
      getUser: () => new Promise((r) => (finish = r)),
      getSession: async () => ({ data: { session: {} } }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: noEvents,
    };
    const { effects, setters } = await renderSignIn(auth);
    effects.forEach((f) => f());
    finish({ data: { user: A }, error: null });
    await new Promise((r) => setTimeout(r, 20));
    const signIn = setters.filter((s) => s.i === 1).map((s) => s.v as { kind: string });
    expect(signIn.at(-1)?.kind).toBe("verified");
  });

  it("Sign out fails (offline, session survives), then the check ends: the page must leave 'Checking your sign-in'", async () => {
    let finish: (v: unknown) => void = () => {};
    const auth = {
      getUser: () => new Promise((r) => (finish = r)),
      // The session is still stored: every sign-out step reports failure.
      getSession: async () => ({ data: { session: {} } }),
      signOut: vi.fn(async () => ({ error: new Error("network down") })),
      onAuthStateChange: noEvents,
    };
    const { tree, effects, setters } = await renderSignIn(auth);
    effects.forEach((f) => f());
    await clickHandlerFor(tree, "Sign out")!();
    // The failure is shown...
    expect(setters.some((s) => s.i === 0 && typeof s.v === "string" && /still signed in/.test(s.v as string))).toBe(true);
    // ...and then Supabase answers: the account is verified and still signed in.
    finish({ data: { user: A }, error: null });
    await new Promise((r) => setTimeout(r, 20));
    const signIn = setters.filter((s) => s.i === 1).map((s) => s.v as { kind: string });
    // Defect: no setSignIn call ever happens, so the page keeps saying "Checking your sign-in..." for good.
    expect(signIn.length).toBeGreaterThan(0);
    expect(signIn.at(-1)?.kind).toBe("verified");
  });
});
