"use client";

import { useEffect, useState } from "react";
import { StrKey, rpc } from "@stellar/stellar-sdk";
import { getKit } from "@/lib/stellar/kit";

/** The payer's wallet is connected for this page only: it never replaces the session saved for the signed-in person. */
const PAYER_KIT = { saveSession: false } as const;
import { NETWORK, explorerLink } from "@/lib/stellar/config";
import { credentialInKitError, walletAddressFor, walletStatus, type LedgerReader } from "@/lib/stellar/wallet-lookup";
import { formatUsdc } from "@/lib/invoices/amount";
import { findPaymentTx, isCaracalSplit, payInvoice, readConfig, readInvoice, readUsdcBalance, type InvoiceOnChain } from "@/lib/invoices/chain";
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
      if (!gone) setView(v);
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
      kit = await getKit(PAYER_KIT);
      // fresh: always ask for this person's passkey, never reuse what this browser last had.
      const r = await kit.connectWallet({ fresh: true });
      if (!r) return setPay({ kind: "message", text: NO_WALLET_FOR_PASSKEY });
      setWallet(r.contractId);
      setPay({ kind: "idle" });
    } catch (e) {
      setPay({ kind: "message", text: await connectFailure(e, kit?.rpc as LedgerReader | undefined) });
    }
  }

  async function payNow() {
    if (!wallet || view.kind !== "invoice") return;
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
    setPay({ kind: "busy", label: "Paying. Approve it with your passkey" });
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit(PAYER_KIT);
    } catch (e) {
      return setPay({ kind: "message", text: `The payment was not made: Caracal could not load the wallet kit. ${errorText(e)}` });
    }
    const outcome = await payInvoice(kit, split, wallet, amount, invoiceRef);
    if (outcome.kind === "done") {
      setPay({ kind: "paid", hash: outcome.hash });
      // It landed. A failed read now must not hide that: the invoice already shown stays, marked paid.
      return void reload().then((v) => {
        if (v.kind === "invoice") setView(v);
      });
    }
    if (outcome.kind === "not-sent") return setPay({ kind: "message", text: `The payment was not made. ${outcome.message}` });
    if (outcome.kind === "failed") return setPay({ kind: "message", text: `The payment failed on the network, and no money moved. ${outcome.message}` });
    // Unknown: the chain says whether it landed.
    const after = await reload();
    setView(after);
    // The receipt is the transaction the contract's events say paid the invoice: after a lost answer the
    // payer's own transaction may have failed while someone else's paid it.
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
    const v = await reload();
    setView(v);
    setPay(v.kind === "invoice" && v.invoice.status === "paid" ? { kind: "paid", hash: v.txHash } : { kind: "idle" });
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
                  <button className="btn btn-green btn-block" disabled={busy || (pay.kind === "message" && pay.checkFirst === true)} onClick={() => void payNow()}>
                    Pay {formatUsdc(view.invoice.amount)} USDC
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
      {pay.kind === "busy" && <p className="small muted">{pay.label}.</p>}
      {pay.kind === "message" && (
        <div className={pay.checkFirst ? "msg msg-unsure flex flex-col gap-2" : "msg msg-bad flex flex-col gap-2"}>
          <p>{pay.text}</p>
          {pay.checkFirst && wallet && (
            <button className="link self-start" onClick={() => void checkAgain()}>
              Check again
            </button>
          )}
        </div>
      )}
    </main>
  );
}
