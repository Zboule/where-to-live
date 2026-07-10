// Software-engineer gross salary by destination country, seniority and year — used by the
// post-relocation "Average SWE" / "Top SWE" income modes (the alternative to the dynamic
// "Auto" salary that just covers living). Smart on EXPERIENCE: 8 years in 2026, ramping to
// a staff/principal plateau by ~15 years, then nominal growth with inflation. Local
// currency (EUR for NL/AT, CHF for CH). Approximate 2026 market levels — easy to tune.
import type { TaxCountry } from './tax';

export type SweTier = 'average' | 'top';

const BASE_2026_PLATEAU: Record<TaxCountry, Record<SweTier, number>> = {
  // The "fully senior / staff" level (≈15+ yrs). An 8-yr engineer sits a bit below it; see
  // the seniority ramp. Gross/year, local currency.
  NL: { average: 92_000, top: 155_000 }, // Netherlands — strong scene (Adyen/Booking/Uber-AMS)
  AT: { average: 80_000, top: 125_000 }, // Austria — a notch below NL, lower top end
  CH: { average: 145_000, top: 215_000 }, // Switzerland (CHF) — far higher, esp. Zürich/Zug; Lausanne a touch lower
  FR: { average: 70_000, top: 120_000 }, // France — Paris/Versailles strong; lower outside the capital
  DE: { average: 85_000, top: 135_000 }, // Germany — Stuttgart/Munich strong (autos/SAP/scale-ups)
  BE: { average: 75_000, top: 120_000 }, // Belgium — Brussels solid; a notch below Germany
  ES: { average: 55_000, top: 95_000 }, // Spain — Madrid hubs (Amazon/Datadog/local scale-ups); Basque lower
  PT: { average: 45_000, top: 80_000 }, // Portugal — Lisbon remote-hub scene; local wages notably lower
  CZ: { average: 1_400_000, top: 2_400_000 }, // Czechia (CZK) — Prague (JetBrains/Oracle/Barclays) ≈ €57k/€97k
  DK: { average: 650_000, top: 1_050_000 }, // Denmark (DKK) — Copenhagen ≈ €87k/€141k, high but heavily taxed
  AU: { average: 145_000, top: 230_000 }, // Australia (AUD) — Melbourne (Atlassian-remote/Canva/banks) ≈ €87k/€138k
  FI: { average: 62_000, top: 100_000 }, // Finland — Helsinki (Supercell/Wolt/Nokia)
  LU: { average: 85_000, top: 130_000 }, // Luxembourg — banks/EU institutions/Amazon-LUX pay well
  SI: { average: 45_000, top: 75_000 }, // Slovenia — Ljubljana (Outfit7/Bitstamp heritage/local dev shops)
  SE: { average: 700_000, top: 1_100_000 }, // Sweden (SEK) — Stockholm (Spotify/Klarna/King) ≈ €64k/€100k
  GB: { average: 70_000, top: 115_000 }, // UK (GBP) — Edinburgh (Skyscanner/FanDuel/banks), below London
  IT: { average: 50_000, top: 85_000 }, // Italy — Bologna/Milan remote; local wages modest
  NZ: { average: 130_000, top: 200_000 }, // New Zealand (NZD) — Christchurch/Wellington ≈ €66k/€102k
};

const BASE_YEAR = 2026;
const EXPERIENCE_AT_BASE = 8; // your experience in 2026

/** Gross annual salary (local currency) for a SWE of the given tier in `country`, in `year`,
 *  given the base-year experience. Seniority ramps from 8 yrs to a ~15-yr plateau, then the
 *  figure just grows with `inflation` (nominal). */
export function sweGrossSalary(country: TaxCountry, tier: SweTier, year: number, inflation = 0.02): number {
  const base = BASE_2026_PLATEAU[country]?.[tier];
  if (!base) return 0;
  const experience = EXPERIENCE_AT_BASE + (year - BASE_YEAR);
  // 0.85 at 8 yrs → 1.0 at ~15.5 yrs (each extra year ≈ +2% of the plateau), then flat.
  const seniority = Math.min(1, 0.85 + 0.02 * Math.max(0, experience - EXPERIENCE_AT_BASE));
  const nominal = Math.pow(1 + inflation, year - BASE_YEAR);
  return base * seniority * nominal;
}
