// Adversary r3g: documented setup paths on the payment route.
import { Address, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, transferArgs } from "./relay-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const call = () =>
  new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: transferArgs(WALLET, SPLIT_ID) });
const transfer = () => ({
  func: xdr.HostFunction.hostFunctionTypeInvokeContract(call()).toXDR("base64"),
  auth: [
    new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call()), subInvocations: [] }),
    }).toXDR("base64"),
  ],
});

describe("adv r3g: an unusable RPC URL gives the documented 'not set up' answer on a payment, not 'try again'", () => {
  it("NEXT_PUBLIC_STELLAR_RPC_URL=http://rpc.example.com (plain http, not local) on a USDC transfer", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_RPC_URL", "http://rpc.example.com");
    vi.resetModules(); // config is already loaded by this file's imports; reload it with the stubbed URL
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}")));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(transfer()) }));
    const body = (await r.json()) as { success: boolean; error?: string };
    expect(r.status).toBe(503);
    expect(body.error).toMatch(/not set up/i);
  });
});

// decisions.md 2026-11-26 (r3e row): wallet creation through SDF's proxy says
// "outcome unknown, reload and check with Connect before creating another" for
// every answer that does not prove a refusal before sending. A retry makes the
// kit create a second passkey and an orphan wallet. The proxy is a CDN-fronted
// worker, so a gateway timeout page can arrive after it already submitted.
import { rpc } from "@stellar/stellar-sdk";
import { SHARED_DEPLOYER, walletCtorArgs } from "./relay-fixtures";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";

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

describe("adv r3g: wallet creation, proxy answer that cannot be read", () => {
  it.each([
    ["a CDN 504 HTML page", () => new Response("<html><body>504 Gateway Time-out</body></html>", { status: 504, headers: { "Content-Type": "text/html" } })],
    ["a 200 with an empty body", () => new Response("", { status: 200 })],
    ["a 200 with text that is not JSON", () => new Response("ok", { status: 200 })],
  ])("%s tells the person to check with Connect first, not to try again", async (_name, upstream) => {
    vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [] })) as never);
    vi.stubGlobal("fetch", vi.fn(async () => upstream()));
    const { POST } = await import("../src/app/api/relay/route");
    const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(walletDeploy()) }));
    const body = (await r.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Connect/);
    expect(body.error).not.toMatch(/try again/i);
  });
});
