// Adversary s4: a split write has no time limit after its first simulation.
//
// s3 bounded the simulation that sendSplitCall (src/lib/split/send.ts) runs
// BEFORE kit.signAndSubmit, so a silent RPC no longer holds the page on
// "Waiting for your passkey..." for ever. But kit.signAndSubmit (smart-account-kit
// 0.10.0, kit/tx-ops.js signResimulateAndPrepare) then re-simulates the signed
// call with `rpc.simulateTransaction`, and the kit builds its rpc.Server with no
// timeout (kit.js: `new RpcServer(config.rpcUrl)`). An RPC that answers the first
// simulation and then goes silent leaves sendSplitCall pending for ever, so
// page.tsx `run` never leaves { busy: "Waiting for your passkey" }, every button
// stays disabled (the page's `busy` flag) and the module-level `writing` flag
// stays set: no message, no way forward but a reload.
//
// Spec:
// - attacker goal 5: "a page that hangs without bound".
// - docs/decisions.md 2026-11-27 (adversary s3): "so a silent RPC ends the write
//   with a message instead of 'Waiting for your passkey' for ever".
// - src/lib/split/send.ts: outcome `unknown` is "anything else: it may or may not
//   have landed. The page re-reads the chain instead of guessing", which is the
//   honest outcome for a wait that ran out after signing.
//
// Real parts: smart-account-kit's own signAndSubmit and signResimulateAndPrepare,
// stellar-sdk's rpc.Server and AssembledTransaction over real HTTP to a server on
// 127.0.0.1, and sendSplitCall with its real buildTx (see s4-fake-network.ts for
// what is faked: the passkey prompt and the kit's context-rule lookup, both
// before the step under test).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { sendSplitCall, type SendOutcome } from "../src/lib/split/send";
import { SPLIT, fakeNetwork, realKit, type Fake } from "./s4-fake-network";
import { WALLET } from "./relay-fixtures";

let net: Fake | undefined;
// test/setup-relay-server.ts spies on rpc.Server.prototype for the relay's tests; this file wants the real HTTP client.
beforeEach(() => vi.restoreAllMocks());
afterEach(async () => {
  vi.useRealTimers();
  await net?.close();
  net = undefined;
});

const NOTHING_SENT = { success: false, error: "Too many requests. Nothing was sent. Try again." };
const realTick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what: string) {
  // setImmediate stays real while setTimeout is faked, so this really waits on the sockets.
  for (let i = 0; i < 200_000 && !cond(); i++) await realTick();
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

describe("adversary s4: an RPC that answers the first simulation and then goes silent", () => {
  it("control: the real kit path reaches the relay when the re-simulation is answered, and the relay's refusal is reported", async () => {
    net = await fakeNetwork(2, NOTHING_SENT);
    const outcome = await sendSplitCall(realKit(net), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT);
    expect(net.simulations()).toBe(2); // first simulation (buildTx) and the kit's re-simulation
    expect(net.relayCalls()).toBe(1);
    expect(outcome).toEqual({ kind: "refused", message: "Too many requests. Nothing was sent. Try again." });
  });

  it("the write ends with an outcome within 10 minutes of the re-simulation being asked", async () => {
    net = await fakeNetwork(1, NOTHING_SENT);
    const kit = realKit(net);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let outcome: SendOutcome | "still waiting" = "still waiting";
    void sendSplitCall(kit, withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT).then((o) => {
      outcome = o;
    });
    await until(() => net!.simulations() === 2, "the kit's re-simulation to reach the RPC");
    await realTick();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await realTick();

    expect(net.simulations()).toBe(2); // the first was answered, the kit's re-simulation is the one that hangs
    expect(net.relayCalls()).toBe(0); // so nothing was posted to the relay
    // Defect: still "still waiting" after ten minutes. The page sits on "Waiting for your passkey" for ever.
    expect(outcome).not.toBe("still waiting");
  });
});
