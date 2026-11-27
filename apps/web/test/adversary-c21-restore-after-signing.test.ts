// Adversary c21: the wallet's own data (its instance, rules or the WebAuthn verifier) has expired on the
// network, but the USDC balance entry has not. The page's first simulation (recording mode, no signatures)
// never runs the wallet's __check_auth, so it sees no restore and c17's needsRestore() lets the payment go to
// the passkey. The signed re-simulation and Caracal's relay then ask for the restore (relay 409). The page
// says "The USDC payment was not sent. Nothing left your wallet. Try again.", which can never work (the relay
// does not pay for restores) and costs a passkey prompt each time. The cause the relay named is dropped.
//
// Spec: docs/decisions.md 2026-11-26 row "The relay tells a missing contract apart from a wrong one" (the
// relay answers 409 "has expired on the network and must be restored first" / "may need restoring" and "does
// not pay for restores yet") and 2026-11-27 row "Adversary c17" (a payment whose data has expired must say
// trying again will not help). Attacker goals 4 (a wrong cause) and 5 (a "Try again" that cannot work).
// Cause: src/lib/anchor/flow.ts sendToAnchor() only recognises a restore through needsRestore(tx) on the FIRST
// simulation; a relay 409 carrying "Nothing was sent" is mapped by provenNotSent() to the generic
// "was not sent ... Try again." text.
//
// Real: smart-account-kit 0.10.0's SmartAccountKit.signAndSubmit and its RelayerClient, stellar-sdk's
// AssembledTransaction, the page's paymentFor/buildAnchorTransfer/sendToAnchor, and Caracal's real relay
// route (src/app/api/relay/route.ts, its policy and sponsor). Faked: the passkey, and the chain's answers
// (rpc.Server.prototype spies, as in test/codex-r4-lookup.test.ts). The restore answers are constructed with
// the SDK's SorobanDataBuilder, not captured: no live archived wallet exists to record one from.
import { readFileSync } from "node:fs";
import { Address, Networks, SorobanDataBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { MemoryStorage, SmartAccountKit } from "smart-account-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToAnchor, type SendDeps } from "../src/lib/anchor/flow";
import { parseTransaction } from "../src/lib/anchor/sep24";
import { buildAnchorTransfer, paymentFor, transferHostFunction } from "../src/lib/anchor/transfer";
import { SMART_ACCOUNT } from "../src/lib/stellar/config";
import { WALLET } from "./relay-fixtures";
import { simulated } from "./setup-relay-server";

const TWO = BigInt(20_000_000);
const LATEST = 1_000_000;
const waiting = parseTransaction(JSON.parse(readFileSync(new URL("./fixtures/anchor/txn-pending-user-transfer-start.json", import.meta.url), "utf8")));

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** The wallet's auth entry as a recording simulation returns it: the wallet must authorise the USDC transfer. */
function recordedAuth(): xdr.SorobanAuthorizationEntry {
  const call = transferHostFunction(WALLET, paymentFor(waiting, TWO)).invokeContract();
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({ address: Address.fromString(WALLET).toScAddress(), nonce: xdr.Int64.fromString("77"), signatureExpirationLedger: 0, signature: xdr.ScVal.scvVoid() }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call), subInvocations: [] }),
  });
}

const accepted = () => ({ ...simulated([SMART_ACCOUNT.accountWasmHash, SMART_ACCOUNT.webauthnVerifierWasmHash]), result: { auth: [recordedAuth()], retval: xdr.ScVal.scvVoid() } });
const askForRestore = () => ({ ...accepted(), restorePreamble: { minResourceFee: "1000", transactionData: new SorobanDataBuilder() } });

/** The wallet's instance entry as the relay's lookup sees it (live, so the relay reaches its simulation). */
function walletOnChain() {
  vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockImplementation((async (...keys: xdr.LedgerKey[]) => ({
    latestLedger: LATEST,
    entries: keys.map((k) => ({
      key: k,
      val: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: k.contractData().contract(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
          val: xdr.ScVal.scvContractInstance(new xdr.ScContractInstance({ executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(SMART_ACCOUNT.accountWasmHash, "hex")), storage: null })),
        }),
      ),
      lastModifiedLedgerSeq: 1,
      liveUntilLedgerSeq: LATEST + 1000,
    })),
  })) as never);
}

