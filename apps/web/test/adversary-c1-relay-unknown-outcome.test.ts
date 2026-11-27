// Adversary c1: the cash-out page's USDC payment goes through the REAL smart-account-kit
// signAndSubmit and its real relayer client, to the REAL /api/relay route (OpenZeppelin
// Channels is the local fake from setup-relay-server.ts). Only the passkey step and the
// final RPC poll are replaced.
//
// The relay's own answers say, in words, when a payment may have been sent
// ("Check your activity before trying again", src/lib/relay/channels.ts), and
// docs/decisions.md 2026-11-26 says that answer exists because "without a hash nobody can
// tell whether a payment happened". The page (src/lib/anchor/flow.ts sendToAnchor) reads
// only a hash or error code 5004, so it tells the person "Nothing left your wallet. Try
// again." and frees its once-only lock: a second USDC payment is one click away.
import { readFileSync } from "node:fs";
import { Account, Address, Keypair, Networks, Operation, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TWO = BigInt(20_000_000);
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

function walletOnChain() {
  const inst = new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null });
  const data = new xdr.ContractDataEntry({
    ext: new xdr.ExtensionPoint(0),
    contract: Address.fromString(WALLET).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
    val: xdr.ScVal.scvContractInstance(inst),
  });
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async () => ({ entries: [{ val: xdr.LedgerEntryData.contractData(data) }] })) as never);
}

/** The real kit, wired to the real relay route in-process; only the passkey step is replaced. */
async function realKit() {
  walletOnChain();
  const { POST } = await import("../src/app/api/relay/route");
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => POST(new Request("http://x/api/relay", init)));
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://x/api/relay",
    storage: new MemoryStorage(),
    rpName: "Caracal",
  });
  (kit as unknown as { _contractId: string })._contractId = WALLET;
  return kit;
}

/** What the page hands signAndSubmit, built from the page's own code (paymentFor, transferHostFunction). */
function assembled() {
  const call = transferHostFunction(WALLET, paymentFor(waiting, TWO));
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call.invokeContract()), subInvocations: [] }),
  });
  const built = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeHostFunction({ func: call, auth: [entry] }))
    .setTimeout(30)
    .build();
  return { built, simulationData: { result: { auth: [entry] } } };
}

async function pay(rpcStub?: unknown) {
  const kit = await realKit();
  const tx = assembled();
  // The passkey step only: sign nothing, hand the same host function and entry on.
  (kit as unknown as { signResimulateAndPrepare: unknown }).signResimulateAndPrepare = async () => tx.built;
  if (rpcStub) (kit as unknown as { rpc: unknown }).rpc = rpcStub;
  const deps: SendDeps = { buildTransfer: async () => tx, signAndSubmit: (t) => kit.signAndSubmit(t as never) };
  return sendToAnchor(waiting, TWO, deps);
}

describe("adversary c1: a payment whose outcome is unknown", () => {
  it("control: a confirmed relay answer is a sent payment (the harness works)", async () => {
    const r = await pay({ pollTransaction: async () => ({ status: "SUCCESS", ledger: 5 }) });
    expect(r).toEqual({ kind: "sent", hash: "ab".repeat(32) });
  });

  it("the relay says 'Check your activity before trying again' (Channels never answered): the page must not say nothing left the wallet", async () => {
    fakeChannels.reply = (req) => req.socket.destroy(); // the connection drops after Channels received the transaction
    const r = await pay();
    expect(fakeChannels.requests.length).toBeGreaterThan(0); // the transaction did reach Channels
    expect(r.kind).not.toBe("not-sent");
  });

  it("the relay confirmed the payment, then the RPC poll failed: money left, the page must not say it did not", async () => {
    const r = await pay({
      pollTransaction: async () => {
        throw new Error("fetch failed");
      },
    });
    expect(fakeChannels.requests.length).toBe(1); // the relay did submit it
    expect(r.kind).not.toBe("not-sent");
  });
});
