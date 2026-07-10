// Progressive income-tax brackets for the relocation destinations, so a salary's NET can
// be grossed up at the REAL effective rate for its size (a €40k salary and a €300k salary
// face very different rates). Approximate 2025 schedules in LOCAL currency, annual — good
// enough for a forecast, easy to refine. Only the countries we actually model are here.

export type TaxCountry =
  | 'NL' | 'AT' | 'CH' | 'FR' | 'DE' | 'BE'
  | 'ES' | 'PT' | 'CZ' | 'DK' | 'AU' | 'FI'
  | 'LU' | 'SI' | 'SE' | 'GB' | 'IT' | 'NZ';

interface Bracket {
  upTo: number; // marginal rate applies on income up to here (local currency, per year)
  rate: number;
}

const BRACKETS: Record<TaxCountry, Bracket[]> = {
  // Netherlands — Box 1, 2025 (wage tax + national insurance combined).
  NL: [
    { upTo: 38_441, rate: 0.3582 },
    { upTo: 76_817, rate: 0.3748 },
    { upTo: Infinity, rate: 0.495 },
  ],
  // Austria — 2025 statutory brackets.
  AT: [
    { upTo: 13_308, rate: 0 },
    { upTo: 21_617, rate: 0.2 },
    { upTo: 35_836, rate: 0.3 },
    { upTo: 69_166, rate: 0.4 },
    { upTo: 103_072, rate: 0.48 },
    { upTo: 1_000_000, rate: 0.5 },
    { upTo: Infinity, rate: 0.55 },
  ],
  // Switzerland — Vaud (Lausanne), married couple: federal + cantonal + communal combined,
  // approximate effective marginal schedule (CHF). Vaud is a higher-tax canton.
  CH: [
    { upTo: 30_000, rate: 0 },
    { upTo: 60_000, rate: 0.12 },
    { upTo: 100_000, rate: 0.2 },
    { upTo: 150_000, rate: 0.27 },
    { upTo: 250_000, rate: 0.33 },
    { upTo: 500_000, rate: 0.38 },
    { upTo: Infinity, rate: 0.41 },
  ],
  // France — approximate effective marginal schedule for a married household (EUR): the
  // 2025 barème de l'IR (quotient familial ~2 parts) plus a slug for deductible CSG/CRDS.
  FR: [
    { upTo: 20_000, rate: 0.06 },
    { upTo: 60_000, rate: 0.21 },
    { upTo: 170_000, rate: 0.33 },
    { upTo: 360_000, rate: 0.43 },
    { upTo: Infinity, rate: 0.48 },
  ],
  // Germany — approximate married (Ehegattensplitting) schedule incl. employee social
  // contributions (capped at the high end, so the top rate plateaus). 2025-ish, EUR.
  DE: [
    { upTo: 24_000, rate: 0.08 },
    { upTo: 70_000, rate: 0.28 },
    { upTo: 140_000, rate: 0.38 },
    { upTo: 300_000, rate: 0.44 },
    { upTo: Infinity, rate: 0.47 },
  ],
  // Belgium — among the highest; federal brackets + ~13% employee social + ~7% communal
  // surcharge folded into an approximate household effective schedule. 2025-ish, EUR.
  BE: [
    { upTo: 20_000, rate: 0.25 },
    { upTo: 50_000, rate: 0.45 },
    { upTo: 120_000, rate: 0.52 },
    { upTo: Infinity, rate: 0.55 },
  ],
  // Spain (Madrid; the Basque foral schedule is close enough at these sizes) — state +
  // regional IRPF plus employee social security (~6.5%, capped ~€60k), household-effective. EUR.
  ES: [
    { upTo: 15_000, rate: 0.13 },
    { upTo: 35_000, rate: 0.3 },
    { upTo: 60_000, rate: 0.37 },
    { upTo: 130_000, rate: 0.43 },
    { upTo: 300_000, rate: 0.46 },
    { upTo: Infinity, rate: 0.47 },
  ],
  // Portugal — IRS brackets to 48% + solidarity surtax (2.5% > €80k, 5% > €250k) and the
  // UNCAPPED 11% employee social security folded into an approximate schedule. EUR.
  PT: [
    { upTo: 10_000, rate: 0.15 },
    { upTo: 30_000, rate: 0.32 },
    { upTo: 80_000, rate: 0.44 },
    { upTo: 250_000, rate: 0.53 },
    { upTo: Infinity, rate: 0.56 },
  ],
  // Czechia — 15% to ~36× the average wage, 23% above, plus employee social + health
  // (~11%) and the basic personal credit folded in. CZK (local currency!).
  CZ: [
    { upTo: 300_000, rate: 0.11 },
    { upTo: 1_600_000, rate: 0.26 },
    { upTo: Infinity, rate: 0.34 },
  ],
  // Denmark — AM-bidrag 8% + bottom/municipal ~37% and top tax, capped by the marginal
  // ceiling (~52% + AM ≈ 55.9%). Approximate household schedule. DKK (local currency!).
  DK: [
    { upTo: 55_000, rate: 0.08 },
    { upTo: 620_000, rate: 0.42 },
    { upTo: Infinity, rate: 0.56 },
  ],
  // Australia — 2025-26 resident brackets + 2% Medicare levy. AUD (local currency!).
  AU: [
    { upTo: 18_200, rate: 0 },
    { upTo: 45_000, rate: 0.18 },
    { upTo: 135_000, rate: 0.32 },
    { upTo: 190_000, rate: 0.39 },
    { upTo: Infinity, rate: 0.47 },
  ],
  // Finland — state + municipal (~7.5% Helsinki) + church-free, plus employee pension /
  // unemployment contributions (~9%), household-effective. EUR.
  FI: [
    { upTo: 20_000, rate: 0.12 },
    { upTo: 40_000, rate: 0.32 },
    { upTo: 80_000, rate: 0.42 },
    { upTo: 150_000, rate: 0.5 },
    { upTo: Infinity, rate: 0.55 },
  ],
  // Luxembourg — class 2 (married splitting), top 42% + 1.4× solidarity ≈ 45.8%, plus
  // employee social ~12% (capped ~€12.5k/mo), household-effective. EUR.
  LU: [
    { upTo: 30_000, rate: 0.1 },
    { upTo: 70_000, rate: 0.25 },
    { upTo: 150_000, rate: 0.38 },
    { upTo: 300_000, rate: 0.44 },
    { upTo: Infinity, rate: 0.46 },
  ],
  // Slovenia — 16/26/33/39/50% brackets plus the UNCAPPED 22.1% employee social
  // contributions — among Europe's heaviest on labour. EUR.
  SI: [
    { upTo: 12_000, rate: 0.25 },
    { upTo: 30_000, rate: 0.42 },
    { upTo: 70_000, rate: 0.52 },
    { upTo: Infinity, rate: 0.58 },
  ],
  // Sweden — municipal ~32% above the basic allowance, +20% state tax above ~SEK 625k;
  // employee pension contribution is credited back. SEK (local currency!).
  SE: [
    { upTo: 60_000, rate: 0.05 },
    { upTo: 620_000, rate: 0.31 },
    { upTo: Infinity, rate: 0.51 },
  ],
  // UK (Scottish rates — Edinburgh): 19–48% Scottish income tax + employee NI 8%/2%.
  // GBP (local currency!).
  GB: [
    { upTo: 12_570, rate: 0 },
    { upTo: 45_000, rate: 0.28 },
    { upTo: 125_000, rate: 0.44 },
    { upTo: Infinity, rate: 0.49 },
  ],
  // Italy — IRPEF 23/35/43% + regional & municipal addizionali (~2.5%) + employee
  // social 9.19%, household-effective. EUR.
  IT: [
    { upTo: 15_000, rate: 0.2 },
    { upTo: 28_000, rate: 0.32 },
    { upTo: 50_000, rate: 0.45 },
    { upTo: Infinity, rate: 0.52 },
  ],
  // New Zealand — 2024-25 brackets (10.5→39%) + ACC earner levy ~1.6%. NZD (local currency!).
  NZ: [
    { upTo: 15_600, rate: 0.12 },
    { upTo: 53_500, rate: 0.19 },
    { upTo: 78_100, rate: 0.32 },
    { upTo: 180_000, rate: 0.35 },
    { upTo: Infinity, rate: 0.4 },
  ],
};

