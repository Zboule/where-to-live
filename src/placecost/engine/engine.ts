// Pure monthly forecast engine. Given the config, simulate month-by-month from
// meta.base_date to the furthest horizon, then snapshot net worth at each
// horizon. No I/O, no React — just math, so it's easy to test and reason about.
//
// This is the "API" / domain layer. Every assumption lives in the config that
// is passed in; nothing about the initial state is hard-coded here.

import type {
  FinanceConfig,
  ForecastPoint,
  ForecastResult,
  HorizonSummary,
  HouseholdYear,
  InvestmentConfig,
  InvestmentPoint,
  InvestmentReport,
  InvestmentYear,
  MortgageConfig,
  MortgageRatePeriod,
  PropertyPoint,
  RealEstateConfig,
  RealEstateReport,
  RealEstateYear,
  SalaryIncome,
  GenericIncome,
  DynamicSalaryIncome,
  SweSalaryIncome,
  ExpenseConfig,
  ExpenseSegment,
  ExpensesReport,
} from './types';
import { equityCgtRate, grossForNet, isTaxCountry, taxForGross } from './tax';
import { sweGrossSalary } from './swe';

/** Internal: one month of a single property's economics (base currency). */
interface PropMonthRec {
  monthIndex: number;
  date: string;
  rentGross: number;
  vacancyLoss: number;
  managementFee: number;
  lettingFee: number;
  rentalTax: number;
  rentNet: number;
  mortgageInterest: number;
  mortgagePrincipal: number;
  mortgagePayment: number;
  holdingCosts: number;
  marketValue: number;
  mortgageBalance: number;
  sellingCosts: number;
  cgt: number;
  cgtGain: number;
  cgtPprExemptFraction: number;
  cgtPprExemptAmount: number;
  residualValue: number;
}

interface HouseMonth {
  salaryGross: number;
  salaryTax: number;
  salaryNet: number;
  expenses: number;
  housingCosts: number; // mortgage interest + holding + acquisition fees (home CONSUMPTION)
  wealthTax: number;
  gainsTax: number; // realised capital-gains tax on a post-move portfolio drawdown (all portfolios)
  investGrowth: number; // investment returns this month (all portfolios)
  mortgage: number;
  holding: number;
  rentNet: number;
  // netCashFlow, un-collapsed into the two flows that drive the equity:
  operatingFlow: number; // salary + self-use − living costs (the income statement)
  propertyFlow: number; // rent + sale − mortgage − holding − loan − purchase (housing cash)
  netCashFlow: number;
  toCash: number;
  toInvest: number;
  // toCash, decomposed by source/destination (toCash = in − out):
  cashFromIncome: number; // operating surplus topped into the buffer (+)
  cashFromInvest: number; // investments liquidated to refill the buffer (+)
  cashToExpenses: number; // buffer drawn down to cover a spending shortfall (−)
  cashToInvest: number; // excess buffer swept into investments (−)
}

interface InvMonth {
  growth: number;
  contribution: number;
  contributionSalary: number;
  contributionProperty: number;
  wealthTax: number; // wealth tax this portfolio paid out of itself this month
  gainsTax: number; // realised capital-gains tax this portfolio paid on a post-move drawdown
  balance: number;
}

// ----------------------------- date helpers -------------------------------

function parseISO(d: string): Date {
  // Treat as UTC midnight to avoid timezone drift across month boundaries.
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, (m ?? 1) - 1, day ?? 1));
}

function addMonths(date: Date, n: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + n, date.getUTCDate()));
}

