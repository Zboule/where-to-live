// Types describing the shape of finance.config.yaml (the source of truth) and
// the output of the forecast engine. Keep these in sync with the YAML.

export type CurrencyCode = string; // e.g. "EUR", "AED", "USD"

export interface FinanceMeta {
  base_date: string; // ISO date
  base_currency: CurrencyCode;
  horizons_years: number[];
  inflation_rate: number;
  /** Your age at base_date — used only to label the retirement age in the UI. */
  base_age?: number;
}

export interface MortgageRatePeriod {
  rate: number; // annual interest rate (decimal)
  months?: number; // length of this rate period in payments; omit on the
  // final period, which runs to the end of the term.
}

/**
 * Swiss-style interest-only mortgage. The loan amortizes from `principal` DOWN TO `floor`
 * over `amortize_months` (the mandatory second-mortgage paydown, ~66% LTV in ~15 years),
 * then runs INTEREST-ONLY on the floor indefinitely — the borrower never repays the first
 * mortgage, holds the deductible debt (offsetting imputed-rent income + lowering the wealth-
 * tax base) and realises the gain on sale. Set `last_payment_date` beyond the horizon so the
 * interest-only phase runs to the end. Only used for CH homes; omit it for normal annuities.
 */
export interface InterestOnlyConfig {
  floor: number; // balance below which no principal is paid (currency). CH: ~66% of value.
  amortize_months: number; // payments to bring (principal − floor) down to the floor.
}

export interface MortgageConfig {
  principal: number;
  first_payment_date: string;
  last_payment_date: string;
  /**
   * One or more rate periods. The payment is (re)computed at the start of each
   * period to amortize the remaining balance over the remaining term — exactly
   * how a fixed-rate roll-off works in practice.
   */
  rate_periods: MortgageRatePeriod[];
  /** Swiss-style amortize-to-a-floor-then-interest-only. Omit for a plain annuity. */
  interest_only?: InterestOnlyConfig;
}

export interface HoldingCosts {
  local_property_tax?: number;
  building_maintenance?: number;
  unit_maintenance?: number;
  grows_with?: 'inflation' | 'none';
}

export interface PprConfig {
  occupied_from: string;
  occupied_until: string;
  final_period_deemed_months: number;
}

export interface CgtConfig {
  rate: number;
  annual_exemption_per_owner: number;
  owners: number;
  ppr?: PprConfig;
}

export interface SaleConfig {
  selling_costs_rate: number;
  cgt: CgtConfig;
}

export interface RentalConfig {
  active_from?: string;
  gross_per_month: number;
  rent_growth_rate: number;
  /** Average tenancy length; a new tenant arrives every this-many years. */
  average_tenancy_years: number;
  /** Void months to re-let between tenants (drives the vacancy figure). */
  vacancy_months_per_turnover: number;
  /** Letting agent "find new tenant" fee, as a % of annual rent, per turnover. */
  find_new_tenant_fee_rate: number;
  management_fee_rate: number;
  tax: {
    rate: number;
    basis: 'gross' | 'net_profit';
  };
}

/** A personal "cash loan" (e.g. a UAE salary-multiple personal loan) used to help
 *  fund a purchase. It injects no cash to the buffer — its proceeds go straight
 *  into the purchase — then amortizes out of income over `term_months`, and its
 *  outstanding balance is a liability against net worth. */
export interface CashLoanConfig {
  amount: number;
  currency?: CurrencyCode; // defaults to the property's currency
  rate: number; // annual interest (decimal), reducing-balance
  term_months: number;
}

/** A saving in living costs while the property is owned: occupying it yourself
 *  reduces what you'd otherwise spend (Paris/Yerevan trips offset travel; an Abu
 *  Dhabi home offsets the rent you stop paying). Reduces total expenses. */
export interface SelfUseSaving {
  per_year: number;
  currency?: CurrencyCode; // defaults to the property's currency
  grows_with?: 'inflation' | 'none';
}

