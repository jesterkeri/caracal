// Codex cash-out R1 (external review of 9f70f35), three findings:
//  1. P1: the in-flight payment lock lived only in the page's memory, so a reload, a crash, leaving the page or
//     another tab's account-change reload during a send reset it to a new cash-out while the first payment
//     could still land, and the person could authorize a second payment.
//  2. P1: checkChallenge did not require or verify the anchor's own entry signed by its SIGNING_KEY: a
//     challenge with only the wallet's unsigned entry was accepted and the passkey asked to sign it.
//  3. P2: the status poll accepted a record whose id was another withdrawal's.
import { readFileSync } from "node:fs";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkChallenge, encodeEntries } from "../src/lib/anchor/sep45";
import { loadTransaction } from "../src/lib/anchor/sep24";
import { SEND_LEDGERS, acquireSend, beginSend, sendHold } from "../src/lib/anchor/send-guard";
import { readToml } from "../src/lib/anchor/toml";
import type { Locks } from "../src/lib/auth/creation-lock";
import { ID, WALLET, buttons, challenge, clickButton, fixture, label, mount, pressContinue, text, tick, toConfirm, unmock } from "./adversary-c2-harness";
import { REAL_SIGNING_KEY, TEST_SIGNING_KEY, signAsAnchor, withTestKey } from "./sep45-test-anchor";

const KEY = `caracal.cashout.send.${WALLET}`;

// ---- 1. a payment that may still land survives a reload ----
describe("finding 1: a reload during a send does not offer a second payment", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    unmock();
  });

  /** Presses Send with the passkey prompt (or the relay) never answering, then "reloads": a new page on the same storage. */
  async function reloadMidSend(store: Map<string, string>) {
    const first = await mount({ store, submit: () => new Promise(() => {}) });
    await toConfirm(first.rt, first.world);
    void clickButton(first.rt.tree, /Send 2 USDC/);
    await tick(50);
    first.rt.unmount();
    unmock();
    vi.useFakeTimers();
    const again = await mount({ store });
    await pressContinue(again.rt).catch(() => {});
    await tick(50);
    return again;
  }

  it("control: on a browser with no payment on its way, a new cash-out can start", async () => {
    const { rt, world } = await mount({ store: new Map() });
    await pressContinue(rt);
    await tick(50);
    expect(world.opened).toBe(1);
    rt.unmount();
  });

  it("the reloaded page says the earlier payment may still go through, and does not let a new cash-out start", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await reloadMidSend(store);
    expect(text(rt)).toMatch(/An earlier USDC payment to the anchor from this browser may still go through \(anchor transaction 2ea23fcd/);
    const cont = buttons(rt.tree).find((b) => /Continue to the anchor/.test(label(b)));
    expect(cont?.props?.disabled).toBe(true);
    expect(world.opened).toBe(0);
    rt.unmount();
  });

  // Restated with the ledger-bound send guard (disclosed in docs/decisions.md): the hold ended SETTLE_MS (3 min)
  // after the dead page's last renewal on the browser's clock; it now ends once the network passes the payment's
  // closeBy (the harness's fake RPC closes a ledger every 5 s).
  it("the hold ends once the network passes the payment's last ledger, and a new cash-out can then start", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await reloadMidSend(store);
    await tick((SEND_LEDGERS + 3) * 5_000);
    expect(text(rt)).not.toMatch(/may still go through/);
    void clickButton(rt.tree, /Continue to the anchor/);
    await tick(50);
    expect(world.opened).toBe(1);
    rt.unmount();
  });

  it("a payment proven not sent leaves no hold behind", async () => {
    const store = new Map<string, string>();
    const { rt, world } = await mount({ store, submit: async () => ({ success: false, error: { code: 4004, message: "The passkey prompt was closed" } }) });
    await toConfirm(rt, world);
    void clickButton(rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(text(rt)).toMatch(/You cancelled the passkey prompt\. Nothing was sent\./);
    expect(store.has(KEY)).toBe(false);
    rt.unmount();
  });

  it("a confirmed payment leaves no hold behind; an unknown one does", async () => {
    const sent = new Map<string, string>();
    const a = await mount({ store: sent, submit: async () => ({ success: true, hash: "cb".repeat(32) }) });
    await toConfirm(a.rt, a.world);
    void clickButton(a.rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(sent.has(KEY)).toBe(false);
    a.rt.unmount();
    unmock();
    vi.useFakeTimers();
    const lost = new Map<string, string>();
    const b = await mount({ store: lost, submit: async () => ({ success: false, error: { code: 5003, message: "Relayer request failed with status 502" } }) });
    await toConfirm(b.rt, b.world);
    void clickButton(b.rt.tree, /Send 2 USDC/);
    await tick(100);
    expect(lost.has(KEY)).toBe(true);
    b.rt.unmount();
  });
});

