"use client";

import { useEffect, useState } from "react";
import { bindWallet, mayRestoreWallet, signOutEverywhere } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { getKit } from "@/lib/stellar/kit";
import { explorerLink } from "@/lib/stellar/config";

type Account = { id: string; email: string | null };

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
    })().catch(() => setState({ kind: "idle" }));
  }, []);

  function connected(contractId: string, txHash?: string) {
    if (account) bindWallet(window.localStorage, account.id);
    setState({ kind: "connected", contractId, txHash });
  }

  async function signOut() {
    await signOutEverywhere(window.localStorage, await getKit(), () => supabaseBrowser().auth.signOut());
    window.location.replace("/signin");
  }

  async function create() {
    setState({ kind: "busy", label: "Creating your passkey and wallet" });
    try {
      const kit = await getKit();
      const r = await kit.createWallet("Caracal", name.trim() || "Caracal user", { autoSubmit: true });
      if (r.submitResult && !r.submitResult.success) {
        setState({ kind: "error", message: r.submitResult.error.message });
        return;
      }
      connected(r.contractId, r.submitResult?.success ? r.submitResult.hash : undefined);
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function connect() {
    setState({ kind: "busy", label: "Waiting for your passkey" });
    try {
      const kit = await getKit();
      const r = await kit.connectWallet({ prompt: true });
      if (r) connected(r.contractId);
      else setState({ kind: "idle" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  async function disconnect() {
    const kit = await getKit();
    await kit.disconnect();
    setState({ kind: "idle" });
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

      {(state.kind === "idle" || state.kind === "error") && (
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
