// Harness for the tax tests written before the person had to say whether each payment is income (Codex tax R1,
// finding 2). Their chain fixtures are payments from a third party that the old pipeline counted as income by
// default. This runs the real pipeline the way the page does: the first request has no answers, the pipeline
// lists the payments it needs answers for, and the second request answers "income" for every listed payment.
// A pipeline answer that is not a classification refusal (or a request that already carries answers) is returned
// untouched, so nothing else about a test's assertions changes.
import { runTaxEstimate as real, type PipelineDeps, type TaxOutcome, type TaxRequest } from "../src/lib/tax/pipeline";

export async function runTaxEstimate(req: TaxRequest, deps: PipelineDeps, networkPassphrase?: string): Promise<TaxOutcome> {
  const first = await real(req, deps, networkPassphrase);
  if (req.classifications === undefined && first.status === "refused" && first.payments !== undefined) {
    return real({ ...req, classifications: Object.fromEntries(first.payments.map((p) => [p.id, "income" as const])) }, deps, networkPassphrase);
  }
  return first;
}
