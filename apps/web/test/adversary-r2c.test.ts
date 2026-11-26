import { describe, expect, it, vi } from "vitest";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { ContractNotFound } from "../src/lib/relay/policy";
import { rpcContractLookup } from "../src/lib/relay/wasm-lookup";
import { checkPayload } from "../src/lib/relay/policy";
import { CARACAL_POLICY } from "../src/lib/relay/caracal-policy";
import { SMART_ACCOUNT, SPLIT } from "../src/lib/stellar/config";
import { GET as rootGet } from "../src/app/route";
import { WALLET, SPLIT_ID, addr, depositArgs } from "./relay-fixtures";

function instanceEntry(contractId: string, hash: string) {
  const inst = new xdr.ScContractInstance({
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(hash, "hex")),
    storage: null,
  });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(contractId).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  return { val: xdr.LedgerEntryData.contractData(data) };
}

describe("adv r2c relay", () => {
  it("a contract looked up before it exists is not refused for 10 minutes after it is deployed (negative result cached)", async () => {
    let deployed = false;
    const spy = vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({
      entries: deployed ? [instanceEntry(WALLET, SMART_ACCOUNT.accountWasmHash)] : [],
    })) as never);
    const { wasm } = rpcContractLookup("https://rpc.invalid");
    // Not deployed yet. Since Codex R4 #4 a missing entry is ContractNotFound, not a null wasm.
    await expect(wasm(WALLET)).rejects.toBeInstanceOf(ContractNotFound);
    deployed = true; // the genuine wallet deploy lands
    expect(await wasm(WALLET)).toBe(SMART_ACCOUNT.accountWasmHash);
    spy.mockRestore();
  });
});

describe("adv r2c signin", () => {
  it("root route shows an upstream error even when error_description is empty", () => {
    const r = rootGet(new Request("https://caracal.test/?error=access_denied&error_description="));
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBeTruthy();
  });
  it("root route never redirects off-site", () => {
    const r = rootGet(new Request("https://caracal.test//evil.com/?error=x"));
    expect(new URL(r.headers.get("location")!).origin).toBe("https://caracal.test");
  });
});
