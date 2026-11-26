// Adversary r4g: /wallet offers "Create wallet with a passkey" in error states
// where this person is known to have a wallet.
//
// Spec: docs/decisions.md 2026-11-26 (r4f row): "A saved wallet of this account
// that cannot be loaded does not offer Create either"; (r3e row) the harm is "a
// second passkey and an orphan wallet". Goal 5: a person is led into creating a
// second wallet when one may already exist.
// Cause: apps/web/src/app/wallet/page.tsx hides Create only when
// `state.walletMayExist` is set. The restore's catch sets it from `savedWallet`,
// which is true only after the wallet kit loaded and mayRestoreWallet said yes,
// so a kit that fails to load (or loads too slowly) for an account whose owner
// binding is in localStorage says "could not load your saved wallet" and still
// offers Create. A failed Sign out and a failed Disconnect, both from a
// connected wallet, set no walletMayExist at all.
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

const CREATE = "Create wallet with a passkey";
const CONNECT = "I already have a wallet";
const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

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
const quiet = () => ({ data: { subscription: { unsubscribe() {} } } });
type Wallet = { kind: string; message?: string; walletMayExist?: boolean };

type Opts = {
  boundOwner?: string | null;
  getKit: () => Promise<unknown>;
  signOutResult?: { error: unknown };
};

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], o: Opts) {
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
    onAuthStateChange: quiet,
    // a sign-out that cannot finish: the session survives
    signOut: async () => o.signOutResult ?? { error: null },
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: o.getKit }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: () => o.boundOwner ?? null, setItem() {}, removeItem() {} },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).map((s) => s.v as Wallet).at(-1)!;

/** Runs the page's load effect and returns what the next render shows. */
async function shownAfterLoad(o: Opts) {
  const { effects, setters } = await renderWallet([], o);
  effects.forEach((f) => f());
  await settle();
  const state = lastState(setters);
  vi.resetModules();
  const { tree } = await renderWallet([state, "", A], o);
  return { state, shown: texts(tree).join(" | ") };
}

/** Shows a connected wallet, clicks `button`, and returns what the next render shows. */
async function shownAfterClick(button: string, o: Opts) {
  const { tree, setters } = await renderWallet([{ kind: "connected", contractId: WALLET }, "", A], o);
  await clickHandlerFor(tree, button)!();
  await settle();
  const state = lastState(setters);
  vi.resetModules();
  const { tree: after } = await renderWallet([state, "", A], o);
  return { state, shown: texts(after).join(" | ") };
}

const okKit = { disconnect: async () => {}, connectWallet: async () => null };

describe("adversary r4g: Create is offered while this person's wallet is known to exist", () => {
  it("control: no saved wallet and a kit that loads offers Create", async () => {
    const { state, shown } = await shownAfterLoad({ boundOwner: null, getKit: () => Promise.resolve(okKit) });
    expect(state.kind).toBe("idle");
    expect(shown).toContain(CREATE);
  });

  it("control: the harness reaches Sign out and Disconnect on a connected wallet", async () => {
    const { tree } = await renderWallet([{ kind: "connected", contractId: WALLET }, "", A], { getKit: () => Promise.resolve(okKit) });
    expect(clickHandlerFor(tree, "Sign out")).toBeTypeOf("function");
    expect(clickHandlerFor(tree, "Disconnect")).toBeTypeOf("function");
  });

  it("the wallet kit failing to load for an account with a saved wallet says so, and offers Connect only", async () => {
    const { state, shown } = await shownAfterLoad({
      boundOwner: "A", // localStorage says this browser holds A's wallet
      getKit: () => Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    });
    expect(state.kind).toBe("error");
    expect(state.message).toMatch(/could not load your saved wallet/);
    expect(shown).toContain(CONNECT);
    // Defect: Create is offered right under "could not load your saved wallet".
    expect(shown).not.toContain(CREATE);
  });

  it("a Sign out that fails on a connected wallet does not then offer Create", async () => {
    const { state, shown } = await shownAfterClick("Sign out", {
      boundOwner: "A",
      getKit: () => Promise.resolve(okKit),
      signOutResult: { error: new Error("offline") },
    });
    expect(state.kind).toBe("error");
    expect(state.message).toMatch(/Sign-out did not finish/);
    expect(shown).toContain(CONNECT);
    // Defect: the wallet was on screen a moment ago, and Create is offered.
    expect(shown).not.toContain(CREATE);
  });

  it("a Disconnect that fails on a connected wallet does not then offer Create", async () => {
    const { state, shown } = await shownAfterClick("Disconnect", {
      boundOwner: "A",
      getKit: () => Promise.resolve({ ...okKit, disconnect: async () => { throw new Error("storage blocked"); } }),
    });
    expect(state.kind).toBe("error");
    expect(shown).toContain(CONNECT);
    // Defect: the wallet is still connected, and Create is offered.
    expect(shown).not.toContain(CREATE);
  });
});
