"use client";

import { useEffect, useState } from "react";
import { StrKey, rpc } from "@stellar/stellar-sdk";
import { getKit } from "@/lib/stellar/kit";

/** The payer's wallet is connected for this page only: it never replaces the session saved for the signed-in person. */
const PAYER_KIT = { saveSession: false } as const;
import { NETWORK, explorerLink } from "@/lib/stellar/config";
import { credentialInKitError, walletAddressFor, walletStatus, type LedgerReader } from "@/lib/stellar/wallet-lookup";
import { formatUsdc } from "@/lib/invoices/amount";
import { PAY_LEDGERS, bounded, findPaymentTx, isCaracalSplit, latestLedger, payInvoice, readConfig, readInvoice, readInvoiceAt, readUsdcBalance, type InvoiceOnChain } from "@/lib/invoices/chain";
import { refBytes } from "@/lib/invoices/ref";

type View =
  | { kind: "loading" }
  | { kind: "bad-link" }
  | { kind: "error"; message: string }
  | { kind: "not-caracal" }
  | { kind: "unknown-invoice" }
  | { kind: "invoice"; invoice: InvoiceOnChain; txHash: string | null };

const BAD_LINK = "This pay link is not valid. Ask the person who sent it for a new one.";
const NETWORK_DOWN = "Caracal could not reach the Stellar network to read this invoice. Check your connection and reload the page.";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// An empty answer does not prove there is no wallet: an RPC may leave out a wallet whose data was archived
// (wallet-lookup.ts, Codex R6 #2), so the text says only what was seen.
const NO_WALLET_FOR_PASSKEY =
  "No Caracal wallet was found on Stellar testnet for that passkey. That does not prove there is none: the network may not show a wallet whose data has expired. If it was created a moment ago, wait a minute and try again, or choose another passkey.";

/**
 * Why Connect failed, in true words. smart-account-kit says "not found
 * on-chain" for any failed lookup, a network failure included, so the page
 * looks up that passkey's wallet itself (as the wallet page does) and says "no
 * wallet" only when the network answers that there is none.
 */
async function connectFailure(e: unknown, rpc: LedgerReader | undefined): Promise<string> {
  const credential = credentialInKitError(e);
  if (!credential) return `Caracal could not connect your wallet. ${errorText(e)}`;
  const status = await walletStatus(rpc, walletAddressFor(credential, NETWORK.passphrase));
  if (status === "not-found") return NO_WALLET_FOR_PASSKEY;
  if (status === "archived") return "Your wallet exists on Stellar testnet, but its data has expired and must be restored before it can pay. Caracal cannot restore it yet.";
  if (status === "present") return "Your wallet exists on Stellar testnet, but Caracal could not open it. Reload the page and try again.";
  return "Caracal could not reach the Stellar network to check whether a wallet exists for this passkey. Check your connection and try again.";
}

/** The passkey prompt (the kit's WebAuthn timeout is 1 minute) plus the wallet lookup, with room to spare. */
const CONNECT_TIMEOUT_MS = 3 * 60_000;

/**
 * A payment of this invoice from this browser whose answer was lost: the last ledger it can land at (its passkey
 * signature expires after it). Kept in localStorage, so a reload or another tab still holds back a second payment
 * until the invoice reads paid or cancelled, or open at a ledger past it (Codex invoices R3 #1).
 */
const PENDING_KEY = (split: string, ref: string) => `caracal.payPending.${split}.${ref}`;

