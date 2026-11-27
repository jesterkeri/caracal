// Adversary i2: when the fee relay clearly refuses an invoice call (it ran its
// own simulation and the contract said no, or Channels says the transaction
// failed on chain and changed nothing), the pay page and the invoices page tell
// the person "could not confirm whether the payment went through ... may have
// gone through", and make them wait on "Check again". Nothing was sent.
//
// Spec: apps/web/src/lib/invoices/chain.ts WriteOutcome ("not-sent: it failed
// before any transaction left (... or the relay said so)"; "failed: reached the
// chain and failed there. Nothing moved"; "unknown: the answer was lost or
// unclear"), and docs/decisions.md 2026-11-26 (r4j row): "Every relay refusal
// made before anything is sent upstream says 'Nothing was sent' ..., since that
// phrase is the only part of the answer the wallet kit hands on to the page.
// Policy and build refusals add it for deployments only; calls keep the
// policy's own wording". For a CALL, sendCall (chain.ts, last branch) can then
// only recognise a pre-send refusal by that phrase or a kit code, and the
// kit's relayer path gives a plain SubmissionError (5003) with no code, so
// every refusal of a call that lacks the phrase becomes "unknown".
//
// The real route (src/app/api/relay/route.ts) and the real smart-account-kit
// 0.10.0 RelayerClient and sendAndPoll run here; only the chain and Channels
// are local fakes.
import { Address, Account, Networks, Operation, TransactionBuilder, contract, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { SmartAccountKit } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { payInvoice } from "../src/lib/invoices/chain";
import { SMART_ACCOUNT, SPLIT, TOKENS } from "../src/lib/stellar/config";
import { SPLIT_ID, WALLET, splitStorage } from "./relay-fixtures";
import { fakeChannels } from "./setup-relay-server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const REF = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
const i128 = (n: number) => nativeToScVal(BigInt(n), { type: "i128" });
const addr = (a: string) => nativeToScVal(Address.fromString(a));

/** The payer's signed deposit, shaped as the kit posts it: deposit(from, amount, ref) with the USDC transfer under it. */
function depositCall() {
  const transfer = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(TOKENS.usdc).toScAddress(), functionName: "transfer", args: [addr(WALLET), addr(SPLIT_ID), i128(500000)] });
  const deposit = new xdr.InvokeContractArgs({ contractAddress: Address.fromString(SPLIT_ID).toScAddress(), functionName: "deposit", args: [addr(WALLET), i128(500000), xdr.ScVal.scvBytes(REF)] });
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(deposit);
  const auth = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("9"), signatureExpirationLedger: 1000, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(deposit),
      subInvocations: [
        new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(transfer), subInvocations: [] }),
      ],
    }),
  });
  return { func, auth };
}

/** The chain as the relay's policy reads it: the payer's wallet, and a Caracal split owned by a wallet. */
function chainKnowsWalletAndSplit() {
  const instance = (id: string, wasm: string, storage: xdr.ScMapEntry[] | null) =>
    xdr.LedgerEntryData.contractData(
      new xdr.ContractDataEntry({
        ext: new xdr.ExtensionPoint(0),
        contract: Address.fromString(id).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
        val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasm, "hex")), storage })),
      }),
    );
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (...keys: xdr.LedgerKey[]) => {
    const id = Address.fromScAddress(keys[0]!.contractData().contract()).toString();
    if (id === WALLET) return { entries: [{ val: instance(WALLET, SMART_ACCOUNT.accountWasmHash, null) }] };
    if (id === SPLIT_ID) return { entries: [{ val: instance(SPLIT_ID, SPLIT.wasmHash, splitStorage(WALLET)) }] };
    return { entries: [] };
  }) as never);
}

/** A kit whose own relayer client posts to the real route, and a Submitter that sends the signed deposit through the kit's real sendAndPoll. */
async function submitterThroughRealRoute() {
  chainKnowsWalletAndSplit();
  const { POST } = await import("../src/app/api/relay/route");
  const answers: { status: number; error?: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const res = await POST(new Request("http://x/api/relay", { method: "POST", body: init.body as string }));
    const copy = res.clone();
    answers.push({ status: res.status, error: ((await copy.json()) as { error?: string }).error });
    return res;
  });
  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://relay.test/api/relay",
    horizonUrl: false,
  });
  const { func, auth } = depositCall();
  const prepared = new TransactionBuilder(new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.invokeHostFunction({ func, auth: [auth] }))
    .setTimeout(30)
    .build();
  // sendCall builds (simulates) first; that needs no network here.
  vi.spyOn(contract.AssembledTransaction, "build").mockResolvedValue({ simulation: undefined } as never);
  return { kit: { rpc: kit.rpc, signAndSubmit: async () => (kit as unknown as { sendAndPoll(tx: unknown): Promise<unknown> }).sendAndPoll(prepared) } as never, answers };
}

const refuseInSimulation = () =>
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation(async () => ({
    _parsed: true,
    id: "sim",
    latestLedger: 1_000_000,
    events: [],
    error: `HostError: Error(Contract, #6)\n\nEvent log (newest first):\n 0: [Diagnostic Event] contract:${SPLIT_ID}, topics:[error, Error(Contract, #6)]`,
  }) as never);

describe("a refusal by the relay, as the pay page and the invoices page see it", () => {
  it("control: a Channels refusal that says 'Nothing was sent' is not-sent", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "x", data: { code: "INVALID_PARAMS" } }));
    };
    const { kit, answers } = await submitterThroughRealRoute();
    const out = await payInvoice(kit, SPLIT_ID, WALLET, BigInt(500000), REF.toString("hex"));
    expect(answers[0]?.error).toMatch(/Nothing was sent/);
    expect(out).toMatchObject({ kind: "not-sent" });
  });

  it("the relay's own simulation refuses the deposit (say the invoice was paid a moment ago): that is not 'unknown'", async () => {
    refuseInSimulation();
    const { kit, answers } = await submitterThroughRealRoute();
    const out = await payInvoice(kit, SPLIT_ID, WALLET, BigInt(500000), REF.toString("hex"));
    // The route refused before building or sending anything.
    expect(answers).toHaveLength(1);
    expect(answers[0]!.status).toBe(400);
    expect(answers[0]!.error).toMatch(/refused this call in simulation/);
    expect(fakeChannels.requests).toHaveLength(0);
    // So the page must not say the payment may have gone through.
    expect(out.kind).not.toBe("unknown");
  });

  it("Channels reports the transaction failed on chain and changed nothing: that is not 'unknown' either", async () => {
    fakeChannels.reply = (_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: false, error: "x", data: { code: "ONCHAIN_FAILED" } }));
    };
    const { kit, answers } = await submitterThroughRealRoute();
    const out = await payInvoice(kit, SPLIT_ID, WALLET, BigInt(500000), REF.toString("hex"));
    expect(answers[0]?.error).toBe("This transaction failed on the network (ONCHAIN_FAILED), so nothing changed.");
    expect(out.kind).not.toBe("unknown");
  });
});
