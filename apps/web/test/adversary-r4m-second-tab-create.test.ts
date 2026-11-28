// Adversary r4m: a second tab of the same browser, still showing "Create wallet
// with a passkey" from when it loaded, creates a SECOND wallet for the account
// after the first tab finished creating and recording the first one.
//
// Spec: docs/decisions.md 2026-11-26 (r4g row): "Create is offered only where
// the page knows this account has no wallet yet"; (r4i row): the creation marker
// exists so that "Create in another tab starts nothing". Goal 5: a person is led
// into creating a second wallet when one may already exist, without being told.
// Cause: apps/web/src/app/wallet/page.tsx create() decides only from
// creationUnconfirmedFor(account.id). Tab A's successful, recorded creation
// removes that marker (connected() -> markCreation(id, false)), so tab B's stale
// Create passes the check and starts a second passkey and wallet. Nothing in
// tab B reacts to tab A's wallet (no storage listener, no re-check of
// caracal.walletOwner or of the saved wallet before creating).
// Not the deferred "sign out and back in" copy question in docs/fix-day.md: no
// sign-out is involved, and the wallet was created and recorded seconds earlier.
// Any fix that stops tab B from starting a second creation (refusing in
// create(), re-checking, or reacting to the storage event) passes this test.
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
 * One browser, shared by its tabs: localStorage, the kit's IndexedDB session and
 * the storage events a real browser sends to the OTHER tabs when one tab writes.
 * createWallet behaves as smart-account-kit 0.10.0 does on success: it emits
 * credentialCreated, then saves a session for the new wallet. `hold` lets a test
 * keep a creation in flight.
 */
function browser() {
  const local = new Map<string, string>();
  let session: { contractId: string } | null = null;
  const credentialListeners = new Set<() => void>();
  const storageListeners: ((e: { key: string | null }) => void)[] = [];
  let writingTab: string | null = null;
  const reload = vi.fn();
  let release: (() => void) | null = null;
  let hold = false;
  let n = 0;
  const kit = {
    events: { on: (_e: string, cb: () => void) => (credentialListeners.add(cb), () => credentialListeners.delete(cb)) },
    disconnect: async () => void (session = null),
    connectWallet: vi.fn(async () => session),
    createWallet: vi.fn(async () => {
      credentialListeners.forEach((cb) => cb());
      if (hold) await new Promise<void>((r) => (release = r));
      const contractId = `CWALLET${++n}`;
      session = { contractId };
      return { contractId, submitResult: { success: true, hash: HASH } };
    }),
  };
  const tell = (key: string | null) => {
    if (writingTab === "B") return; // a real browser does not tell the writing tab
    storageListeners.forEach((cb) => cb({ key }));
  };
  return {
    local,
    kit,
    reload,
    setHold: (h: boolean) => (hold = h),
    release: () => release?.(),
    asTab: (tab: string) => (writingTab = tab),
    storage: {
      getItem: (k: string) => local.get(k) ?? null,
      setItem: (k: string, v: string) => (local.set(k, v), tell(k)),
      removeItem: (k: string) => (local.delete(k), tell(k)),
    },
    addEventListener: (t: string, cb: (e: { key: string | null }) => void) => void (t === "storage" && storageListeners.push(cb)),
    removeEventListener: () => {},
  };
}

// WalletPage state order: state, name, account
async function renderWallet(states: unknown[], b: ReturnType<typeof browser>) {
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
    getSession: async () => ({ data: { session: { user: A } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(b.kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: b.reload, origin: "https://caracal.test", search: "" },
    localStorage: b.storage,
    addEventListener: b.addEventListener,
    removeEventListener: b.removeEventListener,
  });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).map((s) => s.v as S).at(-1);

describe("adversary r4m: Create in a second tab after the first tab made the wallet", () => {
  it("control: while the first tab's creation is still under way, the second tab's Create starts nothing", async () => {
    const b = browser();
    b.setHold(true);
    const tabA = await renderWallet([{ kind: "idle" }, "Ada", A], b);
    vi.resetModules();
    const tabB = await renderWallet([{ kind: "idle" }, "Bea", A], b);
    expect(texts(tabB.tree).join(" | "), "harness: both tabs offer Create").toContain(CREATE);
    b.asTab("A");
    const aDone = clickHandlerFor(tabA.tree, CREATE)!();
    await settle();
    expect(b.kit.createWallet, "harness: tab A is creating").toHaveBeenCalledTimes(1);
    b.asTab("B");
    await clickHandlerFor(tabB.tree, CREATE)!();
    await settle();
    expect(b.kit.createWallet, "the marker keeps tab B out while tab A is under way").toHaveBeenCalledTimes(1);
    b.release();
    await aDone;
  });

  it("after the first tab created and recorded the wallet, the second tab does not start another creation", async () => {
    const b = browser();
    const tabA = await renderWallet([{ kind: "idle" }, "Ada", A], b);
    vi.resetModules();
    const tabB = await renderWallet([{ kind: "idle" }, "Bea", A], b);
    expect(texts(tabB.tree).join(" | "), "harness: tab B offers Create when it loads").toContain(CREATE);
    tabB.effects.forEach((f) => f()); // tab B's own page effects run (they may listen for storage events)
    await settle();

    // Tab A creates the wallet, and it is recorded as account A's.
    b.asTab("A");
    await clickHandlerFor(tabA.tree, CREATE)!();
    await settle();
    expect(b.kit.createWallet).toHaveBeenCalledTimes(1);
    expect(b.local.get("caracal.walletOwner"), "harness: tab A recorded the wallet as A's").toBe("A");
    expect(b.local.get("caracal.creationUnconfirmed"), "harness: the creation marker is gone").toBeUndefined();

    // Tab B: whatever the page now shows is what the person can click.
    b.asTab("B");
    const shown = lastState(tabB.setters);
    let clicked = "nothing to click (the page was restarted or no longer offers Create)";
    if (b.reload.mock.calls.length === 0) {
      vi.resetModules();
      const again = await renderWallet([shown ?? { kind: "idle" }, "Bea", A], b);
      const create = clickHandlerFor(again.tree, CREATE);
      if (create) {
        clicked = "Create was still offered and clicked";
        await create();
        await settle();
      }
    }
    // Defect: a second passkey and wallet for the same account, with nothing said.
    expect(b.kit.createWallet, `tab B: ${clicked}`).toHaveBeenCalledTimes(1);
  });
});
