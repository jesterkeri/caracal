// Adversary r4k: after an unknown creation, a Connect that finds no wallet
// removes the "Start a new one anyway" escape.
//
// Spec: docs/decisions.md 2026-11-26 (r4j row): "After an unknown creation
// outcome the page offers 'No wallet found? Start a new one anyway' for when
// Connect found nothing ... It is not offered where a wallet is proven (a
// failed Connect, a saved wallet that could not load)". When Connect finds no
// wallet the kit does not return null: smart-account-kit 0.10.0 wallet-ops.js
// connectWithCredentials throws "Smart account contract not found on-chain for
// credential ...", which proves nothing exists at that address. wallet/page.tsx
// connect() then sets { kind: "error", message } without checkFirst, so the
// escape (and the hint) vanish exactly when the person has done what the page
// asked, until a reload the page never mentions. Goal 4 (no way forward shown).
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

const ESCAPE = "Start a new one anyway";
const A = { id: "A", email: "a@x.ng" };
const settle = () => new Promise((r) => setTimeout(r, 20));
// smart-account-kit 0.10.0 dist/kit/wallet-ops.js, connectWithCredentials: thrown when getContractData fails.
const KIT_NOT_FOUND =
  "Smart account contract not found on-chain for credential abc. The wallet may not have been deployed yet.";

function browser() {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    connectWallet: async (): Promise<{ contractId: string } | null> => null,
    createWallet: async (): Promise<unknown> => {
      listeners.forEach((cb) => cb());
      return { contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } };
    },
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v;

/** An unknown creation, then the person clicks Connect and the kit finds no wallet. Returns what they see. */
async function connectFindsNothing() {
  const b = browser();
  const first = await render(b, [{ kind: "idle" }, "Ada", A]);
  await click(first.tree, "Create wallet")!();
  await settle();
  b.local.set("caracal.creationStartedAt", String(Date.now() - 4 * 60_000)); // old enough to start anew
  const unknown = lastState(first.setters);
  vi.resetModules();
  const before = texts((await render(b, [unknown, "", A])).tree).join(" | ");
  vi.resetModules();
  b.kit.connectWallet = async () => {
    throw new Error(KIT_NOT_FOUND);
  };
  const page = await render(b, [unknown, "", A]);
  await click(page.tree, "I already have a wallet")!();
  await settle();
  const state = lastState(page.setters);
  vi.resetModules();
  const after = texts((await render(b, [state, "", A])).tree).join(" | ");
  return { b, before, after, state };
}

describe("adversary r4k: Connect found nothing after an unknown creation", () => {
  it("control: before Connect, the unknown-outcome screen offers the escape", async () => {
    const { before } = await connectFindsNothing();
    expect(before).toContain(ESCAPE);
  });

  it("control: the marker is still set, so a reload does bring the escape back", async () => {
    const { b } = await connectFindsNothing();
    expect(b.local.get("caracal.creationUnconfirmed")).toBe("A");
    vi.resetModules();
    const loaded = await render(b);
    loaded.effects.forEach((f) => f());
    await settle();
    vi.resetModules();
    const shown = texts((await render(b, [lastState(loaded.setters), "", A])).tree).join(" | ");
    expect(shown).toContain(ESCAPE);
  });

  it("after Connect finds nothing, the escape is still offered (or the page says to reload)", async () => {
    const { after } = await connectFindsNothing();
    // harness: the failure is shown. Changed after adversary r4p proved the
    // kit's own text names a wrong cause (it says "not deployed" when the
    // network is down); the page now shows its own wording for that failure.
    expect(after).toMatch(/No wallet was found on Stellar testnet|could not reach the Stellar network/);
    expect(after, "what the person sees after Connect found nothing").toContain(ESCAPE);
  });
});
