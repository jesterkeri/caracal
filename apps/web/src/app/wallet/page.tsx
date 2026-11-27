"use client";

import { useEffect, useState } from "react";
import { bindIfStillSignedIn, followAccount, readSignInState } from "@/lib/auth/account";
import {
  SIGN_OUT_FAILED,
  WALLET_OWNER_KEY,
  browserStore,
  endSupabaseSession,
  mayRestoreWallet,
  rememberWallet,
  knownWalletFor,
  rememberedWallet,
  signOutEverywhere,
} from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { withCreationCloseBy } from "@/lib/stellar/creation-close-by";
import { passkeyName } from "@/lib/stellar/passkey-name";
import { CREATION_CLOSE_LEDGERS, CREATION_HEARTBEAT_MS, CREATION_SETTLE_MS, creationMarker } from "@/lib/auth/creation-marker";
import { browserLocks, withCreationLock } from "@/lib/auth/creation-lock";
import { NETWORK, explorerLink } from "@/lib/stellar/config";
import { LOOKUP_TIMEOUT_MS, credentialInKitError, walletAddressFor, walletStatus, type LedgerReader, type WalletStatus } from "@/lib/stellar/wallet-lookup";

type Account = { id: string; email: string | null };

const ACCOUNT_CHANGED = "The signed-in account changed. Reloading";
const SIGN_IN_UNCHECKED = "Caracal could not verify your sign-in. Check your connection and reload the page, or sign out and sign in again.";
const WALLET_UNCHECKED = "Caracal could not load your saved wallet. Check your connection and reload the page.";
const STORAGE_BLOCKED =
  "This browser is blocking site storage (site data), which the wallet needs to remember your passkey. Allow site data for this site, or leave private browsing, then reload the page.";

/**
 * Whether a failure is the browser refusing site storage: the wallet kit reads
 * localStorage when it starts (a SecurityError naming localStorage when site
 * data is blocked) and keeps its passkey records in IndexedDB. A reload cannot
 * fix that. The error must name the storage: a passkey prompt also raises
 * SecurityError (an IP address as the site, passkeys refused in a frame), and
 * that is not a storage problem.
 */
function storageBlocked(e: unknown): boolean {
  if (!(e instanceof Error) && !(e instanceof DOMException)) return false;
  return /IndexedDB|localStorage|sessionStorage|site data/i.test(e.message);
}

/** What a failed Create or Connect shows: blocked storage by name, anything else as the kit said it. */
function failureText(e: unknown): string {
  if (storageBlocked(e)) return STORAGE_BLOCKED;
  return e instanceof Error ? e.message : String(e);
}

// True while this tab signs out. Its own sign-out event is then not taken for
// a change made in another tab, and does not reload the page mid sign-out.
let signingOutHere = false;
// Counts sign-outs started here. A restore that began before one is out of
// date whether that sign-out succeeded or failed: the sign-out disconnected
// the wallet and removed its owner either way.
let signOutsStartedHere = 0;

/** Longest wait for loading the wallet kit and restoring a saved wallet (provenance check and RPC reads). */
const RESTORE_TIMEOUT_MS = 30_000;

