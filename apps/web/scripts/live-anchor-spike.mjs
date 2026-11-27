// Usage (from apps/web): node scripts/live-anchor-spike.mjs <state.json> <step>
// Live spike of SEP-45 auth + SEP-24 withdraw on testanchor.stellar.org, TESTNET ONLY.
// Steps, in order: wallet | usdc | withdraw
//   wallet    deploy a throwaway passkey wallet (software P-256 key) straight to testnet
//   usdc      give the wallet 9 test USDC (bought on the testnet DEX; see the note below)
//   status    print the anchor's record of the last withdrawal (tokens removed)
//   withdraw  SEP-45 auth, SEP-24 interactive withdraw, send USDC to the anchor, poll to the end
// The state file holds a throwaway software passkey and a throwaway G key. Keep it
// OUTSIDE the repo (a scratch folder); it is never committed. Tokens are never printed.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Address, Asset, Keypair, MuxedAccount, Account, Operation, TransactionBuilder, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";
import { ANCHOR, PASS, USDC, USDC_ISSUER, deployWallet, fundG, newPasskey, server, signWithPasskey, sleep, submit } from "./live-anchor-common.mjs";

const [statePath, step] = process.argv.slice(2);
if (!statePath || !step) throw new Error("usage: live-anchor-spike.mjs <state.json> <wallet|usdc|withdraw>");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
const REF = "https://anchor-reference-server-testanchor.stellar.org";
const invoke = (fn, args) =>
  xdr.HostFunction.hostFunctionTypeInvokeContract(new xdr.InvokeContractArgs({ contractAddress: Address.fromString(USDC).toScAddress(), functionName: fn, args }));

