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
    // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
    rpc: { getLatestLedger: async () => ({ sequence: 1000 }) } as unknown,
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

describe("r4j follow-up: the relay's refusals before sending", () => {
  it.each([
    ["Too many requests. Wait a minute.", "Too many requests. Wait a minute. Nothing was sent."],
    ["Payload too large", "Payload too large. Nothing was sent."],
    ["The network could not be reached to check this call. Try again.", "The network could not be reached to check this call. Nothing was sent. Try again."],
    ["Already. Nothing was sent. Try again.", "Already. Nothing was sent. Try again."],
  ])("%j becomes %j", async (from, to) => {
    const { refusalText } = await import("../src/lib/relay/refusal");
    expect(refusalText(from)).toBe(to);
  });
});

describe("r4j follow-up: starting a new wallet after an unknown outcome", () => {
  async function unknownThenEscape(startedAgoMs: number) {
    const b = browser(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } }));
    const first = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(first.tree, "Create wallet")!();
    await settle();
    b.local.set("caracal.creationStartedAt", String(Date.now() - startedAgoMs));
    b.local.set("caracal.creationCloseLedger", "999"); // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
    const state = first.setters.filter((s) => s.i === 0).at(-1)!.v;
    vi.resetModules();
    const create = vi.spyOn(b.kit, "createWallet");
    const page = await render(b, A, [state, "Ada", A]);
    const escape = click(page.tree, "Start a new one anyway");
    expect(escape, "the escape is offered on the unknown-outcome screen").not.toBeNull();
    await escape!();
    return { create, page, b };
  }
  it("less than 3 minutes after the attempt: it waits, and creates nothing", async () => {
    const { create, page, b } = await unknownThenEscape(60_000);
    expect(create).not.toHaveBeenCalled();
    expect(b.local.get(KEY)).toBe("A");
    const state = page.setters.filter((s) => s.i === 0).at(-1)!.v as { message: string };
    expect(state.message).toMatch(/less than 3 minutes ago/);
  });
  it("3 minutes or more after: the person's choice clears the marker and starts a creation", async () => {
    const { create } = await unknownThenEscape(4 * 60_000);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("not offered where a wallet is proven (a failed Connect)", async () => {
    const shown = texts((await render(browser(() => null), A, [{ kind: "error", message: "The indexer did not return one complete schema-2 birth claim." }, "", A])).tree).join(" | ");
    expect(shown).not.toMatch(/Start a new one anyway/);
  });
});

describe("r4k follow-up: the marker per account, and its start time", () => {
  it("A and B both unconfirmed: clearing B keeps A", async () => {
    const b = browser(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } }));
    const pa = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(pa.tree, "Create wallet")!();
    await settle();
    vi.resetModules();
    const pb = await render(b, B, [{ kind: "idle" }, "Bola", B]);
    await click(pb.tree, "Create wallet")!();
    await settle();
    expect(b.local.get(KEY)!.split(",").sort()).toEqual(["A", "B"]);
    vi.resetModules();
    // B's next creation is refused before sending: B is cleared, A kept.
    b.kit.createWallet = async () => ({ contractId: "CX", submitResult: { success: false, error: new Error("Too many requests. Wait a minute. Nothing was sent.") } });
    b.local.delete(KEY);
    b.local.set(KEY, "A,B");
    const pb2 = await render(b, B, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Bola", B]);
    b.local.set("caracal.creationStartedAt", String(Date.now() - 4 * 60_000));
    b.local.set("caracal.creationCloseLedger", "999"); // Harness (Codex R6 #1, 2026-11-27): the escape now also waits for a close ledger; this one has passed.
    await click(pb2.tree, "Start a new one anyway")!();
    await settle();
    expect(b.local.get(KEY)).toBe("A");
  });
  it("a marker with no start time recorded waits the full time", async () => {
    const b = browser(() => null);
    b.local.set(KEY, "A");
    const create = vi.spyOn(b.kit, "createWallet");
    const page = await render(b, A, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", A]);
    await click(page.tree, "Start a new one anyway")!();
    expect(create).not.toHaveBeenCalled();
    expect(Number(b.local.get("caracal.creationStartedAt"))).toBeGreaterThan(0);
  });
  it("after an unknown creation, a Connect error that proves a wallet keeps the way out hidden", async () => {
    const b = browser(() => null);
    b.local.set(KEY, "A");
    b.kit.connectWallet = async () => {
      throw Object.assign(new Error("The indexer did not return one complete schema-2 birth claim."), { name: "WalletProvenanceError" });
    };
    const page = await render(b, A, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    const state = page.setters.filter((s) => s.i === 0).at(-1)!.v;
    vi.resetModules();
    const shown = texts((await render(b, A, [state, "", A])).tree).join(" | ");
    expect(shown).not.toMatch(/Start a new one anyway/);
    expect(shown).not.toMatch(/Create wallet with a passkey/);
  });
});

