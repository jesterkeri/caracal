// Adversary c36 #2: after an unknown send, the landing advice says the balance was "read just now" while the
// balance shown is the one read when Send ended, before a late payment could land.
//
// Spec: docs/decisions.md 2026-11-27 c16 row ("the advice to compare balances must not stand over one read before
// a late landing": the balance is read again when the landing window ends, and the page says so only after that
// read) and goal 3 (the page states how fresh the balance is falsely).
// Cause: src/app/cashout/page.tsx. The landing effect (windowOver && !hold.held) calls refreshBalance() and then
// sets `landingOver` when that promise resolves. In the usual order (the 90 s landing window ends before the
// network passes closeBy) it runs in the same render as the stale-balance effect, whose setTimeout(0) calls
// refreshBalance() again. The second call supersedes the first (`mine !== balanceRead.current`), so the first
// resolves WITHOUT showing its balance; the landing effect's `.then` still sets landingOver, and the page prints
// "Your USDC balance was A when you pressed Send and is A now (read just now)" over the old read, with "you can
// start another cash-out", until the second read lands (up to 20 s on a slow RPC).
//
// Assertion: while the newest balance read is still outstanding, the page must not say the balance was read just
// now with the pre-landing figure. Fixes that wait for the newest read before ending the landing window, or that
// do not print the figure until it is shown, pass; only the false "read just now" fails.
//
// Real: the page, src/lib/anchor/*, send-guard, through the c2 hook runtime. Faked: anchor, kit (the relay did not
// answer: code 5003, no hash), the wallet's balance (a controllable slow second read).
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

const relayDidNotAnswer = { success: false, error: { code: 5003, message: "Relayer request failed with status 502" } };
const PAST = "can no longer reach the network";
const BEFORE = BigInt(900_000_000); // 90 USDC
const AFTER = BigInt(880_000_000); // 88 USDC: the 2 USDC payment landed late

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("adversary c36: the landing advice's 'read just now' balance", () => {
  it("control: once the newest read lands, the page shows the current balance and the advice", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => BEFORE);
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment");
    world.kit.readBalance.mockImplementation(async () => AFTER); // the payment lands late; the anchor does not notice
    await tick(130_000);
    expect(text(rt)).toContain(PAST);
    expect(text(rt)).toContain("USDC in the wallet: 88 USDC");
    rt.unmount();
  });

  it("the advice is not printed over the old balance while the read after closeBy is still outstanding", async () => {
    const { rt, world } = await mount({ submit: async () => relayDidNotAnswer });
    world.kit.readBalance.mockImplementation(async () => BEFORE);
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(50);
    expect(text(rt)).toContain("Caracal could not confirm the USDC payment");
    expect(text(rt)).toContain("USDC in the wallet: 90 USDC"); // read when the send ended, before the payment landed
    await tick(60_000);
    // From here on, the first read after the landing window answers the old figure after 100 ms; every later
    // read (the one that runs when the network passes closeBy) answers the real, lower one after 8 s.
    let reads = 0;
    world.kit.readBalance.mockImplementation(async () => {
      reads++;
      if (reads === 1) {
        await sleep(100);
        return BEFORE;
      }
      await sleep(8_000);
      return AFTER;
    });
    let seen = "";
    for (let i = 0; i < 2600 && !seen; i++) {
      await tick(50);
      if (text(rt).includes(PAST)) seen = text(rt);
    }
    expect(seen, "the page never reached the landing advice").not.toBe("");
    expect(reads, "two overlapping balance reads were expected").toBeGreaterThanOrEqual(2);
    expect(world.txn.status).toBe("pending_user_transfer_start");
    // The newest read (88 USDC) has not landed yet: nothing on screen may claim the old 90 was read just now.
    expect(seen).not.toMatch(/is 90 USDC now \(read just now\)/);
    rt.unmount();
  });
});
