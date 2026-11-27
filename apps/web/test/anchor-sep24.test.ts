import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkInteractiveUrl, FINAL_STATUSES, loadTransaction, parseInfo, parseTransaction, previewWithdraw, startWithdraw, statusText, type WithdrawInfo } from "../src/lib/anchor/sep24";
import { AnchorError } from "../src/lib/anchor/errors";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/anchor/${name}`, import.meta.url), "utf8")) as unknown;
const WALLET = "CBRHIZOREKRKXYGJUEUDGMOMSCDQF2VDM2ZFJRVR2CVP5YQ3CIKSYSCW";
const SERVER = "https://testanchor.stellar.org/sep24";
const TOKEN = "SECRET-ANCHOR-TOKEN-do-not-leak";
const S = (n: number) => BigInt(n) * BigInt(10_000_000);

describe("the anchor's /info (real answer, 2026-11-27)", () => {
  it("gives USDC withdraw limits and no published fee", () => {
    expect(parseInfo(fixture("sep24-info.json"))).toEqual({ enabled: true, min: S(1), max: S(10), feeFixed: null, feePercent: null, feeMinimum: null });
  });
  it("says so when USDC withdrawals are not offered", () => {
    expect(() => parseInfo({ withdraw: { SRT: { enabled: true } } })).toThrow(/does not offer USDC/);
    expect(() => parseInfo(null)).toThrow(AnchorError);
  });
});

describe("the preview", () => {
  const info = parseInfo(fixture("sep24-info.json"));
  it("shows the amount and says the fee comes from the anchor when /info publishes none", () => {
    expect(previewWithdraw("2", info, S(9))).toEqual({ ok: true, amount: S(2), fee: null, arrives: null });
  });
  it("computes the fee and what arrives when the anchor publishes a fee", () => {
    const priced: WithdrawInfo = { ...info, feeFixed: BigInt(5_000_000), feePercent: 1, feeMinimum: null };
    // 0.5 fixed + 1% of 4 = 0.54
    expect(previewWithdraw("4", priced, null)).toEqual({ ok: true, amount: S(4), fee: BigInt(5_400_000), arrives: BigInt(34_600_000) });
    expect(previewWithdraw("4", { ...priced, feeMinimum: S(1) }, null)).toMatchObject({ fee: S(1), arrives: S(3) });
  });
  it("refuses amounts outside the anchor's limits or the wallet's balance, in plain words", () => {
    expect(previewWithdraw("0.5", info, null)).toEqual({ ok: false, reason: "The test anchor's smallest withdrawal is 1 USDC." });
    expect(previewWithdraw("11", info, null)).toEqual({ ok: false, reason: "The test anchor's largest withdrawal is 10 USDC." });
    expect(previewWithdraw("3", info, S(2))).toEqual({ ok: false, reason: "Your wallet holds 2 USDC, which is less than 3 USDC." });
    expect(previewWithdraw("abc", info, null)).toMatchObject({ ok: false });
    expect(previewWithdraw("0", info, null)).toMatchObject({ ok: false });
    expect(previewWithdraw("2", { ...info, enabled: false }, null)).toMatchObject({ ok: false, reason: expect.stringContaining("switched USDC withdrawals off") });
  });
  it("refuses a fee that takes the whole amount", () => {
    expect(previewWithdraw("2", { ...info, feeFixed: S(2) }, null)).toMatchObject({ ok: false });
  });
  it("uses no em dash in any message", () => {
    const reasons = ["0.5", "11", "abc"].map((a) => (previewWithdraw(a, info, null) as { reason: string }).reason);
    for (const r of reasons) expect(r).not.toContain("—");
  });
});

describe("the anchor's form address", () => {
  it("accepts the real one", () => {
    expect(checkInteractiveUrl("https://anchor-ref-ui-testanchor.stellar.org?transaction_id=abc&token=t")).toMatch(/^https:\/\/anchor-ref-ui-testanchor\.stellar\.org/);
  });
  it("opens nothing else", () => {
    for (const bad of ["http://anchor-ref-ui-testanchor.stellar.org/x", "https://evil.example/x", "https://stellar.org.evil.example/x", "javascript:alert(1)", "data:text/html,hi", "https://u:p@a.stellar.org/", "not a url", undefined, 5, ""]) {
      expect(() => checkInteractiveUrl(bad), String(bad)).toThrow(/does not trust/);
    }
  });
});

function answer(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

describe("starting the interactive withdraw", () => {
  it("posts JSON with the token in a header, never in the address", async () => {
    const calls: [string | URL | Request, RequestInit | undefined][] = [];
    const fetchFn = (async (u: string | URL | Request, i?: RequestInit) => {
      calls.push([u, i]);
      return new Response(JSON.stringify({ type: "interactive_customer_info_needed", url: "https://anchor-ref-ui-testanchor.stellar.org?transaction_id=2ea23fcd&token=short", id: "2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef" }));
    }) as typeof fetch;
    const r = await startWithdraw(SERVER, TOKEN, WALLET, S(2), fetchFn);
    expect(r.id).toBe("2ea23fcd-4ff4-4ce2-bb2e-65b9cac4acef");
    const [url, init] = calls[0]!;
    expect(String(url)).toBe(`${SERVER}/transactions/withdraw/interactive`);
    expect(String(url)).not.toContain(TOKEN);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init!.body))).toEqual({ asset_code: "USDC", account: WALLET, amount: "2", lang: "en" });
  });
  it("names each failure and says no USDC was sent", async () => {
    await expect(startWithdraw(SERVER, TOKEN, WALLET, S(2), answer({}, 500))).rejects.toThrow(/would not start the withdrawal.*500.*No USDC has been sent/);
    await expect(startWithdraw(SERVER, TOKEN, WALLET, S(2), answer({ url: "https://a.stellar.org" }))).rejects.toThrow(/no transaction id/);
    await expect(startWithdraw(SERVER, TOKEN, WALLET, S(2), answer({ id: "abcdefgh12", url: "https://evil.example" }))).rejects.toThrow(/does not trust/);
    const down = (async () => {
      throw new TypeError("x");
    }) as unknown as typeof fetch;
    await expect(startWithdraw(SERVER, TOKEN, WALLET, S(2), down)).rejects.toThrow(/may or may not have started it/);
  });
});

describe("the anchor's transaction record (real answers)", () => {
  it("is read while the form is open, when the anchor wants USDC, and when completed", () => {
    expect(parseTransaction(fixture("txn-incomplete.json")).status).toBe("incomplete");
    const waiting = parseTransaction(fixture("txn-pending-user-transfer-start.json"));
    expect(waiting).toMatchObject({
      status: "pending_user_transfer_start",
      amountIn: "2",
      amountOut: "1.8",
      feeTotal: "0.2",
      withdrawAnchorAccount: "GBN4NNCDGJO4XW4KQU3CBIESUJWFVBUZPOKUZHT7W7WRB7CWOA7BXVQF",
      withdrawMemo: "4845611746035792652",
      withdrawMemoType: "id",
    });
    expect(parseTransaction(fixture("txn-completed.json"))).toMatchObject({ status: "completed", stellarTransactionId: "cb718a8337e23939e52d3c5f4588e000b23ed2f3614a16fca4838889510f6b6d" });
  });
  it("refuses an answer that is not a transaction", () => {
    expect(() => parseTransaction({})).toThrow(AnchorError);
    expect(() => parseTransaction({ transaction: { id: "x" } })).toThrow(AnchorError);
  });
  it("sends the token as a header and reports a refused session as an unknown outcome", async () => {
    const calls: [string | URL | Request, RequestInit | undefined][] = [];
    const f = (async (u: string | URL | Request, i?: RequestInit) => {
      calls.push([u, i]);
      return new Response(JSON.stringify(fixture("txn-completed.json")));
    }) as typeof fetch;
    await loadTransaction(SERVER, TOKEN, "147a673a-618d-48f5-812e-f9828525d9b0", f);
    expect(String(calls[0]![0])).toBe(`${SERVER}/transaction?id=147a673a-618d-48f5-812e-f9828525d9b0`);
    expect(String(calls[0]![0])).not.toContain(TOKEN);
    expect((calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    const err = (await loadTransaction(SERVER, TOKEN, "x", answer({}, 403)).catch((e: unknown) => e)) as AnchorError;
    expect(err.outcomeUnknown).toBe(true);
  });
});

describe("what each status says", () => {
  const all = ["incomplete", "pending_user_transfer_start", "pending_user_transfer_complete", "pending_external", "pending_anchor", "pending_stellar", "pending_trust", "pending_user", "completed", "refunded", "expired", "no_market", "too_small", "too_large", "error"];
  it("calls only 'completed' complete, and says it is simulated", () => {
    for (const status of all) {
      const text = statusText({ status, message: null });
      if (status === "completed") expect(text).toMatch(/marked the withdrawal complete.*simulated.*no naira reached a bank/);
      else expect(text, status).not.toMatch(/marked the withdrawal complete|succe/i);
      expect(text).not.toContain("—");
    }
  });
  it("names an unknown status instead of guessing", () => {
    expect(statusText({ status: "brand_new", message: null })).toContain("brand_new");
  });
  it("shows the anchor's own error message", () => {
    expect(statusText({ status: "error", message: "bank down" })).toContain("bank down");
  });
  it("treats the terminal statuses as final", () => {
    for (const s of ["completed", "refunded", "expired", "error"]) expect(FINAL_STATUSES.has(s)).toBe(true);
    for (const s of ["incomplete", "pending_anchor", "pending_user_transfer_start"]) expect(FINAL_STATUSES.has(s)).toBe(false);
  });
});
