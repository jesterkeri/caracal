// POST /tax/estimate: the naira tax estimate for one passkey wallet.
//
// It runs on the server because the CBN rate list does not allow browser
// requests (no CORS), and so the rates' retrieval time and the estimate's
// "as of" time come from one clock. It reads only public data (the wallet's
// payments on chain, CBN's published rates) and returns no secret, so it needs
// no sign-in. Every answer, including a refusal, is a 200 with a `status`; a
// malformed request is a 400.

import { NETWORK } from "@/lib/stellar/config";
import { fetchNfemTable } from "@/lib/tax/cbn-rates";
import { rpcChainReader } from "@/lib/tax/chain-payments";
import { parseTaxRequest, runTaxEstimate } from "@/lib/tax/pipeline";

const MAX_BODY_CHARS = 2_000;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return json({ error: "The request could not be read." }, 400);
  }
  if (text.length > MAX_BODY_CHARS) return json({ error: "The request was too large." }, 400);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "The request was not valid JSON." }, 400);
  }
  const parsed = parseTaxRequest(body);
  if (!parsed.ok) return json({ error: parsed.message }, 400);
  if (!/^https:\/\//i.test(NETWORK.rpcUrl)) return json({ error: "This server's Stellar RPC setting must be an https address." }, 500);

  try {
    const outcome = await runTaxEstimate(parsed.req, {
      chain: rpcChainReader(NETWORK.rpcUrl),
      rateTable: () => fetchNfemTable(),
      now: () => new Date(),
    });
    return json(outcome);
  } catch (e) {
    console.error("tax estimate failed:", e instanceof Error ? e.message : String(e));
    return json({ error: "The estimate failed unexpectedly. No number was produced." }, 500);
  }
}