export interface RealEstateConfig {
  id: string;
  name: string;
  country: string;
  currency: CurrencyCode;
  current_value: number;
  appreciation_rate: number;
  /** Whether this property is part of the forecast by default. New "what-if"
   *  options ship `false` (off) and are switched on in the UI. Default true. */
  enabled?: boolean;
  /** Ownership start. Omitted/past => already owned at base_date (value =
   *  current_value). A FUTURE date models a purchase: the property is off the
   *  books until then, when the down payment + acquisition costs flow out of
   *  cash/investments and its value starts from `purchase.price`. */
  owned_from?: string;
  /** Sale date. On this date the property's net proceeds (value − mortgage −
   *  selling costs − CGT) are realized into cash, and it leaves the books. Models
   *  e.g. selling an existing property to fund a new purchase. */
  sold_on?: string;
  purchase: {
    price: number;
    date: string;
    acquisition_costs?: number;
  };
  mortgage: MortgageConfig;
  /** Optional personal loan that part-funds the purchase (amortized from income). */
  cash_loan?: CashLoanConfig;
  /** Living-cost saving from occupying the property yourself (offsets travel/rent). */
  self_use_saving?: SelfUseSaving;
  holding_costs?: HoldingCosts;
  sale?: SaleConfig;
  /** The property and its rent are one entity — rental income lives here. */
  rental?: RentalConfig;
  /** Investment id that this property's surplus cash flow is reinvested into. */
  reinvest_surplus_to?: string;
  /** Documented actual value track (date -> value). Reference only; the
   *  forecast uses current_value + appreciation_rate. */
  value_history?: Record<string, number>;
}

export interface InvestmentConfig {
  id: string;
  name: string;
  currency: CurrencyCode;
  opening_balance: number;
  expected_return: number;
  // Per-CALENDAR-YEAR annual return overrides, e.g. { 2029: -0.28 } to model
  // market drawdowns. Years not listed use `expected_return`.
  return_overrides?: Record<number, number>;
  gains_tax_rate?: number;
  receives_savings?: boolean;
}

/**
 * One segment of a salary's evolution, starting at a calendar year. The gross
 * resets to `gross_per_year` that year, then grows at `growth_rate` until the
 * next segment. This models non-linear progression (promotions, plateaus, cuts).
 */
export interface SalarySegment {
  year: number;
  gross_per_year: number;
  growth_rate: number;
}

export interface SalaryIncome {
  id: string;
  name: string;
  type: 'salary';
  currency: CurrencyCode;
  tax_rate: number;
  /** Piecewise salary schedule (preferred). The first segment is the current pay. */
  growth?: SalarySegment[];
  // --- simple form (used when `growth` is absent) ---
  gross_per_year?: number;
  growth_rate?: number;
  /** Raises apply for this many years; afterwards salary grows with inflation. */
  growth_years?: number;
}

export interface GenericIncome {
  id: string;
  name: string;
  type: 'generic';
  currency: CurrencyCode;
  net_per_year?: number;
  gross_per_year?: number;
  tax_rate?: number;
  growth_rate?: number;
  active_from?: string;
}

/** A salary that auto-sizes each month to whatever is needed to cover living costs after
 *  all OTHER income (e.g. rent) — so it leaves no operating surplus and no operating
 *  shortfall. Used post-relocation: the local job just covers life, and the whole housing
 *  cost is left to draw down the portfolio. Net = max(0, living − other net income);
 *  gross is grossed up for `tax_rate`. */
export interface DynamicSalaryIncome {
  id: string;
  name: string;
  type: 'dynamic';
  currency: CurrencyCode;
  /** Country whose PROGRESSIVE tax brackets gross up the computed net (NL / AT / CH).
   *  Preferred over `tax_rate` — the effective rate then tracks the salary's actual size. */
  country?: string;
  /** Flat fallback rate, used only when `country` is absent. */
  tax_rate?: number;
  active_from?: string;
}

