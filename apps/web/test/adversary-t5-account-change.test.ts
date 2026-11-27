// Adversary t5: the tax page keeps showing one account's wallet and estimate
// after that account signed out (or another account signed in) in another tab.
//
// Promise: docs/decisions.md 2026-11-26 (Codex R4 #2 and #3): "The wallet page
// follows the account through supabase-js auth events, which reach every tab:
// on a sign-out or a different account it clears what it shows and reloads."
// docs/fix-day.md "User pipeline testing" item 7 lists "a second tab signing in
// with another account" as a failure path of the whole journey, and item 5 of
// that journey is this page. followAccount (src/lib/auth/account.ts) exists for
// exactly this and is used by /wallet and /signin, but /tax reads the account
// once on mount and never listens, so on a shared browser the next person
// still sees the previous account's wallet address and tax estimate, and can
// press Estimate for it.
//
// The real page code runs (React state replaced by a small store, as in
// adversary-t2-page-harness). The auth client is a fake that records the
// listeners the page registers and lets the test deliver the event
// supabase-js sends to every tab on a sign-out.
import { afterEach, describe, expect, it, vi } from "vitest";
import { KNOWN_WALLETS_KEY } from "../src/lib/auth/wallet-binding";
import { WALLET } from "./adversary-t1-harness";
import { cleanUp, walk } from "./adversary-t2-page-harness";

afterEach(cleanUp);

type Listener = (event: string, session: { user: { id: string } } | null) => void;

async function mount() {
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
  const listeners: Listener[] = [];
  const auth = {
    getUser: async () => ({ data: { user: { id: "A", email: "a@x.ng" } }, error: null }),
    getSession: async () => ({ data: { session: {} } }),
    onAuthStateChange: (cb: Listener) => {
      listeners.push(cb);
      return { data: { subscription: { unsubscribe() {} } } };
    },
  };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  const store = new Map<string, string>([[KNOWN_WALLETS_KEY, JSON.stringify({ A: WALLET })]]);
  const location = { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" };
  vi.stubGlobal("window", {
    location,
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  });
  const mod = await import("../src/app/tax/page");
  const render = () => {
    at = 0;
    return mod.default();
  };
  render();
  first = false;
  effects.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 30));
  return { render, listeners, location };
}

describe("adversary t5: the tax page after the account signed out in another tab", () => {
  it("control: a signed-in account with a remembered wallet sees that wallet and the Estimate button", async () => {
    const { render, location } = await mount();
    const tree = render();
    expect(JSON.stringify(tree)).toContain(WALLET);
    expect(walk(tree, (e) => e.type === "button")).toHaveLength(1);
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("stops showing the wallet (reload or back to /signin) when the account signs out elsewhere", async () => {
    const { render, listeners, location } = await mount();
    // supabase-js tells every tab about a sign-out.
    for (const cb of listeners) cb("SIGNED_OUT", null);
    await new Promise((r) => setTimeout(r, 30));
    const left = location.reload.mock.calls.length + location.replace.mock.calls.length > 0;
    const stillShown = JSON.stringify(render()).includes(WALLET);
    expect(left || !stillShown).toBe(true);
  });
});
