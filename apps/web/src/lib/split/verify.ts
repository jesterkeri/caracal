// Which code a split contract runs, read from its instance entry on the network.
// Anyone can deploy a different contract, or a split over another token, at an
// address outside Caracal's sponsored relay, so the page checks the code and the
// token before it shows a balance as USDC or offers an action.

import { Address, xdr } from "@stellar/stellar-sdk";
// Imported, not the global: a browser bundle has no global Buffer, and without it every split read as unchecked (Codex split R2 #2).
import { Buffer } from "buffer";
import { READ_TIMEOUT_MS } from "./chain";

/**
 * wasm: the instance runs this wasm (hex of its hash).
 * other: the instance is not a wasm contract (for example a built-in token).
 * absent: the network returned no instance entry.
 * unchecked: the lookup failed, timed out or returned something unreadable. This is never a pass.
 */
export type InstanceCode = { kind: "wasm"; hash: string } | { kind: "other" } | { kind: "absent" } | { kind: "unchecked" };

/** The part of a stellar-sdk rpc.Server used here. */
export type EntryReader = { getLedgerEntries(...keys: xdr.LedgerKey[]): Promise<{ entries: { val?: xdr.LedgerEntryData }[] }> };

export async function readInstanceCode(server: EntryReader | undefined, contractId: string): Promise<InstanceCode> {
  if (!server || typeof server.getLedgerEntries !== "function") return { kind: "unchecked" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const answer = await Promise.race([
      server.getLedgerEntries(key),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), READ_TIMEOUT_MS);
      }),
    ]);
    if (!answer || !Array.isArray(answer.entries)) return { kind: "unchecked" };
    if (answer.entries.length === 0) return { kind: "absent" };
    const val = answer.entries[0]?.val;
    if (!val) return { kind: "unchecked" };
    const exe = val.contractData().val().instance().executable();
    return exe.switch().name === "contractExecutableWasm" ? { kind: "wasm", hash: Buffer.from(exe.wasmHash()).toString("hex") } : { kind: "other" };
  } catch {
    return { kind: "unchecked" };
  } finally {
    clearTimeout(timer);
  }
}
