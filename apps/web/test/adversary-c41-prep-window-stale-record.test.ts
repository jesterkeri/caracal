// Adversary c41 #1: the payment is signed for the anchor's record as it was before the preparation window, when the
// anchor's status could not be read during it.
//
// Spec: docs/decisions.md 2026-11-27 c13 and 2026-11-28 c36 (1): "Send now reads the anchor's record again at the
// press ... if it cannot be read, nothing is sent", because the page must not pay an account, memo or quote, or a
// withdrawal, that the anchor no longer asks for. src/app/cashout/page.tsx stillCurrent (c23): "the passkey is asked
// only for the record the person confirmed, while the anchor still waits for it", on the premise that the poll
// "kept the record current while the balance was read and the payment built". Goal 1: a payment to an address the
// anchor does not ask for now, or for a withdrawal it no longer expects.
// Cause: between the press (record read, then the ledger read, the lock, the balance read of up to 10 s and the
// build of up to 20 s) and the passkey, the only check is stillCurrent(), which compares txnRef.current with the
// record read at the press. txnRef is written only by a poll that succeeded. When the poll's reads fail (HTTP 503)
// during that window, txnRef is still the press's record, so a changed account (or a status that is no longer
// pending_user_transfer_start) is not seen, and the passkey is asked and the payment signed for the old record.
// c36 closed this for the instant of the press only.
//
// Assertion: with the status endpoint failing from just after the press, and the anchor having changed its
// account (or expired the withdrawal) meanwhile, no payment is signed. Passes for any fix that re-reads the record
// just before the passkey, or that refuses when the record could not be refreshed since the press. The controls
// (nothing changes; or the status reads work and the account changes) behave correctly today.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor (fetch stub), kit, popup, and a
// slow balance read (the real read is bounded by BALANCE_AT_SEND_MS = 10 s, so the window exists on a slow RPC).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clickButton, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

// A different valid classic account, as the anchor might switch to.
const OTHER_ACCOUNT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

type Mounted = Awaited<ReturnType<typeof mount>>;

/** Presses Send with a balance read that takes 8 s (inside BALANCE_AT_SEND_MS), then lets `during` run in that window. */
async function pressSendThen(during: (world: Mounted["world"]) => void, over: Parameters<typeof mount>[0] = {}) {
  const { rt, world } = await mount(over);
  await toConfirm(rt, world);
  world.kit.readBalance.mockImplementation(() => new Promise((r) => setTimeout(() => r(BigInt(90_000_000)), 8_000)));
  void clickButton(rt.tree, /Send 2 USDC/);
  await tick(500); // the press has read the record, the ledger and taken the lock; the balance read is under way
  during(world);
  await tick(15_000); // the poll ticks in the window; the balance read ends; the payment is built and (maybe) signed
  return { rt, world };
}

describe("adversary c41: the record changes while the page prepares the payment and the status cannot be read", () => {
  it("control: nothing changes and the status reads work, so the payment is signed", async () => {
    const { rt, world } = await pressSendThen(() => {});
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("control: the account changes while the status reads work, so the poll sees it and nothing is signed", async () => {
    const { rt, world } = await pressSendThen((w) => {
      w.txn.withdraw_anchor_account = OTHER_ACCOUNT;
    });
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });

  it("the account changes and the status endpoint answers 503 during the preparation: no payment is signed", async () => {
    let code = 200;
    const { rt, world } = await pressSendThen(
      (w) => {
        code = 503; // the anchor's status endpoint starts failing
        w.txn.withdraw_anchor_account = OTHER_ACCOUNT; // and the account it expects changes
      },
      { txnStatusCode: () => code },
    );
    expect(text(rt)).toMatch(/status answered with an error \(503\)/); // the page knows it could not read it
    expect(world.txn.withdraw_anchor_account).toBe(OTHER_ACCOUNT); // the anchor now asks for another account
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });

  it("the anchor expires the withdrawal and the status endpoint answers 503 during the preparation: no payment is signed", async () => {
    let code = 200;
    const { rt, world } = await pressSendThen(
      (w) => {
        code = 503;
        w.txn.status = "expired";
      },
      { txnStatusCode: () => code },
    );
    expect(world.txn.status).toBe("expired");
    expect(world.kit.signAndSubmit).not.toHaveBeenCalled();
    rt.unmount();
  });
});
