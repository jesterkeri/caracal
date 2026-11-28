// Adversary c28: "Start again" is offered, and works, in the moments after Send is pressed and before the
// page enters phase "sending"; the running send() then ends the page with no control at all.
//
// src/app/cashout/page.tsx send(): after the press it awaits readLedger (up to 15 s, readLedger in
// send-guard.ts) and acquireSend while `phase` is still "confirm", and the confirm screen shows "Start again"
// whenever phase === "confirm" (line 607), not "once Send has begun". startAgain() clears the session, the
// transaction (txnRef) and sendingFor, but the running send() goes on: it takes the guard, sets phase
// "sending", and sendToAnchor's stillCurrent() finds txnRef null and answers "The anchor stopped waiting for
// this payment while Caracal was preparing it, so nothing was sent. Its status is shown below." send() then
// sets phase "confirm". With txn null, the confirm card, the preview (phase must be "preview"), the status
// card and every button are gone: the page shows only that sentence, which is false ("shown below": nothing
// is), and only a reload leaves it (goals 4 and 5). Nothing is sent, so no money is at risk.
//
// Spec: docs/decisions.md 2026-11-27 c2 row ("Start another cash-out is never offered while the USDC is
// being sent" because "starting again then would lose track of it") and the c13 row (a person is never left
// with no way forward). The same loss of track happens here, only earlier.
//
// The second test passes for any fix that stops offering Start again once Send was pressed, or that lets the
// finished send leave the page usable; it fails only when the button is offered, pressed, and the page then
// has no input and no button.
//
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor, kit, popup, and an
// RPC whose ledger read is slow (a phone on a bad network), as the c2 harness's `rpc` option allows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonLabels, clickButton, find, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

/** An rpc whose ledger read, once armed, takes `lagMs` (a slow public RPC). */
function slowRpc(lagMs: number) {
  const t0 = Date.now();
  let armed = false;
  return {
    arm: () => (armed = true),
    rpc: {
      getLatestLedger: async () => {
        if (armed) await new Promise((r) => setTimeout(r, lagMs));
        return { sequence: 100 + Math.floor((Date.now() - t0) / 5_000) };
      },
    },
  };
}

describe("adversary c28: Start again pressed right after Send", () => {
  it("control: Send with no Start again asks the passkey once for the confirmed record", async () => {
    const slow = slowRpc(4000);
    const { rt, world } = await mount({ rpc: slow.rpc });
    await toConfirm(rt, world);
    slow.arm();
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(5000);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    rt.unmount();
  });

  it("after Send then Start again, the page still offers a way forward and does not point at a status that is not shown", async () => {
    const slow = slowRpc(4000);
    const { rt, world } = await mount({ rpc: slow.rpc });
    await toConfirm(rt, world);
    slow.arm();
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100); // the ledger read is still pending: the page is still on the confirm screen
    const offered = buttonLabels(rt.tree).includes("Start again");
    if (offered) {
      clickButton(rt.tree, /^Start again$/); // the person abandons this cash-out
      await tick(100);
      expect(find(rt.tree, (e) => e.type === "input").length).toBeGreaterThan(0); // a fresh preview, as startAgain intends
    }
    if (!offered) {
      rt.unmount();
      return; // a fix that stops offering the button is fine
    }
    await tick(6000); // the slow ledger read returns and the running send() finishes
    const control = buttonLabels(rt.tree).length + find(rt.tree, (e) => e.type === "input").length;
    // Observed on 6d71c53: no input, no button, and "The anchor stopped waiting for this payment ... Its status
    // is shown below" with no status shown. Only a reload gets out (phase "confirm" with no record).
    expect(control, `page text: ${text(rt).slice(300, 700)}`).toBeGreaterThan(0);
    rt.unmount();
  });
});
