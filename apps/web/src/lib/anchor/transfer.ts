// Sending the USDC to the anchor from the passkey wallet.
//
// A Soroban transaction has no memo, so the anchor's memo id travels inside a
// muxed (M...) destination: the SAC USDC `transfer(from, to, amount)` accepts a
// muxed `to` (CAP-67) and the anchor reads the id back. Proven live on testnet
// 2026-11-27 (docs/research/anchor-spike-2026-11-27.md). A text or hash memo
// cannot be carried this way, so it is refused before anything is signed.

import { Account, Address, MuxedAccount, Operation, StrKey, TransactionBuilder, contract, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { NETWORK, TOKENS } from "../stellar/config";
import { fromStroops, toStroops } from "./amount";
import { CASHOUT_ASSET } from "./config";
import { AnchorError, RequestTimeout, within } from "./errors";
import type { AnchorTxn } from "./sep24";

const U64_MAX = BigInt("18446744073709551615");

export type AnchorPayment = {
  /** The anchor's classic account with the memo id inside it (M...). */
  destination: string;
  stroops: bigint;
};

/**
 * What the anchor asked for, checked against what the person confirmed.
 * Throws, before anything is signed, if the anchor's request is not exactly
 * a USDC payment of the confirmed amount to a classic account with an id memo.
 */
export function paymentFor(txn: AnchorTxn, confirmed: bigint): AnchorPayment {
  if (txn.status !== "pending_user_transfer_start") {
    throw new AnchorError("The anchor is not asking for USDC right now, so nothing was sent.", "send");
  }
  const account = txn.withdrawAnchorAccount;
  if (!account || !StrKey.isValidEd25519PublicKey(account)) {
    throw new AnchorError("The anchor did not give a valid account to pay, so nothing was sent.", "send");
  }
  if (txn.withdrawMemoType !== "id" || !txn.withdrawMemo || !/^[0-9]{1,20}$/.test(txn.withdrawMemo) || BigInt(txn.withdrawMemo) > U64_MAX) {
    throw new AnchorError(
      "The anchor asked for a memo type a smart wallet cannot send (a Soroban payment carries only a numeric id inside the destination). Nothing was sent.",
      "send",
    );
  }
  // The withdraw was started for Circle testnet USDC; a record that names any other asset is not paid in it.
  if (txn.amountInAsset != null && txn.amountInAsset !== CASHOUT_ASSET.id) {
    throw new AnchorError(`The anchor asks to be paid in ${txn.amountInAsset}, not Circle testnet USDC. Nothing was sent.`, "send");
  }
  const quoted = txn.amountIn ? toStroops(txn.amountIn) : null;
  if (quoted === null || quoted === BigInt(0)) throw new AnchorError("The anchor did not say how much USDC to send, so nothing was sent.", "send");
  if (quoted !== confirmed) {
    throw new AnchorError(
      `The anchor's form asks for ${fromStroops(quoted)} USDC, not the ${fromStroops(confirmed)} USDC you chose. Nothing was sent. Start again and keep the amount the same.`,
      "send",
    );
  }
  const destination = new MuxedAccount(new Account(account, "0"), txn.withdrawMemo).accountId();
  return { destination, stroops: quoted };
}

/** USDC `transfer(wallet, destination, amount)` as the host function the wallet authorises. */
export function transferHostFunction(wallet: string, payment: AnchorPayment): xdr.HostFunction {
  return xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(TOKENS.usdc).toScAddress(),
      functionName: "transfer",
      args: [
        xdr.ScVal.scvAddress(Address.fromString(wallet).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(payment.destination).toScAddress()),
        nativeToScVal(payment.stroops, { type: "i128" }),
      ],
    }),
  );
}

/**
 * The transfer as an assembled transaction, ready for the kit's signAndSubmit
 * (which asks for the passkey and sends it through Caracal's relay, which pays
 * the fee). Mirrors the kit's own direct-transfer builder; the kit's `transfer`
 * refuses an M address, which is why this exists.
 */
export async function buildAnchorTransfer(wallet: string, payment: AnchorPayment, server: rpc.Server): Promise<contract.AssembledTransaction<unknown>> {
  let tx: contract.AssembledTransaction<unknown>;
  try {
    // Building simulates on the network; nothing is signed or sent until it returns, so giving up on it sends nothing.
    tx = await within(
      contract.AssembledTransaction.buildWithOp(Operation.invokeHostFunction({ func: transferHostFunction(wallet, payment), auth: [] }), {
        contractId: TOKENS.usdc,
        networkPassphrase: NETWORK.passphrase,
        rpcUrl: server.serverURL.toString(),
        server,
        timeoutInSeconds: 60,
        method: "transfer",
        parseResultXdr: (value: xdr.ScVal) => value,
      }),
    );
  } catch (e) {
    if (e instanceof RequestTimeout) throw new AnchorError("The Stellar network did not answer within 20 seconds while Caracal prepared the USDC payment, so nothing was sent. Try again.", "send");
    throw e;
  }
  const sim = tx.simulation;
  if (sim && rpc.Api.isSimulationError(sim)) {
    // The balance is named as the cause only when it is read and short of the payment.
    const balance = await readUsdcBalance(wallet, server);
    const short = balance !== null && balance < payment.stroops ? ` Your wallet holds ${fromStroops(balance)} USDC, less than the ${fromStroops(payment.stroops)} USDC to send.` : "";
    throw new AnchorError(`The network rejected the USDC payment before it was signed, so nothing was sent.${short || " Try again; if it happens again, start a new cash-out."}`, "send");
  }
  return tx;
}

/** The wallet's USDC balance in stroops, or null if the network could not say. Read-only. */
/** `at` is told the ledger the balance was read at, when the RPC says (a payment's hold needs a read past its closeBy). */
export async function readUsdcBalance(wallet: string, server: rpc.Server, at?: (ledger: number) => void): Promise<bigint | null> {
  try {
    const source = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0");
    const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: NETWORK.passphrase })
      .addOperation(
        Operation.invokeHostFunction({
          func: xdr.HostFunction.hostFunctionTypeInvokeContract(
            new xdr.InvokeContractArgs({
              contractAddress: Address.fromString(TOKENS.usdc).toScAddress(),
              functionName: "balance",
              args: [xdr.ScVal.scvAddress(Address.fromString(wallet).toScAddress())],
            }),
          ),
          auth: [],
        }),
      )
      .setTimeout(30)
      .build();
    const sim = await within(server.simulateTransaction(tx));
    if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
    const v = scValToNative(sim.result.retval);
    if (typeof v !== "bigint") return null;
    const l = (sim as { latestLedger?: unknown }).latestLedger;
    if (typeof l === "number" && Number.isSafeInteger(l) && l > 0) at?.(l);
    return v;
  } catch {
    return null;
  }
}
