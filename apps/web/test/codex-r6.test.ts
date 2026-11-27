// Codex R6 (2026-11-27) regression tests for the relay findings:
// #4 the 60 s send deadline is measured on a monotonic clock and checked again just before sending;
// #5 a shared-deployer wallet deployment authorised with ADDRESS_V2 credentials is re-signed, not refused;
// adversary i6 #2: an HTTP 429 from Channels says "Nothing was sent".
import { Address, Keypair, Networks, buildAuthorizationEntryPreimage, hash, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, WALLET, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/relay/deploy-auth");
  vi.resetModules();
});

function walletDeploy(v2 = false) {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), salt: Buffer.alloc(32, 7) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")),
    constructorArgs: walletCtorArgs(),
  });
  const creds = new xdr.SorobanAddressCredentials({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() });
  return {
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"),
    auth: [
      new xdr.SorobanAuthorizationEntry({
        credentials: v2 ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(creds) : xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args), subInvocations: [] }),
      }).toXDR("base64"),
    ],
  };
}

function walletOnChain() {
  const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(WALLET).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [{ val: xdr.LedgerEntryData.contractData(data) }] })) as never);
}

const ok = () => new Response(JSON.stringify({ success: true, data: { transactionId: "bec66e49-36ef-4d68-8249-8e214fc6fb7b", hash: "a486e639538a16820417ecf3b4208e6cb17e09eeee2f79c9f93dea6a96d5e87f", status: "confirmed" } }), { headers: { "Content-Type": "application/json" } });

async function post(body: unknown, request?: Request) {
  walletOnChain();
  const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => ok());
  vi.stubGlobal("fetch", upstream);
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(request ?? new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) }));
  return { r, upstream };
}

describe("Codex R6 #5: ADDRESS_V2 shared-deployer authorisation", () => {
  it("control: the classic address arm is re-signed and forwarded", async () => {
    const { r, upstream } = await post(walletDeploy(false));
    expect(r.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("a V2 entry is forwarded as V2, re-signed to expire 12 ledgers after the check, with a valid V2 signature", async () => {
    const body = walletDeploy(true);
    const { r, upstream } = await post(body);
    expect(r.status).toBe(200);
    const sent = JSON.parse(upstream.mock.calls[0]![1].body as string) as { func: string; auth: string[] };
    expect(sent.func).toBe(body.func);
    const after = xdr.SorobanAuthorizationEntry.fromXDR(sent.auth[0]!, "base64");
    expect(after.credentials().switch().name).toBe("sorobanCredentialsAddressV2");
    const c = after.credentials().addressV2();
    expect(c.signatureExpirationLedger()).toBe(1_000_012);
    expect(c.nonce().toString()).toBe("9");
    const sig = (c.signature().vec() ?? [])[0]!.map()!.find((e) => e.key().sym().toString() === "signature")!.val().bytes();
    const payload = hash(buildAuthorizationEntryPreimage(after, 1_000_012, Networks.TESTNET).toXDR());
    expect(Keypair.fromPublicKey(SHARED_DEPLOYER).verify(payload, sig)).toBe(true);
  });
});

describe("Codex R6 #4: the send deadline", () => {
  it("is measured on a monotonic clock: a wall clock set back does not let a request older than 60 s be sent", async () => {
    let mono = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => (mono += 31_000)); // every reading is 31 s later
    vi.spyOn(Date, "now").mockReturnValue(0); // the wall clock stands still (as if set back)
    const { r, upstream } = await post(walletDeploy());
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/Nothing was sent/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("is checked again after re-signing: a caller gone while the relay re-signed is not sent", async () => {
    const ctl = new AbortController();
    vi.doMock("@/lib/relay/deploy-auth", async () => {
      const actual = await vi.importActual<typeof import("../src/lib/relay/deploy-auth")>("../src/lib/relay/deploy-auth");
      return {
        ...actual,
        withShortDeployAuth: async (...a: Parameters<typeof actual.withShortDeployAuth>) => {
          const out = await actual.withShortDeployAuth(...a);
          ctl.abort(); // the person closed the page while the relay re-signed
          return out;
        },
      };
    });
    const req = new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()), signal: ctl.signal });
    const { r, upstream } = await post(undefined, req);
    expect(upstream).not.toHaveBeenCalled();
    expect(((await r.json()) as { error: string }).error).toMatch(/Nothing was sent/);
  });
});

// ---- Codex R6 #3: an unreadable record of the account's wallet is not "no wallet" ----
import { KNOWN_WALLETS_KEY, knownWalletFor } from "../src/lib/auth/wallet-binding";

type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
const WALLET_A = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

/** The wallet page, signed in as A, with no saved session to restore; `getItem` is this browser's localStorage read. */
async function walletPage(getItem: (k: string) => string | null, states: unknown[] = [], kitExtra: Record<string, unknown> = {}, setItem: (k: string, v: string) => void = () => {}, removeItem: (k: string) => void = () => {}) {
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
  const user = { id: "A", email: "a@x.ng" };
  const auth = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { user } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const kit = { events: { on: () => () => {} }, disconnect: async () => {}, connectWallet: async () => null, createWallet: vi.fn(async () => { throw new Error("The operation either timed out or was not allowed."); }), rpc: undefined as unknown, ...kitExtra };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(withLedger(kit)) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem, setItem, removeItem },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  return { tree: mod.default(), effects, setters, user, kit };
}

