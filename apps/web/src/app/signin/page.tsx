"use client";

import { useEffect, useState } from "react";
import { SIGNIN_ERRORS, signinErrorMessage } from "@/lib/auth/signin-errors";
import { SIGN_OUT_FAILED, browserStore, endSupabaseSession, signOutEverywhere } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { getKit } from "@/lib/stellar/kit";

export default function SignIn() {
  const configured = supabaseEnvOrNull() !== null;
  const [error, setError] = useState<string | null>(configured ? null : SIGNIN_ERRORS.config);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    // Only fixed messages are shown; the URL carries a code, never wording.
    const code = new URLSearchParams(window.location.search).get("error");
    supabaseBrowser()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null))
      .catch((e: unknown) => console.error("could not read the session:", e instanceof Error ? e.message : String(e)))
      .finally(() => setError(signinErrorMessage(code)));
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
    try {
      await signOutEverywhere(browserStore, getKit(), () => endSupabaseSession(supabaseBrowser().auth));
      setEmail(null);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      setError(SIGN_OUT_FAILED);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4">
      <h1 className="text-2xl font-semibold">Sign in to Caracal</h1>
      <p className="text-zinc-600 dark:text-zinc-400">
        Google identifies your account in the app. It cannot sign transactions or move money: only your passkey can.
      </p>
      {email ? (
        <div className="flex flex-col gap-3">
          <p>
            Signed in as <strong>{email}</strong>.
          </p>
          <a className="rounded-lg bg-black px-4 py-3 text-center text-white dark:bg-white dark:text-black" href="/wallet">
            Go to your wallet
          </a>
          <button className="text-sm underline" onClick={signOut}>
            Sign out
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
