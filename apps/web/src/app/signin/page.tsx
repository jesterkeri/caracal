"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function SignIn() {
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setError(p.get("error"));
    supabaseBrowser()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function google() {
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    });
    if (error) {
      setError(error.message);
      setBusy(false);
    }
  }

  async function signOut() {
    await supabaseBrowser().auth.signOut();
    setEmail(null);
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
          disabled={busy}
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
