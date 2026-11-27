// Adversary c14: a send whose outcome is UNKNOWN (kit code 5004, the confirmation poll timed out, hash set)
// is later described as a payment that "was sent".
//
// Spec: goal 4 (a person is told something false: "sent when it is unknown"). docs/decisions.md c1 row: a
// failure that is not proven either way "is unknown ... the page says it may have gone through". The c12
// row made statusText say "Your USDC payment (below) was sent, so ask the anchor to refund it" whenever
// "this page holds a sent payment's hash". Cause: src/app/cashout/page.tsx passes `sentHash !== null` as
// `sent`, and the unknown branch of send() also stores r.hash in sentHash, so a payment the page itself
// called "may still go through" becomes "was sent" the moment the anchor reports too_small.
//
// Real: the page and src/lib/anchor/*, through the c2 hook runtime. Faked: anchor, kit.
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

const HASH = "ab".repeat(32);

describe("adversary c14: an unknown send is not 'sent'", () => {
  it("control: a confirmed send (success, hash) followed by too_small says the payment was sent", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: true, hash: HASH }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    world.txn.status = "too_small";
    await tick(3100);
    expect(text(rt)).toContain("Your USDC payment (below) was sent");
    rt.unmount();
  });

  it("an unconfirmed send (5004 with a hash) then too_small does not say the payment was sent", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, hash: HASH, error: { code: 5004, message: "Transaction confirmation timed out" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("It may still go through"); // unknown, as designed (the harness works)
    world.txn.status = "too_small";
    await tick(3100);
    expect(text(rt)).not.toContain("Your USDC payment (below) was sent");
    rt.unmount();
  });
});
