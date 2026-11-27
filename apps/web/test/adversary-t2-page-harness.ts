// Shared by the adversary-t2 page tests: the real /tax page, rendered by calling
// the component with React's state and effects replaced by a small store (as
// adversary-r4a-pages does). The signed-in account "A" has WALLET remembered.
import { vi } from "vitest";
import { KNOWN_WALLETS_KEY } from "../src/lib/auth/wallet-binding";
import { WALLET } from "./adversary-t1-harness";

type El = { type: unknown; props: Record<string, unknown> };

export function walk(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => walk(n, pred, out));
  else if (typeof node === "object" && node !== null) {
    const el = node as El;
    if (el.props) {
      if (pred(el)) out.push(el);
      walk(el.props.children, pred, out);
    }
  }
  return out;
}

export function cleanUp() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.resetModules();
}

export async function mountTaxPage(fetchStub: (url: string, init: { body: string }) => Promise<Response>) {
  const states = new Map<number, unknown>();
  let at = 0;
  let first = true;
  const effects: (() => unknown)[] = [];
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      default: actual,
      useState: (init: unknown) => {
        const i = at++;
        if (!states.has(i)) states.set(i, init);
        return [states.get(i), (v: unknown) => void states.set(i, typeof v === "function" ? (v as (p: unknown) => unknown)(states.get(i)) : v)];
      },
      useEffect: (fn: () => unknown) => {
        if (first) effects.push(fn);
      },
    };
  });
  const auth = {
    getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>([[KNOWN_WALLETS_KEY, JSON.stringify({ A: WALLET })]]);
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  vi.stubGlobal("fetch", fetchStub);
  const mod = await import("../src/app/tax/page");
  const { ResultView } = await import("../src/app/tax/result-view");
  const render = () => {
    at = 0;
    return mod.default();
  };
  render();
  first = false;
  effects.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 30));
  const settle = () => new Promise((r) => setTimeout(r, 30));
  return { render, settle, ResultView };
}

