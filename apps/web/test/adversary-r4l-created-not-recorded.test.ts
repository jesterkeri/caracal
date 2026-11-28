// Adversary r4l: a wallet the page just created, whose owner could not be
// recorded ("not-saved"), is forgotten: the creation marker is removed and a
// reload offers a plain "Create wallet with a passkey" with no hint that the
// account already has a wallet.
//
// Spec: docs/decisions.md 2026-11-26 (r4i row): the marker "removes it once the
// outcome is known (created and recorded, nothing made before the passkey
// existed, or the relay said 'Nothing was sent')"; (r4g row): "Create is
// offered only where the page knows this account has no wallet yet" and, for a
// saved wallet with no session, only "I already have a wallet". Goal 5.
// Cause: apps/web/src/app/wallet/page.tsx connected() calls
// markCreation(account.id, false) for every bindIfStillSignedIn outcome except
// "account-changed", including "not-saved" (the account could not be confirmed
// a moment after the wallet was deployed, e.g. a network blip). The wallet is
// then not recorded as the account's: the reload's mayRestoreWallet finds no
// owner, disconnects the kit's session, and, with no marker left, sets
// { kind: "idle" } (Create offered).
// Not the deferred copy question in docs/fix-day.md (r4h, "unbound saved
// session is disconnected"): here the page itself created the wallet and
// removed the very marker that exists to prevent this.
// Rendered by calling the component with React's state and effects stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLedger } from "./fake-ledger";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const CREATE = "Create wallet with a passkey";
const CONNECT = "I already have a wallet";

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
type S = { kind: string; message?: string };
const HASH = "ab".repeat(32);

/**
 * One browser: localStorage and the kit's session survive a reload. The kit
 * behaves as smart-account-kit 0.10.0 createWallet does on success: it emits
 * credentialCreated, then saves a session for the new wallet.
 */
function browser() {
  const local = new Map<string, string>();
  let session: { contractId: string } | null = null;
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => void (session = null),
    connectWallet: vi.fn(async () => session),
    createWallet: vi.fn(async () => {
      listeners.forEach((cb) => cb());
      session = { contractId: "CNEW" };
      return { contractId: "CNEW", submitResult: { success: true, hash: HASH } };
    }),
  };
  return { local, kit };
}

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], b: ReturnType<typeof browser>, getUserWorks: () => boolean) {
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
    getUser: async () => {
      if (!getUserWorks()) throw new TypeError("fetch failed");
      return { data: { user: A }, error: null };
    },
    // supabase-js: with the access token expired and Supabase unreachable, getSession answers { session: null, error }.
    getSession: async () => (getUserWorks() ? { data: { session: { user: A } } } : { data: { session: null }, error: new Error("offline") }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(b.kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => b.local.get(k) ?? null, setItem: (k: string, v: string) => void b.local.set(k, v), removeItem: (k: string) => void b.local.delete(k) },
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).map((s) => s.v as S).at(-1)!;

/** Create succeeds; Supabase is reachable or not at the moment the owner is recorded. Then the page is reloaded. */
async function createThenReload(supabaseUpWhenBinding: boolean) {
  const b = browser();
  let up = supabaseUpWhenBinding;
  const first = await renderWallet([{ kind: "idle" }, "Ada", A], b, () => up);
  expect(texts(first.tree).join(" | "), "harness: Create is offered on a fresh page").toContain(CREATE);
  await clickHandlerFor(first.tree, CREATE)!();
  await settle();
  expect(b.kit.createWallet).toHaveBeenCalledTimes(1);
  expect(lastState(first.setters), "harness: the page shows the new wallet as connected").toMatchObject({ kind: "connected" });
  vi.resetModules();

  // The person reloads later; Supabase answers again. Same browser storage.
  up = true;
  const second = await renderWallet([], b, () => up);
  second.effects.forEach((f) => f());
  await settle();
  const state = lastState(second.setters);
  vi.resetModules();
  const shown = texts((await renderWallet([state, "", A], b, () => up)).tree).join(" | ");
  return { b, state, shown };
}

describe("adversary r4l: a created wallet that could not be recorded", () => {
  it("control: when the owner is recorded, the reload restores the wallet and offers no Create", async () => {
    const { b, state, shown } = await createThenReload(true);
    expect(b.local.get("caracal.walletOwner")).toBe("A");
    expect(state).toMatchObject({ kind: "connected", contractId: "CNEW" });
    expect(shown).not.toContain(CREATE);
  });

  it("after a wallet was created but not recorded, the reload does not offer a plain Create", async () => {
    const { b, state, shown } = await createThenReload(false);
    // harness: the owner really was not recorded, and the creation really succeeded
    expect(b.local.get("caracal.walletOwner")).toBeUndefined();
    expect(b.kit.createWallet).toHaveBeenCalledTimes(1);
    expect(state.kind, "harness: the reload found nothing to restore").toBe("idle");
    expect(shown).toContain(CONNECT);
    // Defect: Create is offered with nothing said, for an account that has a wallet.
    expect(shown.includes(CREATE) && !shown.includes("may already exist"), `reloaded page shows: ${shown}`).toBe(false);
  });
});
