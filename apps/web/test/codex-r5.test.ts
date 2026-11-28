// Codex R5 (REVISE, 4 findings), each proven fixed here:
// 1. Two tabs could start a wallet creation at the same moment.
// 2. A creation could still land after the 3-minute wait before "start a new
//    one anyway" (no deadline in the relay's queue; the kit's deploy
//    authorisation lasts about an hour).
// 3. Signing out forgot that the account had a wallet here, so signing in
//    again offered Create with no hint.
// 4. A healthy ledger endpoint was taken as proof that a passkey has no wallet.
import { Address, Keypair, Networks, hash, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { simulated } from "./setup-relay-server";
import { SHARED_DEPLOYER, walletCtorArgs } from "./relay-fixtures";
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

const MARK = "caracal.creationUnconfirmed";
const KNOWN = "caracal.knownWallets";
const OWNER = "caracal.walletOwner";
type User = { id: string; email: string };
const A = { id: "A", email: "a@x.ng" };
// A real-looking wallet address (the remembered-wallet record only keeps valid ones).
const WALLET_A = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const settle = () => new Promise((r) => setTimeout(r, 20));

/** One browser: localStorage survives reloads and is shared by its tabs. */
function browser(submit: () => unknown) {
  const local = new Map<string, string>();
  const listeners = new Set<() => void>();
  const kit = {
    events: { on: (_e: string, cb: () => void) => (listeners.add(cb), () => listeners.delete(cb)) },
    disconnect: async () => {},
    connectWallet: async (): Promise<unknown> => null,
    createWallet: async () => {
      listeners.forEach((cb) => cb()); // credentialCreated
      await settle(); // the build and send take a while
      return submit();
    },
    rpc: undefined as unknown,
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
const lastState = (setters: { i: number; v: unknown }[]) => setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; message?: string; checkFirst?: boolean };
const unknownOutcome = () => ({ contractId: "CX", submitResult: { success: false, error: new Error("Relayer request failed with status 504") } });

describe("Codex R5 #1: one wallet creation at a time across tabs", () => {
  it("two tabs clicking Create at the same moment start one creation, not two", async () => {
    const b = browser(unknownOutcome);
    const create = vi.spyOn(b.kit, "createWallet");
    const tab1 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    vi.resetModules();
    const tab2 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    // Neither click is awaited before the other starts.
    await Promise.all([click(tab1.tree, "Create wallet")!(), click(tab2.tree, "Create wallet")!()]);
    expect(create).toHaveBeenCalledTimes(1);
    const second = lastState(tab2.setters);
    expect(second.kind).toBe("error");
    expect(second.message).toMatch(/already under way in another tab/);
  });

  it("the lock is let go when the attempt ends, so a later Create in the other tab is judged on what happened", async () => {
    const b = browser(() => ({ contractId: "CX", submitResult: { success: false, error: new Error("Payload too large. Nothing was sent.") } }));
    const create = vi.spyOn(b.kit, "createWallet");
    const tab1 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(tab1.tree, "Create wallet")!();
    vi.resetModules();
    const tab2 = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(tab2.tree, "Create wallet")!();
    expect(create).toHaveBeenCalledTimes(2); // nothing was sent the first time
  });

  it("a browser without Web Locks creates nothing, and says why", async () => {
    const b = browser(unknownOutcome);
    const create = vi.spyOn(b.kit, "createWallet");
    vi.stubGlobal("navigator", {});
    const tab = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(tab.tree, "Create wallet")!();
    expect(create).not.toHaveBeenCalled();
    expect(lastState(tab.setters).message).toMatch(/cannot make sure that only one tab/);
  });

  it("while an attempt runs, its start time is renewed, so the wait counts from its last sign of life", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      let finish: (v: unknown) => void = () => {};
      const b = browser(() => new Promise((r) => (finish = r)));
      const tab = await render(b, A, [{ kind: "idle" }, "Ada", A]);
      const run = click(tab.tree, "Create wallet")!();
      await vi.advanceTimersByTimeAsync(0);
      const first = Number(b.local.get("caracal.creationStartedAt"));
      await vi.advanceTimersByTimeAsync(35_000);
      expect(Number(b.local.get("caracal.creationStartedAt")) - first).toBeGreaterThanOrEqual(30_000);
      await new Promise((r) => setTimeout(r, 60)); // real time: the fake kit reaches its submit step
      finish(unknownOutcome());
      await vi.advanceTimersByTimeAsync(50);
      await run;
      expect(b.local.get(MARK)).toBe("A");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Codex R5 #2: the relay bounds when a creation can still land", () => {
  const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1_000_720, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
    }).toXDR("base64");
  function walletDeploy() {
    const args = new xdr.CreateContractArgsV2({
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), salt: Buffer.alloc(32, 7) }),
      ),
      executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")),
      constructorArgs: walletCtorArgs(),
    });
    return {
      func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"),
      auth: [authBy(SHARED_DEPLOYER, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args))],
    };
  }
  const ok = () =>
    new Response(JSON.stringify({ success: true, data: { transactionId: "t", hash: "ab".repeat(32), status: "confirmed" } }), { headers: { "Content-Type": "application/json" } });

  it("a creation that waited too long in the queue is refused before sending, and never sent later", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated([SMART_ACCOUNT.accountWasmHash]));
    // The first request is sent, and its upstream answer is slow: it holds the queue.
    const upstream = vi.fn(async () => {
      await held;
      return ok();
    });
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const post = () => POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    const first = post();
    await settle();
    // Harness (Codex R6 #4, 2026-11-27): the relay's deadline now runs on the monotonic clock, so that clock is
    // the one moved on by 61 s (it was Date.now). Assertions unchanged.
    const t0 = performance.now();
    const second = post(); // arrives while the first is still in the queue
    await settle();
    vi.spyOn(performance, "now").mockReturnValue(t0 + 61_000);
    release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(503);
    expect((await r2.json()).error).toMatch(/Nothing was sent/);
    expect(upstream).toHaveBeenCalledTimes(1); // only the first
  });

  it("a request whose caller has gone is not sent", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => {
      if (calls++ === 0) await held;
      return simulated([SMART_ACCOUNT.accountWasmHash]);
    });
    const upstream = vi.fn(async () => ok());
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const first = POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    await settle();
    const gone = new AbortController();
    const second = POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()), signal: gone.signal }));
    await settle();
    gone.abort();
    release();
    const [, r2] = await Promise.all([first, second]);
    expect((await r2.json()).error).toMatch(/Nothing was sent/);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("the forwarded deployment's authorisation is the shared deployer's valid signature, expiring 12 ledgers after the check", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated([SMART_ACCOUNT.accountWasmHash]));
    const upstream = vi.fn(async (_u: string, _i: RequestInit) => ok());
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    expect(r.status).toBe(200);
    const sent = JSON.parse(upstream.mock.calls[0][1].body as string) as { auth: string[] };
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(sent.auth[0], "base64");
    const cr = entry.credentials().address();
    expect(cr.signatureExpirationLedger()).toBe(1_000_012); // simulated() runs at ledger 1_000_000
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: cr.nonce(),
        signatureExpirationLedger: cr.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    );
    const sig = cr.signature().vec()![0].map()!;
    const field = (k: string) => sig.find((e) => e.key().sym().toString() === k)!.val().bytes();
    const deployer = Keypair.fromPublicKey(SHARED_DEPLOYER);
    expect(Buffer.from(field("public_key")).equals(deployer.rawPublicKey())).toBe(true);
    expect(deployer.verify(hash(preimage.toXDR()), Buffer.from(field("signature")))).toBe(true);
  });

  it("the page's wait is longer than the relay's bound: 10 s heartbeat + 60 s send deadline + 12 ledgers at up to 7 s", async () => {
    const { CREATION_SETTLE_MS, CREATION_HEARTBEAT_MS } = await import("../src/lib/auth/creation-marker");
    const { SEND_DEADLINE_MS } = await import("../src/lib/relay/limits");
    const { DEPLOY_AUTH_LEDGERS } = await import("../src/lib/relay/deploy-auth");
    expect(CREATION_HEARTBEAT_MS + SEND_DEADLINE_MS + DEPLOY_AUTH_LEDGERS * 7_000).toBeLessThan(CREATION_SETTLE_MS);
  });
});

