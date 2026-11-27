// Adversary c12: after Caracal itself has confirmed the USDC payment (the kit returned success and a
// hash, shown on screen as "USDC payment on Stellar: <hash>"), the anchor reports too_small (or
// too_large, or no_market) and the same screen tells the person "No USDC was sent".
//
// Spec: goal 4 (a person is told something false: "Nothing was sent" when it may have been, and here
// when the page holds the chain's proof that it was). docs/decisions.md 2026-11-27 (c2/c5 rows): the
// anchor's status decides what happens next, but the page must not say the opposite of what it has
// itself confirmed. Cause: src/lib/anchor/sep24.ts statusText() for "no_market", "too_small" and
// "too_large" returns "The anchor could not do this withdrawal at this amount. No USDC was sent unless
// your wallet history says otherwise." with no knowledge of whether the page sent the payment, and
// src/app/cashout/page.tsx prints it in the watching card beside the sent hash. Those statuses can follow
// a received payment (the anchor measures the amount once the USDC arrives), and the person is then told
// their money did not leave when it is sitting at the anchor.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor (the repo's captured
// record with only status edited), kit (signAndSubmit returns success and a hash), popup.
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

const HASH = "cb".repeat(32);

describe("adversary c12: the anchor's too_small after the payment was confirmed", () => {
  it("control: the page shows the confirmed payment, and an expired status after it hedges with 'If USDC left'", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /^Send 2 USDC/);
    await tick(50);
    world.txn.status = "expired";
    await tick(3100);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(text(rt)).toContain(`USDC payment on Stellar: ${HASH}`);
    expect(text(rt)).toContain("If USDC left your wallet");
    rt.unmount();
  });

  it.each(["too_small", "too_large", "no_market"])("after a confirmed payment, %s must not tell the person no USDC was sent", async (status) => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    void clickButton(rt.tree, /^Send 2 USDC/);
    await tick(50);
    world.txn.status = status;
    await tick(3100);
    // the harness works: the payment was submitted and the screen shows its hash and the anchor's status text
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    expect(text(rt)).toContain(`USDC payment on Stellar: ${HASH}`);
    expect(text(rt)).toContain("The anchor could not do this withdrawal at this amount.");
    // the defect: the same screen says the opposite of the payment it shows
    expect(text(rt)).not.toMatch(/No USDC was sent/);
    rt.unmount();
  });
});
