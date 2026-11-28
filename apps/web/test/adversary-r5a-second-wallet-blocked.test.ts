// Adversary r5a: the explicit "Make a second, new wallet instead" choice (Codex R5 #3)
// is offered after a Disconnect, or after a restore that finds no saved session, while
// this account's owner record is still bound on this browser. Create then refuses with
// "created or connected in another tab. Reload the page to open it", which is false (no
// other tab is involved) and sends the person round a loop: a reload restores nothing
// (the session is gone) and shows the same button.
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
const settle = () => new Promise((r) => setTimeout(r, 20));

function browser() {
  const local = new Map<string, string>();
  const kit = {
    events: { on: (_e: string, _cb: () => void) => () => {} },
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => null, // no saved session (expired, or disconnected)
    createWallet: async () => ({ contractId: "CX", submitResult: { success: false, error: new Error("Payload too large. Nothing was sent.") } }),
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string };

describe("adversary r5a: the explicit second-wallet choice", () => {
  it("control: with no owner record, the choice starts a creation", async () => {
    const b = browser();
    const create = vi.spyOn(b.kit, "createWallet");
    const page = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "Ada", A]);
    await click(page.tree, "Make a second, new wallet instead")!();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a reload with this account's owner record bound and no saved session offers the choice, and the choice must not be refused as 'another tab'", async () => {
    const b = browser();
    b.local.set(OWNER, "A"); // bound when the wallet was connected; Disconnect or an expired session leaves it
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
    const create = vi.spyOn(b.kit, "createWallet");

    const loaded = await render(b);
    loaded.effects.forEach((f) => f());
    await settle();
    const state = lastState(loaded.setters);
    expect(state.kind).toBe("idle"); // the page offers the explicit choice (see the R5 #3 test)
    vi.resetModules();

    const page = await render(b, [state, "Ada", A]);
    expect(texts(page.tree).join(" | ")).toMatch(/Make a second, new wallet instead/);
    await click(page.tree, "Make a second, new wallet instead")!();
    const after = lastState(page.setters);
    // Either it creates, or (if refusing is intended) it says the truth. It says "another tab".
    expect(after?.message ?? "").not.toMatch(/another tab/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
