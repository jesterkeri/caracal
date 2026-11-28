// POST /tax/estimate: the naira tax estimate for one passkey wallet.
//
// It runs on the server because the CBN rate list does not allow browser
// requests (no CORS), and so the rates' retrieval time and the estimate's
// "as of" time come from one clock. It reads only public data (the wallet's
// payments on chain, CBN's published rates) and returns no secret, so it needs
// no sign-in. Every answer, including a refusal, is a 200 with a `status`; a
// malformed request is a 400.

import { clientKey, readBounded, WindowLimiter } from "@/lib/relay/policy";
import { NETWORK } from "@/lib/stellar/config";
import { fetchNfemTable } from "@/lib/tax/cbn-rates";
import { rpcChainReader } from "@/lib/tax/chain-payments";
import { parseTaxRequest, runTaxEstimate } from "@/lib/tax/pipeline";
import { DISCLAIMER } from "@caracal/tax";
import { ESTIMATE_DEADLINE_MS, deadlineSignal, fetchUntil } from "@/lib/tax/deadline";

const MAX_BODY_BYTES = 16_000;

/**
 * A per-process burst limit on this unauthenticated route, like the relay's: per client address and for the whole
 * process. It is not a shared quota across server instances; that comes with the database, before a public deploy
 * (docs/fix-day.md).
 */
const perClient = new WindowLimiter(6, 60_000);
const perInstance = new WindowLimiter(60, 60_000);

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  if (!perClient.take(clientKey(request, process.env))) return json({ error: "Too many estimates were asked for from this address. Wait a minute and try again." }, 429);
  if (!perInstance.take("all")) return json({ error: "Caracal is answering too many estimates right now. Try again in a minute." }, 429);
  // The deadline covers the whole request, the body's read included (Codex tax R5): a body that stalls is given up
  // at the deadline or when the caller goes away, and its stream is cancelled.
  const deadline = deadlineSignal();
  const stop = AbortSignal.any([request.signal, deadline.signal]);
  const until = fetchUntil(stop);
  const stopped = () =>
    deadline.signal.aborted
      ? json({ status: "unavailable", message: `The estimate took longer than ${ESTIMATE_DEADLINE_MS / 1000} seconds, so Caracal stopped it. No number was produced. Try again.`, disclaimer: DISCLAIMER })
      : json({ error: "The request was cancelled before the estimate finished. No number was produced." }, 400);
  try {
    let text: string;
    try {
      const read = await readBounded(request, MAX_BODY_BYTES, stop);
      if (read === null) return json({ error: "The request was too large." }, 400);
      text = read;
    } catch {
      if (stop.aborted) return stopped();
      return json({ error: "The request could not be read." }, 400);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: "The request was not valid JSON." }, 400);
    }
    const parsed = parseTaxRequest(body);
    if (!parsed.ok) return json({ error: parsed.message }, 400);
    if (!/^https:\/\//i.test(NETWORK.rpcUrl)) return json({ error: "This server's Stellar RPC setting must be an https address." }, 500);
    const outcome = await runTaxEstimate(parsed.req, {
      chain: rpcChainReader(NETWORK.rpcUrl, until),
      rateTable: () => fetchNfemTable(until),
      now: () => new Date(),
    });
    // A read cut off by the deadline reads as an RPC or rate failure; say what really happened, and never pass on
    // an answer finished after the deadline.
    if (stop.aborted) return stopped();
    return json(outcome);
  } catch (e) {
    if (stop.aborted) return stopped();
    console.error("tax estimate failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "The estimate failed unexpectedly. No number was produced." }, 500);
  } finally {
    deadline.clear();
  }
}
