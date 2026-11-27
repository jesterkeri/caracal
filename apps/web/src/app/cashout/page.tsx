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
import { buildAnchorTransfer, readUsdcBalance } from "@/lib/anchor/transfer";

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

/** What a payment goes to: the anchor's account and memo. */
function payTo(t: AnchorTxn): string {
  return JSON.stringify([t.withdrawAnchorAccount ?? null, t.withdrawMemoType ?? null, t.withdrawMemo ?? null]);
}

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
  function refreshBalance() {
    const kit = kitRef.current;
    const wallet = walletRef.current;
    if (!kit || !wallet) return;
    const mine = ++balanceRead.current;
    void readUsdcBalance(wallet, kit.rpc).then((b) => {
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
        // A "may still go through" warning from the send is settled once the anchor says it finished.
        if (t.status === "completed" || t.status === "refunded") setProblem(null);
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
  }, [phase, session, toml]);

  // The balance changes when the anchor's status changes (the USDC arrives, a refund lands).
  useEffect(() => {
    if (txn) refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn?.status]);

  const preview = info ? previewWithdraw(amountText, info, balance) : null;

  async function start() {
    const kit = kitRef.current;
    if (boot.kind !== "ready" || !kit || !toml || !preview?.ok) return;
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
    // The account and memo the person was shown must be the ones the anchor still has.
    // The poll keeps the screen on the anchor's latest record, so the comparison is with what was on screen
    // when the person reached this step, not with the record the poll last wrote.
    const latest = txnRef.current ?? txn;
    if (seenRef.current !== payTo(latest)) {
      seenRef.current = payTo(latest);
      setTxn(latest);
      setProblem("The anchor changed the account or memo to pay after you looked at it. Nothing was sent. Check the details above and confirm again.");
      return;
    }
    sendingFor.current = txn.id;
    setProblem(null);
    setPhase("sending");
    const deps: SendDeps = {
      buildTransfer: (payment) => buildAnchorTransfer(boot.wallet, payment, kit.rpc),
      signAndSubmit: (tx) => kit.signAndSubmit(tx as contract.AssembledTransaction<unknown>),
    };
    const r = await sendToAnchor(latest, confirmed, deps);
    refreshBalance();
    if (r.kind === "sent") {
      setSentHash(r.hash);
      setPhase("watching");
    } else if (r.kind === "unknown") {
      // Never sent twice: the sending lock stays, and the anchor's status decides.
      if (r.hash) setSentHash(r.hash);
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
  // Never while the USDC payment is being sent: starting again then would lose track of it.
  const canStartAnother = (done || lostSession) && phase !== "sending";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Cash out</h1>
      <p className="rounded-md border px-3 py-2 text-sm">{SIMULATION_NOTE}</p>

      {boot.kind === "loading" && <p className="text-sm">Opening your wallet...</p>}
      {boot.kind === "error" && <p className="text-sm text-red-600">{boot.message}</p>}
      {boot.kind === "no-wallet" && (
        <p className="text-sm">
          Caracal has no wallet open for this account on this browser. <a className="underline" href="/wallet">Open or create your wallet</a>, then come back.
        </p>
      )}

      {boot.kind === "ready" && (
        <>
          <p className="text-sm">
            Wallet: <span className="break-all font-mono">{boot.wallet}</span>
            <br />
            USDC in the wallet: {balance === null ? "not available right now" : `${fromStroops(balance)} USDC`}
          </p>
          {infoError && <p className="text-sm text-red-600">{infoError}</p>}
          {!infoError && !info && <p className="text-sm">Reading the anchor&apos;s limits...</p>}

          {info && phase === "preview" && (
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm">
                Amount to cash out, in USDC
                <input
                  className="rounded-md border px-3 py-2 text-base"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder="2"
                />
              </label>
              {amountText.trim() !== "" && preview && !preview.ok && <p className="text-sm text-red-600">{preview.reason}</p>}
              {preview?.ok && (
                <dl className="grid grid-cols-2 gap-1 text-sm">
                  <dt>You send</dt>
                  <dd className="text-right">{fromStroops(preview.amount)} USDC</dd>
                  <dt>Anchor fee</dt>
                  <dd className="text-right">{preview.fee === null ? "Quoted by the anchor in its form" : `${fromStroops(preview.fee)} USDC`}</dd>
                  <dt>Arrives</dt>
                  <dd className="text-right">{preview.arrives === null ? "Shown after the anchor quotes its fee" : `${fromStroops(preview.arrives)} USDC`}</dd>
                </dl>
              )}
              <button className="rounded-md bg-black px-4 py-3 text-white disabled:opacity-40" disabled={!preview?.ok} onClick={start}>
                Continue to the anchor
              </button>
              <p className="text-xs opacity-80">
                Next, your passkey signs you in to the anchor (it cannot move money), then the anchor&apos;s own form opens in a pop-up. Nothing is sent from your wallet until you confirm the anchor&apos;s quote here.
              </p>
            </div>
          )}

          {phase === "starting" && <p className="text-sm">Signing in to the anchor with your passkey...</p>}

          {phase === "form" && session && !done && !lostSession && (
            <div className="flex flex-col gap-2 text-sm">
              <p>Finish the anchor&apos;s form in the pop-up window. This page moves on by itself when the anchor is ready for your USDC.</p>
              {popupNote === "blocked" && <p>Your browser blocked the pop-up.</p>}
              {popupNote === "closed" && <p>The pop-up was closed before the anchor&apos;s form could open in it.</p>}
              <p>
                <a className="underline" href={session.url} target="_blank" rel="noopener noreferrer">
                  Open the anchor&apos;s form
                </a>{" "}
                if you closed the pop-up.
              </p>
            </div>
          )}

          {(phase === "confirm" || phase === "sending") && txn && (
            <div className="flex flex-col gap-3">
              <dl className="grid grid-cols-2 gap-1 text-sm">
                <dt>The anchor wants</dt>
                <dd className="text-right">{txn.amountIn ?? "?"} {assetLabel(txn.amountInAsset)}</dd>
                <dt>Anchor fee</dt>
                <dd className="text-right">{txn.feeTotal === null ? "not stated" : `${txn.feeTotal} ${assetLabel(txn.feeAsset)}`}</dd>
                <dt>Arrives</dt>
                <dd className="text-right">{txn.amountOut ?? "not stated"} (simulated)</dd>
                <dt>Pay to account</dt>
                <dd className="break-all text-right font-mono">{txn.withdrawAnchorAccount ?? "not stated"}</dd>
                <dt>Memo ({txn.withdrawMemoType ?? "none"})</dt>
                <dd className="break-all text-right font-mono">{txn.withdrawMemo ?? "not stated"}</dd>
              </dl>
              {phase !== "sending" && !paidInUsdc(txn) ? (
                // paymentFor refuses any other asset, so no Send is offered for one.
                <p className="text-sm">The anchor asks to be paid in {txn.amountInAsset}, not Circle testnet USDC, so Caracal cannot pay this cash-out, and this page sent nothing. Start again for a new one.</p>
              ) : txn.status === "pending_user_transfer_start" || phase === "sending" ? (
                <button className="rounded-md bg-black px-4 py-3 text-white disabled:opacity-40" disabled={phase === "sending"} onClick={send}>
                  {phase === "sending" ? "Waiting for your passkey..." : `Send ${txn.amountIn ?? ""} USDC to the anchor`}
                </button>
              ) : (
                <p className="text-sm">The anchor no longer takes a payment for this cash-out, and this page sent none. {statusText(txn)} Start again for a new one.</p>
              )}
              <p className="text-xs opacity-80">Caracal pays the network fee. Your passkey confirms this one payment.</p>
              {phase === "confirm" && (
                <button className="rounded-md border px-4 py-3 text-sm" onClick={startAgain}>
                  Start again
                </button>
              )}
            </div>
          )}

          {problem && <p className="text-sm text-red-600">{problem}</p>}

          {txn && (phase === "watching" || done) && (
            <div className="flex flex-col gap-2 text-sm">
              <p className={txn.status === "completed" ? "font-medium" : ""}>{statusText(txn)}</p>
              {sentHash && (
                <a className="break-all underline" href={explorerLink("tx", sentHash)}>
                  USDC payment on Stellar: {sentHash}
                </a>
              )}
              <p className="break-all opacity-80">Anchor transaction id: {txn.id}</p>
              {txn.status === "completed" && txn.amountOut && <p>The anchor recorded {txn.amountOut} as paid out (simulated).</p>}
            </div>
          )}
          {pollNote && <p className="text-sm text-red-600">{pollNote}</p>}
          {canStartAnother && (
            <button
              className="rounded-md border px-4 py-3 text-sm"
              onClick={startAgain}
            >
              Start another cash-out
            </button>
          )}
        </>
      )}

      <p className="text-xs opacity-80">
        {STAMP_DUTY_NOTE.text} <span>Source: {STAMP_DUTY_NOTE.source}</span>
      </p>
    </main>
  );
}
