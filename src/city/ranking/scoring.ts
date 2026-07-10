import type {
  ConnectivityResult,
  DimensionKey,
  DimensionResult,
  DistrictData,
  RankedDistrict,
  Tier,
} from './types';
import weatherData from './weather.data.json';
import { CITY_YEREVAN_TIER, YEREVAN_TIER_SCORE } from './flights';

/** Precomputed climate index per city (see src/scripts/build-weather-index.ts). */
const WEATHER = (weatherData as {
  byCity: Record<string, { score: number; goodDaysPerYear: number; note: string }>;
}).byCity;

// ===========================================================================
//  The Kid-Raising Score (refined 100-point framework, ages 6–18).
//
//  Seven researched dimensions (scored 0–5 in the YAML) plus three COMPUTED
//  factors — Weather, Language fit and Family connectivity — that are
//  deterministic given the city's climate, the family's languages (FR / EN / RU)
//  and the city's transport links, so they live here rather than in per-district
//  data. All weights sum to 100.
//
//  Deal-breakers: a serious weakness (≤1/5) in a critical dimension applies a
//  flat penalty and flags the district.
// ===========================================================================

interface DimensionDef {
  /** Matches a key in DistrictScores, or 'language' for the computed factor. */
  key: string;
  label: string;
  /** Max points at a perfect 5/5. */
  weight: number;
  /** Critical dimensions trigger the deal-breaker rule when very weak. */
  critical: boolean;
  blurb: string;
  /** When present, the score is computed here instead of read from the YAML. */
  compute?: (d: DistrictData) => { score: number; note: string };
}

/** The hand-scored + computed dimensions. Weights here + CONNECTIVITY_WEIGHT = 100. */
export const DIMENSIONS: DimensionDef[] = [
  {
    key: 'education',
    label: 'Education ecosystem',
    weight: 22,
    critical: true,
    blurb: 'Strong public schools with credible private/international backups, language support, clubs, serious anti-bullying, stable teachers — and happy, not crushed, kids.',
  },
  {
    key: 'safe_independence',
    label: 'Safe independence',
    weight: 15,
    critical: true,
    blurb: 'Can a 9–12-year-old walk or bike to school? Safe crossings, low car-dependency, good transit for teens, low violent crime.',
  },
  {
    key: 'peer_environment',
    label: 'Peer environment',
    weight: 11,
    critical: false,
    blurb: 'Stable education-valuing families, low antisocial behaviour, clubs/sports/music, kids active outdoors after school, a healthy social mix.',
  },
  {
    key: 'mental_health',
    label: 'Mental health & pressure',
    weight: 12,
    critical: true,
    blurb: 'Academic ambition without toxic pressure, social belonging, reasonable homework, access to psychologists, a healthy teen culture.',
  },
  {
    key: 'health',
    label: 'Health & environment',
    weight: 6,
    critical: true,
    blurb: 'Quality and access to medical care (hospitals, paediatric, emergency), clean air, low noise, safe drinking water, and the absence of environmental hazards. (Green space is scored under Nature; climate under Weather.)',
  },
  {
    key: 'nature',
    label: 'Nature access',
    weight: 6,
    critical: false,
    blurb: 'Green space in and around the district, parks, and proximity to forest, mountains, sea or lakes — plus easy, good outdoor recreation for kids. (Climate is scored separately as Weather.)',
  },
  {
    key: 'weather',
    label: 'Weather (good days)',
    weight: 6,
    critical: false,
    blurb: 'Share of the year that is a "good day" — comfortable feels-like temperature and little rain — from ERA5 climate data, not too hot, too cold or too wet.',
    compute: weatherFit,
  },
  {
    key: 'family_practicality',
    label: 'Family-life practicality',
    weight: 10,
    critical: false,
    blurb: 'Housing size for the price, commute under 30–40 min, affordability, childcare and after-school care, low parent stress.',
  },
  {
    key: 'language',
    label: 'Language fit',
    weight: 7,
    critical: false,
    blurb: 'What the kids (who speak French, English & Russian) would have to learn: a known or high-value language (German, Spanish) is a plus; a small, hard one (Estonian, Hungarian) is a drag.',
    compute: languageFit,
  },
  // NOTE: "Long-term optionality" and "Stability & governance" were both removed.
  // The family are already EU citizens (optionality adds no signal), and governance
  // quality barely differentiates within this European set; stability's 6 points went
  // to the new Nature dimension. Older YAML may still carry `optionality`/`stability`
  // (and the old combined `health_nature`); those keys are simply ignored.
];

