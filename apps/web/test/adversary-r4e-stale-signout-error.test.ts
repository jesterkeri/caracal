// Adversary r4e: after a failed Sign out and a successful retry, the sign-in
// page keeps saying "Sign-out did not finish, so you are still signed in"
// next to a "Continue with Google" button.
// Spec: docs/decisions.md 2026-11-26 (r3b row): sign-out "reports failure if the
// session survives" (and only then), and the SIGN_OUT_FAILED text in
// src/lib/auth/wallet-binding.ts ("Shown when signing out failed and the person
// is still signed in"). Once a retry ends the session, that statement is false.
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGN_OUT_FAILED } from "../src/lib/auth/wallet-binding";

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
  // error, signIn, busy: a verified session is on screen
  const states: unknown[] = [null, { kind: "verified", id: "A", email: "a@x.ng" }, false];
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

/** What a state slot holds after every recorded update, applying functional updates like React does. */
function finalValue(setters: { i: number; v: unknown }[], slot: number, initial: unknown) {
  return setters.filter((s) => s.i === slot).reduce((cur, s) => (typeof s.v === "function" ? (s.v as (c: unknown) => unknown)(cur) : s.v), initial);
}

describe("adversary r4e: sign-in page, failed Sign out then a successful retry", () => {
  function fakeAuth() {
    let session: object | null = { user: { id: "A" } };
    let offline = true;
    return {
      goOnline: () => (offline = false),
      auth: {
        getUser: async () => ({ data: { user: session ? { id: "A", email: "a@x.ng" } : null }, error: null }),
        getSession: async () => ({ data: { session } }),
        signOut: vi.fn(async () => {
          if (offline) return { error: new Error("network down") };
          session = null;
          return { error: null };
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
    };
  }

  it("control: a failed Sign out shows the failure text, a successful one ends signed out", async () => {
    const { auth, goOnline } = fakeAuth();
    const { tree, setters } = await renderSignIn(auth);
    const signOut = clickHandlerFor(tree, "Sign out")!;
    await signOut();
    expect(finalValue(setters, 0, null)).toBe(SIGN_OUT_FAILED);
    goOnline();
    await signOut();
    expect((finalValue(setters, 1, null) as { kind: string }).kind).toBe("signed-out");
  });

  it("once the retry has signed the person out, 'still signed in' is no longer shown", async () => {
    const { auth, goOnline } = fakeAuth();
    const { tree, setters } = await renderSignIn(auth);
    const signOut = clickHandlerFor(tree, "Sign out")!;
    await signOut(); // offline: the session survives, failure shown
    goOnline();
    await signOut(); // the retry works: the person is signed out
    expect((finalValue(setters, 1, null) as { kind: string }).kind).toBe("signed-out");
    // Defect: nothing clears the error, so the alert beside "Continue with Google" still reads
    // "Sign-out did not finish, so you are still signed in."
    expect(finalValue(setters, 0, null)).not.toBe(SIGN_OUT_FAILED);
  });
});