function readPending(split: string, ref: string): number | null {
  try {
    if (typeof window === "undefined") return null;
    const v = JSON.parse(window.localStorage.getItem(PENDING_KEY(split, ref)) ?? "null") as unknown;
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function writePending(split: string, ref: string, payBy: number | null): void {
  try {
    if (typeof window === "undefined") return;
    if (payBy === null) window.localStorage.removeItem(PENDING_KEY(split, ref));
    else window.localStorage.setItem(PENDING_KEY(split, ref), JSON.stringify(payBy));
  } catch {
    // storage blocked: this page still remembers it
  }
}

const PENDING_TEXT = (payBy: number) =>
  `An earlier payment of this invoice from this browser may still go through, until the Stellar network passes ledger ${payBy} (about 5 minutes after it was sent). Do not pay again yet: use "Check again".`;

/** What the page knows about paying, kept apart from what it knows about the invoice. */
type Pay =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "paid"; hash: string | null }
  | { kind: "message"; text: string; checkFirst?: boolean };

export default function PayClient({ split, invoiceRef }: { split: string; invoiceRef: string }) {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [wallet, setWallet] = useState<string | null>(null);
  const [pay, setPay] = useState<Pay>({ kind: "idle" });
  // The last ledger an earlier payment from this browser whose answer was lost can land at (see PENDING_KEY).
  const [pending, setPending] = useState<number | null>(null);

  const linkOk = StrKey.isValidContract(split) && refBytes(invoiceRef) !== null;

  async function reload(): Promise<View> {
    if (!linkOk) return { kind: "bad-link" };
    try {
      const server = new rpc.Server(NETWORK.rpcUrl);
      const cfg = await readConfig(server, split);
      if (!cfg || !isCaracalSplit(split, cfg)) return { kind: "not-caracal" };
      const invoice = await readInvoice(server, split, invoiceRef);
      if (!invoice) return { kind: "unknown-invoice" };
      const txHash = invoice.status === "paid" ? await findPaymentTx(server, split, invoiceRef) : null;
      return { kind: "invoice", invoice, txHash };
    } catch (e) {
      console.error("pay page:", errorText(e));
      return { kind: "error", message: NETWORK_DOWN };
    }
  }

  useEffect(() => {
    let gone = false;
    void reload().then((v) => {
      if (gone) return;
      setView(v);
      // An earlier payment from this browser whose answer was lost (before a reload, or in another tab).
      const kept = readPending(split, invoiceRef);
      if (kept !== null) setPending(kept);
    });
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect() {
    setPay({ kind: "busy", label: "Waiting for your passkey" });
    let kit: Awaited<ReturnType<typeof getKit>> | undefined;
    try {
      kit = await bounded(getKit(PAYER_KIT), "Loading the wallet kit");
      // fresh: always ask for this person's passkey, never reuse what this browser last had. Bounded: after the
      // passkey answers, the kit looks the wallet up on a node it reads with no time limit (adversary i13).
      // Connecting moves nothing, so an answer that arrives later is simply not used.
      const r = await bounded(kit.connectWallet({ fresh: true }), "Connecting your wallet", CONNECT_TIMEOUT_MS);
      if (!r) return setPay({ kind: "message", text: NO_WALLET_FOR_PASSKEY });
      setWallet(r.contractId);
      setPay({ kind: "idle" });
    } catch (e) {
      setPay({ kind: "message", text: await connectFailure(e, kit?.rpc as LedgerReader | undefined) });
    }
  }

  async function payNow() {
    if (!wallet || view.kind !== "invoice") return;
    // An earlier payment from this browser (this page before a reload, or another tab) may still land.
    const earlier = pending ?? readPending(split, invoiceRef);
    if (earlier !== null) {
      setPending(earlier);
      return setPay({ kind: "message", checkFirst: true, text: PENDING_TEXT(earlier) });
    }
    setPay({ kind: "busy", label: "Checking the invoice and your balance" });
    // Fresh from the chain: the amount paid is the one the contract holds now.
    const now = await reload();
    setView(now);
    if (now.kind !== "invoice") return setPay({ kind: "idle" });
    if (now.invoice.status !== "open") return setPay({ kind: "idle" });
    const server = new rpc.Server(NETWORK.rpcUrl);
    let balance: bigint;
    try {
      balance = await readUsdcBalance(server, wallet);
    } catch (e) {
      return setPay({ kind: "message", text: `Caracal could not read your USDC balance, so nothing was sent. ${errorText(e)}` });
    }
    const amount = now.invoice.amount;
    if (balance < amount) {
      return setPay({
        kind: "message",
        text: `Your wallet holds ${formatUsdc(balance)} USDC and this invoice needs ${formatUsdc(amount)} USDC. Nothing was sent. Add USDC to your wallet, then pay.`,
      });
    }
    // The payment's last ledger is fixed before the passkey is asked: a lost answer is then settled once the network
    // is read past it, and kept in this browser in the meantime (Codex invoices R3 #1).
    let payBy: number;
    try {
      payBy = (await latestLedger(server)) + PAY_LEDGERS;
    } catch (e) {
      return setPay({ kind: "message", text: `Caracal could not read the Stellar network, so nothing was sent. ${errorText(e)}` });
    }
    setPay({ kind: "busy", label: "Paying. Approve it with your passkey" });
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit(PAYER_KIT);
    } catch (e) {
      return setPay({ kind: "message", text: `The payment was not made: Caracal could not load the wallet kit. ${errorText(e)}` });
    }
    writePending(split, invoiceRef, payBy);
    const outcome = await payInvoice(kit, split, wallet, amount, invoiceRef, payBy);
    if (outcome.kind !== "unknown") writePending(split, invoiceRef, null);
    if (outcome.kind === "done") {
      setPay({ kind: "paid", hash: outcome.hash });
      // It landed. A failed read now must not hide that: the invoice already shown stays, marked paid.
      return void reload().then((v) => {
        if (v.kind === "invoice") setView(v);
      });
    }
    if (outcome.kind === "not-sent" || outcome.kind === "failed") {
      // Said of this attempt only. The invoice is read again: it may have been paid meanwhile (from another device,
      // say), and a failure because it was already paid must not read as "not paid" (Codex invoices R3 #1).
      const now2 = await reload();
      if (now2.kind === "invoice") setView(now2);
      if (now2.kind === "invoice" && now2.invoice.status === "paid") return setPay({ kind: "paid", hash: now2.txHash });
      if (outcome.kind === "not-sent") return setPay({ kind: "message", text: `This payment was not made. ${outcome.message}` });
      return setPay({ kind: "message", text: `This payment attempt failed on the network, and it moved no money. ${outcome.message}` });
    }
    setPending(payBy);
    // Unknown: the chain says whether it landed.
    const after = await reload();
    setView(after);
    // The receipt is the transaction the contract's events say paid the invoice: after a lost answer the
    // payer's own transaction may have failed while someone else's paid it.
    if (after.kind === "invoice" && (after.invoice.status === "paid" || after.invoice.status === "cancelled")) {
      writePending(split, invoiceRef, null);
      setPending(null);
    }
    if (after.kind === "invoice" && after.invoice.status === "paid") return setPay({ kind: "paid", hash: after.txHash });
    // A cancelled invoice was never paid (the contract refuses to cancel a paid one) and takes no deposit
    // after (InvoiceCancelled), so this payment did not go through and cannot.
    if (after.kind === "invoice" && after.invoice.status === "cancelled") {
      return setPay({ kind: "message", text: "The payment did not go through, and no money moved: the person who sent this invoice cancelled it." });
    }
    setPay({
      kind: "message",
      checkFirst: true,
      text: `Caracal could not confirm whether the payment went through. Do not pay again yet: use "Check again" first. ${outcome.message}`,
    });
  }

  async function checkAgain() {
    setPay({ kind: "busy", label: "Checking the invoice" });
    const earlier = pending ?? readPending(split, invoiceRef);
    // The invoice, with the ledger the network read it at: an open invoice read past the earlier payment's last
    // ledger proves that payment can no longer land; read at or before it, it still may (Codex invoices R3 #1).
    // The status and the ledger must come from the same answer: two requests may reach RPC nodes a few ledgers
    // apart, and an open status from a node behind must not be dated by another node's newer ledger (adversary i15).
    let openPast = false;
    if (earlier !== null && linkOk) {
      try {
        const at = await readInvoiceAt(new rpc.Server(NETWORK.rpcUrl), split, invoiceRef);
        openPast = at.invoice?.status === "open" && at.ledger !== undefined && at.ledger > earlier;
      } catch {
        openPast = false;
      }
    }
    const v = await reload();
    setView(v);
    const settled = v.kind === "invoice" && (v.invoice.status !== "open" || openPast);
    if (earlier !== null && settled) {
      writePending(split, invoiceRef, null);
      setPending(null);
    }
    if (v.kind === "invoice" && v.invoice.status === "paid") return setPay({ kind: "paid", hash: v.txHash });
    if (earlier !== null && !settled) return setPay({ kind: "message", checkFirst: true, text: PENDING_TEXT(earlier) });
    if (earlier !== null && v.kind === "invoice" && v.invoice.status === "open") {
      return setPay({ kind: "message", text: `The earlier payment did not go through, and it can no longer: the network has passed ledger ${earlier}, after which its passkey signature is refused. You can pay now.` });
    }
    setPay({ kind: "idle" });
  }

  const busy = pay.kind === "busy";
  return (
    <main className="page">
      <h1 className="h1">Pay an invoice</h1>
      {view.kind === "loading" && <p className="small muted">Reading the invoice from Stellar.</p>}
      {view.kind === "bad-link" && <p className="msg msg-bad">{BAD_LINK}</p>}
      {view.kind === "error" && <p className="msg msg-bad">{view.message}</p>}
      {view.kind === "not-caracal" && (
        <p className="msg msg-bad">This link does not point to a Caracal invoice contract, so Caracal will not take a payment for it. Nothing was sent.</p>
      )}
      {view.kind === "unknown-invoice" && <p className="msg msg-bad">This invoice does not exist on Stellar. Ask the person who sent the link to check it.</p>}
      {view.kind === "invoice" && (
        <>
          <div className="card card-hero">
          <p className="money-xl num">{formatUsdc(view.invoice.amount)} USDC</p>
          <p className="small opacity-80">
            Read from the Stellar test network. Invoice <code>{invoiceRef.slice(0, 8)}</code>.
          </p>
          </div>
          {view.invoice.status === "cancelled" && <p className="msg msg-bad">This invoice was cancelled by the person who sent it. Do not pay it.</p>}
          {(view.invoice.status === "paid" || pay.kind === "paid") && (
            <p className="msg msg-good">
              This invoice is paid.{" "}
              {(pay.kind === "paid" ? pay.hash : view.txHash) ? (
                <a className="link" href={`/receipt/${pay.kind === "paid" && pay.hash ? pay.hash : view.txHash}`}>
                  View the receipt
                </a>
              ) : (
                "The receipt link could not be found."
              )}
            </p>
          )}
          {view.invoice.status === "open" && pay.kind !== "paid" && (
            <>
              {!wallet ? (
                <div className="card">
                  <p className="lead">Pay from your Caracal wallet with your passkey. Caracal covers the network fee.</p>
                  <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void connect()}>
                    Use my existing wallet
                  </button>
                  <p className="small muted">
                    No wallet yet?{" "}
                    <a className="link" href="/wallet" target="_blank" rel="noopener">
                      Create one on the Caracal wallet page
                    </a>{" "}
                    (it opens in a new tab), then come back here and choose &quot;Use my existing wallet&quot;.
                  </p>
                </div>
              ) : (
                <div className="card">
                  <p className="small muted">
                    Paying from <a className="link addr" href={explorerLink("contract", wallet)}>{wallet}</a>
                  </p>
                  <button className="btn btn-green btn-block" disabled={busy || pending !== null || (pay.kind === "message" && pay.checkFirst === true)} onClick={() => void payNow()}>
                    Pay {formatUsdc(view.invoice.amount)} USDC
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {pending !== null && view.kind === "invoice" && view.invoice.status === "open" && pay.kind !== "paid" && pay.kind !== "busy" && !(pay.kind === "message" && pay.checkFirst) && (
        <div className="msg msg-unsure flex flex-col gap-2">
          <p>{PENDING_TEXT(pending)}</p>
          <button className="link self-start" onClick={() => void checkAgain()}>
            Check again
          </button>
        </div>
      )}
      {pay.kind === "busy" && <p className="small muted">{pay.label}.</p>}
      {pay.kind === "message" && (
        <div className={pay.checkFirst ? "msg msg-unsure flex flex-col gap-2" : "msg msg-bad flex flex-col gap-2"}>
          <p>{pay.text}</p>
          {pay.checkFirst && (wallet || pending !== null) && (
            <button className="link self-start" onClick={() => void checkAgain()}>
              Check again
            </button>
          )}
        </div>
      )}
    </main>
  );
}