/** SEP-45: challenge from the anchor, wallet entry signed by the passkey, token back. */
async function sep45Token() {
  const q = new URLSearchParams({ account: state.wallet, home_domain: "testanchor.stellar.org" });
  const ch = await fetch(`${ANCHOR}/sep45/auth?${q}`);
  if (!ch.ok) throw new Error(`challenge ${ch.status} ${await ch.text()}`);
  const body = await ch.json();
  const entries = xdr.SorobanAuthorizationEntries.fromXDR(body.authorization_entries, "base64");
  const { sequence } = await server.getLatestLedger();
  const out = [];
  for (const e of entries) {
    const c = e.credentials();
    const who = c.switch().name === "sorobanCredentialsAddress" ? Address.fromScAddress(c.address().address()).toString() : null;
    const fn = e.rootInvocation().function().contractFn().functionName().toString();
    console.log("challenge entry:", who === state.wallet ? "wallet's (to sign)" : "anchor's (already signed)", fn);
    out.push(who === state.wallet ? await signWithPasskey(state.pk, state.wallet, e, sequence + 100) : e);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32BE(out.length);
  const payload = Buffer.concat([count, ...out.map((o) => o.toXDR())]).toString("base64");
  const r = await fetch(`${ANCHOR}/sep45/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ authorization_entries: payload }) });
  if (!r.ok) throw new Error(`token ${r.status} ${await r.text()}`);
  console.log("SEP-45 token issued (not printed)");
  return (await r.json()).token;
}

const txn = async (token, id) => (await (await fetch(`${ANCHOR}/sep24/transaction?id=${id}`, { headers: { Authorization: `Bearer ${token}` } })).json()).transaction;

if (step === "wallet") {
  const payer = Keypair.random();
  await fundG(payer);
  const pk = newPasskey();
  const w = await deployWallet(pk, payer);
  Object.assign(state, { payerSecret: payer.secret(), pk, wallet: w.contractId });
  save();
  console.log("wallet", w.contractId, "deploy tx", w.hash);
}

if (step === "usdc") {
  // The anchor's own USDC deposit failed on 2026-11-27 (it errors with Error(Contract, #10)
  // when it sends), so buy USDC on the testnet DEX with the throwaway G account, then move it in.
  const g = Keypair.fromSecret(state.payerSecret);
  const usdc = new Asset("USDC", USDC_ISSUER);
  const horizon = async (tx) => {
    const r = await fetch("https://horizon-testnet.stellar.org/transactions", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tx=" + encodeURIComponent(tx.toXDR()) });
    const j = await r.json();
    console.log("horizon", r.status, j.hash ?? JSON.stringify(j.extras?.result_codes));
    if (!r.ok) throw new Error("horizon refused");
  };
  const build = async (op) => {
    const t = new TransactionBuilder(await server.getAccount(g.publicKey()), { fee: "100000", networkPassphrase: PASS }).addOperation(op).setTimeout(60).build();
    t.sign(g);
    return t;
  };
  await horizon(await build(Operation.changeTrust({ asset: usdc })));
  await horizon(await build(Operation.pathPaymentStrictSend({ sendAsset: Asset.native(), sendAmount: "200", destination: g.publicKey(), destAsset: usdc, destMin: "10" })));
  const r = await submit(g, invoke("transfer", [nativeToScVal(g.publicKey(), { type: "address" }), nativeToScVal(state.wallet, { type: "address" }), nativeToScVal(90000000n, { type: "i128" })]));
  console.log("moved 9 USDC into the wallet, tx", r.hash);
}

if (step === "withdraw") {
  const token = await sep45Token();
  const AMOUNT = "2";
  const start = await fetch(`${ANCHOR}/sep24/transactions/withdraw/interactive`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ asset_code: "USDC", account: state.wallet, amount: AMOUNT, lang: "en" }),
  });
  if (!start.ok) throw new Error(`withdraw start ${start.status} ${await start.text()}`);
  const { id, url, type } = await start.json();
  console.log("anchor transaction", id, type, new URL(url).origin);
  // The anchor's popup does this. A script has no popup, so it drives the reference UI's own API.
  const itok = new URL(url).searchParams.get("token");
  const sid = (await (await fetch(`${REF}/start`, { method: "POST", headers: { Authorization: `Bearer ${itok}` } })).json()).sessionId;
  const sub = await fetch(`${REF}/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sid}`, "content-type": "application/json" },
    body: JSON.stringify({ amount: AMOUNT, name: "Test", surname: "User", email: "test@example.com", bank: "Test Bank", account: "0123456789" }),
  });
  console.log("interactive form submitted", sub.status);
  let t = await txn(token, id);
  for (let i = 0; i < 20 && t.status !== "pending_user_transfer_start"; i++) {
    await sleep(2000);
    t = await txn(token, id);
  }
  console.log("status", t.status, "| in", t.amount_in, "| out", t.amount_out, "| fee", JSON.stringify(t.fee_details));
  console.log("pay to", t.withdraw_anchor_account, "memo", t.withdraw_memo, t.withdraw_memo_type);
  if (t.status !== "pending_user_transfer_start") throw new Error("anchor never asked for the funds");

  // Soroban has no memo, so the memo id travels inside a muxed (M) destination.
  const muxed = new MuxedAccount(new Account(t.withdraw_anchor_account, "0"), t.withdraw_memo).accountId();
  console.log("muxed destination", muxed);
  const stroops = BigInt(Math.round(Number(t.amount_in) * 1e7));
  const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
    new xdr.InvokeContractArgs({
      contractAddress: Address.fromString(USDC).toScAddress(),
      functionName: "transfer",
      args: [
        xdr.ScVal.scvAddress(Address.fromString(state.wallet).toScAddress()),
        xdr.ScVal.scvAddress(Address.fromString(muxed).toScAddress()),
        nativeToScVal(stroops, { type: "i128" }),
      ],
    }),
  );
  // The relay stand-in: a throwaway G account sources and pays. In Caracal the relay does this.
  const payer = Keypair.fromSecret(state.payerSecret);
  const sim = await server.simulateTransaction(
    new TransactionBuilder(await server.getAccount(payer.publicKey()), { fee: "100", networkPassphrase: PASS }).addOperation(Operation.invokeHostFunction({ func, auth: [] })).setTimeout(60).build(),
  );
  if (rpc.Api.isSimulationError(sim)) throw new Error("simulation: " + sim.error);
  const { sequence } = await server.getLatestLedger();
  const auth = [];
  for (const e of sim.result.auth) auth.push(await signWithPasskey(state.pk, state.wallet, e, sequence + 100));
  const sent = await submit(payer, func, auth);
  console.log("USDC sent to the anchor, tx", sent.hash);
  for (let i = 0; i < 60; i++) {
    t = await txn(token, id);
    console.log("status", t.status, t.message ?? "");
    if (["completed", "error", "expired", "refunded"].includes(t.status)) break;
    await sleep(5000);
  }
  console.log("final", t.status, "| in", t.amount_in, "| out", t.amount_out, "| fee", JSON.stringify(t.fee_details), "| stellar txs", JSON.stringify(t.stellar_transactions?.map((x) => x.id)));
  state.lastAnchorTx = id;
  save();
}

if (step === "status") {
  // Prints the anchor's record of the last withdrawal, tokens in links removed.
  const t = await txn(await sep45Token(), state.lastAnchorTx);
  console.log(JSON.stringify(t, null, 2).replace(/token=[A-Za-z0-9._-]+/g, "token=<redacted>"));
}