/** A software-engineer salary for the post-relocation period: a FIXED gross sized from the
 *  destination country, the chosen tier and your experience-by-year (see swe.ts). Unlike the
 *  dynamic salary it doesn't auto-shrink to living — it's a real market wage, so the surplus
 *  (or shortfall vs the home) shows up in the portfolio. Country falls back to the home's. */
export interface SweSalaryIncome {
  id: string;
  name: string;
  type: 'swe';
  tier: 'average' | 'top';
  currency: CurrencyCode;
  country?: string; // NL / AT / CH — else taken from the relocation home
  active_from?: string;
}

export type IncomeConfig = SalaryIncome | GenericIncome | DynamicSalaryIncome | SweSalaryIncome;

/** One segment of an expense's evolution, starting at a calendar year. */
export interface ExpenseSegment {
  year: number;
  per_month?: number;
  per_year?: number;
  growth_rate: number;
}

export interface ExpenseConfig {
  id: string;
  name: string;
  currency: CurrencyCode;
  category?: string;
  /** Piecewise schedule (preferred): start year, amount, growth, step changes. */
  growth?: ExpenseSegment[];
  // --- simple form (used when `growth` is absent) ---
  per_year?: number;
  per_month?: number;
  grows_with?: 'inflation' | 'none';
  active_from?: string;
}

export interface CashConfig {
  opening_balance: number;
  target_buffer_months: number;
  interest_rate: number;
  currency?: CurrencyCode; // defaults to base currency
  /** The headline `interest_rate` applies only up to this balance; the part above
   *  earns `excess_interest_rate` (e.g. a UAE high-yield account capped at AED 1M). */
  interest_cap?: number;
  interest_cap_currency?: CurrencyCode; // defaults to the cash currency
  excess_interest_rate?: number; // rate on the balance above the cap (default 0)
}

/**
 * A dynamic retirement / relocation plan. The engine simulates accumulation, and
 * the moment investable assets can fund the move (buy the home + a nest egg that
 * sustains the destination spend at `safe_withdrawal_rate`), it RETIRES: salary
 * stops, the listed properties are sold, the home is bought, expenses switch to
 * the destination set, and the destination wealth tax kicks in. The retirement
 * DATE is therefore an output — change income/expenses and it moves automatically.
 */
export interface RetirementConfig {
  enabled?: boolean;
  /** Earliest calendar year retirement may trigger (e.g. kids/vesting runway). */
  not_before?: number;
  /** Force retirement by this year even if the target isn't met. */
  not_after?: number;
  /** Safe withdrawal rate used to size the nest egg: needed = spend / swr.
   *  Choose it to already absorb the destination wealth tax + sequence risk. */
  safe_withdrawal_rate: number;
  /** Extra liquid buffer kept on top of the home + nest egg, in years of spend. */
  buffer_years?: number;
  /** Destination wealth tax on the investment portfolio after the move (Dutch Box 3). */
  wealth_tax?: { rate: number; threshold?: number; currency?: CurrencyCode };
  /** Existing property ids to sell on retirement to fund the move. */
  sell_on_retirement?: string[];
  /** The home bought on retirement (owned from the dynamic retirement month). */
  home: RealEstateConfig;
  /** Destination living expenses (the retirement lifestyle), used once retired. */
  expenses: ExpenseConfig[];
}

/**
 * A recurring net-wealth tax on the financial portfolio (Dutch Box 3, Swiss
 * cantonal wealth tax, …), applied monthly to the portfolio above `threshold`
 * from `active_from`. Real estate is OUTSIDE the base — the engine taxes only the
 * investment portfolio (`invBalances`) — so foreign property (e.g. the Yerevan
 * complex) and the primary home naturally escape it. Used by relocation scenarios,
 * where the household keeps working (so it can't ride on the FIRE `retired` flag
 * the way `retirement.wealth_tax` does).
 */
export interface WealthTaxConfig {
  rate: number;
  threshold?: number;
  currency?: CurrencyCode;
  /** Applies from this date onward (e.g. the relocation date). Omit => from base_date. */
  active_from?: string;
  /** Label for the expenses breakdown (defaults to "Wealth tax (Box 3)"). */
  label?: string;
}

