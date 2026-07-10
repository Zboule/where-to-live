import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Dropdown } from './ui/Dropdown';
import { MultiSelect } from './ui/MultiSelect';
import { LivingEditModal } from './LivingEditModal';
import { abbr, money } from './ui/format';
import { fetchMeta, type FinanceApiMeta } from './financeMeta';
import {
  fetchPlaceCost,
  fetchPlaceCostSummary,
  type DestMode,
  type EquityMode,
  type HomeSize,
  type PlaceCostResult,
  type PlaceCostSummary,
} from './placeCost';

// One question, one graph: how much equity does each city need at the chosen
// move year — per home size (color), to FIRE (solid) or just mortgage-free
// (pale). Horizontal bars: cities on the Y axis, cheapest first.
const SIZES: { id: HomeSize; label: string; sqm: number; color: string }[] = [
  { id: '3bed', label: '3-bed', sqm: 140, color: '#1baf7a' },
  { id: 'comfortable', label: 'Comfortable', sqm: 230, color: '#2a78d6' },
  { id: 'premium', label: 'Premium', sqm: 350, color: '#8b5cf6' },
];
// reachable mortgage-free bars: paler than FIRE but clearly "active" — well
// above the grayed-out (over-mark) state so the two never look alike
const MORTGAGE_OPACITY = 0.62;

const RETURNS = [
  { id: '0.035', label: 'Low · 3.5%' },
  { id: '0.05', label: 'Base · 5%' },
  { id: '0.08', label: 'High · 8%' },
  { id: '0.095', label: 'S&P 500 · 9.5%' },
];

const LIVES: { id: DestMode; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'simple', label: 'Simple' },
];

const YEAR_CHOICES = Array.from({ length: 15 }, (_, i) => 2026 + i);
const DEFAULT_YEAR = '2030';
/** Default equity at the move (base ccy) — sizes the left-side sustainable draw. */
const DEFAULT_EQUITY = 2_000_000;
/** Share of a mature equity withdrawal that's taxable gain (basis steps up at
 *  the move, then erodes) — used to net the left draw for CGT so it reconciles
 *  with the FIRE bar, which taxes withdrawals over the horizon. */
const GAIN_FRACTION = 0.5;
/** Years charted in the detail modal, from the move onward. */
const DETAIL_CHART_YEARS = 10;

// semantic hues for the modal charts, matching the Finance tab
const C_LIVING = '#f59e0b';
const C_MORTGAGE = '#f87171';
const C_HOLDING = '#94a3b8';
const C_HOME_EQUITY = '#3b82f6';
const C_HOME_DEBT = '#fca5a5';
const C_EQUITIES = '#34d399';
const C_INCOME = '#f472b6'; // net income, the Finance tab's income pink

// Left butterfly: Need = soft orange ramp, Have = soft green ramp. Softer
// than the modal's saturated hues so the two families read at a glance.
const NEED = { living: '#f0a552', mortgage: '#e08145', holding: '#f7d3a8' };
const HAVE = { income: '#5cb98d', draw: '#a6ddc0' };

/** "Oud-Zuid (Amsterdam)" → "Amsterdam"; plain labels stay as-is. */
function shortLabel(label: string): string {
  const m = /\(([^)]+)\)/.exec(label);
  return m ? m[1] : label;
}

/** Country codes (the engine's `country` field) → display names for the axis. */
const COUNTRY_NAMES: Record<string, string> = {
  NL: 'Netherlands', AT: 'Austria', CH: 'Switzerland', FR: 'France', DE: 'Germany',
  BE: 'Belgium', ES: 'Spain', PT: 'Portugal', CZ: 'Czechia', DK: 'Denmark',
  AU: 'Australia', FI: 'Finland', LU: 'Luxembourg', SI: 'Slovenia', SE: 'Sweden',
  GB: 'United Kingdom', IT: 'Italy', NZ: 'New Zealand',
};

