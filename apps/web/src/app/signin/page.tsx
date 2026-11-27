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
// Counts sign-outs that succeeded here. A sign-in check that began before one
// is out of date when it ends, and does not overwrite the signed-out state.
// A sign-out that failed leaves the session as it was, so the check's result
// still applies.
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
    let failure: string | null = null;
    try {
      const { error } = await supabaseBrowser().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) failure = error.message;
    } catch (e) {
      // A throw (storage blocked for the sign-in verifier, say) must not leave
      // the button on "Opening Google..." with nothing shown.
      failure = e instanceof Error ? e.message : String(e);
    }
    if (failure !== null) {
      console.error("sign-in could not start:", failure);
      setError(SIGNIN_ERRORS.failed);
      setBusy(false);
    }
  }

  async function signOut() {
    // Also disconnects the passkey wallet, so the next person to sign in on
    // this browser never sees this account's wallet.
    signingOutHere = true;
    try {
      await signOutEverywhere(browserStore, getKit(), () => endSupabaseSession(supabaseBrowser().auth));
      signOutsHere += 1;
      setSignIn({ kind: "signed-out" });
      setError(null); // an earlier "still signed in" is no longer true
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      setError(SIGN_OUT_FAILED);
    } finally {
      signingOutHere = false;
    }
  }

  return (
    <main className="signin">
      <section className="card-hero signin-hero">
        <div className="signin-brand">
          <svg className="signin-logo" viewBox="0 0 32 32" aria-hidden="true"><path fill="var(--c-brown)" d="M7.2 15.4 9.6 3.6l5 7.1h2.8l5-7.1 2.4 11.8c1.1 1.4 1.7 3.1 1.7 4.9 0 4.9-4.6 8.2-10.5 8.2S5.5 25.2 5.5 20.3c0-1.8.6-3.5 1.7-4.9z" /><path fill="none" stroke="var(--c-text)" strokeWidth="1.6" strokeLinecap="round" d="M9.6 3.6 8.6 1M22.4 3.6l1-2.6" /><path fill="var(--c-page)" d="M10.6 18.2c1.3-1 2.9-1.2 4.1-.5-.9 1.2-2.6 1.6-4.1.5zM21.4 18.2c-1.3-1-2.9-1.2-4.1-.5.9 1.2 2.6 1.6 4.1.5zM14.8 23.2h2.4L16 24.6z" /></svg>
          Caracal
          <span className="badge-testnet">Stellar testnet</span>
        </div>
        <div className="signin-pitch">
            <p className="signin-kicker">For freelancers paid in USDC</p>
            <p className="signin-title">Get paid in dollars. Have it sorted the moment it lands.</p>
            <ul className="signin-points">
            <li><span className="signin-tick"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Send invoices your clients pay in USDC</li>
            <li><span className="signin-tick"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Every payment splits into Tax, Goal and Spend</li>
            <li><span className="signin-tick"><svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Only your passkey can move your money</li>
          </ul>
        </div>
      </section>
      <section className="signin-panel">
        <div className="signin-host">
            {/* the caracal peeks over the card: head behind it, paws in front on its edge (as in the design) */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="signin-cat-head" src="/caracal-head.svg" alt="" width={112} height={94} />
            <div className="card signin-card">
              <div className="flex flex-col gap-2">
                <h1 className="h1">Sign in to Caracal</h1>
                <p className="lead">
                  Google identifies your account in the app. It cannot sign transactions or move money: only your passkey can.
                </p>
              </div>
      {signIn?.kind === "verified" ? (
        <div className="flex flex-col gap-3">
          <div className="card-sunken">
          <p>
            Signed in as <strong>{signIn.email ?? "your Google account"}</strong>.
          </p>
          </div>
          <a className="btn btn-primary btn-block" href="/wallet">
            Go to your wallet
          </a>
          <button className="link small self-center" onClick={signOut}>
            Sign out
          </button>
        </div>
      ) : signIn?.kind === "unverified" ? (
        // Not shown as signed in, and no way into the wallet: the session could
        // not be confirmed. Signing out works without reaching Supabase.
        <div className="flex flex-col gap-3">
          <div className="msg msg-unsure">
          <p>Caracal could not verify your sign-in. Check your connection and reload the page, or sign out and sign in again.</p>
          </div>
          <button className="link small self-start" onClick={signOut}>
            Sign out of this browser
          </button>
        </div>
      ) : configured && signIn === null ? (
        // Checking can take up to the 10 s request deadline. A session may be
        // stored here, so Sign out is offered meanwhile, and Google is not:
        // starting a second sign-in over an unknown one helps no one.
        <div className="flex flex-col gap-3">
          <p className="msg msg-info">Checking your sign-in...</p>
          <button className="link small self-start" onClick={signOut}>
            Sign out of this browser
          </button>
        </div>
      ) : (
        <button
          className="btn btn-primary btn-block btn-google"
          onClick={google}
          disabled={busy || !configured}
        >
          <span className="g-badge"><svg className="h-5 w-5 shrink-0" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.5z"/></svg></span>
          {busy ? "Opening Google..." : "Continue with Google"}
        </button>
      )}
      {error && (
        <p role="alert" className="msg msg-bad">
          {error}
        </p>
      )}
              <p className="signin-fine">Caracal never holds your money or your keys.</p>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="signin-cat-paws" src="/caracal-paws.svg" alt="" width={112} height={19} />
        </div>
      </section>
    </main>
  );
}
