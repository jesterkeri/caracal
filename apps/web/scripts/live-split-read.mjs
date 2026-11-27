// Usage (from apps/web):
//   node scripts/live-split-read.mjs [split contract address]
// Live read of a split contract on Stellar testnet, the same two simulations the
// /split page makes: balances() (the three pots) and config() (owner, token,
// tax and goal basis points). Read-only: nothing is signed or sent. Prints the
// decoded answers and the raw base64 return values, which the tests keep as
// fixtures captured from the real network.
import { Account, BASE_FEE, Address, Operation, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const PASS = "Test SDF Network ; September 2015";
const SPLIT = process.argv[2] ?? "CAQ6XR26TUJLHT7W2IRCYN3YRDI52FHV6D7FHJ47SH7FMWM5DKKEXV6M";
const server = new rpc.Server("https://soroban-testnet.stellar.org");

async function read(fn) {
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({ contractAddress: Address.fromString(SPLIT).toScAddress(), functionName: fn, args: [] }));
  const tx = new TransactionBuilder(new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"), { fee: BASE_FEE, networkPassphrase: PASS })
    .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${fn}(): ${sim.error}`);
  const retval = sim.result.retval;
  console.log(fn, scValToNative(retval), "retval", retval.toXDR("base64"));
}

console.log("split", SPLIT);
await read("balances");
await read("config");
