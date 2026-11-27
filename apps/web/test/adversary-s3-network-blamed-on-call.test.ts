// Adversary s3: when the network cannot be reached for a write's first
// simulation (src/lib/split/send.ts, sendSplitCall), the person is told "The call
// was refused when Caracal tried it first: Network Error". Every failure of
// buildTx gets that wording, so an unreachable or failing RPC is reported as if
// the contract had refused the call.
//
// Spec:
// - attacker goal 4: "a wrong cause for a failure".
// - src/lib/split/actions.ts loadSplit says "Caracal could not reach the Stellar
//   network ... Check your connection and try again." for the same failure on a
//   read; send.ts's own doc says "stopped" is for "the call was refused when
//   simulated", which a dropped connection is not.
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { sendSplitCall, type WriteKit } from "../src/lib/split/send";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

afterEach(() => vi.restoreAllMocks());

const SPLIT = splitAddressFor(WALLET);
const URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

/** The real buildTx runs against a real rpc.Server whose simulateTransaction is replaced by `answer`. */
async function withdrawWhen(answer: () => Promise<unknown>) {
  const server = new rpc.Server(URL);
  vi.spyOn(server, "simulateTransaction").mockImplementation(answer as never);
  const signAndSubmit = vi.fn();
  const kit = { rpc: server, rpcUrl: URL, networkPassphrase: PASSPHRASE, signAndSubmit } as unknown as WriteKit;
  const outcome = await sendSplitCall(kit, withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT);
  return { outcome, signAndSubmit };
}

describe("adversary s3: what a write says when its first simulation fails", () => {
  it("control: a real refusal by the contract is reported as a refusal, with its reason", async () => {
    const { outcome, signAndSubmit } = await withdrawWhen(async () => ({ _parsed: true, id: "s", latestLedger: 1, events: [], error: "HostError: Error(Contract, #4)" }));
    expect(outcome.kind).toBe("stopped");
    expect(outcome.kind === "stopped" && outcome.message).toBe("The call was refused when Caracal tried it first: That pot does not hold enough USDC for this.");
    expect(signAndSubmit).not.toHaveBeenCalled();
  });

  it("an unreachable RPC is not reported as the call being refused", async () => {
    const { outcome, signAndSubmit } = await withdrawWhen(() => Promise.reject(new Error("Network Error")));
    expect(signAndSubmit).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("stopped"); // nothing was signed or sent: a stop is right, the cause is what is wrong
    // Defect: "The call was refused when Caracal tried it first: Network Error"
    expect(outcome.kind === "stopped" && outcome.message).not.toMatch(/refused/i);
  });

  it("an RPC that answers with a server error is not reported as the call being refused either", async () => {
    const { outcome } = await withdrawWhen(() => Promise.reject(Object.assign(new Error("Request failed with status code 503"), { response: { status: 503 } })));
    expect(outcome.kind === "stopped" && outcome.message).not.toMatch(/refused/i);
  });
});