/**
 * A DYNAMIC relocation plan. Unlike a fixed-date move, the relocation date is an
 * OUTPUT: the engine simulates the UAE-phase accumulation and, the first year the
 * equities book can (a) fund the home's down payment AND (b) sustain its yearly
 * mortgage + the self-funded wealth tax from returns alone — so the portfolio doesn't
 * lose value once housing draws on it, even if no more capital is added — it relocates
 * the NEXT year: the UAE salary + UAE expenses stop, the local (dynamic) salary +
 * destination expenses start, and the home is bought. Change the equity return, the
 * starting capital, the property price, the mortgage rate/duration — the move date
 * recomputes automatically.
 */
export interface RelocationConfig {
  enabled: boolean;
  /** Fixed move year (the "Relocate 2030 / 2032" presets). When set, the move lands on
   *  Jan 1 of this year and the dynamic equity trigger is skipped. Omit => dynamic. */
  fixed_move_year?: number;
  /** Earliest calendar year the inflexion may trigger (kids/career runway floor). */
  not_before?: number;
  /** Force the move by this year even if the equities can't yet sustain it. */
  not_after?: number;
  /** Property id (in assets.real_estate) bought AT the move; its price + mortgage drive the trigger. */
  homeId: string;
  /** Income id of the local (dynamic) salary that switches ON at the move; every other income switches OFF. */
  localIncomeId: string;
  /** Expenses whose id starts with this prefix are the destination lifestyle (start at the move);
   *  every other expense is pre-move (stops at the move). */
  postMoveExpensePrefix?: string;
  /** ...or list the post-move expense ids explicitly (takes precedence over the prefix). */
  postMoveExpenseIds?: string[];
  /** "Auto FIRE": trigger the move only once the portfolio yield + net rent can cover the FULL
   *  post-move outflow (living + the home's mortgage/holding/wealth tax), so NO local salary is
   *  needed — and suppress the local income post-move. Default (Auto) only requires the yield to
   *  sustain the HOME, with the local salary still covering living. */
  fire?: boolean;
}

export interface FinanceConfig {
  meta: FinanceMeta;
  fx_rates: Record<string, number>;
  assets: {
    real_estate?: RealEstateConfig[];
    investments?: InvestmentConfig[];
  };
  cash?: CashConfig;
  incomes?: IncomeConfig[];
  expenses?: ExpenseConfig[];
  retirement?: RetirementConfig;
  /** A standalone wealth tax independent of the FIRE trigger (relocation scenarios). */
  wealth_tax?: WealthTaxConfig;
  /** A dynamic, equity-triggered relocation plan (the move date is an output). */
  relocation?: RelocationConfig;
}

// ----------------------------- engine output ------------------------------

/** A per-property snapshot at a point in time, all in base currency. */
export interface PropertyPoint {
  id: string;
  name: string;
  marketValue: number;
  mortgageBalance: number;
  grossEquity: number; // marketValue - mortgageBalance
  cgt: number; // tax due if sold now
  sellingCosts: number;
  netEquity: number; // what you'd walk away with after costs + CGT + loan
}

/** A per-investment snapshot at a point in time, in base currency. */
export interface InvestmentPoint {
  id: string;
  name: string;
  balance: number; // gross balance
  netBalance: number; // after residual gains tax
}

/** One month of the simulation, everything in base currency. */
export interface ForecastPoint {
  date: string; // ISO, first of month
  monthIndex: number;
  yearsElapsed: number;
  // flows during this month
  incomeNet: number;
  expenses: number;
  mortgagePayment: number;
  holdingCosts: number;
  netCashFlow: number; // before allocation between cash and investments
  // stocks at end of month
  properties: PropertyPoint[];
  investments: InvestmentPoint[];
  propertyNetEquity: number;
  investmentsNet: number;
  cash: number; // liquid buffer (can go negative => warning)
  cashLoanBalance: number; // outstanding personal cash-loan debt (liability)
  netWorth: number; // propertyNetEquity + investmentsNet + cash - cashLoanBalance
}

