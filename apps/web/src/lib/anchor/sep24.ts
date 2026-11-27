// SEP-24 interactive withdraw against the anchor's transfer server. Shapes are
// the ones testanchor.stellar.org answered on 2026-11-27 (test/fixtures/anchor/).

import { CASHOUT_ASSET, INTERACTIVE_HOST_SUFFIX } from "./config";
import { fromStroops, toStroops } from "./amount";
import { AnchorError, RequestTimeout, jsonOf, requestWithin } from "./errors";

export type WithdrawInfo = {
  enabled: boolean;
  min: bigint | null;
  max: bigint | null;
  /** Present only when the anchor publishes its fee in /info. The test anchor does not. */
  feeFixed: bigint | null;
  feePercent: number | null;
  feeMinimum: bigint | null;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const stroopsOf = (v: unknown): bigint | null => {
  const n = num(v);
  return n === null ? null : toStroops(String(n));
};

/** The USDC withdraw entry of the anchor's GET /info answer. */
export function parseInfo(json: unknown): WithdrawInfo {
  const w = (json as { withdraw?: Record<string, Record<string, unknown>> } | null)?.withdraw?.[CASHOUT_ASSET.code];
  if (!w || typeof w !== "object") throw new AnchorError("The test anchor does not offer USDC withdrawals right now.", "anchor-info");
  return {
    enabled: w.enabled === true,
    min: stroopsOf(w.min_amount),
    max: stroopsOf(w.max_amount),
    feeFixed: stroopsOf(w.fee_fixed),
    feePercent: num(w.fee_percent),
    feeMinimum: stroopsOf(w.fee_minimum),
  };
}

export async function loadInfo(transferServer: string, fetchFn: typeof fetch = fetch): Promise<WithdrawInfo> {
  let res;
  try {
    res = await requestWithin(fetchFn, `${transferServer}/info`, { cache: "no-store" });
  } catch (e) {
    if (e instanceof RequestTimeout) throw new AnchorError("The test anchor did not answer within 20 seconds when Caracal read its cash-out limits. Try again in a minute.", "anchor-info");
    throw new AnchorError("Caracal could not reach the test anchor to read its cash-out limits. Check your connection and try again.", "anchor-info");
  }
  if (!res.ok) throw new AnchorError(`The test anchor's cash-out details answered with an error (${res.status}). Try again in a minute.`, "anchor-info");
  return parseInfo(jsonOf(res.text));
}

export type Preview =
  | { ok: false; reason: string }
  | {
      ok: true;
      amount: bigint;
      /** The fee the anchor publishes, or null when it only quotes the fee once you continue. */
      fee: bigint | null;
      /** What arrives after the fee, or null when the fee is not published. */
      arrives: bigint | null;
    };

/** What to show before anything is started: amount, the anchor's published fee, what arrives. */
export function previewWithdraw(amountText: string, info: WithdrawInfo, balance: bigint | null): Preview {
  const amount = toStroops(amountText);
  if (amount === null || amount === BigInt(0)) return { ok: false, reason: "Enter an amount in USDC, with at most 7 decimal places." };
  if (!info.enabled) return { ok: false, reason: "The test anchor has switched USDC withdrawals off." };
  if (info.min !== null && amount < info.min) return { ok: false, reason: `The test anchor's smallest withdrawal is ${fromStroops(info.min)} USDC.` };
  if (info.max !== null && amount > info.max) return { ok: false, reason: `The test anchor's largest withdrawal is ${fromStroops(info.max)} USDC.` };
  if (balance !== null && amount > balance) return { ok: false, reason: `Your wallet holds ${fromStroops(balance)} USDC, which is less than ${fromStroops(amount)} USDC.` };
  let fee: bigint | null = null;
  if (info.feeFixed !== null || info.feePercent !== null) {
    // fee_percent is a percentage with up to 7 places; work in micro-percent to stay exact.
    const pct = info.feePercent === null ? BigInt(0) : BigInt(Math.round(info.feePercent * 1e7));
    fee = (info.feeFixed ?? BigInt(0)) + (amount * pct) / BigInt(1_000_000_000);
    if (info.feeMinimum !== null && fee < info.feeMinimum) fee = info.feeMinimum;
    if (fee >= amount) return { ok: false, reason: "The anchor's fee would take the whole amount. Try a larger amount." };
  }
  return { ok: true, amount, fee, arrives: fee === null ? null : amount - fee };
}

/** An https stellar.org address for the anchor's form: anything else is never opened. */
export function checkInteractiveUrl(url: unknown): string {
  try {
    if (typeof url !== "string") throw new Error("not text");
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.endsWith(INTERACTIVE_HOST_SUFFIX)) throw new Error("not a stellar.org https address");
    return u.toString();
  } catch {
    throw new AnchorError("The test anchor sent a form address Caracal does not trust, so it was not opened. Nothing was started.", "start");
  }
}

