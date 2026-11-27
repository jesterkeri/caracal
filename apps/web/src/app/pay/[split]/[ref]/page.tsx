import { Suspense } from "react";
import PayClient from "./pay-client";

type Params = Promise<{ split: string; ref: string }>;

async function Invoice({ params }: { params: Params }) {
  const { split, ref } = await params;
  return <PayClient split={split} invoiceRef={ref} />;
}

// The pay link carries only the split contract and the invoice id. The amount
// and status are read from the chain in the browser, never taken from the URL.
export default function PayPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<p className="p-4 text-sm">Loading the invoice.</p>}>
      <Invoice params={params} />
    </Suspense>
  );
}
