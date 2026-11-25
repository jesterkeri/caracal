// Looks up which wasm a deployed contract runs, via Soroban RPC, with a small
// in-memory cache. Server only.

import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import type { WasmLookup } from "./policy";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5_000;

export function rpcWasmLookup(rpcUrl: string): WasmLookup {
  const server = new rpc.Server(rpcUrl);
  const cache = new Map<string, { hash: string | null; at: number }>();

  return async (contractId) => {
    const hit = cache.get(contractId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.hash;

    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await server.getLedgerEntries(key);
    let hash: string | null = null;
    const entry = res.entries[0];
    if (entry) {
      const exe = entry.val.contractData().val().instance().executable();
      if (exe.switch().name === "contractExecutableWasm") {
        hash = exe.wasmHash().toString("hex");
      }
    }
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(contractId, { hash, at: Date.now() });
    return hash;
  };
}
