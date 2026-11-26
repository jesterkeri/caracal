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
  "no-split": "This transaction is not a payment into a Caracal split contract.",
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
        <div className="flex flex-col gap-3 text-sm">
          <p role="alert">{MESSAGES[r.kind]}</p>
          {isTxHash(hash) && (
            <a className="underline" href={explorerLink("tx", hash)}>
              Look up this transaction on Stellar Expert
            </a>
          )}
        </div>
      ) : (
        <>
          {r.receipts.map((p, i) => (
            <section key={i} className="flex flex-col gap-4">
              <div>
                <p className="text-3xl font-semibold">{formatUsdc(p.amount)} USDC</p>
                <p className="text-sm opacity-80">
                  paid for invoice <strong>{p.invoiceRef}</strong>
                </p>
              </div>
              <div className="flex flex-col gap-2 rounded-lg border p-4">
                <p className="text-sm font-medium">How the freelancer&apos;s Caracal split divided it</p>
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
                  <dt>Set aside for tax</dt>
                  <dd className="text-right font-mono">{formatUsdc(p.tax)} USDC</dd>
                  <dt>Savings goal</dt>
                  <dd className="text-right font-mono">{formatUsdc(p.goal)} USDC</dd>
                  <dt>Available to spend</dt>
                  <dd className="text-right font-mono">{formatUsdc(p.spend)} USDC</dd>
                </dl>
                <p className="text-xs opacity-70">
                  The amount set aside for tax follows the freelancer&apos;s own split setting. It is not a tax calculation, and not tax advice.
                </p>
              </div>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="opacity-70">From</dt>
                <dd className="font-mono">{shortAddress(p.from)}</dd>
                <dt className="opacity-70">To</dt>
                <dd className="font-mono">{shortAddress(p.owner)}</dd>
              </dl>
              <a className="text-sm underline" href={explorerLink("contract", p.splitContract)}>
                View the split contract
              </a>
            </section>
          ))}
          {/* Once per transaction: the fee and time belong to the whole transaction, not to each payment in it. */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="opacity-70">Network fee</dt>
            <dd>{feeText(r)}</dd>
            <dt className="opacity-70">Recorded</dt>
            <dd>
              {r.closedAt.toISOString().slice(0, 16).replace("T", " ")} UTC, ledger {r.ledger}
            </dd>
          </dl>
          <a className="text-sm underline" href={explorerLink("tx", r.hash)}>
            View the transaction on Stellar Expert
          </a>
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
