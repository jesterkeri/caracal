// Reads a deployed contract's instance entry via Soroban RPC: which wasm it
// runs and its instance storage. Small in-memory cache. Server only.

import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import type { InstanceLookup, WasmLookup } from "./policy";

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 5_000;

type Info = { hash: string | null; storage: xdr.ScMapEntry[] | null };

export function rpcContractLookup(rpcUrl: string): { wasm: WasmLookup; instance: InstanceLookup } {
  // Built on first use, so a misconfigured URL refuses lookups (503 at the
  // route) instead of crashing the module at import.
  let server: rpc.Server | null = null;
  const rpcServer = () => (server ??= new rpc.Server(rpcUrl, { allowHttp: isLoopback(rpcUrl) }));
  const cache = new Map<string, { info: Info; at: number }>();

  async function info(contractId: string): Promise<Info> {
    const hit = cache.get(contractId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.info;

    const key = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: Address.fromString(contractId).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
    const res = await rpcServer().getLedgerEntries(key);
    const result: Info = { hash: null, storage: null };
    const entry = res.entries[0];
    if (entry) {
      const instance = entry.val.contractData().val().instance();
      const exe = instance.executable();
      if (exe.switch().name === "contractExecutableWasm") result.hash = exe.wasmHash().toString("hex");
      result.storage = instance.storage() ?? [];
    }
    // Only cache contracts that exist. A wallet or split looked up a moment
    // before its deploy lands must be found on the next request, not refused
    // for the rest of the TTL.
    if (result.hash !== null || result.storage !== null) {
      if (cache.size >= MAX_ENTRIES) cache.clear();
      cache.set(contractId, { info: result, at: Date.now() });
    }
    return result;
  }

  return {
    wasm: async (id) => (await info(id)).hash,
    instance: async (id) => (await info(id)).storage,
  };
}

/** Plain http is allowed only for an RPC on this machine (a local quickstart). */
function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Kept for callers that only need the wasm hash. */
export const rpcWasmLookup = (rpcUrl: string): WasmLookup => rpcContractLookup(rpcUrl).wasm;
