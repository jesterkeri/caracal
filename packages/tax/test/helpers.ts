import type { FxQuote } from "../src";

/** A valid CBN statutory USD/NGN quote. */
export const cbn = (ngnPerUnit: string, date: string, over: Partial<FxQuote> = {}): FxQuote => ({
  provider: "CBN",
  base: "USD",
  quote: "NGN",
  date,
  ngnPerUnit,
  sourceUrl: "https://www.cbn.gov.ng/rates/ExchRateByCurrency.html",
  retrievedAt: `${date}T18:00:00Z`,
  ...over,
});

/** A valid market quote. */
export const mkt = (ngnPerUnit: string, date: string, over: Partial<FxQuote> = {}): FxQuote => ({
  provider: "market-feed",
  base: "USD",
  quote: "NGN",
  date,
  ngnPerUnit,
  sourceUrl: "https://rates.example.com/usd-ngn",
  retrievedAt: `${date}T18:00:00Z`,
  ...over,
});
