// Reads a deployed contract's instance entry via Soroban RPC: which wasm it
// runs and its instance storage. Small in-memory cache. Server only.
//
// The cache feeds the policy's first, cheap filter. It is not the final word
// on what code runs: a wallet can be upgraded after it is cached, so the relay
// also checks the wasm in the simulated footprint and pins that footprint in
// the signed transaction (sponsor.ts).

import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { ContractNotFound, type InstanceLookup, type WasmLookup } from "./policy";
import { RPC_TIMEOUT_MS, within } from "./sponsor";

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
    const res = await within(rpcServer().getLedgerEntries(key), RPC_TIMEOUT_MS, "getLedgerEntries");
    const entry = res.entries[0];
    // No entry: a wrong address, another network, or an archived entry the RPC
    // does not return. Not cached, so a wallet or split looked up a moment
    // before its deploy lands is found on the next request.
    if (!entry) throw new ContractNotFound(contractId);
    // An entry past its live-until ledger (archived but still returned) keeps
    // its wasm: the policy checks it as usual, and the simulation then asks for
    // the restore (sponsor.ts answers 409 for that).
    const instance = entry.val.contractData().val().instance();
    const exe = instance.executable();
    const result: Info = {
      hash: exe.switch().name === "contractExecutableWasm" ? exe.wasmHash().toString("hex") : null,
      storage: instance.storage() ?? [],
    };
    if (cache.size >= MAX_ENTRIES) cache.clear();
    cache.set(contractId, { info: result, at: Date.now() });
    return result;
  }

  return {
    wasm: async (id) => (await info(id)).hash,
    instance: async (id) => (await info(id)).storage,
  };
}

/** Plain http is allowed only for an RPC on this machine (a local quickstart). */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/** Kept for callers that only need the wasm hash. */
export const rpcWasmLookup = (rpcUrl: string): WasmLookup => rpcContractLookup(rpcUrl).wasm;