/** "Oud-Zuid (Amsterdam)" → "Oud-Zuid"; null when the label has no district. */
function districtOf(label: string): string | null {
  const m = /^(.*?)\s*\(/.exec(label);
  return m ? m[1] : null;
}

function readUrl() {
  const p = new URLSearchParams(window.location.search);
  return {
    cities: (p.get('pcCities') ?? '').split(',').filter(Boolean),
    districts: (p.get('pcDistricts') ?? '').split(',').filter(Boolean),
    sizes: (p.get('pcSizes') ?? '').split(',').filter(Boolean),
    year: p.get('pcYear') ?? DEFAULT_YEAR,
    life: (p.get('pcLife') as DestMode) || 'comfortable',
    ret: Number(p.get('pcReturn')) || 0.05,
    mark: p.get('pcMark') != null ? Number(p.get('pcMark')) || 0 : DEFAULT_EQUITY,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTip({ active, payload, label, ccy, extra }: any) {
  if (!active || !payload?.length) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = payload.filter((p: any) => p.value != null && Math.abs(p.value) > 0.5);
  if (!rows.length) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = rows.reduce((s: number, p: any) => s + p.value, 0);
  return (
    <div className="fin-tooltip">
      <div className="tt-head">
        <strong>{label}</strong>
        {rows.length > 1 && <span>{money(total, ccy)}</span>}
      </div>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {rows.map((p: any) => (
        <div className="tt-row" key={p.dataKey}>
          <span className="tt-dot" style={{ background: p.color || p.fill }} />
          <span className="tt-label">{p.name}</span>
          <span className="tt-val">{money(p.value, ccy)}</span>
        </div>
      ))}
      {extra?.(label)}
    </div>
  );
}

/** The equity chart's tooltip — the Wealth-tab flow style: previous balance,
 *  each in/outflow, then the resulting balance. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function EquityTip({ active, label, data }: any) {
  if (!active) return null;
  const d = data as PlaceCostResult;
  const row = d.yearly.find((y) => String(y.year) === label);
  const pf = row?.portfolio;
  if (!pf) return null;
  const isMoveYear = row!.year === d.moveYear;
  const purchase = d.requiredEquity.purchaseCashOut;
  const flows: [string, number, string][] = [
    ['Previous balance', isMoveYear ? pf.opening + purchase : pf.opening, C_HOLDING],
    ['Growth', pf.growth, C_EQUITIES],
    ...(isMoveYear ? ([['→ Home purchase', -purchase, C_HOME_EQUITY]] as [string, number, string][]) : []),
    ['Withdrawn → living', -pf.withdrawnLiving, C_LIVING],
    ['Withdrawn → home', -pf.withdrawnHome, C_MORTGAGE],
    [d.wealthTax?.label ?? 'Wealth tax', -pf.wealthTax, '#fb923c'],
    ['CGT on withdrawals', -pf.cgt, '#a78bfa'],
  ];
  return (
    <div className="fin-tooltip">
      <div className="tt-head">
        <strong>{label}</strong>
      </div>
      {flows
        .filter(([, v]) => Math.abs(v) > 0.5)
        .map(([name, v, color]) => (
          <div className="tt-row" key={name}>
            <span className="tt-dot" style={{ background: color }} />
            <span className="tt-label">{name}</span>
            <span className="tt-val">
              {v < 0 ? '-' : ''}
              {money(Math.abs(Math.round(v)), d.baseCurrency)}
            </span>
          </div>
        ))}
      <div className="tt-sep" />
      <div className="tt-row tt-foot">
        <span className="tt-label">Balance</span>
        <span className="tt-val">{money(Math.round(pf.closing), d.baseCurrency)}</span>
      </div>
    </div>
  );
}

/** Click-through detail for one bar: where the (city, size, mode) number
 *  comes from — the purchase, the yearly costs, and the three flow charts. */
function ScenarioDetail({
  city,
  cityLabel,
  size,
  mode,
  year,
  life,
  ret,
  onClose,
}: {
  city: string;
  cityLabel: string;
  size: HomeSize;
  mode: EquityMode;
  year: number;
  life: DestMode;
  ret: number;
  onClose: () => void;
}) {
  const [d, setD] = useState<PlaceCostResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sizeInfo = SIZES.find((s) => s.id === size)!;

  useEffect(() => {
    fetchPlaceCost({
      city,
      moveYear: year,
      homeSize: size,
      destMode: life,
      equityMode: mode,
      equityReturn: ret,
      // same window as the summary bars, so the headline reconciles; the
      // charts below only show the first DETAIL_CHART_YEARS of it
      years: Math.max(2, year - 2026) + 25,
    })
      .then(setD)
      .catch((e) => setErr((e as Error).message));
  }, [city, size, mode, year, life, ret]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const moveRow = d?.yearly.find((y) => y.year === d.moveYear);
  const ccy = d?.baseCurrency ?? 'EUR';
  // living items grouped by category, like the Expenses tab
  const livingGroups = useMemo(() => {
    const groups: { cat: string; total: number; items: NonNullable<typeof moveRow>['livingItems'] }[] = [];
    for (const it of moveRow?.livingItems ?? []) {
      let g = groups.find((x) => x.cat === it.category);
      if (!g) groups.push((g = { cat: it.category, total: 0, items: [] }));
      g.total += it.amount;
      g.items.push(it);
    }
    return groups;
  }, [moveRow]);

  // 10 years from the move, for the three charts
  const chartRows = useMemo(
    () =>
      (d?.yearly ?? [])
        .filter((y) => y.year >= (d?.moveYear ?? 0) && y.year < (d?.moveYear ?? 0) + DETAIL_CHART_YEARS)
        .map((y) => {
          const pf = y.portfolio;
          const isMove = y.year === d?.moveYear;
          const purchase = d?.requiredEquity.purchaseCashOut ?? 0;
          return {
            year: String(y.year),
            living: Math.round(y.living),
            mortgage: Math.round(y.mortgagePayment),
            holding: Math.round(y.holdingCosts),
            livingItems: y.livingItems,
            homeEquity: Math.round(y.homeEquity),
            homeDebt: Math.round(y.mortgageBalance),
            // signed composition, wealth-style: balance carried in + growth up,
            // every outflow below the axis
            pfPrev: pf ? Math.round(isMove ? pf.opening + purchase : pf.opening) : 0,
            pfGrowth: pf ? Math.round(pf.growth) : 0,
            pfPurchase: pf && isMove ? -Math.round(purchase) : 0,
            pfLiving: pf ? -Math.round(pf.withdrawnLiving) : 0,
            pfHome: pf ? -Math.round(pf.withdrawnHome) : 0,
            pfWtax: pf ? -Math.round(pf.wealthTax) : 0,
            pfCgt: pf ? -Math.round(pf.cgt) : 0,
          };
        }),
    [d],
  );

  return (
    <>
      <div className="pc-modal-backdrop" onClick={onClose} />
      <div className="pc-modal" role="dialog" aria-modal="true">
        <button className="bud-close bud-close-abs" onClick={onClose}>
          ✕
        </button>
        <h2 className="pc-modal-title">
          {cityLabel} · {sizeInfo.label} ({sizeInfo.sqm} m²) ·{' '}
          {mode === 'fire' ? 'FIRE' : 'Mortgage-free'} · {life === 'simple' ? 'simple life · ' : ''}move {year}
        </h2>
        {err ? (
          <div className="pc-error">{err}</div>
        ) : !d || !moveRow ? (
          <div className="empty">Loading…</div>
        ) : (
          <>
            <div className="pc-headline">
              {d.requiredEquity.total != null ? (
                <>
                  <strong>{money(Math.round(d.requiredEquity.total), ccy)}</strong> ={' '}
                  {money(Math.round(d.requiredEquity.purchaseCashOut), ccy)} home purchase +{' '}
                  {money(Math.round(d.requiredEquity.portfolio ?? 0), ccy)} portfolio at{' '}
                  {(d.equityReturn * 100).toFixed(1)}%
                </>
              ) : (
                <strong>Not sustainable at {(d.equityReturn * 100).toFixed(1)}%</strong>
              )}
            </div>

            <div className="pc-cols">
              {/* ---- the home purchase ---- */}
              <section className="pc-sec">
                <h4>The home · {d.home.name}</h4>
                <div className="pc-kv"><span>Price today</span><b>{money(Math.round(d.home.priceAtBase), ccy)}</b></div>
                <div className="pc-kv">
                  <span>Price at the {d.moveYear} purchase ({(d.home.appreciationRate * 100).toFixed(1)}%/y)</span>
                  <b>{money(Math.round(d.home.priceAtMove), ccy)}</b>
                </div>
                <div className="pc-kv"><span>Acquisition costs</span><b>{money(Math.round(d.home.acquisitionCosts), ccy)}</b></div>
                <div className="pc-kv">
                  <span>Mortgage ({(d.home.mortgageRate * 100).toFixed(1)}%, {Math.round((d.home.mortgagePrincipal / d.home.priceAtMove) * 100)}% LTV)</span>
                  <b>−{money(Math.round(d.home.mortgagePrincipal), ccy)}</b>
                </div>
                <div className="pc-kv pc-kv-total">
                  <span>Cash to buy (down payment + costs)</span>
                  <b>{money(Math.round(d.home.purchaseCashOut), ccy)}</b>
                </div>
              </section>

              {/* ---- yearly costs at the move ---- */}
              <section className="pc-sec">
                <h4>Yearly costs in {d.moveYear}</h4>
                <div className="pc-kv">
                  <span>
                    <i className="tt-dot" style={{ background: C_LIVING }} />
                    Cost of life{mode === 'mortgage' ? ' (covered by salary, not the portfolio)' : ''}
                  </span>
                  <b>{money(Math.round(moveRow.living), ccy)}</b>
                </div>
                {livingGroups.map((g) => (
                  <div key={g.cat}>
                    <div className="pc-kv pc-kv-sub pc-kv-grp">
                      <span>
                        <i className="tt-dot" style={{ background: `var(--cat-${g.cat.toLowerCase()}, var(--cat-other))` }} />
                        {g.cat}
                      </span>
                      <b>{abbr(g.total, ccy)}</b>
                    </div>
                    {g.items.map((it) => (
                      <div className="pc-kv pc-kv-sub2" key={it.id}>
                        <span>{it.name}</span>
                        <b>{abbr(it.amount, ccy)}</b>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="pc-kv">
                  <span>
                    <i className="tt-dot" style={{ background: C_MORTGAGE }} />
                    Mortgage payments
                  </span>
                  <b>{money(Math.round(moveRow.mortgagePayment), ccy)}</b>
                </div>
                <div className="pc-kv">
                  <span>
                    <i className="tt-dot" style={{ background: C_HOLDING }} />
                    Home holding costs (tax + maintenance)
                  </span>
                  <b>{money(Math.round(moveRow.holdingCosts), ccy)}</b>
                </div>
                {d.wealthTax && (
                  <div className="pc-kv">
                    <span>
                      <i className="tt-dot" style={{ background: '#fb923c' }} />
                      {d.wealthTax.label} ({(d.wealthTax.rate * 100).toFixed(2)}% above {abbr(d.wealthTax.threshold, ccy)})
                    </span>
                    <b>{money(Math.round(moveRow.portfolio?.wealthTax ?? 0), ccy)}</b>
                  </div>
                )}
                {d.cgtRate > 0 && (
                  <div className="pc-kv">
                    <span>
                      <i className="tt-dot" style={{ background: '#a78bfa' }} />
                      CGT on withdrawn gains
                    </span>
                    <b>{(d.cgtRate * 100).toFixed(1)}%</b>
                  </div>
                )}
              </section>
            </div>

            {/* ---- the three flow charts, DETAIL_CHART_YEARS from the move ---- */}
            <section className="pc-sec">
              <h4>Costs, year by year</h4>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="year" stroke="currentColor" fontSize={12} />
                  <YAxis stroke="currentColor" fontSize={12} tickFormatter={(v) => abbr(v, ccy)} width={54} />
                  <Tooltip
                    allowEscapeViewBox={{ x: false, y: true }}
                    position={{ y: 0 }}
                    wrapperStyle={{ zIndex: 60 }}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    content={({ active, label }: any) => {
                      const row = chartRows.find((r) => r.year === label);
                      if (!active || !row) return null;
                      const groups: { cat: string; total: number }[] = [];
                      for (const it of row.livingItems ?? []) {
                        let g = groups.find((x) => x.cat === it.category);
                        if (!g) groups.push((g = { cat: it.category, total: 0 }));
                        g.total += it.amount;
                      }
                      return (
                        <div className="fin-tooltip">
                          <div className="tt-head">
                            <strong>{label}</strong>
                            <span>{money(row.living + row.mortgage + row.holding, ccy)}</span>
                          </div>
                          <div className="tt-row">
                            <span className="tt-dot" style={{ background: C_MORTGAGE }} />
                            <span className="tt-label">Mortgage</span>
                            <span className="tt-val">{money(row.mortgage, ccy)}</span>
                          </div>
                          <div className="tt-row">
                            <span className="tt-dot" style={{ background: C_HOLDING }} />
                            <span className="tt-label">Home holding costs</span>
                            <span className="tt-val">{money(row.holding, ccy)}</span>
                          </div>
                          <div className="tt-row">
                            <span className="tt-dot" style={{ background: C_LIVING }} />
                            <span className="tt-label">Living</span>
                            <span className="tt-val">{money(row.living, ccy)}</span>
                          </div>
                          {groups.map((g) => (
                            <div className="tt-row tt-sub" key={g.cat}>
                              <span
                                className="tt-dot"
                                style={{ background: `var(--cat-${g.cat.toLowerCase()}, var(--cat-other))` }}
                              />
                              <span className="tt-label">{g.cat}</span>
                              <span className="tt-val">{abbr(g.total, ccy)}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="living" name="Living" stackId="c" fill={C_LIVING} />
                  <Bar dataKey="mortgage" name="Mortgage" stackId="c" fill={C_MORTGAGE} />
                  <Bar dataKey="holding" name="Home holding costs" stackId="c" fill={C_HOLDING} />
                </ComposedChart>
              </ResponsiveContainer>
            </section>

            <section className="pc-sec">
              <h4>
                Home value & mortgage
                <span className="pc-sec-sub">
                  bought {d.moveYear} at {abbr(d.home.priceAtMove, ccy)} · mortgage{' '}
                  {abbr(d.home.mortgagePrincipal, ccy)} at {(d.home.mortgageRate * 100).toFixed(1)}%
                </span>
              </h4>
              <ResponsiveContainer width="100%" height={220}>
                <ComposedChart data={chartRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="year" stroke="currentColor" fontSize={12} />
                  <YAxis stroke="currentColor" fontSize={12} tickFormatter={(v) => abbr(v, ccy)} width={54} />
                  <Tooltip
                    allowEscapeViewBox={{ x: false, y: true }}
                    position={{ y: 0 }}
                    wrapperStyle={{ zIndex: 60 }}
                    content={<ChartTip ccy={ccy} />}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="homeEquity" name="Your equity" stackId="h" fill={C_HOME_EQUITY} />
                  <Bar dataKey="homeDebt" name="Mortgage balance" stackId="h" fill={C_HOME_DEBT} />
                </ComposedChart>
              </ResponsiveContainer>
            </section>

            <section className="pc-sec">
              <h4>
                Equity portfolio
                <span className="pc-sec-sub">
                  {(d.equityReturn * 100).toFixed(1)}%/y
                  {d.wealthTax ? ` · ${d.wealthTax.label}` : ''}
                  {d.cgtRate > 0 ? ` · CGT ${(d.cgtRate * 100).toFixed(1)}%` : ''} · hover a year for the flows
                </span>
              </h4>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartRows} stackOffset="sign">
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="year" stroke="currentColor" fontSize={12} />
                  <YAxis stroke="currentColor" fontSize={12} tickFormatter={(v) => abbr(v, ccy)} width={54} />
                  <Tooltip
                    allowEscapeViewBox={{ x: false, y: true }}
                    position={{ y: 0 }}
                    wrapperStyle={{ zIndex: 60 }}
                    content={<EquityTip data={d} />}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="pfPrev" name="Previous balance" stackId="p" fill={C_HOLDING} />
                  <Bar dataKey="pfGrowth" name="Growth" stackId="p" fill={C_EQUITIES} />
                  <Bar dataKey="pfPurchase" name="→ Home purchase" stackId="p" fill={C_HOME_EQUITY} />
                  <Bar dataKey="pfLiving" name="Withdrawn → living" stackId="p" fill={C_LIVING} />
                  <Bar dataKey="pfHome" name="Withdrawn → home" stackId="p" fill={C_MORTGAGE} />
                  <Bar dataKey="pfWtax" name="Wealth tax" stackId="p" fill="#fb923c" />
                  <Bar dataKey="pfCgt" name="CGT" stackId="p" fill="#a78bfa" />
                  <ReferenceLine y={0} stroke="currentColor" strokeOpacity={0.4} />
                </ComposedChart>
              </ResponsiveContainer>
            </section>
            {d.warnings.length > 0 && <div className="pc-warn">{d.warnings.join(' ')}</div>}
          </>
        )}
      </div>
    </>
  );
}

export function PlaceCostPage() {
  const init = useRef(readUrl()).current;
  const [meta, setMeta] = useState<FinanceApiMeta | null>(null);
  const [cities, setCities] = useState<string[]>(init.cities); // empty = all
  // district/place ids to show — empty = all. A pure client-side visibility
  // filter (no refetch), so it layers on top of the Cities fetch filter.
  const [districts, setDistricts] = useState<string[]>(init.districts);
  const [sizes, setSizes] = useState<string[]>(init.sizes); // empty = all three
  const [year, setYear] = useState(init.year);
  const [life, setLife] = useState<DestMode>(init.life);
  const [ret, setRet] = useState(init.ret);
  // dashed vertical marker on the amount axis (e.g. "our current equity")
  const [mark, setMark] = useState<number>(init.mark);
  // one summary per home size, fetched together
  const [data, setData] = useState<Record<HomeSize, PlaceCostSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // bar click-through: the (city, size, mode) whose detail modal is open
  const [detail, setDetail] = useState<{ city: string; label: string; size: HomeSize; mode: EquityMode } | null>(
    null,
  );
  // cost-of-life editor: open flag + a version bump that forces a refetch when
  // a preset is saved/reset (so the charts pick up the new living costs)
  const [editLife, setEditLife] = useState(false);
  const [presetsVersion, setPresetsVersion] = useState(0);
  // recharts' shared=false payload always reports the first series of the
  // hovered group, so the hovered BAR (series + city) is tracked by hand,
  // along with the cursor position (per-Cell bars lose the auto coordinate
  // and the tooltip would fall back to the chart's top-left corner)
  const [hover, setHover] = useState<{ key: string; city: string } | null>(null);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const TIP_W = 270; // approx tooltip width, for the right-edge flip
  // leaving a bar only clears the hover after a beat — moving across the gap
  // to the next bar re-hovers before the timeout, so the tooltip never flashes
  const hoverClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverBar = (key: string, city: string) => {
    if (hoverClear.current) {
      clearTimeout(hoverClear.current);
      hoverClear.current = null;
    }
    setHover({ key, city });
  };
  const unhoverBar = () => {
    if (hoverClear.current) clearTimeout(hoverClear.current);
    hoverClear.current = setTimeout(() => setHover(null), 140);
  };
  // below this width the butterfly can't sit side-by-side — stack the wings,
  // each full-width with its own city labels
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 760px)');
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  // left wing: the hovered (city, tier) set — both its bars highlight and the
  // tooltip breaks down cost vs resource for that one tier
  const [hoverLeft, setHoverLeft] = useState<{ city: string; size: HomeSize } | null>(null);
  const hoverLeftClear = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverSet = (city: string, size: HomeSize) => {
    if (hoverLeftClear.current) {
      clearTimeout(hoverLeftClear.current);
      hoverLeftClear.current = null;
    }
    setHoverLeft({ city, size });
  };
  const unhoverSet = () => {
    if (hoverLeftClear.current) clearTimeout(hoverLeftClear.current);
    hoverLeftClear.current = setTimeout(() => setHoverLeft(null), 140);
  };

  useEffect(() => {
    fetchMeta().then(setMeta).catch(() => setError('Cannot reach the finance service.'));
  }, []);

  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    const params = {
      cities: cities.length ? cities : undefined,
      moveYears: [Number(year)],
      destMode: life,
      equityReturn: ret,
    };
    Promise.all(SIZES.map((s) => fetchPlaceCostSummary({ ...params, homeSize: s.id })))
      .then((results) => {
        if (id !== reqId.current) return;
        setData(Object.fromEntries(SIZES.map((s, i) => [s.id, results[i]])) as Record<HomeSize, PlaceCostSummary>);
        setError(null);
      })
      .catch((e) => {
        if (id === reqId.current) setError((e as Error).message);
      });
    // presetsVersion bumps when a cost-of-life preset is edited → refetch
  }, [cities, year, life, ret, presetsVersion]);

  // shareable URL
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const put = (k: string, v: string, dflt: string) =>
        v === dflt ? url.searchParams.delete(k) : url.searchParams.set(k, v);
      put('pcCities', cities.join(','), '');
      put('pcDistricts', districts.join(','), '');
      put('pcSizes', sizes.join(','), '');
      put('pcYear', year, DEFAULT_YEAR);
      put('pcLife', life, 'comfortable');
      put('pcReturn', String(ret), '0.05');
      put('pcMark', String(mark || 0), String(DEFAULT_EQUITY));
      window.history.replaceState(null, '', url);
    } catch {
      /* non-browser env */
    }
  }, [cities, districts, sizes, year, life, ret, mark]);

  // one row per city. RIGHT side: required equity per size × mode. LEFT side,
  // per home tier: a COST bar (life + mortgage + holding) and a RESOURCE bar
  // (SWE net income + child benefits, plus the sustainable equity withdrawal
  // your Marked equity supports at the chosen Return, keeping the equity
  // growing at inflation after the down payment is pulled out).
  const chartData = useMemo(() => {
    if (!data) return [];
    const y = Number(year);
    const infl = data.comfortable.inflationRate ?? 0.02;
    const base = data.comfortable.cities;
    const rows = base.map((c) => {
      const row: Record<string, string | number | null> = {
        city: shortLabel(c.label),
        id: c.id,
        country: COUNTRY_NAMES[c.country] ?? c.country,
        district: districtOf(c.label),
      };
      const wt = c.wealthTax;
      const cgt = c.cgtRate ?? 0;
      const living = c.years[y] ? Math.round(c.years[y].livingYr) : 0;
      const sweNet = c.years[y]?.sweNetIncome != null ? Math.round(c.years[y].sweNetIncome!) : 0;
      for (const s of SIZES) {
        const e = data[s.id].cities.find((x) => x.id === c.id)?.years[y];
        // right side: required equity
        row[`f_${s.id}`] = e?.fire.total != null ? Math.round(e.fire.total) : null;
        row[`m_${s.id}`] = e?.mortgage.total != null ? Math.round(e.mortgage.total) : null;
        // left side: cost bar (stacked)
        row[`cLiv_${s.id}`] = living;
        row[`cMort_${s.id}`] = Math.round(e?.mortgagePaymentYr ?? 0);
        row[`cHold_${s.id}`] = Math.round(e?.holdingYr ?? 0);
        // left side: resource bar = income + sustainable equity withdrawal.
        // equity left after the down payment, grown-real sustainable draw:
        //   gross = E'·(return − inflation) − wealth tax(E')
        // then net of realised-gains tax, so it reconciles with the FIRE bar
        // (which taxes withdrawals). We assume ~half of a mature withdrawal is
        // taxable gain (basis stepped up at the move, then erodes over time).
        const purchase = e?.purchaseCashOut ?? e?.fire.purchaseCashOut ?? 0;
        const eLeft = Math.max(0, mark - purchase);
        const wtax = wt ? Math.max(0, eLeft - wt.threshold) * wt.rate : 0;
        const gross = Math.max(0, eLeft * (ret - infl) - wtax);
        const netDraw = gross * (1 - cgt * GAIN_FRACTION);
        row[`rInc_${s.id}`] = sweNet;
        row[`rDraw_${s.id}`] = Math.round(netDraw);
      }
      return row;
    });
    rows.sort(
      (a, b) => ((a.f_comfortable as number) ?? Infinity) - ((b.f_comfortable as number) ?? Infinity),
    );
    // hide any place not in the district selection (empty = show all)
    return districts.length ? rows.filter((r) => districts.includes(r.id as string)) : rows;
  }, [data, year, mark, ret, districts]);

  const unsustainable = useMemo(() => {
    if (!data) return [];
    const y = Number(year);
    const out: string[] = [];
    for (const s of SIZES)
      for (const c of data[s.id].cities) {
        if (districts.length && !districts.includes(c.id)) continue;
        if (c.years[y] && c.years[y].fire.total == null) out.push(`${shortLabel(c.label)} ${s.label}`);
      }
    return out;
  }, [data, year, districts]);

  if (error && !data) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const ccy = data.comfortable.baseCurrency;
  // which home tiers to draw (empty selection = all three)
  const visibleSizes = sizes.length ? SIZES.filter((s) => sizes.includes(s.id)) : SIZES;
  const chartHeight = 90 + chartData.length * (isMobile ? 96 : 120);

  // compact, left-aligned city label (city + country) — used on mobile where
  // each wing is full width and carries its own axis
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mobileCityTick = ({ x, y, payload }: any) => {
    const row = chartData.find((r) => r.city === payload.value);
    return (
      <g transform={`translate(${x},${y})`}>
        <text textAnchor="end" x={-6} y={-2} fontSize={11} fontWeight={600} fill="currentColor">
          {payload.value}
        </text>
        <text textAnchor="end" x={-6} y={10} fontSize={9} fill="currentColor" opacity={0.6}>
          {row?.country}
        </text>
      </g>
    );
  };

  // "reachable given your equity" — used to gray out configs on both wings.
  // LEFT: a tier is short when salary + sustainable draw can't cover life +
  // mortgage. RIGHT: a bar is out of reach when its required equity exceeds
  // your marked equity. When no equity is marked, nothing is grayed.
  const GRAY = 0.12;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const leftShort = (row: any, sizeId: string): boolean => {
    const need =
      (row[`cLiv_${sizeId}`] ?? 0) + (row[`cMort_${sizeId}`] ?? 0) + (row[`cHold_${sizeId}`] ?? 0);
    const have = (row[`rInc_${sizeId}`] ?? 0) + (row[`rDraw_${sizeId}`] ?? 0);
    return mark > 0 && have < need;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rightOverMark = (row: any, key: string): boolean => {
    const v = row[key];
    return mark > 0 && v != null && (v as number) > mark;
  };

  return (
    <div className="finance placecost">
      {/* ---------------- controls ---------------- */}
      <div className="fin-summary">
        <div className="fin-controls">
          <MultiSelect
            ariaLabel="Cities"
            allLabel="All cities"
            options={(meta?.cities ?? data.comfortable.cities).map((c) => ({
              id: c.id,
              label: shortLabel(c.label),
            }))}
            values={cities}
            onChange={setCities}
          />
          <MultiSelect
            ariaLabel="Districts"
            allLabel="All districts"
            options={(meta?.cities ?? data.comfortable.cities).map((c) => ({
              id: c.id,
              label: c.label,
            }))}
            values={districts}
            onChange={setDistricts}
          />
          <MultiSelect
            ariaLabel="Home sizes"
            allLabel="All sizes"
            options={SIZES.map((s) => ({ id: s.id, label: `${s.label} · ${s.sqm} m²` }))}
            values={sizes}
            onChange={setSizes}
          />
          <Dropdown
            className="fin-horizon fin-scenario fin-plan"
            ariaLabel="Move year"
            label="Move"
            value={year}
            onChange={setYear}
            options={YEAR_CHOICES.map((y) => ({ id: String(y), label: String(y) }))}
          />
          <Dropdown
            className="fin-horizon fin-scenario fin-plan"
            ariaLabel="Quality of life"
            label="Life"
            value={life}
            onChange={(id) => (id === '__edit' ? setEditLife(true) : setLife(id as DestMode))}
            options={[...LIVES.map((l) => ({ id: l.id, label: l.label })), { id: '__edit', label: '✎ Edit…' }]}
          />
          <Dropdown
            className="fin-horizon fin-scenario fin-plan"
            ariaLabel="Equity return"
            label="Return"
            value={String(ret)}
            onChange={(id) => setRet(Number(id))}
            options={RETURNS}
          />
          <label
            className="fin-horizon fin-scenario pc-amount"
            title="Your equity at the move — sizes the left-side sustainable withdrawal, and draws the marker line on the right"
          >
            <span className="fin-horizon-label">Equity €</span>
            <input
              type="number"
              min={0}
              step={100000}
              value={mark || ''}
              placeholder="e.g. 3M"
              onChange={(e) => setMark(Math.max(0, Number(e.target.value) || 0))}
            />
          </label>
        </div>
      </div>

      <div className="charts">
        <div className="chart bud-chart-wide">
          <div className="pc-butterfly">
          {/* left wing (growing LEFT): per home tier a COST bar (life+mortgage
              +holding) and a RESOURCE bar (income + sustainable equity draw).
              Bars are grouped in tier order; the tier's size-color outlines
              each pair, echoing the right side. */}
          <div className="pc-butterfly-left">
          {isMobile && <div className="pc-wing-title">Yearly need vs have</div>}
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ComposedChart
              data={chartData}
              layout="vertical"
              margin={{ top: 24, right: isMobile ? 12 : 4, left: 10, bottom: 4 }}
              barGap={1}
              barCategoryGap="16%"
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                reversed={!isMobile}
                stroke="currentColor"
                fontSize={12}
                tickFormatter={(v) => abbr(v, ccy)}
              />
              {isMobile ? (
                <YAxis type="category" dataKey="city" width={72} interval={0} tick={mobileCityTick} />
              ) : (
                <YAxis type="category" dataKey="city" hide />
              )}
              <Tooltip
                allowEscapeViewBox={{ x: false, y: true }}
                isAnimationActive={false}
                wrapperStyle={{ zIndex: 40 }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content={({ active, label }: any) => {
                  const row = chartData.find((r) => r.city === label);
                  if (!active || !row) return null;
                  const s =
                    hoverLeft && hoverLeft.city === row.id
                      ? SIZES.find((x) => x.id === hoverLeft.size)
                      : null;
                  // hovering a specific set → full cost/resource breakdown + diff
                  if (s) {
                    const liv = (row[`cLiv_${s.id}`] as number) ?? 0;
                    const mort = (row[`cMort_${s.id}`] as number) ?? 0;
                    const hold = (row[`cHold_${s.id}`] as number) ?? 0;
                    const inc = (row[`rInc_${s.id}`] as number) ?? 0;
                    const draw = (row[`rDraw_${s.id}`] as number) ?? 0;
                    const need = liv + mort + hold;
                    const have = inc + draw;
                    const diff = have - need;
                    const tipRow = (name: string, color: string, v: number) => (
                      <div className="tt-row" key={name}>
                        <span className="tt-dot" style={{ background: color }} />
                        <span className="tt-label">{name}</span>
                        <span className="tt-val">{money(Math.round(v), ccy)}</span>
                      </div>
                    );
                    return (
                      <div className="fin-tooltip pc-tip-fixed">
                        <div className="tt-head">
                          <strong>
                            {label} · {s.label}
                          </strong>
                          <span>per year</span>
                        </div>
                        <div className="pc-tt-grp">
                          <span>Need</span>
                          <b>{money(Math.round(need), ccy)}</b>
                        </div>
                        {tipRow('Living', NEED.living, liv)}
                        {mort > 0.5 && tipRow('Mortgage', NEED.mortgage, mort)}
                        {hold > 0.5 && tipRow('Holding', NEED.holding, hold)}
                        <div className="pc-tt-grp">
                          <span>
                            <i className="tt-dot" style={{ background: HAVE.draw }} /> Equity
                          </span>
                          <b>{money(Math.round(draw), ccy)}</b>
                        </div>
                        <div className="pc-tt-grp">
                          <span>
                            <i className="tt-dot" style={{ background: HAVE.income }} /> Income
                          </span>
                          <b>{money(Math.round(inc), ccy)}</b>
                        </div>
                        <div className="tt-row tt-foot">
                          <span className="tt-label">{diff >= 0 ? 'Surplus' : 'Short'}</span>
                          <span
                            className="tt-val"
                            style={{ color: diff >= 0 ? '#16a34a' : '#dc2626' }}
                          >
                            {diff >= 0 ? '+' : '−'}
                            {money(Math.abs(Math.round(diff)), ccy)}
                          </span>
                        </div>
                      </div>
                    );
                  }
                  // not hovering a specific set → no tooltip
                  return null;
                }}
              />
              {/* declared in tier order: cost then resource, so each pair sits
                  together; hovering any bar highlights the whole (city,tier) set */}
              {visibleSizes.flatMap((s) => {
                const seg = (dataKey: string, name: string, fill: string) => (
                  <Bar
                    key={dataKey}
                    dataKey={dataKey}
                    name={name}
                    stackId={dataKey.startsWith('c') ? `c_${s.id}` : `r_${s.id}`}
                    fill={fill}
                    maxBarSize={9}
                    isAnimationActive={false}
                    cursor="pointer"
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseEnter={(e: any) => hoverSet((e?.payload ?? e)?.id, s.id)}
                    onMouseLeave={unhoverSet}
                  >
                    {chartData.map((row) => (
                      <Cell
                        key={String(row.id)}
                        fillOpacity={
                          hoverLeft
                            ? hoverLeft.city === row.id && hoverLeft.size === s.id
                              ? 1
                              : 0.15
                            : leftShort(row, s.id)
                              ? GRAY
                              : 1
                        }
                      />
                    ))}
                  </Bar>
                );
                return [
                  seg(`cLiv_${s.id}`, 'Living', NEED.living),
                  seg(`cMort_${s.id}`, 'Mortgage', NEED.mortgage),
                  seg(`cHold_${s.id}`, 'Holding', NEED.holding),
                  // Have bar: equity draw first (at the axis), then SWE income
                  seg(`rDraw_${s.id}`, 'Equity draw', HAVE.draw),
                  seg(`rInc_${s.id}`, 'Income', HAVE.income),
                ];
              })}
            </ComposedChart>
          </ResponsiveContainer>
          </div>

          {/* right wing: the required-equity bars (city labels sit between the wings) */}
          <div className="pc-butterfly-right" ref={chartWrapRef}>
          {isMobile && <div className="pc-wing-title">Equity needed</div>}
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ComposedChart
              data={chartData}
              layout="vertical"
              // top margin leaves head-room for the marker line's label
              margin={{ top: 24, right: 24, left: 8, bottom: 4 }}
              barGap={2}
              barCategoryGap="18%"
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onMouseMove={(st: any) => {
                if (st?.chartX != null) setCursorPos({ x: st.chartX, y: st.chartY });
              }}
              onMouseLeave={() => setCursorPos(null)}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                stroke="currentColor"
                fontSize={12}
                tickFormatter={(v) => abbr(v, ccy)}
              />
              {isMobile ? (
                <YAxis type="category" dataKey="city" width={72} interval={0} tick={mobileCityTick} />
              ) : (
                <YAxis
                  type="category"
                  dataKey="city"
                  stroke="currentColor"
                  width={132}
                  interval={0}
                  // the label column sits in the gap between the two wings
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  tick={({ x, y, payload }: any) => {
                    const row = chartData.find((r) => r.city === payload.value);
                    return (
                      <g transform={`translate(${x},${y})`}>
                        <text textAnchor="middle" x={-66} y={-10} fontSize={10.5} fill="currentColor" opacity={0.6}>
                          {row?.country}
                        </text>
                        <text textAnchor="middle" x={-66} y={4} fontSize={12.5} fontWeight={600} fill="currentColor">
                          {payload.value}
                        </text>
                        {row?.district && (
                          <text textAnchor="middle" x={-66} y={17} fontSize={10.5} fill="currentColor" opacity={0.6}>
                            {row.district}
                          </text>
                        )}
                      </g>
                    );
                  }}
                />
              )}
              <Tooltip
                shared={false}
                cursor={false}
                active={!!hover}
                position={
                  cursorPos
                    ? {
                        x:
                          cursorPos.x + 16 + TIP_W > (chartWrapRef.current?.clientWidth ?? Infinity)
                            ? Math.max(0, cursorPos.x - TIP_W - 12)
                            : cursorPos.x + 16,
                        y: cursorPos.y + 14,
                      }
                    : undefined
                }
                isAnimationActive={false}
                allowEscapeViewBox={{ x: false, y: true }}
                wrapperStyle={{ zIndex: 40 }}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                content={({ active, payload }: any) => {
                  // per-BAR tooltip driven by the hand-tracked hover state
                  if (!active || !payload?.length || !hover) return null;
                  const row = payload[0].payload;
                  const s = SIZES.find((x) => x.id === hover.key.slice(2));
                  const v = row?.[hover.key];
                  if (!s || v == null) return null;
                  return (
                    <div className="fin-tooltip">
                      <div className="tt-head">
                        <strong>{row.city}</strong>
                        <span>{hover.key.startsWith('f_') ? 'FIRE' : 'Mortgage-free'}</span>
                      </div>
                      <div className="tt-row">
                        <span className="tt-dot" style={{ background: s.color }} />
                        <span className="tt-label">
                          {s.label} · {s.sqm} m²
                        </span>
                        <span className="tt-val">{money(v, ccy)}</span>
                      </div>
                    </div>
                  );
                }}
              />
              {/* the three mortgage-free bars first, then the three FIRE bars;
                  hover highlights the ONE bar, a click opens its detail modal */}
              {mark > 0 && (
                <ReferenceLine
                  x={mark}
                  stroke="var(--text)"
                  strokeDasharray="5 4"
                  strokeOpacity={0.6}
                  label={{ value: abbr(mark, ccy), position: 'top', offset: 7, fontSize: 11, fill: 'currentColor' }}
                />
              )}
              {/* per size: mortgage-free bar (pale) then FIRE bar (solid) —
                  so each tier's two modes sit together */}
              {visibleSizes.flatMap((s) => {
                const mKey = `m_${s.id}`;
                const fKey = `f_${s.id}`;
                return [
                  <Bar
                    key={mKey}
                    dataKey={mKey}
                    name={`${s.label} mortgage-free`}
                    fill={s.color}
                    isAnimationActive={false}
                    cursor="pointer"
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseEnter={(e: any) => hoverBar(mKey, (e?.payload ?? e)?.id)}
                    onMouseLeave={unhoverBar}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(e: any) => {
                      const p = e?.payload ?? e;
                      if (p?.id) setDetail({ city: p.id, label: p.city, size: s.id, mode: 'mortgage' });
                    }}
                  >
                    {chartData.map((row) => (
                      <Cell
                        key={String(row.id)}
                        fillOpacity={
                          hover
                            ? hover.key === mKey && hover.city === row.id
                              ? 0.85
                              : 0.18
                            : rightOverMark(row, mKey)
                              ? GRAY
                              : MORTGAGE_OPACITY
                        }
                      />
                    ))}
                  </Bar>,
                  <Bar
                    key={fKey}
                    dataKey={fKey}
                    name={`${s.label} FIRE`}
                    fill={s.color}
                    isAnimationActive={false}
                    cursor="pointer"
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onMouseEnter={(e: any) => hoverBar(fKey, (e?.payload ?? e)?.id)}
                    onMouseLeave={unhoverBar}
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onClick={(e: any) => {
                      const p = e?.payload ?? e;
                      if (p?.id) setDetail({ city: p.id, label: p.city, size: s.id, mode: 'fire' });
                    }}
                  >
                    {chartData.map((row) => (
                      <Cell
                        key={String(row.id)}
                        fillOpacity={
                          hover
                            ? hover.key === fKey && hover.city === row.id
                              ? 1
                              : 0.3
                            : rightOverMark(row, fKey)
                              ? GRAY
                              : 1
                        }
                      />
                    ))}
                  </Bar>,
                ];
              })}
            </ComposedChart>
          </ResponsiveContainer>
          </div>
          </div>
          {/* color = home size; the paler bar of the same hue is mortgage-free */}
          <div className="pc-legend">
            <span className="pc-legend-sec">Need:</span>
            <span className="pc-legend-item">
              <i style={{ background: NEED.living }} />
              Living
            </span>
            <span className="pc-legend-item">
              <i style={{ background: NEED.mortgage }} />
              Mortgage
            </span>
            <span className="pc-legend-item">
              <i style={{ background: NEED.holding }} />
              Holding
            </span>
            <span className="pc-legend-sec">Have:</span>
            <span className="pc-legend-item">
              <i style={{ background: HAVE.income }} />
              SWE net + benefits
            </span>
            <span className="pc-legend-item">
              <i style={{ background: HAVE.draw }} />
              Equity draw
            </span>
            <span className="pc-legend-sec">Right · equity needed:</span>
            {visibleSizes.map((s) => (
              <span className="pc-legend-item" key={s.id}>
                <i style={{ background: s.color }} />
                {s.label} ({s.sqm} m²)
              </span>
            ))}
            <span className="pc-legend-note">solid = FIRE · pale = mortgage-free</span>
          </div>
          {unsustainable.length > 0 && (
            <div className="pc-warn">
              Not sustainable at this return (no bar): {unsustainable.join(', ')}.
            </div>
          )}
        </div>
      </div>

      {detail && (
        <ScenarioDetail
          city={detail.city}
          cityLabel={detail.label}
          size={detail.size}
          mode={detail.mode}
          year={Number(year)}
          life={life}
          ret={ret}
          onClose={() => setDetail(null)}
        />
      )}

      {editLife && (
        <LivingEditModal
          cities={(meta?.cities ?? data.comfortable.cities).map((c) => ({
            id: c.id,
            label: shortLabel(c.label),
          }))}
          initialCity={cities[0] ?? data.comfortable.cities[0]?.id ?? 'amsterdam'}
          initialPreset={life}
          onClose={() => setEditLife(false)}
          onSaved={() => setPresetsVersion((v) => v + 1)}
        />
      )}
    </div>
  );
}
