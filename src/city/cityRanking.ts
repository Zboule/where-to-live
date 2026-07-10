// ===========================================================================
//  Browser-local client for the "best place to raise a kid" engine.
//
//  This mirrors the shape of the original thin client
//  (family-dashboard/src/web/lib/cityRanking.ts), which fetched JSON from the
//  city-ranking service. Here there is no server: the district data, Kid-
//  Raising scoring and cost engine are ported verbatim into ./ranking +
//  ./enrich, and this module just wires their outputs into the same exported
//  types/functions the UI (PlacesPage/MapView) already expects.
// ===========================================================================

import {
  DIMENSIONS,
  DEFAULT_WEIGHTS,
  CONNECTIVITY_WEIGHT,
  TOTAL_WEIGHT,
  DEALBREAKER_THRESHOLD,
  DEALBREAKER_PENALTY,
  COST_META,
  COST_RULE_LABELS,
  COST_CATEGORY_LABELS,
} from './ranking/index';
import type {
  DimensionResult,
  ConnectivityResult,
  DistrictData,
  Tier,
  RankedDistrict as EngineRankedDistrict,
} from './ranking/types';
import type { WeightMap } from './ranking/scoring';
import type { CostLine, CostGroup, CostBreakdown } from './ranking/cost';
import { rankings } from './enrich';

// Re-export the engine's own types where they are identical (or a superset of
// what the UI needs) to avoid drift between the ported engine and the client.
export type { WeightMap, DimensionResult, ConnectivityResult, DistrictData, Tier, CostLine, CostGroup, CostBreakdown };

/** Shape of one DIMENSIONS entry as sent over the wire by the old /meta route
 *  (a plain JSON value — the `compute` function is not serializable, so it's
 *  dropped here too). Mirrors family-dashboard's DimensionDef. */
export interface DimensionDef {
  key: string;
  label: string;
  weight: number;
  critical: boolean;
  blurb: string;
}

/** One ranked district as produced by `rankings()` — the scoring result
 *  enriched with cost + coordinates (what the old server-side /rankings
 *  route produced, now computed locally). */
export type RankedDistrict = EngineRankedDistrict & {
  monthlyCostEur: number | null;
  costMultiplier: number | null;
  costBreakdown: CostBreakdown | null;
  coords: [number, number] | null;
};

export interface CityRankingMeta {
  dimensions: DimensionDef[];
  defaultWeights: WeightMap;
  connectivityWeight: number;
  totalWeight: number;
  dealbreakerThreshold: number;
  dealbreakerPenalty: number;
  costMeta: { ad_monthly_eur: number } & Record<string, unknown>;
  costRuleLabels: Record<string, string>;
  costCategoryLabels: Record<string, string>;
}

/** Same object the server's `/meta` route built (see city-ranking's
 *  src/index.ts `app.get('/meta', ...)`), computed locally instead of fetched. */
export function fetchCityRankingMeta(): Promise<CityRankingMeta> {
  const dimensions: DimensionDef[] = DIMENSIONS.map((d) => ({
    key: d.key,
    label: d.label,
    weight: d.weight,
    critical: d.critical,
    blurb: d.blurb,
  }));
  return Promise.resolve({
    dimensions,
    defaultWeights: DEFAULT_WEIGHTS,
    connectivityWeight: CONNECTIVITY_WEIGHT,
    totalWeight: TOTAL_WEIGHT,
    dealbreakerThreshold: DEALBREAKER_THRESHOLD,
    dealbreakerPenalty: DEALBREAKER_PENALTY,
    costMeta: COST_META as unknown as CityRankingMeta['costMeta'],
    costRuleLabels: COST_RULE_LABELS,
    costCategoryLabels: COST_CATEGORY_LABELS,
  });
}

/** Districts ranked best-first by the Kid-Raising Score, enriched with cost +
 *  coordinates. Pass `weights` to re-rank under custom factor importance
 *  (computed locally — no round trip). */
export function fetchRankings(weights?: WeightMap): Promise<RankedDistrict[]> {
  return Promise.resolve(rankings(weights) as RankedDistrict[]);
}

// --- supporting evidence (lazy-loaded per district) ---
//
// The research-evidence dataset (produced by the rescore pipeline) is empty
// for this port — no district has an evidence JSON yet. The mechanism is kept
// so it starts working the moment files land under public/city-evidence/.
export interface EvLeaf {
  id: string; label: string; core: boolean; bonus: boolean;
  support: string; confidence: string | null;
  for: string[]; against: string[]; unknowns: string[]; rationale: string;
}
export interface EvDim {
  label: string; report: string;
  math: number | null; llm: number | null;
  calibrated: { reads: number[]; median: number; final: number } | null;
  leaves: EvLeaf[];
}
export interface Evidence { region_id: string; dimensions: Record<string, EvDim>; }

const evCache = new Map<string, Evidence | null>();
export async function loadEvidence(id: string): Promise<Evidence | null> {
  if (evCache.has(id)) return evCache.get(id)!;
  let data: Evidence | null = null;
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}city-evidence/${id}.json`);
    if (res.ok) data = await res.json();
  } catch { /* none */ }
  evCache.set(id, data);
  return data;
}
