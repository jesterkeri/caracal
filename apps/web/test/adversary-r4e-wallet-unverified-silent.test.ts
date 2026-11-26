// Adversary r4e: on /wallet, when the sign-in cannot be verified (or a Sign out
// from that view fails), the page sets an error state but never shows its text:
// the message block is rendered only when `account` is set, and in this case it
// is null. The person sees a bare "Sign out of this browser" link and no reason.
// Spec: docs/decisions.md 2026-11-26 (r4a row): "'Could not verify your sign-in'
// also suggests signing out and in again, since a refused session is not a
// connection problem"; (r3k row) "Sign out stays offered when the session cannot
// be verified (... an error on /wallet)"; and (r3b/r3d) a failed sign-out must
// be reported ("reports failure if the session survives").
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

type El = { type?: unknown; props?: { children?: unknown; onClick?: () => unknown } };

/** Every string in a rendered tree. */
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
  if (typeof click === "function" && own.includes(text)) return click;
  return clickHandlerFor(kids, text);
}

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], auth: unknown) {
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
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({
    HTTPS_RPC_REQUIRED: "https required",
    getKit: () => Promise.resolve({ disconnect: async () => {}, connectWallet: async () => null }),
  }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const quiet = () => ({ data: { subscription: { unsubscribe() {} } } });
const A = { id: "A", email: "a@x.ng" };

/** A session is stored but Supabase cannot confirm it (offline). */
const offlineAuth = (signOut: () => Promise<{ error: unknown }> = async () => ({ error: null })) => ({
  getUser: async () => {
    throw new TypeError("Failed to fetch");
  },
  getSession: async () => ({ data: { session: { user: A } } }),
  signOut,
  onAuthStateChange: quiet,
});

describe("adversary r4e: /wallet when the sign-in could not be verified", () => {
  it("control: with a verified account, an error state shows its message", async () => {
    const { tree } = await renderWallet([{ kind: "error", message: "WALLET-MESSAGE-SHOWN" }, "", A], offlineAuth());
    expect(texts(tree).join(" | ")).toContain("WALLET-MESSAGE-SHOWN");
  });

  it("the page's own check ends in an error state, and the person is told why", async () => {
    const { effects, setters } = await renderWallet([], offlineAuth());
    effects.forEach((f) => f());
    await settle();
    // What the page decided to say: the check failed, no account is known.
    const state = setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string; message?: string }).at(-1)!;
    expect(state.kind).toBe("error");
    expect(setters.filter((s) => s.i === 2)).toEqual([]);
    expect(state.message).toMatch(/could not verify your sign-in/);

    // What the person sees when that state is rendered (no account).
    vi.resetModules();
    const { tree } = await renderWallet([state, "", null], offlineAuth());
    const shown = texts(tree).join(" | ");
    expect(shown).toMatch(/Sign out of this browser/); // Sign out is offered...
    // Defect: ...but the reason is not on the page.
    expect(shown).toMatch(/could not verify your sign-in/);
  });

  it("a Sign out that fails from that view says so", async () => {
    const auth = offlineAuth(async () => ({ error: new Error("network down") }));
    const { tree, setters } = await renderWallet([{ kind: "error", message: "x" }, "", null], auth);
    await clickHandlerFor(tree, "Sign out")!();
    const state = setters.filter((s) => s.i === 0).map((s) => s.v as { kind: string; message?: string }).at(-1)!;
    expect(state).toEqual({ kind: "error", message: SIGN_OUT_FAILED });
    vi.resetModules();
    const { tree: after } = await renderWallet([state, "", null], auth);
    // Defect: the failure is recorded in state but nowhere on screen.
    expect(texts(after).join(" | ")).toMatch(/Sign-out did not finish/);
  });
});
