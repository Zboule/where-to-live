// ===========================================================================
//  Direct flights to Yerevan (EVN) — the data behind Family-connectivity.
//
//  Visiting family in Yerevan is the connectivity differentiator. What matters
//  is (a) whether the trip is DIRECT from a taxi-distance airport (no mode-change
//  with two kids) and (b) how OFTEN it flies — a daily route is materially better
//  than a once-a-week one for a real family rhythm. So connectivity is now graded
//  by frequency tier rather than a binary direct/transfer flag.
//
//  Source: route survey (Wizz Air / FlyOne / flag carriers), 2026. Frequencies are
//  approximate and seasonal; re-run the `rescore-places` flight review to refresh.
// ===========================================================================

export type FlightTier = 'daily' | 'frequent' | 'weekly' | 'none';

export interface YerevanRoute {
  city: string;
  code: string;
  country: string;
  airlines: string;
  /** Approximate weekly frequency, as surveyed. */
  weekly: string;
  tier: Exclude<FlightTier, 'none'>;
}

/** Every surveyed direct EVN route (reference data). European routes drive the
 *  residence-city mapping below; transcontinental ones are kept for completeness. */
export const YEREVAN_ROUTES: YerevanRoute[] = [
  // --- daily / near-daily (7+/week, or "borderline daily" ~6–7x) ---
  { city: 'Paris', code: 'CDG', country: 'France', airlines: 'Air France + FlyOne', weekly: '~9x', tier: 'daily' },
  { city: 'Rome', code: 'FCO', country: 'Italy', airlines: 'Wizz Air + FlyOne', weekly: '~9–11x', tier: 'daily' },
  { city: 'Larnaca', code: 'LCA', country: 'Cyprus', airlines: 'Wizz Air + FlyOne', weekly: '~15x', tier: 'daily' },
  { city: 'Frankfurt', code: 'FRA', country: 'Germany', airlines: 'Lufthansa (+Condor seasonal)', weekly: '7x', tier: 'daily' },
  { city: 'Athens', code: 'ATH', country: 'Greece', airlines: 'Aegean + Sky Express', weekly: '~6–7x', tier: 'daily' },
  { city: 'Vienna', code: 'VIE', country: 'Austria', airlines: 'Austrian + FlyOne', weekly: '~6–9x', tier: 'daily' },
  { city: 'Warsaw', code: 'WAW', country: 'Poland', airlines: 'LOT', weekly: '4–7x', tier: 'daily' },
  { city: 'Brussels', code: 'BRU', country: 'Belgium', airlines: 'Brussels Airlines + FlyOne', weekly: '3–7x', tier: 'daily' },
  // --- frequent (3–6/week) ---
  { city: 'Milan', code: 'MXP', country: 'Italy', airlines: 'Wizz Air + FlyOne', weekly: '~6x', tier: 'frequent' },
  { city: 'Paris', code: 'BVA', country: 'France', airlines: 'Wizz Air', weekly: '4x', tier: 'frequent' },
  { city: 'Dortmund', code: 'DTM', country: 'Germany', airlines: 'Wizz Air', weekly: '4x', tier: 'frequent' },
  { city: 'Barcelona', code: 'BCN', country: 'Spain', airlines: 'FlyOne', weekly: '3x (→2x autumn)', tier: 'frequent' },
  { city: 'Prague', code: 'PRG', country: 'Czechia', airlines: 'Wizz Air', weekly: '3x', tier: 'frequent' },
  { city: 'Hamburg', code: 'HAM', country: 'Germany', airlines: 'Wizz Air', weekly: '3x', tier: 'frequent' },
  { city: 'Naples', code: 'NAP', country: 'Italy', airlines: 'Wizz Air', weekly: '3x', tier: 'frequent' },
  { city: 'Budapest', code: 'BUD', country: 'Hungary', airlines: 'Wizz Air', weekly: '2–3x', tier: 'frequent' },
  { city: 'Paphos', code: 'PFO', country: 'Cyprus', airlines: 'Wizz Air + FlyOne', weekly: '2–3x', tier: 'frequent' },
  { city: 'Tbilisi', code: 'TBS', country: 'Georgia', airlines: 'various', weekly: '3–6x', tier: 'frequent' },
  // --- weekly / semi-weekly (1–2/week, year-round) ---
  { city: 'Amsterdam', code: 'AMS', country: 'Netherlands', airlines: 'various', weekly: '1–2x', tier: 'weekly' },
  { city: 'London', code: 'LTN', country: 'United Kingdom', airlines: 'Wizz Air (only UK link)', weekly: '1–2x', tier: 'weekly' },
  { city: 'Paris', code: 'ORY', country: 'France', airlines: 'FlyOne', weekly: '1–2x', tier: 'weekly' },
  { city: 'Milan', code: 'BGY', country: 'Italy', airlines: 'Wizz Air', weekly: '1–2x', tier: 'weekly' },
  { city: 'Düsseldorf', code: 'DUS', country: 'Germany', airlines: 'Eurowings', weekly: '1–2x', tier: 'weekly' },
  { city: 'Berlin', code: 'BER', country: 'Germany', airlines: 'Eurowings', weekly: '1–2x', tier: 'weekly' },
  { city: 'Cologne', code: 'CGN', country: 'Germany', airlines: 'various', weekly: '1–2x', tier: 'weekly' },
  // Non-European gateways (Istanbul, Dubai, Moscow, etc.) exist daily but are not
  // relevant to a European residence choice, so they are omitted from the mapping.
];

