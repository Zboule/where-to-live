// Place-cost explorer: "how much equity do I need to relocate to this place?"
//
// A FOCUSED sibling of the full forecast: it deliberately ignores the family's
// current wealth trajectory (salaries, other properties, cash buffer) and
// answers, for one destination city and a chosen relocation year:
//   • what the destination life costs, year by year (living + mortgage + holding);
//   • what the home is worth over time (price projected to the purchase year,
//     LTV-preserving mortgage — same rules as the main engine's relocation);
//   • what equity portfolio, invested at a chosen return, sustains it.
//
// Equity modes:
//   fire      — smallest portfolio at the move whose returns cover ALL costs
//               (living + mortgage + holding + city taxes) without the balance
//               ever decreasing over the horizon;
//   mortgage  — same, but the portfolio only carries the mortgage payments
//               (a salary is assumed to cover life);
//   free      — the user supplies the equity at the move; we show what happens.
//
// City taxes come from the same sources as the main engine: the per-city
// wealth tax (scenarios.ts CITIES) and the per-country equity CGT (tax.ts),
// with the cost basis stepped up at the move.

import { listConfigGroups, loadFinanceConfig } from './config';
import type { Selection } from './config';
import { CITIES } from './scenarios';
import { livingEngineItems } from './livingPresets';
import type { City } from './scenarios';
import { childBenefit2Kids, equityCgtRate, isTaxCountry, taxForGross } from './tax';
import { sweGrossSalary } from './swe';
import type { SweTier } from './swe';
import { buildExpenseSchedule, mortgageAt } from './engine';
import type { ExpenseConfig, RealEstateConfig, WealthTaxConfig } from './types';

export type EquityMode = 'fire' | 'mortgage' | 'free';
export type HomeSize = '3bed' | 'comfortable' | 'premium';
/** Quality of the destination life — picks the city's living variant or its
 *  `-simple` sibling (same knob as the Finance tab's "Abroad" toggle). */
export type DestMode = 'comfortable' | 'simple';

export interface PlaceCostParams {
  city: string;
  /** Horizon in years from the base year (chart span). */
  years?: number;
  /** Relocation year (any calendar year within the horizon). */
  moveYear?: number;
  homeSize?: HomeSize;
  destMode?: DestMode;
  equityMode?: EquityMode;
  /** Equity at the move, base currency — only for mode 'free'. */
  equityAmount?: number;
  /** Annual expected return on the equity portfolio (decimal). */
  equityReturn?: number;
  /** Override the destination living items (preview an unsaved edit). */
  livingItems?: ExpenseConfig[];
}

export interface PlaceCostYear {
  year: number;
  /** Destination cost of living for the year (0 before the move), base ccy. */
  living: number;
  livingItems: { id: string; name: string; category: string; amount: number }[];
  mortgagePayment: number;
  mortgageInterest: number;
  mortgagePrincipal: number;
  holdingCosts: number;
  /** Projected market value — tracked from the base year even before the buy. */
  homeValue: number;
  /** End-of-year mortgage balance (0 before the move). */
  mortgageBalance: number;
  /** homeValue − mortgageBalance after the purchase, 0 before. */
  homeEquity: number;
  /** Equity portfolio for the year; null before the move. */
  portfolio: {
    opening: number;
    growth: number;
    wealthTax: number;
    cgt: number;
    /** Net spend withdrawn = withdrawnLiving + withdrawnHome. */
    withdrawal: number;
    withdrawnLiving: number;
    /** Mortgage payments (+ holding costs outside 'mortgage' mode). */
    withdrawnHome: number;
    closing: number;
  } | null;
}

export interface PlaceCostResult {
  city: { id: string; label: string; country: string; currency: string };
  baseCurrency: string;
  baseYear: number;
  years: number;
  moveYear: number;
  homeSize: HomeSize;
  equityMode: EquityMode;
  equityReturn: number;
  home: {
    name: string;
    variant: string;
    priceAtBase: number;
    priceAtMove: number;
    acquisitionCosts: number;
    mortgagePrincipal: number;
    downPayment: number;
    /** downPayment + acquisitionCosts — the cash the purchase itself burns. */
    purchaseCashOut: number;
    appreciationRate: number;
    mortgageRate: number;
    currency: string;
  };
  /** Equity needed AT the move: purchase cash + the sustaining portfolio.
   *  `portfolio` is null when the mode is unsatisfiable at any size. */
  requiredEquity: { total: number | null; portfolio: number | null; purchaseCashOut: number };
  wealthTax: { label: string; rate: number; threshold: number } | null;
  cgtRate: number;
  yearly: PlaceCostYear[];
  warnings: string[];
}

