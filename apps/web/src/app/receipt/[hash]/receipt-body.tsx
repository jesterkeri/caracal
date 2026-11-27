// The receipt itself, read from the chain at request time
// (src/lib/stellar/receipt.ts). Rendered inside <Suspense> by page.tsx.

import { rpc } from "@stellar/stellar-sdk";
import { RPC_TIMEOUT_MS, within } from "@/lib/relay/sponsor";
import { isLoopback } from "@/lib/relay/wasm-lookup";
import { NETWORK, explorerLink } from "@/lib/stellar/config";
import { baseAccount, formatUsdc, formatXlm, isTxHash, readSplitReceipt, shortAddress, type ReceiptRead } from "@/lib/stellar/receipt";

let server: rpc.Server | null = null;

async function read(hash: string): Promise<ReceiptRead> {
  try {
    server ??= new rpc.Server(NETWORK.rpcUrl, { allowHttp: isLoopback(NETWORK.rpcUrl) });
  } catch (e) {
    console.error("receipt: the RPC URL is not usable:", e instanceof Error ? e.message : String(e));
    return { kind: "not-set-up" };
  }
  const rpcServer = server;
  return readSplitReceipt(hash, {
    getTransaction: (h) => within(rpcServer.getTransaction(h), RPC_TIMEOUT_MS, "getTransaction"),
    networkPassphrase: NETWORK.passphrase,
  });
}

const MESSAGES: Record<Exclude<ReceiptRead["kind"], "found">, string> = {
  "not-found":
    "Caracal could not find this payment. Check the link. The network keeps about a week of history, so an older payment may no longer show here; it can still be seen on Stellar Expert.",
  failed: "This transaction failed on the network, so no payment was made.",
  "no-split": "Caracal could not confirm this transaction as a payment into a Caracal split contract, so it shows no receipt for it.",
  unreachable: "Caracal could not reach the Stellar network just now. Reload the page to try again.",
  unreadable: "Caracal could not read this transaction's details from the network, so it shows no receipt for it.",
  "not-set-up": "Receipts are not set up on this server: its Stellar RPC setting (NEXT_PUBLIC_STELLAR_RPC_URL) cannot be used.",
};

export async function ReceiptBody({ params }: { params: Promise<{ hash: string }> }) {
  const hash = (await params).hash.toLowerCase();
  const r: ReceiptRead = isTxHash(hash) ? await read(hash) : { kind: "not-found" };

  return (
    <>
      {r.kind !== "found" ? (
        <div className="flex flex-col gap-3">
          <p role="alert" className="msg msg-bad">{MESSAGES[r.kind]}</p>
          {isTxHash(hash) && (
            <a className="link small self-start" href={explorerLink("tx", hash)}>
              Look up this transaction on Stellar Expert
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-8">
          {r.receipts.map((p, i) => (
            <section key={i} className="flex flex-col gap-3 [section+&]:border-t [section+&]:border-[var(--c-line)] [section+&]:pt-8">
              <div className="card card-hero gap-5">
                <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-current/15 ring-1 ring-current/25">
                  <span className="mb-1 block h-4 w-2 rotate-45 border-r-2 border-b-2 border-current" />
                </span>
                <div className="flex flex-col gap-1.5">
                <p className="money-xl num break-words">{formatUsdc(p.amount)} USDC</p>
                <p className="text-[0.9375rem] leading-snug opacity-85">
                  paid for invoice <strong className="font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">{p.invoiceRef}</strong>
                </p>
                </div>
              </div>
              <div className="card gap-1">
                <p className="h3">How the freelancer&apos;s Caracal split divided it</p>
                <dl className="kv">
                  <div className="kv-row">
                  <dt>Set aside for tax</dt>
                  <dd className="num whitespace-nowrap">{formatUsdc(p.tax)} USDC</dd>
                  </div>
                  <div className="kv-row">
                  <dt>Savings goal</dt>
                  <dd className="num whitespace-nowrap">{formatUsdc(p.goal)} USDC</dd>
                  </div>
                  <div className="kv-row">
                  <dt>Available to spend</dt>
                  <dd className="num whitespace-nowrap">{formatUsdc(p.spend)} USDC</dd>
                  </div>
                </dl>
                <p className="notice small mt-2">
                  The amount set aside for tax follows the freelancer&apos;s own split setting. It is not a tax calculation, and not tax advice.
                </p>
              </div>
              <div className="card">
              <dl className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                <dt className="eyebrow">From</dt>
                <dd className="addr addr-box">{p.from}</dd>
                </div>
                <div className="flex flex-col gap-1.5">
                <dt className="eyebrow">To</dt>
                <dd className="addr addr-box">{p.owner}</dd>
                </div>
              </dl>
              <a className="link small self-start" href={explorerLink("contract", p.splitContract)}>
                View the split contract
              </a>
              </div>
            </section>
          ))}
          </div>
          {/* Once per transaction: the fee and time belong to the whole transaction, not to each payment in it. */}
          <div className="card gap-4">
          <dl className="kv">
            <div className="kv-row [&>dd]:min-w-0">
            <dt className="shrink-0">Network fee</dt>
            <dd>{feeText(r)}</dd>
            </div>
            <div className="kv-row">
            <dt className="shrink-0">Recorded</dt>
            <dd className="min-w-0 num">
              {r.closedAt.toISOString().slice(0, 16).replace("T", " ")} UTC, ledger {r.ledger}
            </dd>
            </div>
          </dl>
          <a className="btn btn-secondary btn-block" href={explorerLink("tx", r.hash)}>
            View the transaction on Stellar Expert
          </a>
          </div>
        </>
      )}
    </>
  );
}

/** Who paid the network fee, compared with the payers (G... accounts; muxed ids already removed). */
function feeText(r: Extract<ReceiptRead, { kind: "found" }>): string {
  const fee = `${formatXlm(r.feeCharged)} XLM`;
  const payers = new Set(r.receipts.map((p) => baseAccount(p.from)));
  if (!payers.has(r.feePayer)) return `None for the payer (${fee} paid by ${shortAddress(r.feePayer)})`;
  return payers.size === 1 ? `${fee}, paid by the payer` : `${fee}, paid by ${shortAddress(r.feePayer)}`;
}