describe("Codex R5 #3: an account that had a wallet here is sent to Connect after signing in again", () => {
  it("a created wallet is remembered for its account, and sign-out keeps that record", async () => {
    const b = browser(() => ({ contractId: WALLET_A, submitResult: { success: true, hash: "ab".repeat(32) } }));
    const page = await render(b, A, [{ kind: "idle" }, "Ada", A]);
    await click(page.tree, "Create wallet")!();
    await settle();
    expect(JSON.parse(b.local.get(KNOWN)!)).toEqual({ A: WALLET_A });
    const { signOutEverywhere } = await import("../src/lib/auth/wallet-binding");
    const store = { getItem: (k: string) => b.local.get(k) ?? null, setItem: (k: string, v: string) => void b.local.set(k, v), removeItem: (k: string) => void b.local.delete(k) };
    await signOutEverywhere(store, b.kit, async () => {});
    expect(b.local.has(OWNER)).toBe(false); // not restored
    expect(JSON.parse(b.local.get(KNOWN)!)).toEqual({ A: WALLET_A }); // but remembered
  });

  it("signing in again: Connect first, the wallet named, and a new wallet only as an explicit choice", async () => {
    const b = browser(unknownOutcome);
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
    const loaded = await render(b, A);
    loaded.effects.forEach((f) => f());
    await settle();
    const state = lastState(loaded.setters);
    vi.resetModules();
    const shown = texts((await render(b, A, [state, "", A])).tree).join(" | ");
    expect(shown).not.toMatch(/Create wallet with a passkey/);
    expect(shown).toContain(WALLET_A);
    expect(shown).toMatch(/I already have a wallet/);
    expect(shown).toMatch(/Make a second, new wallet instead/);
  });

  it("another account on the same browser is not told about A's wallet", async () => {
    const b = browser(unknownOutcome);
    b.local.set(KNOWN, JSON.stringify({ A: WALLET_A }));
    const B = { id: "B", email: "b@x.ng" };
    const loaded = await render(b, B);
    loaded.effects.forEach((f) => f());
    await settle();
    const state = lastState(loaded.setters);
    vi.resetModules();
    const shown = texts((await render(b, B, [state, "", B])).tree).join(" | ");
    expect(shown).toMatch(/Create wallet with a passkey/);
    expect(shown).not.toContain(WALLET_A);
  });

  it("the explicit choice does create", async () => {
    const b = browser(unknownOutcome);
    const create = vi.spyOn(b.kit, "createWallet");
    const page = await render(b, A, [{ kind: "idle", knownWallet: true, remembered: WALLET_A }, "Ada", A]);
    await click(page.tree, "Make a second, new wallet instead")!();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("Codex R5 #4: 'no wallet' only when the network says that contract is absent", () => {
  const KIT_NOT_FOUND = "Smart account contract not found on-chain for credential AQIDBAUGBwgJCgsMDQ4PEA. The wallet may not have been deployed yet.";
  async function connectFails(rpcFake: unknown, marked = false) {
    const b = browser(() => null);
    b.kit.rpc = rpcFake;
    if (marked) b.local.set(MARK, "A");
    b.kit.connectWallet = async () => {
      throw new Error(KIT_NOT_FOUND);
    };
    const page = await render(b, A, [{ kind: "idle" }, "", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    return lastState(page.setters);
  }
  const ledgerOk = { getLatestLedger: async () => ({ sequence: 5 }) };

  it("the ledger answers but the contract lookup fails: not 'no wallet', and the check-first hint stays", async () => {
    const s = await connectFails({ ...ledgerOk, getLedgerEntries: async () => { throw new Error("upstream 502"); } }, true);
    expect(s.message).not.toMatch(/No wallet was found/);
    expect(s.message).toMatch(/could not reach the Stellar network to check/);
    expect(s.checkFirst).toBe(true);
  });
  it("the lookup answers with no such contract: no wallet for this passkey", async () => {
    const s = await connectFails({ ...ledgerOk, getLedgerEntries: async () => ({ entries: [], latestLedger: 5 }) });
    expect(s.message).toMatch(/No wallet was found on Stellar testnet for this passkey/);
  });
  it("the contract exists but expired: it must be restored, and no new wallet is suggested", async () => {
    const s = await connectFails({ ...ledgerOk, getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 3 }], latestLedger: 5 }) }, true);
    expect(s.message).toMatch(/must be restored/);
    expect(s.checkFirst).toBe(false);
  });
  it("the contract exists and is live: the wallet exists, try again", async () => {
    const s = await connectFails({ ...ledgerOk, getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 99 }], latestLedger: 5 }) }, true);
    expect(s.message).toMatch(/Your wallet exists on Stellar testnet/);
    expect(s.checkFirst).toBe(false);
  });
  it("the lookup asks about the passkey's own wallet address, as the kit derives it", async () => {
    const asked: string[] = [];
    await connectFails({
      getLedgerEntries: async (k: xdr.LedgerKey) => {
        asked.push(Address.fromScAddress(k.contractData().contract()).toString());
        return { entries: [], latestLedger: 5 };
      },
    });
    const { deriveContractAddress } = await import("../../../node_modules/.pnpm/smart-account-kit@0.10.0/node_modules/smart-account-kit/dist/utils.js");
    expect(asked).toEqual([deriveContractAddress(Buffer.from("AQIDBAUGBwgJCgsMDQ4PEA", "base64url"), SHARED_DEPLOYER, Networks.TESTNET)]);
  });
  it("restoring a saved wallet: 'gone' only when the network says the contract is absent", async () => {
    for (const [entries, expected] of [
      [async () => ({ entries: [], latestLedger: 5 }), /saved wallet was not found on Stellar testnet/],
      [async () => { throw new Error("upstream 502"); }, /could not load your saved wallet/],
    ] as const) {
      const b = browser(() => null);
      b.local.set(OWNER, "A");
      b.kit.rpc = { ...ledgerOk, getLedgerEntries: entries };
      b.kit.connectWallet = async () => {
        throw new Error(KIT_NOT_FOUND);
      };
      const loaded = await render(b, A);
      loaded.effects.forEach((f) => f());
      await settle();
      expect(lastState(loaded.setters).message).toMatch(expected);
      vi.resetModules();
    }
  });
});

