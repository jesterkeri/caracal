// Adversary r3d: attacks on what the relay tells the user about wallet creation
// (proxy path) and on the "every relayer call is time-bounded" promise.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, SPLIT_ID, WALLET, transferArgs, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
const call = () =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
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
const req = (body: unknown) => new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) });

describe("adv r3d: wallet creation through the SDF proxy", () => {
  // Same class as r3c: the plugin ends its wait on expired/canceled and still returns a hash.
  // The proxy path passes the upstream body on as a success without looking at the status.
  it.each(["expired", "canceled"])("a proxy answer with a hash and status %s is not reported as a created wallet", async (status) => {
    walletOnChain();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { transactionId: "t", hash: "ab".repeat(32), status } }), { status: 200 })));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(req(walletDeploy()));
    const body = (await r.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

describe("adv r3d: sign-out always ends the session", () => {
  // wallet-binding.ts: "The session is always ended, even if the wallet cannot be
  // disconnected (the kit failed to load, or its storage is blocked)". A kit load or
  // IndexedDB open that never settles (a stalled chunk fetch, a blocked IndexedDB
  // upgrade) is a common way a wallet "cannot be disconnected".
  it("the session is still ended when the wallet kit never settles", async () => {
    const { signOutEverywhere } = await import("../src/lib/auth/wallet-binding");
    const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const endSession = vi.fn(async () => {});
    void signOutEverywhere(store, new Promise(() => {}), endSession).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});

describe("adv r3d: relayer calls are time-bounded", () => {
  it("Channels sends headers then drips its body forever: the route still answers within the configured timeout", async () => {
    walletOnChain();
    const drip = createServer((_q, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("{");
      const t = setInterval(() => res.write(" "), 200);
      res.on("close", () => clearInterval(t));
    });
    await new Promise<void>((r) => drip.listen(0, "127.0.0.1", r));
    vi.stubEnv("CHANNELS_BASE_URL", `http://127.0.0.1:${(drip.address() as AddressInfo).port}`);
    vi.stubEnv("CHANNELS_TIMEOUT_MS", "1000");
    const { POST } = await import("../src/app/api/relay/route");
    const outcome = await Promise.race([
      POST(req(transfer())).then(() => "answered"),
      new Promise<string>((r) => setTimeout(() => r("still hanging after 6 s (configured timeout 1 s)"), 6000)),
    ]);
    drip.closeAllConnections();
    await new Promise((r) => drip.close(r));
    expect(outcome).toBe("answered");
  }, 15_000);
});