export function isTaxCountry(c: string | undefined): c is TaxCountry {
  return c != null && c in BRACKETS;
}

// Realised capital-gains tax on a SECURITIES portfolio, by tax residence. Applied to the
// GAIN portion of a post-move drawdown. The family steps up their cost basis at the move
// (liquidating/rebalancing while still UAE-resident), so only gains accruing AFTER the move
// are taxed — see the engine's basis step-up. Rate 0 ⇒ no realisation CGT for that country.
const EQUITY_CGT: Record<string, number> = {
  FR: 0.30, // PFU "flat tax" (12.8% income + 17.2% social charges)
  DE: 0.264, // Abgeltungsteuer 25% + 5.5% Soli (church tax ignored)
  AT: 0.275, // KESt on securities
  BE: 0.10, // 2026 "solidarity contribution" on realised financial gains (€10k/person/yr exemption ignored — slightly conservative)
  NL: 0, // taxed via the Box 3 deemed-return wealth tax instead — no realisation CGT
  CH: 0, // no CGT on private capital gains
  ES: 0.27, // savings-income bands 19–28%; a large portfolio's gains mostly at 27–28%
  PT: 0.28, // flat 28% on securities gains (long-holding partial exclusions ignored — conservative)
  CZ: 0, // 3-year time test: securities held >3 yrs are exempt — a long-term portfolio pays none
  DK: 0.42, // aktieindkomst 27% below ~DKK 63k/yr/person, 42% above — big drawdowns sit at 42%
  AU: 0.235, // top marginal ~47% incl. Medicare × the 50% CGT discount for >12-month holdings
  FI: 0.34, // capital income 30% to €30k/yr, 34% above — large drawdowns sit at 34%
  LU: 0, // securities held >6 months are fully exempt — a buy-and-hold portfolio pays none
  SI: 0.2, // 25% base tapering 20% (5y) / 15% (10y) / 0% (15y+) — ~20% fits a FIRE drawdown's holding mix
  SE: 0, // no realisation CGT inside an ISK — the ~1%/yr deemed tax is modeled as a wealth tax instead
  GB: 0.24, // UK CGT on shares (2025-26 higher rate), annual exempt amount ignored
  IT: 0.26, // 26% flat on financial gains (plus IVAFE 0.2%/yr, modeled as a wealth tax)
  NZ: 0, // New Zealand has no general capital-gains tax
};

