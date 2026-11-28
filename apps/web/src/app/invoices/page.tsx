"use client";

import { useEffect, useState } from "react";
import { followAccount, readSignInState, type SignInState } from "@/lib/auth/account";
import { browserStore, mayRestoreWallet } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { splitAddressFor } from "@/lib/stellar/split-address";
import { NETWORK } from "@/lib/stellar/config";
import { credentialInKitError, walletAddressFor, walletStatus, type LedgerReader } from "@/lib/stellar/wallet-lookup";
import { formatUsdc, parseUsdc } from "@/lib/invoices/amount";
import { OPENING_LEDGERS, bounded, cancelInvoice, createInvoice, isCaracalSplit, latestLedger, readConfig, readInvoiceAt, type WriteOutcome } from "@/lib/invoices/chain";
import { checkDetails, deleteDetails, listDetails, saveDetails, type Db } from "@/lib/invoices/details";
import { newInvoiceRef, payPath } from "@/lib/invoices/ref";
import { cannotOpenAnyMore, loadRows, statusText, type Row } from "@/lib/invoices/rows";

/** `account` is the signed-in account the page loaded for: the details it saves go into that account's rows only. */
/**
 * A row as shown: `stillOpening` marks one not on chain whose opening answer was lost a moment ago;
 * `ahead` marks one whose opening or cancelling this browser saw confirmed, which the read has not caught up with.
 */
type ShownRow = Row & { stillOpening?: boolean; startedRecently?: boolean; ahead?: Confirmed; mayOpen?: boolean; cancelling?: number };
type Ready = { account: string; wallet: string; split: string; rows: ShownRow[] };
type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string; signOut?: boolean }
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

/**
 * Invoices whose opening or cancelling this browser saw confirmed ({ ref: "opened" | "cancelled" }, JSON).
 * A read right after (an RPC node a ledger behind) can still show the invoice missing or open; the row then
 * says what was confirmed and offers neither "Remove this entry" (on a live invoice) nor its pay link and
 * Cancel (on a cancelled one). An entry is dropped once a read agrees. Kept until then: a confirmed
 * transaction is on the ledger, so a read catches up.
 */
const CONFIRMED_KEY = "caracal.invoiceConfirmed";
type Confirmed = "opened" | "cancelled";
const confirmedHere = new Map<string, Confirmed | null>();

