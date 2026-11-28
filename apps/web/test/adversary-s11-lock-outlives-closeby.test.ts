// Adversary s11: a split write's Web Lock is held past its closeBy, so the tab is refused for a write that can no
// longer land, and told the network has not yet shown that.
//
// write-guard.ts acquireWrite holds the split's Web Lock "until nothing more can be sent from that tab: a
// certain outcome, or an unknown one once its kit call settles". A kit call that never settles (the RPC answers
// the first simulation and then goes silent, the s4 case: the kit's rpc.Server has no timeout) therefore keeps the
// lock for ever, although the write's passkey signature expired at closeBy and nothing it holds can land after it.
//
// When the network is past closeBy, holdOn (the hold the page shows) says the hold has lifted: the buttons are
// enabled and no hold banner is shown. A click then takes the lock path (`!lock`), which answers
//   "An earlier withdrawal, move or change may still go through ... nothing new can be sent until Caracal reads on
//    the Stellar network that it can no longer land; it checks every few seconds."
// although the network was read past closeBy: the text is false and nothing ever lifts it in this tab (a reload does).
//
// Spec:
// - docs/decisions.md 2026-11-28 (Codex split R3): "The hold lifts only when an RPC shows a ledger past closeBy"
//   (i.e. it does lift then), "no clock decides it", and the signature "is invalid in any ledger after closeBy".
// - attacker goal 5: "a control offered that cannot work", "no way forward".
//
// Real parts: smart-account-kit's own signAndSubmit and signResimulateAndPrepare, stellar-sdk's rpc.Server and
// AssembledTransaction over real HTTP to a server on 127.0.0.1 that answers the first simulation and then goes
// silent (test/s4-fake-network.ts), sendSplitCall with its real buildTx, and the real acquireWrite / holdOn.
// Faked: the passkey prompt and the kit's context-rule lookup (see s4-fake-network.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withdrawFunction } from "../src/lib/split/calls";
import { SEND_TIMEOUT_MS, sendSplitCall, type SendOutcome } from "../src/lib/split/send";
import { WRITE_LEDGERS, acquireWrite, holdOn } from "../src/lib/split/write-guard";
import { SPLIT, fakeNetwork, realKit, type Fake } from "./s4-fake-network";
import { WALLET } from "./relay-fixtures";

let net: Fake | undefined;
// test/setup-relay-server.ts spies on rpc.Server.prototype for the relay's tests; this file wants the real HTTP client.
beforeEach(() => vi.restoreAllMocks());
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await net?.close();
  net = undefined;
});

const NOTHING_SENT = { success: false, error: "Too many requests. Nothing was sent. Try again." };
const realTick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200_000 && !cond(); i++) await realTick();
  if (!cond()) throw new Error(`timed out waiting for ${what}`);
}

function browserStorage() {
  const kept = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) },
  });
}

const LEDGER = 1000;

describe("adversary s11: the write lock after an unknown write whose kit call never settles", () => {
  it("control: after a certain outcome the next write may start (the harness takes and lets go of the lock)", async () => {
    browserStorage();
    const first = await acquireWrite(SPLIT, LEDGER);
    if (!first.ok) throw new Error("the first write should begin");
    first.guard.finish({ kind: "refused", message: "Nothing was sent." });
    await first.guard.released;
    await realTick();
    expect((await acquireWrite(SPLIT, LEDGER)).ok).toBe(true);
  });

  it("once the network is past closeBy, a write may start although the first kit call never settled", async () => {
    browserStorage();
    net = await fakeNetwork(1, NOTHING_SENT); // the first simulation is answered, the kit's re-simulation never is
    const kit = realKit(net);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const first = await acquireWrite(SPLIT, LEDGER);
    if (!first.ok) throw new Error("the first write should begin");
    let outcome: SendOutcome | "still waiting" = "still waiting";
    void sendSplitCall(first.guard.kit(kit), withdrawFunction(SPLIT, "Spend", WALLET, BigInt(1)), "withdraw", SPLIT).then((o) => {
      outcome = o;
    });
    await until(() => net!.simulations() === 2, "the kit's re-simulation to reach the RPC");
    await realTick();
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS + 1_000);
    await realTick();
    // The page gives up waiting: the outcome is unknown, and the record holds until the network passes closeBy.
    expect(outcome).toMatchObject({ kind: "unknown" });
    first.guard.finish(outcome as unknown as SendOutcome); // a type-only cast added when kept (tsc)
    expect(first.guard.closeBy).toBe(LEDGER + WRITE_LEDGERS);

    // The network is now past closeBy: the passkey signature (expiration closeBy) can no longer land.
    const later = first.guard.closeBy + 40;
    expect(net.relayCalls()).toBe(0);
    // The hold the page shows has lifted (buttons enabled, no banner) ...
    expect(holdOn(SPLIT, later)).toEqual({ held: false });
    // ... so a click must be able to start a write. Defect: the lock is still held by the pending kit call, and the
    // click is refused with "nothing new can be sent until Caracal reads on the Stellar network that it can no longer land".
    const second = await acquireWrite(SPLIT, later);
    expect(second.ok).toBe(true);
  });
});