/** Family-connectivity weight (direct travel to Paris & Yerevan), computed below. */
export const CONNECTIVITY_WEIGHT = 5;

/** Tunable per-factor weights (factor key → weight). The UI can override these so
 *  the global score is recomputed client-side without re-running any data pipeline. */
export type WeightMap = Record<string, number>;
export const DEFAULT_WEIGHTS: WeightMap = {
  ...Object.fromEntries(DIMENSIONS.map((d) => [d.key, d.weight])),
  connectivity: CONNECTIVITY_WEIGHT,
};

/** Score (0–5) at/under which a critical dimension flags a deal-breaker. */
export const DEALBREAKER_THRESHOLD = 1;
/** Flat multiplier applied to the total when a deal-breaker is present. */
export const DEALBREAKER_PENALTY = 0.85;

const MAX_SCORE = 5;

/** Sanity: weights must total 100 so a score reads directly as "out of 100". */
export const TOTAL_WEIGHT =
  DIMENSIONS.reduce((sum, d) => sum + d.weight, 0) + CONNECTIVITY_WEIGHT;

// --------------------------- connectivity ---------------------------------
//
//  What matters for visiting family is whether the trip is DIRECT (no mode-change
//  with two kids) and how OFTEN it flies. Yerevan is the differentiator and is
//  weighted more than the (almost always easy) Paris hop; its sub-score is now
//  graded by flight frequency (daily > frequent > weekly > none) from flights.ts.

/** The few cities with no direct flight/train to Paris (a real transfer to reach it). */
const PARIS_TRANSFER_CITIES = new Set<string>([
  'Trento', 'Bolzano',
  // non-European cities with no nonstop to Paris (one stop to CDG)
  'Sydney', 'Melbourne', 'Perth', 'Adelaide', 'Auckland', 'Wellington', 'Ottawa',
  // (Montreal, Toronto, Vancouver, Dubai, Abu Dhabi, Doha, Singapore, Tokyo,
  //  Yokohama→Tokyo, Herzliya→TLV, Palo Alto→SFO all have nonstop Paris service)
]);

const DIRECT = 1.0;
const TRANSFER = 0.4; // a mode-change/connection — the painful case with kids
const YEREVAN_SHARE = 0.65;
const PARIS_SHARE = 0.35;

export function computeConnectivity(d: DistrictData, weight: number = CONNECTIVITY_WEIGHT): ConnectivityResult {
  const tier = CITY_YEREVAN_TIER[d.city] ?? 'none';
  const yerevanSub = YEREVAN_TIER_SCORE[tier];
  const parisDirect = !PARIS_TRANSFER_CITIES.has(d.city);
  const parisSub = parisDirect ? DIRECT : TRANSFER;
  const points = (yerevanSub * YEREVAN_SHARE + parisSub * PARIS_SHARE) * weight;
  return { points, weight, yerevanDirect: tier !== 'none', parisDirect, yerevanSub, parisSub };
}

// ----------------------------- language -----------------------------------
//
//  Scored for a family whose kids already speak French, English and Russian.
//  Higher = better fit (already known, or a valuable/easy language); lower = a
//  small, hard, low-utility language to acquire. City overrides come first
//  (Switzerland and Belgium are split by language; Spain by region), then the
//  country default.

