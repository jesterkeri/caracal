"use client";

import { useEffect, useState } from "react";
import { bindIfStillSignedIn, followAccount, readSignInState } from "@/lib/auth/account";
import { SIGN_OUT_FAILED, WALLET_OWNER_KEY, browserStore, endSupabaseSession, mayRestoreWallet, signOutEverywhere } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { passkeyName } from "@/lib/stellar/passkey-name";
import { CREATION_SETTLE_MS, creationMarker } from "@/lib/auth/creation-marker";
import { explorerLink } from "@/lib/stellar/config";

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

const { creationUnconfirmedFor, creationAge, markCreation } = creationMarker(browserStore);

/** How smart-account-kit 0.10.0 begins its error for a passkey whose contract lookup failed (missing, or unreachable). */
const KIT_NOT_FOUND = "Smart account contract not found on-chain";
const NO_WALLET_FOR_PASSKEY =
  "No wallet was found on Stellar testnet for this passkey. If it was created a moment ago, wait a minute and try again, or choose another passkey.";
const CONNECT_UNREACHABLE = "Caracal could not reach the Stellar network to look up your wallet. Check your connection and try again.";

/** Whether the kit's Stellar RPC answers now (within 10 s). */
async function networkAnswers(kit: { rpc?: { getLatestLedger(): Promise<unknown> } } | undefined): Promise<boolean> {
  if (!kit?.rpc) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      kit.rpc.getLatestLedger(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), 10_000);
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const WALLET_RECORDED_ELSEWHERE =
  "This account already has a wallet on this browser, created or connected in another tab. Reload the page to open it.";

const CREATION_TOO_RECENT =
  "The last attempt started less than 3 minutes ago and may still finish. Wait a few minutes, then check with \"I already have a wallet\" first.";

const CREATION_IN_PROGRESS =
  "A wallet creation for this account is already under way in another tab, or an earlier one could not be confirmed.";

/** Shown under a failure after which a wallet may already exist, unless the failure already says it. */
const WALLET_MAYBE_EXISTS =
  "Your wallet may already exist. Before creating another, reload the page and check with \"I already have a wallet\", using your passkey.";

