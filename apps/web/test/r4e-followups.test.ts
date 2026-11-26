// Follow-up to adversary r4e's suspicion and r4f's findings: after a wallet
// creation whose outcome is unknown, the page offers Connect, not Create.
import { afterEach, describe, expect, it, vi } from "vitest";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("react");
  vi.doUnmock("@/lib/supabase/client");
  vi.doUnmock("@/lib/stellar/kit");
  vi.resetModules();
});

async function renderWallet(states: unknown[], createWallet?: () => Promise<unknown>) {
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
      useEffect: () => {},
    };
  });
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: {} }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve({ disconnect: async () => {}, createWallet }) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", { location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" } });
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), setters };
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
const A = { id: "A", email: "a@x.ng" };

/** Clicks Create with a kit whose submission fails as given, then renders the page with the state it set. */
async function afterCreateFails(submitResult: unknown): Promise<string> {
  const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], async () => ({ contractId: "CNEW", submitResult }));
  await click(tree, "Create wallet")!();
  const state = setters.filter((s) => s.i === 0).at(-1)!.v;
  vi.resetModules();
  return texts((await renderWallet([state, "", A])).tree).join(" | ");
}

describe("r4e/r4f follow-up: Create after a failed creation", () => {
  it("control: a refusal the relay says sent nothing keeps Create", async () => {
    const shown = await afterCreateFails({ success: false, error: new Error("The fee relayer refused to create this wallet (INVALID_PARAMS). Nothing was sent. Try again.") });
    expect(shown).toMatch(/Create wallet with a passkey/);
  });
  it("a sent transaction (hash) that was not confirmed offers Connect, not Create, and says why", async () => {
    const shown = await afterCreateFails({ success: false, hash: "ab".repeat(32), error: new Error("Transaction confirmation timed out") });
    expect(shown).toMatch(/Transaction confirmation timed out/);
    expect(shown).toMatch(/may already exist/);
    expect(shown).toMatch(/I already have a wallet/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
  it("an unrecognised failure with no hash is treated the same way", async () => {
    const shown = await afterCreateFails({ success: false, error: new Error("Relayer submission failed") });
    expect(shown).toMatch(/may already exist/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
});

describe("r4f follow-up: an empty INITIAL_SESSION is checked before it counts as a sign-out", () => {
  const settle = () => new Promise((r) => setTimeout(r, 20));
  function authWith(read: () => Promise<{ data: { user: { id: string } | null }; error: unknown }>, session: unknown = { user: { id: "A" } }) {
    let cb: ((e: string, s: { user: { id: string } } | null) => void) | undefined;
    const auth = {
      getUser: read,
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: (f: typeof cb) => {
        cb = f;
        return { data: { subscription: { unsubscribe() {} } } };
      },
    };
    return { auth, emit: (e: string, s: { user: { id: string } } | null) => cb!(e, s) };
  }
  it("Supabase unreachable (the session is still stored): no change reported", async () => {
    const { followAccount } = await import("../src/lib/auth/account");
    const { auth, emit } = authWith(async () => { throw new TypeError("Failed to fetch"); });
    const changed = vi.fn();
    followAccount(auth as never, "A", changed);
    emit("INITIAL_SESSION", null);
    await settle();
    expect(changed).not.toHaveBeenCalled();
  });
  it("still A when read again: no change reported", async () => {
    const { followAccount } = await import("../src/lib/auth/account");
    const { auth, emit } = authWith(async () => ({ data: { user: { id: "A" } }, error: null }));
    const changed = vi.fn();
    followAccount(auth as never, "A", changed);
    emit("INITIAL_SESSION", null);
    await settle();
    expect(changed).not.toHaveBeenCalled();
  });
  it("control: really signed out when read again: the change is reported", async () => {
    const { followAccount } = await import("../src/lib/auth/account");
    const { auth, emit } = authWith(async () => ({ data: { user: null }, error: null }), null);
    const changed = vi.fn();
    followAccount(auth as never, "A", changed);
    emit("INITIAL_SESSION", null);
    await settle();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe("r4g follow-up: which create failures still offer Create", () => {
  it("a closed passkey prompt (NotAllowedError, nothing sent) keeps Create", async () => {
    const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], async () => {
      throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
    });
    await click(tree, "Create wallet")!();
    const state = setters.filter((s) => s.i === 0).at(-1)!.v;
    vi.resetModules();
    expect(texts((await renderWallet([state, "", A])).tree).join(" | ")).toMatch(/Create wallet with a passkey/);
  });
  it("any other throw (it may come after the deploy) offers Connect only", async () => {
    const { tree, setters } = await renderWallet([{ kind: "idle" }, "", A], async () => {
      throw new Error("QuotaExceededError: could not save the session");
    });
    await click(tree, "Create wallet")!();
    const state = setters.filter((s) => s.i === 0).at(-1)!.v;
    vi.resetModules();
    const shown = texts((await renderWallet([state, "", A])).tree).join(" | ");
    expect(shown).toMatch(/may already exist/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
  it("after Disconnect, Create is not offered for the wallet just disconnected", async () => {
    const shown = texts((await renderWallet([{ kind: "idle", knownWallet: true }, "", A])).tree).join(" | ");
    expect(shown).toMatch(/I already have a wallet/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
});

describe("r4g follow-up: the Google button when starting the sign-in throws", () => {
  it("shows the error and frees the button", async () => {
    const setters: { i: number; v: unknown }[] = [];
    vi.doMock("react", async () => {
      const actual = await vi.importActual<typeof import("react")>("react");
      let i = 0;
      return { ...actual, default: actual, useState: (init: unknown) => { const at = i++; return [at === 1 ? { kind: "signed-out" } : init, (v: unknown) => setters.push({ i: at, v })]; }, useEffect: () => {} };
    });
    vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth: { signInWithOAuth: async () => { throw new DOMException("The operation is insecure.", "SecurityError"); } } }) }));
    vi.doMock("@/lib/stellar/kit", () => ({ getKit: () => Promise.resolve({}) }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    vi.stubGlobal("window", { location: { origin: "https://caracal.test", search: "" } });
    const mod = await import("../src/app/signin/page");
    await click(mod.default(), "Continue with Google")!();
    // state order in SignIn: error, signIn, busy
    expect(setters.filter((s) => s.i === 2).map((s) => s.v).at(-1)).toBe(false);
    expect(setters.filter((s) => s.i === 0).map((s) => s.v).at(-1)).toMatch(/./);
  });
});