/** Sub-score per tier, feeding the Yerevan half of the connectivity factor. A
 *  no-direct-flight city ('none') keeps the old transfer baseline of 0.4. */
export const YEREVAN_TIER_SCORE: Record<FlightTier, number> = {
  daily: 1.0,
  frequent: 0.85,
  weekly: 0.7,
  none: 0.4,
};

/** Residence city → best Yerevan tier reachable from a taxi-distance airport.
 *  Metro mappings: Cyprus (Limassol/Nicosia) → Larnaca; the Dutch Randstad →
 *  Schiphol; London/St Albans/Cambridge → Luton; Barcelona metro → BCN. NRW
 *  (Düsseldorf/Cologne/Bonn) is now weekly, not "direct", per current schedules.
 *  Cities not listed have no taxi-distance direct EVN flight (→ 'none'). */
export const CITY_YEREVAN_TIER: Record<string, FlightTier> = {
  // daily / near-daily
  Paris: 'daily',
  Rome: 'daily',
  Vienna: 'daily',
  Athens: 'daily',
  Warsaw: 'daily',
  Brussels: 'daily',
  Frankfurt: 'daily', // FRA 7x
  Larnaca: 'daily', // LCA ~15x (city itself)
  // Paris metro (Île-de-France) — all reach CDG (daily EVN)
  'Boulogne-Billancourt': 'daily',
  'Neuilly-sur-Seine': 'daily',
  'Maisons-Laffitte': 'daily',
  'Saint-Germain-en-Laye': 'daily',
  Sceaux: 'daily',
  Versailles: 'daily',
  Vincennes: 'daily',
  Limassol: 'daily', // Larnaca ~45 min
  Nicosia: 'daily', // Larnaca ~45 min
  // frequent
  Milan: 'frequent',
  Prague: 'frequent',
  Barcelona: 'frequent',
  'Sant Cugat del Vallès': 'frequent', // Barcelona metro
  Hamburg: 'frequent',
  Budapest: 'frequent',
  Naples: 'frequent',
  Dortmund: 'frequent', // DTM 4x
  Paphos: 'frequent', // PFO 2–3x
  Bucharest: 'frequent', // FlyOne/Wizz OTP–EVN service (not in the latest table — verify)
  // weekly
  Berlin: 'weekly',
  Düsseldorf: 'weekly',
  Cologne: 'weekly',
  Bonn: 'weekly', // near Cologne/Bonn airport
  Amsterdam: 'weekly',
  Haarlem: 'weekly', // Randstad / Schiphol
  Utrecht: 'weekly',
  'The Hague': 'weekly',
  Wageningen: 'weekly',
  London: 'weekly',
  'St Albans': 'weekly', // ~15 min to Luton
  Cambridge: 'weekly', // ~40 min to Luton
  // --- non-European (global pass): only the Gulf has a real direct Yerevan link ---
  Dubai: 'daily', // DXB–EVN daily (flydubai / Air Arabia / FlyOne)
  'Abu Dhabi': 'frequent', // AUH–EVN (Wizz Air Abu Dhabi / FlyOne)
  Doha: 'frequent', // DOH–EVN (Qatar Airways)
  // Canada / Australia / NZ / Singapore / Japan / US / Israel → no direct EVN (default 'none')
};
