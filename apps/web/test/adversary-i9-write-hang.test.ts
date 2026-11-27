// Adversary i9. Goal 5 (a person is left stuck: a page that hangs without bound) on the pay and invoices pages.
//
// Promise (docs/decisions.md, 2026-11-27, adversary i1): "Every network read on the pay and invoices pages
// (simulations, event pages, building a call) is limited to 20 s". sendCall() (lib/invoices/chain.ts) bounds
// the build of the call, then hands the signed call to smart-account-kit 0.10.0's signAndSubmit with no limit
// at all. That function does more network reads after the passkey prompt: it re-simulates the call with the
// signed authorisation (tx-ops.js resimulateAndAssemble, rpc.simulateTransaction), before it sends anything.
// A node that takes the request and never answers (the case adversary i1 proved for the first read) leaves
// payInvoice(), createInvoice() and cancelInvoice() pending for ever. The pay page then shows "Paying.
// Approve it with your passkey." and the invoices page "Opening the invoice on Stellar. Approve it with your
// passkey." with every control disabled and no error, although the person already approved and nothing was
// sent. (The kit's relayer wait has its own 360 s limit; this wait has none. docs/fix-day.md lists the
// same class only for the wallet page's Connect and Create.)
//
// What the kit does is real here: the real SmartAccountKit signAndSubmit and signResimulateAndPrepare, the
// real stellar-sdk AssembledTransaction and the real sendCall. Only the RPC's answers are replaced (as in
// adversary-i3-passkey-cancel-unknown.test.ts), and the passkey step, which needs a browser, returns the
// entry as the person's approval would.
import { Address, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { SmartAccountKit, MemoryStorage } from "smart-account-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NETWORK, SMART_ACCOUNT } from "../src/lib/stellar/config";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { cancelInvoice, createInvoice, payInvoice, type WriteOutcome } from "../src/lib/invoices/chain";

const WALLET = "CDK24QZKOWOF3JPDLFQI4YAGIUYJO4YBLFFMOS6BK3SQ2HAPICZL3FGX";
const SPLIT = splitAddressFor(WALLET);
const REF = "0123456789abcdef0123456789abcdef";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

/**
 * A real kit connected to WALLET. Its first simulation (building the call) succeeds. The second is the kit's
 * re-simulation after the passkey step: `resim` decides what the network does with it.
 */
function kitWhoseResimulation(resim: () => Promise<unknown>) {
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
  const first = {
    id: "1",
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: new SorobanDataBuilder(),
    minResourceFee: "100",
    result: { auth: [walletAuthEntry("cancel_invoice", [xdr.ScVal.scvBytes(Buffer.from(REF, "hex"))])], retval: xdr.ScVal.scvVoid() },
  };
  let calls = 0;
  const simulateTransaction = vi.fn(async () => (++calls === 1 ? first : resim()));
  k.rpc = { simulateTransaction };
  k.resolveConnectedContextRuleIds = async () => [0];
  // The person approves the passkey prompt: the entry comes back signed (here, unchanged).
  k.signAuthEntryInternal = async (entry: unknown) => entry;
  return { kit, simulateTransaction };
}

const settles = async (run: () => Promise<WriteOutcome>) => {
  vi.useFakeTimers();
  let outcome: WriteOutcome | undefined;
  void run().then((o) => (outcome = o));
  // Ten minutes: far longer than any wait the pages promise (20 s a read, 30 s to restore a wallet).
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  return outcome;
};

const WRITES: [string, (kit: SmartAccountKit) => Promise<WriteOutcome>][] = [
  ["paying an invoice", (kit) => payInvoice(kit, SPLIT, WALLET, BigInt(5_000_000), REF)],
  ["opening an invoice", (kit) => createInvoice(kit, SPLIT, REF, BigInt(5_000_000))],
  ["cancelling an invoice", (kit) => cancelInvoice(kit, SPLIT, REF)],
];

describe("a write whose re-simulation after the passkey prompt gets no answer", () => {
  it("control: when the network answers that re-simulation with a failure, the write ends (nothing was sent)", async () => {
    const { kit, simulateTransaction } = kitWhoseResimulation(() => Promise.reject(new Error("fetch failed")));
    const out = await settles(() => payInvoice(kit, SPLIT, WALLET, BigInt(5_000_000), REF));
    expect(simulateTransaction).toHaveBeenCalledTimes(2); // the build, then the kit's re-simulation
    expect(out?.kind).toBeDefined();
  });

  for (const [what, write] of WRITES) {
    it(`${what} ends within ten minutes, not in a busy page for ever`, async () => {
      const { kit, simulateTransaction } = kitWhoseResimulation(() => new Promise<never>(() => {}));
      const out = await settles(() => write(kit));
      expect(simulateTransaction).toHaveBeenCalledTimes(2); // it reached the re-simulation, which never answers
      expect(out).toBeDefined();
    });
  }
});
