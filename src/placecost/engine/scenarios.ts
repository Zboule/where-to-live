// Named scenario presets — the top-of-page selector. A scenario bundles a base
// `Selection` (which section entities are on, at which variant) with a few plan-level
// overrides the per-section pickers can't express (turn the FIRE retirement off, apply
// a destination wealth tax from the move date). The per-section pickers still layer on
// top, so you can fine-tune (salary best/bad, returns) WITHIN a chosen scenario.
//
// Two families:
//   • FIRE — the existing dynamic "retire in Amsterdam" plan (date is an output).
//   • RELOCATION — a FIXED 2030 move (the oldest child turns 6) to the kids' "growing
//     place": buy a ~250 m² family home with a mortgage, keep earning a local income so
//     the equities keep compounding, keep Dublin + the Yerevan complex. Each destination
//     is one preset; the city sets the home/income/expense variants + the wealth tax.

import { loadFinanceConfig } from './config';
import type { Selection } from './config';
import type { FinanceConfig, WealthTaxConfig } from './types';

export interface ScenarioPlan {
  /** Force the FIRE retirement block off (relocation isn't a retire plan). */
  retirementEnabled?: boolean;
  /** Destination wealth tax applied from the move date (none for Austria). */
  wealthTax?: WealthTaxConfig;
  /** Fixed move year (the "Relocate 2030 / 2032" presets). Omit => "Auto": the move date
   *  is the dynamic output of the equity-sustainability trigger. */
  fixedMoveYear?: number;
  /** The move year, for the headline (the fixed year, or undefined when Auto). */
  moveYear?: number;
  /** Destination city, for the headline. */
  destinationLabel?: string;
  /** "Auto FIRE" timing: the move waits until the portfolio yield + net rent cover the full
   *  post-move spend, and the local salary is suppressed (true financial independence). */
  fire?: boolean;
}

export interface Scenario {
  id: string;
  label: string;
  kind: 'fire' | 'relocation';
  /** Base selection: entities switched on + their city variants. */
  selection: Selection;
  plan: ScenarioPlan;
}

export const DEFAULT_SCENARIO = 'plan';
const MOVE_FROM = '2031-01-01'; // move at end of 2030 → destination tax-residency from 2031

// Destination wealth taxes (applied to the financial portfolio from the move date; real
// estate — incl. the Yerevan complex and the primary home — is outside the base).
const NL_BOX3: WealthTaxConfig = { rate: 0.0212, threshold: 115368, currency: 'EUR', active_from: MOVE_FROM, label: 'Wealth tax (Box 3)' };
const VAUD: WealthTaxConfig = { rate: 0.007, threshold: 100000, currency: 'CHF', active_from: MOVE_FROM, label: 'Wealth tax (Vaud)' };
// Belgium: no net-wealth tax, BUT the annual "taxe sur les comptes-titres" (TACT) hits a
// securities account averaging >€1M at 0.30% (the rate from 1 Jun 2026) — a real drag on the
// portfolio, modelled here as a wealth tax. (Belgium's new 10% CGT on realised gains from 2026
// is a transaction tax, not a holding tax, so it's out of scope for this annual levy.)
const BE_TACT: WealthTaxConfig = { rate: 0.003, threshold: 1000000, currency: 'EUR', active_from: MOVE_FROM, label: 'Securities-account tax' };
// Spain (common regime, Madrid): the regional wealth tax is 100% rebated in Madrid, BUT the
// national "solidarity" tax (ITSGF) claws it back above ~€3M per person (1.7%→3.5% bands).
// Approximated as a flat 1.7% above a couple-level €6M (2×3M bands incl. allowances).
const ES_SOLIDARITY: WealthTaxConfig = { rate: 0.017, threshold: 6_000_000, currency: 'EUR', active_from: MOVE_FROM, label: 'Solidarity wealth tax' };
// Basque Country (Gipuzkoa, San Sebastián): its own foral wealth tax, ~0.25–1.5% progressive
// above €700k/person (primary home partly exempt). Approximated at an effective 0.6% above
// the couple's €1.4M allowance.
const GIPUZKOA: WealthTaxConfig = { rate: 0.006, threshold: 1_400_000, currency: 'EUR', active_from: MOVE_FROM, label: 'Wealth tax (Gipuzkoa)' };
// Sweden: no CGT inside an ISK — instead a flat DEEMED tax of ~0.9%/yr on the account value
// (govt borrowing rate + 1%, × 30%), above the tax-free allowance (SEK 300k/person from 2026).
// Exactly a wealth tax, so it's modeled as one.
const SE_ISK: WealthTaxConfig = { rate: 0.009, threshold: 600_000, currency: 'SEK', active_from: MOVE_FROM, label: 'ISK deemed tax' };
// Italy: IVAFE — 0.2%/yr on foreign-held financial assets (no threshold worth modeling).
const IT_IVAFE: WealthTaxConfig = { rate: 0.002, threshold: 0, currency: 'EUR', active_from: MOVE_FROM, label: 'IVAFE (foreign assets)' };
// Austria, France, Germany: no net-wealth tax on the financial portfolio → no entry. (France's
// IFI taxes REAL ESTATE only; the equities portfolio is fully exempt. Germany levies none.)
// Portugal (AIMI is real-estate-only), Czechia, Denmark, Australia, Finland, Luxembourg,
// Slovenia, the UK and New Zealand levy no net-wealth tax on a securities portfolio either —
// where there's a drag it's the CGT (tax.ts).

