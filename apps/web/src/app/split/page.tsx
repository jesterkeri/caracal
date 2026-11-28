"use client";

import { useEffect, useState } from "react";
import { followAccount } from "@/lib/auth/account";
import { browserStore } from "@/lib/auth/wallet-binding";
import { supabaseBrowser } from "@/lib/supabase/client";
import { supabaseEnvOrNull } from "@/lib/supabase/env";
import { HTTPS_RPC_REQUIRED, getKit } from "@/lib/stellar/kit";
import { NETWORK, explorerLink } from "@/lib/stellar/config";
import type { LedgerReader } from "@/lib/stellar/wallet-lookup";
import { formatUsdc, bpsText, parsePercent, parseUsdc } from "@/lib/split/amounts";
import type { SimulatingRpc } from "@/lib/split/chain";
import { POTS, type Pot } from "@/lib/split/calls";
import { POT_LABEL, changeSplit, deploySplit, loadSplit, moveBetweenPots, potBalance, withdrawToWallet, type Loaded } from "@/lib/split/actions";
import { say, type Said } from "@/lib/split/messages";
import { splitAddressFor } from "@/lib/stellar/split-address";
import { acquireWrite, hasWriteRecord, holdOn, holdText, readLedger } from "@/lib/split/write-guard";
import { restoreWallet, type Account } from "@/lib/split/restore";
import type { SendOutcome, WriteKit } from "@/lib/split/send";

const WALLET_UNCHECKED = "Caracal could not load your wallet. Check your connection and reload the page.";
const SIGN_IN_UNCHECKED = "Caracal could not verify your sign-in. Check your connection and reload the page, or open the wallet page to sign out and in again.";
const ARCHIVED =
  "Your split contract exists on Stellar testnet, but its data has expired and must be restored before it can be used. Caracal cannot restore it yet. Do not deploy another.";

type View =
  | { kind: "checking" }
  | { kind: "problem"; message: string }
  | { kind: "no-wallet" }
  | { kind: "ready"; wallet: string; loaded: Loaded };

type Form = {
  deployTax: string;
  deployGoal: string;
  wdPot: Pot;
  wdAmount: string;
  moveFrom: Pot;
  moveTo: Pot;
  moveAmount: string;
  newTax: string;
  newGoal: string;
};
const EMPTY_FORM: Form = { deployTax: "", deployGoal: "", wdPot: "Spend", wdAmount: "", moveFrom: "Spend", moveTo: "Goal", moveAmount: "", newTax: "", newGoal: "" };

type Note = { busy?: string; said?: Said };

// Reads and writes are ordered by these, not by render state (which a click can
// outrun). Each read takes a number; a write takes one when it starts. A read
// that finishes after a newer read or write began is dropped, so an older,
// slower read never puts earlier pots on screen or clears a write's note.
let readSeq = 0;
let writing = false;
/** A hold on writes was shown since the last read of the pots (see the effect after `hold`). */
let heldSeen = false;

