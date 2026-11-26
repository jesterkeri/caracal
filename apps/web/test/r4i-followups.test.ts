// Follow-ups to adversary r4i: the "creation outcome unknown" marker is kept
// per account and cleared once the outcome is known.
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const KEY = "caracal.creationUnconfirmed";
type User = { id: string; email: string };

/** One browser (localStorage survives a reload); `submit` is what the kit's creation returns after the passkey exists. */
function browser(submit: () => unknown) {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    connectWallet: async () => null,
    createWallet: async () => {
      listeners.forEach((cb) => cb()); // credentialCreated
      return submit();
    },
  };
  return { local, kit };
}

async function render(b: ReturnType<typeof browser>, user: User, states: unknown[] = []) {
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
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { user } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(b.kit) }));
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
const A = { id: "A", email: "a@x.ng" };
const B = { id: "B", email: "b@x.ng" };

/** Clicks Create as `user`, then reloads as `next` and returns what the page offers. */
async function createThenReload(submit: () => unknown, user: User, next: User) {
  const b = browser(submit);
  const first = await render(b, user, [{ kind: "idle" }, "Ada", user]);
  await click(first.tree, "Create wallet")!();
  await settle();
  vi.resetModules();
  const second = await render(b, next);
  second.effects.forEach((f) => f());
  await settle();
  const state = second.setters.filter((s) => s.i === 0).at(-1)!.v;
  vi.resetModules();
  return { shown: texts((await render(b, next, [state, "", next])).tree).join(" | "), b };
}

describe("r4i follow-up: the creation-unconfirmed marker", () => {
  it("unknown outcome: the same account, after a reload, gets Connect only and the hint", async () => {
    const { shown, b } = await createThenReload(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } }), A, A);
    expect(b.local.get(KEY)).toBe("A");
    expect(shown).toMatch(/may already exist/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
  it("another account signing in on this browser is not affected", async () => {
    const { shown } = await createThenReload(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } }), A, B);
    expect(shown).toMatch(/Create wallet with a passkey/);
  });
  it("the relay said nothing was sent: the marker is cleared and Create comes back after a reload", async () => {
    const { shown, b } = await createThenReload(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("The fee relayer refused to create this wallet (INVALID_PARAMS). Nothing was sent. Try again.") } }), A, A);
    expect(b.local.has(KEY)).toBe(false);
    expect(shown).toMatch(/Create wallet with a passkey/);
  });
  it("a created and recorded wallet clears the marker", async () => {
    const b = browser(() => ({ contractId: "CX", submitResult: { success: true, hash: "ab".repeat(32) } }));
    const first = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(first.tree, "Create wallet")!();
    await settle();
    expect(b.local.has(KEY)).toBe(false);
    expect(b.local.get("caracal.walletOwner")).toBe("A");
  });
});

describe("r4i follow-up: two tabs of one browser", () => {
  it("while one tab's creation is under way, Create in the other starts nothing", async () => {
    const b = browser(() => new Promise(() => {})); // tab 1's creation never finishes
    const tab1 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    void click(tab1.tree, "Create wallet")!();
    await settle();
    expect(b.local.get(KEY)).toBe("A");
    vi.resetModules();
    const create = vi.spyOn(b.kit, "createWallet");
    const tab2 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(tab2.tree, "Create wallet")!();
    expect(create).not.toHaveBeenCalled();
    const state = tab2.setters.filter((s) => s.i === 0).at(-1)!.v as { kind: string; message: string };
    expect(state.kind).toBe("error");
    expect(state.message).toMatch(/already under way in another tab/);
  });
});
