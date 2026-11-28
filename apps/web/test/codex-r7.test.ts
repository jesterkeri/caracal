// Codex R7 (2026-11-27) regression tests for the wallet creation's escape:
// #1 the wait for an earlier attempt rested on an RPC's lag, which is not a bound. Now the page reads the
//    latest ledger BEFORE sending, records closeBy = latest + CREATION_CLOSE_LEDGERS, and sends it to the
//    relay, which caps the deployment's authorisation at closeBy and refuses (nothing sent) past it.
// #2 a pending wallet the network does not show was treated as "did not create". Now it stays uncertain:
//    the person is warned, must choose explicitly, and the address is kept and shown.
import { Address, xdr } from "@stellar/stellar-sdk";
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATION_CLOSE_LEDGERS, POSSIBLE_WALLETS_KEY } from "../src/lib/auth/creation-marker";
import { closeByOf, deployAuthExpiry, DEPLOY_AUTH_LEDGERS } from "../src/lib/relay/deploy-auth";
import { withCreationCloseBy } from "../src/lib/stellar/creation-close-by";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, WALLET, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("Codex R7 #1: the relay keeps a creation within the page's closeBy", () => {
  it("deployAuthExpiry: the short expiry, capped at closeBy, none once the network reached it", () => {
    expect(DEPLOY_AUTH_LEDGERS).toBe(12);
    expect(deployAuthExpiry(1000, null)).toBe(1012);
    expect(deployAuthExpiry(1000, 2000)).toBe(1012);
    expect(deployAuthExpiry(1000, 1005)).toBe(1005);
    expect(deployAuthExpiry(1000, 1001)).toBe(1001);
    expect(deployAuthExpiry(1000, 1000)).toBeNull();
    expect(deployAuthExpiry(1000, 900)).toBeNull();
  });

  it("closeByOf: absent is null; only a plain ledger number is accepted", () => {
    expect(closeByOf("http://x/api/relay")).toBeNull();
    expect(closeByOf("http://x/api/relay?closeBy=1024")).toBe(1024);
    for (const bad of ["abc", "0", "-1", "1e3", "01", "1.5", "", "99999999999", "4294967296"]) {
      expect(closeByOf(`http://x/api/relay?closeBy=${bad}`), bad).toBe("invalid");
    }
  });

  function walletDeploy() {
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
          credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(creds),
          rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args), subInvocations: [] }),
        }).toXDR("base64"),
      ],
    };
  }

  async function post(query: string) {
    const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
    const data = new xdr.ContractDataEntry({ ext: new xdr.ExtensionPoint(0), contract: Address.fromString(WALLET).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent(), val: xdr.ScVal.scvContractInstance(inst) });
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [{ val: xdr.LedgerEntryData.contractData(data) }] })) as never);
    const upstream = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      new Response(JSON.stringify({ success: true, data: { transactionId: "bec66e49-36ef-4d68-8249-8e214fc6fb7b", hash: "a486e639538a16820417ecf3b4208e6cb17e09eeee2f79c9f93dea6a96d5e87f", status: "confirmed" } }), { headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request(`http://x/api/relay${query}`, { method: "POST", body: JSON.stringify(walletDeploy()) }));
    const expiry = upstream.mock.calls.length
      ? xdr.SorobanAuthorizationEntry.fromXDR((JSON.parse(upstream.mock.calls[0]![1].body as string) as { auth: string[] }).auth[0]!, "base64").credentials().address().signatureExpirationLedger()
      : null;
    return { r, upstream, expiry };
  }

  it("control: without closeBy the deployment is re-signed to expire 12 ledgers after the check", async () => {
    const { r, expiry } = await post("");
    expect(r.status).toBe(200);
    expect(expiry).toBe(1_000_012);
  });

  it("a closeBy before the short expiry caps the re-signed authorisation at closeBy", async () => {
    const { r, expiry } = await post("?closeBy=1000005");
    expect(r.status).toBe(200);
    expect(expiry).toBe(1_000_005);
  });

  it("a closeBy the network has already reached is refused before sending", async () => {
    const { r, upstream } = await post("?closeBy=1000000");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/Nothing was sent/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("a closeBy that is not a ledger number is refused before sending", async () => {
    const { r, upstream } = await post("?closeBy=soon");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/Nothing was sent/);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("Codex R7 #1: the page names closeBy on the creation's relay request", () => {
  it("the relayer's url carries closeBy while the creation runs and is put back after, also on failure", async () => {
    const kit = { relayer: { url: "https://caracal.test/api/relay" } };
    let seen = "";
    await withCreationCloseBy(kit, 1234, async () => void (seen = kit.relayer.url));
    expect(seen).toBe("https://caracal.test/api/relay?closeBy=1234");
    expect(kit.relayer.url).toBe("https://caracal.test/api/relay");
    await expect(withCreationCloseBy(kit, 1234, async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(kit.relayer.url).toBe("https://caracal.test/api/relay");
  });

  it("a relayer whose url cannot be set stops before anything runs and says nothing was sent", async () => {
    const run = vi.fn(async () => 1);
    await expect(withCreationCloseBy({ relayer: {} }, 1234, run)).rejects.toThrow(/Nothing was sent/);
    expect(run).not.toHaveBeenCalled();
  });
});

// ---- the wallet page ----
type El = { props?: { children?: unknown; onClick?: () => unknown } };
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) node.forEach((n) => texts(n, out));
  else if (typeof node === "string") out.push(node);
  else if (typeof node === "object" && node !== null) texts((node as El).props?.children, out);
  return out;
}
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
const PENDING = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";

async function walletPage(local: Map<string, string>, states: unknown[], kitExtra: Record<string, unknown>) {
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
  const user = { id: "A", email: "a@x.ng" };
  const auth = {
    getUser: async () => ({ data: { user }, error: null }),
    getSession: async () => ({ data: { session: { user } } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
  };
  const kit = { events: { on: () => () => {} }, disconnect: async () => {}, connectWallet: async () => null, createWallet: vi.fn(async () => { throw new Error("The operation either timed out or was not allowed."); }), ...kitExtra };
  vi.doMock("@/lib/supabase/client", () => ({ supabaseBrowser: () => ({ auth }) }));
  vi.doMock("@/lib/stellar/kit", () => ({ HTTPS_RPC_REQUIRED: "https required", getKit: () => Promise.resolve(kit) }));
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
  vi.stubGlobal("window", {
    location: { replace: vi.fn(), reload: vi.fn(), origin: "https://caracal.test", search: "" },
    localStorage: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
    addEventListener() {},
    removeEventListener() {},
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const mod = await import("../src/app/wallet/page");
  const last = () => setters.filter((x) => x.i === 0).at(-1)?.v as { kind: string; message?: string; notFound?: string };
  return { tree: mod.default(), kit, last, user };
}
const ledgerRpc = (latest: number | Error, entries: unknown[] = []) => ({
  getLatestLedger: async () => {
    if (latest instanceof Error) throw latest;
    return { sequence: latest };
  },
  getLedgerEntries: async () => ({ entries, latestLedger: typeof latest === "number" ? latest : 0 }),
});

describe("Codex R7 #1: the page records closeBy before sending and sends it", () => {
  it("Create records latest + CREATION_CLOSE_LEDGERS before the creation starts, and the relay request names it", async () => {
    const local = new Map<string, string>();
    let atSend: { recorded?: string; url?: string } = {};
    const relayer = { url: "https://caracal.test/api/relay" };
    const createWallet = vi.fn(async () => {
      atSend = { recorded: local.get("caracal.creationCloseLedger"), url: relayer.url };
      throw new Error("The operation either timed out or was not allowed.");
    });
    const p = await walletPage(local, [{ kind: "idle" }, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(5000), relayer, createWallet });
    await clickOn(p.tree, "Create wallet with a passkey")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(createWallet).toHaveBeenCalledTimes(1);
    const closeBy = 5000 + CREATION_CLOSE_LEDGERS;
    // Changed with Codex Day 1 R8 #1: the close ledger is recorded per account ({ accountId: ledger }).
    expect(JSON.parse(atSend.recorded!)).toEqual({ A: closeBy });
    expect(atSend.url).toBe(`https://caracal.test/api/relay?closeBy=${closeBy}`);
    expect(relayer.url).toBe("https://caracal.test/api/relay");
  });

  it("a network that cannot be read before Create sends nothing and says so", async () => {
    const local = new Map<string, string>();
    const p = await walletPage(local, [{ kind: "idle" }, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(new Error("down")), relayer: { url: "https://caracal.test/api/relay" } });
    await clickOn(p.tree, "Create wallet with a passkey")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().message).toMatch(/could not read the Stellar network, so nothing was created or sent/);
    expect(local.has("caracal.creationUnconfirmed")).toBe(false);
  });
});

describe("Codex R7 #2: a pending wallet the network does not show stays uncertain", () => {
  const earlier = (extra: Record<string, string> = {}) =>
    new Map<string, string>([
      ["caracal.creationUnconfirmed", "A"],
      ["caracal.creationStartedAt", String(Date.now() - 4 * 60_000)],
      ["caracal.creationCloseLedger", JSON.stringify({ A: 1024 })],
      ["caracal.creationPendingWallet", JSON.stringify({ A: PENDING })],
      ...Object.entries(extra),
    ]);

  it("the escape does not create: it warns, names the address and asks for an explicit choice", async () => {
    const local = earlier();
    const p = await walletPage(local, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(1025, []) });
    await clickOn(p.tree, "Start a new one anyway")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().notFound).toBe(PENDING);
    expect(p.last().message).toContain(PENDING);
    expect(p.last().message).toMatch(/does not prove it was not made/);
    expect(local.get("caracal.creationUnconfirmed")).toBe("A");

    // the warning offers only the explicit choice, not the plain escape
    vi.resetModules();
    const shown = await walletPage(local, [p.last(), "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(1025, []) });
    const words = texts(shown.tree).join(" ");
    expect(words).not.toContain("Start a new one anyway");
    expect(words).toContain("Make a new wallet anyway (if the earlier one exists, you will have two)");
  });

  it("the explicit choice creates, and the earlier address is kept and shown afterwards", async () => {
    const local = earlier();
    const state = { kind: "error", message: "x", checkFirst: true, notFound: PENDING };
    const p = await walletPage(local, [state, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(1025, []), relayer: { url: "https://caracal.test/api/relay" } });
    await clickOn(p.tree, "Make a new wallet anyway (if the earlier one exists, you will have two)")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.kit.createWallet).toHaveBeenCalledTimes(1);
    expect(JSON.parse(local.get(POSSIBLE_WALLETS_KEY)!)).toEqual({ A: [PENDING] });

    vi.resetModules();
    const later = await walletPage(local, [{ kind: "idle" }, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(1030, []) });
    expect(texts(later.tree).join(" ")).toContain(`An earlier attempt may have made the wallet ${PENDING}`);
  });

  it("a choice made for a different address (the record changed since) is not taken as consent", async () => {
    const local = earlier();
    const state = { kind: "error", message: "x", checkFirst: true, notFound: "CBOTHERWALLETNOTTHEPENDINGONE" };
    const p = await walletPage(local, [state, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(1025, []) });
    await clickOn(p.tree, "Make a new wallet anyway (if the earlier one exists, you will have two)")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().notFound).toBe(PENDING);
  });

  it("an earlier attempt with no recorded close ledger is refused, whatever the network shows", async () => {
    const local = earlier();
    local.delete("caracal.creationCloseLedger");
    const p = await walletPage(local, [{ kind: "idle", knownWallet: true, checkFirst: true }, "Ada", { id: "A", email: "a@x.ng" }], { rpc: ledgerRpc(999_999, []) });
    await clickOn(p.tree, "Start a new one anyway")!();
    await new Promise((r) => setTimeout(r, 20));
    expect(p.kit.createWallet).not.toHaveBeenCalled();
    expect(p.last().message).toMatch(/last possible ledger was not recorded/);
  });
});