type State =
  // knownWallet: this account has, or may have, a wallet already (one was
  // restored and then disconnected, or one is recorded as its own here).
  | { kind: "idle"; knownWallet?: boolean; checkFirst?: boolean }
  | { kind: "busy"; label: string }
  | { kind: "connected"; contractId: string; txHash?: string }
  // Create is offered after an error only with createAllowed: when the page
  // knows that no wallet was made (the passkey step failed, or the relay said
  // nothing was sent) and none was known before. Otherwise only Connect is
  // offered: a second try could make a second passkey and an orphan wallet.
  // checkFirst: a creation whose outcome is unknown; the page says to check
  // with Connect before creating another.
  | { kind: "error"; message: string; createAllowed?: boolean; checkFirst?: boolean };

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
      if (stale()) return;
      const mayRestore = await mayRestoreWallet(browserStore, kit, me.id);
      if (stale()) return;
      if (!mayRestore) {
        // An earlier creation by this account whose outcome is unknown: only Connect.
        return setState(creationUnconfirmedFor(me.id) ? { kind: "idle", knownWallet: true, checkFirst: true } : { kind: "idle" });
      }
      const r = await restoreWithin(kit.connectWallet(), "restoring the saved wallet");
      if (stale()) return;
      setState(r ? { kind: "connected", contractId: r.contractId } : { kind: "idle", knownWallet: true });
    })().catch((e: unknown) => {
      console.error("could not check the sign-in or saved wallet:", e instanceof Error ? e.message : String(e));
      if (stale()) return;
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

  async function connected(contractId: string, txHash?: string) {
    if (!account) return;
    // The account may have changed since the page loaded (another tab), so it
    // is confirmed again before this wallet is recorded as its.
    const bound = await bindIfStillSignedIn(browserStore, supabaseBrowser().auth, getKit(), account.id);
    if (bound === "account-changed") return accountChanged();
    // Recorded as this account's: a reload restores it, so the note goes.
    // "not-saved" keeps it: nothing on this browser would remember the wallet.
    if (bound === "bound") markCreation(account.id, false);
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

  async function create() {
    if (!account) return; // a wallet is always bound to its signed-in owner
    // Another tab of this browser may be creating this account's wallet right
    // now, or an earlier attempt's outcome is unknown: do not start a second.
    if (creationUnconfirmedFor(account.id)) {
      setState({ kind: "error", message: CREATION_IN_PROGRESS, checkFirst: true });
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
    if (recordedOwner === account.id) {
      setState({ kind: "error", message: WALLET_RECORDED_ELSEWHERE });
      return;
    }
    setState({ kind: "busy", label: "Creating your passkey and wallet" });
    let kit: Awaited<ReturnType<typeof getKit>>;
    try {
      kit = await getKit();
    } catch (e) {
      // Nothing was made or sent; what was known before still holds.
      setState({ kind: "error", message: failureText(e), createAllowed: true });
      return;
    }
    // The kit announces credentialCreated once the passkey exists, before the
    // wallet is built or sent. A failure before it sent nothing, whatever its
    // error; one after it may follow a deploy (the kit saves its session after
    // submitting). Without the event API nothing can be told apart, so every
    // failure counts as after.
    let passkeyMade = typeof kit.events?.on !== "function";
    const stop = kit.events?.on?.("credentialCreated", () => {
      passkeyMade = true;
      // The wait before "Start a new one anyway" counts from here, not from
      // before the passkey prompt (which can take a minute).
      markCreation(account.id, true);
    });
    let r: Awaited<ReturnType<typeof kit.createWallet>>;
    markCreation(account.id, true);
    try {
      r = await kit.createWallet("Caracal", passkeyName(name), { autoSubmit: true });
    } catch (e) {
      const message = failureText(e);
      if (!passkeyMade) markCreation(account.id, false);
      setState(passkeyMade ? { kind: "error", message, checkFirst: true } : { kind: "error", message, createAllowed: true });
      return;
    } finally {
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
        markCreation(account.id, false);
        return setState({ kind: "error", message: detail, createAllowed: true });
      }
      setState({ kind: "error", message: detail, checkFirst: true });
      return;
    }
    try {
      await connected(r.contractId, r.submitResult?.success ? r.submitResult.hash : undefined);
    } catch (e) {
      // The wallet was made; only recording its owner failed.
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e), checkFirst: true });
    }
  }

  /** After an unknown outcome, the person checked with Connect and found no wallet. */
  async function createAnyway() {
    if (!account) return;
    if (creationAge() < CREATION_SETTLE_MS) {
      setState({ kind: "error", message: CREATION_TOO_RECENT, checkFirst: true });
      return;
    }
    markCreation(account.id, false);
    await create();
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
      else setState({ kind: "idle", knownWallet: !couldCreate, checkFirst: unconfirmed });
    } catch (e) {
      // Not createAllowed: the kit's checks that fail after it found a contract
      // at this passkey's address (provenance, ownership, wallet code) prove a
      // wallet exists. Reloading offers Create again when none is recorded.
      // Only those keep the way out hidden: any other failure (no contract at
      // this passkey's address, a closed prompt) leaves it for an unconfirmed
      // creation.
      const proven = e instanceof Error && WALLET_PROVEN_ERRORS.has(e.name);
      // The kit says "not found on-chain" for any failed lookup, a network
      // failure included, so the page asks the network itself before saying
      // anything about the wallet.
      const notFound = e instanceof Error && e.message.startsWith(KIT_NOT_FOUND);
      const message = notFound ? ((await networkAnswers(kit)) ? NO_WALLET_FOR_PASSKEY : CONNECT_UNREACHABLE) : failureText(e);
      setState({ kind: "error", message, checkFirst: !proven && creationUnconfirmedFor(account.id) });
    }
  }

  async function disconnect() {
    try {
      const kit = await getKit();
      await kit.disconnect();
      setState({ kind: "idle", knownWallet: true });
    } catch (e) {
      console.error("could not disconnect the wallet:", e instanceof Error ? e.message : String(e));
      setState({ kind: "error", message: "Caracal could not disconnect this wallet. Reload the page and try again." });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Your Caracal wallet</h1>
      {account && (
        <p className="text-sm">
          Signed in as <strong>{account.email ?? "your Google account"}</strong>.{" "}
          <button className="underline" onClick={signOut}>
            Sign out
          </button>
        </p>
      )}
      {!account && state.kind === "error" && (
        // Sign-in could not be checked; a session may still be stored here, so
        // signing out stays possible (it works without reaching Supabase).
        // What failed is shown too, including a Sign out that did not finish.
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-red-600">{state.message}</p>
          <p>
            <button className="underline" onClick={signOut}>
              Sign out of this browser
            </button>
          </p>
        </div>
      )}
      <p className="text-sm opacity-80">
        Your wallet is a smart contract on Stellar testnet, controlled by a passkey on this device.
        There is no seed phrase. Caracal pays the network fee and can never move your money.
      </p>

      {state.kind === "busy" && <p className="text-sm">{state.label}...</p>}

      {account && (state.kind === "idle" || state.kind === "error") && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Your name, as the passkey prompt shows it (a short name: longer ones are cut)
            <input
              className="rounded-md border px-3 py-2 text-base"
              maxLength={24}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada"
            />
          </label>
          {createOffered(state) && (
            // Hidden while a wallet may already exist: a second try would make another.
            <button className="rounded-md bg-black px-4 py-3 text-white" onClick={create}>
              Create wallet with a passkey
            </button>
          )}
          <button className="rounded-md border px-4 py-3" onClick={connect}>
            I already have a wallet
          </button>
          {state.kind === "error" && <p className="text-sm text-red-600">{state.message}</p>}
          {(state.kind === "error" || state.kind === "idle") && state.checkFirst && !(state.kind === "error" && state.message.includes("check with Connect")) && (
            <p className="text-sm">{WALLET_MAYBE_EXISTS}</p>
          )}
          {(state.kind === "error" || state.kind === "idle") && state.checkFirst && (
            // The way out when "I already have a wallet" found nothing: the
            // person says so, and only once the last attempt cannot still finish.
            <button className="text-sm underline" onClick={createAnyway}>
              No wallet found? Start a new one anyway
            </button>
          )}
        </div>
      )}

      {state.kind === "connected" && (
        <div className="flex flex-col gap-3 text-sm">
          <p>Wallet address:</p>
          <a className="break-all font-mono underline" href={explorerLink("contract", state.contractId)}>
            {state.contractId}
          </a>
          {state.txHash && (
            <a className="underline" href={explorerLink("tx", state.txHash)}>
              Deployment transaction (fee paid by the sponsor)
            </a>
          )}
          <button className="rounded-md border px-4 py-3" onClick={disconnect}>
            Disconnect
          </button>
        </div>
      )}
    </main>
  );
}
