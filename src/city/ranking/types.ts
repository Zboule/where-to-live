// ===========================================================================
//  "Best place to raise a kid" — domain types.
//
//  A DISTRICT is the unit of ranking (a neighbourhood/suburb, never a whole city
//  or country). Raw district data lives in `src/config/places/*.yaml` and is
//  loaded by `config.ts`; the scoring engine in `scoring.ts` turns it into a
//  ranked, classified list. This module is fully independent of `src/finance`.
// ===========================================================================

export type TravelMode = 'train' | 'flight';

/** The seven researched dimensions, each scored 0–5 (0.5 steps allowed). */
export interface DistrictScores {
  /** School quality & whole education ecosystem across the full 6–18 span (public + backups). */
  education: number;
  /** Can a 9–12yo walk/bike/transit to school safely? Low car-dependency, low crime. */
  safe_independence: number;
  /** Stable education-valuing families, clubs/sports, kids active outdoors, healthy mix. */
  peer_environment: number;
  /** Ambition without toxic pressure, belonging, reasonable homework, psych access. */
  mental_health: number;
  /** Daily-life ease: childcare/after-school, transit & short commute, easy admin & services (price excluded). */
  family_practicality: number;
  /** Medical access (hospitals/paediatric/ER), clean air, low noise, safe water, no hazards. */
  health: number;
  /** Green space, parks, proximity to forest/mountains/sea, outdoor recreation. */
  nature: number;
}

export type DimensionKey = keyof DistrictScores;

/** Residential buy price, EUR per square metre, as a typical range for the district. */
export interface PriceRange {
  lower: number;
  upper: number;
  average: number;
}

/** City-level travel time (door-to-door-ish) to the two family anchors. */
export interface TravelInfo {
  paris_hours: number;
  paris_mode: TravelMode;
  yerevan_hours: number;
  yerevan_mode: TravelMode;
}

/** One district as stored in YAML. */
export interface DistrictData {
  id: string;
  city: string;
  country: string;
  country_code: string;
  district: string;
  blurb?: string;
  price_per_sqm: PriceRange;
  travel: TravelInfo;
  scores: DistrictScores;
  /** Short per-dimension justification (helps trust the score). */
  notes?: Partial<Record<DimensionKey, string>>;
  sources?: string[];
}

// --------------------------- scored output --------------------------------

export interface DimensionResult {
  /** A DistrictScores key, or 'language' for the computed language-fit factor. */
  key: string;
  label: string;
  /** Max points this dimension can contribute (at a 5/5 score). */
  weight: number;
  /** Researched 0–5 score. */
  score: number;
  /** Weighted contribution = (score / 5) * weight. */
  points: number;
  /** A weakness here is treated as a potential deal-breaker. */
  critical: boolean;
  note?: string;
}

export interface ConnectivityResult {
  /** Weighted contribution (0..CONNECTIVITY_WEIGHT). */
  points: number;
  weight: number;
  /** Whether each anchor is reachable by a direct flight/train (no transfer). */
  yerevanDirect: boolean;
  parisDirect: boolean;
  /** 0–1 sub-score per anchor (direct = 1, transfer = docked). */
  yerevanSub: number;
  parisSub: number;
}

export interface Tier {
  /** "Exceptional", "Very strong", … */
  label: string;
  /** Band string for display, e.g. "85–100". */
  band: string;
  /** Stable key for styling: exceptional | strong | good | acceptable | weak. */
  key: string;
}

export interface RankedDistrict {
  data: DistrictData;
  dimensions: DimensionResult[];
  connectivity: ConnectivityResult;
  /** Sum of all weighted points before any deal-breaker penalty (0–100). */
  rawTotal: number;
  /** Final score after deal-breaker penalty (what the ranking uses). */
  total: number;
  /** True if any critical dimension scored ≤ the deal-breaker threshold. */
  dealbreaker: boolean;
  /** Labels of the critical dimensions that triggered the flag. */
  dealbreakerDims: string[];
  tier: Tier;
  /** 1-based position in the full ranking. */
  rank: number;
}