describe("adversary r5b follow-up: only the attempt's own wallet confirms it", () => {
  const W2 = "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
  it("the marker keeps the attempt's wallet through renewals, and drops it when cleared", async () => {
    const { creationMarker } = await import("../src/lib/auth/creation-marker");
    const local = new Map<string, string>();
    const store = { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) };
    const m = creationMarker(store);
    m.markCreation("A", true, W2);
    m.markCreation("A", true); // a heartbeat
    expect(m.pendingWalletFor("A")).toBe(W2);
    m.markCreation("A", false);
    expect(m.pendingWalletFor("A")).toBeNull();
    expect(local.has("caracal.creationPendingWallet")).toBe(false);
  });
  it("connecting the attempt's own wallet confirms it and clears the note", async () => {
    const b = browser(() => null);
    b.local.set(MARK, "A");
    b.local.set("caracal.creationPendingWallet", JSON.stringify({ A: W2 }));
    b.kit.connectWallet = async () => ({ contractId: W2, credentialId: "x" });
    const page = await render(b, A, [{ kind: "idle", knownWallet: true, checkFirst: true }, "", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    expect(b.local.has(MARK)).toBe(false);
  });
  it("connecting an older wallet keeps the note", async () => {
    const b = browser(() => null);
    b.local.set(MARK, "A");
    b.local.set("caracal.creationPendingWallet", JSON.stringify({ A: W2 }));
    b.kit.connectWallet = async () => ({ contractId: WALLET_A, credentialId: "x" });
    const page = await render(b, A, [{ kind: "idle", knownWallet: true, checkFirst: true }, "", A]);
    await click(page.tree, "I already have a wallet")!();
    await settle();
    expect(b.local.get(MARK)).toBe("A");
  });
});
