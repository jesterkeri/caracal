export type FxQuote = {
  ngnPerUnit: string;
  source: string;
  sourceUrl?: string;
  date: string; // YYYY-MM-DD
};

export type LedgerEntry = {
  id: string;
  txHash: string;
  occurredAt: string;
  direction: "in" | "out";
  kind: "income" | "own_transfer" | "cashout" | "split_internal" | "refund" | "other";
  asset: string;
  amount: string; // decimal, up to 7 dp
  fx: { statutory: FxQuote | null; economic: FxQuote | null };
};

export type Account = {
  id: string;
  label: string;
  lastSyncedAt: string;
  gaps: { from: string; to: string }[];
};

export type Profile = { annualRentNgn?: string };

export type EstimateInput = {
  country: "NG";
  taxYear: number;
  asOf: string;
  entries: LedgerEntry[];
  accounts: Account[];
  profile: Profile;
  staleAfterHours?: number;
};

export type Confidence = "primary" | "secondary" | "single_secondary";

export type RuleSource = {
  id: string;
  citation: string;
  url: string;
  confidence: Confidence;
  verifiedOn: string;
};

export type Rules = {
  country: string;
  year: number;
  currency: string;
  timezoneOffset: string;
  pit: RuleSource & {
    bands: { id: string; from: string; to: string | null; rate: string }[];
  };
  rentRelief: RuleSource & { rate: string; capNgn: string };
  virtualAssetIncome: RuleSource & { summary: string };
  valuation: RuleSource & { summary: string; basis: string; note: string };
  stampDuty: RuleSource & { rate: string; summary: string; additionalUrls: string[] };
  notModelled: { id: string; title: string; reason: string }[];
};

export type SourceRef = {
  ruleId: string;
  citation: string;
  url: string;
  confidence: Confidence;
};

export type Refused = {
  status: "refused";
  reasons: string[];
  disclaimer: string;
};

export type IncomeLine = {
  entryId: string;
  txHash: string;
  amount: string;
  asset: string;
  ngnPerUnit: string;
  rateSource: string;
  ruleId: string;
  ngnValue: string;
  economicNgnValue?: string;
  fxGapPct?: string;
};

export type BandResult = {
  from: string;
  to: string | null;
  rate: string;
  taxableInBand: string;
  taxInBand: string;
  ruleId: string;
};

export type Informational = {
  kind: "stamp_duty" | "not_modelled" | "rate_date";
  id: string;
  message: string;
};

export type Estimate = {
  status: "ok";
  taxYear: number;
  currency: "NGN";
  grossIncomeNgn: string;
  reliefs: { ruleId: string; label: string; amountNgn: string }[];
  taxableIncomeNgn: string;
  bands: BandResult[];
  totalTaxNgn: string;
  effectiveRate: string;
  incomeLines: IncomeLine[];
  informational: Informational[];
  sources: SourceRef[];
  disclaimer: string;
};

export type EstimateResult = Estimate | Refused;
