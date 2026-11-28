// Adversary c13: a USDC send whose outcome is unknown, where the payment in fact never reached the
// network, leaves the person with no control and no instruction for as long as the anchor keeps
// the withdrawal open.
//
// Spec: goal 5 (no way forward), with the c2 precedent test adversary-c2-session-rejected ("a person
// whose USDC has been sent ... has no control ... and is not told to reload"). docs/decisions.md
// 2026-11-27 (c1 row): a bare 5003 with no hash (the relay "did not answer", the common case when the
// relay is down or times out) is "unknown": the send lock stays, "the anchor's status decides".
// Cause: src/app/cashout/page.tsx phase "watching" offers "Start another cash-out" only when the
// anchor's status is final (`done`) or the session is lost, and the lock (sendingFor) is never
// released for an unknown outcome. When the payment never landed, the anchor stays at
// pending_user_transfer_start ("The anchor is waiting for your USDC.") and no final status comes, so
// "the anchor's status decides" never happens. The message says only "Do not send it again."
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor, kit (the relay's
// answer is the kit's real failure shape for a relay that did not answer: code 5003, no hash).
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

const wayForward = (rt: { tree: unknown }) => buttonLabels(rt.tree).length > 0 || find(rt.tree, (e) => e.type === "input").length > 0 || /reload|refresh/i.test(text(rt));

describe("adversary c13: unknown send, payment never landed, anchor still waiting", () => {
  it("control: a payment the anchor completes ends with 'Start another cash-out'", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, error: { code: 5003, message: "Relayer request failed with status 502" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    world.txn.status = "completed"; // it did land after all
    await tick(3100);
    // Test change (Codex cash-out R2): the anchor's report keeps the payment's closeBy as the ledger the balance must be
    // read past (the ledger it landed in is not known for an unknown send), so the way forward comes once the balance
    // is read past it, about 90 s on. The assertion is unchanged.
    await tick(100_000);
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out");
    rt.unmount();
  });

  it("the relay never answered (5003, no hash) and the anchor still waits for USDC after two minutes: the person has a way forward", async () => {
    const { rt, world } = await mount({ submit: async () => ({ success: false, error: { code: 5003, message: "Relayer request failed with status 502" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(world.kit.signAndSubmit).toHaveBeenCalledTimes(1);
    await tick(120_000);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment"); // unknown, as designed (the harness works)
    expect(text(rt)).toContain("The anchor is waiting for your USDC."); // and the anchor never moves on
    expect(wayForward(rt)).toBe(true);
    rt.unmount();
  });
});
