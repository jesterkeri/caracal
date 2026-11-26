// Follow-ups to adversary r4a's unproven suspicions:
// - the relay's fee account cannot be loaded (stellar-sdk reports an unfunded
//   account and an unreachable RPC alike as "Account not found"): the answer
//   must not claim only one cause, and must say nothing was sent;
// - the server Supabase client (the /auth/callback code exchange) uses the
//   same request deadline as the browser client.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("next/headers");
  vi.doUnmock("@supabase/ssr");
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

describe("r4a follow-up: the relay's fee account cannot be loaded", () => {
  it("names both possible causes and says nothing was sent", async () => {
    walletOnChain();
    // What stellar-sdk's getAccount throws for any failure.
    vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => {
      throw new Error(`Account not found: ${id}`);
    });
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
    expect(r.status).toBe(503);
    const { error } = (await r.json()) as { error: string };
    expect(error).toMatch(/could not be reached/);
    expect(error).toMatch(/RELAY_SOURCE_SECRET/);
    expect(error).toMatch(/Nothing was sent/);
  });
});

describe("r4a follow-up: the server Supabase client has the request deadline", () => {
  it("passes fetchWithTimeout as its fetch", async () => {
    let options: { global?: { fetch?: unknown } } | undefined;
    vi.doMock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
    vi.doMock("@supabase/ssr", () => ({
      createServerClient: (_u: string, _k: string, o: typeof options) => {
        options = o;
        return {};
      },
    }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test-key");
    const { supabaseServer } = await import("../src/lib/supabase/server");
    const { fetchWithTimeout } = await import("../src/lib/supabase/deadline");
    await supabaseServer();
    expect(options?.global?.fetch).toBe(fetchWithTimeout);
  });
});
