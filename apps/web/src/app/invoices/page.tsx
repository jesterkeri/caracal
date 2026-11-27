"use client";

import { useEffect, useState } from "react";
import { followAccount, readSignInState } from "@/lib/auth/account";
import { browserStore, mayRestoreWallet } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { splitAddressFor } from "@/lib/stellar/split-address";
import { formatUsdc, parseUsdc } from "@/lib/invoices/amount";
import { bounded, cancelInvoice, createInvoice, isCaracalSplit, readConfig, type WriteOutcome } from "@/lib/invoices/chain";
import { checkDetails, deleteDetails, listDetails, saveDetails, type Db } from "@/lib/invoices/details";
import { newInvoiceRef, payPath } from "@/lib/invoices/ref";
import { loadRows, statusText, type Row } from "@/lib/invoices/rows";

/** `account` is the signed-in account the page loaded for: the details it saves go into that account's rows only. */
/** A row as shown: `stillOpening` marks one not on chain whose opening answer was lost a moment ago. */
type ShownRow = Row & { stillOpening?: boolean };
type Ready = { account: string; wallet: string; split: string; rows: ShownRow[] };
type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "no-wallet" }
  | { kind: "no-split"; split: string }
  | ({ kind: "ready" } & Ready);

const db = () => supabaseBrowser() as unknown as Db;

/**
 * How long after a lost answer an invoice opening may still land. The relay builds each transaction with a
 * 25 s time bound (TX_TIMEOUT_S) within 60 s of receiving it, so one that has not landed by then never will;
 * this leaves a wide margin, like the wallet page's 3 minutes for a creation.
 */
const OPENING_SETTLE_MS = 3 * 60_000;
const OPENING_UNKNOWN_KEY = "caracal.invoiceOpeningUnknown";
/** Invoice ids whose opening answer was lost, and when: kept in this tab, and in localStorage across a reload. */
const openingUnknown = new Map<string, number>();

function rememberUnknownOpening(ref: string) {
  const at = Date.now();
  openingUnknown.set(ref, at);
  try {
    const saved = JSON.parse(window.localStorage.getItem(OPENING_UNKNOWN_KEY) ?? "{}") as Record<string, unknown>;
    // Old entries are dropped so the record stays small.
    const kept = Object.fromEntries(Object.entries(saved).filter(([, t]) => typeof t === "number" && at - t < OPENING_SETTLE_MS));
    window.localStorage.setItem(OPENING_UNKNOWN_KEY, JSON.stringify({ ...kept, [ref]: at }));
  } catch {
    // storage blocked: this tab still remembers it
  }
}

/** An opening whose outcome is known (on chain, or proven not sent): it no longer holds back "Remove this entry". */
function forgetOpening(ref: string) {
  openingUnknown.delete(ref);
  try {
    const saved = JSON.parse(window.localStorage.getItem(OPENING_UNKNOWN_KEY) ?? "{}") as Record<string, unknown>;
    delete saved[ref];
    window.localStorage.setItem(OPENING_UNKNOWN_KEY, JSON.stringify(saved));
  } catch {
    // storage blocked: nothing was saved there
  }
}

/** How often an opening on its way renews its record, so a page that goes away mid-send leaves a recent one. */
const OPENING_HEARTBEAT_MS = 10_000;

/** Whether an invoice that is not on chain may still appear: its opening's answer was lost less than OPENING_SETTLE_MS ago. */
function mayStillOpen(ref: string): boolean {
  let at = openingUnknown.get(ref);
  if (at === undefined) {
    try {
      const t = (JSON.parse(window.localStorage.getItem(OPENING_UNKNOWN_KEY) ?? "{}") as Record<string, unknown>)[ref];
      if (typeof t === "number") at = t;
    } catch {
      // nothing saved
    }
  }
  return at !== undefined && Date.now() - at < OPENING_SETTLE_MS;
}

const STILL_OPENING = "Not on chain yet. Its opening's answer was lost, so it may still appear: reload the page in a few minutes before removing it.";

const ACCOUNT_CHANGED = "The signed-in account changed in another tab, so nothing was opened. Reloading for the account signed in now.";

/** Longest wait for loading the wallet kit and restoring the saved wallet: the wallet page's limit (decisions 2026-11-26, r4e). */
const RESTORE_TIMEOUT_MS = 30_000;

/** What a person is told about a write that did not finish cleanly. */
function outcomeText(o: Exclude<WriteOutcome, { kind: "done" }>, what: string): string {
  if (o.kind === "not-sent") return `${what} did not go through. ${o.message}`;
  if (o.kind === "failed") return `${what} failed on the network, and nothing changed. ${o.message}`;
  return `${what}: the answer was lost, so it may have gone through. Do not repeat it yet. Reload this page and check the list first. ${o.message}`;
}

/** Bumped by every list read: a read that finishes after a newer one began is dropped. */
let listReads = 0;

