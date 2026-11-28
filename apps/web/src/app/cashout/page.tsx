"use client";

import { useEffect, useRef, useState } from "react";
import type { contract } from "@stellar/stellar-sdk";
import { followAccount, readSignInState } from "@/lib/auth/account";
import { browserStore, mayRestoreWallet } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { explorerLink } from "@/lib/stellar/config";
import { fromStroops } from "@/lib/anchor/amount";
import { CASHOUT_ASSET, SIMULATION_NOTE, STAMP_DUTY_NOTE } from "@/lib/anchor/config";
import { AnchorError, messageOf } from "@/lib/anchor/errors";
import { beginCashout, sendToAnchor, type SendDeps } from "@/lib/anchor/flow";
import { FINAL_STATUSES, loadInfo, loadTransaction, previewWithdraw, statusText, type AnchorTxn, type WithdrawInfo } from "@/lib/anchor/sep24";
import { loadToml, type AnchorToml } from "@/lib/anchor/toml";
import { acquireSend, anchorReceived, holdText, readLedger, sendHold, type Hold } from "@/lib/anchor/send-guard";
import { buildAnchorTransfer, paymentFor, readUsdcBalance } from "@/lib/anchor/transfer";

type Kit = Awaited<ReturnType<typeof getKit>>;
type Boot =
  | { kind: "loading" }
  | { kind: "no-wallet" }
  | { kind: "error"; message: string }
  | { kind: "ready"; wallet: string };
type Phase = "preview" | "starting" | "form" | "confirm" | "sending" | "watching";
type Session = { token: string; id: string; url: string };

const POLL_MS = 3000;
const RESTORE_MS = 20_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The unit an anchor amount is in: USDC when the anchor names Circle testnet USDC or no asset, else its own id. */
/** Whether the anchor asks for Circle testnet USDC (or names no asset): the only payment the page can make. */
function paidInUsdc(txn: { amountInAsset?: string | null }): boolean {
  return txn.amountInAsset == null || txn.amountInAsset === CASHOUT_ASSET.id;
}

function assetLabel(asset: string | null | undefined): string {
  return asset == null || asset === CASHOUT_ASSET.id ? "USDC" : `(in ${asset})`;
}

/** The unit of what arrives: a currency code for an iso4217 id, USDC for the cash-out asset, else the anchor's id (adversary c24). */
function payoutUnit(asset: string | null | undefined): string {
  if (asset == null) return "unit not stated";
  if (asset === CASHOUT_ASSET.id) return "USDC";
  const iso = /^iso4217:([A-Z]{3})$/.exec(asset);
  return iso ? iso[1] : `in ${asset}`;
}

/**
 * What the person confirms on the confirm screen: where the payment goes (the anchor's account and memo) and
 * the anchor's quote (the amount it wants and in what, its fee and in what, and what arrives). Send is refused
 * when any of it changed after it was shown (c5 for the account and memo, adversary c11 for the quote).
 */
function payTo(t: AnchorTxn): string {
  return JSON.stringify([
    t.withdrawAnchorAccount ?? null,
    t.withdrawMemoType ?? null,
    t.withdrawMemo ?? null,
    t.amountIn ?? null,
    t.amountInAsset ?? null,
    t.feeTotal ?? null,
    t.feeAsset ?? null,
    t.amountOut ?? null,
    t.amountOutAsset ?? null,
  ]);
}

/** Why Send would refuse this record (paymentFor's own text), or null when it would pay it. */
function unpayable(t: AnchorTxn, confirmed: bigint | null): string | null {
  if (confirmed === null) return "Caracal lost the amount you confirmed, so it cannot pay this cash-out, and this page sent nothing. Start again.";
  try {
    paymentFor(t, confirmed);
    return null;
  } catch (e) {
    return e instanceof AnchorError ? e.message : "Caracal cannot pay this cash-out as the anchor asks, and this page sent nothing. Start again.";
  }
}

/** After the kit's send settled, how long an unconfirmed payment can still land (see unknownWaiting). */
const LAND_WINDOW_MS = 90_000;
/** How long Send waits to read the balance at the press before sending without it (adversary c19). */
const BALANCE_AT_SEND_MS = 10_000;

