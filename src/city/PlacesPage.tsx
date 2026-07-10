import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCityRankingMeta,
  fetchRankings,
  loadEvidence,
  type CityRankingMeta,
  type EvDim,
  type EvLeaf,
  type Evidence,
  type RankedDistrict,
  type WeightMap,
} from './cityRanking';
import { MapView } from './MapView';

// The Places tab is a THIN CLIENT: the district data, Kid-Raising scoring and
// cost engine live in the city-ranking service (Zboule/city-ranking,
// /api/city-ranking/*). This page fetches /meta once, /rankings per weight
// change (debounced), and renders. Filters/sorting stay client-side.

const WEIGHTS_KEY = 'places-weights-v1';

const SUPPORT_LABEL: Record<string, string> = {
  strongly_supported: 'strong', leans_supported: 'leans yes', mixed: 'mixed',
  leans_contradicted: 'leans no', strongly_contradicted: 'weak/false', unknown: 'unknown',
};

const eur = new Intl.NumberFormat('en-IE', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});
const fmtScore = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtHours = (h: number) => `${h % 1 === 0 ? h : h.toFixed(1)}h`;
// Budget-category swatch colours — match the Finance modal's expense palette.
const COST_CAT_COLOR: Record<string, string> = { Home: '#f59e0b', Transport: '#ef4444', Staff: '#a855f7', Lifestyle: '#ec4899' };

type SortKey = string;

interface Column {
  key: SortKey;
  label: string;
  short: string;
  value: (d: RankedDistrict) => number;
  max?: number;
  filter: 'min' | 'max' | 'direct';
  step?: number;
}

/** The score column is rendered separately but shares the same filter machinery. */
const SCORE_FILTER: Column = { key: 'score', label: 'Total score', short: 'Score', value: (d) => d.total, max: 100, filter: 'min', step: 5 };

// Short header labels — each is a recognisable shortening of the full dimension
// name shown in the detail view, so the two views line up.
function shortLabel(key: string): string {
  return ({
    education: 'Education',
    safe_independence: 'Safe independence',
    peer_environment: 'Peer environment',
    mental_health: 'Mental health',
    health: 'Health',
    nature: 'Nature',
    family_practicality: 'Practicality',
    language: 'Language',
    weather: 'Weather',
  } as Record<string, string>)[key] ?? key;
}

const dim = (d: RankedDistrict, key: string) => d.dimensions.find((x) => x.key === key)!;

/** Map a 0–1 "share of max earned" to a quality colour class (green→red). */
function levelClass(frac: number): string {
  if (frac >= 0.9) return 'lvl-perfect';
  if (frac >= 0.75) return 'lvl-vgood';
  if (frac >= 0.6) return 'lvl-good';
  if (frac >= 0.4) return 'lvl-fair';
  return 'lvl-weak';
}

/** Map a tier key to its rollup-bar colour class, so the total bar matches the tier badge. */
const TIER_LEVEL: Record<string, string> = {
  exceptional: 'lvl-perfect',
  strong: 'lvl-vgood',
  good: 'lvl-good',
  acceptable: 'lvl-fair',
  weak: 'lvl-weak',
};

/** Per-column header filter control: a ≥/≤ numeric threshold, or a direct-only toggle. */
function FilterCell({
  col, value, directOnly, onNum, onDirect,
}: {
  col: Column;
  value: number | undefined;
  directOnly: boolean;
  onNum: (v: number | null) => void;
  onDirect: (b: boolean) => void;
}) {
  if (col.filter === 'direct') {
    return (
      <button
        className={`places-direct-toggle${directOnly ? ' on' : ''}`}
        title="Show only districts with a direct flight to Yerevan"
        onClick={() => onDirect(!directOnly)}
      >
        {directOnly ? '✓ direct' : 'direct?'}
      </button>
    );
  }
  return (
    <input
      type="number"
      className={`places-colfilter${value != null ? ' on' : ''}`}
      step={col.step}
      placeholder={col.filter === 'min' ? '≥' : '≤'}
      title={`Show only ${col.short} ${col.filter === 'min' ? '≥' : '≤'} a value`}
      value={value ?? ''}
      onChange={(e) => onNum(e.target.value === '' ? null : Number(e.target.value))}
    />
  );
}