describe("r4m follow-up: the marker's clock", () => {
  const blocked: import("../src/lib/auth/wallet-binding").KeyValue = {
    getItem: () => {
      throw new DOMException("Access is denied", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("Access is denied", "SecurityError");
    },
    removeItem: () => {
      throw new DOMException("Access is denied", "SecurityError");
    },
  };
  it("storage blocked: the age counts from this page's own start, then the wait ends", async () => {
    const { creationMarker, CREATION_SETTLE_MS } = await import("../src/lib/auth/creation-marker");
    let t = 1_000_000;
    const m = creationMarker(blocked, () => t);
    m.markCreation("A", true);
    t += 60_000;
    expect(m.creationAge()).toBe(60_000);
    t += CREATION_SETTLE_MS;
    expect(m.creationAge()).toBeGreaterThanOrEqual(CREATION_SETTLE_MS);
  });
  it("storage blocked and no start known here: the full wait from the first look, then it ends", async () => {
    const { creationMarker, CREATION_SETTLE_MS } = await import("../src/lib/auth/creation-marker");
    let t = 5_000_000;
    const m = creationMarker(blocked, () => t);
    expect(m.creationAge()).toBe(0);
    t += CREATION_SETTLE_MS;
    expect(m.creationAge()).toBe(CREATION_SETTLE_MS);
  });
  it("a second mark (the passkey now exists) restarts the wait", async () => {
    const { creationMarker } = await import("../src/lib/auth/creation-marker");
    const local = new Map<string, string>();
    const store = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) };
    let t = 1_000_000;
    const m = creationMarker(store, () => t);
    m.markCreation("A", true);
    t += 50_000; // the passkey prompt
    m.markCreation("A", true);
    expect(m.creationAge()).toBe(0);
    expect(local.get("caracal.creationUnconfirmed")).toBe("A");
  });
});

describe("r4n follow-up: blocked storage named on Create and Connect too", () => {
  it("Connect failing on IndexedDB says to allow site data", async () => {
    const b = browser(() => null);
    b.kit.connectWallet = async () => {
      throw new Error("IndexedDB is not available in this environment");
    };
    const page = await render(b, A, [{ kind: "idle" }, "", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    const state = page.setters.filter((s) => s.i === 0).at(-1)!.v as { message: string };
    expect(state.message).toMatch(/blocking site storage/);
    expect(state.message).not.toMatch(/check your connection/i);
  });
});

describe("r4o follow-up: sign-in codes from the URL in logs", () => {
  it.each([
    ["bad_oauth_state", "bad_oauth_state"],
    ["x\nFAKE LOG LINE", "x?FAKE?LOG?LINE"],
    [null, "(none)"],
  ])("%j is logged as %j", async (v, out) => {
    const { logSafe } = await import("../src/lib/auth/log-safe");
    expect(logSafe(v)).toBe(out);
  });
  it("is cut to 80 characters", async () => {
    const { logSafe } = await import("../src/lib/auth/log-safe");
    expect(logSafe("a".repeat(500))).toHaveLength(80);
  });
});

describe("r4p follow-up: 'not found on-chain' is checked against the network", () => {
  async function connectFails(rpc: unknown) {
    const b = browser(() => null);
    Object.assign(b.kit, { rpc });
    b.kit.connectWallet = async () => {
      throw new Error("Smart account contract not found on-chain for credential AQID. The wallet may not have been deployed yet.");
    };
    const page = await render(b, A, [{ kind: "idle" }, "", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    return (page.setters.filter((s) => s.i === 0).at(-1)!.v as { message: string }).message;
  }
  it("the network answers: no wallet for this passkey", async () => {
    // Since Codex R5 #4 the page asks for the passkey's wallet contract itself
    // (getLedgerEntries); a ledger that answers is no longer enough.
    const m = await connectFails({ getLatestLedger: async () => ({ sequence: 1 }), getLedgerEntries: async () => ({ entries: [], latestLedger: 1 }) });
    expect(m).toMatch(/No wallet was found on Stellar testnet for this passkey/);
  });
  it("the network does not answer: says so, not that the wallet is missing", async () => {
    const m = await connectFails({ getLatestLedger: async () => { throw new TypeError("fetch failed"); } });
    expect(m).toMatch(/could not reach the Stellar network/);
    expect(m).not.toMatch(/No wallet was found|not been deployed/);
  });
});