const LANGUAGE_BY_CITY: Record<string, { score: number; note: string }> = {
  Geneva: { score: 5, note: 'Schooling in French — already fluent.' },
  Lausanne: { score: 5, note: 'French-speaking canton — schooling in a language they already have.' },
  Brussels: { score: 4.5, note: 'French-medium schooling available (already fluent); Dutch a bonus.' },
  Ghent: { score: 3, note: 'Flemish/Dutch schooling — low global utility, but English is everywhere.' },
  Leuven: { score: 3, note: 'Flemish/Dutch schooling — low global utility, but English is everywhere.' },
  Barcelona: { score: 3.5, note: 'Public school in Catalan; Castilian Spanish also useful but it is a second local tongue.' },
  'Sant Cugat del Vallès': { score: 3.5, note: 'Catalan-medium public school; Spanish also in use — two local languages to absorb.' },
  Bilbao: { score: 3.5, note: 'Basque required in public school (hard, low utility); Castilian Spanish also used.' },
  'Vitoria-Gasteiz': { score: 3.5, note: 'Basque-model public schooling (hard, low utility); Castilian Spanish alongside.' },
  Montreal: { score: 5, note: 'French-medium public schooling (already native); English equally available.' },
};

const LANGUAGE_BY_COUNTRY: Record<string, { score: number; note: string }> = {
  FR: { score: 5, note: 'French is the family’s native language — schooling in French, nothing new to learn.' },
  GB: { score: 5, note: 'English-native — no new school language to learn.' },
  IE: { score: 5, note: 'English-native — no new school language to learn.' },
  CY: { score: 4.5, note: 'English-medium schooling is widespread; a Russian-speaking community eases daily life.' },
  CH: { score: 4, note: 'German-speaking canton — German is a genuinely valuable language to learn.' },
  DE: { score: 4.5, note: 'German — a high-value language well worth learning.' },
  AT: { score: 4.5, note: 'German — a high-value language well worth learning.' },
  ES: { score: 4.5, note: 'Castilian Spanish — a high-value world language, easy for French speakers.' },
  IT: { score: 4, note: 'Italian — Romance, easy for French speakers to pick up; good cultural value.' },
  PT: { score: 4, note: 'Portuguese — Romance and easy-ish; opens the Lusophone world.' },
  RO: { score: 3.5, note: 'Romanian is Romance — easy for French speakers; modest global utility.' },
  LU: { score: 4, note: 'Trilingual schooling (Lux/German/French) — demanding, but French already covers a third.' },
  NL: { score: 3, note: 'Dutch — limited global utility, but near-universal English softens the burden.' },
  BE: { score: 3, note: 'Flemish/Dutch schooling — low utility, eased by ubiquitous English.' },
  DK: { score: 3, note: 'Danish — low global utility, but English is universal.' },
  SE: { score: 3, note: 'Swedish — low global utility, but English is universal.' },
  NO: { score: 3, note: 'Norwegian — low global utility, but English is universal.' },
  FI: { score: 2.5, note: 'Finnish is hard and low-utility; strong English and Swedish/international options help.' },
  PL: { score: 3, note: 'Polish (Slavic) — the kids’ Russian aids learning; useful regionally.' },
  CZ: { score: 3, note: 'Czech (Slavic) — Russian gives a head start; modest utility.' },
  SK: { score: 3, note: 'Slovak (Slavic) — the kids’ Russian aids learning; modest regional utility.' },
  HR: { score: 3, note: 'Croatian (Slavic) — Russian gives a head start; small language.' },
  SI: { score: 2.5, note: 'Slovenian — small Slavic language; Russian helps a little.' },
  GR: { score: 2.5, note: 'Greek — own alphabet, low global utility; English-medium schools help.' },
  HU: { score: 2, note: 'Hungarian — very hard and low-utility, unrelated to any language the kids have.' },
  EE: { score: 2, note: 'Estonian — hard and low-utility; Russian helps daily life, but school is in Estonian.' },
  LV: { score: 2.5, note: 'Latvian is hard/low-utility, but Riga’s large Russian-speaking base eases daily life.' },
  LT: { score: 2.5, note: 'Lithuanian is hard and low-utility; some Russian is understood.' },
  // --- non-European (global pass) ---
  CA: { score: 5, note: 'English-native (and French-medium schooling in Québec) — no new school language to learn.' },
  US: { score: 5, note: 'English-native — no new school language to learn.' },
  AU: { score: 5, note: 'English-native — no new school language to learn.' },
  NZ: { score: 5, note: 'English-native — no new school language to learn.' },
  SG: { score: 4.5, note: 'English-medium schooling is the norm; Mandarin a high-value bonus.' },
  AE: { score: 4.5, note: 'English-medium international schools are universal; a large Russian-speaking community eases daily life.' },
  QA: { score: 4.5, note: 'English-medium international schooling is the norm; very international.' },
  JP: { score: 3, note: 'English international schools exist, but local schooling and daily life are Japanese — hard and low cross-utility.' },
  IL: { score: 3.5, note: 'Hebrew local schooling is hard, but a very large Russian-speaking community + English/international schools soften it.' },
};