/** Whole months between two dates (a <= b), rounded down. */
function monthsBetween(a: Date, b: Date): number {
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function isoMonth(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function isSameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

function annualToMonthlyRate(annual: number): number {
  // Effective monthly rate so that (1+m)^12 = 1+annual.
  return Math.pow(1 + annual, 1 / 12) - 1;
}

// --------------------------- mortgage helpers -----------------------------

/** Level monthly payment that amortizes `balance` over `n` payments at `r`/mo. */
function annuity(balance: number, monthlyRate: number, n: number): number {
  if (n <= 0) return balance;
  if (monthlyRate === 0) return balance / n;
  return (balance * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -n));
}

export interface MortgageState {
  balance: number;
  interestThisMonth: number;
  principalThisMonth: number;
  payment: number;
}

/**
 * Amortization state after `paymentsElapsed` payments, supporting multiple rate
 * periods. At the start of each period the payment is recomputed to clear the
 * remaining balance over the remaining term — i.e. a fixed rate rolling onto a
 * revert rate. Returns the balance and the most recent payment's interest/principal.
 */
function amortizeSchedule(
  principal: number,
  periods: MortgageRatePeriod[],
  totalPayments: number,
  paymentsElapsed: number,
  floor = 0, // Swiss interest-only: principal stops amortizing at this balance.
  amortizeMonths?: number, // payments over which (principal − floor) is repaid; defaults to the full term.
): MortgageState {
  const amortTerm = amortizeMonths ?? totalPayments;
  let balance = principal;
  let remaining = totalPayments;
  let amortLeft = amortTerm; // payments left in the amortizing phase
  let made = 0;
  let curInterest = 0;
  let curPrincipal = 0;
  let curPayment = 0;
  const target = Math.min(Math.max(0, paymentsElapsed), totalPayments);

  for (let pi = 0; pi < periods.length && made < target && balance > 1e-6; pi++) {
    const isLast = pi === periods.length - 1;
    const r = periods[pi].rate / 12;
    const segLen = isLast ? remaining : Math.min(periods[pi].months ?? remaining, remaining);
    for (let i = 0; i < segLen && made < target && balance > 1e-6; i++) {
      const interest = balance * r;
      // Only the slice ABOVE the floor amortizes. Once the slice (or its term) is gone the
      // loan is interest-only on the floor. With floor=0 & amortLeft=remaining this is the
      // plain annuity (annuity(slice,r,amortLeft) === annuity(balance,r,remaining)).
      const slice = Math.max(0, balance - floor);
      const amortPay = amortLeft > 0 && slice > 1e-6 ? annuity(slice, r, amortLeft) : 0;
      const principalPaid = Math.min(Math.max(0, amortPay - slice * r), slice);
      balance -= principalPaid;
      made++;
      remaining--;
      if (amortLeft > 0) amortLeft--;
      curInterest = interest;
      curPrincipal = principalPaid;
      curPayment = interest + principalPaid;
    }
  }

  // A floored loan is never "paid off" within the horizon — it sits interest-only on the floor.
  const paidOff = balance <= 1e-6 || (floor <= 1e-6 && made >= totalPayments);
  return {
    balance,
    interestThisMonth: paidOff ? 0 : curInterest,
    principalThisMonth: paidOff ? 0 : curPrincipal,
    payment: paidOff ? 0 : curPayment,
  };
}

/** Mortgage state as of a calendar date, from first/last payment dates.
 *  Exported for the place-cost explorer (placeCost.ts) — same math, one owner. */
export function mortgageAt(m: MortgageConfig, asOfDate: Date): MortgageState {
  const first = parseISO(m.first_payment_date);
  const last = parseISO(m.last_payment_date);
  const totalPayments = monthsBetween(first, last) + 1;
  const paymentsElapsed = monthsBetween(first, asOfDate);
  return amortizeSchedule(m.principal, m.rate_periods, totalPayments, paymentsElapsed,
    m.interest_only?.floor ?? 0, m.interest_only?.amortize_months);
}

// ------------------------------- CGT (Irish PPR) --------------------------

/**
 * Irish Capital Gains Tax due if the property is sold on `saleDate`.
 * gain = sale - sellingCosts - (purchasePrice + acquisitionCosts)
 * PPR-exempt fraction = (occupied months + deemed-last-N) / total ownership.
 * CGT = rate * max(0, gain - exemptGain - annualExemptions).
 */
interface CgtDetail {
  cgt: number; // tax due (property currency)
  gain: number; // chargeable gain before reliefs
  pprExemptFraction: number; // 0..1 share of the gain exempt via PPR relief
  pprExemptAmount: number; // gain * fraction
}

function computeCgt(
  re: RealEstateConfig,
  saleValue: number,
  sellingCosts: number,
  saleDate: Date,
): CgtDetail {
  const sale = re.sale;
  const costBase = re.purchase.price + (re.purchase.acquisition_costs ?? 0);
  const gain = saleValue - sellingCosts - costBase;
  if (!sale || gain <= 0) return { cgt: 0, gain: Math.max(0, gain), pprExemptFraction: 0, pprExemptAmount: 0 };

  const cgt = sale.cgt;
  let pprExemptFraction = 0;
  if (cgt.ppr) {
    const purchaseDate = parseISO(re.purchase.date);
    const occFrom = parseISO(cgt.ppr.occupied_from);
    const occUntil = parseISO(cgt.ppr.occupied_until);
    const ownershipMonths = Math.max(1, monthsBetween(purchaseDate, saleDate));
    const occupiedMonths = monthsBetween(occFrom, occUntil);
    // Last N months are always treated as occupied (if it was ever the PPR),
    // but don't double-count months already inside the occupied period.
    const vacantTail = Math.max(0, ownershipMonths - occupiedMonths);
    const deemed = Math.min(cgt.ppr.final_period_deemed_months, vacantTail);
    const exemptMonths = Math.min(ownershipMonths, occupiedMonths + deemed);
    pprExemptFraction = exemptMonths / ownershipMonths;
  }
  const pprExemptAmount = gain * pprExemptFraction;

  const annualExemption = cgt.annual_exemption_per_owner * cgt.owners;
  const taxable = Math.max(0, gain - pprExemptAmount - annualExemption);
  return { cgt: taxable * cgt.rate, gain, pprExemptFraction, pprExemptAmount };
}

// ------------------------------ salary schedule ---------------------------

/**
 * Gross salary for each forecast year (1..totalYears), in the income's currency.
 * Forecast year y is labelled `baseYear + y`. With a `growth` schedule, the
 * active segment for that label year sets the gross, grown at its rate since the
 * segment started. Without one, the simple `gross_per_year`/`growth_rate` is used
 * (raises taper to inflation after `growth_years`).
 */
function buildSalarySchedule(s: SalaryIncome, baseYear: number, totalYears: number, inflation: number): number[] {
  const segs = s.growth?.length ? [...s.growth].sort((a, b) => a.year - b.year) : null;
  const out: number[] = [0];
  for (let y = 1; y <= totalYears; y++) {
    const label = baseYear + y - 1; // forecast year 1 = the base year itself
    let gross: number;
    if (segs) {
      let seg = segs[0];
      for (const sg of segs) if (sg.year <= label) seg = sg;
      gross = seg.gross_per_year * Math.pow(1 + (seg.growth_rate ?? 0), Math.max(0, label - seg.year));
    } else {
      const base = s.gross_per_year ?? 0;
      const rate = s.growth_rate ?? 0;
      const steps = y - 1; // base year (y=1) has no growth applied yet
      const raiseYears = s.growth_years == null ? steps : Math.min(steps, s.growth_years);
      const inflationYears = Math.max(0, steps - (s.growth_years ?? steps));
      gross = base * Math.pow(1 + rate, raiseYears) * Math.pow(1 + inflation, inflationYears);
    }
    out[y] = gross;
  }
  return out;
}

/**
 * Expense for each forecast year (1..totalYears), in the expense's currency.
 * Same model as the salary: the active `growth` segment for the label year sets
 * the amount (grown at its rate since it started); before the first segment the
 * expense is 0 (not yet active). Falls back to the simple per_year/per_month.
 */
export function buildExpenseSchedule(e: ExpenseConfig, baseYear: number, totalYears: number, inflation: number): number[] {
  const segs = e.growth?.length ? [...e.growth].sort((a, b) => a.year - b.year) : null;
  const out: number[] = [0];
  for (let y = 1; y <= totalYears; y++) {
    const label = baseYear + y - 1; // forecast year 1 = the base year itself
    let amount = 0;
    if (segs) {
      let seg: ExpenseSegment | null = null;
      for (const sg of segs) if (sg.year <= label) seg = sg;
      if (seg) {
        const annual = seg.per_year ?? (seg.per_month ?? 0) * 12;
        amount = annual * Math.pow(1 + (seg.growth_rate ?? 0), Math.max(0, label - seg.year));
      }
    } else {
      const startYear = e.active_from ? parseISO(e.active_from).getUTCFullYear() : baseYear;
      if (label >= startYear) {
        const annual = e.per_year ?? (e.per_month ?? 0) * 12;
        amount = annual * (e.grows_with === 'inflation' ? Math.pow(1 + inflation, label - baseYear) : 1);
      }
    }
    out[y] = amount;
  }
  return out;
}

// --------------------------------- engine ---------------------------------

export function runForecast(cfg: FinanceConfig, maxYears?: number): ForecastResult {
  const warnings: string[] = [];
  const baseDate = parseISO(cfg.meta.base_date);
  const baseCcy = cfg.meta.base_currency;
  const toBase = (amount: number, currency: string): number => {
    const rate = cfg.fx_rates[currency];
    if (rate == null) {
      warnings.push(`Missing fx_rate for ${currency}; treated as 0.`);
      return 0;
    }
    return amount * rate;
  };

  const configHorizons = [...cfg.meta.horizons_years].sort((a, b) => a - b);
  // The dashboard can override how many years to project (the horizon selector).
  const maxY = Math.max(1, Math.round(maxYears ?? Math.max(...configHorizons)));
  const horizonsYears = [...new Set([...configHorizons.filter((h) => h <= maxY), maxY])].sort((a, b) => a - b);
  const totalMonths = maxY * 12;
  const totalYears = maxY;
  const inflationM = annualToMonthlyRate(cfg.meta.inflation_rate);
  const baseYear = baseDate.getUTCFullYear();
  // Forecast year y (1..N) represents calendar year `baseYear + y - 1` — year 1
  // IS the base year. Yearly reports are labelled by that calendar year's start,
  // so the charts (which format the date as YYYY) read 2026, 2027, …
  const yearStartDate = (y: number) => isoMonth(addMonths(baseDate, (y - 1) * 12));

  // Retirement plan (optional). The home is appended as a property bought on the
  // DYNAMIC retirement date; the listed properties are sold then to fund the move.
  const retCfg = cfg.retirement?.enabled ? cfg.retirement : undefined;
  const homeRe = retCfg ? { ...retCfg.home } : undefined;
  const homeId = homeRe?.id;
  const sellOnRetirement = new Set(retCfg?.sell_on_retirement ?? []);
  const realEstate = homeRe ? [...(cfg.assets.real_estate ?? []), homeRe] : (cfg.assets.real_estate ?? []);
  const investments = cfg.assets.investments ?? [];
  const incomes = cfg.incomes ?? [];
  const expenses = cfg.expenses ?? [];

  // Precompute each salary's gross-per-year for every forecast year (stepwise
  // raises + promotions). Indexed [1..totalYears], in the income's currency.
  const salarySchedules = new Map<string, number[]>();
  for (const inc of incomes) {
    if (inc.type === 'salary') {
      salarySchedules.set(inc.id, buildSalarySchedule(inc, baseYear, totalYears, cfg.meta.inflation_rate));
    }
  }

  // Per-expense yearly schedule, converted to base currency.
  const expenseSchedules = expenses.map((e) => ({
    e,
    schedule: buildExpenseSchedule(e, baseYear, totalYears, cfg.meta.inflation_rate).map((v) => toBase(v, e.currency)),
  }));

  // ---- Retirement plan precompute ----
  // Destination (e.g. Amsterdam) living-cost schedule + its annual total (base ccy).
  const retExpenseSchedules = (retCfg?.expenses ?? []).map((e) => ({
    e,
    schedule: buildExpenseSchedule(e, baseYear, totalYears, cfg.meta.inflation_rate).map((v) => toBase(v, e.currency)),
  }));
  const retSpendByYear: number[] = [0];
  for (let y = 1; y <= totalYears; y++) {
    retSpendByYear[y] = retExpenseSchedules.reduce((s, { schedule }) => s + (schedule[y] ?? 0), 0);
  }
  // Destination wealth tax (Dutch Box 3): annual % of the portfolio above a
  // threshold, charged monthly once retired.
  const wealthTaxRate = retCfg?.wealth_tax?.rate ?? 0;
  const wealthTaxThreshold = retCfg?.wealth_tax
    ? toBase(retCfg.wealth_tax.threshold ?? 0, retCfg.wealth_tax.currency ?? baseCcy)
    : 0;
  // Standalone wealth tax (RELOCATION scenarios): applies to the portfolio from
  // `active_from` while the household keeps working — so, unlike the retirement
  // wealth tax above, it can't ride on the `retired` flag. The base is the same
  // (only invBalances are taxed), so the Yerevan complex / primary home are exempt.
  const standaloneWtRate = cfg.wealth_tax?.rate ?? 0;
  const standaloneWtThreshold = cfg.wealth_tax
    ? toBase(cfg.wealth_tax.threshold ?? 0, cfg.wealth_tax.currency ?? baseCcy)
    : 0;
  const standaloneWtFrom = cfg.wealth_tax?.active_from ? parseISO(cfg.wealth_tax.active_from) : baseDate;
  // Retirement state — the date is an OUTPUT of the trigger evaluated in the loop.
  let retired = false;
  let retirementDate: Date | null = null;
  const FAR_FUTURE = addMonths(baseDate, totalMonths + 24);

  // ---- Dynamic RELOCATION plan (the move date is an OUTPUT of an equity trigger) ----
  const relCfg = cfg.relocation?.enabled ? cfg.relocation : undefined;
  const relHome = relCfg ? realEstate.find((re) => re.id === relCfg.homeId) : undefined;
  // The home's one-off down payment + fees (agreed price, less the mortgage/loan), base ccy.
  const relDownPayment = relHome
    ? toBase(Math.max(0, relHome.purchase.price + (relHome.purchase.acquisition_costs ?? 0)
        - relHome.mortgage.principal - (relHome.cash_loan?.amount ?? 0)), relHome.currency)
    : 0;
  // The home's yearly mortgage payment (annuity at the first rate period), base ccy. For a
  // Swiss interest-only loan this is the amortizing-phase payment (annuity on the slice above
  // the floor + interest-only on the floor) — far cheaper than a full annuity, so the equities
  // sustain it sooner and the Auto move triggers earlier (the cheap-leverage point).
  const relMortgageYear = relHome
    ? toBase((() => {
        const m = relHome.mortgage;
        const r = (m.rate_periods[0]?.rate ?? 0) / 12;
        if (m.interest_only) {
          const slice = Math.max(0, m.principal - m.interest_only.floor);
          return (annuity(slice, r, m.interest_only.amortize_months) + m.interest_only.floor * r) * 12;
        }
        const n = monthsBetween(parseISO(m.first_payment_date), parseISO(m.last_payment_date)) + 1;
        return annuity(m.principal, r, n) * 12;
      })(), relHome.currency)
    : 0;
  // The home's yearly running costs (property tax + maintenance), base ccy — these draw on
  // the portfolio every year just like the mortgage, so the sustainability test must cover
  // them too, or the equities quietly bleed by the holding-cost amount each year.
  const relHoldingYear = relHome?.holding_costs
    ? toBase((relHome.holding_costs.local_property_tax ?? 0) + (relHome.holding_costs.building_maintenance ?? 0)
        + (relHome.holding_costs.unit_maintenance ?? 0), relHome.currency)
    : 0;
  // The home appreciates between now and the (dynamic) PURCHASE date, so by the time it's bought
  // its price — and the LTV-scaled mortgage and the down payment with it — have grown by this
  // factor. The trigger and the purchase both project to the move year, so the move targets the
  // home's ACTUAL future cost rather than today's (which would fire too early in the Auto modes).
  const relHomeGrow = (atDate: Date): number =>
    relHome ? Math.pow(1 + relHome.appreciation_rate, monthsBetween(baseDate, atDate) / 12) : 1;
  // Balance-weighted expected return of the equities book (drives "can returns sustain it").
  const equitiesReturn = (): number => {
    const tot = investments.reduce((s, inv) => s + Math.max(0, invBalances.get(inv.id) ?? 0), 0);
    if (tot <= 0) return savingsSink?.expected_return ?? investments[0]?.expected_return ?? 0;
    return investments.reduce((s, inv) => s + Math.max(0, invBalances.get(inv.id) ?? 0) * inv.expected_return, 0) / tot;
  };
  // Move state. A FIXED-year preset (Relocate 2030 / 2032) seeds the date up front and
  // skips the dynamic trigger; otherwise it's an OUTPUT (the year AFTER the inflexion).
  let relocationDate: Date | null = relCfg?.fixed_move_year ? parseISO(`${relCfg.fixed_move_year}-01-01`) : null;
  let relInflexionFound = relocationDate != null;
  // Post-move expense test: destination lifestyle (e.g. `dl_*`) vs the UAE budget.
  const isPostMoveExpense = (e: ExpenseConfig): boolean =>
    !relCfg ? false
    : relCfg.postMoveExpenseIds?.length ? relCfg.postMoveExpenseIds.includes(e.id)
    : !!relCfg.postMoveExpensePrefix && e.id.startsWith(relCfg.postMoveExpensePrefix);
  // For the AUTO move trigger: how much the POST-MOVE income leaves over after living, so
  // the equities only need to sustain the REST of the housing. The dynamic "Auto" salary
  // covers living by design (no surplus) — but a fixed SWE wage leaves a real surplus that
  // can service the mortgage, so the move triggers sooner. (Dublin nets ~flat — its rent and
  // mortgage roughly offset around the move — so it's left out, mirroring the rest of the test.)
  const postMoveExpScheds = expenseSchedules.filter(({ e }) => isPostMoveExpense(e));
  const postMoveLivingYr = (fy: number) =>
    postMoveExpScheds.reduce((s, { schedule }) => s + (schedule[fy] ?? schedule[schedule.length - 1] ?? 0), 0);
  const localInc = relCfg ? incomes.find((i) => i.id === relCfg.localIncomeId) : undefined;
  const relSweTier = localInc?.type === 'swe' ? (localInc as SweSalaryIncome).tier : null;
  const relIncomeCountry = relHome && isTaxCountry(relHome.country) ? relHome.country : undefined;
  /** Post-move income surplus over living available to service the home (base ccy/yr) at a
   *  candidate move year. 0 for the dynamic salary (it just covers living). */
  const postMoveSurplus = (moveLabel: number, moveFy: number): number => {
    if (!relSweTier || !relIncomeCountry || !relHome) return 0;
    const grossLocal = sweGrossSalary(relIncomeCountry, relSweTier, moveLabel, cfg.meta.inflation_rate);
    const netBase = toBase(grossLocal - taxForGross(relIncomeCountry, grossLocal), relHome.currency);
    return Math.max(0, netBase - postMoveLivingYr(moveFy));
  };
  // Net proceeds (base ccy) if `re` were sold on `atDate` — values the
  // sell-on-retirement properties when testing the trigger.
  const residualAt = (re: RealEstateConfig, atDate: Date): number => {
    const from = re.owned_from ? parseISO(re.owned_from) : baseDate;
    if (atDate < from) return 0;
    const future = from > baseDate;
    const age = monthsBetween(future ? from : baseDate, atDate) / 12;
    const mv = (future ? re.purchase.price : re.current_value) * Math.pow(1 + re.appreciation_rate, age);
    const st = mortgageAt(re.mortgage, atDate);
    const sc = re.sale ? mv * re.sale.selling_costs_rate : 0;
    const cgt = computeCgt(re, mv, sc, atDate).cgt;
    return toBase(Math.max(0, mv - st.balance - sc - cgt), re.currency);
  };
  // Own-cash to buy the home on `atDate`: its value (grown from base) + fees, less
  // any mortgage. Plus its annual running (holding) cost for the trigger spend.
  const homeBuyCashAt = (atDate: Date): number => {
    if (!homeRe) return 0;
    const grow = Math.pow(1 + homeRe.appreciation_rate, monthsBetween(baseDate, atDate) / 12);
    const price = homeRe.current_value * grow;
    const acq = (homeRe.purchase.acquisition_costs ?? 0) * grow;
    return toBase(Math.max(0, price + acq - homeRe.mortgage.principal), homeRe.currency);
  };
  const homeHoldingAt = (yearIdx: number): number => {
    const hc = homeRe?.holding_costs;
    if (!hc || !homeRe) return 0;
    const infl = hc.grows_with === 'none' ? 1 : Math.pow(1 + cfg.meta.inflation_rate, yearIdx);
    return toBase(((hc.local_property_tax ?? 0) + (hc.building_maintenance ?? 0) + (hc.unit_maintenance ?? 0)) * infl, homeRe.currency);
  };

  // ---- Running balances (base currency) ----
  const invBalances = new Map<string, number>(
    investments.map((inv) => [inv.id, toBase(inv.opening_balance, inv.currency)]),
  );
  // Cost basis per portfolio (base ccy), for realised capital-gains tax on post-move draws.
  // The family steps up the basis to market value AT the move (liquidating while UAE-resident),
  // so only gains accruing after the move are taxed. Tracked average-cost: contributions add to
  // basis, a sale removes a proportional slice. `basisSteppedUp` flips once, at the move month.
  const invBasis = new Map<string, number>(
    investments.map((inv) => [inv.id, toBase(inv.opening_balance, inv.currency)]),
  );
  let basisSteppedUp = false;
  const addBasis = (id: string, amount: number) => invBasis.set(id, (invBasis.get(id) ?? 0) + amount);
  const sellBasis = (id: string, sold: number, balBefore: number) => {
    const keep = balBefore > 0 ? Math.max(0, 1 - sold / balBefore) : 1;
    invBasis.set(id, (invBasis.get(id) ?? 0) * keep);
  };
  // Surplus cash is swept here. A property's `reinvest_surplus_to` takes
  // precedence (its distributions are reinvested there), else `receives_savings`.
  const reinvestTarget = realEstate.find((re) => re.reinvest_surplus_to)?.reinvest_surplus_to;
  const savingsSink =
    investments.find((inv) => inv.id === reinvestTarget) ?? investments.find((inv) => inv.receives_savings);

  // Cash buffer (config-driven; defaults to none if no `cash` section). The
  // headline rate applies only up to `interest_cap` (e.g. a UAE high-yield account
  // capped at AED 1M); the balance above earns the lower `excess_interest_rate`.
  const cashCfg = cfg.cash;
  const cashCcy = cashCfg?.currency ?? baseCcy;
  const cashMonthlyRate = annualToMonthlyRate(cashCfg?.interest_rate ?? 0);
  const cashExcessMonthlyRate = annualToMonthlyRate(cashCfg?.excess_interest_rate ?? 0);
  const cashCapBase = cashCfg?.interest_cap != null
    ? toBase(cashCfg.interest_cap, cashCfg.interest_cap_currency ?? cashCcy)
    : Infinity;
  const cashInterest = (bal: number): number => {
    if (bal <= 0) return 0; // no interest credited on an overdrawn buffer
    const atHigh = Math.min(bal, cashCapBase);
    const above = Math.max(0, bal - cashCapBase);
    return atHigh * cashMonthlyRate + above * cashExcessMonthlyRate;
  };
  const bufferMonths = cashCfg?.target_buffer_months ?? 0;
  let cash = cashCfg ? toBase(cashCfg.opening_balance, cashCfg.currency ?? baseCcy) : 0;
  let warnedNegativeCash = false;

  const allPoints: ForecastPoint[] = [];

  // Per-property monthly breakdown, aggregated into yearly reports after the loop.
  const propMonthly = new Map<string, PropMonthRec[]>(realEstate.map((re) => [re.id, []]));
  // Household income flows + per-investment growth/contribution, per month.
  const houseMonthly: HouseMonth[] = [];
  const invMonthly = new Map<string, InvMonth[]>(investments.map((i) => [i.id, []]));
  // Trailing-12-month net rental income (base ccy) — what "real estate" contributes toward the
  // cost of life in the Auto-FIRE move trigger (pre-move it's the kept rentals; the residence
  // earns none). Updated at the end of each month from that month's realised rent.
  let rentTrailing12 = 0;
  const rentMonthHist: number[] = [];

  for (let m = 0; m <= totalMonths; m++) {
    // Calendar-aligned: month m (m>=1) is the m-th month FROM the base month, so
    // m=1 is the base month itself (Jan of the base year). This makes forecast year
    // y = months (y-1)*12+1..y*12 fall on calendar Jan..Dec of `baseYear+y-1`, so
    // `active_from`/`owned_from` boundaries (e.g. a 2031-01-01 move) land in the year
    // they're labelled with — not one month early in the prior year's bucket.
    const monthDate = m === 0 ? baseDate : addMonths(baseDate, m - 1);
    const yearsElapsed = m / 12;
    // Whole forecast years completed (0 during year 1, 1 during year 2, ...).
    // Salary raises step up at each year boundary, not continuously.
    const yearIndex = Math.floor((m - 1) / 12);
    const isOpening = m === 0;

    // ---- RETIREMENT TRIGGER ----
    // Retire as soon as investable assets (portfolio + cash + the equity of the
    // properties we'd sell) can fund the move: buy the home AND leave a nest egg
    // that sustains the destination spend at the safe withdrawal rate. The first
    // month this holds (>= not_before) becomes the retirement date.
    if (retCfg && !retired && !isOpening) {
      const label = baseYear + yearIndex;
      const fy = yearIndex + 1;
      const portfolio = [...invBalances.values()].reduce((s, b) => s + b, 0);
      const sellable = [...sellOnRetirement].reduce((s, id) => {
        const re = realEstate.find((r) => r.id === id);
        return s + (re ? residualAt(re, monthDate) : 0);
      }, 0);
      const investable = portfolio + Math.max(0, cash) + sellable;
      const swr = retCfg.safe_withdrawal_rate || 0.03;
      const spend = (retSpendByYear[fy] ?? retSpendByYear[retSpendByYear.length - 1] ?? 0) + homeHoldingAt(yearIndex);
      const need = homeBuyCashAt(monthDate) + spend / swr + (retCfg.buffer_years ?? 0) * spend;
      const forced = label >= (retCfg.not_after ?? Infinity);
      if ((label >= (retCfg.not_before ?? -Infinity) && investable >= need) || forced) {
        retired = true;
        retirementDate = monthDate;
      }
    }

    // ---- RELOCATION TRIGGER ----
    // The move is dynamic: the first YEAR the equities can (a) fund the home's down
    // payment AND (b) sustain its yearly mortgage + the self-funded wealth tax from
    // returns alone — so the portfolio doesn't lose value once housing draws on it,
    // even if no more capital is added — is the inflexion. The move lands the NEXT
    // year: UAE income/expenses stop, the local (dynamic) salary + destination expenses
    // start, and the home is bought. (Mirrors the FIRE trigger, but SWITCHES income.)
    if (relCfg && !relInflexionFound && !isOpening) {
      const label = baseYear + yearIndex;
      const equities = [...invBalances.values()].reduce((s, b) => s + Math.max(0, b), 0);
      // Project the home's cost to the PURCHASE year (the move lands at label+1, by which point the
      // price, its LTV-scaled mortgage and the down payment have all appreciated). Holding grows
      // with inflation. Using today's price would let the move fire before the home is affordable.
      const grow = relHomeGrow(parseISO(`${label + 1}-01-01`));
      const inflGrow = Math.pow(1 + (cfg.meta.inflation_rate ?? 0), label + 1 - baseYear);
      const downY = relDownPayment * grow;
      const mortgageY = relMortgageYear * grow;
      const holdingY = relHoldingYear * inflGrow;
      const afterDown = equities - downY;
      const wt = standaloneWtRate > 0 ? Math.max(0, afterDown - standaloneWtThreshold) * standaloneWtRate : 0;
      // Sustainable = after paying the down payment, the year's GROWTH covers the ongoing
      // housing draw (mortgage + running costs) AND the wealth tax — NET of any post-move
      // income surplus that goes to the mortgage (a SWE wage leaves one; the Auto salary
      // doesn't). With a small margin so holding-cost inflation can't tip it into a slow
      // decline. The portfolio then only dips the year the down payment leaves, never after.
      const surplus = postMoveSurplus(label + 1, yearIndex + 2); // the move lands next year
      // Default Auto: the yield need only sustain the HOME (mortgage + holding + wealth tax),
      // net of any post-move salary surplus — the local salary still covers living.
      // Auto FIRE: NO salary, so the yield + net rent must also cover the destination LIVING —
      // true financial independence. (Net rent = the trailing-year rental from the kept homes.)
      const annualDraw = relCfg.fire
        ? Math.max(0, postMoveLivingYr(yearIndex + 2) + mortgageY + holdingY + wt - rentTrailing12)
        : Math.max(0, mortgageY + holdingY + wt - surplus);
      const sustains = equities >= downY && afterDown * equitiesReturn() >= annualDraw * 1.05;
      const forced = label >= (relCfg.not_after ?? Infinity);
      if ((label >= (relCfg.not_before ?? -Infinity) && sustains) || forced) {
        relInflexionFound = true;
        relocationDate = parseISO(`${label + 1}-01-01`); // move the year AFTER the inflexion
      }
    }
    const relMoved = relocationDate != null && monthDate >= relocationDate;

    // ---- INCOME (net, base ccy) — zero on the opening snapshot.
    //      Rental income is handled with its property below. ----
    let incomeNet = 0;
    let salaryGross = 0; // non-rental income, gross (base ccy)
    let salaryTax = 0; // income tax on it (0 in the UAE)
    if (!isOpening && !retired) {
      // employment income stops at retirement (the household then lives off the portfolio)
      for (const inc of incomes) {
        if (inc.type === 'dynamic') continue; // sized after expenses + rent are known (below)
        if (relCfg && inc.id !== relCfg.localIncomeId && relMoved) continue; // UAE income ends at the move
        if (relCfg && inc.id === relCfg.localIncomeId && !relMoved) continue; // local income starts at the move
        if (relCfg?.fire && inc.id === relCfg.localIncomeId) continue; // Auto FIRE: no local salary at all
        if (inc.type === 'swe') {
          // A fixed software-engineer wage, sized from the destination country (the home's),
          // the tier and the experience-by-year — then taxed progressively in that country.
          const s = inc as SweSalaryIncome;
          if (s.active_from && monthDate < parseISO(s.active_from)) continue;
          const country = isTaxCountry(s.country) ? s.country : (relHome && isTaxCountry(relHome.country) ? relHome.country : undefined);
          if (!country) continue;
          const ccy = relHome?.currency ?? s.currency; // the destination's currency (CHF for CH)
          const grossYrLocal = sweGrossSalary(country, s.tier, baseYear + yearIndex, cfg.meta.inflation_rate);
          const taxYrLocal = taxForGross(country, grossYrLocal);
          salaryGross += toBase(grossYrLocal / 12, ccy);
          salaryTax += toBase(taxYrLocal / 12, ccy);
          incomeNet += toBase((grossYrLocal - taxYrLocal) / 12, ccy);
          continue;
        }
        if (inc.type === 'salary') {
          const s = inc as SalaryIncome;
          const sched = salarySchedules.get(s.id)!;
          const grossYr = sched[yearIndex + 1] ?? sched[sched.length - 1]; // gross for this forecast year
          const grossBase = toBase(grossYr / 12, s.currency);
          salaryGross += grossBase;
          salaryTax += grossBase * s.tax_rate;
          incomeNet += grossBase * (1 - s.tax_rate);
        } else {
          const g = inc as GenericIncome;
          if (g.active_from && monthDate < parseISO(g.active_from)) continue;
          const growth = Math.pow(1 + (g.growth_rate ?? 0), yearIndex);
          const grossBase = toBase(((g.gross_per_year ?? g.net_per_year ?? 0) * growth) / 12, g.currency);
          const taxRate = g.net_per_year != null ? 0 : (g.tax_rate ?? 0);
          salaryGross += grossBase;
          salaryTax += grossBase * taxRate;
          incomeNet += grossBase * (1 - taxRate);
        }
      }
    }
    let salaryNet = incomeNet; // non-rental income net; the dynamic salary is added in below
    let rentNetTotal = 0; // household rental income, net (base ccy)

    // ---- EXPENSES (base ccy) — from the per-line yearly schedules ----
    let expensesTotal = 0;
    if (!isOpening) {
      const fy = yearIndex + 1; // forecast year
      // working (pre-retirement) costs, then the destination lifestyle once retired.
      for (const { e, schedule } of retired ? retExpenseSchedules : expenseSchedules) {
        // RELOCATION: UAE costs run until the move; destination costs start at the move.
        if (relCfg && isPostMoveExpense(e) !== relMoved) continue;
        expensesTotal += (schedule[fy] ?? 0) / 12;
      }
    }

    // ---- PROPERTIES: rental income + mortgage + holding + end-of-month state ----
    let mortgagePayment = 0;
    let mortgageInterestTotal = 0; // interest slice of the payment — CONSUMPTION (a cost)
    let mortgagePrincipalTotal = 0; // principal slice — EQUITY (transfers cash → home)
    let holdingCosts = 0;
    let relHomeMortgage = 0; // the RELOCATION home's mortgage only (base ccy) — salary-backstopped
    let relHomeHolding = 0; // the RELOCATION home's holding only (base ccy)
    let cashLoanPayment = 0; // personal-loan repayments this month (base ccy)
    let cashLoanBalance = 0; // outstanding personal-loan principal (base ccy)
    let purchaseOutflow = 0; // one-off down payment + fees in a purchase month (base ccy)
    let purchaseAcq = 0; // ...of which acquisition costs — CONSUMPTION (a one-off cost)
    let purchaseDownEquity = 0; // ...of which the down payment — EQUITY (transfers cash → home)
    let saleInflow = 0; // net proceeds realized when a property is sold (base ccy)
    let selfUseSaving = 0; // living-cost saving from occupying owned properties (base ccy)
    const propertyPoints: PropertyPoint[] = [];
    for (const re of realEstate) {
      // Ownership window. A future `owned_from` models a purchase; a `sold_on`
      // date realizes net proceeds into cash and takes it off the books. The
      // retirement home is bought on the (dynamic) retirement date; the
      // sell-on-retirement properties are sold then.
      const isHome = re.id === homeId;
      const isRelHome = !!relCfg && re.id === relCfg.homeId;
      const ownedFrom = isHome
        ? (retired ? retirementDate! : FAR_FUTURE)
        : isRelHome
          ? (relocationDate ?? FAR_FUTURE) // dynamic relocation: bought AT the move
          : re.owned_from ? parseISO(re.owned_from) : baseDate;
      let soldOn = re.sold_on ? parseISO(re.sold_on) : null;
      if (!isHome && retired && sellOnRetirement.has(re.id)) soldOn = retirementDate!;
      const isFuture = ownedFrom > baseDate;
      // The home (retirement OR relocation) grows from base_date, so it's bought at its THEN-market
      // price (today's price projected to the dynamic move date) — not at today's price. Other
      // future purchases use their fixed agreed price grown from the purchase date.
      const fromBase = isHome || isRelHome || !isFuture;
      // The relocation home's mortgage starts at the (dynamic) move date, not the YAML's
      // fixed first-payment date — shift it there, preserving the term + rate.
      const reMortgage = (isRelHome && relocationDate)
        ? (() => {
            const term = monthsBetween(parseISO(re.mortgage.first_payment_date), parseISO(re.mortgage.last_payment_date)) + 1;
            const first = addMonths(relocationDate, 1);
            // Scale the loan by the price's appreciation to the purchase date — keeps the LTV
            // constant (you mortgage a % of the ACTUAL purchase price, not the 2026 price).
            const g = relHomeGrow(relocationDate);
            const io = re.mortgage.interest_only;
            return {
              ...re.mortgage,
              principal: re.mortgage.principal * g,
              ...(io ? { interest_only: { ...io, floor: io.floor * g } } : {}),
              first_payment_date: isoMonth(first),
              last_payment_date: isoMonth(addMonths(first, term - 1)),
            };
          })()
        : re.mortgage;
      if (monthDate < ownedFrom || (soldOn && monthDate >= soldOn)) {
        // not on the books this month. In the sale month, realize net proceeds.
        if (soldOn && !isOpening && isSameMonth(monthDate, soldOn)) {
          const ageAtSale = monthsBetween(isFuture ? ownedFrom : baseDate, soldOn) / 12;
          const mvSale = (isFuture ? re.purchase.price : re.current_value) * Math.pow(1 + re.appreciation_rate, ageAtSale);
          const saleState = mortgageAt(reMortgage, soldOn);
          const sc = re.sale ? mvSale * re.sale.selling_costs_rate : 0;
          const cgtSale = computeCgt(re, mvSale, sc, soldOn);
          const residual = mvSale - saleState.balance - sc - cgtSale.cgt;
          saleInflow += toBase(Math.max(0, residual), re.currency);
        }
        propertyPoints.push({ id: re.id, name: re.name, marketValue: 0, mortgageBalance: 0, grossEquity: 0, cgt: 0, sellingCosts: 0, netEquity: 0 });
        propMonthly.get(re.id)!.push({ monthIndex: m, date: isoMonth(monthDate), rentGross: 0, vacancyLoss: 0, managementFee: 0, lettingFee: 0, rentalTax: 0, rentNet: 0, mortgageInterest: 0, mortgagePrincipal: 0, mortgagePayment: 0, holdingCosts: 0, marketValue: 0, mortgageBalance: 0, sellingCosts: 0, cgt: 0, cgtGain: 0, cgtPprExemptFraction: 0, cgtPprExemptAmount: 0, residualValue: 0 });
        continue;
      }
      const a = mortgageAt(reMortgage, monthDate);
      const interestBase = toBase(a.interestThisMonth, re.currency);
      const principalBase = toBase(a.principalThisMonth, re.currency);
      const paymentBase = toBase(a.payment, re.currency);

      // holding costs (monthly, optionally inflating). Track the portion that is
      // deductible against rental income — Irish rule: maintenance is deductible,
      // Local Property Tax is NOT.
      let hcBase = 0;
      let deductibleHolding_c = 0; // property currency, monthly
      const hc = re.holding_costs;
      if (hc) {
        const inflFactor = hc.grows_with === 'inflation' ? Math.pow(1 + inflationM, m) : 1;
        const lpt = (hc.local_property_tax ?? 0) * inflFactor;
        const maintenance = ((hc.building_maintenance ?? 0) + (hc.unit_maintenance ?? 0)) * inflFactor;
        hcBase = toBase((lpt + maintenance) / 12, re.currency);
        deductibleHolding_c = maintenance / 12;
      }

      // rental income (monthly, base ccy) — components for the breakdown
      let rentGross = 0, vacancyLoss = 0, managementFee = 0, lettingFee = 0, rentalTax = 0, rentNet = 0;
      const rental = re.rental;
      const active = rental && (!rental.active_from || monthDate >= parseISO(rental.active_from));
      if (rental && active) {
        const grown = Math.pow(1 + rental.rent_growth_rate, yearsElapsed);
        const grossFull = rental.gross_per_month * grown; // monthly contractual rent
        // Tenant turnover drives both vacancy and the find-new-tenant fee.
        const turnoversPerYear = 1 / rental.average_tenancy_years;
        const vacFrac = (rental.vacancy_months_per_turnover * turnoversPerYear) / 12;
        const vacancyLoss_c = grossFull * vacFrac;
        const collected_c = grossFull - vacancyLoss_c;
        const mgmt_c = collected_c * rental.management_fee_rate;
        // find-new-tenant fee: % of ANNUAL rent per turnover, annualized -> monthly
        const letting_c = grossFull * rental.find_new_tenant_fee_rate * turnoversPerYear;
        const afterCosts_c = collected_c - mgmt_c - letting_c;
        const taxableBasis_c = rental.tax.basis === 'net_profit'
          ? Math.max(0, afterCosts_c - a.interestThisMonth - deductibleHolding_c)
          : afterCosts_c;
        const tax_c = taxableBasis_c * rental.tax.rate;
        rentGross = toBase(grossFull, re.currency);
        vacancyLoss = toBase(vacancyLoss_c, re.currency);
        managementFee = toBase(mgmt_c, re.currency);
        lettingFee = toBase(letting_c, re.currency);
        rentalTax = toBase(tax_c, re.currency);
        rentNet = rentGross - vacancyLoss - managementFee - lettingFee - rentalTax;
      }

      // one-off purchase funding: the part of (price + acquisition costs) you fund
      // yourself — i.e. less the mortgage and any personal-loan proceeds that go
      // straight into the deal. Hits cash flow in the purchase month and is drawn
      // from cash, then liquidated investments.
      if (isFuture && !isOpening && isSameMonth(monthDate, ownedFrom)) {
        let ownCash: number;
        let acq: number;
        if (isHome || isRelHome) {
          // bought at its then-market price (grown from base) + fees; the loan scales with it
          // (constant LTV), so the down payment is the 2026 down payment grown by appreciation.
          const grow = Math.pow(1 + re.appreciation_rate, yearsElapsed);
          acq = (re.purchase.acquisition_costs ?? 0) * grow;
          ownCash = re.current_value * grow + acq - re.mortgage.principal * grow;
        } else {
          acq = re.purchase.acquisition_costs ?? 0;
          ownCash = re.purchase.price + acq - re.mortgage.principal - (re.cash_loan?.amount ?? 0);
        }
        const ownBase = toBase(Math.max(0, ownCash), re.currency);
        const acqBase = toBase(acq, re.currency);
        purchaseOutflow += ownBase;
        // Split the buy into its CONSUMPTION part (acquisition fees — lost) and its EQUITY part
        // (the down payment — cash that becomes home equity). The "→ home" flow shows the latter.
        purchaseAcq += Math.min(ownBase, acqBase);
        purchaseDownEquity += Math.max(0, ownBase - acqBase);
      }
      // personal cash loan: repaid from income; its outstanding balance is a liability.
      if (re.cash_loan && !isOpening) {
        const cl = re.cash_loan;
        const clCcy = cl.currency ?? re.currency;
        const cs = amortizeSchedule(cl.amount, [{ rate: cl.rate, months: cl.term_months }], cl.term_months, monthsBetween(ownedFrom, monthDate));
        cashLoanPayment += toBase(cs.payment, clCcy);
        cashLoanBalance += toBase(cs.balance, clCcy);
      }
      // self-use saving: occupying it offsets living costs (travel / rent) while owned.
      if (re.self_use_saving && !isOpening) {
        const sus = re.self_use_saving;
        const inflF = sus.grows_with === 'none' ? 1 : Math.pow(1 + inflationM, m);
        selfUseSaving += toBase((sus.per_year / 12) * inflF, sus.currency ?? re.currency);
      }

      // contribute to household totals (skip flows on opening snapshot)
      if (!isOpening) {
        incomeNet += rentNet;
        rentNetTotal += rentNet;
        mortgagePayment += paymentBase;
        mortgageInterestTotal += interestBase;
        mortgagePrincipalTotal += principalBase;
        holdingCosts += hcBase;
        if (isRelHome) { relHomeMortgage += paymentBase; relHomeHolding += hcBase; }
      }

      // end-of-month stocks (residual value if sold). A fixed-price future purchase
      // grows from the price paid (at owned_from); existing holdings and the home
      // grow from current_value (base).
      const valueAge = fromBase ? yearsElapsed : monthsBetween(ownedFrom, monthDate) / 12;
      const marketValue = (fromBase ? re.current_value : re.purchase.price) * Math.pow(1 + re.appreciation_rate, valueAge);
      const sellingCosts = re.sale ? marketValue * re.sale.selling_costs_rate : 0;
      const cgtDetail = computeCgt(re, marketValue, sellingCosts, monthDate);
      const mvBase = toBase(marketValue, re.currency);
      const balBase = toBase(a.balance, re.currency);
      const sellBase = toBase(sellingCosts, re.currency);
      const cgtBase = toBase(cgtDetail.cgt, re.currency);
      const cgtGainBase = toBase(cgtDetail.gain, re.currency);
      const cgtExemptBase = toBase(cgtDetail.pprExemptAmount, re.currency);
      propertyPoints.push({
        id: re.id,
        name: re.name,
        marketValue: mvBase,
        mortgageBalance: balBase,
        grossEquity: mvBase - balBase,
        cgt: cgtBase,
        sellingCosts: sellBase,
        netEquity: mvBase - balBase - sellBase - cgtBase,
      });

      propMonthly.get(re.id)!.push({
        monthIndex: m,
        date: isoMonth(monthDate),
        rentGross: isOpening ? 0 : rentGross,
        vacancyLoss: isOpening ? 0 : vacancyLoss,
        managementFee: isOpening ? 0 : managementFee,
        lettingFee: isOpening ? 0 : lettingFee,
        rentalTax: isOpening ? 0 : rentalTax,
        rentNet: isOpening ? 0 : rentNet,
        mortgageInterest: isOpening ? 0 : interestBase,
        mortgagePrincipal: isOpening ? 0 : principalBase,
        mortgagePayment: isOpening ? 0 : paymentBase,
        holdingCosts: isOpening ? 0 : hcBase,
        marketValue: mvBase,
        mortgageBalance: balBase,
        sellingCosts: sellBase,
        cgt: cgtBase,
        cgtGain: cgtGainBase,
        cgtPprExemptFraction: cgtDetail.pprExemptFraction,
        cgtPprExemptAmount: cgtExemptBase,
        residualValue: mvBase - balBase - sellBase - cgtBase,
      });
    }

    // Destination wealth tax (Dutch Box 3 / cantonal) on the portfolio — self-financed by the
    // holdings it's levied on. Computed BEFORE the dynamic salary, which nets it off the
    // portfolio's yield. (Applied to the balances further down, at the allocation step.)
    let wealthTax = 0;
    if (!isOpening) {
      const portfolio = [...invBalances.values()].reduce((s, b) => s + b, 0);
      if (retired && wealthTaxRate > 0) {
        // FIRE: the destination wealth tax turns on at retirement.
        wealthTax = Math.max(0, portfolio - wealthTaxThreshold) * (wealthTaxRate / 12);
      } else if (standaloneWtRate > 0 && monthDate >= (relCfg ? (relocationDate ?? FAR_FUTURE) : standaloneWtFrom)) {
        // Relocation: wealth tax from the (dynamic) move date, while still earning.
        wealthTax = Math.max(0, portfolio - standaloneWtThreshold) * (standaloneWtRate / 12);
      }
    }

    // ---- DYNAMIC SALARY — sized so the household lives off salary + portfolio YIELD while
    //      PRESERVING the portfolio's principal. It covers living AND all ongoing housing
    //      (mortgage + holding, less rent) beyond what the cash-buffer interest and the
    //      portfolio's yield (growth − wealth tax) can fund, plus the buffer top-up. The home's
    //      DOWN PAYMENT is 100% equity (it falls to the purchase-month portfolio draw below) —
    //      the salary backstops it only if the portfolio can't (a forced fixed-year move). So
    //      the portfolio gives up only its yield, never principal (bar the down payment), and
    //      the cash buffer's interest goes straight to the home. Computed now that expenses +
    //      rent are known.
    if (!isOpening && !retired) {
      for (const inc of incomes) {
        if (inc.type !== 'dynamic') continue;
        const d = inc as DynamicSalaryIncome;
        // The local salary switches on at the (dynamic) move date in a relocation plan;
        // otherwise it honours its own static active_from. Auto FIRE suppresses it entirely —
        // the family lives off the portfolio + rent, no salary.
        if (relCfg && inc.id === relCfg.localIncomeId) { if (!relMoved || relCfg.fire) continue; }
        else if (d.active_from && monthDate < parseISO(d.active_from)) continue;
        const bufferTarget = expensesTotal * bufferMonths;
        const cashYield = cashInterest(cash); // buffer interest → straight to the home
        const labelYr = baseYear + yearIndex;
        const equityGrowth = investments.reduce((s, inv) => s
          + Math.max(0, invBalances.get(inv.id) ?? 0) * annualToMonthlyRate(inv.return_overrides?.[labelYr] ?? inv.expected_return), 0);
        const equityYield = Math.max(0, equityGrowth - wealthTax); // growth − potential wealth tax
        // (1) living gap AND (2) ALL ongoing housing — every property's mortgage + holding, net
        // of its rent — beyond what the cash-buffer interest and the portfolio's yield can fund.
        // Folding all housing in (not just the relocation home) means a rental whose costs
        // outrun its rent is topped up by SALARY, not by silently drawing the portfolio: the
        // portfolio is then drawn by AT MOST its yield (growth − wealth tax), never principal.
        const ongoingNeed = expensesTotal + mortgagePayment + holdingCosts + cashLoanPayment
          - incomeNet - saleInflow - selfUseSaving; // living + housing, less rent + fixed income
        let dynNet = Math.max(0, ongoingNeed - cashYield - equityYield);
        // (3) the DOWN PAYMENT is 100% equity (it falls to the purchase-month portfolio draw);
        //     the salary backstops it only if the portfolio genuinely can't cover the buy.
        const portfolioAvail = Math.max(0, [...invBalances.values()].reduce((s, b) => s + b, 0));
        const downFromSalary = Math.max(0, purchaseOutflow - saleInflow - portfolioAvail);
        // (4) keep the buffer topped up.
        dynNet += downFromSalary + Math.max(0, bufferTarget - cash);
        if (dynNet <= 0) continue;
        // Gross up the (monthly) net at the country's PROGRESSIVE annual rate, in its own
        // currency, so the effective rate tracks the salary's actual size (a small salary
        // sits in low brackets; a big one hits the top rate). Flat `tax_rate` is a fallback.
        let dynGross: number;
        const dynCountry = isTaxCountry(d.country) ? d.country : (relHome && isTaxCountry(relHome.country) ? relHome.country : undefined);
        const dynCcy = relHome?.currency ?? d.currency; // the destination's currency
        if (dynCountry) {
          const netLocalYr = (dynNet / cfg.fx_rates[dynCcy]) * 12; // base → local, annualised
          dynGross = toBase(grossForNet(dynCountry, netLocalYr) / 12, dynCcy);
        } else {
          dynGross = dynNet / (1 - (d.tax_rate ?? 0));
        }
        salaryGross += dynGross;
        salaryTax += dynGross - dynNet;
        incomeNet += dynNet;
        salaryNet += dynNet;
      }
    }

    // self-use savings and any sale proceeds add to cash flow; living costs,
    // financing and the one-off purchase outflow subtract from it. The wealth tax
    // does NOT — it's charged to the portfolio it's levied on (self-financed), so it
    // never burdens this cash flow.
    const netCashFlow = incomeNet + selfUseSaving + saleInflow - expensesTotal - mortgagePayment - holdingCosts - cashLoanPayment - purchaseOutflow;
    // Un-collapse it into the income statement vs the housing flow (they sum to
    // netCashFlow). Income (salary + rent) covers living; the HOUSING — mortgage, holding,
    // the purchase — is a separate draw funded from the portfolio. So the charts show the
    // income surplus saved AND the equity draw, not just the netted residual.
    //
    // SELF-CONTAINED properties: each home's rent pays its own mortgage + holding. The household's
    // OPERATING flow is therefore just LIVING vs salary + the cash properties distribute — housing
    // (interest/holding/principal) is NOT a household cost here, it lives on the property. The
    // PROPERTY flow is the full cash a property needs (capital injected = mortgage + holding −
    // rent) plus any one-off purchase (down payment + fees) — funded from the portfolio's yield
    // (the "→ home" draw on the Equities chart) and topped up by income only when the yield can't.
    // housingConsumption is still reported (it's the income chart's old "Home running costs"); the
    // flows no longer use it. netCashFlow is unchanged — this only re-attributes the split.
    const housingConsumption = mortgageInterestTotal + holdingCosts + purchaseAcq;
    const salaryAndFixed = incomeNet - rentNetTotal; // income that ISN'T rent (salary, pensions)
    // The PROPERTY contribution (each home's distribution / capital injected) is added at the
    // ANNUAL level in the household aggregation below — from each property's ANNUAL net cash flow —
    // so it matches the property cash-flow chart exactly (a property can need cash some months and
    // distribute others in a mortgage-payoff year; only the annual net is what its chart shows).
    const operatingFlow = salaryAndFixed + selfUseSaving - expensesTotal; // + Σ distributions (added annually)
    const propertyFlow = saleInflow - purchaseDownEquity - purchaseAcq - cashLoanPayment; // − Σ capital injected (added annually)

    // ---- ALLOCATE cash flow between the cash buffer and investments ----
    const monthGrowth = new Map<string, number>(); // investment return this month
    const monthContribution = new Map<string, number>(); // cash added/removed this month
    const monthContribSalary = new Map<string, number>();
    const monthContribProperty = new Map<string, number>();
    const monthWealthTax = new Map<string, number>(); // wealth tax charged to each portfolio this month
    const monthGainsTax = new Map<string, number>(); // realised capital-gains tax on a draw this month
    // the property's own cash flow this month (positive = it distributes)
    const propertyCashFlow = rentNetTotal - mortgagePayment - holdingCosts;
    let toCashM = 0;
    let toInvestM = 0;
    // toCashM decomposed by where the cash came from / went to, so the cash chart
    // can show a buffer-sweep (productive) apart from a spend-down (consumed).
    let cashFromIncomeM = 0;
    let cashFromInvestM = 0;
    let cashToExpensesM = 0;
    let cashToInvestM = 0;
    if (!isOpening) {
      // grow stocks first (interest / market return accrue on opening balances).
      // A per-year `return_overrides` entry models a market drawdown that year.
      cash += cashInterest(cash);
      // Key overrides by the forecast-year LABEL (the calendar year the charts
      // show), so a "2029: -0.28" drawdown lands wholly on the 2029 bar.
      const labelYear = baseYear + yearIndex;
      for (const inv of investments) {
        const before = invBalances.get(inv.id) ?? 0;
        const annualReturn = inv.return_overrides?.[labelYear] ?? inv.expected_return;
        const g = before * annualToMonthlyRate(annualReturn);
        invBalances.set(inv.id, before + g);
        monthGrowth.set(inv.id, g);
      }

      // Step up the cost basis to MARKET VALUE the first month we're post-move — the family
      // liquidates/rebalances while still UAE-resident, so only gains accruing AFTER the move
      // are taxed when the portfolio is later drawn for living.
      if (relMoved && !basisSteppedUp) {
        for (const inv of investments) invBasis.set(inv.id, Math.max(0, invBalances.get(inv.id) ?? 0));
        basisSteppedUp = true;
      }

      // ---- WEALTH TAX — self-financed by the portfolio it's levied on ----
      // Box 3 / cantonal wealth tax is a charge ON the holdings, so the taxed
      // portfolios pay it by selling a sliver of themselves (pro-rata to balance).
      // It never touches salary or the cash buffer — income isn't burdened by it.
      if (wealthTax > 0) {
        const wtBase = investments.reduce((s, inv) => s + Math.max(0, invBalances.get(inv.id) ?? 0), 0);
        if (wtBase > 0) {
          for (const inv of investments) {
            const balB = Math.max(0, invBalances.get(inv.id) ?? 0);
            const share = wealthTax * (balB / wtBase);
            invBalances.set(inv.id, (invBalances.get(inv.id) ?? 0) - share);
            sellBasis(inv.id, share, balB); // the sliver sold to pay it shrinks the basis pro-rata
            monthWealthTax.set(inv.id, share);
          }
        }
      }

      const bufferTarget = expensesTotal * bufferMonths;
      if (netCashFlow >= 0) {
        const need = Math.max(0, bufferTarget - cash);
        const toCash = Math.min(netCashFlow, need);
        cash += toCash;
        cashFromIncomeM += toCash; // operating surplus that topped up the buffer
        const surplus = netCashFlow - toCash;
        if (savingsSink) {
          invBalances.set(savingsSink.id, (invBalances.get(savingsSink.id) ?? 0) + surplus);
          addBasis(savingsSink.id, surplus); // money paid in adds to the cost basis
          // attribute the contribution: the property's distribution first, the rest from salary
          const fromProperty = Math.min(surplus, Math.max(0, propertyCashFlow));
          monthContribution.set(savingsSink.id, surplus);
          monthContribProperty.set(savingsSink.id, fromProperty);
          monthContribSalary.set(savingsSink.id, surplus - fromProperty);
          toCashM = toCash;
          toInvestM = surplus;
        } else {
          cash += surplus;
          cashFromIncomeM += surplus; // no investment bucket — surplus stays as cash
          toCashM = toCash + surplus;
        }
      } else {
        let deficit = -netCashFlow;
        // Keep the cash buffer at target: liquidate investments to cover the
        // deficit AND refill the buffer, rather than draining the buffer first.
        // This maintains the emergency fund through retirement (when every month is
        // a deficit). Only dip into the buffer / borrow once investments run out.
        const bufferShortfall = Math.max(0, bufferTarget - cash);
        if (savingsSink) {
          const avail = Math.max(0, invBalances.get(savingsSink.id) ?? 0);
          const need = deficit + bufferShortfall; // NET cash the household needs from the portfolio
          // Realised capital-gains tax: selling appreciated holdings to fund living triggers CGT
          // on the GAIN portion (post-move only; basis was stepped up at the move). Gross up the
          // sale so the net-of-tax proceeds still cover `need`. r=0 pre-move / for NL/CH ⇒ no gross-up.
          const r = relMoved ? equityCgtRate(relHome?.country) : 0;
          const gainFrac = r > 0 && avail > 0
            ? Math.max(0, Math.min(1, (avail - (invBasis.get(savingsSink.id) ?? 0)) / avail))
            : 0;
          const grossNeed = gainFrac * r < 1 ? need / (1 - gainFrac * r) : need;
          const take = Math.min(avail, grossNeed); // gross sale (may be capped if the portfolio runs dry)
          const cgt = take * gainFrac * r; // tax on the realised gain — leaves the portfolio
          const netProceeds = take - cgt; // cash actually delivered to the household
          invBalances.set(savingsSink.id, (invBalances.get(savingsSink.id) ?? 0) - take);
          sellBasis(savingsSink.id, take, avail);
          monthGainsTax.set(savingsSink.id, cgt);
          monthContribution.set(savingsSink.id, -netProceeds); // the NET withdrawal (CGT tracked separately)
          monthContribSalary.set(savingsSink.id, -netProceeds); // drawdown covers the shortfall
          toInvestM = -netProceeds;
          const coverDeficit = Math.min(netProceeds, deficit); // the rest tops up the buffer
          cash += netProceeds - coverDeficit;
          toCashM = netProceeds - coverDeficit;
          cashFromInvestM += netProceeds - coverDeficit; // investments liquidated to refill the buffer
          deficit -= coverDeficit;
        }
        if (deficit > 0) {
          const fromCash = Math.min(Math.max(0, cash), deficit); // buffer exhausted -> draw it down
          cash -= fromCash;
          deficit -= fromCash;
          toCashM -= fromCash;
          cashToExpensesM += fromCash; // buffer spent on living costs
        }
        if (deficit > 0) {
          cash -= deficit; // nothing left -> negative cash (borrowing)
          toCashM -= deficit;
          cashToExpensesM += deficit; // borrowed to cover living costs
          if (!warnedNegativeCash) {
            warnings.push('Cash goes negative at some point — outgoings exceed income and savings.');
            warnedNegativeCash = true;
          }
        }
      }
      // Cap the buffer at target: sweep anything above it (accumulated interest, or
      // a surplus with no buffer shortfall) into investments so the cash buffer
      // tracks ~6 months of expenses instead of ballooning. With no investment
      // bucket it simply stays as cash (income).
      if (cash > bufferTarget + 1e-6 && savingsSink) {
        const excess = cash - bufferTarget;
        cash = bufferTarget;
        invBalances.set(savingsSink.id, (invBalances.get(savingsSink.id) ?? 0) + excess);
        addBasis(savingsSink.id, excess); // swept-in cash adds to the cost basis
        monthContribution.set(savingsSink.id, (monthContribution.get(savingsSink.id) ?? 0) + excess);
        const fromProperty = Math.min(excess, Math.max(0, propertyCashFlow));
        monthContribProperty.set(savingsSink.id, (monthContribProperty.get(savingsSink.id) ?? 0) + fromProperty);
        monthContribSalary.set(savingsSink.id, (monthContribSalary.get(savingsSink.id) ?? 0) + (excess - fromProperty));
        toInvestM += excess;
        toCashM -= excess;
        cashToInvestM += excess; // swept out of the buffer into the portfolio
      }
    }

    houseMonthly.push({
      salaryGross,
      salaryTax,
      salaryNet,
      expenses: expensesTotal,
      housingCosts: housingConsumption,
      wealthTax,
      gainsTax: [...monthGainsTax.values()].reduce((s, t) => s + t, 0),
      investGrowth: [...monthGrowth.values()].reduce((s, g) => s + g, 0),
      mortgage: mortgagePayment,
      holding: holdingCosts,
      rentNet: rentNetTotal,
      operatingFlow,
      propertyFlow,
      netCashFlow,
      toCash: toCashM,
      toInvest: toInvestM,
      cashFromIncome: cashFromIncomeM,
      cashFromInvest: cashFromInvestM,
      cashToExpenses: cashToExpensesM,
      cashToInvest: cashToInvestM,
    });
    for (const inv of investments) {
      invMonthly.get(inv.id)!.push({
        growth: monthGrowth.get(inv.id) ?? 0,
        contribution: monthContribution.get(inv.id) ?? 0,
        contributionSalary: monthContribSalary.get(inv.id) ?? 0,
        contributionProperty: monthContribProperty.get(inv.id) ?? 0,
        wealthTax: monthWealthTax.get(inv.id) ?? 0,
        gainsTax: monthGainsTax.get(inv.id) ?? 0,
        balance: invBalances.get(inv.id) ?? 0,
      });
    }

    const investmentPoints: InvestmentPoint[] = investments.map((inv: InvestmentConfig) => {
      const bal = invBalances.get(inv.id) ?? 0;
      const basis = toBase(inv.opening_balance, inv.currency);
      const gain = Math.max(0, bal - basis);
      const tax = gain * (inv.gains_tax_rate ?? 0);
      return { id: inv.id, name: inv.name, balance: bal, netBalance: bal - tax };
    });

    const propertyNetEquity = propertyPoints.reduce((s, p) => s + p.netEquity, 0);
    const investmentsNet = investmentPoints.reduce((s, i) => s + i.netBalance, 0);
    // personal cash-loan debt is a liability against net worth (property mortgages
    // are already netted inside each property's equity).
    const netWorth = propertyNetEquity + investmentsNet + cash - cashLoanBalance;

    allPoints.push({
      date: isoMonth(monthDate),
      monthIndex: m,
      yearsElapsed,
      incomeNet,
      expenses: expensesTotal,
      mortgagePayment,
      holdingCosts,
      netCashFlow,
      properties: propertyPoints,
      investments: investmentPoints,
      propertyNetEquity,
      investmentsNet,
      cash,
      cashLoanBalance,
      netWorth,
    });

    // roll the trailing-year rental net forward (for the Auto-FIRE trigger above)
    rentMonthHist.push(isOpening ? 0 : rentNetTotal);
    rentTrailing12 += rentMonthHist[rentMonthHist.length - 1] - (rentMonthHist.length > 12 ? rentMonthHist[rentMonthHist.length - 13] : 0);
  }

  const today = allPoints[0];
  const monthly = allPoints.slice(1);
  const yearly = allPoints.filter((p) => p.monthIndex % 12 === 0);

  const horizons: HorizonSummary[] = horizonsYears.map((years) => {
    const p = allPoints[Math.min(allPoints.length - 1, years * 12)];
    return {
      years,
      date: p.date,
      netWorth: p.netWorth,
      propertyNetEquity: p.propertyNetEquity,
      investmentsNet: p.investmentsNet,
      cash: p.cash,
    };
  });

  // ---- Per-investment (real estate) yearly reports ----
  const realEstateReports: RealEstateReport[] = realEstate.map((re) => {
    const recs = propMonthly.get(re.id)!;
    const byMonth = new Map(recs.map((r) => [r.monthIndex, r]));
    // First month the property is on the books (0 if already owned at base_date).
    const buyMonth = recs.find((r) => r.marketValue > 0)?.monthIndex ?? 0;
    let cumulativeCapital = 0;
    const yearlyReport: RealEstateYear[] = [];
    for (let y = 1; y <= totalYears; y++) {
      // sum flows over months (y-1)*12+1 .. y*12; stocks at month y*12
      const sum = { rentGross: 0, vacancyLoss: 0, managementFee: 0, lettingFee: 0, rentalTax: 0, rentNet: 0, mortgageInterest: 0, mortgagePrincipal: 0, mortgagePayment: 0, holdingCosts: 0 };
      for (let mm = (y - 1) * 12 + 1; mm <= y * 12; mm++) {
        const r = byMonth.get(mm);
        if (!r) continue;
        sum.rentGross += r.rentGross;
        sum.vacancyLoss += r.vacancyLoss;
        sum.managementFee += r.managementFee;
        sum.lettingFee += r.lettingFee;
        sum.rentalTax += r.rentalTax;
        sum.rentNet += r.rentNet;
        sum.mortgageInterest += r.mortgageInterest;
        sum.mortgagePrincipal += r.mortgagePrincipal;
        sum.mortgagePayment += r.mortgagePayment;
        sum.holdingCosts += r.holdingCosts;
      }
      const end = byMonth.get(y * 12)!;
      const cashFlow = sum.rentNet - sum.mortgagePayment - sum.holdingCosts;
      const capitalInjected = Math.max(0, -cashFlow);
      cumulativeCapital += capitalInjected;
      // Decompose the residual-value increase: appreciation net of CGT/selling drag
      // (growth), plus mortgage principal paid down — funded by rent first, then
      // injected salary. In the PURCHASE year the baseline is the purchase month
      // (not last year's zero), so the down-payment equity shows as injected capital
      // (`newCapital`) rather than as bogus growth/rent. The five terms — previous +
      // newCapital + salary + rent + growth — sum to residualValue.
      const isPurchaseYear = buyMonth > 0 && buyMonth > (y - 1) * 12 && buyMonth <= y * 12;
      const base = byMonth.get(isPurchaseYear ? buyMonth : (y - 1) * 12)!;
      const newCapital = isPurchaseYear ? base.residualValue : 0;
      const valueGrowth =
        end.marketValue - base.marketValue - (end.sellingCosts - base.sellingCosts) - (end.cgt - base.cgt);
      const equityBuilt = base.mortgageBalance - end.mortgageBalance; // principal paid down (exact)
      const equityFromRent = Math.min(equityBuilt, Math.max(0, sum.rentNet - sum.mortgageInterest - sum.holdingCosts));
      const equityFromSalary = equityBuilt - equityFromRent;
      // Attribute the down-payment equity to where the money came from, so a portfolio
      // withdrawal in the purchase year reads "→ <home>" not "→ living costs". For the
      // FIRE retirement home that's the sold properties (their proceeds) then the
      // portfolio; for any OTHER future purchase (e.g. a 2030 relocation home) it's
      // funded from the portfolio/cash. We attribute the remainder to the portfolio and
      // let the withdrawal split cap it at the amount actually drawn (the cash-buffer
      // part of the down-payment isn't a portfolio withdrawal).
      let newCapitalSources: { label: string; amount: number }[] | undefined;
      if (newCapital > 0.5 && savingsSink) {
        const sources: { label: string; amount: number }[] = [];
        let remaining = newCapital;
        if (re.id === homeId && retirementDate) {
          for (const id of sellOnRetirement) {
            const sold = realEstate.find((r) => r.id === id);
            if (!sold) continue;
            const take = Math.min(remaining, residualAt(sold, retirementDate));
            if (take > 0.5) { sources.push({ label: sold.name, amount: take }); remaining -= take; }
          }
        }
        if (remaining > 0.5) sources.push({ label: savingsSink.name, amount: remaining });
        newCapitalSources = sources;
      }
      // Cash actually drawn to BUY it in the purchase year — the down payment INCLUDING
      // acquisition costs (less any personal loan), i.e. value − mortgage + fees. This is
      // bigger than `newCapital` (the equity that lands on the books, net of selling
      // costs), and it's the figure the Equities withdrawal should pin to so the
      // acquisition-cost slice doesn't fall through to "living costs". 0 otherwise.
      const acqBase = toBase(re.purchase.acquisition_costs ?? 0, re.currency);
      const cashloanBase = toBase(re.cash_loan?.amount ?? 0, re.cash_loan?.currency ?? re.currency);
      const purchaseCashOut = isPurchaseYear ? Math.max(0, base.marketValue - base.mortgageBalance + acqBase - cashloanBase) : 0;
      yearlyReport.push({
        date: yearStartDate(y),
        year: y,
        ...sum,
        cashFlow,
        capitalInjected,
        distribution: Math.max(0, cashFlow),
        cumulativeCapitalInjected: cumulativeCapital,
        newCapital,
        newCapitalSources,
        purchaseCashOut,
        equityFromSalary,
        equityFromIncome: equityFromSalary, // default; split into income / cash / portfolio below (if a sink exists)
        equityFromCash: 0,
        equityFromPortfolio: 0,
        equityFromRent,
        valueGrowth,
        marketValue: end.marketValue,
        mortgageBalance: end.mortgageBalance,
        grossEquity: end.marketValue - end.mortgageBalance,
        sellingCosts: end.sellingCosts,
        cgt: end.cgt,
        cgtGain: end.cgtGain,
        cgtPprExemptFraction: end.cgtPprExemptFraction,
        cgtPprExemptAmount: end.cgtPprExemptAmount,
        residualValue: end.residualValue,
      });
    }
    return {
      id: re.id,
      name: re.name,
      currency: baseCcy,
      openingResidualValue: byMonth.get(0)!.residualValue,
      yearly: yearlyReport,
    };
  });

  // ---- Per financial-investment yearly reports ----
  const investmentReports: InvestmentReport[] = investments.map((inv) => {
    const recs = invMonthly.get(inv.id)!; // index = month (0..N)
    const basis = toBase(inv.opening_balance, inv.currency);
    const yearlyReport: InvestmentYear[] = [];
    let cumContribution = 0;
    for (let y = 1; y <= totalYears; y++) {
      let contribution = 0;
      let contributionFromSalary = 0;
      let contributionFromProperty = 0;
      let growth = 0;
      let wealthTaxY = 0;
      let realisedGainsTaxY = 0;
      for (let mm = (y - 1) * 12 + 1; mm <= y * 12; mm++) {
        const r = recs[mm];
        if (!r) continue;
        contribution += r.contribution;
        contributionFromSalary += r.contributionSalary;
        contributionFromProperty += r.contributionProperty;
        growth += r.growth;
        wealthTaxY += r.wealthTax;
        realisedGainsTaxY += r.gainsTax;
      }
      cumContribution += contribution;
      const bal = recs[y * 12].balance;
      const gainsTax = Math.max(0, bal - basis) * (inv.gains_tax_rate ?? 0);
      yearlyReport.push({
        date: yearStartDate(y),
        year: y,
        openingBalance: recs[(y - 1) * 12].balance,
        contribution,
        contributionFromSalary,
        contributionFromProperty,
        contributionFromCash: 0, // filled in below for the savings-sink portfolio
        savedFromIncome: 0, // filled in below for the savings-sink portfolio
        withdrawnForHome: 0, // portfolio drawn to fund properties' capital injected (+ down payment)
        withdrawnForLiving: 0, // portfolio drawn to cover living the salary + distributions didn't
        growth,
        wealthTax: wealthTaxY, // self-funded wealth tax drawn from this portfolio this year
        realisedGainsTax: realisedGainsTaxY, // CGT realised on this year's post-move drawdowns
        balance: bal,
        gainsTax,
        netBalance: bal - gainsTax,
        cumulativeContribution: cumContribution,
      });
    }
    return { id: inv.id, name: inv.name, currency: baseCcy, openingBalance: recs[0].balance, yearly: yearlyReport, wealthTaxLabel: cfg.wealth_tax?.label ?? 'Wealth tax (Box 3)' };
  });

  // ---- Household income breakdown (annual) ----
  const householdReports: HouseholdYear[] = [];
  for (let y = 1; y <= totalYears; y++) {
    let salaryGross = 0, salaryTax = 0, salaryNet = 0, expensesY = 0, housingCostsY = 0, wealthTaxY = 0, gainsTaxY = 0, returnsY = 0, mortgage = 0, holding = 0, rentNet = 0, netSaved = 0, toCash = 0, toInvestments = 0;
    let cashFromIncome = 0, cashFromInvest = 0, cashToExpenses = 0, cashToInvest = 0;
    let operatingFlowY = 0, propertyFlowY = 0;
    for (let mm = (y - 1) * 12 + 1; mm <= y * 12; mm++) {
      const h = houseMonthly[mm];
      if (!h) continue;
      salaryGross += h.salaryGross;
      salaryTax += h.salaryTax;
      salaryNet += h.salaryNet;
      expensesY += h.expenses;
      housingCostsY += h.housingCosts;
      wealthTaxY += h.wealthTax;
      gainsTaxY += h.gainsTax;
      returnsY += h.investGrowth;
      mortgage += h.mortgage;
      holding += h.holding;
      rentNet += h.rentNet;
      operatingFlowY += h.operatingFlow;
      propertyFlowY += h.propertyFlow;
      netSaved += h.netCashFlow;
      toCash += h.toCash;
      toInvestments += h.toInvest;
      cashFromIncome += h.cashFromIncome;
      cashFromInvest += h.cashFromInvest;
      cashToExpenses += h.cashToExpenses;
      cashToInvest += h.cashToInvest;
    }
    const yp = allPoints[y * 12]; // year-end snapshot
    // Add each property's ANNUAL net to the household flows (self-contained model): distributions
    // lift the operating flow (income that helps cover living), capital injected weighs on the
    // property flow (the "→ home" portfolio draw). Annual net per property = what its cash-flow
    // chart shows, so the income / equities / property charts reconcile to the euro.
    let distY = 0, capInjY = 0;
    for (const re of realEstateReports) {
      const ry = re.yearly[y - 1];
      if (!ry) continue;
      distY += ry.distribution;
      capInjY += ry.capitalInjected;
    }
    operatingFlowY += distY;
    propertyFlowY -= capInjY;
    householdReports.push({
      date: yearStartDate(y),
      year: y,
      salaryGross,
      salaryTax,
      salaryNet,
      expenses: expensesY,
      housingCosts: housingCostsY,
      wealthTax: wealthTaxY,
      gainsTax: gainsTaxY,
      investmentReturns: returnsY,
      investableEnd: yp ? yp.cash + yp.investmentsNet : 0,
      realEstateFunding: mortgage + holding - rentNet, // cash the property needs
      operatingFlow: operatingFlowY,
      propertyFlow: propertyFlowY,
      netSaved,
      toCash,
      toInvestments,
      cashFromIncome,
      cashFromInvest,
      cashToExpenses,
      cashToInvest,
    });
  }

  // Decompose the savings-sink's yearly flow into its GROSS economic legs so the charts
  // can show where every euro went, not just the netted residual. They reconcile exactly:
  //   balance = opening + growth − wealthTax
  //             + savedFromIncome + contributionFromProperty   (money in)
  //             − withdrawnForHome − withdrawnForLiving         (money out)
  //             + contributionFromCash                          (signed buffer flow)
  // because (savedFromIncome + propertyDist − homeDraw − livingDraw) = operatingFlow +
  // propertyFlow = netCashFlow, and the year's contribution = netCashFlow − toCash.
  // So the salary surplus shows as SAVED even in a year the portfolio also funds the
  // full housing draw — instead of the two silently cancelling to one small number.
  if (savingsSink) {
    const sinkReport = investmentReports.find((r) => r.id === savingsSink.id);
    if (sinkReport) {
      sinkReport.yearly.forEach((yr, idx) => {
        const hh = householdReports[idx];
        const toCash = hh?.toCash ?? 0;
        const opFlow = hh?.operatingFlow ?? 0; // salary − living (the income statement)
        const propFlow = hh?.propertyFlow ?? 0; // rent + sale − mortgage − holding − purchase
        yr.savedFromIncome = Math.max(0, opFlow); // operating surplus saved to the portfolio
        yr.withdrawnForLiving = Math.max(0, -opFlow); // salary couldn't cover living → drawn
        yr.contributionFromProperty = Math.max(0, propFlow); // property distributed cash in
        yr.withdrawnForHome = Math.max(0, -propFlow); // the FULL housing cost, drawn from equities
        yr.contributionFromCash = -toCash; // signed: + buffer→portfolio, − surplus→buffer
        // The dynamic salary refills the buffer that the home drained, so its "surplus"
        // round-trips: income → buffer → mortgage, never actually resting in the portfolio.
        // Net that loop out (it belongs on the Cash chart) so the Equities chart shows only
        // money that truly moved in/out of the portfolio — not a phantom save-then-withdraw.
        const roundTrip = Math.min(yr.savedFromIncome, yr.withdrawnForHome);
        yr.savedFromIncome -= roundTrip;
        yr.withdrawnForHome -= roundTrip;
        // The buffer→portfolio sweep is KEPT VISIBLE (not netted against a same-year draw). When
        // cash is swept above its target into the portfolio AND the portfolio funds a draw the same
        // year, the swept cash genuinely rests in the portfolio first, which then funds the draw —
        // cash → portfolio → home/living. So the Equities chart shows a real "From cash buffer"
        // inflow PLUS the gross "→ home"/"→ living" draw, matching the Cash chart's "Swept to
        // {portfolio}" line, instead of silently cancelling the two. The balance is identical either
        // way (the inflow and the correspondingly larger draw offset). `contributionFromCash` stays
        // the honest signed buffer flow (+ in / − out).
        // Funding split for each property's PRINCIPAL paydown: income (roundTrip) + portfolio. The
        // cash sweep funds the PORTFOLIO (shown on Equities as an inflow), not the home directly, so
        // there is no "from cash buffer" paydown line on the property modal — its share rolls into
        // "from portfolio".
        const homeFund = roundTrip + yr.withdrawnForHome; // income + portfolio = external capital injected
        for (const re of realEstateReports) {
          const ry = re.yearly[idx];
          if (!ry) continue;
          const fromIncome = homeFund > 0.5 ? ry.equityFromSalary * (roundTrip / homeFund) : 0;
          ry.equityFromIncome = fromIncome;
          ry.equityFromCash = 0; // cash tops up the portfolio, not the home directly
          ry.equityFromPortfolio = ry.equityFromSalary - fromIncome;
        }
        // …and the part that merely refilled the buffer (income → cash) isn't a portfolio save
        // either — net it against the to-buffer flow so it shows on the Cash chart only.
        const toBuffer = Math.max(0, -yr.contributionFromCash);
        const cashRoundTrip = Math.min(yr.savedFromIncome, toBuffer);
        yr.savedFromIncome -= cashRoundTrip;
        yr.contributionFromCash += cashRoundTrip;
        yr.contributionFromSalary = yr.savedFromIncome - yr.withdrawnForLiving; // net, for legacy readers
        // Split the portfolio's property draw BY PROPERTY, weighted by each property's CAPITAL
        // INJECTED this year (mortgage + holding − rent) plus any one-off purchase it funded — so
        // each "→ home" line equals that property's capital injected on its own cash-flow chart
        // (when the portfolio funds the whole need; the income/cash share, if any, shows there).
        const drawWeights = realEstateReports.map((re) => {
          const ry = re.yearly[idx];
          if (!ry) return { name: re.name, w: 0 };
          return { name: re.name, w: Math.max(0, ry.capitalInjected) + Math.max(0, ry.purchaseCashOut) };
        });
        const totW = drawWeights.reduce((s, x) => s + x.w, 0);
        yr.withdrawnForHomeByProperty = yr.withdrawnForHome > 0.5 && totW > 0.5
          ? drawWeights.filter((x) => x.w > 0.5).map((x) => ({ name: x.name, amount: yr.withdrawnForHome * (x.w / totW) }))
          : undefined;
        // Name the home draw: the property bought this year, else the PRIMARY RESIDENCE
        // (named in every year it's owned, not just at purchase) — e.g. "Withdrawn → Vienna home".
        let purchaseLabel: string | undefined;
        for (const re of realEstateReports) {
          if ((re.yearly[idx]?.purchaseCashOut ?? 0) > 0.5) purchaseLabel = re.name;
        }
        const homeReport = realEstateReports.find((re) => re.id === (relCfg?.homeId ?? homeId));
        const homeName = (homeReport?.yearly[idx]?.marketValue ?? 0) > 0.5 ? homeReport!.name : undefined;
        yr.withdrawnForHomeLabel = yr.withdrawnForHome > 0.5 ? (purchaseLabel ?? homeName ?? 'real estate') : undefined;
      });
    }
  }

  // ---- Living-expenses breakdown (annual, per line item) ----
  // After retirement the breakdown switches to the destination lifestyle (the UAE
  // rent etc. go away — you own the home), matching the engine's expensesTotal.
  const retYearForecast = retirementDate ? retirementDate.getUTCFullYear() - baseYear + 1 : Infinity;
  // NB: the wealth tax is NOT a living expense — it's charged to the portfolio it's
  // levied on (self-financed; see the investment loop above) and shows on the Equities
  // chart, so it no longer appears here as a "Taxes" expense category.
  // Relocation: the per-line breakdown must follow the SAME move switch as the monthly
  // expense total — UAE lines stop at the move, destination lines start — otherwise the
  // tooltip shows e.g. UAE rent in every year even after the home is bought.
  const relMoveYear = relocationDate ? relocationDate.getUTCFullYear() : null;
  const expensesReport: ExpensesReport = {
    categories: [
      ...new Set([...expenseSchedules, ...retExpenseSchedules].map(({ e }) => e.category ?? 'Other')),
    ],
    yearly: Array.from({ length: totalYears }, (_, i) => {
      const y = i + 1;
      const items = (y >= retYearForecast ? retExpenseSchedules : expenseSchedules).map(({ e, schedule }) => {
        let amount = schedule[y] ?? 0;
        if (relCfg) {
          const moved = relMoveYear != null && baseYear + y - 1 >= relMoveYear;
          if (isPostMoveExpense(e) !== moved) amount = 0; // pre-move lines off after the move, & vice-versa
        }
        return { id: e.id, name: e.name, category: e.category ?? 'Other', amount };
      });
      return {
        date: yearStartDate(y),
        year: y,
        total: items.reduce((s, it) => s + it.amount, 0),
        items,
      };
    }),
  };

  return {
    baseDate: cfg.meta.base_date,
    baseCurrency: baseCcy,
    today,
    monthly,
    yearly,
    realEstate: realEstateReports,
    investments: investmentReports,
    household: householdReports,
    expenses: expensesReport,
    horizons,
    retirementDate: retirementDate ? isoMonth(retirementDate) : null,
    relocationDate: relocationDate ? isoMonth(relocationDate) : null,
    warnings,
  };
}