/** Statuses whose text tells the person to open the anchor's form. */
const FORM_STATUSES = new Set(["pending_user", "pending_trust"]);
/** Non-final statuses where waiting is the right thing and the status text says so. */
const WAIT_STATUSES = new Set(["pending_user_transfer_start", "pending_user_transfer_complete", "pending_anchor", "pending_stellar", "pending_external", ...FORM_STATUSES]);

export default function CashoutPage() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });
  const [toml, setToml] = useState<AnchorToml | null>(null);
  const [info, setInfo] = useState<WithdrawInfo | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [amountText, setAmountText] = useState("");
  const [phase, setPhase] = useState<Phase>("preview");
  const [session, setSession] = useState<Session | null>(null);
  // Why the anchor's form is not in the pop-up: the browser refused to open one, or the person closed it.
  const [popupNote, setPopupNote] = useState<"blocked" | "closed" | null>(null);
  const [confirmed, setConfirmed] = useState<bigint | null>(null);
  const [txn, setTxn] = useState<AnchorTxn | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pollNote, setPollNote] = useState<string | null>(null);
  const [sentHash, setSentHash] = useState<string | null>(null);
  /** A send whose outcome is unknown, with or without a hash: the anchor's status decides (adversary c13, c14). */
  const [unknownSend, setUnknownSend] = useState(false);
  /** The send was confirmed on chain (not merely given a hash). */
  const [sendConfirmed, setSendConfirmed] = useState(false);
  /** The outcome was unknown while the kit's send had not settled, and it still has not, LAND_WINDOW_MS later. */
  const [stalled, setStalled] = useState(false);
  /** When the kit's signAndSubmit for this page's send settled (resolved or threw), on Date.now(). */
  const [sendSettledAt, setSendSettledAt] = useState<number | null>(null);
  /** The USDC balance shown when Send was pressed, to compare with after an unknown send. */
  const [balanceBeforeSend, setBalanceBeforeSend] = useState<bigint | null>(null);
  /** LAND_WINDOW_MS has passed since sendSettledAt (set by a timer, see unknownWaiting). */
  const [landingOver, setLandingOver] = useState(false);
  /**
   * The latest ledger read while an earlier payment holds this wallet: the hold lifts once it passes the
   * payment's closeBy (send-guard.ts). null until read, or when it cannot be read, and the hold then stays.
   */
  const [seenLedger, setSeenLedger] = useState<number | null>(null);
  /** LAND_WINDOW_MS has passed since the send settled; landingOver also waits for the hold to lift (see below). */
  const [windowOver, setWindowOver] = useState(false);
  const kitRef = useRef<Kit | null>(null);
  const popupRef = useRef<Window | null>(null);
  // One send per anchor transaction: set the moment the passkey prompt is asked for.
  const sendingFor = useRef<string | null>(null);
  // The newest record from the anchor, read the moment Send is pressed.
  const txnRef = useRef<AnchorTxn | null>(null);
  /** The account and memo on screen when the person reached the confirm step (or last confirmed again). */
  const seenRef = useRef<string | null>(null);
  const walletRef = useRef<string | null>(null);
  const balanceRead = useRef(0);

  // The wallet's USDC balance, read again whenever it may have changed. A slow
  // older read never overwrites a newer one, and a failed read shows "not available"
  // rather than an old number the preview would check against.
  // Resolves once this read has finished (shown, or superseded by a newer one).
  function refreshBalance(): Promise<void> {
    const kit = kitRef.current;
    const wallet = walletRef.current;
    if (!kit || !wallet) return Promise.resolve();
    const mine = ++balanceRead.current;
    return readUsdcBalance(wallet, kit.rpc).then((b) => {
      if (mine === balanceRead.current) setBalance(b);
    });
  }

  // The wallet: restored only for the signed-in account that created or connected it.
  useEffect(() => {
    let gone = false;
    let unfollow: (() => void) | undefined;
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const now = await readSignInState(auth);
      if (now.kind === "signed-out") return window.location.replace("/signin");
      if (now.kind === "unverified") throw new Error("the sign-in could not be verified");
      unfollow = followAccount(auth, now.id, () => window.location.reload());
      const kit = await within(getKit(), RESTORE_MS);
      kitRef.current = kit;
      if (!(await mayRestoreWallet(browserStore, kit, now.id))) return gone ? undefined : setBoot({ kind: "no-wallet" });
      const r = await within(kit.connectWallet(), RESTORE_MS);
      if (gone) return;
      if (!r) return setBoot({ kind: "no-wallet" });
      walletRef.current = r.contractId;
      setBoot({ kind: "ready", wallet: r.contractId });
      // The anchor's details and the wallet's balance: each failure is named on its own.
      loadToml()
        .then(async (t) => {
          setToml(t);
          setInfo(await loadInfo(t.transferServer));
        })
        .catch((e: unknown) => !gone && setInfoError(e instanceof AnchorError ? e.message : "Caracal could not read the test anchor's cash-out details. Reload the page to try again."));
      refreshBalance();
    })().catch((e: unknown) => {
      console.error("could not open the cash-out page:", messageOf(e));
      if (gone) return;
      const message = messageOf(e) === HTTPS_RPC_REQUIRED ? HTTPS_RPC_REQUIRED : "Caracal could not load your wallet. Check your connection and reload the page.";
      setBoot({ kind: "error", message });
    });
    return () => {
      gone = true;
      unfollow?.();
    };
  }, []);

  const wallet = boot.kind === "ready" ? boot.wallet : null;
  // Watch the anchor's record of the withdrawal. The anchor's status is the truth.
  useEffect(() => {
    if (!session || !toml || !["form", "confirm", "sending", "watching"].includes(phase)) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const t = await loadTransaction(toml.transferServer, session.token, session.id);
        if (stop) return;
        setPollNote(null);
        txnRef.current = t;
        setTxn(t);
        // A "may still go through" warning from the send is settled once the anchor says it finished, and the
        // record holding back a new cash-out goes: the anchor received the payment, so its outcome is certain.
        if (t.status === "completed" || t.status === "refunded") {
          setProblem(null);
          if (wallet) anchorReceived(wallet, t.id);
        }
        if (phase === "form" && t.status === "pending_user_transfer_start") {
          seenRef.current = payTo(t);
          setPhase("confirm");
          popupRef.current?.close();
        }
        if (FINAL_STATUSES.has(t.status)) return;
      } catch (e) {
        if (stop) return;
        setPollNote(e instanceof AnchorError ? e.message : "Caracal could not read the anchor's status.");
        if (e instanceof AnchorError && e.message.startsWith("The anchor no longer accepts")) return;
      }
      timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [phase, session, toml, wallet]);

  // The balance changes when the anchor's status changes (the USDC arrives, a refund lands).
  useEffect(() => {
    if (txn) refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn?.status]);

  const preview = info ? previewWithdraw(amountText, info, balance) : null;

  async function start() {
    const kit = kitRef.current;
    if (boot.kind !== "ready" || !kit || !toml || !preview?.ok) return;
    // An earlier payment from this browser (this page before a reload, or another tab) may still land.
    const held = sendHold(boot.wallet, seenLedger);
    if (held.held) return setProblem(holdText(held));
    setProblem(null);
    setPopupNote(null);
    setPhase("starting");
    // The popup is opened now, inside the click, so the browser allows it. It
    // is pointed at the anchor's form once the anchor has started the withdrawal.
    popupRef.current = window.open("", "caracal-anchor", "popup,width=480,height=760");
    // The popup is about to show the anchor's own site: it gets no handle back to this page.
    // ("noopener" in the features would make window.open return null, and the popup could not be pointed at the form.)
    if (popupRef.current) {
      try {
        popupRef.current.opener = null;
      } catch {
        // a browser that refuses this keeps the popup as it is
      }
    }
    try {
      const r = await beginCashout(boot.wallet, toml, preview.amount, {
        fetchFn: (input, init) => fetch(input, init),
        signAuthEntry: (entry, options) => kit.signAuthEntry(entry, options),
        latestLedger: async () => (await kit.rpc.getLatestLedger()).sequence,
      });
      setConfirmed(preview.amount);
      setSession(r);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.location.href = r.url;
      else setPopupNote(popupRef.current ? "closed" : "blocked");
      setPhase("form");
    } catch (e) {
      popupRef.current?.close();
      setProblem(e instanceof AnchorError ? e.message : "Something went wrong starting the cash-out. Nothing was sent.");
      setPhase("preview");
    }
  }

  async function send() {
    const kit = kitRef.current;
    if (boot.kind !== "ready" || !kit || !txn || confirmed === null || sendingFor.current === txn.id) return;
    // The anchor refused this session: the record on screen can no longer be followed, so it is not paid (adversary c13).
    if (lostSession) return;
    // The account, memo and quote the person was shown must be the ones the anchor still has.
    // The poll keeps the screen on the anchor's latest record, so the comparison is with what was on screen
    // when the person reached this step, not with the record the poll last wrote.
    const latest = txnRef.current ?? txn;
    if (seenRef.current !== payTo(latest)) {
      seenRef.current = payTo(latest);
      setTxn(latest);
      setProblem("The anchor changed the account, memo or quote after you looked at it. Nothing was sent. Check the details above and confirm again.");
      return;
    }
    sendingFor.current = txn.id;
    // From the press on, the page is sending: "Start again" goes at once, not only once the payment is built,
    // or pressing it during the ledger read left the page with no record and no control (adversary c28).
    setPhase("sending");
    // The balance at the press, read now: the last one on screen may predate USDC that arrived since, and the
    // landing advice compares against it (adversary c19). A failed or slow read leaves it unknown, and the advice
    // then says to check the wallet's history instead. Started before anything else is awaited.
    const balanceAtPress = within(readUsdcBalance(boot.wallet, kit.rpc), BALANCE_AT_SEND_MS).catch(() => null);
    // The payment's last ledger is fixed from the ledger read now, before the passkey is asked (send-guard.ts).
    let ledger: number;
    try {
      ledger = await readLedger(kit.rpc);
    } catch {
      sendingFor.current = null;
      setProblem("Caracal could not read the Stellar network, so nothing was sent. Check your connection and try again.");
      setPhase("confirm");
      return;
    }
    setSeenLedger(ledger);
    // Recorded in this browser before the passkey is asked, so a reload, a crash or another tab cannot start a
    // second payment while this one may still land (Codex cash-out R1 #1, send-guard.ts).
    const begun = await acquireSend(boot.wallet, latest.id, ledger);
    if (!begun.ok) {
      sendingFor.current = null;
      setProblem(holdText(begun.hold));
      setPhase("confirm");
      return;
    }
    const guard = begun.guard;
    setProblem(null);
    // Each attempt has its own landing window: an earlier attempt's (proven not sent, so the lock was released)
    // must not count for this one (adversary c15).
    setUnknownSend(false);
    setStalled(false);
    setSendSettledAt(null);
    setLandingOver(false);
    setWindowOver(false);
    setBalanceBeforeSend(null);
    setPhase("sending");
    setBalanceBeforeSend(await balanceAtPress);
    const deps: SendDeps = {
      buildTransfer: (payment) => buildAnchorTransfer(boot.wallet, payment, kit.rpc),
      // The passkey signature expires at the payment's closeBy (send-guard.ts submit).
      signAndSubmit: (tx) =>
        guard.submit(kit, tx as contract.AssembledTransaction<unknown>).finally(() => {
          setSendSettledAt(Date.now());
        }),
      // The poll kept the record current while the balance was read and the payment built: the passkey is
      // asked only for the record the person confirmed, while the anchor still waits for it (adversary c23).
      stillCurrent: () => {
        const now = txnRef.current;
        if (!now || now.id !== latest.id || now.status !== "pending_user_transfer_start") {
          return "The anchor stopped waiting for this payment while Caracal was preparing it, so nothing was sent. Its status is shown below.";
        }
        if (payTo(now) !== seenRef.current) {
          seenRef.current = payTo(now);
          setTxn(now);
          return "The anchor changed the account, memo or quote while Caracal was preparing the payment. Nothing was sent. Check the details above and confirm again.";
        }
        return null;
      },
    };
    let r: Awaited<ReturnType<typeof sendToAnchor>>;
    try {
      r = await sendToAnchor(latest, confirmed, deps);
    } catch (e) {
      console.error("USDC payment:", messageOf(e));
      r = { kind: "unknown", message: "Something went wrong while sending the USDC and Caracal cannot tell whether it left your wallet. The anchor's status below shows whether it arrived. Do not send it again." };
    }
    if (r.kind !== "not-sent" && r.hash) guard.noteHash(r.hash);
    guard.finish(r.kind);
    refreshBalance();
    if (r.kind === "sent") {
      setSentHash(r.hash);
      setSendConfirmed(true);
      setPhase("watching");
    } else if (r.kind === "unknown") {
      // Never sent twice: the sending lock stays, and the anchor's status decides.
      if (r.hash) setSentHash(r.hash);
      setUnknownSend(true);
      setProblem(r.message);
      setPhase("watching");
    } else {
      sendingFor.current = null;
      setProblem(r.message);
      setPhase("confirm");
    }
  }

  function startAgain() {
    // A withdrawal that was not paid is never reused: the next one starts from a new sign-in.
    popupRef.current?.close();
    setSession(null);
    setTxn(null);
    txnRef.current = null;
    seenRef.current = null;
    setConfirmed(null);
    setSentHash(null);
    setUnknownSend(false);
    setSendConfirmed(false);
    setStalled(false);
    setSendSettledAt(null);
    setLandingOver(false);
    setWindowOver(false);
    setProblem(null);
    setPollNote(null);
    setPopupNote(null);
    sendingFor.current = null;
    setPhase("preview");
    refreshBalance();
  }

  const done = txn !== null && FINAL_STATUSES.has(txn.status);
  // The anchor refused this sign-in for status reads: the page can no longer follow the withdrawal, so it offers a new one.
  const lostSession = pollNote !== null && pollNote.startsWith("The anchor no longer accepts");
  // An unknown send with no hash while the anchor still waits for USDC. Once the kit's send has settled, the
  // payment can land only while the relay may still send it (its 60 s deadline from receipt) and the
  // transaction it built is valid (25 s), both started before the send settled: LAND_WINDOW_MS after it,
  // a payment the anchor still has not seen did not arrive, and a new cash-out cannot pay this one twice.
  const unknownWaiting = phase === "watching" && unknownSend && txn?.status === "pending_user_transfer_start";
  const pastLanding = unknownWaiting && landingOver;
  // A send still unsettled LAND_WINDOW_MS after its outcome was called unknown (the page's 5 minute limit) has
  // no bound the page can wait out: it may still be in the passkey prompt. The page then stops promising a new
  // cash-out and says to reload, which ends it (adversary c14).
  useEffect(() => {
    if (!unknownSend || sendSettledAt !== null) return;
    const t = setTimeout(() => setStalled(true), LAND_WINDOW_MS);
    return () => clearTimeout(t);
  }, [unknownSend, sendSettledAt]);
  useEffect(() => {
    if (sendSettledAt === null) return;
    const t = setTimeout(() => setWindowOver(true), Math.max(0, sendSettledAt + LAND_WINDOW_MS - Date.now()));
    return () => clearTimeout(t);
  }, [sendSettledAt]);
  // An earlier payment from this browser that may still land (read on every render, so another tab's or one
  // from before a reload counts). Its ledger is read every few seconds while it holds, so the hold lifts once
  // the network passes the payment's closeBy.
  const hold: Hold = boot.kind === "ready" ? sendHold(boot.wallet, seenLedger) : { held: false };
  useEffect(() => {
    if (!hold.held) return;
    let gone = false;
    const look = () => {
      const kit = kitRef.current;
      if (!kit) return;
      readLedger(kit.rpc)
        .then((n) => !gone && setSeenLedger(n))
        .catch(() => !gone && setSeenLedger(null));
    };
    look();
    const t = setInterval(look, 5_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [hold.held]);
  // The payment can no longer land once the landing window is over AND the network has passed its closeBy
  // (the hold has lifted): only the ledger proves it, and the page never offers what the hold would refuse
  // (adversary c27). The balance is read again then, and the page says so only after that read: the advice to
  // compare balances must not stand over one read before a late landing (adversary c16).
  useEffect(() => {
    if (!windowOver || hold.held || landingOver) return;
    let gone = false;
    void refreshBalance()
      .catch(() => {})
      .then(() => {
        if (!gone) setLandingOver(true);
      });
    return () => {
      gone = true;
    };
  }, [windowOver, hold.held, landingOver]);
  // An unknown payment the anchor has not reported received may still land until the landing window ends.
  // No new cash-out is offered before then, whatever else happened (a lost session, a final status), because
  // a second payment could then pay the anchor twice (adversary c18). Only "completed" and "refunded" prove
  // the anchor received the first one.
  const mayStillLand =
    phase === "watching" && unknownSend && !landingOver && !(txn !== null && (txn.status === "completed" || txn.status === "refunded"));
  // Never while the USDC payment is being sent: starting again then would lose track of it; never while the
  // hold would refuse the new one (adversary c27).
  const canStartAnother = (done || lostSession || pastLanding) && !mayStillLand && phase !== "sending" && !hold.held;

  return (
    <main className="page">
      <h1 className="h1">Cash out</h1>
      <p className="notice">{SIMULATION_NOTE}</p>

      {boot.kind === "loading" && <p className="muted">Opening your wallet...</p>}
      {boot.kind === "error" && <p className="msg msg-bad">{boot.message}</p>}
      {boot.kind === "no-wallet" && (
        <p className="msg msg-info">
          Caracal has no wallet open for this account on this browser. <a className="link" href="/wallet">Open or create your wallet</a>, then come back.
        </p>
      )}

      {boot.kind === "ready" && (
        <>
          <div className="card num gap-2">
            Wallet: <span className="addr addr-box">{boot.wallet}</span>
            <br className="hidden" />
            USDC in the wallet: {balance === null ? "not available right now" : `${fromStroops(balance)} USDC`}
          </div>
          {infoError && <p className="msg msg-bad">{infoError}</p>}
          {!infoError && !info && <p className="muted small">Reading the anchor&apos;s limits...</p>}

          {info && phase === "preview" && (
            <div className="card">
              <label className="field">
                Amount to cash out, in USDC
                <input
                  className="input money-lg num min-h-16"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="2"
                />
              </label>
              {amountText.trim() !== "" && preview && !preview.ok && <p className="msg msg-bad">{preview.reason}</p>}
              {preview?.ok && (
                <dl className="kv card-sunken num gap-0 py-1">
                  <div className="kv-row">
                  <dt>You send</dt>
                  <dd className="text-right">{fromStroops(preview.amount)} USDC</dd>
                  </div>
                  <div className="kv-row">
                  <dt>Anchor fee</dt>
                  <dd className="text-right">{preview.fee === null ? "Quoted by the anchor in its form" : `${fromStroops(preview.fee)} USDC`}</dd>
                  </div>
                  <div className="kv-row kv-total [&>dd]:font-semibold">
                  <dt>Arrives</dt>
                  <dd className="text-right">{preview.arrives === null ? "Shown after the anchor quotes its fee" : `${fromStroops(preview.arrives)} USDC`}</dd>
                  </div>
                </dl>
              )}
              {hold.held && <p className="msg msg-unsure">{holdText(hold)}</p>}
              <button className="btn btn-primary btn-block" disabled={!preview?.ok || hold.held} onClick={start}>
                Continue to the anchor
              </button>
              <p className="muted small">
                Next, your passkey signs you in to the anchor (it cannot move money), then the anchor&apos;s own form opens in a pop-up. Nothing is sent from your wallet until you confirm the anchor&apos;s quote here.
              </p>
            </div>
          )}

          {phase === "starting" && <p className="msg msg-info">Signing in to the anchor with your passkey...</p>}

          {phase === "form" && session && !done && !lostSession && (
            <div className="flex flex-col gap-3">
              <div className="msg msg-info">
              <p>Finish the anchor&apos;s form in the pop-up window. This page moves on by itself when the anchor is ready for your USDC.</p>
              </div>
              <div className="msg msg-unsure empty:hidden">
              {popupNote === "blocked" && <p>Your browser blocked the pop-up.</p>}
              {popupNote === "closed" && <p>The pop-up was closed before the anchor&apos;s form could open in it.</p>}
              </div>
              <p className="muted small flex flex-col items-center gap-2 text-center">
                <a className="btn btn-secondary btn-block" href={session.url} target="_blank" rel="noopener noreferrer">
                  Open the anchor&apos;s form
                </a>{" "}
                if you closed the pop-up.
              </p>
            </div>
          )}

          {(phase === "confirm" || phase === "sending") && txn && (
            <div className="card">
              <dl className="kv num">
                <div className="kv-row">
                <dt>The anchor wants</dt>
                <dd className="text-right">{txn.amountIn ?? "?"} {assetLabel(txn.amountInAsset)}</dd>
                </div>
                <div className="kv-row">
                <dt>Anchor fee</dt>
                <dd className="text-right">{txn.feeTotal === null ? "not stated" : `${txn.feeTotal} ${assetLabel(txn.feeAsset)}`}</dd>
                </div>
                <div className="kv-row kv-total [&>dd]:font-semibold">
                <dt>Arrives ({payoutUnit(txn.amountOutAsset)})</dt>
                <dd className="text-right">{txn.amountOut ?? "not stated"} (simulated)</dd>
                </div>
                <div className="kv-row flex-col items-stretch gap-2">
                <dt>Pay to account</dt>
                <dd className="addr addr-box text-left font-normal">{txn.withdrawAnchorAccount ?? "not stated"}</dd>
                </div>
                <div className="kv-row">
                <dt>Memo ({txn.withdrawMemoType ?? "none"})</dt>
                <dd className="addr">{txn.withdrawMemo ?? "not stated"}</dd>
                </div>
              </dl>
              {phase !== "sending" && !paidInUsdc(txn) ? (
                // paymentFor refuses any other asset, so no Send is offered for one.
                <p className="msg msg-bad">The anchor asks to be paid in {txn.amountInAsset}, not Circle testnet USDC, so Caracal cannot pay this cash-out, and this page sent nothing. Start again for a new one.</p>
              ) : phase !== "sending" && lostSession ? (
                // The anchor refused this session: its latest record cannot be read, so this one is not paid (adversary c13).
                <p className="msg msg-bad">The anchor no longer lets Caracal follow this withdrawal, so Caracal cannot see its latest terms and does not offer to pay it. Nothing was sent. Start another cash-out.</p>
              ) : phase !== "sending" && txn.status === "pending_user_transfer_start" && unpayable(txn, confirmed) !== null ? (
                // The anchor asks for a payment Send would refuse (a memo a smart wallet cannot carry, or another
                // amount than the one confirmed): no Send is offered, only the reason (adversary c12, as c8 for an asset).
                <p className="msg msg-bad">{unpayable(txn, confirmed)}</p>
              ) : txn.status === "pending_user_transfer_start" || phase === "sending" ? (
                <button className="btn btn-primary btn-block" disabled={phase === "sending"} onClick={send}>
                  {phase === "sending" ? "Waiting for your passkey..." : `Send ${txn.amountIn ?? ""} USDC to the anchor`}
                </button>
              ) : session && (FORM_STATUSES.has(txn.status) || txn.status === "incomplete") ? (
                // The anchor went back to its form (adversary c10): the form is the way forward, and once the anchor
                // takes a payment again, Send is offered here again.
                <>
                  <p className="msg msg-bad">The anchor no longer takes a payment for this cash-out, and this page sent none. {statusText(txn)} When the anchor is ready for your USDC again, this page offers to send it.</p>
                  <a className="btn btn-secondary btn-block" href={session.url} target="_blank" rel="noopener noreferrer">
                    Open the anchor&apos;s form
                  </a>
                </>
              ) : (
                <p className="msg msg-bad">The anchor no longer takes a payment for this cash-out, and this page sent none. {statusText(txn)} Start again for a new one.</p>
              )}
              <p className="muted small">Caracal pays the network fee. Your passkey confirms this one payment.</p>
              {phase === "confirm" && (
                <button className="btn btn-secondary btn-block" onClick={startAgain}>
                  Start again
                </button>
              )}
            </div>
          )}

          {problem && <p className={phase === "watching" ? "msg msg-unsure" : "msg msg-bad"}>{problem}</p>}

          {txn && (phase === "watching" || done) && (
            <div className="card">
              <p className={txn.status === "completed" ? "font-semibold" : ""}>{statusText(txn, sendConfirmed)}</p>
              {sentHash && (
                <a className="addr link" href={explorerLink("tx", sentHash)} target="_blank" rel="noopener noreferrer">
                  USDC payment on Stellar: {sentHash}
                </a>
              )}
              <p className="addr muted">Anchor transaction id: {txn.id}</p>
              {txn.status === "completed" && txn.amountOut && <p>The anchor recorded {txn.amountOut} as paid out (simulated).</p>}
            </div>
          )}
          {txn && phase === "watching" && !done && session && FORM_STATUSES.has(txn.status) && (
            <a className="btn btn-secondary btn-block" href={session.url} target="_blank" rel="noopener noreferrer">
              Open the anchor&apos;s form
            </a>
          )}
          {txn && phase === "watching" && !done && !FORM_STATUSES.has(txn.status) && !WAIT_STATUSES.has(txn.status) && (
            <p className="msg msg-unsure">
              {session && txn.status === "incomplete"
                ? "The anchor still shows its form as unfinished. Open the form to finish it. This page sends no second payment."
                : "Caracal does not know what to do with this status. Check with the anchor using the transaction id above. This page sends no second payment."}
            </p>
          )}
          {txn && phase === "watching" && !done && session && txn.status === "incomplete" && (
            <a className="btn btn-secondary btn-block" href={session.url} target="_blank" rel="noopener noreferrer">
              Open the anchor&apos;s form
            </a>
          )}
          {unknownWaiting && (
            <p className="msg msg-unsure">
              {pastLanding
                ? `${
                    lostSession
                      ? "Caracal can no longer read the anchor's status"
                      : "The anchor still has not received the USDC"
                  }, and the payment can no longer reach the network. ${
                    balanceBeforeSend !== null && balance !== null
                      ? `Your USDC balance was ${fromStroops(balanceBeforeSend)} USDC when you pressed Send and is ${fromStroops(balance)} USDC now (read just now). `
                      : "Caracal could not read your USDC balance just now, so check your wallet's history first. "
                  }If it did not drop and no other USDC came in meanwhile, the payment did not go through and you can start another cash-out. If it dropped, or other USDC came in, check your wallet's history first, and ask the anchor about a payment it did not record with the transaction id.`
                : stalled && sendSettledAt === null
                  ? "The payment has still not finished sending, so Caracal cannot tell when it stops being able to land. Reload this page, which stops it, then wait two minutes and check your USDC balance above before starting another cash-out."
                  : "The payment can still reach the network for a short while. If the anchor still has not received it then, this page offers to start another cash-out. If the page stops changing, reload it and check your USDC balance before starting again."}
            </p>
          )}
          {mayStillLand && !unknownWaiting && (done || lostSession) && (
            <p className="msg msg-unsure">
              {stalled && sendSettledAt === null
                ? "The USDC payment has still not finished sending, so Caracal cannot tell when it stops being able to land. Reload this page, which stops it, then wait two minutes and check your USDC balance above before starting another cash-out."
                : "Caracal could not confirm the USDC payment, and it can still reach the network for a short while. This page offers to start another cash-out once it no longer can."}
            </p>
          )}
          {pollNote && <p className="msg msg-unsure">{pollNote}</p>}
          {canStartAnother && (
            <button
              className="btn btn-secondary btn-block"
              onClick={startAgain}
            >
              Start another cash-out
            </button>
          )}
        </>
      )}

      <p className="notice small [&>span]:mt-2 [&>span]:block [&>span]:opacity-80">
        {STAMP_DUTY_NOTE.text} <span>Source: {STAMP_DUTY_NOTE.source}</span>
      </p>
    </main>
  );
}