function languageFit(d: DistrictData): { score: number; note: string } {
  return (
    LANGUAGE_BY_CITY[d.city] ??
    LANGUAGE_BY_COUNTRY[d.country_code] ?? {
      score: 3,
      note: 'Local language of moderate burden; English availability assumed.',
    }
  );
}

// ----------------------------- weather ------------------------------------
//  Climate "good-day" index, precomputed from Goldilocks ERA5 tiles per city.

function weatherFit(d: DistrictData): { score: number; note: string } {
  const w = WEATHER[d.city];
  if (!w) return { score: 3, note: 'No climate data for this city.' };
  return { score: w.score, note: w.note };
}

// --------------------------- scoring + rank -------------------------------

/** Classify a 0–100 total into a tier. */
export function classify(total: number): Tier {
  if (total >= 85) return { label: 'Exceptional', band: '85–100', key: 'exceptional' };
  if (total >= 75) return { label: 'Very strong', band: '75–84', key: 'strong' };
  if (total >= 65) return { label: 'Good, trade-offs', band: '65–74', key: 'good' };
  if (total >= 50) return { label: 'Acceptable', band: '50–64', key: 'acceptable' };
  return { label: 'Not ideal', band: '<50', key: 'weak' };
}

/** Score one district (without its rank — the ranker fills that in).
 *  `weights` overrides the per-factor importance (defaults to DEFAULT_WEIGHTS). */
export function scoreDistrict(
  data: DistrictData,
  weights: WeightMap = DEFAULT_WEIGHTS,
): Omit<RankedDistrict, 'rank'> {
  const dimensions: DimensionResult[] = DIMENSIONS.map((def) => {
    let score: number;
    let note: string | undefined;
    if (def.compute) {
      const r = def.compute(data);
      score = r.score;
      note = r.note;
    } else {
      score = (data.scores as unknown as Record<string, number>)[def.key] ?? 0;
      note = data.notes?.[def.key as DimensionKey];
    }
    const weight = weights[def.key] ?? def.weight;
    return {
      key: def.key,
      label: def.label,
      weight,
      score,
      points: (score / MAX_SCORE) * weight,
      critical: def.critical,
      note,
    };
  });

  const connectivity = computeConnectivity(data, weights.connectivity ?? CONNECTIVITY_WEIGHT);

  const rawTotal =
    dimensions.reduce((sum, d) => sum + d.points, 0) + connectivity.points;

  const dealbreakerDims = dimensions
    .filter((d) => d.critical && d.score <= DEALBREAKER_THRESHOLD)
    .map((d) => d.label);
  const dealbreaker = dealbreakerDims.length > 0;

  const total = dealbreaker ? rawTotal * DEALBREAKER_PENALTY : rawTotal;

  return {
    data,
    dimensions,
    connectivity,
    rawTotal,
    total,
    dealbreaker,
    dealbreakerDims,
    tier: classify(total),
  };
}

/** Rank a set of districts best-first; ties break deterministically.
 *  Pass `weights` to re-rank under custom factor importance. */
export function rankDistricts(districts: DistrictData[], weights?: WeightMap): RankedDistrict[] {
  return districts
    .map((d) => scoreDistrict(d, weights))
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.rawTotal - a.rawTotal ||
        a.data.district.localeCompare(b.data.district),
    )
    .map((d, i) => ({ ...d, rank: i + 1 }));
}
