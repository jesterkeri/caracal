// Adversary c13: after the anchor refuses the session (401 or 403 on the status read), the confirm
// screen still offers an enabled Send of the stale record it can no longer check.
//
// Spec: docs/decisions.md 2026-11-27 (c5 row): "Send is offered only while the anchor's status is
// pending_user_transfer_start" and Send "is refused if the anchor's record changed" after the page
// showed it. Both promises need the anchor's current record. src/app/cashout/page.tsx tick() stops
// polling on "The anchor no longer accepts this session" and calls it `lostSession`: "the page can no
// longer follow the withdrawal, so it offers a new one". Goal 1 and 4: USDC leaves for a withdrawal
// whose state (expired, replaced, refunded) the page cannot see, and the status on screen is not
// the anchor's current one.
// Cause: the confirm card (page.tsx, the `txn.status === "pending_user_transfer_start"` branch) does not
// look at `lostSession`, and send() pays txnRef.current, which no poll will ever refresh.
//
// Real: the page and src/lib/anchor/*, through the hook runtime. Faked: anchor, kit, popup.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttons, buttonLabels, label, mount, text, tick, toConfirm, unmock } from "./adversary-c2-harness";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  unmock();
});

const enabledSend = (tree: unknown) => buttons(tree).filter((b) => !b.props?.disabled).map(label).filter((l) => /^Send/.test(l));

describe("adversary c13: Send while the anchor no longer accepts the session", () => {
  it("control: with a readable status the confirm screen offers Send", async () => {
    const { rt, world } = await mount();
    await toConfirm(rt, world);
    expect(enabledSend(rt.tree)).toEqual(["Send 2 USDC to the anchor"]);
    rt.unmount();
  });

  it("a 403 on the status read after the confirm screen opened leaves no enabled Send", async () => {
    let code = 200;
    const { rt, world } = await mount({ txnStatusCode: () => code });
    await toConfirm(rt, world);
    code = 403; // the anchor no longer accepts the token
    await tick(3100);
    expect(text(rt)).toMatch(/no longer accepts this session/); // the page knows (the harness works)
    expect(buttonLabels(rt.tree)).toContain("Start another cash-out"); // and says the way forward is a new cash-out
    expect(enabledSend(rt.tree)).toEqual([]);
    rt.unmount();
  });
});
