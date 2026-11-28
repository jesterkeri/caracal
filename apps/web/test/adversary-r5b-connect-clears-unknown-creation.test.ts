// Adversary r5b: a Connect that finds the account's OLD wallet clears the "creation
// unconfirmed" note of a second-wallet attempt whose outcome is still unknown, so the
// explicit "Make a second, new wallet instead" choice (Codex R5 #3) is offered again
// at once, with no 3-minute wait. docs/decisions.md (2026-11-26, r4i/r4j): the note is
// removed only once the outcome is known (created and recorded, nothing made before
// the passkey existed, or the relay said "Nothing was sent"), and the 3-minute wait
// exists "so a creation another tab or the network may still finish is not doubled".
// Finding the old wallet says nothing about whether the new attempt will still land.
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
const MARK = "caracal.creationUnconfirmed";
const A = { id: "A", email: "a@x.ng" };
const WALLET_1 = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX"; // A's first wallet, already connected before
const settle = () => new Promise((r) => setTimeout(r, 20));

/** One browser: localStorage is shared by every render below, like reloads of one site. */
function browser() {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    // Connect: the person picks the passkey of the FIRST wallet, which exists.
    connectWallet: async (): Promise<unknown> => ({ contractId: WALLET_1 }),
    // The second wallet's creation: the passkey is made, the answer is lost (504). It may still land.
    createWallet: async () => {
      listeners.forEach((cb) => cb()); // credentialCreated
      await settle();
      return { contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } };
    },
    rpc: undefined as unknown,
  };
  return { local, kit };
}

async function render(b: ReturnType<typeof browser>, states: unknown[]) {
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string; checkFirst?: boolean; remembered?: string };

/** Start the second wallet from the page that shows the first one, and let the unknown outcome land. */
async function startSecondWalletWithUnknownOutcome(b: ReturnType<typeof browser>) {
  b.local.set(OWNER, "A");
  b.local.set(KNOWN, JSON.stringify({ A: WALLET_1 }));
  const first = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_1 }, "Ada", A]);
  await click(first.tree, "Make a second, new wallet instead")!();
  const after = lastState(first.setters);
  expect(after.kind).toBe("error");
  expect(after.checkFirst).toBe(true);
  expect(b.local.get(MARK)).toBe("A"); // the attempt's outcome is unknown, and the page records it
  return after;
}

describe("adversary r5b: an unknown second-wallet creation is not forgotten by connecting the first wallet", () => {
  it("control: straight after the unknown outcome, the second-wallet choice is refused", async () => {
    const b = browser();
    const create = vi.spyOn(b.kit, "createWallet");
    await startSecondWalletWithUnknownOutcome(b);
    vi.resetModules();
    // A reload shows the idle page with the remembered wallet again.
    const again = await render(b, [{ kind: "idle", knownWallet: true, remembered: WALLET_1 }, "Ada", A]);
    await click(again.tree, "Make a second, new wallet instead")!();
    expect(create).toHaveBeenCalledTimes(1); // refused: "could not be confirmed"
    expect(lastState(again.setters).message).toMatch(/could not be confirmed/);
  });

  it("Connect finds the first wallet, Disconnect, then the second-wallet choice must still wait for the unknown attempt", async () => {
    const b = browser();
    const create = vi.spyOn(b.kit, "createWallet");
    const unknown = await startSecondWalletWithUnknownOutcome(b);

    // The page said to check with "I already have a wallet". The person's passkey chooser offers the
    // first wallet's passkey, and the first wallet is connected.
    vi.resetModules();
    const errorPage = await render(b, [unknown, "Ada", A]);
    await click(errorPage.tree, "I already have a wallet")!();
    const connected = lastState(errorPage.setters);
    expect(connected.kind).toBe("connected"); // control: the Connect worked and found the first wallet

    // Disconnect, as the page offers; the account's wallet is remembered, so the choice comes back.
    vi.resetModules();
    const connectedPage = await render(b, [connected, "Ada", A]);
    await click(connectedPage.tree, "Disconnect")!();
    const idle = lastState(connectedPage.setters);
    expect(idle.kind).toBe("idle");
    vi.resetModules();
    const page = await render(b, [idle, "Ada", A]);
    expect(texts(page.tree).join(" | ")).toMatch(/Make a second, new wallet instead/);
    await click(page.tree, "Make a second, new wallet instead")!();

    // The second wallet's creation was sent a moment ago and its outcome is unknown: the relay may still land it
    // for about two more minutes. A third passkey and wallet must not be started on top of it.
    expect(create).toHaveBeenCalledTimes(1);
    expect(b.local.get(MARK)).toBe("A");
  });
});