describe("finding 1: the record itself", () => {
  const sharedLocks = (): Locks => {
    const held = new Set<string>();
    return {
      async request(name, _o, cb) {
        if (held.has(name)) return cb(null);
        held.add(name);
        try {
          return await cb({ name });
        } finally {
          held.delete(name);
        }
      },
    };
  };
  const storage = () => {
    const kept = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) } });
    return kept;
  };
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("two tabs pressing Send at the same moment: exactly one goes on", async () => {
    storage();
    const locks = sharedLocks();
    const both = await Promise.all([acquireSend(WALLET, "a", 1000, locks), acquireSend(WALLET, "b", 1000, locks)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
  });

  // Restated with the ledger-bound send guard (disclosed in docs/decisions.md): the record was renewed while the
  // kit's call was pending and held SETTLE_MS after it settled; it now holds through the payment's closeBy, whose
  // passkey signature the network refuses after it, pending or not, and lifts past it.
  it("an unknown payment holds through its closeBy, whatever the clock, and the passkey signs with that expiry", async () => {
    vi.useFakeTimers();
    storage();
    const begun = beginSend(WALLET, ID, 1000);
    if (!begun.ok) throw new Error("should begin");
    expect(begun.guard.closeBy).toBe(1000 + SEND_LEDGERS);
    const signAndSubmit = vi.fn((_tx: unknown, _o: { expiration: number }) => new Promise<never>(() => {}));
    void begun.guard.submit({ signAndSubmit }, { needsNonInvokerSigningBy: () => [WALLET] } as never);
    expect(signAndSubmit.mock.calls[0]![1]).toEqual({ expiration: 1000 + SEND_LEDGERS });
    begun.guard.finish("unknown");
    vi.advanceTimersByTime(30 * 60_000);
    expect(sendHold(WALLET, 1000 + SEND_LEDGERS).held).toBe(true);
    expect(sendHold(WALLET, null).held).toBe(true);
    expect(sendHold(WALLET, 1001 + SEND_LEDGERS).held).toBe(false);
  });

  it("storage that cannot be read holds back; no Web Locks sends nothing", async () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem() {} } });
    expect(sendHold(WALLET, 1000)).toMatchObject({ held: true, reason: "unreadable" });
    storage();
    vi.stubGlobal("navigator", {});
    expect(await acquireSend(WALLET, ID, 1000)).toMatchObject({ ok: false, hold: { reason: "unsupported" } });
  });
});

