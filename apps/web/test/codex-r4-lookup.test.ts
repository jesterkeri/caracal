// Codex R4 #4: a wallet whose instance entry the RPC does not return (archived,
// or a wrong network or address) was refused as "Only Caracal passkey wallets
// can sign", before the restore-aware simulation ran. A missing entry proves
// none of those causes, so it must not be reported as a wrong wasm, and an
// entry that is past its live-until ledger but still returned must reach the
// simulation, which asks for the restore.
import { Address, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_NOT_FOUND, ContractNotFound, WALLET_NOT_FOUND } from "../src/lib/relay/policy";
import { rpcContractLookup } from "../src/lib/relay/wasm-lookup";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { OLD_SPLIT_ID, SPLIT_ID, WALLET, splitStorage, transferArgs } from "./relay-fixtures";
import { simulated } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

const LATEST = 1_000_000;
type OnChain = { wasm: string; storage?: xdr.ScMapEntry[]; liveUntil: number };

/** The RPC's getLedgerEntries, answering per contract from `chain`; absent contracts have no entry. */
function ledger(chain: Record<string, OnChain>) {
  return vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: LATEST,
    entries: keys.flatMap((k) => {
      const id = Address.fromScAddress(k.contractData().contract()).toString();
      const c = chain[id];
      if (!c) return [];
      const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(c.wasm, "hex")), storage: c.storage ?? null });
      const data = new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: k.contractData().contract(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(inst),
      });
      return [{ key: k, val: xdr.LedgerEntryData.contractData(data), lastModifiedLedgerSeq: 1, liveUntilLedgerSeq: c.liveUntil }];
    }),
  })) as never);
}

const authBy = (signer: string, fn: xdr.SorobanAuthorizedFunction) =>
  new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(signer).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: fn, subInvocations: [] }),
  }).toXDR("base64");
function invoke(target: string, fn: string, args: xdr.ScVal[], signer = WALLET) {
  const c = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(target).toScAddress(), functionName: fn, args });
  return {
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(c).toXDR("base64"),
    auth: [authBy(signer, xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(c))],
  };
}
async function relay(body: unknown) {
  const { POST } = await import("../src/app/api/relay/route");
  const r = await POST(new Request("http://x/api/relay", { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, body: (await r.json()) as { success: boolean; error?: string } };
}

describe("codex r4 #4: a wallet the RPC does not return", () => {
  it("signing wallet with no instance entry: 409 that names no cause, not 'only Caracal wallets'", async () => {
    ledger({});
    const r = await relay(invoke(TOKENS.usdc, "transfer", transferArgs(WALLET, SPLIT_ID)));
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ success: false, error: WALLET_NOT_FOUND });
    expect(r.body.error).not.toMatch(/Only Caracal/);
  });

  it("signing wallet past its live-until ledger reaches the simulation, which asks for the restore", async () => {
    ledger({ [WALLET]: { wasm: SMART_ACCOUNT.accountWasmHash, liveUntil: LATEST - 10 } });
    const sim = vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => ({
      ...simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]),
      restorePreamble: { minResourceFee: "1000", transactionData: new SorobanDataBuilder() },
    }));
    const r = await relay(invoke(TOKENS.usdc, "transfer", transferArgs(WALLET, SPLIT_ID)));
    expect(sim).toHaveBeenCalledTimes(1);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/expired on the network and must be restored/);
  });

  it("a deployed contract running another wasm is still refused as not a Caracal wallet", async () => {
    ledger({ [WALLET]: { wasm: "aa".repeat(32), liveUntil: LATEST + 1000 } });
    const r = await relay(invoke(TOKENS.usdc, "transfer", transferArgs(WALLET, SPLIT_ID)));
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("Only Caracal passkey wallets can sign sponsored calls");
  });

  it("a call to a split contract the RPC does not return: 409 that names no cause", async () => {
    ledger({ [WALLET]: { wasm: SMART_ACCOUNT.accountWasmHash, liveUntil: LATEST + 1000 } });
    const r = await relay(invoke(SPLIT_ID, "withdraw", [xdr.ScVal.scvU32(0)]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(CONTRACT_NOT_FOUND);
  });

  it("a split whose owner wallet the RPC does not return: 409, not 'not owned by a Caracal wallet'", async () => {
    ledger({
      [WALLET]: { wasm: SMART_ACCOUNT.accountWasmHash, liveUntil: LATEST + 1000 },
      [SPLIT_ID]: { wasm: SPLIT.wasmHash, storage: splitStorage(OLD_SPLIT_ID), liveUntil: LATEST + 1000 },
    });
    const r = await relay(invoke(SPLIT_ID, "withdraw", [xdr.ScVal.scvU32(0)]));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe(WALLET_NOT_FOUND);
  });
});

describe("codex r4 #4: rpcContractLookup", () => {
  it("throws ContractNotFound for a missing entry and does not cache it", async () => {
    const chain: Record<string, OnChain> = {};
    ledger(chain);
    const { wasm } = rpcContractLookup("https://rpc.example");
    await expect(wasm(WALLET)).rejects.toBeInstanceOf(ContractNotFound);
    chain[WALLET] = { wasm: SMART_ACCOUNT.accountWasmHash, liveUntil: LATEST + 1000 };
    expect(await wasm(WALLET)).toBe(SMART_ACCOUNT.accountWasmHash);
  });

  it("returns the wasm of an entry past its live-until ledger", async () => {
    ledger({ [WALLET]: { wasm: SMART_ACCOUNT.accountWasmHash, liveUntil: 1 } });
    expect(await rpcContractLookup("https://rpc.example").wasm(WALLET)).toBe(SMART_ACCOUNT.accountWasmHash);
  });
});

// Hits the real testnet RPC. Run with CARACAL_NETWORK_TESTS=1.
describe.runIf(process.env.CARACAL_NETWORK_TESTS === "1")("codex r4 #4: rpcContractLookup on testnet", () => {
  it("a contract address with nothing deployed is ContractNotFound, not a null wasm", async () => {
    const { NETWORK } = await import("../src/lib/stellar/config");
    const nothing = Address.contract(Buffer.from(crypto.getRandomValues(new Uint8Array(32)))).toString();
    await expect(rpcContractLookup(NETWORK.rpcUrl).wasm(nothing)).rejects.toBeInstanceOf(ContractNotFound);
  }, 30_000);
});
