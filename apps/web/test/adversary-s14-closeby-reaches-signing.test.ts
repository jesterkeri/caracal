// Adversary s14 (passing control, not a defect): the write guard's closeBy really reaches the kit's passkey signing.
//
// Every earlier test of write-guard.ts fakes the transaction (`needsNonInvokerSigningBy: () => [WALLET]`) and
// the kit's signAndSubmit, so none showed that, with the REAL stellar-sdk AssembledTransaction and the REAL
// smart-account-kit signAndSubmit, `expiration: closeBy` is what the kit hands to the signing step
// (the only thing that bounds how long an uncertain write can still land, decisions 2026-11-28 Codex split R3).
// Real: kit.signAndSubmit, signResimulateAndPrepare, sendSplitCall and its buildTx, the guard's real
// needsNonInvokerSigningBy check. Faked: the passkey prompt (records the options it is given) and the network
// (test/s4-fake-network.ts, 127.0.0.1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { sendSplitCall } from "../src/lib/split/send";
import { acquireWrite } from "../src/lib/split/write-guard";
import { SPLIT, fakeNetwork, realKit, type Fake } from "./s4-fake-network";
import { WALLET } from "./relay-fixtures";

let net: Fake | undefined;
beforeEach(() => vi.restoreAllMocks());
afterEach(async () => {
  vi.unstubAllGlobals();
  await net?.close();
  net = undefined;
});

describe("adversary s14: closeBy reaches the real kit's signing step", () => {
  it("the signature's expiration is the write's closeBy, and the real transaction's signer list is not empty", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    net = await fakeNetwork(2, { success: false, error: "The relay refused it. Nothing was sent." });
    const kit = realKit(net) as unknown as Record<string, unknown>;
    const signingOptions: { expiration?: number }[] = [];
    kit.signAuthEntryInternal = async (entry: unknown, options: { expiration?: number }) => {
      signingOptions.push(options);
      return entry;
    };
    const begun = await acquireWrite(SPLIT, 1000);
    if (!begun.ok) throw new Error(`the write was not allowed to begin: ${JSON.stringify(begun.hold)}`);
    const outcome = await sendSplitCall(begun.guard.kit(kit as never), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT);
    expect(signingOptions).toHaveLength(1); // the passkey step was reached (the guard did not refuse the call as unbounded)
    expect(signingOptions[0]!.expiration).toBe(1000 + 60);
    expect(outcome).toEqual({ kind: "refused", message: "The relay refused it. Nothing was sent." });
  });
});
