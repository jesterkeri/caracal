// Codex r3 #1: a wallet's code can change (owner-authorised upgrade) after the
// relay first looked it up. The relay must decide on the code the transaction
// will actually load, and pin it, so an upgrade after the check cannot run.
// Also observation (b): junk auth must be refused before reaching the relayer.
import { Address, Keypair, Networks, TransactionBuilder, rpc, xdr, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { footprintCode, serial } from "../src/lib/relay/sponsor";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { simulated } from "./setup-relay-server";
import { SHARED_DEPLOYER, SPLIT_ID, WALLET, transferArgs, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const UPGRADED = "aa".repeat(32); // any wasm that is not Caracal's
const call = () =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
const transfer = () => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(call()).toXDR("base64"),
  auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call()))],
});
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

/** The relay's chain lookup sees WALLET running the passkey account wasm (what the policy cache primes). */
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

const ok = () => new Response(JSON.stringify({ success: true, data: { transactionId: "t", hash: "h", status: "confirmed" } }), { headers: { "Content-Type": "application/json" } });
async function post(body: unknown) {
  walletOnChain();
  const upstream = vi.fn(async (_url: string, _init: RequestInit) => ok());
  vi.stubGlobal("fetch", upstream);
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) }));
  return { r, upstream };
}
const sentXdr = (upstream: ReturnType<typeof vi.fn>) =>
  TransactionBuilder.fromXDR(JSON.parse(upstream.mock.calls[0][1].body).params.xdr, Networks.TESTNET) as Transaction | FeeBumpTransaction;

describe("code identity is decided on what the transaction loads (Codex r3 #1)", () => {
  it("a wallet upgraded after the cached lookup is refused, and nothing is forwarded", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated([UPGRADED, SMART_ACCOUNT.webauthnVerifierWasmHash]));
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/not Caracal's/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("a deployment whose simulation would load foreign code is refused too", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => simulated([SMART_ACCOUNT.accountWasmHash, UPGRADED]));
    const { r, upstream } = await post(walletDeploy());
    expect(r.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("the transaction sent for fee bumping is pinned to the checked footprint and auth, signed by the relay's own account", async () => {
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(200);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe("https://channels.openzeppelin.com/testnet/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-channels-key");
    const tx = sentXdr(upstream) as Transaction;
    expect("innerTransaction" in tx).toBe(false); // a plain signed tx; Channels adds the fee bump
    // Pinned code: only Caracal's wasm, exactly as simulated. An upgrade after
    // this point needs a code entry the footprint does not have, so it fails.
    const data = tx.toEnvelope().v1().tx().ext().sorobanData();
    expect(footprintCode(data).sort()).toEqual([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash].sort());
    // Same auth the policy checked; source is the relay's account, which signed.
    const op = tx.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
    expect(op.auth!.map((a) => a.toXDR("base64"))).toEqual(transfer().auth);
    const source = Keypair.fromPublicKey(tx.source);
    expect(source.publicKey()).toBe(Keypair.fromSecret(process.env.RELAY_SOURCE_SECRET!).publicKey());
    expect(source.verify(tx.hash(), tx.signatures[0].signature())).toBe(true);
    // Short validity, within what Channels accepts.
    expect(Number(tx.timeBounds!.maxTime) - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(30);
  });

  it("a deployment names its code in the request, so it goes to the proxy as { func, auth }", async () => {
    const body = walletDeploy();
    const { r, upstream } = await post(body);
    expect(r.status).toBe(200);
    expect(upstream.mock.calls[0][0]).toBe("https://smart-account-relayer-proxy.sdf-ecosystem.workers.dev");
    expect(JSON.parse(upstream.mock.calls[0][1].body as string)).toEqual(body);
  });
});

describe("the simulation is enforced before anything is forwarded", () => {
  it("junk or forged auth fails enforced simulation and is refused (Codex r3 observation b)", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(
      async () => ({ _parsed: true, id: "s", latestLedger: 1, events: [], error: "HostError: Error(Auth, InvalidAction)" }) as never,
    );
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("a call needing more resources than Caracal sponsors is refused", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () =>
      simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash], "50000000"),
    );
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("archived contract data asks for a restore instead of forwarding", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => ({
      ...simulated([SMART_ACCOUNT.accountWasmHash]),
      restorePreamble: { minResourceFee: "1", transactionData: simulated([]).transactionData },
    }) as never);
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("the split contract's wasm is also Caracal's", async () => {
    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () =>
      simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash, SPLIT.wasmHash]),
    );
    expect((await post(transfer())).r.status).toBe(200);
  });
});

describe("fails closed when not set up", () => {
  it("without CHANNELS_API_KEY a contract call is refused and nothing is forwarded; a wallet deploy still works", async () => {
    vi.stubEnv("CHANNELS_API_KEY", "");
    const call = await post(transfer());
    expect(call.r.status).toBe(503);
    expect(call.upstream).not.toHaveBeenCalled();
    vi.resetModules();
    expect((await post(walletDeploy())).r.status).toBe(200);
  });

  it("without RELAY_SOURCE_SECRET nothing is sponsored", async () => {
    vi.stubEnv("RELAY_SOURCE_SECRET", "");
    const { r, upstream } = await post(transfer());
    expect(r.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("one transaction at a time per source account", () => {
  it("serial() never overlaps tasks, and a failed task does not block the next", async () => {
    const run = serial();
    const log: string[] = [];
    const task = (name: string, fail = false) => async () => {
      log.push(`${name} start`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`${name} end`);
      if (fail) throw new Error(name);
    };
    await Promise.allSettled([run(task("a", true)), run(task("b")), run(task("c"))]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });
});
