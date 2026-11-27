// Adversary t5: the CBN rate list's size limit is applied only after the whole
// body has been read into memory.
//
// Promise: apps/web/src/lib/tax/cbn-rates.ts defines MAX_BODY_CHARS = 5_000_000
// and refuses "The CBN rate list was larger than expected." The same pass that
// found the POST body unbounded (adversary-t1-route-body, decisions 2026-11-27
// row, finding 3: "reads its body with readBounded ... and answers 400 without
// reading the rest") treats a size limit as a limit on what is READ, not on
// what is judged afterwards. fetchNfemTable calls `res.text()` first and only
// then compares `text.length`, so a list of any size is downloaded and held in
// memory (until the 20 s timer) before it is refused.
//
// The stream here is a local fake (no network): 64 MiB offered in 1 MiB chunks,
// counting how many bytes the reader actually pulled.
import { describe, expect, it } from "vitest";
import { RateSourceError, fetchNfemTable } from "../src/lib/tax/cbn-rates";

const MIB = 1024 * 1024;

function streamed(totalBytes: number, headers: Record<string, string> = { "content-type": "application/json" }) {
  let pulled = 0;
  const chunk = new Uint8Array(MIB).fill(0x20); // spaces: valid JSON whitespace, never parses to a list
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalBytes) return controller.close();
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const fetchFn = async () => new Response(body, { status: 200, headers });
  return { fetchFn, pulled: () => pulled };
}

describe("adversary t5: the CBN list size limit stops the read", () => {
  it("control: a list over 5,000,000 characters is refused as larger than expected", async () => {
    const s = streamed(6 * MIB);
    const err = await fetchNfemTable(s.fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateSourceError);
    expect((err as Error).message).toMatch(/larger than expected/);
  });

  it("stops pulling from a 64 MiB answer soon after the 5,000,000 character limit (it reads all of it today)", async () => {
    const s = streamed(64 * MIB);
    const err = await fetchNfemTable(s.fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateSourceError);
    // The limit is about 4.8 MiB. Allow a few chunks of read-ahead, not the whole 64 MiB.
    expect(s.pulled()).toBeLessThanOrEqual(8 * MIB);
  });
});
