// Adversary r3a: attacks on the relay route and the sign-out path.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { signOutEverywhere, bindWallet, WALLET_OWNER_KEY } from "../src/lib/auth/wallet-binding";
import { SPLIT_ID, WALLET, splitCtorArgs, transferArgs } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.useRealTimers();
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

const transferBody = () => {
  const call = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(call).toXDR("base64"),
    auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call))],
  };
};
/** A passkey wallet deploying its own split contract (owner = that wallet). */
function walletDeploysSplit() {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(WALLET).toScAddress(), salt: Buffer.alloc(32, 5) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SPLIT.wasmHash, "hex")),
    constructorArgs: splitCtorArgs(WALLET),
  });
  return {
    func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"),
    auth: [authBy(WALLET, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args))],
  };
}

describe("relay: a chain call that never answers must not wedge the relay (goal: deadlock it)", () => {
  it("one hung simulation is answered or abandoned, and the next request still gets served", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"] });
    walletOnChain();
    const sim = vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(() => new Promise(() => {}) as never);
    const upstream = vi.fn(async () => ok());
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const req = () => new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transferBody()) });
    let first: Response | "pending" = "pending";
    void POST(req()).then((r) => (first = r));
    await vi.advanceTimersByTimeAsync(10 * 60_000); // ten minutes
    // The RPC (stellar-sdk default timeout is 0 = none) never answered. A relay
    // that bounds its chain calls has answered 503 by now.
    expect(sim).toHaveBeenCalledTimes(1); // the hang is inside the relay's one-at-a-time lock
    expect(first).not.toBe("pending");
  });
});

describe("relay: code pinning for every sponsored transaction (README: 'a wallet upgraded after the check cannot run new code in a sponsored transaction')", () => {
  it("a deployment authorised by a passkey wallet runs that wallet's __check_auth, so it must be pinned and signed by the relay, not forwarded as { func, auth }", async () => {
    walletOnChain();
    const upstream = vi.fn(async (_u: string, _i: RequestInit) => ok());
    vi.stubGlobal("fetch", upstream);
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploysSplit()) }));
    expect(r.status).toBe(200);
    // Forwarded to SDF's proxy as { func, auth }: the proxy re-simulates and loads whatever code the wallet runs at that moment.
    // Instead it must go out as the relay's own pinned, signed XDR (through the Channels client).
    expect(upstream).not.toHaveBeenCalled();
    expect(fakeChannels.requests).toHaveLength(1);
    expect(fakeChannels.requests[0]!.body).toHaveProperty("params.xdr");
  });
});

describe("sign-out must end the session even if the wallet cannot be disconnected", () => {
  it("kit.disconnect() rejects: the Supabase session is still ended", async () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
    bindWallet(store, "user-A");
    const endSession = vi.fn(async () => {});
    const kit = { disconnect: vi.fn(async () => { throw new Error("IndexedDB blocked"); }) };
    await signOutEverywhere(store, kit, endSession).catch(() => {});
    expect(endSession).toHaveBeenCalled();
    expect(store.getItem(WALLET_OWNER_KEY)).toBeNull();
  });
});