export default function SplitPage() {
  const [view, setView] = useState<View>({ kind: "checking" });
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [note, setNote] = useState<Note>({});
  const [account, setAccount] = useState<Account | null>(null);
  // Bumped every few seconds so the hold on writes (below) is read again and lifts on its own.
  const [, setTick] = useState(0);
  // The latest ledger read while this browser holds a write record: the hold lifts once it passes the record's
  // closeBy (write-guard.ts). null until read, or when it cannot be read, and the hold then stays.
  const [seenLedger, setSeenLedger] = useState<number | null>(null);

  useEffect(() => {
    let unfollow: (() => void) | undefined;
    let gone = false;
    let accountMoved = false;
    const stale = () => gone || accountMoved;
    (async () => {
      if (!supabaseEnvOrNull()) return window.location.replace("/signin");
      const auth = supabaseBrowser().auth;
      const r = await restoreWallet({
        auth,
        getKit,
        store: browserStore,
        stale,
        onAccount: (me) => {
          setAccount(me);
          unfollow = followAccount(auth, me.id, () => {
            accountMoved = true;
            setAccount(null);
            window.location.reload();
          });
        },
      });
      if (!r || stale()) return;
      if (r.kind === "signed-out") return window.location.replace("/signin");
      if (r.kind === "unverified") return setView({ kind: "problem", message: SIGN_IN_UNCHECKED });
      if (r.kind === "no-wallet") return setView({ kind: "no-wallet" });
      if (r.kind === "failed") {
        console.error("could not load the wallet:", r.error instanceof Error ? r.error.message : String(r.error));
        return setView({ kind: "problem", message: r.error instanceof Error && r.error.message === HTTPS_RPC_REQUIRED ? HTTPS_RPC_REQUIRED : WALLET_UNCHECKED });
      }
      const kit = await getKit();
      const loaded = await loadSplit(kit.rpc as unknown as LedgerReader & SimulatingRpc, r.wallet);
      if (stale()) return;
      setView({ kind: "ready", wallet: r.wallet, loaded });
    })().catch((e: unknown) => {
      console.error("could not open the split page:", e instanceof Error ? e.message : String(e));
      if (!stale()) setView({ kind: "problem", message: WALLET_UNCHECKED });
    });
    return () => {
      gone = true;
      unfollow?.();
    };
  }, []);

  const shownSplit = view.kind === "ready" ? splitAddressFor(view.wallet) : null;
  useEffect(() => {
    let gone = false;
    const t = setInterval(() => {
      setTick((n) => n + 1);
      const split = shownSplit;
      if (!split || !hasWriteRecord(split)) return;
      getKit()
        .then((kit) => readLedger(kit.rpc))
        .then((n) => !gone && setSeenLedger(n))
        .catch(() => !gone && setSeenLedger(null));
    }, 5_000);
    return () => {
      gone = true;
      clearInterval(t);
    };
  }, [shownSplit]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const refused = (text: string) => setNote({ said: { tone: "bad", text } });

  /** Re-reads the contract from the network, keeping what was last said. */
  async function reread(wallet: string, said?: Said) {
    // A Refresh while a write runs would race it; the write reads afterwards itself.
    if (writing && said === undefined) return;
    const mine = ++readSeq;
    try {
      const kit = await getKit();
      const loaded = await loadSplit(kit.rpc as unknown as LedgerReader & SimulatingRpc, wallet);
      if (mine !== readSeq) return;
      setView({ kind: "ready", wallet, loaded });
      setNote({ said });
    } catch (e) {
      if (mine !== readSeq) return;
      setNote({ said: { tone: "bad", text: `Caracal could not read the network: ${e instanceof Error ? e.message : String(e)}` } });
    }
  }

  /** One write: passkey, fee relay, then the chain read again (unless the outcome proves nothing changed). */
  async function run(what: string, send: (kit: WriteKit) => Promise<SendOutcome>) {
    if (view.kind !== "ready" || note.busy || writing) return;
    const wallet = view.wallet;
    writing = true;
    try {
      // An earlier write that may still land, or one another tab is making, holds back every new write on
      // this split (write-guard.ts).
      // The write's last ledger is fixed from the ledger read now, before anything is signed (write-guard.ts).
      let kit: WriteKit;
      let ledger: number;
      try {
        kit = (await getKit()) as unknown as WriteKit;
        ledger = await readLedger(kit.rpc);
      } catch (e) {
        return setNote({ said: { tone: "bad", text: `Caracal could not read the Stellar network, so nothing was signed or sent. Check your connection and try again. (${e instanceof Error ? e.message : String(e)})` } });
      }
      setSeenLedger(ledger);
      const begun = await acquireWrite(splitAddressFor(wallet), ledger);
      if (!begun.ok) return setNote({ said: { tone: "unsure", text: holdText(begun.hold) } });
      const guard = begun.guard;
      // Any read already under way began before this write: it is dropped.
      readSeq++;
      setNote({ busy: "Waiting for your passkey" });
      let outcome: SendOutcome;
      try {
        outcome = await send(guard.kit(kit));
      } catch (e) {
        outcome = { kind: "unknown", message: e instanceof Error ? e.message : String(e) };
      }
      guard.finish(outcome);
      const said = say(outcome, what);
      if (outcome.kind === "refused" || outcome.kind === "stopped") return setNote({ said });
      setNote({ busy: "Reading the result from the network", said });
      await reread(wallet, said);
    } finally {
      writing = false;
    }
  }

  function deploy() {
    if (view.kind !== "ready") return;
    const tax = parsePercent(form.deployTax, "tax");
    const goal = parsePercent(form.deployGoal, "goal");
    if (!tax.ok) return refused(tax.message);
    if (!goal.ok) return refused(goal.message);
    const wallet = view.wallet;
    return run("Your split contract deployment", (kit) => deploySplit(kit, wallet, tax.value, goal.value));
  }

  function withdraw() {
    if (view.kind !== "ready" || view.loaded.kind !== "present") return;
    const amount = parseUsdc(form.wdAmount);
    if (!amount.ok) return refused(amount.message);
    const { wallet, loaded } = view;
    return run("Your withdrawal", (kit) => withdrawToWallet(kit, wallet, loaded.pots, form.wdPot, amount.value));
  }

  function move() {
    if (view.kind !== "ready" || view.loaded.kind !== "present") return;
    const amount = parseUsdc(form.moveAmount);
    if (!amount.ok) return refused(amount.message);
    const { wallet, loaded } = view;
    return run("Your move between pots", (kit) => moveBetweenPots(kit, wallet, loaded.pots, form.moveFrom, form.moveTo, amount.value));
  }

  function newSplit() {
    if (view.kind !== "ready" || view.loaded.kind !== "present") return;
    const tax = parsePercent(form.newTax, "tax");
    const goal = parsePercent(form.newGoal, "goal");
    if (!tax.ok) return refused(tax.message);
    if (!goal.ok) return refused(goal.message);
    const wallet = view.wallet;
    return run("Your split change", (kit) => changeSplit(kit, wallet, tax.value, goal.value));
  }

  const busy = note.busy !== undefined;
  const loaded = view.kind === "ready" ? view.loaded : null;
  // Read from storage on every render (not remembered), so a write in another tab or before a reload counts.
  const hold = view.kind === "ready" && loaded?.kind !== "error" ? holdOn(splitAddressFor(view.wallet), seenLedger) : ({ held: false } as const);
  const blocked = busy || hold.held;
  // When a hold lifts, the pots are read again and its note goes: a write that landed after the write's own
  // re-read is then on screen before the person repeats it (adversary s11).
  const readyWallet = view.kind === "ready" ? view.wallet : null;
  useEffect(() => {
    if (hold.held) {
      heldSeen = true;
      return;
    }
    if (!heldSeen || !readyWallet) return;
    const t = setTimeout(() => {
      heldSeen = false;
      void reread(readyWallet);
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hold.held, readyWallet]);

  return (
    <main className="page">
      <h1 className="h1">Your split and pots</h1>
      <p className="lead">
        Each payment you receive is divided on Stellar testnet into three pots, Tax, Goal and Spend, by a contract that only your passkey can move money out of.
        Caracal pays the network fee and can never move your money.
      </p>
      {account && (
        <p className="small muted">
          Signed in as <strong>{account.email ?? "your Google account"}</strong>. <a className="link" href="/wallet">Your wallet</a>
        </p>
      )}

      {view.kind === "checking" && <p className="small muted">Checking for your wallet...</p>}
      {view.kind === "problem" && <p className="msg msg-bad">{view.message}</p>}
      {view.kind === "no-wallet" && (
        <p className="msg msg-info">
          This browser has no wallet open for your account. <a className="link" href="/wallet">Open or create your wallet</a> first, then come back.
        </p>
      )}

      {view.kind === "ready" && loaded?.kind === "error" && (
        <div className="flex flex-col gap-3">
          <p className="msg msg-bad">{loaded.message}</p>
          <button className="btn btn-secondary btn-sm self-start" disabled={busy} onClick={() => reread(view.wallet)}>
            Try again
          </button>
        </div>
      )}
      {loaded?.kind === "archived" && <p className="msg msg-bad">{ARCHIVED}</p>}

      {view.kind === "ready" && loaded?.kind === "absent" && (
        <section className="card">
          <h2 className="h2">Set up your split</h2>
          <p className="small muted">
            No split contract was found for your wallet on Stellar testnet. Choose how each payment is divided. Spend is always what is left, so rounding is never lost. You can change this later.
            If you deployed one before and its data has expired, the deployment is stopped before it is sent, so nothing is made twice.
          </p>
          <label className="field">
            Tax pot, percent of each payment
            <input className="input" inputMode="decimal" placeholder="for example 10" value={form.deployTax} onChange={(e) => set("deployTax", e.target.value)} />
          </label>
          <label className="field">
            Goal pot, percent of each payment
            <input className="input" inputMode="decimal" placeholder="for example 15" value={form.deployGoal} onChange={(e) => set("deployGoal", e.target.value)} />
          </label>
          <button className="btn btn-primary btn-block" disabled={blocked} onClick={deploy}>
            Deploy my split contract with my passkey
          </button>
          <p className="small muted leading-7">
            Your wallet deploys it at a fixed address, <span className="addr addr-box box-decoration-clone px-1.5 py-0.5 text-[color:var(--c-text)]">{loaded.split}</span>, so it cannot be deployed twice. Caracal pays the fee.
          </p>
          <button className="btn btn-secondary btn-sm self-start" disabled={busy} onClick={() => reread(view.wallet)}>
            Check again
          </button>
        </section>
      )}

      {view.kind === "ready" && loaded?.kind === "present" && (
        <>
          <section className="card">
            <h2 className="h2">Your pots (USDC)</h2>
            <ul className="kv">
              {POTS.map((p) => (
                <li key={p} className="kv-row [&>:first-child]:text-(color:--c-muted)">
                  <span>{POT_LABEL[p]}</span>
                  <span className="kv-v num font-mono">{formatUsdc(potBalance(loaded.pots, p))}</span>
                </li>
              ))}
            </ul>
            <p className="small muted">
              New payments split {bpsText(loaded.config.taxBps)}% to Tax, {bpsText(loaded.config.goalBps)}% to Goal and the rest ({bpsText(10_000 - loaded.config.taxBps - loaded.config.goalBps)}%) to Spend.
            </p>
            <p className="small muted">
              Contract:{" "}
              <a className="link addr" href={explorerLink("contract", loaded.split)}>
                {loaded.split}
              </a>
            </p>
            <button className="btn btn-secondary btn-sm self-start" disabled={busy} onClick={() => reread(view.wallet)}>
              Refresh
            </button>
          </section>

          <section className="card">
            <h2 className="h2">Withdraw to your wallet</h2>
            <label className="field">
              From pot
              <select className="select" value={form.wdPot} onChange={(e) => set("wdPot", e.target.value as Pot)}>
                {POTS.map((p) => (
                  <option key={p} value={p}>
                    {POT_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Amount in USDC
              <input className="input" inputMode="decimal" placeholder="25.00" value={form.wdAmount} onChange={(e) => set("wdAmount", e.target.value)} />
            </label>
            <p className="small muted leading-7">
              Goes to your own wallet <span className="addr addr-box box-decoration-clone px-1.5 py-0.5 text-[color:var(--c-text)]">{view.wallet}</span>.
            </p>
            <button className="btn btn-primary btn-block" disabled={blocked} onClick={withdraw}>
              Withdraw with my passkey
            </button>
          </section>

          <section className="card">
            <h2 className="h2">Move between pots</h2>
            <label className="field">
              From
              <select className="select" value={form.moveFrom} onChange={(e) => set("moveFrom", e.target.value as Pot)}>
                {POTS.map((p) => (
                  <option key={p} value={p}>
                    {POT_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              To
              <select className="select" value={form.moveTo} onChange={(e) => set("moveTo", e.target.value as Pot)}>
                {POTS.map((p) => (
                  <option key={p} value={p}>
                    {POT_LABEL[p]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Amount in USDC
              <input className="input" inputMode="decimal" placeholder="5.00" value={form.moveAmount} onChange={(e) => set("moveAmount", e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block" disabled={blocked} onClick={move}>
              Move with my passkey
            </button>
          </section>

          <section className="card">
            <h2 className="h2">Change the split</h2>
            <p className="small muted">This applies to payments that arrive after the change. Money already in the pots stays where it is.</p>
            <label className="field">
              Tax pot, percent
              <input className="input" inputMode="decimal" placeholder={bpsText(loaded.config.taxBps)} value={form.newTax} onChange={(e) => set("newTax", e.target.value)} />
            </label>
            <label className="field">
              Goal pot, percent
              <input className="input" inputMode="decimal" placeholder={bpsText(loaded.config.goalBps)} value={form.newGoal} onChange={(e) => set("newGoal", e.target.value)} />
            </label>
            <button className="btn btn-primary btn-block" disabled={blocked} onClick={newSplit}>
              Change split with my passkey
            </button>
          </section>
        </>
      )}

      {!busy && hold.held && <p className="msg msg-unsure">{holdText(hold)}</p>}
      {note.busy && <p className="small muted">{note.busy}...</p>}
      {note.said && (
        <div className={`msg flex flex-col gap-1 ${note.said.tone === "good" ? "msg-good" : note.said.tone === "bad" ? "msg-bad" : "msg-unsure"}`}>
          <p>{note.said.text}</p>
          {note.said.hash && (
            <a className="link self-start text-current" href={explorerLink("tx", note.said.hash)}>
              Transaction on Stellar testnet (fee paid by the sponsor)
            </a>
          )}
        </div>
      )}
      <p className="small muted">Network: Stellar {NETWORK.name}.</p>
    </main>
  );
}
