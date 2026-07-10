import {
  getPlaceRankings,
  getCostBreakdown,
  getCostMultiplier,
  getMonthlyCostEur,
  type WeightMap,
} from './ranking/index.ts';
import COORDS from './ranking/coords.data.json';

const coords = COORDS as unknown as Record<string, [number, number]>;

/** Rankings enriched with what the UI/agents need per district (cost, coords). */
export function rankings(weights?: WeightMap) {
  return getPlaceRankings(weights).map((d) => ({
    ...d,
    monthlyCostEur: getMonthlyCostEur(d.data.id),
    costMultiplier: getCostMultiplier(d.data.id),
    costBreakdown: getCostBreakdown(d.data.id),
    coords: coords[d.data.id] ?? null,
  }));
}