/** Base selection for a relocation scenario: turn the three relocation entities on, point
 *  them at the city's variants, end the UAE salary at the move, wind the UAE budget down.
 *  (The Yerevan complex is off by default globally, so it's simply not part of this.) */
function relocate(home: string, living: string): Selection {
  return {
    groups: {
      'real-estate:relocation_home': home,
      // income:relocation_income defaults to 'default' (Auto) and income:jordane_salary to
      // 'default' (Good). The user picks the UAE income (Good / Bad) and the post-move mode
      // (Auto / Average SWE / Top SWE) from the income dropdowns; the local income's
      // country/currency follow the destination home, so neither is set per-city here.
      'expenses:destination_living': living,
    },
    enabled: ['real-estate:relocation_home', 'income:relocation_income', 'expenses:destination_living'],
  };
}

// The DESTINATIONS (cities). Each sets the home + living variants and the wealth tax, and
// (future) any country-specific extras to enable (e.g. an Armenian real-estate holding to
// optimise a NL plan). These are picked by the top "City" selector.
export interface City { id: string; label: string; home: string; living: string; wealthTax?: WealthTaxConfig; extras?: string[]; }
export const CITIES: City[] = [
  // Labels are "District (City)" — each pinned to the city's best-ranked district in src/places
  // (the Kid-Raising Score). Amersfoort has no scored district, so it stays city-level; Versailles
  // is its own district. Vienna keeps Hietzing (the user's pick; Döbling ranks marginally higher).
  { id: 'amsterdam', label: 'Oud-Zuid (Amsterdam)', home: 'default', living: 'default', wealthTax: NL_BOX3 },
  { id: 'utrecht', label: 'Oost-Wittevrouwen (Utrecht)', home: 'utrecht', living: 'utrecht', wealthTax: NL_BOX3 },
  { id: 'amersfoort', label: 'Amersfoort', home: 'amersfoort', living: 'amersfoort', wealthTax: NL_BOX3 },
  { id: 'vienna', label: 'Hietzing (Vienna)', home: 'vienna', living: 'vienna' }, // AT: no wealth tax
  { id: 'lausanne', label: 'Pully (Lausanne)', home: 'lausanne', living: 'lausanne', wealthTax: VAUD },
  { id: 'woluwe', label: 'Woluwe-Saint-Pierre (Brussels)', home: 'woluwe', living: 'woluwe', wealthTax: BE_TACT },
  { id: 'degerloch', label: 'Degerloch (Stuttgart)', home: 'degerloch', living: 'degerloch' }, // DE: no wealth tax
  { id: 'versailles', label: 'Versailles', home: 'versailles', living: 'versailles' }, // FR: IFI is real-estate-only → portfolio untaxed
  { id: 'robertsau', label: 'Robertsau (Strasbourg)', home: 'robertsau', living: 'robertsau' }, // FR: idem
  { id: 'annecy', label: 'Annecy-le-Vieux (Annecy)', home: 'annecy', living: 'annecy' }, // FR: idem
  { id: 'dinard', label: 'La Malouine (Dinard)', home: 'dinard', living: 'dinard' }, // FR: idem — sea-view house
  { id: 'madrid', label: 'El Viso (Madrid)', home: 'madrid', living: 'madrid', wealthTax: ES_SOLIDARITY },
  { id: 'sansebastian', label: 'Antiguo (San Sebastián)', home: 'sansebastian', living: 'sansebastian', wealthTax: GIPUZKOA },
  { id: 'freiburg', label: 'Herdern (Freiburg)', home: 'freiburg', living: 'freiburg' }, // DE: no wealth tax
  { id: 'lisbon', label: 'Alvalade (Lisbon)', home: 'lisbon', living: 'lisbon' }, // PT: AIMI on property handled in holding costs
  { id: 'porto', label: 'Foz do Douro (Porto)', home: 'porto', living: 'porto' }, // PT: idem
  { id: 'prague', label: 'Vinohrady (Prague)', home: 'prague', living: 'prague' }, // CZ: no wealth tax, CGT 0 after 3y
  { id: 'copenhagen', label: 'Frederiksberg (Copenhagen)', home: 'copenhagen', living: 'copenhagen' }, // DK: no wealth tax; 42% share-income CGT bites instead
  { id: 'melbourne', label: 'Camberwell (Melbourne)', home: 'melbourne', living: 'melbourne' }, // AU: no wealth tax; CGT at discounted marginal rate
  { id: 'helsinki', label: 'Munkkiniemi (Helsinki)', home: 'helsinki', living: 'helsinki' }, // FI: no wealth tax; 34% capital-income CGT
  { id: 'luxembourg', label: 'Belair (Luxembourg)', home: 'luxembourg', living: 'luxembourg' }, // LU: >6-month holdings CGT-exempt, no wealth tax
  { id: 'stockholm', label: 'Bromma (Stockholm)', home: 'stockholm', living: 'stockholm', wealthTax: SE_ISK }, // SE: ISK deemed tax instead of CGT
  { id: 'edinburgh', label: 'Morningside (Edinburgh)', home: 'edinburgh', living: 'edinburgh' }, // GB: 24% CGT, no wealth tax
  { id: 'bologna', label: 'Santo Stefano (Bologna)', home: 'bologna', living: 'bologna', wealthTax: IT_IVAFE }, // IT: 26% CGT + IVAFE
  { id: 'ljubljana', label: 'Rožna dolina (Ljubljana)', home: 'ljubljana', living: 'ljubljana' }, // SI: CGT tapers to 0 at 15y (~20% modeled)
  { id: 'christchurch', label: 'Fendalton (Christchurch)', home: 'christchurch', living: 'christchurch' }, // NZ: no CGT at all
];

