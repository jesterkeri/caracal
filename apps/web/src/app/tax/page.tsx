"use client";

import { useEffect, useState } from "react";
import { readSignInState } from "@/lib/auth/account";
import { browserStore, rememberedWallet } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import type { TaxOutcome } from "@/lib/tax/pipeline";
import { ResultView } from "./result-view";

type Who = { kind: "checking" } | { kind: "error"; message: string } | { kind: "no-wallet" } | { kind: "ready"; wallet: string };
type Run = { kind: "idle" } | { kind: "running" } | { kind: "failed"; message: string } | { kind: "done"; outcome: TaxOutcome };

const FAILED = "Caracal could not get an estimate. No number was produced. Check your connection and try again.";

export default function TaxPage() {
  const [who, setWho] = useState<Who>({ kind: "checking" });
  const [scope, setScope] = useState<"all" | "elsewhere" | null>(null);
  const [elsewhere, setElsewhere] = useState("");
  const [rent, setRent] = useState("");
  const [run, setRun] = useState<Run>({ kind: "idle" });

  useEffect(() => {
    let gone = false;
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const now = await readSignInState(supabaseBrowser().auth);
      if (now.kind === "signed-out") return window.location.replace("/signin");
      if (now.kind === "unverified") throw new Error("the sign-in could not be verified");
      if (gone) return;
      const wallet = rememberedWallet(browserStore, now.id);
      setWho(wallet ? { kind: "ready", wallet } : { kind: "no-wallet" });
    })().catch((e: unknown) => {
      console.error("could not check the sign-in:", e instanceof Error ? e.message : String(e));
      if (!gone) setWho({ kind: "error", message: "Caracal could not verify your sign-in. Check your connection and reload the page." });
    });
    return () => {
      gone = true;
    };
  }, []);

  async function estimate() {
    if (who.kind !== "ready" || scope === null) return;
    setRun({ kind: "running" });
    try {
      const res = await fetch("/tax/estimate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: who.wallet,
          annualRentNgn: rent,
          otherIncome: scope === "all" ? { kind: "all-in-caracal" } : { kind: "elsewhere", amountNgn: elsewhere },
        }),
      });
      const body = (await res.json()) as TaxOutcome | { error: string };
      if ("error" in body) return setRun({ kind: "failed", message: body.error });
      if (!res.ok || typeof body.status !== "string") return setRun({ kind: "failed", message: FAILED });
      setRun({ kind: "done", outcome: body });
    } catch {
      setRun({ kind: "failed", message: FAILED });
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">Your naira tax estimate</h1>
      <p className="text-sm opacity-80">
        Caracal reads the payments into your split contract, values each in naira at the Central Bank of Nigeria official rate for the day it arrived, and estimates your 2026
        personal income tax. It refuses when it cannot prove it has all your payments for the year. Estimate, not tax advice.
      </p>

      {who.kind === "checking" && <p className="text-sm">Checking your sign-in...</p>}
      {who.kind === "error" && <p className="text-sm text-red-600">{who.message}</p>}
      {who.kind === "no-wallet" && (
        <p className="text-sm">
          Caracal does not know your wallet on this browser yet. Open <a className="underline" href="/wallet">your wallet page</a>, connect your wallet, then come back.
        </p>
      )}

      {who.kind === "ready" && (
        <div className="flex flex-col gap-4 text-sm">
          <p>
            Wallet: <span className="break-all font-mono">{who.wallet}</span>
          </p>
          <fieldset className="flex flex-col gap-2">
            <legend className="font-semibold">Does all your income for the year arrive in this wallet?</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="scope" checked={scope === "all"} onChange={() => setScope("all")} />
              Yes, all of it arrives through my Caracal split contract.
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="scope" checked={scope === "elsewhere"} onChange={() => setScope("elsewhere")} />
              No, some income arrives somewhere else.
            </label>
          </fieldset>
          {scope === "elsewhere" && (
            <label className="flex flex-col gap-1">
              Income that arrives elsewhere this year, in naira (it is added as you say it, and not checked on chain)
              <input className="rounded-md border px-3 py-2 text-base" inputMode="decimal" value={elsewhere} onChange={(e) => setElsewhere(e.target.value)} placeholder="2500000" />
            </label>
          )}
          <label className="flex flex-col gap-1">
            Rent you pay for the year, in naira (optional, for the rent relief)
            <input className="rounded-md border px-3 py-2 text-base" inputMode="decimal" value={rent} onChange={(e) => setRent(e.target.value)} placeholder="600000" />
          </label>
          <button className="rounded-md bg-black px-4 py-3 text-white disabled:opacity-50" disabled={scope === null || run.kind === "running"} onClick={estimate}>
            {run.kind === "running" ? "Working it out..." : "Estimate my 2026 tax"}
          </button>
          {scope === null && <p className="opacity-80">Answer the income question first: Caracal cannot see income that arrives elsewhere unless you say so.</p>}
        </div>
      )}

      {run.kind === "failed" && <p className="text-sm text-red-600">{run.message}</p>}
      {run.kind === "done" && <ResultView outcome={run.outcome} />}
    </main>
  );
}
