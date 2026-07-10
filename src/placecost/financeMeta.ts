// Browser replacement for the family dashboard's `lib/finance` module. The page
// only needs `fetchMeta()` + the `FinanceApiMeta` type (it reads `meta.cities`).
// The original fetched the finance service's /meta; here we build the SAME shape
// from the ported engine, so the exported names/types match and the page is
// unchanged beyond its import path.

import { CITIES, TIMINGS, SCENARIOS, DEFAULT_SCENARIO } from './engine/scenarios';
import type { City, Timing, Scenario } from './engine/scenarios';
import { listConfigGroups, loadFinanceConfig, DEFAULT_VARIANT } from './engine/config';
import type { ConfigGroup } from './engine/config';

export interface FinanceApiMeta {
  defaultScenario: string;
  defaultVariant: string;
  scenarios: Scenario[];
  cities: City[];
  timings: Timing[];
  configGroups: ConfigGroup[];
  homePrices: Record<string, { price: number; ccy: string } | null>;
}

// The three entities that only exist for the relocation presets — hidden from
// the Finance tab's pickers (kept here so /meta's shape matches the server).
const RELOCATION_KEYS = new Set([
  'income:relocation_income',
  'expenses:destination_living',
  'real-estate:relocation_home',
]);

// Purchase price + currency of every relocation-home variant, for the "Home
// size" picker. Mirrors the server's homePrices() in finance/src/index.ts.
function homePrices(): Record<string, { price: number; ccy: string } | null> {
  const out: Record<string, { price: number; ccy: string } | null> = {};
  const group = listConfigGroups().find((g) => g.key === 'real-estate:relocation_home');
  for (const v of group?.variants ?? []) {
    try {
      const cfg = loadFinanceConfig({
        groups: { 'real-estate:relocation_home': v.id },
        enabled: ['real-estate:relocation_home'],
      });
      const home = ((cfg.assets?.real_estate ?? []) as any[]).find((p) => p.id === 'relocation_home');
      out[v.id] = home?.purchase ? { price: home.purchase.price, ccy: home.currency } : null;
    } catch {
      out[v.id] = null;
    }
  }
  return out;
}

export function fetchMeta(): Promise<FinanceApiMeta> {
  return Promise.resolve({
    defaultScenario: DEFAULT_SCENARIO,
    defaultVariant: DEFAULT_VARIANT,
    scenarios: SCENARIOS,
    cities: CITIES,
    timings: TIMINGS,
    configGroups: listConfigGroups().filter((g) => !RELOCATION_KEYS.has(g.key)),
    homePrices: homePrices(),
  });
}
