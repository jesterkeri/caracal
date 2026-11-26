// The relay server's own configuration, as every test sees it: a fresh random
// testnet keypair as the relay's source account (generated here, never a real
// secret), a test Channels key, and the chain's answers for that account and
// for simulation. The simulated footprint is the one a passkey wallet's USDC
// transfer really loads: the account wasm and the WebAuthn verifier wasm (USDC
// is a built-in asset contract with no wasm). Tests that need other chain
// answers override these spies.
import { Account, Keypair, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { beforeEach, vi } from "vitest";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";

export const codeKey = (hash: string) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(hash, "hex") }));

/** A successful simulation whose footprint loads exactly these wasm hashes. */
export function simulated(code: string[], minResourceFee = "120000"): rpc.Api.SimulateTransactionSuccessResponse {
  return {
    _parsed: true,
    id: "sim",
    latestLedger: 1_000_000,
    events: [],
    minResourceFee,
    transactionData: new SorobanDataBuilder().setReadOnly(code.map(codeKey)).setResourceFee(minResourceFee),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  } as rpc.Api.SimulateTransactionSuccessResponse;
}

beforeEach(() => {
  vi.stubEnv("RELAY_SOURCE_SECRET", Keypair.random().secret());
  vi.stubEnv("CHANNELS_API_KEY", "test-channels-key");
  vi.spyOn(rpc.Server.prototype, "getAccount").mockImplementation(async (id: string) => new Account(id, "1000"));
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () =>
    simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]),
  );
});