describe("Codex R6 #3: the account's wallet record cannot be read", () => {
  it("knownWalletFor tells none, known and unreadable apart", () => {
    const store = (v: string | null | Error) => ({ getItem: () => { if (v instanceof Error) throw v; return v; }, setItem() {}, removeItem() {} });
    expect(knownWalletFor(store(null), "A")).toEqual({ kind: "none" });
    expect(knownWalletFor(store(JSON.stringify({ B: WALLET_A })), "A")).toEqual({ kind: "none" });
    expect(knownWalletFor(store(JSON.stringify({ A: WALLET_A })), "A")).toEqual({ kind: "known", wallet: WALLET_A });
    expect(knownWalletFor(store(new DOMException("The operation is insecure.", "SecurityError") as unknown as Error), "A")).toEqual({ kind: "unreadable" });
    expect(knownWalletFor(store("{not json"), "A")).toEqual({ kind: "unreadable" });
  });

  it("control: a readable record naming no wallet offers plain Create", async () => {
    const p = await walletPage(() => null);
    await p.effects[0]!();
    await new Promise((r) => setTimeout(r, 20));
    const state = p.setters.filter((s) => s.i === 0).at(-1)?.v as { kind: string; knownWallet?: boolean };
    expect(state).toEqual({ kind: "idle" });
  });

  it("an unreadable record does not offer plain Create; it says why, and a new wallet only with a warning", async () => {
    const p = await walletPage((k) => {
      if (k === KNOWN_WALLETS_KEY) throw new DOMException("The operation is insecure.", "SecurityError");
      return null;
    });
    await p.effects[0]!();
    await new Promise((r) => setTimeout(r, 20));
    const state = p.setters.filter((s) => s.i === 0).at(-1)?.v;
    expect(state).toMatchObject({ kind: "idle", knownWallet: true, storageUnread: true });
    vi.resetModules();
    const again = await walletPage(() => null, [state, "", p.user]);
    const shown = texts(again.tree).join(" ");
    expect(shown).not.toContain("Create wallet with a passkey");
    expect(shown).toContain("could not read this browser's record of your wallet");
    expect(shown).toContain("Make a new wallet anyway (if this account already has one, this makes a second)");
  });
});

// ---- Codex R6 #2: an empty getLedgerEntries answer is not proof that a wallet does not exist ----
import { walletStatus } from "../src/lib/stellar/wallet-lookup";
import { withLedger } from "./fake-ledger";

describe("Codex R6 #2: an archived wallet the RPC leaves out", () => {
  it("an answer with no entry is 'not-found' (proves neither), not 'absent'", async () => {
    const status = await walletStatus({ getLedgerEntries: async () => ({ entries: [], latestLedger: 100 }) }, WALLET_A);
    expect(status).toBe("not-found");
  });

  it("control: an entry past its live-until ledger is 'archived', a live one 'present'", async () => {
    expect(await walletStatus({ getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 50 }], latestLedger: 100 }) }, WALLET_A)).toBe("archived");
    expect(await walletStatus({ getLedgerEntries: async () => ({ entries: [{ liveUntilLedgerSeq: 500 }], latestLedger: 100 }) }, WALLET_A)).toBe("present");
  });
});

