// The invoices list: the freelancer's saved details joined with what the chain
// says about each invoice. The chain is the truth for amount and status.

import { findPaymentTx, readInvoice, type EventReader, type InvoiceOnChain, type Reader } from "./chain";
import type { Details } from "./details";

/**
 * chain: what the contract says.
 *   an invoice: open, paid or cancelled, with its amount;
 *   null: the contract has no such invoice (the details were saved but opening it did not finish);
 *   "unreadable": the network could not be asked just now.
 * txHash: for a paid invoice, the payment's transaction when it could be found (the node keeps about a week of events).
 */
export type Row = Details & { chain: InvoiceOnChain | null | "unreadable"; txHash: string | null };

export async function loadRows(server: Reader & EventReader, details: Details[], split: string): Promise<Row[]> {
  // Only invoices opened on this split contract: an older contract's invoices cannot be read from this one.
  const mine = details.filter((d) => d.split === split);
  return Promise.all(
    mine.map(async (d): Promise<Row> => {
      let chain: Row["chain"];
      try {
        chain = await readInvoice(server, split, d.invoice_ref);
      } catch {
        return { ...d, chain: "unreadable", txHash: null };
      }
      const txHash = chain?.status === "paid" ? await findPaymentTx(server, split, d.invoice_ref) : null;
      return { ...d, chain, txHash };
    }),
  );
}

/** The words for an invoice's state. */
export function statusText(chain: Row["chain"]): string {
  if (chain === "unreadable") return "Status unknown: the network could not be reached";
  if (chain === null) return "Not opened on chain (the opening did not finish)";
  return { open: "Open, waiting for payment", paid: "Paid", cancelled: "Cancelled" }[chain.status];
}
