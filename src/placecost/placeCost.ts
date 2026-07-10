// Browser client for the place-cost explorer. In the original family dashboard
// this was a thin fetch() wrapper over the finance service's /place-cost API.
// Here the ported engine runs 100% in the browser, so each function calls the
// engine directly and wraps the (synchronous) result in a Promise — the exported
// types and signatures are IDENTICAL to the original client, so the page needs no
// change beyond its import path.

import {
  computePlaceCost,
  computePlaceCostSummary,
  type DestMode,
  type EquityMode,
  type HomeSize,
  type PlaceCostParams,
  type PlaceCostResult,
  type PlaceCostSummary,
} from './engine/placeCost';
import {
  LIVING_CATEGORIES,
  getLivingPreset,
  isLivingEdited,
  saveLivingPreset as engineSaveLivingPreset,
  resetLivingPreset as engineResetLivingPreset,
  type LivingItem,
  type LivingPreset,
} from './engine/livingPresets';

export type { EquityMode, HomeSize, DestMode } from './engine/placeCost';
export type {
  PlaceCostParams,
  PlaceCostYear,
  PlaceCostResult,
  RequiredEquity,
  PlaceCostSummary,
} from './engine/placeCost';
export type { LivingItem, LivingPreset } from './engine/livingPresets';

export interface CityLivingPresets {
  categories: string[];
  comfortable: LivingPreset & { edited: boolean };
  simple: LivingPreset & { edited: boolean };
}

export function fetchPlaceCost(params: PlaceCostParams): Promise<PlaceCostResult> {
  return Promise.resolve(computePlaceCost(params));
}

export function fetchPlaceCostSummary(params: {
  cities?: string[];
  moveYears: number[];
  homeSize?: HomeSize;
  destMode?: DestMode;
  equityReturn?: number;
}): Promise<PlaceCostSummary> {
  return Promise.resolve(computePlaceCostSummary(params));
}

// ---- editable destination cost-of-life presets --------------------------

export function fetchLivingPresets(city: string): Promise<CityLivingPresets> {
  return Promise.resolve({
    categories: [...LIVING_CATEGORIES],
    comfortable: { ...getLivingPreset(city, 'comfortable'), edited: isLivingEdited(city, 'comfortable') },
    simple: { ...getLivingPreset(city, 'simple'), edited: isLivingEdited(city, 'simple') },
  });
}

export function saveLivingPreset(
  city: string,
  preset: DestMode,
  value: LivingPreset,
): Promise<LivingPreset> {
  return Promise.resolve(engineSaveLivingPreset(city, preset, value));
}

export function resetLivingPreset(city: string, preset: DestMode): Promise<LivingPreset> {
  return Promise.resolve(engineResetLivingPreset(city, preset));
}
