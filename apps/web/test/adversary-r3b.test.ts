// Adversary r3b: attacks on the relay route's setup paths and what it tells the user.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";
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

function transferBody() {
  const call = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(call).toXDR("base64"),
    auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call))],
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

describe("adv r3b relay answers", () => {
  // Real Channels wording, from @openzeppelin/relayer-plugin-channels 0.21.1 dist/plugin/submit.js:
  // after it has submitted the transaction, a confirmation wait that runs out throws
  // pluginError("Transaction wait timeout. It may still submit.", { code: "WAIT_TIMEOUT", status: 504, details: { id, hash } }).
  it("Channels' WAIT_TIMEOUT (submitted, outcome unknown) is not reported as a refusal; the user is told to check before retrying", async () => {
    walletOnChain();
    fakeChannels.reply = (_req, res) => {
      res.writeHead(504, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "Transaction wait timeout. It may still submit.", data: { code: "WAIT_TIMEOUT", details: { id: "tx-1", hash: "ab".repeat(32) } } }));
    };
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transferBody()) }));
    const j = (await r.json()) as { success: boolean; error: string };
    expect(j.success).toBe(false);
    expect(j.error).not.toMatch(/refused/i);
    expect(j.error).toMatch(/check your activity/i);
  });
});
