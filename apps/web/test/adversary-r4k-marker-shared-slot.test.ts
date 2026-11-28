// Adversary r4k: the "creation outcome unknown" marker is one slot for the
// whole browser, so another account's Connect or Create erases it.
//
// Spec: docs/decisions.md 2026-11-26 (r4i row): "Just before a creation is
// sent, the page records caracal.creationUnconfirmed = the account id ...
// While it is set for the signed-in account, a reload offers only Connect ...;
// another account on the same browser is not affected." The r4i/r4j rows rely
// on this so a person is never led into a second wallet when one may exist.
// Goal 5: A's creation outcome is unknown (marker = A). A signs out, B signs
// in on the shared browser and connects B's own wallet: wallet/page.tsx
// connected() calls markCreation(null), which removes the key whatever
// account it names. A signs in again and is offered Create with no warning.
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

const KEY = "caracal.creationUnconfirmed";
const CREATE = "Create wallet with a passkey";
type User = { id: string; email: string };
const A = { id: "A", email: "a@x.ng" };
const B = { id: "B", email: "b@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 20));

/** One browser: localStorage and the wallet kit's saved state survive every page load and account change. */
function browser() {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    connectWallet: async (): Promise<{ contractId: string } | null> => null,
    createWallet: async (): Promise<unknown> => {
      listeners.forEach((cb) => cb()); // credentialCreated: the passkey exists
      // smart-account-kit 0.10.0 deploy-ops.js:184-193: a relayer failure after the passkey is returned as { success: false, error }.
      return { contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } };
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v;

/** A creation whose outcome is unknown, as `user`. */
async function unknownCreationBy(b: ReturnType<typeof browser>, user: User) {
  const first = await render(b, user, [{ kind: "idle" }, "Ada", user]);
  await click(first.tree, "Create wallet")!();
  await settle();
  vi.resetModules();
}

/** What `user` is offered after a page load against this browser's storage. */
async function offeredAfterLoadAs(b: ReturnType<typeof browser>, user: User): Promise<string> {
  const loaded = await render(b, user);
  loaded.effects.forEach((f) => f());
  await settle();
  const state = lastState(loaded.setters);
  vi.resetModules();
  return texts((await render(b, user, [state, "", user])).tree).join(" | ");
}

describe("adversary r4k: one account's marker survives another account's wallet", () => {
  it("control: after an unknown creation, a reload as the same account offers Connect only", async () => {
    const b = browser();
    await unknownCreationBy(b, A);
    expect(b.local.get(KEY)).toBe("A");
    const shown = await offeredAfterLoadAs(b, A);
    expect(shown).not.toContain(CREATE);
    expect(shown).toContain("I already have a wallet");
  });

  it("control: B connecting a wallet leaves B recorded as owner", async () => {
    const b = browser();
    await unknownCreationBy(b, A);
    b.kit.connectWallet = async () => ({ contractId: "CB" });
    const asB = await render(b, B, [{ kind: "idle" }, "", B]);
    await click(asB.tree, "I already have a wallet")!();
    await settle();
    expect(b.local.get("caracal.walletOwner")).toBe("B");
    expect((lastState(asB.setters) as { kind: string }).kind).toBe("connected");
  });

  it("another account connecting its own wallet does not erase A's unknown creation", async () => {
    const b = browser();
    await unknownCreationBy(b, A); // A: outcome unknown, marker = A
    // A signs out; B signs in on the same browser and connects B's own wallet.
    b.kit.connectWallet = async () => ({ contractId: "CB" });
    const asB = await render(b, B, [{ kind: "idle" }, "", B]);
    await click(asB.tree, "I already have a wallet")!();
    await settle();
    vi.resetModules();
    // A signs in again.
    const shown = await offeredAfterLoadAs(b, A);
    expect(b.local.get(KEY), "A's marker after B connected").toBe("A");
    expect(shown, "what A is offered").not.toContain(CREATE);
    expect(shown).toMatch(/may already exist/);
  });

  it("another account's own creation does not erase A's unknown creation either", async () => {
    const b = browser();
    await unknownCreationBy(b, A);
    b.kit.createWallet = async () => ({ contractId: "CB", submitResult: { success: true, hash: "ab".repeat(32) } });
    const asB = await render(b, B, [{ kind: "idle" }, "Bob", B]);
    await click(asB.tree, "Create wallet")!();
    await settle();
    vi.resetModules();
    const shown = await offeredAfterLoadAs(b, A);
    expect(shown, "what A is offered").not.toContain(CREATE);
  });
});