export default function InvoicesPage() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [amount, setAmount] = useState("");
  const [client, setClient] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function refresh(account: string, wallet: string, split: string) {
    // Reads can finish out of order (each row read may take up to 20 s): only the latest one started is shown,
    // so an older read never puts back a row a newer one saw change (a cancelled invoice shown as open again).
    const mine = ++listReads;
    const kit = await bounded(getKit(), "Loading the wallet kit", RESTORE_TIMEOUT_MS);
    const rows = await loadRows(kit.rpc, await bounded(listDetails(db()), "Reading your saved invoices"), split);
    if (mine !== listReads) return;
    setLoad({ kind: "ready", account, wallet, split, rows: rows.map((r) => (r.chain === null && mayStillOpen(r.invoice_ref) ? { ...r, stillOpening: true } : r)) });
  }

  /** Another tab signed in as someone else (or signed out): this page's wallet and form belong to the old account, so it starts again. */
  function accountChanged() {
    setLoad({ kind: "loading" });
    window.location.reload();
  }

  useEffect(() => {
    let gone = false;
    let unfollow = () => {};
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const me = await readSignInState(auth);
      if (me.kind === "signed-out") return window.location.replace("/signin");
      if (me.kind === "unverified") throw new Error("Caracal could not verify your sign-in. Check your connection and reload the page.");
      if (gone) return;
      unfollow = followAccount(auth, me.id, accountChanged);
      const kit = await bounded(getKit(), "Loading the wallet kit", RESTORE_TIMEOUT_MS);
      // Only a wallet this account connected on this browser is used (the same rule as the wallet page).
      const wallet = (await mayRestoreWallet(browserStore, kit, me.id)) ? await bounded(kit.connectWallet(), "Restoring your saved wallet", RESTORE_TIMEOUT_MS) : null;
      if (gone) return;
      if (!wallet) return setLoad({ kind: "no-wallet" });
      const split = splitAddressFor(wallet.contractId);
      const cfg = await readConfig(kit.rpc, split);
      if (gone) return;
      if (!cfg) return setLoad({ kind: "no-split", split });
      if (!isCaracalSplit(split, cfg) || cfg.owner !== wallet.contractId) {
        throw new Error("The contract at your split address is not a Caracal split owned by your wallet, so Caracal will not use it.");
      }
      await refresh(me.id, wallet.contractId, split);
    })().catch((e: unknown) => {
      console.error("invoices page:", e instanceof Error ? e.message : String(e));
      if (gone) return;
      const text = e instanceof Error ? e.message : String(e);
      setLoad({ kind: "error", message: text === HTTPS_RPC_REQUIRED ? text : `Caracal could not load your invoices. ${text}` });
    });
    return () => {
      gone = true;
      unfollow();
    };
  }, []);

  async function create(ready: Ready) {
    setNotice(null);
    const stroops = parseUsdc(amount);
    if (stroops === null) return setNotice("Enter the amount in USDC as a number above 0, with at most 7 decimals, for example 150 or 150.50.");
    const details = checkDetails(client, description);
    if (!details.ok) return setNotice(details.why);
    const ref = newInvoiceRef();
    setBusy("Opening the invoice on Stellar. Approve it with your passkey.");
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit();
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not load the wallet kit, so nothing was opened. ${e instanceof Error ? e.message : String(e)}`);
    }
    // The details go into the rows of whoever is signed in at the moment they are saved (supabase-js reads the
    // session shared by every tab), so the account is read again here: another tab may have switched it.
    const now = await readSignInState(supabaseBrowser().auth);
    if (now.kind !== "verified" || now.id !== ready.account) {
      setBusy(null);
      if (now.kind === "unverified") return setNotice("Caracal could not verify your sign-in, so nothing was opened. Check your connection and try again.");
      setNotice(ACCOUNT_CHANGED);
      return accountChanged();
    }
    try {
      // The details are saved first, so an invoice that reached the chain always has its client name here.
      await saveDetails(db(), { invoice_ref: ref, split: ready.split, client_name: details.name, description: details.description });
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not save the client's name, so nothing was opened. ${e instanceof Error ? e.message : String(e)}`);
    }
    // Recorded before anything is sent and renewed while the opening is on its way, so a reload or a closed tab
    // mid-send still holds back "Remove this entry" until the opening can no longer land.
    rememberUnknownOpening(ref);
    const beat = setInterval(() => rememberUnknownOpening(ref), OPENING_HEARTBEAT_MS);
    const leaving = () => rememberUnknownOpening(ref);
    window.addEventListener?.("pagehide", leaving);
    let outcome: Awaited<ReturnType<typeof createInvoice>>;
    try {
      outcome = await createInvoice(kit, ready.split, ref, stroops);
    } finally {
      clearInterval(beat);
      window.removeEventListener?.("pagehide", leaving);
    }
    if (outcome.kind === "not-sent" || outcome.kind === "failed") {
      // Nothing is on chain: the saved details are removed again.
      try {
        await deleteDetails(db(), ref);
      } catch (e) {
        console.error("could not remove unused invoice details:", e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(null);
    if (outcome.kind === "unknown") rememberUnknownOpening(ref);
    else forgetOpening(ref);
    if (outcome.kind !== "done") setNotice(outcomeText(outcome, "Opening the invoice"));
    else {
      setAmount("");
      setClient("");
      setDescription("");
      setNotice("Invoice opened. Copy its pay link below and send it to your client.");
    }
    if (outcome.kind !== "not-sent" && outcome.kind !== "failed") await refresh(ready.account, ready.wallet, ready.split).catch(listFailed);
  }

  async function cancel(ready: Ready, ref: string) {
    setNotice(null);
    setBusy("Cancelling the invoice. Approve it with your passkey.");
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit();
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not load the wallet kit, so nothing was cancelled. ${e instanceof Error ? e.message : String(e)}`);
    }
    const outcome = await cancelInvoice(kit, ready.split, ref);
    setBusy(null);
    setNotice(outcome.kind === "done" ? "Invoice cancelled. Its pay link no longer works." : outcomeText(outcome, "Cancelling the invoice"));
    await refresh(ready.account, ready.wallet, ready.split).catch(listFailed);
  }

  /** An entry the chain has no invoice for (opening it did not finish) can be removed from the list. */
  async function removeUnopened(ready: Ready, ref: string) {
    try {
      await deleteDetails(db(), ref);
      await refresh(ready.account, ready.wallet, ready.split);
    } catch (e) {
      setNotice(`Caracal could not remove that entry. ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function listFailed(e: unknown) {
    setNotice(`The invoice list could not be refreshed. Reload the page. ${e instanceof Error ? e.message : String(e)}`);
  }

  async function copy(link: string, ref: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(ref);
    } catch {
      setNotice(`Caracal could not copy the link. Select and copy it yourself: ${link}`);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Invoices</h1>
      {load.kind === "loading" && <p className="text-sm">Loading your invoices.</p>}
      {load.kind === "error" && <p className="text-sm text-red-600">{load.message}</p>}
      {load.kind === "no-wallet" && (
        <p className="text-sm">
          Invoices are opened from your Caracal wallet. <a className="underline" href="/wallet">Create or connect your wallet</a> first.
        </p>
      )}
      {load.kind === "no-split" && (
        <p className="text-sm">
          Your split contract is not on Stellar yet, so there is nothing to open an invoice on. <a className="underline" href="/split">Set up your split</a> first.
        </p>
      )}
      {load.kind === "ready" && (
        <>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create(load);
            }}
          >
            <h2 className="text-lg font-medium">New invoice</h2>
            <label className="flex flex-col gap-1 text-sm">
              Client
              <input className="rounded border px-2 py-1" value={client} maxLength={120} onChange={(e) => setClient(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              What it is for (optional)
              <input className="rounded border px-2 py-1" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Amount in USDC
              <input className="rounded border px-2 py-1" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <p className="text-xs opacity-70">
              Only an invoice id and the amount go on the blockchain. The client name and description stay in your Caracal account. The client pays exactly this amount, once.
            </p>
            <button className="rounded border px-3 py-2 text-sm" type="submit" disabled={busy !== null}>
              Open invoice
            </button>
          </form>
          {busy && <p className="text-sm">{busy}</p>}
          {notice && <p className="text-sm">{notice}</p>}
          <section className="flex flex-col gap-3">
            <h2 className="text-lg font-medium">Your invoices</h2>
            {load.rows.length === 0 && <p className="text-sm">No invoices yet.</p>}
            {load.rows.map((r) => {
              const link = `${window.location.origin}${payPath(r.split, r.invoice_ref)}`;
              return (
                <article key={r.invoice_ref} className="flex flex-col gap-1 rounded border p-3 text-sm">
                  <p>
                    <strong>{r.client_name}</strong>
                    {typeof r.chain === "object" && r.chain !== null && <> , {formatUsdc(r.chain.amount)} USDC</>}
                  </p>
                  {r.description && <p className="opacity-80">{r.description}</p>}
                  <p>{r.chain === null && r.stillOpening ? STILL_OPENING : statusText(r.chain)}</p>
                  {r.chain === null && !r.stillOpening && (
                    <p>
                      <button className="underline" onClick={() => void removeUnopened(load, r.invoice_ref)}>
                        Remove this entry
                      </button>
                    </p>
                  )}
                  {typeof r.chain === "object" && r.chain !== null && r.chain.status === "open" && (
                    <>
                      <p className="break-all text-xs">{link}</p>
                      <p className="flex gap-3">
                        <button className="underline" onClick={() => void copy(link, r.invoice_ref)}>
                          {copied === r.invoice_ref ? "Link copied" : "Copy pay link"}
                        </button>
                        <button className="underline" disabled={busy !== null} onClick={() => void cancel(load, r.invoice_ref)}>
                          Cancel invoice
                        </button>
                      </p>
                    </>
                  )}
                  {typeof r.chain === "object" && r.chain !== null && r.chain.status === "paid" && (
                    <p>
                      {r.txHash ? (
                        <a className="underline" href={`/receipt/${r.txHash}`}>
                          View receipt
                        </a>
                      ) : (
                        "The receipt link could not be found (the network keeps about a week of payment history)."
                      )}
                    </p>
                  )}
                </article>
              );
            })}
          </section>
        </>
      )}
    </main>
  );
}