// Annual child benefit for TWO school-age children at a HIGH-EARNER household
// (means-tested schemes → 0), local currency, ~2026 levels. Universal schemes
// (DE Kindergeld, SE barnbidrag, LU allocations…) pay regardless of income;
// FR halves-then-quarters above the ceilings; GB's HICBC claws back fully
// above £80k; AU/NZ/PT/CZ-cash are income-tested away (CZ keeps the child TAX
// credit, modeled here as its cash equivalent).
const CHILD_BENEFIT_2KIDS: Record<string, number> = {
  NL: 2_600, // kinderbijslag, universal
  AT: 4_800, // Familienbeihilfe + Kinderabsetzbetrag, universal
  CH: 7_200, // Vaud allocations familiales (CHF 300/mo/child), universal
  FR: 500, // allocations familiales quartered above the high-income ceiling
  DE: 6_120, // Kindergeld €255/mo/child, universal
  BE: 4_300, // Groeipakket base amounts, universal
  ES: 0, // no universal cash benefit (child allowances live inside IRPF)
  PT: 0, // abono de família is income-tested away at this earnings level
  CZ: 37_000, // CZK — daňové zvýhodnění (child tax credits), not income-tested
  DK: 24_000, // DKK — børne/ungeydelse, mildly tapered at the top (approx.)
  AU: 0, // Family Tax Benefit fully income-tested away
  FI: 2_500, // lapsilisä incl. 2nd-child supplement, universal
  LU: 7_700, // allocation pour l'avenir des enfants + rentrée scolaire, universal
  SI: 1_000, // cash benefit income-tested away; child tax allowance ≈ this net
  SE: 31_800, // SEK — barnbidrag + flerbarnstillägg, universal
  GB: 0, // Child Benefit fully clawed back (HICBC) above £80k
  IT: 1_400, // Assegno Unico at the high-ISEE floor (€57/mo/child)
  NZ: 0, // Working for Families fully abated at this income
};

/** Yearly child benefit for two school-age kids at a high-earner household
 *  (local currency, base-2026 level — index with inflation for later years). */
export function childBenefit2Kids(country: string | undefined): number {
  return (country != null && CHILD_BENEFIT_2KIDS[country]) || 0;
}

/** Realised-gains tax rate on a securities portfolio for a tax residence (0 if none). */
export function equityCgtRate(country: string | undefined): number {
  return (country != null && EQUITY_CGT[country]) || 0;
}

/** Income tax on an annual `gross` (local currency) under the country's progressive brackets. */
export function taxForGross(country: TaxCountry, gross: number): number {
  let tax = 0;
  let lower = 0;
  for (const b of BRACKETS[country]) {
    if (gross <= lower) break;
    tax += (Math.min(gross, b.upTo) - lower) * b.rate;
    lower = b.upTo;
  }
  return tax;
}

/** Inverse: the annual gross (local currency) whose after-tax take-home equals `net`. */
export function grossForNet(country: TaxCountry, net: number): number {
  if (net <= 0) return 0;
  let lower = 0;
  let taxSoFar = 0;
  for (const b of BRACKETS[country]) {
    const netAtLower = lower - taxSoFar; // take-home at this bracket's lower gross bound
    const netAtUpper = b.upTo === Infinity ? Infinity : b.upTo - (taxSoFar + (b.upTo - lower) * b.rate);
    if (net <= netAtUpper) {
      // net = netAtLower + (gross − lower)·(1 − rate)  →  solve for gross
      return lower + (net - netAtLower) / (1 - b.rate);
    }
    taxSoFar += (b.upTo - lower) * b.rate;
    lower = b.upTo;
  }
  return lower;
}
