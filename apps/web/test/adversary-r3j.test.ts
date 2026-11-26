// Adversary r3j.
//
// Sign-out on the wallet page and the sign-in page when the browser refuses
// access to window.localStorage itself (a SecurityError thrown by the getter,
// as browsers do when site data is blocked), not only removeItem.
//
// Promises broken:
// - docs/decisions.md 2026-11-26 (r3c): "sign-out ends the session even if
//   storage refuses".
// - src/lib/auth/wallet-binding.ts signOutEverywhere doc: "The session is
//   always ended, even if the wallet cannot be disconnected (the kit failed to
//   load, or its storage is blocked); the next account still never gets this
//   wallet, because the owner binding is gone."
//
// signOutEverywhere guards removeItem, but both pages evaluate
// `window.localStorage` as an argument BEFORE calling it, so a throwing getter
// aborts sign-out before endSupabaseSession runs: the session survives and
// every retry fails the same way.
import { afterEach, describe, expect, it, vi } from "vitest";

type El = { type: unknown; props: { children?: unknown; onClick?: () => unknown } };

/** The onClick of the first host element whose own text children include `text`. */
function clickHandlerFor(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickHandlerFor(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const el = node as El;
  const kids = el.props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  if (typeof el.props?.onClick === "function" && own.includes(text)) return el.props.onClick;
  return clickHandlerFor(kids, text);
}

function blockedWindow() {
  const win = { location: { replace: vi.fn(), origin: "https://caracal.test", search: "" } } as Record<string, unknown>;
  Object.defineProperty(win, "localStorage", {
    configurable: true,
    get() {
      throw new DOMException("Access is denied for this document.", "SecurityError");
    },
  });
  return win;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

async function renderPage(path: "wallet" | "signin", states: unknown[]) {
  const signOut = vi.fn(async () => ({ error: null }));
  const getSession = vi.fn(async () => ({ data: { session: null } }));
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    let i = 0;
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const v = i < states.length ? states[i] : init;
        i += 1;
        return [v, () => {}];
      },
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: { signOut, getSession } }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: () => Promise.resolve({ disconnect: async () => {} }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const win = blockedWindow();
  vi.stubGlobal("window", win);
  const mod = await import(path === "wallet" ? "../src/app/wallet/page" : "../src/app/signin/page");
  const tree = mod.default();
  return { tree, signOut, win };
}

describe("adv r3j control: the harness reaches Supabase when storage works", () => {
  it("wallet page with a working localStorage ends the session", async () => {
    const { tree, signOut, win } = await renderPage("wallet", [{ kind: "idle" }, "", { id: "user-A", email: "a@example.com" }]);
    Object.defineProperty(win, "localStorage", { value: { getItem: () => null, setItem() {}, removeItem() {} }, configurable: true });
    const click = clickHandlerFor(tree, "Sign out");
    expect(click).not.toBeNull();
    await click!();
    expect(signOut).toHaveBeenCalled();
  });
});

describe("adv r3j: sign-out when window.localStorage itself throws", () => {
  it("wallet page: the Supabase session is still ended", async () => {
    const { tree, signOut } = await renderPage("wallet", [{ kind: "idle" }, "", { id: "user-A", email: "a@example.com" }]);
    const click = clickHandlerFor(tree, "Sign out");
    expect(click, "the Sign out button must be rendered for a known account").not.toBeNull();
    await click!();
    expect(signOut).toHaveBeenCalled();
  });

  it("sign-in page: the Supabase session is still ended", async () => {
    // state order in SignIn: error, email, busy
    const { tree, signOut } = await renderPage("signin", [null, "a@example.com", false]);
    const click = clickHandlerFor(tree, "Sign out");
    expect(click, "the Sign out button must be rendered for a signed-in email").not.toBeNull();
    await click!();
    expect(signOut).toHaveBeenCalled();
  });
});

describe("r3j follow-up: unreadable storage when restoring", () => {
  it("an owner binding that cannot be read counts as not bound: disconnect, do not restore", async () => {
    const { mayRestoreWallet } = await import("../src/lib/auth/wallet-binding");
    const blocked = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => {}, removeItem: () => { throw new Error("SecurityError"); } };
    const kit = { disconnect: vi.fn(async () => {}) };
    await expect(mayRestoreWallet(blocked, kit, "user-B")).resolves.toBe(false);
    expect(kit.disconnect).toHaveBeenCalledTimes(1);
  });
});