// The move TIMINGS: the dynamic "Auto" (equity-sustainability trigger), "Auto FIRE" (the
// portfolio also covers living — no salary needed), and two fixed years.
export interface Timing { id: string; label: string; year?: number; fire?: boolean; }
export const TIMINGS: Timing[] = [
  { id: 'auto', label: 'Auto' }, // move when the yield can sustain the HOME (salary still covers living)
  { id: 'fire', label: 'Auto FIRE', fire: true }, // move when the yield + rent cover EVERYTHING — no salary
  { id: '2030', label: '2030', year: 2030 },
  { id: '2032', label: '2032', year: 2032 },
];

/** The scenario id for a (city, timing) pair, e.g. relocate_amsterdam_auto. */
export function scenarioIdFor(cityId: string, timingId: string): string {
  return `relocate_${cityId}_${timingId}`;
}
/** Split a scenario id back into its city + timing dimensions (for the two selectors). */
export function parseScenarioId(id: string | null | undefined): { cityId: string; timingId: string } {
  const m = /^relocate_(.+)_([^_]+)$/.exec(id ?? '');
  return m && CITIES.some((c) => c.id === m[1]) && TIMINGS.some((t) => t.id === m[2])
    ? { cityId: m[1], timingId: m[2] }
    : { cityId: CITIES[0].id, timingId: 'auto' };
}

