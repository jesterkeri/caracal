export type FxQuote = {
  provider: string;
  base: string;
  quote: "NGN";
  date: string; // YYYY-MM-DD
  ngnPerUnit: string;
  sourceUrl: string;
  retrievedAt: string; // instant with offset
};

export type LedgerEntry = {
  id: string;
  accountId: string;
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
  /** ISO instant (with offset) from which this account's history is complete. */
  coverageFrom: string;
  /** ISO instant (with offset) when the account came into existence, if known. */
  openedAt?: string;
  gaps: { from: string; to: string }[];
};

export type IncomeScope =
  | { allIncomeInLinkedAccounts: true }
  | { allIncomeInLinkedAccounts: false; otherIncomeNgn: string; otherIncomeNote?: string };

export type Profile = { annualRentNgn?: string; incomeScope: IncomeScope };

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
  valuation: RuleSource & {
    summary: string;
    basis: string;
    note: string;
    rateDateRule: string;
    statutoryProviders: { id: string; name: string; urlPrefix: string }[];
    assetBase: Record<string, string>;
    assetBaseNote: string;
  };
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
  rateProvider: string;
  ratePair: string;
  rateDate: string;
  rateSourceUrl: string;
  ruleId: string;
  ngnValue: string;
  /** How the valuation rule applies to this income (e.g. "analogy"); explained in `informational`. */
  valuationBasis: string;
  /** Ids of the `informational` notes that qualify this line's naira value. */
  assumptionIds: string[];
  economicNgnValue?: string;
  economicQuote?: { provider: string; pair: string; date: string; sourceUrl: string };
  fxGapPct?: string;
};

export type DeclaredIncomeLine = {
  label: string;
  amountNgn: string;
  source: "declared by you";
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
  kind: "stamp_duty" | "not_modelled" | "declared_income" | "fx_gap_omitted" | "valuation_basis" | "asset_assumption";
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
  declaredIncomeLines: DeclaredIncomeLine[];
  informational: Informational[];
  sources: SourceRef[];
  disclaimer: string;
};

export type EstimateResult = Estimate | Refused;