const HOME_ENTITY = 'real-estate:relocation_home';
const LIVING_ENTITY = 'expenses:destination_living';
/** Portfolio sizes above this are treated as "no finite answer". */
const PORTFOLIO_CAP = 1e9;

export function cityById(id: string): City | undefined {
  return CITIES.find((c) => c.id === id);
}

// ---------------------------------------------------------------------------
// Cross-city summary: the required equity per (city, move year) for the two
// self-sustaining modes — the "which city can we afford, when" comparison.
// ---------------------------------------------------------------------------

export interface PlaceCostSummaryParams {
  /** City ids; defaults to all. */
  cities?: string[];
  moveYears: number[];
  homeSize?: HomeSize;
  destMode?: DestMode;
  equityReturn?: number;
  /** SWE tier for the income comparison — the user is top-tier, so 'top' is the default. */
  sweTier?: SweTier;
  /** Sustainability window after the move (keeps the bar comparable across
   *  move years — the horizon shifts with the move). */
  postMoveYears?: number;
}

export interface RequiredEquity {
  total: number | null;
  portfolio: number | null;
  purchaseCashOut: number;
}

export interface PlaceCostSummary {
  baseCurrency: string;
  baseYear: number;
  homeSize: HomeSize;
  destMode: DestMode;
  equityReturn: number;
  /** General price inflation — the UI's "keep equity growing at inflation" rule. */
  inflationRate: number;
  postMoveYears: number;
  cities: {
    id: string;
    label: string;
    /** ISO-ish country code of the relocation home (AT, PT, AU, …). */
    country: string;
    /** Destination wealth tax on the equity portfolio (base ccy threshold). */
    wealthTax: { rate: number; threshold: number } | null;
    /** Realised-gains tax rate on equity withdrawals (0 if none). */
    cgtRate: number;
    years: Record<
      number,
      {
        fire: RequiredEquity;
        mortgage: RequiredEquity;
        /** Destination cost of living in the move year (base ccy/yr). */
        livingYr: number;
        /** Mortgage payments in the move year for THIS home tier (base ccy/yr). */
        mortgagePaymentYr: number;
        /** Home holding costs (property tax + maintenance) in the move year (base ccy/yr). */
        holdingYr: number;
        /** Cash pulled from equity to buy this tier's home (down payment + costs). */
        purchaseCashOut: number;
        /** SWE net income (chosen tier) + child benefits for 2 kids, in the
         *  move year (base ccy/yr; null if unmodeled). */
        sweNetIncome: number | null;
      }
    >;
  }[];
}

export function computePlaceCostSummary(params: PlaceCostSummaryParams): PlaceCostSummary {
  const homeSize = params.homeSize ?? 'comfortable';
  const destMode = params.destMode ?? 'comfortable';
  const equityReturn = params.equityReturn ?? 0.05;
  const sweTier: SweTier = params.sweTier ?? 'top';
  const postMoveYears = Math.max(5, Math.min(40, params.postMoveYears ?? 25));
  const cities = params.cities?.length
    ? params.cities.map((id) => {
        const c = cityById(id);
        if (!c) throw new Error(`unknown city "${id}"`);
        return c;
      })
    : CITIES;
  if (!params.moveYears.length) throw new Error('moveYears required');

  const cfg0 = loadFinanceConfig({});
  const meta = cfg0.meta;
  const baseCurrency = meta.base_currency;
  const baseYear = new Date(meta.base_date).getUTCFullYear();
  const toBase0 = (v: number, ccy: string): number =>
    (v * (cfg0.fx_rates[ccy] ?? 1)) / cfg0.fx_rates[baseCurrency];
  const out = cities.map((c) => {
    const years: PlaceCostSummary['cities'][number]['years'] = {};
    let country = '';
    let wealthTax: { rate: number; threshold: number } | null = null;
    let cgtRate = 0;
    for (const moveYear of params.moveYears) {
      const run = (equityMode: EquityMode): PlaceCostResult =>
        computePlaceCost({
          city: c.id,
          moveYear,
          homeSize,
          destMode,
          equityMode,
          equityReturn,
          // horizon = up to the move + the fixed post-move window
          years: Math.max(2, moveYear - baseYear) + postMoveYears,
        });
      const fire = run('fire');
      const mortgage = run('mortgage');
      country = fire.city.country;
      wealthTax = fire.wealthTax ? { rate: fire.wealthTax.rate, threshold: fire.wealthTax.threshold } : null;
      cgtRate = fire.cgtRate;
      const moveRow = fire.yearly.find((y) => y.year === fire.moveYear);
      // SWE income at the chosen tier (default: top — staff/principal at
      // strong companies), net of the destination's progressive tax, base ccy
      let sweNetIncome: number | null = null;
      if (isTaxCountry(country)) {
        const gross = sweGrossSalary(country, sweTier, moveYear, meta.inflation_rate);
        // child benefits are indexed like everything else in the model
        const benefits =
          childBenefit2Kids(country) * Math.pow(1 + meta.inflation_rate, moveYear - baseYear);
        sweNetIncome = toBase0(gross - taxForGross(country, gross) + benefits, fire.city.currency);
      }
      years[moveYear] = {
        fire: fire.requiredEquity,
        mortgage: mortgage.requiredEquity,
        livingYr: moveRow?.living ?? 0,
        mortgagePaymentYr: moveRow?.mortgagePayment ?? 0,
        holdingYr: moveRow?.holdingCosts ?? 0,
        purchaseCashOut: fire.requiredEquity.purchaseCashOut,
        sweNetIncome,
      };
    }
    return { id: c.id, label: c.label, country, wealthTax, cgtRate, years };
  });

  return {
    baseCurrency,
    baseYear,
    homeSize,
    destMode,
    equityReturn,
    inflationRate: meta.inflation_rate,
    postMoveYears,
    cities: out,
  };
}