function readConfirmed(): Record<string, unknown> {
  try {
    const v = JSON.parse(window.localStorage.getItem(CONFIRMED_KEY) ?? "{}") as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function setConfirmed(ref: string, what: Confirmed | null) {
  confirmedHere.set(ref, what);
  try {
    const saved = readConfirmed();
    if (what === null) delete saved[ref];
    else saved[ref] = what;
    window.localStorage.setItem(CONFIRMED_KEY, JSON.stringify(saved));
  } catch {
    // storage blocked: this tab still remembers it
  }
}

function confirmedOf(ref: string): Confirmed | null {
  const here = confirmedHere.get(ref);
  if (here !== undefined) return here;
  const v = readConfirmed()[ref];
  return v === "opened" || v === "cancelled" ? v : null;
}

/**
 * Cancellations whose answer was lost ({ ref: last ledger it can land at }, JSON in localStorage, so a reload keeps
 * it). Until the invoice reads cancelled or paid, or open at a ledger past that one, its row says the cancellation
 * may still go through and offers neither its pay link nor Cancel (Codex invoices R3 #2).
 */
const CANCEL_PENDING_KEY = "caracal.invoiceCancelPending";

function readCancelPending(): Record<string, unknown> {
  try {
    const v = JSON.parse(window.localStorage.getItem(CANCEL_PENDING_KEY) ?? "{}") as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function setCancelPending(ref: string, cancelBy: number | null) {
  try {
    const saved = readCancelPending();
    if (cancelBy === null) delete saved[ref];
    else saved[ref] = cancelBy;
    window.localStorage.setItem(CANCEL_PENDING_KEY, JSON.stringify(saved));
  } catch {
    // storage blocked: nothing is kept for a reload
  }
}

function cancelPendingOf(ref: string): number | null {
  const v = readCancelPending()[ref];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}

const CANCELLING_TEXT = (by: number) =>
  `Cancelling: Caracal could not confirm the cancellation, and it may still go through until the network passes ledger ${by} (about 5 minutes after it was sent). Do not share its pay link meanwhile: it may stop working. Reload the page in a few minutes.`;

/** The row as shown: a confirmed outcome the read has not caught up with is shown as confirmed, and dropped once it has. */
function shown(r: Row): ShownRow {
  const cancelBy = cancelPendingOf(r.invoice_ref);
  if (cancelBy !== null && typeof r.chain === "object" && r.chain !== null) {
    // Settled once the invoice reads cancelled or paid (a paid invoice cannot be cancelled), or open past cancelBy.
    if (r.chain.status !== "open" || (typeof r.readAt === "number" && r.readAt > cancelBy)) setCancelPending(r.invoice_ref, null);
    else return { ...r, cancelling: cancelBy };
  }
  const done = confirmedOf(r.invoice_ref);
  const chain = typeof r.chain === "object" && r.chain !== null ? r.chain : null;
  if (done === "opened") {
    if (r.chain === null) return { ...r, ahead: "opened" };
    if (chain) setConfirmed(r.invoice_ref, null);
  } else if (done === "cancelled") {
    if (chain?.status === "open") return { ...r, ahead: "cancelled" };
    if (chain) setConfirmed(r.invoice_ref, null);
  }
  if (r.chain !== null) return r;
  if (mayStillOpen(r.invoice_ref)) return { ...r, stillOpening: true };
  if (startedRecently(r.created_at)) return { ...r, startedRecently: true };
  // Removable only once the network has read it as missing after the last ledger its opening could land at.
  return cannotOpenAnyMore(r) ? r : { ...r, mayOpen: true };
}

/**
 * The row as drawn now: a cancellation recorded in this browser since the list was read (this page, when the list
 * read after a lost answer failed, or another tab) holds the row too. Reads only, so it is safe while rendering
 * (adversary i16); shown() settles the record at the next list read.
 */
function heldNow(r: ShownRow): ShownRow {
  if (r.ahead || r.cancelling !== undefined || typeof r.chain !== "object" || r.chain === null || r.chain.status !== "open") return r;
  const cancelBy = cancelPendingOf(r.invoice_ref);
  return cancelBy === null ? r : { ...r, cancelling: cancelBy };
}

const MAY_OPEN =
  "Not on chain yet, and Caracal cannot show yet that its opening can no longer land (the network has not been read past its last ledger), so it may still appear: reload the page in a few minutes before removing it.";

/**
 * How long after its details were saved an opening may still land, whichever device started it. The details are
 * saved (with the server's created_at) before anything is sent; then come the passkey prompt (the kit's WebAuthn
 * timeout, 1 minute), the send (SEND_TIMEOUT_MS, 5 minutes, after which the relay's own 60 s send deadline and
 * the transaction's validity still apply). 15 minutes is well past that. Another device has no record in this
 * browser (mayStillOpen), so without this its row read "the opening did not finish" and offered Remove while the
 * opening could still land (adversary i12).
 */
const STARTED_RECENTLY_MS = 15 * 60_000;

/** Whether the details were saved within STARTED_RECENTLY_MS of now (either way, so a clock a little off still counts). */
function startedRecently(createdAt: string): boolean {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && Math.abs(Date.now() - at) < STARTED_RECENTLY_MS;
}

const STARTED_RECENTLY =
  "Not on chain yet. It was started in the last few minutes, here or on another device, so it may still appear: reload the page in a few minutes before removing it.";

const AHEAD_TEXT: Record<Confirmed, string> = {
  opened: "Opened. The network has not shown it yet: reload the page in a minute to see its pay link.",
  cancelled: "Cancelled. The network has not shown it yet: reload the page in a minute.",
};

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
  if (at === undefined) return false;
  const now = Date.now();
  if (at > now) {
    // Stamped in the future (the clock was ahead, then set back): recorded again as now, so the
    // wait is the full 3 minutes from here, not as long as the clock was off (as the wallet page, r4l).
    rememberUnknownOpening(ref);
    return true;
  }
  return now - at < OPENING_SETTLE_MS;
}

const STILL_OPENING = "Not on chain yet. Its opening's answer was lost, so it may still appear: reload the page in a few minutes before removing it.";

const ACCOUNT_CHANGED = "The signed-in account changed in another tab, so nothing was opened. Reloading for the account signed in now.";

/** Longest wait for loading the wallet kit and restoring the saved wallet: the wallet page's limit (decisions 2026-11-26, r4e). */
const RESTORE_TIMEOUT_MS = 30_000;

const SIGN_IN_UNCHECKED = "Caracal could not verify your sign-in. Check your connection and reload the page, or sign out and sign in again.";

/**
 * Why the saved wallet could not be restored, in true words (decisions r4p, r4q). smart-account-kit 0.10.0
 * says "not found on-chain" for any failed lookup, a network failure included, so the wallet's contract is
 * looked up on the network itself, as the wallet page does. An answer with no entry does not prove the wallet
 * is gone (an RPC may leave out archived data). Null for an error that is not the kit's lookup failure.
 */
async function restoreFailure(e: unknown, rpc: unknown): Promise<{ message: string; signOut?: boolean } | null> {
  const credential = credentialInKitError(e);
  if (!credential) return null;
  let contractId: string;
  try {
    contractId = walletAddressFor(credential, NETWORK.passphrase);
  } catch {
    contractId = "";
  }
  const status = contractId ? await walletStatus(rpc as LedgerReader | undefined, contractId) : "unknown";
  if (status === "not-found") {
    return {
      message:
        "Your saved wallet was not found on Stellar testnet. That does not prove it is gone: if you created it in the last few minutes the network may not show it yet, so wait a minute and reload; its data may also have expired, which the network does not always show. If the test network was reset, sign out and sign in again, then set up your wallet on the Wallet page.",
      signOut: true,
    };
  }
  if (status === "archived") return { message: "Your wallet exists on Stellar testnet, but its data has expired and must be restored before it can be used. Caracal cannot restore it yet. Do not create another wallet." };
  if (status === "present") return { message: "Your wallet exists on Stellar testnet, but Caracal could not load it just now. Reload the page in a moment." };
  return { message: "Caracal could not reach the Stellar network to load your saved wallet. Check your connection and reload the page." };
}

/** good: it happened. bad: it did not (or the page cannot go on). unsure: it may have happened. */
type Tone = "good" | "bad" | "unsure";
const TONE_CLASS: Record<Tone, string> = { good: "msg msg-good", bad: "msg msg-bad", unsure: "msg msg-unsure" };

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
  const [notice, setNoticeText] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // How the notice looks is set with its text, never guessed from the words.
  const [noticeTone, setNoticeTone] = useState<Tone>("bad");

  function setNotice(text: string | null, tone: Tone = "bad") {
    setNoticeText(text);
    setNoticeTone(tone);
  }

  async function refresh(account: string, wallet: string, split: string) {
    // Reads can finish out of order (each row read may take up to 20 s): only the latest one started is shown,
    // so an older read never puts back a row a newer one saw change (a cancelled invoice shown as open again).
    const mine = ++listReads;
    const kit = await bounded(getKit(), "Loading the wallet kit", RESTORE_TIMEOUT_MS);
    const rows = await loadRows(kit.rpc, await bounded(listDetails(db()), "Reading your saved invoices"), split);
    if (mine !== listReads) return;
    setLoad({ kind: "ready", account, wallet, split, rows: rows.map(shown) });
  }

  /** Another tab signed in as someone else (or signed out): this page's wallet and form belong to the old account, so it starts again. */
  function accountChanged() {
    setLoad({ kind: "loading" });
    window.location.reload();
  }

  useEffect(() => {
    let gone = false;
    let unfollow = () => {};
    let loadedKit: { rpc?: unknown } | undefined;
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const me = await readSignInState(auth);
      if (me.kind === "signed-out") return window.location.replace("/signin");
      if (me.kind === "unverified") return setLoad({ kind: "error", message: SIGN_IN_UNCHECKED, signOut: true });
      if (gone) return;
      unfollow = followAccount(auth, me.id, accountChanged);
      const kit = await bounded(getKit(), "Loading the wallet kit", RESTORE_TIMEOUT_MS);
      loadedKit = kit;
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
    })().catch(async (e: unknown) => {
      console.error("invoices page:", e instanceof Error ? e.message : String(e));
      if (gone) return;
      const failure = await restoreFailure(e, loadedKit?.rpc);
      if (gone) return;
      if (failure) return setLoad({ kind: "error", message: `Caracal could not load your invoices. ${failure.message}`, signOut: failure.signOut });
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
    // Bounded: a database that never answers ends in "could not verify", not an endless busy page (adversary i15).
    const now: SignInState = await bounded(readSignInState(supabaseBrowser().auth), "Checking your sign-in").catch(() => ({ kind: "unverified" }) as const);
    if (now.kind !== "verified" || now.id !== ready.account) {
      setBusy(null);
      if (now.kind === "unverified") return setNotice("Caracal could not verify your sign-in, so nothing was opened. Check your connection and try again.");
      setNotice(ACCOUNT_CHANGED);
      return accountChanged();
    }
    // The opening cannot land after this ledger (its passkey signature expires), which is saved with the details,
    // so any device can tell when an entry that never reached the chain is safe to remove (Codex invoices R1 #2).
    let opensBy: number;
    try {
      opensBy = (await latestLedger(kit.rpc)) + OPENING_LEDGERS;
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not read the Stellar network, so nothing was opened. Try again. ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      // The details are saved first, so an invoice that reached the chain always has its client name here. The
      // account checked above is sent as the owner, so a session switched since then is refused by the database.
      // Bounded (adversary i15). A save that answers late may still add the entry: it then shows as never opened,
      // and can be removed once the network passes its last ledger, like any opening that did not finish.
      await bounded(saveDetails(db(), { owner_id: ready.account, invoice_ref: ref, split: ready.split, client_name: details.name, description: details.description, opens_by_ledger: opensBy }), "Saving the client's name");
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not save the client's name, so nothing was opened. If an entry for it appears in the list, it was never opened and can be removed. ${e instanceof Error ? e.message : String(e)}`);
    }
    // Recorded before anything is sent and renewed while the opening is on its way, so a reload or a closed tab
    // mid-send still holds back "Remove this entry" until the opening can no longer land.
    rememberUnknownOpening(ref);
    const beat = setInterval(() => rememberUnknownOpening(ref), OPENING_HEARTBEAT_MS);
    const leaving = () => rememberUnknownOpening(ref);
    window.addEventListener?.("pagehide", leaving);
    let outcome: Awaited<ReturnType<typeof createInvoice>>;
    try {
      outcome = await createInvoice(kit, ready.split, ref, stroops, opensBy);
    } finally {
      clearInterval(beat);
      window.removeEventListener?.("pagehide", leaving);
    }
    if (outcome.kind === "not-sent" || outcome.kind === "failed") {
      // Nothing is on chain: the saved details are removed again.
      try {
        // Bounded, so the outcome is shown even when the database does not answer (adversary i15).
        await bounded(deleteDetails(db(), ref), "Removing the unused details");
      } catch (e) {
        console.error("could not remove unused invoice details:", e instanceof Error ? e.message : String(e));
      }
    }
    setBusy(null);
    if (outcome.kind === "unknown") rememberUnknownOpening(ref);
    else forgetOpening(ref);
    // Confirmed on chain: a read that has not caught up must not call it unopened (shown()).
    if (outcome.kind === "done") setConfirmed(ref, "opened");
    let said: string;
    if (outcome.kind !== "done") said = outcomeText(outcome, "Opening the invoice");
    else {
      setAmount("");
      setClient("");
      setDescription("");
      said = "Invoice opened. Copy its pay link below and send it to your client.";
    }
    setNotice(said, outcome.kind === "done" ? "good" : outcome.kind === "unknown" ? "unsure" : "bad");
    if (outcome.kind !== "not-sent" && outcome.kind !== "failed") await refresh(ready.account, ready.wallet, ready.split).catch(listFailed(said));
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
    // The cancellation's last ledger is fixed before the passkey is asked, and kept in this browser until its
    // outcome is known, so a lost answer is shown on the row, after a reload too (Codex invoices R3 #2).
    let cancelBy: number;
    try {
      cancelBy = (await latestLedger(kit.rpc)) + OPENING_LEDGERS;
    } catch (e) {
      setBusy(null);
      return setNotice(`Caracal could not read the Stellar network, so nothing was cancelled. ${e instanceof Error ? e.message : String(e)}`);
    }
    // An earlier cancellation from this browser (this page before a reload, or another tab) may still land: nothing
    // new is sent, read now, at the press, as the pay page does for a payment (adversary i15). The list is read
    // again, which settles that record once the invoice reads cancelled or paid, or open past its last ledger.
    const earlier = cancelPendingOf(ref);
    if (earlier !== null) {
      setBusy(null);
      setNotice(CANCELLING_TEXT(earlier), "unsure");
      return refresh(ready.account, ready.wallet, ready.split).catch(listFailed(CANCELLING_TEXT(earlier)));
    }
    setCancelPending(ref, cancelBy);
    const outcome = await cancelInvoice(kit, ready.split, ref, cancelBy);
    // Only this attempt's own record is cleared, never one written meanwhile by another tab.
    if (outcome.kind !== "unknown" && cancelPendingOf(ref) === cancelBy) setCancelPending(ref, null);
    setBusy(null);
    // Confirmed on chain: a read that has not caught up must not offer the pay link again (shown()).
    if (outcome.kind === "done") setConfirmed(ref, "cancelled");
    const said = outcome.kind === "done" ? "Invoice cancelled. Its pay link no longer works." : outcomeText(outcome, "Cancelling the invoice");
    setNotice(said, outcome.kind === "done" ? "good" : outcome.kind === "unknown" ? "unsure" : "bad");
    await refresh(ready.account, ready.wallet, ready.split).catch(listFailed(said));
  }

  /** An entry the chain has no invoice for (opening it did not finish) can be removed from the list. */
  async function removeUnopened(ready: Ready, ref: string) {
    // Read again now: the list may be old, and only a read past the opening's last ledger proves it never landed.
    const row = ready.rows.find((r) => r.invoice_ref === ref);
    let gone = false;
    try {
      const kit = await getKit();
      const { invoice, ledger } = await readInvoiceAt(kit.rpc, ready.split, ref);
      gone = row !== undefined && cannotOpenAnyMore({ chain: invoice, readAt: ledger, opens_by_ledger: row.opens_by_ledger });
    } catch (e) {
      console.error("could not check an entry before removing it:", e instanceof Error ? e.message : String(e));
    }
    if (!gone) {
      setNotice("Caracal could not confirm that this invoice can no longer be opened, so its entry was kept. Reload the page in a few minutes and try again.", "unsure");
      return refresh(ready.account, ready.wallet, ready.split).catch(listFailed("The entry was kept."));
    }
    try {
      await bounded(deleteDetails(db(), ref), "Removing the entry");
    } catch (e) {
      return setNotice(`Caracal could not remove that entry. ${e instanceof Error ? e.message : String(e)}`);
    }
    await refresh(ready.account, ready.wallet, ready.split).catch(listFailed("Entry removed."));
  }

  /** A list read that failed after a write: what the write did is kept, and the failed read is added to it. */
  function listFailed(said: string) {
    return (e: unknown) => setNotice(`${said} The invoice list could not be refreshed, so it may be out of date. Reload the page. ${e instanceof Error ? e.message : String(e)}`, "unsure");
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
    <main className="page page-wide">
      <h1 className="h1">Invoices</h1>
      {load.kind === "loading" && <p className="small muted">Loading your invoices.</p>}
      {load.kind === "error" && (
        <div className="flex flex-col gap-2">
          <p className="msg msg-bad">{load.message}</p>
          {load.signOut && (
            <a className="link small self-start" href="/signin">
              Sign out on the sign-in page
            </a>
          )}
        </div>
      )}
      {load.kind === "no-wallet" && (
        <p className="msg msg-info">
          Invoices are opened from your Caracal wallet. <a className="link" href="/wallet">Create or connect your wallet</a> first.
        </p>
      )}
      {load.kind === "no-split" && (
        <p className="msg msg-info">
          Your split contract is not on Stellar yet, so there is nothing to open an invoice on. <a className="link" href="/split">Set up your split</a> first.
        </p>
      )}
      {load.kind === "ready" && (
        <>
          <form
            className="card"
            onSubmit={(e) => {
              e.preventDefault();
              void create(load);
            }}
          >
            <h2 className="h2">New invoice</h2>
            <label className="field">
              Client
              <input className="input" value={client} maxLength={120} onChange={(e) => setClient(e.target.value)} />
            </label>
            <label className="field">
              What it is for (optional)
              <input className="input" value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} />
            </label>
            <label className="field">
              Amount in USDC
              <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
            <p className="small muted">
              Only an invoice id and the amount go on the blockchain. The client name and description stay in your Caracal account. The client pays exactly this amount, once.
            </p>
            <button className="btn btn-primary btn-block" type="submit" disabled={busy !== null}>
              Open invoice
            </button>
          </form>
          {busy && <p className="small muted">{busy}</p>}
          {notice && <p className={TONE_CLASS[noticeTone]}>{notice}</p>}
          <section className="list">
            <h2 className="h2">Your invoices</h2>
            {load.rows.length === 0 && <p className="small muted">No invoices yet.</p>}
            {load.rows.map((row) => {
              const r = heldNow(row);
              const link = `${window.location.origin}${payPath(r.split, r.invoice_ref)}`;
              return (
                <article key={r.invoice_ref} className="item">
                  <p className="num">
                    <strong>{r.client_name}</strong>
                    {typeof r.chain === "object" && r.chain !== null && <> , {formatUsdc(r.chain.amount)} USDC</>}
                  </p>
                  {r.description && <p className="small muted">{r.description}</p>}
                  <div className={r.ahead || r.cancelling !== undefined || r.chain === "unreadable" || (r.chain === null && (r.stillOpening || r.startedRecently || r.mayOpen)) ? "chip chip-unsure self-start" : r.chain === null || r.chain.status === "cancelled" ? "chip chip-bad self-start" : r.chain.status === "paid" ? "chip chip-good self-start" : "chip self-start"}>
                  <p>{r.ahead ? AHEAD_TEXT[r.ahead] : r.cancelling !== undefined ? CANCELLING_TEXT(r.cancelling) : r.chain === null && r.stillOpening ? STILL_OPENING : r.chain === null && r.startedRecently ? STARTED_RECENTLY : r.chain === null && r.mayOpen ? MAY_OPEN : statusText(r.chain)}</p>
                  </div>
                  {r.chain === null && !r.stillOpening && !r.startedRecently && !r.mayOpen && !r.ahead && (
                    <p>
                      <button className="link small" onClick={() => void removeUnopened(load, r.invoice_ref)}>
                        Remove this entry
                      </button>
                    </p>
                  )}
                  {!r.ahead && r.cancelling === undefined && typeof r.chain === "object" && r.chain !== null && r.chain.status === "open" && (
                    <>
                      <p className="addr addr-box">{link}</p>
                      <p className="flex flex-wrap gap-2">
                        <button className="btn btn-secondary btn-sm" onClick={() => void copy(link, r.invoice_ref)}>
                          {copied === r.invoice_ref ? "Link copied" : "Copy pay link"}
                        </button>
                        <button className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void cancel(load, r.invoice_ref)}>
                          Cancel invoice
                        </button>
                      </p>
                    </>
                  )}
                  {typeof r.chain === "object" && r.chain !== null && r.chain.status === "paid" && (
                    <p className="small muted">
                      {r.txHash ? (
                        <a className="link" href={`/receipt/${r.txHash}`}>
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