// ---- Codex R6 #1: the escape waits until the earlier attempt's authorisation has expired by ledger ----
function clickOn(node: unknown, text: string): (() => unknown) | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const f = clickOn(n, text);
      if (f) return f;
    }
    return null;
  }
  if (typeof node !== "object" || node === null) return null;
  const kids = (node as El).props?.children;
  const own = (Array.isArray(kids) ? kids : [kids]).filter((k) => typeof k === "string").join("");
  const f = (node as El).props?.onClick;
  if (typeof f === "function" && own.includes(text)) return f;
  return clickOn(kids, text);
}

/** The page after an unknown outcome, 4 minutes after the attempt's last sign of life; the person presses the escape. */
async function escapeAfterFourMinutes(network: { latest: number | Error }, recorded: Record<string, string> = {}, entries: { liveUntilLedgerSeq?: number }[] = []) {
  const local = new Map<string, string>([
    ["caracal.creationUnconfirmed", "A"],
    ["caracal.creationStartedAt", String(Date.now() - 4 * 60_000)],
    ...Object.entries(recorded),
  ]);
  const rpc = {
    getLatestLedger: async () => {
      if (network.latest instanceof Error) throw network.latest;
      return { sequence: network.latest };
    },
    getLedgerEntries: async () => ({ entries, latestLedger: typeof network.latest === "number" ? network.latest : 0 }),
  };
  const user = { id: "A", email: "a@x.ng" };
  const p = await walletPage((k) => local.get(k) ?? null, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", user], { rpc }, (k, v) => void local.set(k, v), (k) => void local.delete(k));
  await clickOn(p.tree, "Start a new one anyway")!();
  await new Promise((r) => setTimeout(r, 20));
  const last = p.setters.filter((x) => x.i === 0).at(-1)?.v as { kind: string; message?: string };
  return { local, last, created: (p.kit.createWallet as ReturnType<typeof vi.fn>).mock.calls.length };
}

describe("Codex R6 #1: a deployment can land after the 3-minute wait if ledgers are slow", () => {
  // Superseded by Codex R7 #1 (decisions row "Codex R7"): the close ledger is no longer set on the
  // escape press from an RPC read (Codex showed an RPC's lag is not a bound). It is recorded BEFORE
  // sending and enforced by the relay. An attempt with no recorded close ledger therefore has no
  // proven bound, and the escape refuses it instead of recording one. The R6 promise kept: after 3
  // minutes with an unknown bound, the press creates nothing.
  it("after 3 minutes an attempt with no recorded close ledger creates nothing and records none", async () => {
    const r = await escapeAfterFourMinutes({ latest: 1000 });
    expect(r.created).toBe(0);
    expect(r.local.has("caracal.creationCloseLedger")).toBe(false);
    expect(r.last.message).toMatch(/last possible ledger was not recorded/);
  });

  it("a stalled network (close ledger not yet reached) still creates nothing, however long it has been", async () => {
    const r = await escapeAfterFourMinutes({ latest: 1010 }, { "caracal.creationCloseLedger": "1024" });
    expect(r.created).toBe(0);
    expect(r.last.message).toMatch(/until ledger 1024 has closed/);
  });

  it("at the close ledger itself it still waits (the attempt may land in that ledger)", async () => {
    const r = await escapeAfterFourMinutes({ latest: 1024 }, { "caracal.creationCloseLedger": "1024" });
    expect(r.created).toBe(0);
  });

  it("control: once the network is past the close ledger, the person's choice starts a creation", async () => {
    const r = await escapeAfterFourMinutes({ latest: 1025 }, { "caracal.creationCloseLedger": "1024" });
    expect(r.created, JSON.stringify(r.last)).toBe(1);
  });

  it("past the close ledger, an attempt whose own wallet is on the chain is named instead of making a second", async () => {
    const r = await escapeAfterFourMinutes({ latest: 1025 }, { "caracal.creationCloseLedger": "1024", "caracal.creationPendingWallet": JSON.stringify({ A: WALLET_A }) }, [{ liveUntilLedgerSeq: 9999 }]);
    expect(r.created).toBe(0);
    expect(r.last.message).toMatch(/created your wallet after all/);
    expect(r.last.message).toContain(WALLET_A);
  });

  it("a network that cannot be read creates nothing and says the outcome cannot be told yet", async () => {
    const r = await escapeAfterFourMinutes({ latest: new Error("down") }, { "caracal.creationCloseLedger": "1024" });
    expect(r.created).toBe(0);
    expect(r.last.message).toMatch(/cannot tell yet whether the earlier attempt can still finish/);
  });
});
