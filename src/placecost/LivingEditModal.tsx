import { useEffect, useMemo, useState } from 'react';
import { Dropdown } from './ui/Dropdown';
import {
  fetchLivingPresets,
  resetLivingPreset,
  saveLivingPreset,
  type CityLivingPresets,
  type DestMode,
  type LivingItem,
  type LivingPreset,
} from './placeCost';

// Edit a destination's cost-of-life presets (Comfortable / Simple). Pick a
// city + preset, edit the line items grouped by the shared expense taxonomy;
// Save writes to the model, Reset reverts to the shipped YAML seed.

const slug = () => 'x' + Math.random().toString(36).slice(2, 8);

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

export function LivingEditModal({
  cities,
  initialCity,
  initialPreset,
  onClose,
  onSaved,
}: {
  cities: { id: string; label: string }[];
  initialCity: string;
  initialPreset: DestMode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [city, setCity] = useState(initialCity);
  const [preset, setPreset] = useState<DestMode>(initialPreset);
  const [loaded, setLoaded] = useState<CityLivingPresets | null>(null);
  const [items, setItems] = useState<LivingItem[]>([]);
  const [currency, setCurrency] = useState('EUR');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (re)load the two presets whenever the city changes
  useEffect(() => {
    setLoaded(null);
    fetchLivingPresets(city)
      .then((d) => {
        setLoaded(d);
        setError(null);
      })
      .catch(() => setError('Cannot load the presets.'));
  }, [city]);

  // seed the editable rows from the chosen preset
  useEffect(() => {
    if (!loaded) return;
    const p = loaded[preset];
    setItems(p.items.map((it) => ({ ...it })));
    setCurrency(p.currency);
    setDirty(false);
  }, [loaded, preset]);

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

  const categories = loaded?.categories ?? [];
  const total = useMemo(() => items.reduce((s, it) => s + (it.per_year || 0), 0), [items]);
  const byCategory = useMemo(() => {
    const groups: { cat: string; items: (LivingItem & { idx: number })[] }[] = [];
    items.forEach((it, idx) => {
      let g = groups.find((x) => x.cat === it.category);
      if (!g) groups.push((g = { cat: it.category, items: [] }));
      g.items.push({ ...it, idx });
    });
    // sort groups by the taxonomy order
    groups.sort((a, b) => categories.indexOf(a.cat) - categories.indexOf(b.cat));
    return groups;
  }, [items, categories]);

  const patch = (idx: number, p: Partial<LivingItem>) => {
    setItems((xs) => xs.map((it, i) => (i === idx ? { ...it, ...p } : it)));
    setDirty(true);
  };
  const remove = (idx: number) => {
    setItems((xs) => xs.filter((_, i) => i !== idx));
    setDirty(true);
  };
  const addLine = (cat: string) => {
    setItems((xs) => [
      ...xs,
      { id: slug(), name: 'New line', category: cat, currency, per_year: 0, growth_rate: 0.02 },
    ]);
    setDirty(true);
  };

  const save = async () => {
    setBusy(true);
    try {
      const value: LivingPreset = { currency, items: items.map((it) => ({ ...it, currency })) };
      await saveLivingPreset(city, preset, value);
      setDirty(false);
      onSaved();
      const d = await fetchLivingPresets(city);
      setLoaded(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('Reset this preset to the shipped default? Your edits are discarded.')) return;
    setBusy(true);
    try {
      await resetLivingPreset(city, preset);
      onSaved();
      const d = await fetchLivingPresets(city);
      setLoaded(d);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const edited = loaded?.[preset].edited;

  return (
    <>
      <div className="pc-modal-backdrop" onClick={onClose} />
      <div className="pc-modal lc-modal" role="dialog" aria-modal="true">
        <button className="bud-close bud-close-abs" onClick={onClose}>
          ✕
        </button>
        <h2 className="pc-modal-title">Edit cost of life</h2>

        <div className="lc-controls">
          <Dropdown
            className="fin-horizon fin-scenario fin-plan"
            ariaLabel="City"
            label="City"
            value={city}
            onChange={setCity}
            options={cities}
          />
          <div className="lc-preset-toggle" role="group" aria-label="Preset">
            {(['comfortable', 'simple'] as DestMode[]).map((p) => (
              <button key={p} className={preset === p ? 'on' : ''} onClick={() => setPreset(p)}>
                {p === 'comfortable' ? 'Comfortable' : 'Simple'}
              </button>
            ))}
          </div>
          {edited && <span className="lc-edited">edited</span>}
          <span className="lc-total">
            {fmt(Math.round(total))} {currency}/yr
          </span>
        </div>

        {error && <div className="pc-error">{error}</div>}
        {!loaded ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="lc-groups">
            {categories.map((cat) => {
              const g = byCategory.find((x) => x.cat === cat);
              const rows = g?.items ?? [];
              const subtotal = rows.reduce((s, it) => s + (it.per_year || 0), 0);
              return (
                <section className="lc-group" key={cat}>
                  <div className="lc-group-head">
                    <span>
                      <i className="tt-dot" style={{ background: `var(--cat-${cat.toLowerCase()}, var(--cat-other))` }} />
                      {cat}
                    </span>
                    <b>{fmt(Math.round(subtotal))}</b>
                    <button className="lc-add" title={`Add a ${cat} line`} onClick={() => addLine(cat)}>
                      + line
                    </button>
                  </div>
                  {rows.map((it) => (
                    <div className="lc-row" key={it.idx}>
                      <input
                        className="lc-name"
                        value={it.name}
                        onChange={(e) => patch(it.idx, { name: e.target.value })}
                      />
                      <select
                        className="lc-cat"
                        value={it.category}
                        onChange={(e) => patch(it.idx, { category: e.target.value })}
                      >
                        {categories.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                      <input
                        className="lc-amt"
                        type="number"
                        min={0}
                        step={100}
                        value={it.per_year}
                        onChange={(e) => patch(it.idx, { per_year: Math.max(0, Number(e.target.value) || 0) })}
                      />
                      <label className="lc-growth" title="Annual growth rate">
                        <input
                          type="number"
                          step={0.5}
                          value={+(it.growth_rate * 100).toFixed(1)}
                          onChange={(e) => patch(it.idx, { growth_rate: (Number(e.target.value) || 0) / 100 })}
                        />
                        %/y
                      </label>
                      <button className="lc-del" title="Remove" onClick={() => remove(it.idx)}>
                        ✕
                      </button>
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        )}

        <div className="lc-actions">
          <button className="lc-reset" onClick={reset} disabled={busy || !edited}>
            Reset to default
          </button>
          <div className="lc-actions-right">
            <button className="lc-cancel" onClick={onClose}>
              Close
            </button>
            <button className="lc-save" onClick={save} disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
