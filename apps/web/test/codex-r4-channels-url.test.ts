// Codex R4 note: a CHANNELS_BASE_URL that is not a usable URL surfaced as the
// Channels client's own unclear error. The relay now names the setting.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
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
function transfer() {
  const c = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c), subInvocations: [] }),
  });
  return { func: xdr.HostFunction.hostFunctionTypeInvokeContract(c).toXDR("base64"), auth: [auth.toXDR("base64")] };
}

describe("codex r4: CHANNELS_BASE_URL checked locally", () => {
  it.each(["channels.openzeppelin.com/testnet", "http://channels.example.com/testnet", "ftp://channels.example.com"])("%s: a 503 naming the setting, nothing sent", async (url) => {
    walletOnChain();
    vi.stubEnv("CHANNELS_BASE_URL", url);
    const before = fakeChannels.requests.length;
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toMatch(/CHANNELS_BASE_URL/);
    expect(fakeChannels.requests.length).toBe(before);
  });

  it("a loopback http URL (the local fake) is still used", async () => {
    walletOnChain();
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
    expect(r.status).toBe(200);
  });
});
