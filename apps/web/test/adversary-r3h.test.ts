// Adversary r3h: wallet creation through SDF's proxy, an answer with no body.
//
// decisions.md 2026-11-26 (r3g row): "Every wallet-creation answer that does not
// prove a refusal before sending (including an unreadable one) asks the person
// to check with Connect first." An empty 204 proves no refusal, and the proxy
// may already have submitted. The route passes it on as a bare 204, which the
// wallet kit (relayer.js submit(): response.json() fails, success is false)
// turns into "Relayer request failed with status 204", with no instruction to
// check with Connect. A retry makes a second passkey and an orphan wallet.
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { SHARED_DEPLOYER, walletCtorArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function walletDeploy() {
  const args = new xdr.CreateContractArgsV2({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), salt: Buffer.alloc(32, 7) }),
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")),
    constructorArgs: walletCtorArgs(),
  });
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(SHARED_DEPLOYER).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractV2HostFn(args),
      subInvocations: [],
    }),
  }).toXDR("base64");
  return { func: xdr.HostFunction.hostFunctionTypeCreateContractV2(args).toXDR("base64"), auth: [entry] };
}

describe("adv r3h: wallet creation, proxy answers with no body", () => {
  it.each([204, 205, 304])("an upstream %s tells the person to check with Connect first", async (status) => {
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [] })) as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status })));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    const text = await r.text();
    let body: { success?: boolean; error?: string } = {};
    try {
      body = JSON.parse(text);
    } catch {
      // an empty body: the kit has nothing to show but its own "request failed"
    }
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Connect/);
    expect(body.error).not.toMatch(/try again/i);
  });
});
