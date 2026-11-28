// Adversary c39: after an unknown send, the landing advice says "the payment can no longer reach the network" and
// "your USDC balance ... is X USDC now (read just now)", and tells the person that if it did not drop the payment
// did not go through and they can start another cash-out, over a balance whose ledger is not past the payment's
// closeBy (a balance node a few ledgers behind the ledger poll: the payment that landed in the last ledgers is not
// in the figure).
//
// Spec: docs/decisions.md 2026-11-27 c16 row ("the page says the payment can no longer land only after that read;
// it also states the balance when Send was pressed and the one just read") and the send-guard.ts header ("A passed
// record does not let the page offer a cash-out at once: the balance must first be read at a ledger past its
// closeBy"). Attacker goal 3 (the page states something false about how fresh the balance is / a payment's outcome).
//
// Cause: src/app/cashout/page.tsx, the effect on [windowOver, hold.held, landingOver] sets landingOver after ANY
// completed refreshBalance(), without checking that the balance was read at a ledger past the payment's closeBy
// (balanceAt > mustPass, the test the page applies everywhere else). The text under `pastLanding` then prints the
// read-before-landing figure as "is 90 USDC now (read just now)" while the page's own gate treats that balance as
// unfit (the "Start another cash-out" button is withheld until a read past closeBy).
//
// How: the unknown send (relay answered nothing: code 5003, no hash); the payment lands at ledger 117 (closeBy is
// 118; the fake chain shows 88 USDC from then on, 90 before); the balance node is 4 ledgers behind the ledger poll,
// and reports the ledger it ran at (the real readUsdcBalance does, from the simulation's latestLedger). The moment
// the advice appears, the network is past closeBy and the landing window is over, but the balance is as of ledger
// 116. Passes for any fix that waits for a balance read past closeBy before it prints the comparison, or does not
// call that figure "read just now".
//
// Real: the page, src/lib/anchor/*, send-guard, Web Locks stand-in, through the c2 hook runtime. Faked: anchor, kit
// (the real failure shape of a relay that did not answer), popup, the chain's balance and its lagging node.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const relayDidNotAnswer = { success: false, error: { code: 5003, message: "Relayer request failed with status 502" } };
const BEFORE = BigInt(900_000_000); // 90 USDC
const AFTER = BigInt(880_000_000); // 88 USDC: the 2 USDC payment landed
const LANDS_AT = 117; // the last ledgers before closeBy (118): a slow relay

/**
 * The chain: a ledger every 5 s from 100; the payment lands at LANDS_AT. The balance node is `lag` ledgers behind the
 * ledger poll (a load-balanced RPC): its balance is the chain's at its own ledger, and it reports that ledger (the
 * harness asks getLatestLedger right after each balance read to learn the ledger the balance was read at).
 */
function chain(startedAt: number, lag: number) {
  const state = { justRead: false };
  const real = () => 100 + Math.floor((Date.now() - startedAt) / 5_000);
  return {
    rpc: {
      getLatestLedger: async () => {
        const at = state.justRead ? real() - lag : real();
        state.justRead = false;
        return { sequence: at };
      },
    },
    balance: async () => {
      state.justRead = true;
      return real() - lag >= LANDS_AT ? AFTER : BEFORE;
    },
  };
}

/** Steps the fake clock 1 s at a time until the page says the payment can no longer reach the network. */
async function untilLandingAdvice(rt: { tree: unknown }) {
  for (let i = 0; i < 400 && !text(rt).includes("can no longer reach the network"); i++) await tick(1_000);
  expect(text(rt)).toContain("can no longer reach the network");
}

async function unknownSend(lag: number) {
  const startedAt = Date.now();
  const c = chain(startedAt, lag);
  const { rt, world } = await mount({ submit: async () => relayDidNotAnswer, rpc: c.rpc });
  world.kit.readBalance.mockImplementation(c.balance);
  await toConfirm(rt, world);
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(50);
  expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed
  return { rt, world };
}

describe("adversary c39: the landing advice's 'read just now' balance is not from before the payment could land", () => {
  it("control: with a node that keeps up, the advice shows 88 USDC, the payment that landed at ledger 117", async () => {
    const { rt } = await unknownSend(0);
    await untilLandingAdvice(rt);
    expect(text(rt)).toMatch(/is 88 USDC now \(read just now\)/);
    rt.unmount();
  });

  it("with a balance node 4 ledgers behind, the page does not vouch for a balance from before the payment landed ('is 90 USDC now (read just now)', 'did not go through')", async () => {
    const { rt } = await unknownSend(4);
    await untilLandingAdvice(rt);
    const shown = text(rt);
    // The page's own gate treats that balance as unfit: it withholds a new cash-out until one is read past closeBy.
    expect(buttonLabels(rt.tree)).not.toContain("Start another cash-out");
    // So it must not present it as the fresh read the advice is built on.
    expect(shown).not.toMatch(/is 90 USDC now \(read just now\)/);
    rt.unmount();
  });
});
