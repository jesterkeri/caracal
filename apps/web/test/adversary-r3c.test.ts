// Adversary r3c: attacks on the relay's answer to the user, the relay's
// documented setup paths, and sign-out's "always ended" promise.
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signOutEverywhere } from "../src/lib/auth/wallet-binding";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { rpc } from "@stellar/stellar-sdk";
import { SHARED_DEPLOYER, SPLIT_ID, WALLET, transferArgs, walletCtorArgs } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

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
async function post(body: unknown) {
  walletOnChain();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { hash: "h" } }))));
  const { POST } = await import("../src/app/api/relay/route");
  return POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) }));
}

describe("adv r3c: what the user is told about a payment", () => {
  // The Channels plugin only treats status "failed" as a failure. Its transaction
  // wait also ends on "expired" and "canceled", which return a hash and no error.
  it.each(["expired", "canceled"])("Channels answering a hash with status %s is not reported as a successful payment", async (status) => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true, data: { transactionId: "tx-1", hash: "ab".repeat(32), status }, error: null }));
    };
    const r = await post(transfer());
    const body = (await r.json()) as { success: boolean };
    expect(body.success).toBe(false);
  });
});

describe("adv r3c: documented setup paths", () => {
  it("a non-https, non-local NEXT_PUBLIC_STELLAR_RPC_URL does not make the route throw when creating a wallet", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "http://rpc.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(600);
    expect(((await r.json()) as { success: boolean }).success).toBe(false);
  });
});

describe("adv r3c: sign-out", () => {
  it("wallet-binding.ts: the session is always ended, even when the owner binding cannot be removed", async () => {
    const store = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error("storage blocked");
      },
    };
    const endSession = vi.fn(async () => {});
    await signOutEverywhere(store, { disconnect: async () => {} }, endSession).catch(() => {});
    expect(endSession).toHaveBeenCalledTimes(1);
  });
});
