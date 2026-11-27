// Adversary c2: when the anchor stops accepting the session after the USDC was sent, the page is a dead end.
//
// src/lib/anchor/sep24.ts loadTransaction(): a 401 or 403 from the anchor's status endpoint becomes
// "The anchor no longer accepts this session, so its status cannot be read here. Your wallet's history
// shows whether the USDC left." and src/app/cashout/page.tsx stops polling on exactly that message.
// The page then shows that note and nothing else: `done` needs a final status, which can never arrive
// now, so "Start another cash-out" is never offered; "Start again" exists only in phase "confirm". A
// person whose USDC has been sent (phase "watching") has no control, no status, and is not told to
// reload (goal 5: no way forward; a withdrawal they cannot follow or finish).
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (status endpoint refusal), kit, popup.
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

describe("adversary c2: the anchor refuses the session after the payment was sent", () => {
  it("control: with a readable status the finished withdrawal offers 'Start another cash-out'", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    world.txn.status = "completed";
    await tick(3100);
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    rt.unmount();
  });

  it("a 403 on the status after the USDC was sent still leaves the person a way forward", async () => {
    let code = 200;
    const { rt, world } = await mount({ txnStatusCode: () => code });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1); // the USDC was sent
    code = 403; // the anchor's token is refused from now on
    await tick(3100);
    await tick(60_000);
    expect(text(rt)).toMatch(/no longer accepts this session/); // the page knows (the harness works)
    const way = buttonLabels(rt.tree).length > 0 || find(rt.tree, (e) => e.type === "input").length > 0 || /reload|refresh/i.test(text(rt));
    expect(way).toBe(true);
    rt.unmount();
  });
});