// ---- 2. the anchor's signature ----
describe("finding 2: the challenge must carry the anchor's signature", () => {
  const toml = readToml(withTestKey(fixture("stellar.toml")));
  const entries = () => [...xdr.SorobanAuthorizationEntries.fromXDR(challenge(), "base64")];

  it("control: the harness challenge, signed by the toml's key, is accepted", () => {
    expect(checkChallenge(challenge(), WALLET, toml).own).toBe(0);
  });

  it("the real anchor's challenge (captured 2026-11-28) passes with its real SIGNING_KEY", () => {
    const real = JSON.parse(readFileSync(new URL("./fixtures/anchor/sep45-challenge.json", import.meta.url), "utf8")) as { authorization_entries: string };
    const realToml = readToml(fixture("stellar.toml"));
    expect(realToml.signingKey).toBe(REAL_SIGNING_KEY);
    expect(checkChallenge(real.authorization_entries, WALLET, realToml).own).toBe(0);
  });

  it("a challenge with only the wallet's unsigned entry is refused before the passkey", () => {
    expect(() => checkChallenge(encodeEntries([entries()[0]!]), WALLET, toml)).toThrow(/not signed by the anchor's published key/);
  });

  it("the anchor's entry left unsigned is refused", () => {
    const [own, anchor] = entries();
    anchor!.credentials().address().signature(xdr.ScVal.scvVoid());
    expect(() => checkChallenge(encodeEntries([own!, anchor!]), WALLET, toml)).toThrow(/not signed by the anchor's published key/);
  });

  it("an entry signed by another key, even claiming the anchor's address, is refused", () => {
    const [own, anchor] = entries();
    signAsAnchor(anchor!, Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)));
    expect(() => checkChallenge(encodeEntries([own!, anchor!]), WALLET, toml)).toThrow(/not signed by the anchor's published key/);
  });

  it("a signature that does not cover the entry as sent (its expiry changed after signing) is refused", () => {
    const [own, anchor] = entries();
    anchor!.credentials().address().signatureExpirationLedger(1);
    expect(() => checkChallenge(encodeEntries([own!, anchor!]), WALLET, toml)).toThrow(/not signed by the anchor's published key/);
  });

  it("a third entry is refused", () => {
    const [own, anchor] = entries();
    expect(() => checkChallenge(encodeEntries([own!, anchor!, anchor!]), WALLET, toml)).toThrow(/not signed by the anchor's published key/);
  });

  it("entries whose calls differ (another nonce) are refused", () => {
    const map = xdr.ScVal.scvMap(
      [["account", WALLET], ["home_domain", "testanchor.stellar.org"], ["nonce", "another"], ["web_auth_domain", "testanchor.stellar.org"], ["web_auth_domain_account", TEST_SIGNING_KEY]].map(
        ([k, v]) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k!), val: xdr.ScVal.scvString(v!) }),
      ),
    );
    const [own, anchor] = entries();
    own!.rootInvocation().function().contractFn().args([map]);
    expect(() => checkChallenge(encodeEntries([own!, anchor!]), WALLET, toml)).toThrow(/different calls or nonces/);
  });
});

// ---- 3. a record for another withdrawal ----
describe("finding 3: the status poll accepts only this withdrawal's record", () => {
  const base = JSON.parse(fixture("txn-pending-user-transfer-start.json")) as { transaction: Record<string, unknown> };
  const answering = (id: string): typeof fetch => (async () => new Response(JSON.stringify({ transaction: { ...base.transaction, id } }))) as unknown as typeof fetch;

  it("control: its own record is read", async () => {
    expect((await loadTransaction("https://a.example/sep24", "TOK", ID, answering(ID))).id).toBe(ID);
  });

  it("another withdrawal's record is refused, as a check to try again", async () => {
    const e = await loadTransaction("https://a.example/sep24", "TOK", ID, answering("ffffffff-0000-0000-0000-000000000000")).catch((x: unknown) => x);
    expect(e).toMatchObject({ step: "status", message: expect.stringMatching(/different withdrawal's record/) });
  });

  it("on the page, another withdrawal's record waiting for USDC does not bring up its Send", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { rt, world } = await mount();
      await pressContinue(rt);
      await tick(50);
      world.txn.id = "ffffffff-0000-0000-0000-000000000000";
      world.txn.status = "pending_user_transfer_start";
      await tick(3100);
      expect(buttons(rt.tree).map(label).join(" | ")).not.toMatch(/Send 2 USDC/);
      expect(text(rt)).toMatch(/different withdrawal's record, so Caracal ignored it/);
      world.txn.id = ID;
      await tick(3100);
      expect(buttons(rt.tree).map(label).join(" | ")).toMatch(/Send 2 USDC/);
      rt.unmount();
    } finally {
      vi.restoreAllMocks();
      unmock();
    }
  });
});
