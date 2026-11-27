// Adversary i3. Promise (apps/web/src/lib/invoices/chain.ts, WriteOutcome; invoices page and pay page
// copy): "not-sent" is a write that "failed before any transaction left (passkey refused, the call fails
// when tried, or the relay said so)", and the person is then told "did not go through" / "The payment was
// not made". "unknown" ("may have gone through. Do not repeat it yet") is only for an answer that was lost
// after something may have been sent.
//
// What the real smart-account-kit 0.10.0 does (node_modules/smart-account-kit/dist/kit/tx-ops.js,
// signAndSubmit): everything before the submission, a refused passkey included, is caught by one
// try/catch and returned as failedTransaction(wrapError(err, TRANSACTION_SIGNING_FAILED)), that is code
// 5002 with the raw error's message. The kit never raises WEBAUTHN_CANCELLED (4004) anywhere, and
// NOT_SENT_CODES in chain.ts has no 5002. The existing test in invoice-chain.test.ts fakes a refused
// passkey as code 4004, which the real kit never produces.
//
// This test uses the real SmartAccountKit class (its signAndSubmit and signResimulateAndPrepare), the real
// @simplewebauthn/browser startAuthentication with a browser that refuses the prompt (navigator.credentials.get
// rejects with NotAllowedError, as Chrome and Safari do when the person closes the sheet), the real
// stellar-sdk AssembledTransaction, and the real sendCall. Only three things are replaced: the RPC's
// simulateTransaction answer (a successful simulation with one wallet auth entry), the kit's context rule
// lookup (needs the network) and the lookup of the wallet's signer (needs the network), which both run
// before the prompt.
import { Address, Account, Operation, TransactionBuilder, Networks, SorobanDataBuilder, authorizeEntry, xdr, nativeToScVal } from "@stellar/stellar-sdk";
import { SmartAccountKit, MemoryStorage } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK, SMART_ACCOUNT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { cancelInvoice, createInvoice, payInvoice } from "../src/lib/invoices/chain";

void Account;
void Operation;
void TransactionBuilder;
void Networks;
void authorizeEntry;

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The wallet's own address-credential auth entry for split.cancel_invoice(ref): what a real simulation hands the kit to sign. */
function walletAuthEntry(method: string, args: xdr.ScVal[]): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(WALLET).toScAddress(),
        nonce: new xdr.Int64(BigInt(1)),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(SPLIT).toScAddress(), functionName: method, args }),
      ),
      subInvocations: [],
    }),
  });
}

/** A real kit, connected to WALLET, whose RPC answers every simulation with success and one wallet auth entry. */
function connectedKit(sim: "success" | "restore" = "success") {
  const kit = new SmartAccountKit({
    rpcUrl: NETWORK.rpcUrl,
    networkPassphrase: NETWORK.passphrase,
    accountWasmHash: SMART_ACCOUNT.accountWasmHash,
    webauthnVerifierAddress: SMART_ACCOUNT.webauthnVerifier,
    relayerUrl: "http://127.0.0.1:9/api/relay",
    storage: new MemoryStorage(),
    rpId: "caracal.test",
    rpName: "Caracal",
    indexerUrl: false,
    horizonUrl: false,
  });
  const k = kit as unknown as Record<string, unknown>;
  k._contractId = WALLET;
  k._credentialId = "AQIDBA";
  const data = new SorobanDataBuilder();
  const success = {
    id: "1",
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: data,
    minResourceFee: "100",
    result: { auth: [walletAuthEntry("cancel_invoice", [xdr.ScVal.scvBytes(Buffer.from(REF, "hex"))])], retval: xdr.ScVal.scvVoid() },
  };
  const answer = sim === "restore" ? { ...success, restorePreamble: { minResourceFee: "100", transactionData: new SorobanDataBuilder() } } : success;
  k.rpc = { simulateTransaction: vi.fn(async () => answer) };
  // Needs the network (context rules, signer lookup); both run before the passkey prompt.
  k.resolveConnectedContextRuleIds = async () => [0];
  k.signAuthEntryInternal = async () => {
    // What webauthn-ops.js signAuthEntry does at the prompt, minus the network lookups before it.
    await ((kit as unknown as { webAuthn: unknown }).webAuthn as { startAuthentication: (o: unknown) => Promise<unknown> }).startAuthentication({
      optionsJSON: { challenge: "AAAA", rpId: "caracal.test", userVerification: "required", allowCredentials: [{ id: "AQIDBA", type: "public-key" }] },
    });
    throw new Error("the prompt was not refused");
  };
  return kit;
}

/** A browser whose passkey sheet is closed by the person: navigator.credentials.get rejects with NotAllowedError. */
function browserRefusingThePrompt() {
  vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
  vi.stubGlobal("navigator", {
    credentials: {
      get: async () => {
        throw new DOMException("The operation either timed out or was not allowed.", "NotAllowedError");
      },
    },
  });
}

describe("a passkey prompt the person closes", () => {
  it("control: the real kit really did stop at the prompt, before sending anything (a failed result, no hash, the browser's message)", async () => {
    browserRefusingThePrompt();
    const kit = connectedKit();
    const { contract } = await import("@stellar/stellar-sdk");
    const tx = await contract.AssembledTransaction.build({
      contractId: SPLIT,
      method: "cancel_invoice",
      args: [xdr.ScVal.scvBytes(Buffer.from(REF, "hex"))],
      networkPassphrase: NETWORK.passphrase,
      rpcUrl: NETWORK.rpcUrl,
      server: kit.rpc,
      parseResultXdr: (v: xdr.ScVal) => v,
    });
    const result = await kit.signAndSubmit(tx);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.message).toMatch(/not allowed|timed out/i);
    expect(result.hash).toBeUndefined();
    // Documented, not asserted against the fix: the kit labels it a signing failure, 5002.
    expect((result.error as { code?: number }).code).toBe(5002);
  });

  it("cancelling an invoice: a closed passkey sheet means nothing was sent, not 'may have gone through'", async () => {
    browserRefusingThePrompt();
    const out = await cancelInvoice(connectedKit(), SPLIT, REF);
    expect(out.kind).toBe("not-sent");
  });

  it("opening an invoice: a closed passkey sheet means nothing was sent (so its saved details are removed again)", async () => {
    browserRefusingThePrompt();
    const out = await createInvoice(connectedKit(), SPLIT, REF, BigInt(5_000_000));
    expect(out.kind).toBe("not-sent");
  });

  it("paying an invoice: a closed passkey sheet means nothing was sent, so the payer is not told to 'Check again' first", async () => {
    browserRefusingThePrompt();
    const out = await payInvoice(connectedKit(), SPLIT, WALLET, BigInt(5_000_000), REF);
    expect(out.kind).toBe("not-sent");
  });
});

describe("a split whose contract data has expired on the network", () => {
  void nativeToScVal;
  it("the kit cannot sign it (the SDK wants a restore first); nothing was sent, so it is not 'unknown'", async () => {
    const out = await cancelInvoice(connectedKit("restore"), SPLIT, REF);
    expect(out.kind).toBe("not-sent");
  });
});
