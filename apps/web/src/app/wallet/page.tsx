"use client";

import { useEffect, useState } from "react";
import { SIGN_OUT_FAILED, bindWallet, endSupabaseSession, mayRestoreWallet, signOutEverywhere } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { explorerLink } from "@/lib/stellar/config";

type Account = { id: string; email: string | null };

const WALLET_MAYBE_CREATED =
  "Caracal could not confirm whether your wallet was created. Before creating another, reload the page and check with Connect, using your passkey.";

type State =
  | { kind: "idle" }
  | { kind: "busy"; label: string }
  | { kind: "connected"; contractId: string; txHash?: string }
  | { kind: "error"; message: string };

export default function WalletPage() {
  const [state, setState] = useState<State>({ kind: "busy", label: "Checking for a saved wallet" });
  const [name, setName] = useState("");
  const [account, setAccount] = useState<Account | null>(null);

  useEffect(() => {
    // The wallet belongs to a signed-in account. A saved wallet session is
    // restored only for the account that created or connected it.
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const { data } = await supabaseBrowser().auth.getUser();
      if (!data.user) return window.location.replace("/signin");
      const me = { id: data.user.id, email: data.user.email ?? null };
      setAccount(me);
      const kit = await getKit();
      if (!(await mayRestoreWallet(window.localStorage, kit, me.id))) return setState({ kind: "idle" });
      const r = await kit.connectWallet();
      setState(r ? { kind: "connected", contractId: r.contractId } : { kind: "idle" });
    })().catch((e: unknown) => {
      console.error("could not check the sign-in or saved wallet:", e instanceof Error ? e.message : String(e));
      // Without a known account a new wallet could not be bound to its owner,
      // so creating or connecting is offered only after a successful check.
      // A wrong RPC setting is named as such, not mistaken for a sign-in problem.
      const message = e instanceof Error && e.message === HTTPS_RPC_REQUIRED ? HTTPS_RPC_REQUIRED : "Caracal could not check your sign-in. Check your connection and reload the page.";
      setState({ kind: "error", message });
    });
  }, []);

  function connected(contractId: string, txHash?: string) {
    if (!account) return;
    bindWallet(window.localStorage, account.id);
    setState({ kind: "connected", contractId, txHash });
  }

  async function signOut() {
    try {
      await signOutEverywhere(window.localStorage, getKit(), () => endSupabaseSession(supabaseBrowser().auth));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      // The wallet is already disconnected and unbound; only the session survived.
      setState({ kind: "error", message: SIGN_OUT_FAILED });
      return;
    }
    window.location.replace("/signin");
  }

  async function create() {
    if (!account) return; // a wallet is always bound to its signed-in owner
    setState({ kind: "busy", label: "Creating your passkey and wallet" });
    try {
      const kit = await getKit();
      const r = await kit.createWallet("Caracal", name.trim() || "Caracal user", { autoSubmit: true });
      if (r.submitResult && !r.submitResult.success) {
        // With a hash the transaction was sent; the kit only failed to see it
        // confirmed, so the wallet may exist. A second try would make another.
        const sent = "hash" in r.submitResult && typeof r.submitResult.hash === "string" && r.submitResult.hash !== "";
        setState({ kind: "error", message: sent ? WALLET_MAYBE_CREATED : r.submitResult.error.message });
        return;
      }
      connected(r.contractId, r.submitResult?.success ? r.submitResult.hash : undefined);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function connect() {
    if (!account) return; // a wallet is always bound to its signed-in owner
    setState({ kind: "busy", label: "Waiting for your passkey" });
    try {
      const kit = await getKit();
      // fresh: always ask for this person's passkey. { prompt: true } would
      // first reuse a stored session, which could be the previous person's if
      // their disconnect failed, and then bind it to this account.
      const r = await kit.connectWallet({ fresh: true });
      if (r) connected(r.contractId);
      else setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function disconnect() {
    try {
      const kit = await getKit();
      await kit.disconnect();
      setState({ kind: "idle" });
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
      <p className="text-sm opacity-80">
        Your wallet is a smart contract on Stellar testnet, controlled by a passkey on this device.
        There is no seed phrase. Caracal pays the network fee and can never move your money.
      </p>

      {state.kind === "busy" && <p className="text-sm">{state.label}...</p>}

      {account && (state.kind === "idle" || state.kind === "error") && (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Your name (shown in the passkey prompt)
            <input
              className="rounded-md border px-3 py-2 text-base"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada"
            />
          </label>
          <button className="rounded-md bg-black px-4 py-3 text-white" onClick={create}>
            Create wallet with a passkey
          </button>
          <button className="rounded-md border px-4 py-3" onClick={connect}>
            I already have a wallet
          </button>
          {state.kind === "error" && <p className="text-sm text-red-600">{state.message}</p>}
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
