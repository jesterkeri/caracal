"use client";

import { useEffect, useState } from "react";
import { followAccount, readSignInState, type SignInState } from "@/lib/auth/account";
import { SIGNIN_ERRORS, signinErrorMessage } from "@/lib/auth/signin-errors";
import { SIGN_OUT_FAILED, browserStore, endSupabaseSession, signOutEverywhere } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { getKit } from "@/lib/stellar/kit";

// True while this tab signs out, so its own sign-out event does not reload the
// page before the wallet disconnect has finished.
let signingOutHere = false;
// Counts sign-outs started here. A sign-in check that began before one is out
// of date when it ends, and does not overwrite the signed-out state.
let signOutsHere = 0;

export default function SignIn() {
  const configured = supabaseEnvOrNull() !== null;
  const [error, setError] = useState<string | null>(configured ? null : SIGNIN_ERRORS.config);
  const [signIn, setSignIn] = useState<SignInState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    // Only fixed messages are shown; the URL carries a code, never wording.
    const code = new URLSearchParams(window.location.search).get("error");
    const auth = supabaseBrowser().auth;
    let unfollow: (() => void) | undefined;
    let gone = false;
    const signOutsAtStart = signOutsHere;
    // Only a session Supabase confirmed is shown as signed in. One that is
    // stored here but could not be confirmed keeps its Sign out control.
    readSignInState(auth)
      .then((now) => {
        if (gone) return;
        // An error already shown (a sign-out that failed meanwhile) is kept.
        setError((shown) => shown ?? signinErrorMessage(code));
        if (signOutsHere !== signOutsAtStart) return;
        setSignIn(now);
        // A sign-in or sign-out in another tab: show the page for the new state.
        if (now.kind !== "unverified") {
          unfollow = followAccount(auth, now.kind === "verified" ? now.id : null, () => window.location.reload(), () => signingOutHere);
        }
      });
    return () => {
      gone = true;
      unfollow?.();
    };
  }, [configured]);

  async function google() {
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      console.error("sign-in could not start:", error.message);
      setError(SIGNIN_ERRORS.failed);
      setBusy(false);
    }
  }

  async function signOut() {
    // Also disconnects the passkey wallet, so the next person to sign in on
    // this browser never sees this account's wallet.
    signingOutHere = true;
    signOutsHere += 1;
    try {
      await signOutEverywhere(browserStore, getKit(), () => endSupabaseSession(supabaseBrowser().auth));
      setSignIn({ kind: "signed-out" });
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      setError(SIGN_OUT_FAILED);
    } finally {
      signingOutHere = false;
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in to Caracal</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Google identifies your account in the app. It cannot sign transactions or move money: only your passkey can.
      </p>
      {signIn?.kind === "verified" ? (
        <div className="flex flex-col gap-3">
          <p>
            Signed in as <strong>{signIn.email ?? "your Google account"}</strong>.
          </p>
          <a className="rounded-lg bg-black px-4 py-3 text-center text-white dark:bg-white dark:text-black" href="/wallet">
            Go to your wallet
          </a>
          <button className="text-sm underline" onClick={signOut}>
            Sign out
          </button>
        </div>
      ) : signIn?.kind === "unverified" ? (
        // Not shown as signed in, and no way into the wallet: the session could
        // not be confirmed. Signing out works without reaching Supabase.
        <div className="flex flex-col gap-3">
          <p>Caracal could not verify your sign-in. Check your connection and reload the page, or sign out and sign in again.</p>
          <button className="text-sm underline" onClick={signOut}>
            Sign out of this browser
          </button>
        </div>
      ) : configured && signIn === null ? (
        // Checking can take up to the 10 s request deadline. A session may be
        // stored here, so Sign out is offered meanwhile, and Google is not:
        // starting a second sign-in over an unknown one helps no one.
        <div className="flex flex-col gap-3">
          <p className="text-sm">Checking your sign-in...</p>
          <button className="text-sm underline" onClick={signOut}>
            Sign out of this browser
          </button>
        </div>
      ) : (
        <button
          className="rounded-lg bg-black px-4 py-3 text-white disabled:opacity-50 dark:bg-white dark:text-black"
          onClick={google}
          disabled={busy || !configured}
        >
          {busy ? "Opening Google..." : "Continue with Google"}
        </button>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
    </main>
  );
}