/** A net-worth snapshot at one of the configured horizons. */
export interface HorizonSummary {
  years: number;
  date: string;
  netWorth: number;
  propertyNetEquity: number;
  investmentsNet: number;
  cash: number;
}

/**
 * One year of a real-estate investment, all flows summed over the year and
 * all stocks snapshotted at year end. Base currency.
 */
export interface RealEstateYear {
  date: string; // ISO, year-end month within the forecast
  year: number; // whole years from base_date (0 = first forecast year)
  // --- annual flows (revenue) ---
  rentGross: number; // contractual rent for the year
  vacancyLoss: number; // rent lost to void months (>= 0)
  managementFee: number; // ongoing management fee (>= 0)
  lettingFee: number; // find-new-tenant fee, annualized over turnover (>= 0)
  rentalTax: number; // income tax on the rent (>= 0)
  rentNet: number; // rentGross - vacancy - mgmt - letting - tax
  // --- annual flows (costs) ---
  mortgageInterest: number;
  mortgagePrincipal: number;
  mortgagePayment: number; // interest + principal
  holdingCosts: number;
  // --- the headline: cash in/out for the year ---
  cashFlow: number; // rentNet - mortgagePayment - holdingCosts (signed)
  capitalInjected: number; // max(0, -cashFlow): cash you must put in
  distribution: number; // max(0, cashFlow): cash it returns to you
  cumulativeCapitalInjected: number; // running sum from base_date
  // --- stocks at year end (residual value if sold) ---
  marketValue: number;
  mortgageBalance: number;
  grossEquity: number;
  sellingCosts: number;
  cgt: number;
  cgtGain: number; // chargeable gain before reliefs
  cgtPprExemptFraction: number; // 0..1 of the gain exempt via PPR (years lived in)
  cgtPprExemptAmount: number; // gain * fraction
  residualValue: number; // marketValue - mortgageBalance - sellingCosts - cgt
  // --- how the residual value grew vs last year (sums to residualValue) ---
  newCapital: number; // equity injected to acquire it (purchase year only — the down-payment equity)
  /** Where that injected capital came from (sold properties, the portfolio, cash). */
  newCapitalSources?: { label: string; amount: number }[];
  /** Cash actually drawn to BUY it in the purchase year: down payment + acquisition
   *  costs, less any personal loan. Bigger than newCapital; 0 outside the purchase year. */
  purchaseCashOut: number;
  equityFromSalary: number; // mortgage principal paid down from external funds (income + cash + portfolio)
  equityFromIncome: number; // ...of which the income-surplus share (salary that covered the home)
  equityFromCash: number; // ...the cash-buffer-interest share (buffer interest routed to the home)
  equityFromPortfolio: number; // ...and the portfolio-withdrawal share (equities drawn for the home)
  equityFromRent: number; // mortgage principal paid down out of rent
  valueGrowth: number; // appreciation, net of the CGT/selling-cost drag
}

export interface RealEstateReport {
  id: string;
  name: string;
  currency: CurrencyCode;
  /** Equity already in the property at base_date (residual value today). */
  openingResidualValue: number;
  yearly: RealEstateYear[];
}

/** One year of a financial investment portfolio (base currency). */
export interface InvestmentYear {
  date: string;
  year: number;
  openingBalance: number;
  contribution: number; // net cash added this year (negative if liquidated)
  contributionFromSalary: number; // of the contribution, the part from salary savings
  contributionFromProperty: number; // of the contribution, the part from property distributions
  contributionFromCash: number; // of the contribution, the part swept in from the cash buffer
  savedFromIncome: number; // operating surplus (salary − living) saved into this portfolio
  withdrawnForHome: number; // portfolio drawn to fund properties' CAPITAL INJECTED (mortgage interest + holding + principal − rent) + any down payment
  withdrawnForLiving: number; // portfolio drawn to cover LIVING the salary + rental distributions didn't
  withdrawnForHomeLabel?: string; // name of the property the withdrawal bought, if any
  withdrawnForHomeByProperty?: { name: string; amount: number }[]; // the home draw split per property (sums to withdrawnForHome)
  growth: number; // investment return this year
  wealthTax: number; // wealth tax this portfolio self-funded (drew from itself) this year
  realisedGainsTax: number; // CGT realised on this year's post-move drawdowns (self-funded)
  balance: number; // gross balance at year end
  gainsTax: number; // residual tax if liquidated at year end
  netBalance: number; // balance - gainsTax
  cumulativeContribution: number;
}

