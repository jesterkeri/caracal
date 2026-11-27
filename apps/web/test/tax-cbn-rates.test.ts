// The CBN rate adapter. fixtures/tax/cbn-nfem-rates.json holds rows copied
// verbatim from the CBN's real answer (see its "note": captured 2026-11-27).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CBN_NFEM_DATA_URL, CBN_RATES_PAGE_URL, RateSourceError, fetchNfemTable, parseNfemTable, quoteFor } from "../src/lib/tax/cbn-rates";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/tax/cbn-nfem-rates.json", import.meta.url), "utf8")) as { rows: Record<string, string>[] };
const row = (ratedate: string, weightedAvgRate: unknown) => ({ ratedate, weightedAvgRate });
const T0 = "2026-11-27T15:00:00Z";

describe("reading the CBN NFEM list", () => {
  const table = parseNfemTable(fixture.rows);

  it("gives the real weighted average rate of a real day, exactly as CBN wrote it", () => {
    expect(table.byDate.get("2026-11-25")).toBe("1392.2481");
    expect(table.byDate.get("2026-11-26")).toBe("1387.8883");
    expect(table.byDate.get("2026-01-02")).toBe("1430.8479");
  });

  it("builds the structured quote the tax engine requires", () => {
    const q = quoteFor(table, "2026-11-25", T0);
    expect(q).toEqual({
      ok: true,
      quote: { provider: "CBN", base: "USD", quote: "NGN", date: "2026-11-25", ngnPerUnit: "1392.2481", sourceUrl: CBN_RATES_PAGE_URL, retrievedAt: T0 },
    });
    expect(CBN_RATES_PAGE_URL.startsWith("https://www.cbn.gov.ng/")).toBe(true);
  });

  it("has no rate for a Saturday or a public holiday, and says so instead of using a neighbouring day", () => {
    for (const day of ["2026-11-28", "2026-11-22", "2026-01-01"]) {
      const q = quoteFor(table, day, T0);
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.reason).toContain(day);
    }
  });

  it("accepts the dates CBN really lists twice with the same rate", () => {
    const t = parseNfemTable(fixture.rows);
    expect(t.byDate.get("2025-06-19")).toBe("1549.4193");
    expect(t.conflicting.has("2025-06-19")).toBe(false);
  });

  it("refuses a date listed twice with different rates", () => {
    const t = parseNfemTable([row("June-19-2025", "1549.4193"), row("June-19-2025", "1500.0000")]);
    expect(quoteFor(t, "2025-06-19", T0).ok).toBe(false);
  });

  it.each([["0"], ["0.0000"], ["-1387.8883"], ["1,387.88"], ["1387.1234567"], [" 1387.8883"], ["1387.8883 "], ["abc"], [""], ["1e3"], ["NaN"]])(
    "leaves a day with an unreadable rate %j without a rate",
    (bad) => {
      const t = parseNfemTable([row("November-26-2026", bad), row("November-25-2026", "1392.2481")]);
      expect(quoteFor(t, "2026-11-26", T0).ok).toBe(false);
      expect(quoteFor(t, "2026-11-25", T0).ok).toBe(true);
    },
  );

  it("leaves a day without a rate when the rate is not text (a number or null)", () => {
    const t = parseNfemTable([row("November-26-2026", 1387.8883), row("November-25-2026", null)]);
    expect(quoteFor(t, "2026-11-26", T0).ok).toBe(false);
    expect(quoteFor(t, "2026-11-25", T0).ok).toBe(false);
  });

  it.each([
    ["not a list", { rows: [] }],
    ["an empty list", []],
    ["a row that is not an object", [1]],
    ["a null row", [null]],
    ["a date in another format", [row("2026-11-26", "1387.8883")]],
    ["a month that does not exist", [row("Smarch-01-2026", "1387.8883")]],
    ["a day that does not exist", [row("February-30-2026", "1387.8883")]],
    ["no date", [{ weightedAvgRate: "1387.8883" }]],
  ])("refuses the whole list when it has %s", (_name, json) => {
    expect(() => parseNfemTable(json)).toThrow(RateSourceError);
  });
});

describe("downloading the CBN list", () => {
  const ok = (body: string, type = "application/json; charset=utf-8", status = 200) =>
    (async () => new Response(body, { status, headers: { "content-type": type } })) as never;

  it("reads a real-shaped answer from the data URL", async () => {
    let asked = "";
    const t = await fetchNfemTable((async (url: string) => {
      asked = url;
      return new Response(JSON.stringify(fixture.rows), { headers: { "content-type": "application/json; charset=utf-8" } });
    }) as never);
    expect(asked).toBe(CBN_NFEM_DATA_URL);
    expect(t.byDate.get("2026-11-25")).toBe("1392.2481");
  });

  it("refuses an HTTP error", async () => {
    await expect(fetchNfemTable(ok("{}", "application/json", 503))).rejects.toThrow(/status 503/);
  });
  it("refuses an answer that is not JSON", async () => {
    await expect(fetchNfemTable(ok("<html></html>", "text/html"))).rejects.toThrow(/JSON/);
  });
  it("refuses JSON that cannot be parsed", async () => {
    await expect(fetchNfemTable(ok("[{", "application/json"))).rejects.toThrow(RateSourceError);
  });
  it("refuses an answer much larger than the real one", async () => {
    await expect(fetchNfemTable(ok(`[${" ".repeat(5_000_001)}]`))).rejects.toThrow(/larger/);
  });
  it("says it could not reach CBN when the request fails", async () => {
    await expect(
      fetchNfemTable((async () => {
        throw new TypeError("fetch failed");
      }) as never),
    ).rejects.toThrow(/could not reach/);
  });
});