/** `p`, or a rejection once `ms` has passed: a restore that never answers ends in an error, not endless "Checking". */
function restoreWithin<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${RESTORE_TIMEOUT_MS} ms`)), RESTORE_TIMEOUT_MS);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** smart-account-kit 0.10.0 errors raised only after it found a contract at the passkey's address. */
const WALLET_PROVEN_ERRORS = new Set(["WalletProvenanceError", "WalletAmbiguousError", "WalletOwnershipError", "WalletCodeNotAcceptedError"]);

const { creationUnconfirmedFor, creationAge, markCreation, pendingWalletFor, closeLedger, recordCloseLedger, possibleWalletsFor, rememberPossibleWallet } =
  creationMarker(browserStore);

// An empty answer does not prove there is no wallet: an RPC may leave out a
// wallet whose data was archived (wallet-lookup.ts). The text says only that.
const NO_WALLET_FOR_PASSKEY =
  "No wallet was found on Stellar testnet for this passkey. That does not prove there is none: the network may not show a wallet whose data has expired. If it was created a moment ago, wait a minute and try again, or choose another passkey.";
const SAVED_WALLET_GONE =
  "Your saved wallet was not found on Stellar testnet. That does not prove it is gone: if you created it in the last few minutes the network may not show it yet, so wait a minute and reload; its data may also have expired, which the network does not always show. Do not make another wallet unless you know this one is gone. If the test network was reset, sign out and sign in again: the page then offers a new wallet as an explicit choice.";
const WALLET_ARCHIVED =
  "Your wallet exists on Stellar testnet, but its data has expired and must be restored before it can be used. Caracal cannot restore it yet. Do not create another wallet.";
const WALLET_EXISTS_UNREAD = "Your wallet exists on Stellar testnet, but Caracal could not load it just now. Try again in a moment.";
const WALLET_STATUS_UNKNOWN =
  "Caracal could not reach the Stellar network to check whether a wallet exists for this passkey. Check your connection and try again.";

/**
 * After smart-account-kit's "not found on-chain" (said for any failed lookup):
 * the wallet contract for that passkey, looked up on the network itself. Null
 * for any other error.
 */
async function lookedUp(e: unknown, kit: { rpc?: unknown } | undefined): Promise<WalletStatus | null> {
  const credential = credentialInKitError(e);
  if (!credential) return null;
  let contractId: string;
  try {
    contractId = walletAddressFor(credential, NETWORK.passphrase);
  } catch {
    return "unknown";
  }
  return walletStatus(kit?.rpc as LedgerReader | undefined, contractId);
}

const WALLET_RECORDED_ELSEWHERE =
  "This account already has a wallet on this browser, created or connected in another tab. Reload the page to open it.";

const CREATION_TOO_RECENT =
  "The last attempt started less than 3 minutes ago and may still finish. Wait a few minutes, then check with \"I already have a wallet\" first.";

const LEDGER_UNREAD =
  "Caracal could not read the Stellar network just now, so it cannot tell yet whether the earlier attempt can still finish. Nothing was created. Try again in a minute.";
const creationClosing = (ledger: number) =>
  `The earlier attempt could still land on the network until ledger ${ledger} has closed (about 3 minutes after it started, longer if the network is slow). Nothing was created. Try again after that.`;
const CLOSE_LEDGER_UNKNOWN =
  "This browser holds an earlier wallet attempt whose last possible ledger was not recorded (it was started by an older version of Caracal, or this browser's storage was cleared or blocked), so Caracal cannot tell whether it can still land and will not start another. Use \"I already have a wallet\" to check. If you are sure no wallet was made, clearing this site's data in your browser removes the record.";
const NETWORK_UNREAD_BEFORE_CREATE =
  "Caracal could not read the Stellar network, so nothing was created or sent. Check your connection and try again.";
const earlierNotFound = (wallet: string) =>
  `The earlier attempt can no longer land, and its wallet ${wallet} was not found on Stellar testnet. That does not prove it was not made: the network may not show a wallet whose data has expired. Use "I already have a wallet" with that passkey to check. If you make a new wallet anyway and the first one exists, you will have two; Caracal keeps showing the first address here.`;
const possiblyMade = (wallets: string[]) =>
  `An earlier attempt may have made ${wallets.length === 1 ? "the wallet" : "the wallets"} ${wallets.join(", ")}. The network did not show ${wallets.length === 1 ? "it" : "them"}, which does not prove ${wallets.length === 1 ? "it does" : "they do"} not exist. If you made ${wallets.length === 1 ? "it" : "one"} with a passkey on this device, "I already have a wallet" opens it.`;
const attemptLanded = (wallet: string) =>
  `The earlier attempt created your wallet after all: ${wallet}. Use "I already have a wallet" to open it with your passkey.`;

/** The network's latest ledger, or null when it could not be read within 10 s. */
async function latestLedger(rpc: unknown): Promise<number | null> {
  const r = rpc as { getLatestLedger?: () => Promise<{ sequence?: unknown }> } | undefined;
  if (typeof r?.getLatestLedger !== "function") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      r.getLatestLedger(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), LOOKUP_TIMEOUT_MS);
      }),
    ]);
    return typeof answer?.sequence === "number" && Number.isSafeInteger(answer.sequence) && answer.sequence > 0 ? answer.sequence : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const CREATION_IN_PROGRESS =
  "An earlier wallet creation for this account could not be confirmed.";
const CREATION_UNDER_WAY =
  "A wallet creation is already under way in another tab of this browser, or in this one. Wait for it to finish, then reload this page.";
const LOCKS_REFUSED =
  "This browser refused to let Caracal make sure that only one tab creates your wallet, so nothing was created. If site data is blocked for this site or you are in private browsing, allow it and reload the page; otherwise use a current version of Chrome, Edge, Safari or Firefox.";
const LOCKS_UNSUPPORTED =
  "This browser cannot make sure that only one tab creates your wallet. Use a current version of Chrome, Edge, Safari or Firefox to create it.";

/** Shown under a failure after which a wallet may already exist, unless the failure already says it. */
const KNOWN_WALLETS_UNREAD =
  "Caracal could not read this browser's record of your wallet (site storage is blocked or unreadable), so it cannot tell whether this account already has one. Use \"I already have a wallet\" with your passkey first.";

const WALLET_MAYBE_EXISTS =
  "Your wallet may already exist. Before creating another, reload the page and check with \"I already have a wallet\", using your passkey.";

type State =
  // knownWallet: this account has, or may have, a wallet already (one was
  // restored and then disconnected, or one is recorded as its own here).
  // remembered: the wallet this account last connected on this browser (kept
  // after sign-out); a new wallet is then offered only as an explicit choice.
  // storageUnread: this browser's record of the account's wallet could not be
  // read, so whether it has one is unknown; Connect first, a new wallet only
  // as an explicit choice with that warning.
  | { kind: "idle"; knownWallet?: boolean; checkFirst?: boolean; remembered?: string; storageUnread?: boolean }
  | { kind: "busy"; label: string }
  | { kind: "connected"; contractId: string; txHash?: string }
  // Create is offered after an error only with createAllowed: when the page
  // knows that no wallet was made (the passkey step failed, or the relay said
  // nothing was sent) and none was known before. Otherwise only Connect is
  // offered: a second try could make a second passkey and an orphan wallet.
  // checkFirst: a creation whose outcome is unknown; the page says to check
  // with Connect before creating another.
  | {
      kind: "error";
      message: string;
      createAllowed?: boolean;
      checkFirst?: boolean;
      remembered?: string;
      storageUnread?: boolean;
      /** The earlier attempt's wallet, not found: a new wallet only as a choice made knowing it may exist. */
      notFound?: string;
    };

/** A state's remembered wallet, or that this browser's record of it could not be read. */
function recordOf(id: string): { remembered?: string; storageUnread?: true } {
  const k = knownWalletFor(browserStore, id);
  return k.kind === "known" ? { remembered: k.wallet } : k.kind === "unreadable" ? { storageUnread: true } : {};
}

/** Create is offered only where the page knows this account has no wallet yet. */
function createOffered(state: State): boolean {
  if (state.kind === "idle") return !state.knownWallet;
  return state.kind === "error" && state.createAllowed === true;
}


export default function WalletPage() {
  const [state, setState] = useState<State>({ kind: "busy", label: "Checking for a saved wallet" });
  const [name, setName] = useState("");
  const [account, setAccount] = useState<Account | null>(null);

  // The account changed (signed out, or another account signed in, maybe in
  // another tab): nothing of the old account stays on screen, and the page
  // starts again for whoever is signed in now.
  function accountChanged() {
    setAccount(null);
    setState({ kind: "busy", label: ACCOUNT_CHANGED });
    window.location.reload();
  }

  useEffect(() => {
    // The wallet belongs to a signed-in account. A saved wallet session is
    // restored only for the account that created or connected it.
    let unfollow: (() => void) | undefined;
    let gone = false;
    let verified = false;
    let loadedKit: Awaited<ReturnType<typeof getKit>> | undefined;
    // Set once the account changed (here or in another tab). Restoring takes
    // seconds; whatever it finds after that is no longer this account's to show.
    let accountMoved = false;
    // The restore's later steps do nothing once the page unmounted, the account
    // changed, or this tab signed out (the page is then on its way to /signin).
    const signOutsAtStart = signOutsStartedHere;
    const stale = () => gone || accountMoved || signingOutHere || signOutsStartedHere !== signOutsAtStart;
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const now = await readSignInState(auth);
      if (now.kind === "signed-out") return window.location.replace("/signin");
      if (now.kind === "unverified") throw new Error("the sign-in could not be verified");
      if (stale()) return;
      verified = true;
      const me = { id: now.id, email: now.email };
      unfollow = followAccount(
        auth,
        me.id,
        () => {
          accountMoved = true;
          accountChanged();
        },
        () => signingOutHere,
      );
      setAccount(me);
      const kit = await restoreWithin(getKit(), "loading the wallet kit");
      loadedKit = kit;
      if (stale()) return;
      const mayRestore = await mayRestoreWallet(browserStore, kit, me.id);
      if (stale()) return;
      if (!mayRestore) {
        // An earlier creation by this account whose outcome is unknown, or a
        // wallet it connected here before signing out: Connect first.
        const unconfirmed = creationUnconfirmedFor(me.id);
        const known = knownWalletFor(browserStore, me.id);
        const remembered = known.kind === "known" ? known.wallet : undefined;
        if (unconfirmed || remembered) return setState({ kind: "idle", knownWallet: true, checkFirst: unconfirmed || undefined, remembered });
        // Plain Create only where the record was read and names no wallet.
        return setState(known.kind === "unreadable" ? { kind: "idle", knownWallet: true, storageUnread: true } : { kind: "idle" });
      }
      const r = await restoreWithin(kit.connectWallet(), "restoring the saved wallet");
      if (stale()) return;
      if (r) rememberWallet(browserStore, me.id, r.contractId);
      setState(r ? { kind: "connected", contractId: r.contractId } : { kind: "idle", knownWallet: true, ...recordOf(me.id) });
    })().catch(async (e: unknown) => {
      console.error("could not check the sign-in or saved wallet:", e instanceof Error ? e.message : String(e));
      if (stale()) return;
      // The kit says "not found on-chain" for any failed lookup, so the saved
      // wallet's contract is looked up itself. An answer with no entry does
      // not prove the wallet is gone (an RPC may leave out archived data), so
      // the message says only what was seen and does not offer a new wallet.
      const status = verified ? await lookedUp(e, loadedKit) : null;
      if (stale()) return;
      if (status === "not-found") return setState({ kind: "error", message: SAVED_WALLET_GONE });
      if (status === "archived") return setState({ kind: "error", message: WALLET_ARCHIVED });
      // Without a known account a new wallet could not be bound to its owner,
      // so creating or connecting is offered only after a successful check.
      // Each failure is named for what failed: a wrong RPC setting, the wallet
      // after a verified sign-in, or the sign-in check itself.
      const message =
        e instanceof Error && e.message === HTTPS_RPC_REQUIRED ? HTTPS_RPC_REQUIRED : verified && storageBlocked(e) ? STORAGE_BLOCKED : verified ? WALLET_UNCHECKED : SIGN_IN_UNCHECKED;
      // Create is not offered: whether this account has a wallet is unknown
      // (the kit or the saved wallet could not be loaded). Reloading retries.
      setState({ kind: "error", message });
    });
    return () => {
      gone = true;
      unfollow?.();
    };
  }, []);

  /** created: this wallet is the one this page's own creation just made. */
  async function connected(contractId: string, txHash?: string, created = false) {
    if (!account) return;
    // The account may have changed since the page loaded (another tab), so it
    // is confirmed again before this wallet is recorded as its.
    const bound = await bindIfStillSignedIn(browserStore, supabaseBrowser().auth, getKit(), account.id);
    if (bound === "account-changed") return accountChanged();
    // Recorded as this account's: a reload restores it, so the note goes.
    // "not-saved" keeps it: nothing on this browser would remember the wallet.
    if (bound === "bound") {
      // Only the attempt's own wallet confirms it. Connecting an older wallet
      // says nothing about whether the unconfirmed attempt may still land.
      if (created || pendingWalletFor(account.id) === contractId) markCreation(account.id, false);
      rememberWallet(browserStore, account.id, contractId);
    }
    // "not-saved": the wallet is this person's for this visit, but it will not
    // be restored on a later visit (mayRestoreWallet fails closed).
    setState({ kind: "connected", contractId, txHash });
  }

  async function signOut() {
    signingOutHere = true;
    signOutsStartedHere += 1;
    try {
      await signOutEverywhere(browserStore, getKit(), () => endSupabaseSession(supabaseBrowser().auth));
    } catch (e) {
      signingOutHere = false;
      console.error(e instanceof Error ? e.message : String(e));
      // The wallet is already disconnected and unbound; only the session survived.
      setState({ kind: "error", message: SIGN_OUT_FAILED });
      return;
    }
    window.location.replace("/signin");
  }

  /**
   * Creates a wallet, holding this browser's creation lock throughout, so no
   * other tab can start one until this attempt's outcome is recorded.
   * anyway: the person chose to start a new wallet after an unknown outcome.
   * secondTo: the person chose a second wallet, having been shown this one.
   */
  async function create(choice: { anyway?: boolean; secondTo?: string; despiteNotFound?: string } = {}) {
    if (!account) return; // a wallet is always bound to its signed-in owner
    const me = account;
    const out = await withCreationLock(browserLocks(), () => createHoldingLock(me, choice));
    if (out.ran) return;
    setState(
      out.why === "busy"
        ? { kind: "error", message: CREATION_UNDER_WAY, checkFirst: true, remembered: choice.secondTo }
        : { kind: "error", message: out.why === "refused" ? LOCKS_REFUSED : LOCKS_UNSUPPORTED, ...recordOf(me.id) },
    );
  }

  /**
   * True once the latest attempt can no longer land and the network shows no
   * wallet of it; { notFound } when its wallet's address is known and the
   * network did not show it (which does not prove it was not made); otherwise
   * what to tell the person. Called only after the time wait.
   */
  async function attemptSettled(me: Account): Promise<true | { notFound: string } | string> {
    // The close ledger was recorded before the attempt was sent, and the relay
    // let it land no later (creation-marker.ts). Without it nothing bounds it.
    const close = closeLedger();
    if (close === null) return CLOSE_LEDGER_UNKNOWN;
    let rpc: unknown;
    try {
      rpc = (await getKit()).rpc;
    } catch {
      return LEDGER_UNREAD;
    }
    const latest = await latestLedger(rpc);
    if (latest === null) return LEDGER_UNREAD;
    // An RPC can lag the network but never run ahead of it: a later ledger here proves the network passed `close`.
    if (latest <= close) return creationClosing(close);
    // The attempt can no longer land. If it made a wallet, that is the one to use.
    const pending = pendingWalletFor(me.id);
    if (pending) {
      const status = await walletStatus(rpc as LedgerReader | undefined, pending);
      if (status === "present" || status === "archived") return attemptLanded(pending);
      if (status === "unknown") return LEDGER_UNREAD;
      return { notFound: pending };
    }
    return true;
  }

  async function createHoldingLock(
    me: Account,
    { anyway = false, secondTo, despiteNotFound }: { anyway?: boolean; secondTo?: string; despiteNotFound?: string },
  ) {
    if (anyway) {
      // Only once the last attempt cannot still finish (creation-marker.ts):
      // first the relay can no longer send it (a wait in time), then its
      // authorisation has expired (a wait in ledgers, which a slow network
      // stretches), and its own wallet, if known, is not on the chain.
      if (creationAge() < CREATION_SETTLE_MS) {
        setState({ kind: "error", message: CREATION_TOO_RECENT, checkFirst: true, remembered: secondTo });
        return;
      }
      const settled = await attemptSettled(me);
      if (typeof settled === "string") {
        setState({ kind: "error", message: settled, checkFirst: !settled.startsWith("The earlier attempt created"), remembered: secondTo });
        return;
      }
      if (settled !== true) {
        // Not found is not proof it was not made: the person chooses, told so, and the address is kept.
        if (despiteNotFound !== settled.notFound) {
          setState({ kind: "error", message: earlierNotFound(settled.notFound), checkFirst: true, remembered: secondTo, notFound: settled.notFound });
          return;
        }
        rememberPossibleWallet(me.id, settled.notFound);
      }
      markCreation(me.id, false);
    }
    // An earlier attempt's outcome is unknown: do not start a second.
    if (creationUnconfirmedFor(me.id)) {
      setState({ kind: "error", message: CREATION_IN_PROGRESS, checkFirst: true, remembered: secondTo });
      return;
    }
    // This page may be older than a wallet created since in another tab:
    // the record is read again, not the state the page loaded with.
    let recordedOwner: string | null = null;
    try {
      recordedOwner = browserStore.getItem(WALLET_OWNER_KEY);
    } catch {
      // storage blocked: nothing can have been recorded by another tab either
    }
    // The person who chose a second wallet, shown this account's wallet, has
    // a binding left from it (after Disconnect, or an expired session): that
    // is the wallet they were shown, not one made elsewhere since, unless the
    // remembered wallet changed meanwhile.
    const chosenSecond = secondTo !== undefined && rememberedWallet(browserStore, me.id) === secondTo;
    if (recordedOwner === me.id && !chosenSecond) {
      setState({ kind: "error", message: WALLET_RECORDED_ELSEWHERE });
      return;
    }
    // Nothing was made or sent: what was known before still holds. A wallet
    // this account had here is named again, and a new one stays an explicit
    // choice; plain Create only where none was known.
    const nothingMade = (message: string) => {
      const known = knownWalletFor(browserStore, me.id);
      setState(
        known.kind === "known"
          ? { kind: "error", message, remembered: known.wallet }
          : known.kind === "unreadable"
            ? { kind: "error", message, storageUnread: true }
            : { kind: "error", message, createAllowed: true },
      );
    };
    setState({ kind: "busy", label: "Creating your passkey and wallet" });
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit();
    } catch (e) {
      nothingMade(failureText(e));
      return;
    }
    // The last ledger this attempt may land in, recorded before anything is
    // sent and sent to the relay, which keeps the attempt within it
    // (creation-marker.ts CREATION_CLOSE_LEDGER_KEY).
    const readAt = await latestLedger(kit.rpc);
    if (readAt === null) {
      nothingMade(NETWORK_UNREAD_BEFORE_CREATE);
      return;
    }
    const closeBy = readAt + CREATION_CLOSE_LEDGERS;
    // The kit announces credentialCreated once the passkey exists, before the
    // wallet is built or sent. A failure before it sent nothing, whatever its
    // error; one after it may follow a deploy (the kit saves its session after
    // submitting). Without the event API nothing can be told apart, so every
    // failure counts as after.
    let passkeyMade = typeof kit.events?.on !== "function";
    const stop = kit.events?.on?.("credentialCreated", (e?: { credential?: { contractId?: unknown } }) => {
      passkeyMade = true;
      // The wait before "Start a new one anyway" counts from here, not from
      // before the passkey prompt (which can take a minute). The address the
      // attempt would create is kept: connecting it later confirms the attempt.
      const wallet = e?.credential?.contractId;
      markCreation(me.id, true, typeof wallet === "string" ? wallet : undefined);
    });
    markCreation(me.id, true);
    recordCloseLedger(closeBy);
    // While the attempt runs, its start time is renewed, so if this tab
    // closes mid-attempt the wait counts from its last sign of life.
    const beat = setInterval(() => markCreation(me.id, true), CREATION_HEARTBEAT_MS);
    // A background tab's timers can be slowed to once a minute, so closing or
    // leaving the page renews the start time too.
    const leaving = () => markCreation(me.id, true);
    window.addEventListener?.("pagehide", leaving);
    let r: Awaited<ReturnType<typeof kit.createWallet>>;
    try {
      r = await withCreationCloseBy(kit, closeBy, () => kit.createWallet("Caracal", passkeyName(name), { autoSubmit: true }));
    } catch (e) {
      const message = failureText(e);
      // An unknown outcome: the wait counts from now, when it ended here.
      markCreation(me.id, passkeyMade);
      if (passkeyMade) setState({ kind: "error", message, checkFirst: true, remembered: secondTo });
      else nothingMade(message);
      return;
    } finally {
      clearInterval(beat);
      window.removeEventListener?.("pagehide", leaving);
      stop?.();
    }
    if (r.submitResult && !r.submitResult.success) {
      // Only the relay's own answer can prove nothing was sent: its refusals
      // before sending say "Nothing was sent". Anything else (a hash, a
      // timeout, a gateway page, a refusal of unknown timing) may have created
      // the wallet, so a second try could make another.
      const detail = r.submitResult.error.message;
      const sent = "hash" in r.submitResult && typeof r.submitResult.hash === "string" && r.submitResult.hash !== "";
      if (!sent && detail.includes("Nothing was sent")) {
        markCreation(me.id, false);
        return nothingMade(detail);
      }
      markCreation(me.id, true);
      setState({ kind: "error", message: detail, checkFirst: true, remembered: secondTo });
      return;
    }
    try {
      await connected(r.contractId, r.submitResult?.success ? r.submitResult.hash : undefined, true);
    } catch (e) {
      // The wallet was made; only recording its owner failed.
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), checkFirst: true, remembered: secondTo });
    }
  }

  /**
   * After an unknown outcome, the person checked with Connect and found no
   * wallet. If the attempt was a second wallet beside one this page showed,
   * that same wallet is passed on, so this account's own binding does not
   * refuse it; a wallet recorded since (by another tab) still does.
   */
  function createAnyway() {
    const shown = state.kind === "error" || state.kind === "idle" ? state.remembered : undefined;
    return create({ anyway: true, secondTo: shown });
  }

  async function connect() {
    if (!account) return; // a wallet is always bound to its signed-in owner
    const couldCreate = createOffered(state);
    setState({ kind: "busy", label: "Waiting for your passkey" });
    let kit: Awaited<ReturnType<typeof getKit>> | undefined;
    try {
      kit = await getKit();
      // fresh: always ask for this person's passkey. { prompt: true } would
      // first reuse a stored session, which could be the previous person's if
      // their disconnect failed, and then bind it to this account.
      const r = await kit.connectWallet({ fresh: true });
      // An unconfirmed creation of this account keeps its hint and its way
      // out ("Start a new one anyway") after a Connect that found nothing.
      const unconfirmed = creationUnconfirmedFor(account.id);
      if (r) await connected(r.contractId);
      else setState({ kind: "idle", knownWallet: !couldCreate, checkFirst: unconfirmed, ...recordOf(account.id) });
    } catch (e) {
      // Not createAllowed: the kit's checks that fail after it found a contract
      // at this passkey's address (provenance, ownership, wallet code) prove a
      // wallet exists. Reloading offers Create again when none is recorded.
      // Only those keep the way out hidden: any other failure (no contract at
      // this passkey's address, a closed prompt) leaves it for an unconfirmed
      // creation.
      // The kit says "not found on-chain" for any failed lookup, a network
      // failure included, so the page looks up that passkey's wallet contract
      // itself. An answer with no entry is "not found", never proof of no
      // wallet (an RPC may leave out archived data); a failed lookup is "could
      // not check". Neither proves a wallet, so both keep the hint to check first.
      const status = await lookedUp(e, kit);
      const proven = (e instanceof Error && WALLET_PROVEN_ERRORS.has(e.name)) || status === "present" || status === "archived";
      const message =
        status === "not-found"
          ? NO_WALLET_FOR_PASSKEY
          : status === "archived"
            ? WALLET_ARCHIVED
            : status === "present"
              ? WALLET_EXISTS_UNREAD
              : status === "unknown"
                ? WALLET_STATUS_UNKNOWN
                : failureText(e);
      setState({
        kind: "error",
        message,
        checkFirst: !proven && creationUnconfirmedFor(account.id),
        // Not where a wallet is proven to exist: no second wallet is offered there.
        ...(proven ? {} : recordOf(account.id)),
      });
    }
  }

  async function disconnect() {
    try {
      const kit = await getKit();
      await kit.disconnect();
      setState({ kind: "idle", knownWallet: true, ...(account ? recordOf(account.id) : {}) });
    } catch (e) {
      console.error("could not disconnect the wallet:", e instanceof Error ? e.message : String(e));
      setState({ kind: "error", message: "Caracal could not disconnect this wallet. Reload the page and try again." });
    }
  }

  // Wallets an earlier attempt may have made (not found, which proves nothing), except the one open now.
  const earlier = account ? possibleWalletsFor(account.id).filter((w) => !(state.kind === "connected" && state.contractId === w)) : [];

  return (
    <main className="page">
      <h1 className="h1">Your Caracal wallet</h1>
      {account && (
        <p className="small muted -mt-2">
          Signed in as <strong>{account.email ?? "your Google account"}</strong>.{" "}
          <button className="link" onClick={signOut}>
            Sign out
          </button>
        </p>
      )}
      {!account && state.kind === "error" && (
        // Sign-in could not be checked; a session may still be stored here, so
        // signing out stays possible (it works without reaching Supabase).
        // What failed is shown too, including a Sign out that did not finish.
        <div className="flex flex-col gap-3">
          <p className="msg msg-bad">{state.message}</p>
          <p className="small">
            <button className="link" onClick={signOut}>
              Sign out of this browser
            </button>
          </p>
        </div>
      )}
      <p className="notice">
        Your wallet is a smart contract on Stellar testnet, controlled by a passkey on this device.
        There is no seed phrase. Caracal pays the network fee and can never move your money.
      </p>

      {state.kind === "busy" && <p className="msg msg-info">{state.label}...</p>}
      {account && earlier.length > 0 && <p className="msg msg-unsure">{possiblyMade(earlier)}</p>}

      {account && (state.kind === "idle" || state.kind === "error") && (
        <div className="card">
          <label className="field">
            Your name, as the passkey prompt shows it (a short name: longer ones are cut)
            <input
              className="input"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada"
            />
          </label>
          {createOffered(state) && (
            // Hidden while a wallet may already exist: a second try would make another.
            <button className="btn btn-primary btn-block" onClick={() => create()}>
              Create wallet with a passkey
            </button>
          )}
          <button className="btn btn-secondary btn-block" onClick={connect}>
            I already have a wallet
          </button>
          {state.kind === "error" && <p className="msg msg-bad">{state.message}</p>}
          {state.remembered && !state.checkFirst && !createOffered(state) && (
            // This account connected a wallet on this browser before: connect
            // that one first; a new wallet only as an explicit choice.
            <div className="msg msg-info flex flex-col gap-2">
              <p>
                This browser was last connected to your wallet <span className="addr">{state.remembered}</span>. Use &quot;I
                already have a wallet&quot; to open it with your passkey.
              </p>
              <button className="link self-start text-left" onClick={() => create({ secondTo: state.remembered })}>
                Make a second, new wallet instead (your first wallet stays as it is)
              </button>
            </div>
          )}
          {state.storageUnread && !state.checkFirst && !createOffered(state) && (
            <div className="flex flex-col gap-2">
              <p className="msg msg-unsure">{KNOWN_WALLETS_UNREAD}</p>
              <button className="link self-start text-left" onClick={() => create()}>
                Make a new wallet anyway (if this account already has one, this makes a second)
              </button>
            </div>
          )}
          {(state.kind === "error" || state.kind === "idle") && state.checkFirst && !(state.kind === "error" && state.message.includes("check with Connect")) && (
            <p className="msg msg-unsure">{WALLET_MAYBE_EXISTS}</p>
          )}
          {(state.kind === "error" || state.kind === "idle") && state.checkFirst && !(state.kind === "error" && state.notFound) && (
            // The way out when "I already have a wallet" found nothing: the
            // person says so, and only once the last attempt cannot still finish.
            <button className="link small self-start text-left" onClick={createAnyway}>
              No wallet found? Start a new one anyway
            </button>
          )}
          {state.kind === "error" && state.notFound && (
            // The earlier attempt's wallet was not found, which does not prove
            // it was not made: a new wallet only as a choice made knowing that.
            <button
              className="link small self-start text-left"
              onClick={() => create({ anyway: true, secondTo: state.remembered, despiteNotFound: state.notFound })}
            >
              Make a new wallet anyway (if the earlier one exists, you will have two)
            </button>
          )}
        </div>
      )}

      {state.kind === "connected" && (
        <div className="card">
          <div className="eyebrow">
          <p>Wallet address:</p>
          </div>
          <a className="addr addr-box block underline underline-offset-4" href={explorerLink("contract", state.contractId)}>
            {state.contractId}
          </a>
          {state.txHash && (
            <a className="link small self-start" href={explorerLink("tx", state.txHash)}>
              Deployment transaction (fee paid by the sponsor)
            </a>
          )}
          <button className="btn btn-secondary btn-block" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
    </main>
  );
}
