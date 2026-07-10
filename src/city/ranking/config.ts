import districts from './districts.generated.json';
import type { DistrictData } from './types';

// ===========================================================================
//  Places config loader (browser build).
//
//  In the original service this read+validated `config/places/*.yaml` from
//  disk at module load. Here the district list is precomputed at build time
//  by `scripts/gen-city.mjs` (which does the same flatten/validate/dedup over
//  `data/city/places/*.yaml`) into `districts.generated.json`. That JSON is
//  trusted — this loader just hands the array back.
// ===========================================================================

/** All districts across every region file. Precomputed and validated by
 *  `scripts/gen-city.mjs`; this is just the accessor the ranker calls. */
export function loadDistricts(): DistrictData[] {
  return districts as unknown as DistrictData[];
}
