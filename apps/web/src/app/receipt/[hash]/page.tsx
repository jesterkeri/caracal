// A shareable receipt for one payment: what the payer paid and how the
// freelancer's Caracal split contract divided it. Anyone with the link can
// open it; it shows only what is already public on Stellar.

import type { Metadata } from "next";
import { Suspense } from "react";
import { ReceiptBody } from "./receipt-body";

export const metadata: Metadata = { title: "Payment receipt · Caracal" };

export default function ReceiptPage({ params }: { params: Promise<{ hash: string }> }) {
  return (
    <main className="page min-h-dvh pt-10">
      <h1 className="h1">Payment receipt</h1>
      {/* Read from the network on each request, so it streams in after the page shell. */}
      <Suspense fallback={<p className="muted small">Reading this payment from Stellar...</p>}>
        <ReceiptBody params={params} />
      </Suspense>
    </main>
  );
}
