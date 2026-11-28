// Adversary r4i: after a wallet creation whose outcome is unknown, the page
// tells the person to reload and check with Connect. The reloaded page then
// offers "Create wallet with a passkey" again, with nothing said, although the
// wallet kit holds an unresolved (pending) credential from that attempt.
//
// Spec: docs/decisions.md 2026-11-26 (r3e row #27) "'refused, try again' after
// a proxy timeout led to a second passkey and an orphan wallet"; (r4g row #44)
// "Create is offered only where the page knows this account has no wallet yet".
// Goal 5: a person is led into creating a second wallet when one may already
// exist.
// Cause: apps/web/src/app/wallet/page.tsx keeps "this may already exist" only
// in component state (checkFirst), which a reload (the very thing the message
// asks for) throws away; the restore finds no saved session (smart-account-kit
// 0.10.0 dist/kit/wallet-ops.js saves the session only after a confirmed
// submit; no owner is recorded either) and sets { kind: "idle" } with Create. The kit's own
// kit.credentials.getPending() ("unresolved credentials that still require user
// attention", dist/managers/credential-manager.d.ts) is never read; the kit
// saved that credential, as pending, before it submitted anything.
// Rendered by calling the component with React's state and effects stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLedger } from "./fake-ledger";

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
type Cred = { credentialId: string; deploymentStatus: string };

/**
 * One browser: localStorage and the kit's IndexedDB survive a reload. The kit
 * behaves as smart-account-kit 0.10.0 does in createWallet: it saves the
 * credential as pending, emits credentialCreated, submits, and saves a session
 * only if the submit succeeded. Here the relay's answer never arrives.
 */
function browser() {
  const local = new Map<string, string>();
  const credentials: Cred[] = [];
  let session: { contractId: string } | null = null;
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    credentials: { getAll: async () => credentials.slice(), getPending: async () => credentials.filter((c) => c.deploymentStatus !== "deployed") },
    disconnect: async () => void (session = null),
    connectWallet: vi.fn(async () => session),
    createWallet: vi.fn(async () => {
      credentials.push({ credentialId: "cred-1", deploymentStatus: "pending" });
      listeners.forEach((cb) => cb());
      throw new Error("The fee relayer did not answer. Check your activity before trying again.");
    }),
  };
  return { local, kit };
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
    getSession: async () => ({ data: { session: {} } }),
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

describe("adversary r4i: reloading after a creation whose outcome is unknown", () => {
  it("control: the failed creation itself hides Create and says the wallet may exist", async () => {
    const b = browser();
    const { tree, setters } = await renderWallet([{ kind: "idle" }, "Ada", A], b);
    expect(texts(tree).join(" | "), "harness: Create is offered on a fresh page").toContain(CREATE);
    await clickHandlerFor(tree, CREATE)!();
    await settle();
    expect(b.kit.createWallet).toHaveBeenCalledTimes(1);
    const state = lastState(setters);
    expect(state.kind).toBe("error");
    vi.resetModules();
    const { tree: after } = await renderWallet([state, "Ada", A], b);
    const shown = texts(after).join(" | ");
    expect(shown).toContain("may already exist");
    expect(shown).not.toContain(CREATE);
    expect(shown).toContain(CONNECT);
  });

  it("the reloaded page does not offer Create while the kit holds a pending credential from that attempt", async () => {
    const b = browser();
    const first = await renderWallet([{ kind: "idle" }, "Ada", A], b);
    await clickHandlerFor(first.tree, CREATE)!();
    await settle();
    expect(await b.kit.credentials.getPending()).toHaveLength(1);
    vi.resetModules();

    // The person reloads, as the page told them to. Same browser storage.
    const second = await renderWallet([], b);
    second.effects.forEach((f) => f());
    await settle();
    const state = lastState(second.setters);
    expect(state.kind, "harness: the reload finished its check with no wallet restored").toBe("idle");
    vi.resetModules();
    const { tree } = await renderWallet([state, "", A], b);
    const shown = texts(tree).join(" | ");
    expect(shown).toContain(CONNECT);
    // Defect: Create is offered, with no hint that the last attempt may have
    // created a wallet.
    expect(shown).not.toContain(CREATE);
  });
});
