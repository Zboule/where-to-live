// Shared money/number formatting for the finance charts.

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return `${Math.round(n).toLocaleString()} ${currency}`;
  }
}

// ---- Tiered Y-axis bounds -----------------------------------------------------
// Round the data extent UP to a "nice" 1 / 2 / 5 tier so the axis is STICKY: switching
// between scenarios (e.g. two cities) keeps the SAME scale within a tier, making the bars
// directly comparable. Only a skyrocketing case (Top-SWE Switzerland, long horizon) bumps
// up to the next tier. Used as recharts `domain={[axisMin, axisMax]}` functions.
function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}
/** Upper bound: the data max rounded up to the next 1/2/5 tier. */
export const axisMax = (dataMax: number): number => niceCeil(dataMax) || 1;
/** Lower bound: 0 normally, or the negative tier when a chart dips below zero. */
export const axisMin = (dataMin: number): number => (dataMin < 0 ? -niceCeil(-dataMin) : 0);

/** Abbreviated, ~3 sig figs: €468k, €1.42M, €16.6M. */
export function abbr(v: number, currency: string): string {
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'AED' ? 'AED ' : currency === 'CHF' ? 'CHF ' : currency === 'GBP' ? '£' : `${currency} `;
  const s = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${s}${sym}${(a / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${s}${sym}${Math.round(a / 1000)}k`;
  return `${s}${sym}${Math.round(a)}`;
}