export interface InvestmentReport {
  id: string;
  name: string;
  currency: CurrencyCode;
  openingBalance: number;
  yearly: InvestmentYear[];
  wealthTaxLabel?: string; // label for the self-funded wealth tax shown on the chart (e.g. "Wealth tax (Box 3)")
}

/** One year of household income and where it goes (base currency). */
export interface HouseholdYear {
  date: string;
  year: number;
  salaryGross: number;
  salaryTax: number; // income tax on salary (0 in the UAE)
  salaryNet: number;
  expenses: number; // cost of living
  housingCosts: number; // home CONSUMPTION: mortgage interest + holding + acquisition fees (a cost, not equity)
  wealthTax: number; // destination wealth tax (Box 3), once retired
  gainsTax: number; // realised capital-gains tax on a post-move equity drawdown (0 pre-move / NL / CH)
  investmentReturns: number; // investment growth this year (all portfolios)
  investableEnd: number; // cash + net investments at year end (for the income chart)
  realEstateFunding: number; // cash the property needs (= mortgage + holding - net rent); negative when it distributes
  // netSaved un-collapsed: the income statement (salary − living) vs the housing flow
  // (rent + sale − mortgage − holding − loan − purchase). operatingFlow + propertyFlow = netSaved.
  operatingFlow: number; // salary + self-use − living costs; positive = surplus saved to the portfolio
  propertyFlow: number; // property cash; negative = the housing draw funded from the portfolio
  netSaved: number; // salaryNet - expenses - realEstateFunding
  toCash: number; // of netSaved, how much topped up the cash buffer
  toInvestments: number; // of netSaved, how much was invested
  // toCash decomposed (toCash = cashFromIncome + cashFromInvest − cashToExpenses − cashToInvest):
  cashFromIncome: number; // operating surplus that topped up the buffer
  cashFromInvest: number; // investments liquidated to refill the buffer (deficit years)
  cashToExpenses: number; // buffer drawn down to cover a spending shortfall
  cashToInvest: number; // excess buffer swept into the savings portfolio
}

/** One year of the living-expenses breakdown (base currency). */
export interface ExpenseItemYear {
  id: string;
  name: string;
  category: string;
  amount: number;
}
export interface ExpenseYear {
  date: string;
  year: number;
  total: number;
  items: ExpenseItemYear[];
}
export interface ExpensesReport {
  categories: string[];
  yearly: ExpenseYear[];
}

export interface ForecastResult {
  baseDate: string;
  baseCurrency: string;
  /** Opening snapshot at base_date (month 0). */
  today: ForecastPoint;
  /** Full monthly series (month 1..N). */
  monthly: ForecastPoint[];
  /** Annual snapshots including today: index k ≈ base_date + k years. */
  yearly: ForecastPoint[];
  /** Per real-estate investment, a yearly capital/residual-value report. */
  realEstate: RealEstateReport[];
  /** Per financial investment portfolio, a yearly contribution/growth report. */
  investments: InvestmentReport[];
  /** Yearly household income and where it goes. */
  household: HouseholdYear[];
  /** Yearly living-expenses breakdown by line item. */
  expenses: ExpensesReport;
  horizons: HorizonSummary[];
  /** When the dynamic retirement trigger fired (ISO month), or null if never. */
  retirementDate: string | null;
  /** When the dynamic relocation move fired (ISO month = the purchase/switch date), or null. */
  relocationDate: string | null;
  warnings: string[];
}
