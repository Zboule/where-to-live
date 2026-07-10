// ===========================================================================
//  Public API for the "best place to raise a kid" module.
//
//  UI imports only from here (mirrors how `src/web` consumes `src/finance`).
// ===========================================================================

import { loadDistricts } from './config';
import { rankDistricts } from './scoring';
import type { RankedDistrict } from './types';
import type { WeightMap } from './scoring';

export * from './types';
export * from './cost';
export {
  DIMENSIONS,
  CONNECTIVITY_WEIGHT,
  TOTAL_WEIGHT,
  DEALBREAKER_THRESHOLD,
  DEALBREAKER_PENALTY,
  DEFAULT_WEIGHTS,
  classify,
} from './scoring';
export type { WeightMap } from './scoring';

/** Districts ranked best-first by the Kid-Raising Score.
 *  Pass `weights` to re-rank under custom factor importance (computed client-side). */
export function getPlaceRankings(weights?: WeightMap): RankedDistrict[] {
  return rankDistricts(loadDistricts(), weights);
}