/**
 * One cash-out payment through the real kit and the real relay route. `later` is what the chain answers to every
 * simulation after the page's own first one (the kit's signed re-simulation, then the relay's).
 */
async function pay(later: () => unknown, archived = false) {
  if (archived) vi.spyOn(rpc.Server.prototype, "getLedgerEntries").mockResolvedValue({ latestLedger: LATEST, entries: [] } as never); // the RPC returns no entry for an archived wallet
  else walletOnChain();
  let sims = 0;
  vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockImplementation((async () => (++sims === 1 ? accepted() : later())) as never);
  const polled = vi.spyOn(rpc.Server.prototype, "pollTransaction").mockResolvedValue({ status: "SUCCESS", ledger: 5 } as never);

  const kit = new SmartAccountKit({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://relay.test/api/relay",
    storage: new MemoryStorage(),
    rpName: "Caracal",
  });
  const k = kit as unknown as Record<string, unknown>;
  k._contractId = WALLET;
  const passkey = vi.fn(async (e: unknown) => e); // the passkey signature is not under test
  k.signAuthEntryInternal = passkey;
  k.resolveConnectedContextRuleIds = async () => [0];

  // Caracal's own relay route answers the kit's POST.
  const relayAnswers: { status: number; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const { POST } = await import("../src/app/api/relay/route");
    const res = await POST(new Request(url, { method: "POST", body: init?.body as string }));
    relayAnswers.push({ status: res.status, body: await res.clone().json() });
    return res;
  });

  const deps: SendDeps = {
    buildTransfer: (payment) => buildAnchorTransfer(WALLET, payment, kit.rpc),
    signAndSubmit: (tx) => kit.signAndSubmit(tx as never),
  };
  const result = await sendToAnchor(waiting, TWO, deps);
  return { result, passkey, relayAnswers, polled };
}

describe("adversary c21: the restore is found only after the passkey signed (the page's first simulation cannot see it)", () => {
  it("control: with nothing expired the same pipeline pays (real kit, real relay route, fake Channels)", async () => {
    const { result, passkey, relayAnswers } = await pay(accepted);
    expect(passkey).toHaveBeenCalledTimes(1);
    expect(relayAnswers[0]?.status).toBe(200);
    expect(result.kind).toBe("sent");
  });

  it("the relay refuses with its restore answer after the passkey was used: the page names the expired data and does not promise a retry helps", async () => {
    const { result, passkey, relayAnswers } = await pay(askForRestore);
    // The harness did what the scenario says: the person used the passkey, and Caracal's relay answered 409.
    expect(passkey).toHaveBeenCalledTimes(1);
    expect(relayAnswers[0]?.status).toBe(409);
    expect(JSON.stringify(relayAnswers[0]?.body)).toMatch(/expired on the network and must be restored first/);
    expect(result.kind).toBe("not-sent");
    const message = "message" in result ? result.message : "";
    // today: "The USDC payment was not sent. Nothing left your wallet. Try again."
    expect(message).toMatch(/expired|restor|archiv/i);
    expect(message).not.toMatch(/Try again\.?$/);
  });

  it("the wallet's own entry is archived (the relay's lookup finds nothing, 409 'may need restoring'): same wrong 'Try again' after the passkey", async () => {
    const { result, passkey, relayAnswers } = await pay(accepted, true);
    expect(passkey).toHaveBeenCalledTimes(1);
    expect(relayAnswers[0]?.status).toBe(409);
    expect(JSON.stringify(relayAnswers[0]?.body)).toMatch(/may need restoring/);
    expect(result.kind).toBe("not-sent");
    const message = "message" in result ? result.message : "";
    expect(message).toMatch(/expired|restor|archiv/i);
    expect(message).not.toMatch(/Try again\.?$/);
  });
});
