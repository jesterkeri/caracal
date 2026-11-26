// Adversary r3e: documented setup values for the relay's Channels timeout.
// .env.example: "CHANNELS_TIMEOUT_MS: How long to wait for Channels, in
// milliseconds." A large value (someone choosing "wait much longer") must mean
// a long wait, not an instant failure.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
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
const req = (body: unknown) => new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) });

describe("adv r3e: CHANNELS_TIMEOUT_MS", () => {
  // Channels answers "confirmed" after 400 ms. With a 50-day timeout the route must wait for it.
  it.each(["3000000000", "1e10"])("CHANNELS_TIMEOUT_MS=%s (a long wait) still waits for Channels' confirmed answer", async (ms) => {
    walletOnChain();
    vi.stubEnv("CHANNELS_TIMEOUT_MS", ms);
    const confirmed = fakeChannels.reply;
    fakeChannels.reply = (rq, rs) => void setTimeout(() => confirmed(rq, rs), 400);
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(req(transfer()));
    const body = (await r.json()) as { success: boolean; error?: string };
    expect(body).toMatchObject({ success: true });
  });
});

// decisions.md 2026-11-26 (r3b row): a refusal may say "nothing was sent" only for
// codes raised before sending; WAIT_TIMEOUT ("It may still submit") and anything
// unknown must tell the user to check before trying again. Wallet creation goes
// through SDF's proxy, which forwards Channels' answers, and a retry makes the
// kit create a second passkey and wallet.
describe("adv r3e: wallet creation through the proxy when the outcome is unknown", () => {
  it.each([
    ["a proxy error with code WAIT_TIMEOUT (Channels: 'It may still submit')", () => new Response(JSON.stringify({ success: false, error: "Transaction wait timeout. It may still submit.", data: { code: "WAIT_TIMEOUT" } }), { status: 500 })],
  ])("%s is not reported as a refusal that invites a retry", async (_name, upstream) => {
    walletOnChain();
    vi.stubGlobal("fetch", vi.fn(async () => upstream()));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(req(walletDeploy()));
    const body = (await r.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).not.toMatch(/refused/i);
    expect(body.error).toMatch(/check/i);
  });

  it("the proxy accepted the request but the answer timed out: the user is told to check, not that it 'could not be reached'", async () => {
    walletOnChain();
    vi.stubGlobal("fetch", vi.fn(async () => {
      const res = new Response("x", { status: 200 });
      vi.spyOn(res, "text").mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
      return res;
    }));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(req(walletDeploy()));
    const body = (await r.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/check/i);
  });
});