/** Start the interactive withdraw. Returns the anchor's transaction id and the form address. */
export async function startWithdraw(
  transferServer: string,
  token: string,
  wallet: string,
  amount: bigint,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string; url: string }> {
  let res;
  try {
    res = await requestWithin(fetchFn, `${transferServer}/transactions/withdraw/interactive`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ asset_code: CASHOUT_ASSET.code, account: wallet, amount: fromStroops(amount), lang: "en" }),
    });
  } catch (e) {
    if (e instanceof RequestTimeout) {
      throw new AnchorError("The test anchor did not answer within 20 seconds when Caracal asked it to start the cash-out. The anchor may have started it. No USDC has been sent. Try again.", "start", true);
    }
    // The anchor may have received it: it is not safe to say nothing was started.
    throw new AnchorError("Caracal lost the connection while starting the cash-out. The anchor may or may not have started it. No USDC has been sent. Check your connection and try again.", "start");
  }
  if (!res.ok) throw new AnchorError(`The test anchor would not start the withdrawal (it answered ${res.status}). No USDC has been sent.`, "start");
  const body = jsonOf(res.text);
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(o.id)) throw new AnchorError("The test anchor's answer had no transaction id. No USDC has been sent.", "start");
  return { id: o.id, url: checkInteractiveUrl(o.url) };
}

/** SEP-24 statuses that will not change again. */
export const FINAL_STATUSES = new Set(["completed", "refunded", "expired", "error", "no_market", "too_small", "too_large"]);

export type AnchorTxn = {
  id: string;
  status: string;
  message: string | null;
  amountIn: string | null;
  /** The asset amount_in is in (SEP-38 id), when the anchor says; absent means the asset the withdraw was started for. */
  amountInAsset?: string | null;
  amountOut: string | null;
  feeTotal: string | null;
  withdrawAnchorAccount: string | null;
  withdrawMemo: string | null;
  withdrawMemoType: string | null;
  stellarTransactionId: string | null;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** The transaction record from GET /transaction. Only what Caracal uses. */
export function parseTransaction(json: unknown): AnchorTxn {
  const t = (json as { transaction?: Record<string, unknown> } | null)?.transaction;
  if (!t || typeof t !== "object" || typeof t.id !== "string" || typeof t.status !== "string") {
    throw new AnchorError("The test anchor's status answer was not in the expected shape.", "status");
  }
  const fee = t.fee_details as { total?: unknown } | undefined;
  return {
    id: t.id,
    status: t.status,
    message: str(t.message),
    amountIn: str(t.amount_in),
    amountInAsset: str(t.amount_in_asset),
    amountOut: str(t.amount_out),
    feeTotal: str(fee?.total),
    withdrawAnchorAccount: str(t.withdraw_anchor_account),
    withdrawMemo: str(t.withdraw_memo),
    withdrawMemoType: str(t.withdraw_memo_type),
    stellarTransactionId: str(t.stellar_transaction_id),
  };
}

export async function loadTransaction(transferServer: string, token: string, id: string, fetchFn: typeof fetch = fetch): Promise<AnchorTxn> {
  let res;
  try {
    res = await requestWithin(fetchFn, `${transferServer}/transaction?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  } catch (e) {
    if (e instanceof RequestTimeout) throw new AnchorError("The test anchor did not answer within 20 seconds when Caracal checked the status. Trying again.", "status", true);
    throw new AnchorError("Caracal could not reach the test anchor to check the status.", "status", true);
  }
  if (res.status === 403 || res.status === 401) throw new AnchorError("The anchor no longer accepts this session, so its status cannot be read here. Your wallet's history shows whether the USDC left.", "status", true);
  if (!res.ok) throw new AnchorError(`The test anchor's status answered with an error (${res.status}).`, "status", true);
  return parseTransaction(jsonOf(res.text));
}

/** What a status means for the person, in plain English. Only "completed" counts as done. */
export function statusText(t: Pick<AnchorTxn, "status" | "message">): string {
  switch (t.status) {
    case "incomplete":
      return "Waiting for you to finish the anchor's form.";
    case "pending_user_transfer_start":
      return "The anchor is waiting for your USDC.";
    case "pending_user_transfer_complete":
    case "pending_anchor":
      return "The anchor received your USDC and is processing the withdrawal.";
    case "pending_stellar":
    case "pending_external":
      return "The anchor is processing the withdrawal.";
    case "pending_user":
    case "pending_trust":
      return "The anchor needs something more from you. Open its form from the anchor's page to see what.";
    case "completed":
      return "The anchor marked the withdrawal complete. On this test anchor that is simulated: no naira reached a bank.";
    case "refunded":
      return "The anchor refunded the withdrawal.";
    case "expired":
      return "The withdrawal expired before it was finished. If USDC left your wallet, ask the anchor about it with the transaction id.";
    case "no_market":
    case "too_small":
    case "too_large":
      return "The anchor could not do this withdrawal at this amount. No USDC was sent unless your wallet history says otherwise.";
    case "error":
      return `The anchor reported an error${t.message ? `: ${t.message}` : ""}. Check your wallet history to see whether USDC left, and keep the transaction id.`;
    default:
      return `The anchor reported a status Caracal does not know (${t.status}). Check with the anchor before doing anything else.`;
  }
}