/** Fetch /meta once, then render the page proper. */
export function PlacesPage() {
  const [meta, setMeta] = useState<CityRankingMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  useEffect(() => {
    fetchCityRankingMeta().then(setMeta, (e) => setMetaError(String(e?.message ?? e)));
  }, []);
  if (metaError) {
    return (
      <div className="card" style={{ borderColor: 'crimson' }}>
        <h2>Couldn’t reach the city-ranking service</h2>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{metaError}</pre>
      </div>
    );
  }
  if (!meta) return <div className="empty"><p>Loading districts…</p></div>;
  return <PlacesPageInner meta={meta} />;
}

function PlacesPageInner({ meta }: { meta: CityRankingMeta }) {
  const WEIGHT_FACTORS = useMemo(
    () => [
      ...meta.dimensions.map((d) => ({ key: d.key, label: d.label })),
      { key: 'connectivity', label: 'Family connectivity' },
    ],
    [meta],
  );
  const PRESETS: Record<string, WeightMap> = useMemo(
    () => ({
      Default: { ...meta.defaultWeights },
      'Academics first': { ...meta.defaultWeights, education: 32, mental_health: 14, family_practicality: 7 },
      Wellbeing: { ...meta.defaultWeights, mental_health: 18, safe_independence: 18, health: 12, education: 14 },
      Outdoorsy: { ...meta.defaultWeights, nature: 13, weather: 12, health: 10, education: 16 },
    }),
    [meta],
  );
  // Every scored factor is a column, in the same order as the detail breakdown.
  const COLUMNS: Column[] = useMemo(
    () => [
      ...meta.dimensions.map((def): Column => ({
        key: def.key, label: def.label, short: shortLabel(def.key), value: (d) => dim(d, def.key).points, max: def.weight, filter: 'min', step: 1,
      })),
      { key: 'connectivity', label: 'Connectivity (direct flights to Yerevan & Paris)', short: 'Family connectivity', value: (d) => d.connectivity.points, max: meta.connectivityWeight, filter: 'min', step: 1 },
      { key: 'price', label: 'Price €/m²', short: '€/m²', value: (d) => d.data.price_per_sqm.average, filter: 'max', step: 1000 },
      { key: 'monthlycost', label: 'Monthly cost (excl. rent) — your Abu Dhabi lifestyle re-priced for this district', short: 'Cost/mo', value: (d) => d.monthlyCostEur ?? Number.POSITIVE_INFINITY, filter: 'max', step: 1000 },
    ],
    [meta],
  );

  const [weights, setWeights] = useState<WeightMap>(() => {
    try {
      const s = localStorage.getItem(WEIGHTS_KEY);
      if (s) return { ...meta.defaultWeights, ...JSON.parse(s) };
    } catch { /* ignore */ }
    return { ...meta.defaultWeights };
  });
  const [showWeights, setShowWeights] = useState(false);
  const [viewMode, setViewMode] = useState<'table' | 'map'>('table');
  useEffect(() => {
    try { localStorage.setItem(WEIGHTS_KEY, JSON.stringify(weights)); } catch { /* ignore */ }
  }, [weights]);
  // Normalise to 100 so the total still reads "/100" whatever the raw sliders sum to.
  const normWeights = useMemo(() => {
    const sum = WEIGHT_FACTORS.reduce((s, f) => s + (weights[f.key] || 0), 0) || 1;
    return Object.fromEntries(WEIGHT_FACTORS.map((f) => [f.key, ((weights[f.key] || 0) / sum) * 100]));
  }, [weights, WEIGHT_FACTORS]);

  // Re-rank on the server, debounced (the sliders fire continuously) with the
  // previous ranking kept on screen; stale responses are dropped.
  const [rows, setRows] = useState<RankedDistrict[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  useEffect(() => {
    const id = ++reqId.current;
    const t = setTimeout(() => {
      fetchRankings(normWeights).then(
        (r) => {
          if (reqId.current === id) { setRows(r); setError(null); }
        },
        (e) => {
          if (reqId.current === id) setError(String(e?.message ?? e));
        },
      );
    }, rows === null ? 0 : 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normWeights]);

  const ranked = rows ?? [];

  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('all');
  const [hideDealbreakers, setHideDealbreakers] = useState(false);
  const [colFilters, setColFilters] = useState<Record<string, number>>({});
  const [directOnly, setDirectOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'rank', dir: 'asc' });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hoverDim, setHoverDim] = useState<string | null>(null);

  const setColFilter = (key: string, value: number | null) =>
    setColFilters((f) => {
      const next = { ...f };
      if (value == null || Number.isNaN(value)) delete next[key];
      else next[key] = value;
      return next;
    });
  const countries = useMemo(
    () => Array.from(new Set(ranked.map((r) => r.data.country))).sort(),
    [ranked],
  );

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const checks = [...COLUMNS, SCORE_FILTER];
    let out = ranked.filter((r) => {
      if (q && !`${r.data.district} ${r.data.city} ${r.data.country}`.toLowerCase().includes(q)) return false;
      if (country !== 'all' && r.data.country !== country) return false;
      if (hideDealbreakers && r.dealbreaker) return false;
      if (directOnly && !r.connectivity.yerevanDirect) return false;
      for (const c of checks) {
        const t = colFilters[c.key];
        if (t == null) continue;
        if (c.filter === 'min' && c.value(r) < t) return false;
        if (c.filter === 'max' && c.value(r) > t) return false;
      }
      return true;
    });

    const col = sort.key === 'score' ? SCORE_FILTER : COLUMNS.find((c) => c.key === sort.key);
    out = [...out].sort((a, b) => {
      let cmp: number;
      if (sort.key === 'rank') cmp = a.rank - b.rank;
      else if (col) cmp = col.value(a) - col.value(b);
      else cmp = a.total - b.total;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
    return out;
  }, [ranked, query, country, hideDealbreakers, colFilters, directOnly, sort, COLUMNS]);

  if (error && !rows) {
    return (
      <div className="card" style={{ borderColor: 'crimson' }}>
        <h2>Couldn’t load places</h2>
        <pre style={{ whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{error}</pre>
      </div>
    );
  }
  if (!rows) return <div className="empty"><p>Ranking districts…</p></div>;

  const onSort = (key: SortKey) => {
    const lowerIsBetter = key === 'price' || key === 'monthlycost' || key === 'paris' || key === 'yerevan' || key === 'rank';
    setSort((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: lowerIsBetter ? 'asc' : 'desc' },
    );
  };
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="places">
      <div className="places-controls">
        <input
          className="places-search"
          placeholder="Search district, city or country…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="places-select" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="all">All countries</option>
          {countries.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <label className="places-minscore">
          Min score
          <input
            type="number" min={0} max={100} step={5} placeholder="≥"
            value={colFilters.score ?? ''}
            onChange={(e) => setColFilter('score', e.target.value === '' ? null : Number(e.target.value))}
          />
        </label>
        <label className="places-toggle">
          <input type="checkbox" checked={directOnly} onChange={(e) => setDirectOnly(e.target.checked)} />
          Direct flight to Yerevan
        </label>
        <label className="places-toggle">
          <input type="checkbox" checked={hideDealbreakers} onChange={(e) => setHideDealbreakers(e.target.checked)} />
          Hide deal-breakers
        </label>
        <button className={`places-wbtn${showWeights ? ' on' : ''}`} onClick={() => setShowWeights((s) => !s)} title="Adjust how much each factor counts toward the total">
          ⚖ Weighting{showWeights ? ' ▾' : ' ▸'}
        </button>
        <div className="places-viewtoggle" role="group" aria-label="View mode">
          <button className={viewMode === 'table' ? 'on' : ''} onClick={() => setViewMode('table')}>Table</button>
          <button className={viewMode === 'map' ? 'on' : ''} onClick={() => setViewMode('map')}>Map</button>
        </div>
        <span className="places-count">{view.length} of {ranked.length}</span>
      </div>

      {showWeights && (
        <WeightPanel weights={weights} setWeights={setWeights} factors={WEIGHT_FACTORS} presets={PRESETS} defaults={meta.defaultWeights} />
      )}

      {viewMode === 'map' ? (
        <MapView
          rows={view}
          selected={expanded}
          onSelect={(id) => {
            const d = ranked.find((r) => r.data.id === id)?.data;
            if (d) setQuery(d.district); // filter the table down to this district
            setExpanded(id);
            setViewMode('table');
          }}
        />
      ) : (
      <div className="places-tablewrap">
        <table className="places-table">
          <thead>
            <tr className="places-headrow">
              <th className="num sortable" onClick={() => onSort('rank')}>#{arrow('rank')}</th>
              <th className="place">District</th>
              {COLUMNS.map((c, i) => (
                <th
                  key={c.key}
                  className={`rot sortable${c.key === 'price' ? ' col-price' : ''}${c.key === 'monthlycost' ? ' col-cost' : ''}${c.key !== 'monthlycost' ? ' col-sec' : ''}${hoverDim === c.key ? ' hl' : ''}`}
                  title={c.max != null ? `${c.label} — up to ${c.max} pts` : c.label}
                  style={{ zIndex: COLUMNS.length - i + 1 }}
                  onClick={() => onSort(c.key)}
                >
                  <span className="places-rot">{c.short}{c.max != null && <span className="places-hwt"> /{c.max}</span>}{arrow(c.key)}</span>
                </th>
              ))}
              <th className="rot sortable" title="Total Kid-Raising Score (out of 100)" style={{ zIndex: 1 }} onClick={() => onSort('score')}>
                <span className="places-rot">{arrow('score')}</span>
              </th>
            </tr>
            <tr className="places-filterrow">
              <th />
              <th className="place">
                <span className="places-filterhint">filter ▾</span>
              </th>
              {COLUMNS.map((c) => (
                <th key={c.key} className="num">
                  <FilterCell
                    col={c}
                    value={colFilters[c.key]}
                    directOnly={directOnly}
                    onNum={(v) => setColFilter(c.key, v)}
                    onDirect={setDirectOnly}
                  />
                </th>
              ))}
              <th className="num">
                <FilterCell col={SCORE_FILTER} value={colFilters.score} directOnly={directOnly} onNum={(v) => setColFilter('score', v)} onDirect={setDirectOnly} />
              </th>
            </tr>
          </thead>
          <tbody>
            {view.map((r) => (
              <DistrictRow
                key={r.data.id}
                r={r}
                meta={meta}
                columnsCount={COLUMNS.length}
                open={expanded === r.data.id}
                onToggle={() => setExpanded((id) => (id === r.data.id ? null : r.data.id))}
                hoverDim={hoverDim}
                onHoverDim={setHoverDim}
                onShowOnMap={() => { setExpanded(r.data.id); setViewMode('map'); }}
              />
            ))}
            {view.length === 0 && (
              <tr><td colSpan={COLUMNS.length + 3} className="places-empty">No districts match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

/** Live weighting of the factors — re-ranked by the service per (debounced) change. */
function WeightPanel({
  weights, setWeights, factors, presets, defaults,
}: {
  weights: WeightMap;
  setWeights: (w: WeightMap) => void;
  factors: { key: string; label: string }[];
  presets: Record<string, WeightMap>;
  defaults: WeightMap;
}) {
  const sum = factors.reduce((s, f) => s + (weights[f.key] || 0), 0);
  const set = (key: string, v: number) => setWeights({ ...weights, [key]: Math.max(0, Number.isFinite(v) ? v : 0) });
  return (
    <div className="places-weights">
      <div className="places-weights-head">
        <span className="places-weights-title">Factor importance — re-ranks live (the evidence doesn’t change)</span>
        <div className="places-weights-presets">
          {Object.keys(presets).map((name) => (
            <button key={name} className="places-wpreset" onClick={() => setWeights({ ...presets[name] })}>{name}</button>
          ))}
        </div>
      </div>
      <div className="places-weights-grid">
        {factors.map((f) => {
          const raw = weights[f.key] || 0;
          const pct = sum > 0 ? (raw / sum) * 100 : 0;
          return (
            <div className="places-wrow" key={f.key}>
              <label className="places-wlabel" title={f.label}>{f.label}</label>
              <input className="places-wslider" type="range" min={0} max={30} step={1} value={raw} onChange={(e) => set(f.key, Number(e.target.value))} />
              <input className="places-wnum" type="number" min={0} max={60} value={raw} onChange={(e) => set(f.key, Number(e.target.value))} />
              <span className="places-wpct">{pct.toFixed(0)}%</span>
            </div>
          );
        })}
      </div>
      <div className="places-weights-foot">
        <span className="places-wsum">raw total {sum} → normalised to 100</span>
        <button className="places-wreset" onClick={() => setWeights({ ...defaults })}>Reset to defaults</button>
      </div>
    </div>
  );
}

function DistrictRow({
  r, meta, columnsCount, open, onToggle, hoverDim, onHoverDim, onShowOnMap,
}: {
  r: RankedDistrict;
  meta: CityRankingMeta;
  columnsCount: number;
  open: boolean;
  onToggle: () => void;
  hoverDim: string | null;
  onHoverDim: (key: string | null) => void;
  onShowOnMap: () => void;
}) {
  const p = r.data.price_per_sqm;
  const monthlyCost = r.monthlyCostEur;
  const costMult = r.costMultiplier;
  // Lazy-load the supporting evidence the first time the row is expanded.
  const [evidence, setEvidence] = useState<Evidence | null | undefined>(undefined);
  useEffect(() => {
    if (open && evidence === undefined) loadEvidence(r.data.id).then(setEvidence);
  }, [open, evidence, r.data.id]);
  const cell = (key: string, points: number, max: number) => (
    <td
      key={key}
      className={`num col-sec${hoverDim === key ? ' hl' : ''}`}
      onMouseEnter={() => onHoverDim(key)}
      onMouseLeave={() => onHoverDim(null)}
    >
      <CellPts points={points} max={max} />
    </td>
  );
  return (
    <>
      <tr className={`places-row${open ? ' open' : ''}`} onClick={onToggle}>
        <td className="num rank">{r.rank}</td>
        <td className="place">
          <div className="places-name">
            <span className="places-disc" aria-hidden>{open ? '▾' : '▸'}</span>
            <span>
              <strong>{r.data.district}</strong>
              {r.dealbreaker && <span className="places-flag" title={`Deal-breaker: ${r.dealbreakerDims.join(', ')}`}>⚠</span>}
              <span className="places-sub">{r.data.city}, {r.data.country}</span>
            </span>
          </div>
        </td>
        {meta.dimensions.map((def) => { const d = dim(r, def.key); return cell(def.key, d.points, d.weight); })}
        {cell('connectivity', r.connectivity.points, r.connectivity.weight)}
        <td className="num col-sec" title={`${eur.format(p.lower)} – ${eur.format(p.upper)}`}>{eur.format(p.average)}</td>
        <td
          className="num places-costcell"
          title={monthlyCost != null
            ? `Your Abu Dhabi lifestyle excl. rent (${eur.format(meta.costMeta.ad_monthly_eur)}/mo) costs about ${eur.format(monthlyCost)}/mo here — ${costMult?.toFixed(2)}× Abu Dhabi. Housing is separate — see the €/m² column.`
            : 'No cost data for this district'}
        >
          {monthlyCost != null ? (
            <>
              {eur.format(monthlyCost)}
              {costMult != null && <span className="places-costx">{costMult.toFixed(2)}×</span>}
            </>
          ) : '—'}
        </td>
        <td className="num">
          <span className={`places-score tier-${r.tier.key}`}>{r.total.toFixed(1)}</span>
        </td>
      </tr>
      {open && (
        <tr className="places-detailrow">
          <td colSpan={columnsCount + 3}>
            <DistrictDetail r={r} meta={meta} hoverDim={hoverDim} onHoverDim={onHoverDim} evidence={evidence} onShowOnMap={onShowOnMap} />
          </td>
        </tr>
      )}
    </>
  );
}

/** A compact "points contributed" chip; the fill shows the share of the max earned. */
function CellPts({ points, max }: { points: number; max: number }) {
  const frac = max > 0 ? points / max : 0;
  return (
    <span className="cell5" title={`${fmtScore(points)} of ${max} pts`}>
      <span className={`cell5-bar ${levelClass(frac)}`} style={{ width: `${frac * 100}%` }} />
      <span className="cell5-val">{fmtScore(points)}</span>
    </span>
  );
}

interface DetailRow {
  key: string;
  label: string;
  points: number;
  weight: number;
  note?: string;
  danger?: boolean;
}

/** All factors (researched dimensions + computed connectivity), as points contributed. */
function detailRows(r: RankedDistrict): DetailRow[] {
  const c = r.connectivity;
  const connNote =
    `Yerevan: ${c.yerevanDirect ? `direct flight (~${fmtHours(r.data.travel.yerevan_hours)})` : `needs a transfer (~${fmtHours(r.data.travel.yerevan_hours)}, change of plane/mode)`}. ` +
    `Paris: ${c.parisDirect ? `direct ${r.data.travel.paris_mode} (~${fmtHours(r.data.travel.paris_hours)})` : `needs a transfer (~${fmtHours(r.data.travel.paris_hours)})`}. ` +
    `A direct trip matters far more than the flight length.`;
  return [
    ...r.dimensions.map((d) => ({
      key: d.key,
      label: d.label,
      points: d.points,
      weight: d.weight,
      note: d.note,
      danger: d.critical && d.score <= 1,
    })),
    { key: 'connectivity', label: 'Family connectivity', points: c.points, weight: c.weight, note: connNote },
  ];
}

function DistrictDetail({
  r, meta, hoverDim, onHoverDim, evidence, onShowOnMap,
}: {
  r: RankedDistrict;
  meta: CityRankingMeta;
  hoverDim: string | null;
  onHoverDim: (key: string | null) => void;
  evidence: Evidence | null | undefined;
  onShowOnMap: () => void;
}) {
  const p = r.data.price_per_sqm;
  const rows = detailRows(r);
  const cost = r.costBreakdown;
  const [openEv, setOpenEv] = useState<string | null>(null);
  return (
    <div className="places-detail">
      <div className="places-detail-head">
        <div>
          <span className={`places-tier tier-${r.tier.key}`}>{r.tier.label} · {r.tier.band}</span>
          <button className="places-mapbtn" onClick={onShowOnMap} title="Show this district on the map">📍 Show on map</button>
          {r.data.blurb && <p className="places-blurb">{r.data.blurb}</p>}
        </div>
        <div className="places-detail-stats">
          <Stat label="Price €/m²" value={`${eur.format(p.lower)}–${eur.format(p.average)}`} sub={`up to ${eur.format(p.upper)}`} />
          <Stat label="→ Paris" value={fmtHours(r.data.travel.paris_hours)} sub={r.data.travel.paris_mode} />
          <Stat label="→ Yerevan" value={fmtHours(r.data.travel.yerevan_hours)} sub={r.connectivity.yerevanDirect ? 'direct' : 'transfer'} />
        </div>
      </div>

      <div className="places-rollup">
        <div className="places-rollup-bar" title="Total Kid-Raising Score out of 100">
          <div className={`places-rollup-fill ${TIER_LEVEL[r.tier.key]}`} style={{ width: `${r.total}%` }} />
          <span className="places-rollup-score"><b>{r.total.toFixed(1)}</b> / 100{r.dealbreaker ? ' · ⚠ deal-breaker' : ''}</span>
        </div>
      </div>

      {cost && (
        <div className="places-cost">
          <div className="places-cost-head">
            <span className="places-cost-title">Monthly cost of living — your Abu Dhabi lifestyle re-priced here <span className="places-cost-rule">excl. rent</span></span>
            <span className="places-cost-total">
              <b>{eur.format(cost.hereEur)}</b>/mo
              <span className="places-cost-vs">vs {eur.format(cost.adEur)} in Abu Dhabi · <b>{cost.multiplier.toFixed(2)}×</b></span>
            </span>
          </div>
          <table className="places-cost-table">
            <thead>
              <tr><th>Category</th><th className="num">Abu Dhabi</th><th className="num">ratio</th><th className="num">Here</th></tr>
            </thead>
            <tbody>
              {cost.groups.map((g) => (
                <Fragment key={g.category}>
                  <tr className="places-cost-grouprow">
                    <td><span className="places-cost-swatch" style={{ background: COST_CAT_COLOR[g.category] ?? 'var(--muted)' }} />{g.category}</td>
                    <td className="num">{eur.format(g.adEur)}</td>
                    <td className={`num places-cost-ratio${g.ratio > 1.02 ? ' up' : g.ratio < 0.98 ? ' down' : ''}`}>{g.ratio.toFixed(2)}×</td>
                    <td className="num"><b>{eur.format(g.hereEur)}</b></td>
                  </tr>
                  {g.lines.map((l) => (
                    <tr key={l.key} className="places-cost-itemrow">
                      <td className="places-cost-item">{l.label} <span className="places-cost-rule">{meta.costRuleLabels[l.rule]}</span></td>
                      <td className="num">{eur.format(l.adEur)}</td>
                      <td className={`num places-cost-ratio${l.ratio > 1.02 ? ' up' : l.ratio < 0.98 ? ' down' : ''}`}>{l.ratio.toFixed(2)}×</td>
                      <td className="num">{eur.format(l.hereEur)}</td>
                    </tr>
                  ))}
                </Fragment>
              ))}
              <tr className="places-cost-totalrow">
                <td>Total <span className="places-cost-rule">excl. rent</span></td>
                <td className="num">{eur.format(cost.adEur)}</td>
                <td className="num">{cost.multiplier.toFixed(2)}×</td>
                <td className="num"><b>{eur.format(cost.hereEur)}</b></td>
              </tr>
            </tbody>
          </table>
          <div className="places-cost-foot">
            Basis: Numbeo prices for <b>{cost.numbeoCity}</b>
            {cost.fallbackFrom ? ` (nearest surveyed city to ${r.data.city})` : ''} vs Abu Dhabi (NYC=100 indices).
            Staff priced at the local full-time domestic-help cost (min wage + employer charges); car, travel, health &amp; subscriptions held flat.
            Rent is excluded from the total{(() => { const rl = cost.lines.find((l) => l.key === 'rent'); return rl ? ` (it'd run ~${rl.ratio.toFixed(2)}× Abu Dhabi here)` : ''; })()} — housing is a separate decision; see the {eur.format(p.average)}/m² buy price above.
          </div>
        </div>
      )}

      <div className="places-bars">
        {[...rows].sort((a, b) => b.weight - a.weight).map((d) => {
          const frac = d.weight > 0 ? d.points / d.weight : 0;
          const ev = evidence ? evidence.dimensions[d.key] : undefined;
          return (
            <Fragment key={d.key}>
              <div
                className={`places-fbar${hoverDim === d.key ? ' hl' : ''}`}
                onMouseEnter={() => onHoverDim(d.key)}
                onMouseLeave={() => onHoverDim(null)}
              >
                <div className="places-fbar-bar" title={`Worth ${d.weight} of 100 points`}>
                  <div className="places-fbar-max" style={{ width: `${d.weight * 12}px` }} />
                  <div className={`places-fbar-fill ${levelClass(frac)}`} style={{ width: `${d.points * 12}px` }} />
                  <span className="places-fbar-score"><b>{fmtScore(d.points)}</b> / {d.weight}</span>
                </div>
                <div className="places-fbar-body">
                  <div className="places-fbar-label">{d.label}</div>
                  {d.note && <div className="places-fbar-note">{d.note}</div>}
                  {ev && (
                    <button
                      className="places-ev-toggle"
                      onClick={() => setOpenEv((k) => (k === d.key ? null : d.key))}
                    >
                      {openEv === d.key ? '▾ hide evidence' : `▸ evidence (${ev.leaves.length} claims)`}
                    </button>
                  )}
                </div>
              </div>
              {openEv === d.key && ev && <EvidencePanel dim={ev} />}
            </Fragment>
          );
        })}
      </div>

      {evidence === null && (
        <div className="places-ev-none">Evidence not yet collected for this district (run the rescore pipeline).</div>
      )}
      {r.data.sources && r.data.sources.length > 0 && (
        <div className="places-sources">Sources: {r.data.sources.join(' · ')}</div>
      )}
    </div>
  );
}

/** The supporting-evidence drill-down for one dimension (consolidated report). */
function EvidencePanel({ dim }: { dim: EvDim }) {
  const c = dim.calibrated;
  return (
    <div className="places-ev">
      <div className="places-ev-scores">
        {dim.math != null && <span className="places-ev-chip" title="deterministic rules-based score">math <b>{fmtScore(dim.math)}</b></span>}
        {dim.llm != null && <span className="places-ev-chip" title="holistic model judgment">judgment <b>{fmtScore(dim.llm)}</b></span>}
        {c ? (
          <span className="places-ev-chip cal" title="cross-district calibrated final (median of 3 reads)">
            calibrated <b>{fmtScore(c.final)}</b>
            <span className="places-ev-mut"> · median {fmtScore(c.median)} of {c.reads.map(fmtScore).join(' / ')}</span>
          </span>
        ) : (
          <span className="places-ev-mut">calibration pending</span>
        )}
      </div>
      {dim.report && <p className="places-ev-report">{dim.report}</p>}
      <div className="places-ev-leaves">
        {dim.leaves.map((l) => <EvLeafRow key={l.id} l={l} />)}
      </div>
    </div>
  );
}

function EvBullets({ kind, items }: { kind: 'for' | 'against' | 'unknown'; items: string[] }) {
  if (!items.length) return null;
  const head = kind === 'for' ? 'supports' : kind === 'against' ? 'against' : 'not found';
  return (
    <div className={`places-ev-bul ${kind}`}>
      <span className="places-ev-bul-h">{head}</span>
      <ul>{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}

function EvLeafRow({ l }: { l: EvLeaf }) {
  return (
    <div className="places-ev-leaf">
      <div className="places-ev-leaf-head">
        <span className={`places-ev-sup sup-${l.support}`}>{SUPPORT_LABEL[l.support] ?? l.support}</span>
        <span className="places-ev-leaf-label">
          {l.label}
          {l.core && <span className="places-ev-tag core" title="load-bearing (core leaf)">core</span>}
          {l.bonus && <span className="places-ev-tag bonus" title="bonus-only — never penalises">bonus</span>}
        </span>
        {l.confidence && <span className="places-ev-conf">{l.confidence}</span>}
      </div>
      {l.rationale && <div className="places-ev-rat">{l.rationale}</div>}
      <EvBullets kind="for" items={l.for} />
      <EvBullets kind="against" items={l.against} />
      <EvBullets kind="unknown" items={l.unknowns} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="places-stat">
      <div className="places-stat-label">{label}</div>
      <div className="places-stat-value">{value}</div>
      {sub && <div className="places-stat-sub">{sub}</div>}
    </div>
  );
}