function variantFor(base: string, size: HomeSize): string {
  return size === 'comfortable' ? base : `${base}-${size}`;
}

/** Yearly wealth-tax due on a portfolio balance (base ccy). */
function wealthTaxOn(
  balance: number,
  wt: WealthTaxConfig | undefined,
  toBase: (v: number, ccy: string) => number,
  baseCcy: string,
): number {
  if (!wt) return 0;
  const threshold = toBase(wt.threshold ?? 0, wt.currency ?? baseCcy);
  return Math.max(0, balance - threshold) * wt.rate;
}

export function computePlaceCost(params: PlaceCostParams): PlaceCostResult {
  const city = cityById(params.city);
  if (!city) throw new Error(`unknown city "${params.city}"`);
  const homeSize: HomeSize = params.homeSize ?? 'comfortable';
  const destMode: DestMode = params.destMode ?? 'comfortable';
  const equityMode: EquityMode = params.equityMode ?? 'fire';
  const equityReturn = params.equityReturn ?? 0.05;
  const warnings: string[] = [];

  const homeVariant = variantFor(city.home, homeSize);
  // simple life = the city's `-simple` living sibling, when it exists
  let livingVariant = city.living;
  if (destMode === 'simple') {
    const variants = listConfigGroups().find((g) => g.key === LIVING_ENTITY)?.variants ?? [];
    if (variants.some((v) => v.id === `${city.living}-simple`)) livingVariant = `${city.living}-simple`;
    else warnings.push(`No simple living budget for ${city.label} — using the comfortable one.`);
  }
  const selection: Selection = {
    groups: { [HOME_ENTITY]: homeVariant, [LIVING_ENTITY]: livingVariant },
    enabled: [HOME_ENTITY, LIVING_ENTITY],
  };
  const cfg = loadFinanceConfig(selection);
  const toBase = (v: number, ccy: string): number => v * (cfg.fx_rates[ccy] ?? 1) / cfg.fx_rates[cfg.meta.base_currency];

  const home = (cfg.assets?.real_estate ?? []).find((r) => r.id === 'relocation_home') as
    | RealEstateConfig
    | undefined;
  if (!home) throw new Error(`relocation home variant ${homeVariant} not found`);

  const baseYear = new Date(cfg.meta.base_date).getUTCFullYear();
  const years = Math.max(2, Math.min(60, params.years ?? 20));
  const endYear = baseYear + years - 1;
  const moveYear = Math.max(baseYear, Math.min(endYear, params.moveYear ?? baseYear + 4));
  if (params.moveYear != null && params.moveYear !== moveYear)
    warnings.push(`Relocation year clamped to ${moveYear} (horizon ${baseYear}–${endYear}).`);

  // ---- home: price projected to the move (same rule as the main engine:
  // grow from base_date, mortgage principal + interest-only floor keep LTV) ----
  const growAt = (year: number) => Math.pow(1 + home.appreciation_rate, year - baseYear);
  const g = growAt(moveYear);
  const priceAtBase = toBase(home.current_value, home.currency);
  const priceAtMove = priceAtBase * g;
  const acquisitionCosts = toBase(home.purchase.acquisition_costs ?? 0, home.currency) * g;
  const mortgagePrincipal = toBase(home.mortgage.principal, home.currency) * g;
  const downPayment = Math.max(0, priceAtMove - mortgagePrincipal);
  const purchaseCashOut = downPayment + acquisitionCosts;

  // Mortgage shifted to the move (term + rates preserved), like the engine does.
  const termMonths = (() => {
    const first = new Date(home.mortgage.first_payment_date);
    const last = new Date(home.mortgage.last_payment_date);
    return (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + (last.getUTCMonth() - first.getUTCMonth()) + 1;
  })();
  const io = home.mortgage.interest_only;
  const mortgage = {
    ...home.mortgage,
    principal: home.mortgage.principal * g,
    ...(io ? { interest_only: { ...io, floor: io.floor * g } } : {}),
    first_payment_date: `${moveYear}-02-01`,
    last_payment_date: (() => {
      const end = new Date(Date.UTC(moveYear, 1, 1));
      end.setUTCMonth(end.getUTCMonth() + termMonths - 1);
      return `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-01`;
    })(),
  };
  /** Sum of the 12 payments of calendar `year`, plus the end-of-year balance (base ccy). */
  const mortgageYear = (year: number) => {
    let interest = 0;
    let principal = 0;
    for (let m = 0; m < 12; m++) {
      const st = mortgageAt(mortgage, new Date(Date.UTC(year, m, 15)));
      interest += st.interestThisMonth;
      principal += st.principalThisMonth;
    }
    const endState = mortgageAt(mortgage, new Date(Date.UTC(year, 11, 31)));
    return {
      interest: toBase(interest, home.currency),
      principal: toBase(principal, home.currency),
      balance: toBase(endState.balance, home.currency),
    };
  };

  // ---- destination living, holding costs ----
  // living items come from the UI-managed preset store (seeded from the YAML),
  // so edits in the "Edit life" modal drive the cost of living; an explicit
  // override (params.livingItems) wins, for previewing an unsaved edit.
  const livingItems: ExpenseConfig[] =
    params.livingItems ?? livingEngineItems(city.id, destMode, baseYear);
  const livingSchedules = livingItems.map((e) => ({
    e,
    schedule: buildExpenseSchedule(e, baseYear, years, cfg.meta.inflation_rate),
  }));
  const holdingAt = (year: number): number => {
    const hc = home.holding_costs;
    if (!hc) return 0;
    const infl = hc.grows_with === 'none' ? 1 : Math.pow(1 + cfg.meta.inflation_rate, year - baseYear);
    return toBase(((hc.local_property_tax ?? 0) + (hc.building_maintenance ?? 0) + (hc.unit_maintenance ?? 0)) * infl, home.currency);
  };

  const cgtRate = equityCgtRate(home.country);
  const wt = city.wealthTax;

  // Pre-compute the yearly cost rows once — the equity simulation replays them.
  interface CostRow { year: number; living: number; items: PlaceCostYear['livingItems']; mi: number; mp: number; holding: number; balance: number }
  const costRows: CostRow[] = [];
  for (let i = 0; i < years; i++) {
    const year = baseYear + i;
    const owned = year >= moveYear;
    const items = owned
      ? livingSchedules.map(({ e, schedule }) => ({
          id: e.id,
          name: e.name,
          category: e.category ?? 'Other',
          amount: toBase(schedule[i + 1] ?? 0, e.currency),
        }))
      : [];
    const mort = owned ? mortgageYear(year) : { interest: 0, principal: 0, balance: 0 };
    costRows.push({
      year,
      living: items.reduce((s, it) => s + it.amount, 0),
      items,
      mi: mort.interest,
      mp: mort.principal,
      holding: owned ? holdingAt(year) : 0,
      balance: mort.balance,
    });
  }

  /** Simulate the portfolio from the move with opening balance E.
   *  Returns the per-year rows and the worst year-over-year delta. */
  const simulate = (E: number) => {
    const rows: (PlaceCostYear['portfolio'] | null)[] = [];
    let v = E;
    let basis = E; // cost basis stepped up at the move (engine rule)
    let worstDelta = Infinity;
    for (const row of costRows) {
      if (row.year < moveYear) {
        rows.push(null);
        continue;
      }
      const opening = v;
      const growth = opening * equityReturn;
      const wtax = wealthTaxOn(opening, wt, toBase, cfg.meta.base_currency);
      const livingCost = equityMode === 'mortgage' ? 0 : row.living;
      const homeCost = row.mi + row.mp + (equityMode === 'mortgage' ? 0 : row.holding);
      const cost = livingCost + homeCost;
      // Everything leaving the portfolio (spend + wealth tax) is a sale, so the
      // whole outflow is grossed up for CGT on its gain share (proportional basis).
      const need = cost + wtax;
      const value = opening + growth;
      const gainFrac = value > 0 ? Math.max(0, (value - basis) / value) : 0;
      const denom = 1 - gainFrac * cgtRate;
      const grossOut = denom > 0 ? Math.min(need / denom, value) : value;
      const cgt = grossOut * gainFrac * cgtRate;
      basis = Math.max(0, basis - grossOut * (1 - gainFrac));
      v = Math.max(0, value - grossOut);
      worstDelta = Math.min(worstDelta, v - opening);
      // report the components: spend withdrawal + wealth tax + cgt = grossOut.
      // If the portfolio ran dry (grossOut capped at value) the spend is only
      // partially funded — scale the living/home split to what was actually paid.
      const paid = Math.max(0, grossOut - wtax - cgt);
      const scale = cost > 0 ? Math.min(1, paid / cost) : 0;
      rows.push({
        opening,
        growth,
        wealthTax: wtax,
        cgt,
        withdrawal: paid,
        withdrawnLiving: livingCost * scale,
        withdrawnHome: homeCost * scale,
        closing: v,
      });
    }
    return { rows, worstDelta };
  };

  // ---- required portfolio at the move ----
  let portfolioAtMove: number | null;
  if (equityMode === 'free') {
    const total = Math.max(0, params.equityAmount ?? 0);
    portfolioAtMove = Math.max(0, total - purchaseCashOut);
    if (total < purchaseCashOut)
      warnings.push(
        `The equity provided does not cover the purchase itself (down payment + costs). The portfolio starts empty.`,
      );
  } else {
    // Smallest E whose balance never decreases over the horizon (bisection —
    // the worst delta is monotone in E as long as growth outpaces the taxes).
    let lo = 0;
    let hi = Math.max(1e5, costRows[costRows.length - 1].living * 40);
    while (simulate(hi).worstDelta < 0 && hi < PORTFOLIO_CAP) hi *= 2;
    if (simulate(hi).worstDelta < 0) {
      portfolioAtMove = null;
      warnings.push(
        `No portfolio size sustains this at a ${(equityReturn * 100).toFixed(1)}% return — costs grow faster than the net return.`,
      );
    } else {
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (simulate(mid).worstDelta >= -1e-6) hi = mid;
        else lo = mid;
      }
      portfolioAtMove = hi;
    }
  }

  const { rows: portfolioRows } = simulate(portfolioAtMove ?? 0);

  const yearly: PlaceCostYear[] = costRows.map((row, i) => ({
    year: row.year,
    living: row.living,
    livingItems: row.items,
    mortgagePayment: row.mi + row.mp,
    mortgageInterest: row.mi,
    mortgagePrincipal: row.mp,
    holdingCosts: row.holding,
    homeValue: priceAtBase * growAt(row.year + 1), // end-of-year value
    mortgageBalance: row.balance,
    homeEquity: row.year >= moveYear ? Math.max(0, priceAtBase * growAt(row.year + 1) - row.balance) : 0,
    portfolio: portfolioRows[i],
  }));

  return {
    city: { id: city.id, label: city.label, country: home.country, currency: home.currency },
    baseCurrency: cfg.meta.base_currency,
    baseYear,
    years,
    moveYear,
    homeSize,
    equityMode,
    equityReturn,
    home: {
      name: home.name,
      variant: homeVariant,
      priceAtBase,
      priceAtMove,
      acquisitionCosts,
      mortgagePrincipal,
      downPayment,
      purchaseCashOut,
      appreciationRate: home.appreciation_rate,
      mortgageRate: home.mortgage.rate_periods[0]?.rate ?? 0,
      currency: home.currency,
    },
    requiredEquity: {
      total: portfolioAtMove == null ? null : portfolioAtMove + purchaseCashOut,
      portfolio: portfolioAtMove,
      purchaseCashOut,
    },
    wealthTax: wt
      ? {
          label: wt.label ?? 'Wealth tax',
          rate: wt.rate,
          threshold: toBase(wt.threshold ?? 0, wt.currency ?? cfg.meta.base_currency),
        }
      : null,
    cgtRate,
    yearly,
    warnings,
  };
}