// The BASELINE: the current Abu Dhabi life carried forward — no relocation preset
// and the FIRE retirement block OFF. This is what the Finance tab shows; the
// move exploration lives in the Place-cost tab (and the presets below stay for
// /city-summaries + the MCP tools).
const BASELINE: Scenario = { id: 'plan', label: 'Abu Dhabi, as-is', kind: 'fire', selection: {}, plan: { retirementEnabled: false } };

// The baseline, then the CITIES × TIMINGS relocation presets (FIRE retired),
// e.g. "Relocate Auto · Amsterdam".
export const SCENARIOS: Scenario[] = [
  BASELINE,
  ...CITIES.flatMap((d) =>
    TIMINGS.map((t) => ({
      id: scenarioIdFor(d.id, t.id),
      label: `Relocate ${t.label} · ${d.label}`,
      kind: 'relocation' as const,
      selection: relocate(d.home, d.living),
      plan: { retirementEnabled: false, wealthTax: d.wealthTax, fixedMoveYear: t.year, moveYear: t.year, destinationLabel: d.label, fire: t.fire },
    })),
  ),
];

export function getScenario(id?: string | null): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Merge the user's per-section overrides on top of the scenario's base selection.
 *  User picks win: an entity the user enabled is no longer disabled, and vice versa. */
function mergeSelection(base: Selection, over?: Selection): Selection {
  if (!over) return base;
  const enabled = new Set([...(base.enabled ?? []), ...(over.enabled ?? [])]);
  const disabled = new Set([...(base.disabled ?? []), ...(over.disabled ?? [])]);
  for (const k of over.enabled ?? []) disabled.delete(k);
  for (const k of over.disabled ?? []) enabled.delete(k);
  return {
    groups: { ...(base.groups ?? {}), ...(over.groups ?? {}) },
    enabled: [...enabled],
    disabled: [...disabled],
  };
}

/** The scenario's base selection merged with the user's per-section tweaks — what the
 *  config ACTUALLY uses. The UI reads this so the per-section pickers/toggles reflect the
 *  variants the scenario chose (e.g. the relocation city, the salary that ends at 2030),
 *  not just the user's deltas. */
export function effectiveSelection(scenarioId: string | null | undefined, userSelection?: Selection): Selection {
  return mergeSelection(getScenario(scenarioId).selection, userSelection);
}

/** Assemble the effective config for a scenario + the user's fine-tuning selection. */
export function applyScenario(
  scenarioId: string | null | undefined,
  userSelection?: Selection,
): { config: FinanceConfig; scenario: Scenario } {
  const scenario = getScenario(scenarioId);
  const config = loadFinanceConfig(effectiveSelection(scenarioId, userSelection));
  if (scenario.plan.retirementEnabled === false && config.retirement) config.retirement.enabled = false;
  if (scenario.plan.wealthTax) config.wealth_tax = scenario.plan.wealthTax;
  if (scenario.kind === 'relocation') {
    // The move date is a DYNAMIC OUTPUT: the engine triggers it the year after the
    // equities can fund the home's down payment AND sustain its mortgage + wealth tax
    // from returns. That date then drives the UAE→local income switch, the UAE→
    // destination expense switch, and the home purchase. (The wealth tax's static
    // `active_from` above is overridden to the computed move date by the engine.)
    config.relocation = {
      enabled: true,
      fixed_move_year: scenario.plan.fixedMoveYear, // 2030 / 2032 presets; undefined => Auto (dynamic)
      not_before: 2030, // (Auto only) don't move before 2030; the equities set the rest
      homeId: 'relocation_home',
      localIncomeId: 'relocation_income',
      postMoveExpensePrefix: 'dl_', // destination_living items (vs the UAE `household` ones)
      fire: scenario.plan.fire, // "Auto FIRE": yield+rent must cover everything; suppress the local salary
    };
  }
  return { config, scenario };
}
