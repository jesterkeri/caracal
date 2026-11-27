"use client";

import { useEffect, useState } from "react";
import { followAccount, readSignInState } from "@/lib/auth/account";
import { browserStore, rememberedWallet } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import type { Classification, PaymentRow, TaxOutcome } from "@/lib/tax/pipeline";
import { ResultView, group } from "./result-view";

type Who = { kind: "checking" } | { kind: "error"; message: string } | { kind: "no-wallet" } | { kind: "ready"; wallet: string };
type Run = { kind: "idle" } | { kind: "running" } | { kind: "failed"; message: string } | { kind: "done"; outcome: TaxOutcome };

const FAILED = "Caracal could not get an estimate. No number was produced. Check your connection and try again.";

/** Longest wait for the estimate. Reading a year of payments and the CBN rates normally takes seconds. */
const ESTIMATE_TIMEOUT_MS = 120_000;
const TOO_SLOW = "Caracal did not get an estimate within 2 minutes, so it stopped waiting. No number was produced. Try again.";

/** Bumped by every edit and every Estimate: an answer for answers that have since changed is dropped. */
let asked = 0;

export default function TaxPage() {
  const [who, setWho] = useState<Who>({ kind: "checking" });
  const [scope, setScope] = useState<"all" | "elsewhere" | null>(null);
  const [elsewhere, setElsewhere] = useState("");
  const [rent, setRent] = useState("");
  const [run, setRun] = useState<Run>({ kind: "idle" });
  // The in-year payments the server listed, and the person's answer for each (nothing is preselected).
  const [listed, setListed] = useState<PaymentRow[] | null>(null);
  const [answers, setAnswers] = useState<Record<string, Classification>>({});

  useEffect(() => {
    let gone = false;
    let unfollow = () => {};
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const now = await readSignInState(auth);
      if (now.kind === "signed-out") return window.location.replace("/signin");
      if (now.kind === "unverified") throw new Error("the sign-in could not be verified");
      if (gone) return;
      // Another tab signing out, or signing in as someone else, ends this page's account: nothing of this
      // account stays on screen (no wallet, no estimate, no answer still on its way) and the page loads again.
      unfollow = followAccount(auth, now.id, () => {
        asked++;
        setRun({ kind: "idle" });
        setListed(null);
        setAnswers({});
        setWho({ kind: "checking" });
        window.location.reload();
      });
      const wallet = rememberedWallet(browserStore, now.id);
      setWho(wallet ? { kind: "ready", wallet } : { kind: "no-wallet" });
    })().catch((e: unknown) => {
      console.error("could not check the sign-in:", e instanceof Error ? e.message : String(e));
      if (!gone) setWho({ kind: "error", message: "Caracal could not verify your sign-in. Check your connection and reload the page." });
    });
    return () => {
      gone = true;
      unfollow();
    };
  }, []);

  /** A changed answer makes any result (or one still being worked out) stale: it is cleared, not left beside the new answers. */
  function edited() {
    asked++;
    setRun({ kind: "idle" });
  }

  async function estimate() {
    if (who.kind !== "ready" || scope === null) return;
    const mine = ++asked;
    const current = () => mine === asked;
    setRun({ kind: "running" });
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ESTIMATE_TIMEOUT_MS);
    try {
      const res = await fetch("/tax/estimate", {
        method: "POST",
        signal: stop.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          wallet: who.wallet,
          annualRentNgn: rent,
          otherIncome: scope === "all" ? { kind: "all-in-caracal" } : { kind: "elsewhere", amountNgn: elsewhere },
          // Only answers for payments on the list on screen are sent.
          classifications: Object.fromEntries(Object.entries(answers).filter(([id]) => listed?.some((p) => p.id === id))),
        }),
      });
      const body = (await res.json()) as TaxOutcome | { error: string };
      if (!current()) return;
      if ("error" in body) return setRun({ kind: "failed", message: body.error });
      if (!res.ok || typeof body.status !== "string") return setRun({ kind: "failed", message: FAILED });
      if (body.status === "refused" && body.payments !== undefined) {
        // The server's list replaces ours: an answer for a payment no longer on it is dropped.
        const ids = new Set(body.payments.map((p) => p.id));
        setListed(body.payments);
        setAnswers((a) => Object.fromEntries(Object.entries(a).filter(([id]) => ids.has(id))));
      }
      setRun({ kind: "done", outcome: body });
    } catch {
      if (current()) setRun({ kind: "failed", message: stop.signal.aborted ? TOO_SLOW : FAILED });
    } finally {
      clearTimeout(timer);
    }
  }

  return (
    <main className="page">
      <h1 className="h1">Your naira tax estimate</h1>
      <p className="lead">
        Caracal reads the payments into your split contract, values each in naira at the Central Bank of Nigeria official rate for the day it arrived, and estimates your 2026
        personal income tax. It refuses when it cannot prove it has all your payments for the year. Estimate, not tax advice.
      </p>

      {who.kind === "checking" && <p className="small muted">Checking your sign-in...</p>}
      {who.kind === "error" && <p className="msg msg-bad">{who.message}</p>}
      {who.kind === "no-wallet" && (
        <p className="msg msg-info">
          Caracal does not know your wallet on this browser yet. Open <a className="link" href="/wallet">your wallet page</a>, connect your wallet, then come back.
        </p>
      )}

      {who.kind === "ready" && (
        <div className="flex flex-col gap-5">
          <p className="flex flex-col gap-1.5 text-sm font-medium">
            Wallet: <span className="addr addr-box font-normal">{who.wallet}</span>
          </p>
          <div className="card gap-5 text-sm">
          <fieldset className="flex flex-col gap-2">
            <legend className="h3 mb-3">Does all your income for the year arrive in this wallet?</legend>
            <label className="choice py-3 has-checked:bg-[var(--c-green-soft)] has-checked:text-[var(--c-on-green-soft)]">
              <input type="radio" name="scope" checked={scope === "all"} onChange={() => (setScope("all"), edited())} />
              Yes, all of it arrives through my Caracal split contract.
            </label>
            <label className="choice py-3 has-checked:bg-[var(--c-green-soft)] has-checked:text-[var(--c-on-green-soft)]">
              <input type="radio" name="scope" checked={scope === "elsewhere"} onChange={() => (setScope("elsewhere"), edited())} />
              No, some income arrives somewhere else.
            </label>
          </fieldset>
          {scope === "elsewhere" && (
            <label className="field">
              Income that arrives elsewhere this year, in naira (it is added as you say it, and not checked on chain)
              <input className="input" inputMode="decimal" value={elsewhere} onChange={(e) => (setElsewhere(e.target.value), edited())} placeholder="2500000" />
            </label>
          )}
          <label className="field">
            Rent you pay for the year, in naira (optional, for the rent relief)
            <input className="input" inputMode="decimal" value={rent} onChange={(e) => (setRent(e.target.value), edited())} placeholder="600000" />
          </label>
          <button className="btn btn-primary btn-block" disabled={scope === null || run.kind === "running"} onClick={estimate}>
            {run.kind === "running" ? "Working it out..." : "Estimate my 2026 tax"}
          </button>
          {scope === null && <p className="small muted">Answer the income question first: Caracal cannot see income that arrives elsewhere unless you say so.</p>}
          </div>
          {listed !== null && (
            <fieldset className="card gap-4 text-sm">
              <legend className="h3 mb-3">Was each payment income?</legend>
              <p className="muted">
                A payment on chain shows an amount and who sent it, not what it was for. Say whether each one is income for you. A transfer from another wallet of yours, or a
                refund, is not income. Caracal makes no estimate until every payment has an answer, and payments you mark as not income are left out by your own answer and are not checked on chain.
              </p>
              {listed.length === 0 && <p>There are no payments in 2026 to answer for.</p>}
              {listed.map((p) => (
                <div key={p.id} className="item kv gap-1 py-2">
                  <p className="kv-row num text-base">
                    {p.date}: <strong>{group(p.amount)} {p.asset}</strong>
                  </p>
                  <p className="kv-row muted text-sm">
                    From <span className="addr">{p.from}</span>. Invoice reference: {p.invoiceRef || "none"}.
                  </p>
                  <label className="choice py-2 has-checked:bg-[var(--c-green-soft)] has-checked:text-[var(--c-on-green-soft)]">
                    <input type="radio" name={`pay-${p.id}`} checked={answers[p.id] === "income"} onChange={() => (setAnswers((a) => ({ ...a, [p.id]: "income" })), edited())} />
                    Income
                  </label>
                  <label className="choice py-2 has-checked:bg-[var(--c-green-soft)] has-checked:text-[var(--c-on-green-soft)]">
                    <input type="radio" name={`pay-${p.id}`} checked={answers[p.id] === "not_income"} onChange={() => (setAnswers((a) => ({ ...a, [p.id]: "not_income" })), edited())} />
                    Not income
                  </label>
                </div>
              ))}
            </fieldset>
          )}
        </div>
      )}

      {run.kind === "failed" && <p className="msg msg-bad">{run.message}</p>}
      {run.kind === "done" && <ResultView outcome={run.outcome} />}
    </main>
  );
}
