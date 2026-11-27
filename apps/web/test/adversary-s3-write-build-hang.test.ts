// Adversary s3: a split write has no time limit on its first step, the
// simulation that sendSplitCall (src/lib/split/send.ts, buildTx) runs before any
// passkey prompt. stellar-sdk's rpc.Server has no timeout of its own, so an RPC
// that accepts the request and never answers leaves the page on "Waiting for your
// passkey..." with every button disabled (the page's `busy` flag) until a reload,
// though no passkey prompt was ever shown.
//
// Spec:
// - attacker goal 5: "a page that hangs without bound".
// - src/lib/split/chain.ts: every read has READ_TIMEOUT_MS (15 s), and
//   src/lib/stellar/wallet-lookup.ts LOOKUP_TIMEOUT_MS (10 s); docs/decisions.md
//   2026-11-27: "The split page bounds restoring the saved wallet ... 30 s limit,
//   then the page says it could not load the wallet". The write path is the one
//   network step on this page that is not bounded.
// Not the fix-day r4l/r4r item: that one is the wallet page's step after the
// passkey; this is the split page, before the passkey.
import { rpc } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPots } from "../src/lib/split/chain";
import { withdrawFunction } from "../src/lib/split/calls";
import { sendSplitCall, type WriteKit } from "../src/lib/split/send";
import { splitAddressFor } from "../src/lib/stellar/split-address";
import { WALLET } from "./relay-fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SPLIT = splitAddressFor(WALLET);
const URL = "https://soroban-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

/** An RPC that accepts every simulation and never answers it. */
function silentRpc() {
  const server = new rpc.Server(URL);
  const sim = vi.spyOn(server, "simulateTransaction").mockImplementation(() => new Promise(() => {}));
  return { server, sim };
}

describe("adversary s3: an RPC that never answers the first simulation of a write", () => {
  it("control: the same silent RPC makes a read give up after its 15 s limit", async () => {
    vi.useFakeTimers();
    const { server } = silentRpc();
    const read = readPots(server, SPLIT).then(
      () => "answered",
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(16_000);
    expect(await read).toMatch(/did not answer within 15 seconds/);
  });

  it("a write against it ends with a message within 10 minutes, with no passkey prompt shown", async () => {
    vi.useFakeTimers();
    const { server, sim } = silentRpc();
    const signAndSubmit = vi.fn();
    const kit = { rpc: server, rpcUrl: URL, networkPassphrase: PASSPHRASE, signAndSubmit } as unknown as WriteKit;

    let outcome: unknown = "still waiting";
    void sendSplitCall(kit, withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT).then((o) => {
      outcome = o;
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(sim).toHaveBeenCalledTimes(1); // the real buildTx did ask the RPC
    expect(signAndSubmit).not.toHaveBeenCalled(); // so no passkey prompt was ever reached
    // Defect: still "still waiting" after ten minutes: the page sits on "Waiting for your passkey" for ever.
    expect(outcome).not.toBe("still waiting");
  });
});
