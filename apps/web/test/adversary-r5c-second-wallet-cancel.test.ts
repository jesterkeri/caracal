// Adversary r5c: after the person chose "Make a second, new wallet instead" and the
// passkey prompt failed before any passkey existed (cancelled, timed out), the page
// offers the plain "Create wallet with a passkey" (createAllowed). That button is
// not the explicit second-wallet choice: it carries no secondTo, so while this
// account's own owner record is still bound (after Disconnect or an expired
// session) it refuses with "created or connected in another tab. Reload the page to
// open it". That is false (no other tab), and it is a control offered that cannot
// work. Without a bound owner it makes a second wallet with no mention of the first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withLedger } from "./fake-ledger";

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const OWNER = "caracal.walletOwner";
const KNOWN = "caracal.knownWallets";
const A = { id: "A", email: "a@x.ng" };
const WALLET_A = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

function browser(createWallet: () => Promise<unknown>) {
  const local = new Map<string, string>();
  const kit = {
    events: { on: (_e: string, _cb: () => void) => () => {} }, // credentialCreated never fires: the prompt failed first
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => null,
    createWallet,
    rpc: undefined as unknown,
  };
  return { local, kit };
}

async function render(b: ReturnType<typeof browser>, states: unknown[] = []) {
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string; createAllowed?: boolean };

const cancelled = () => Promise.reject(new Error("The operation either timed out or was not allowed."));

describe("adversary r5c: Create offered after a cancelled second-wallet prompt", () => {
  it("control: a cancelled prompt on the explicit second-wallet choice reaches the kit and fails before any passkey exists", async () => {
    const b = browser(cancelled);
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
    const create = vi.spyOn(b.kit, "createWallet");
    const page = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "Ada", A]);
    await click(page.tree, "Make a second, new wallet instead")!();
    expect(create).toHaveBeenCalledTimes(1);
    expect(lastState(page.setters).kind).toBe("error");
  });

  it("the Create button offered afterwards must not refuse with 'another tab' (owner record still bound)", async () => {
    const b = browser(cancelled);
    b.local.set(OWNER, "A"); // this account's own record, left by Disconnect or an expired session
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
    const first = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "Ada", A]);
    await click(first.tree, "Make a second, new wallet instead")!();
    const state = lastState(first.setters);
    expect(state.kind).toBe("error");
    vi.resetModules();

    const page = await render(b, [state, "Ada", A]);
    const create = click(page.tree, "Create wallet with a passkey");
    // Either Create is not offered here (the explicit choice stays), or it works.
    if (create) {
      const spy = vi.spyOn(b.kit, "createWallet");
      await create();
      expect(lastState(page.setters)?.message ?? "").not.toMatch(/another tab/);
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("with no owner record, the plain Create that follows must not appear without the first wallet being named", async () => {
    const b = browser(cancelled);
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A })); // signed out and in again: remembered, not bound
    const first = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "Ada", A]);
    await click(first.tree, "Make a second, new wallet instead")!();
    const state = lastState(first.setters);
    vi.resetModules();

    const page = await render(b, [state, "Ada", A]);
    const shown = texts(page.tree).join(" | ");
    // A new wallet is offered, after a first wallet is known, only as an explicit
    // choice that names it (decisions 2026-11-27, Codex R5 #3): so a Create button
    // here must come with the remembered wallet's address on screen.
    if (/Create wallet with a passkey/.test(shown)) expect(shown).toContain(WALLET_A);
  });
});
