import { useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
  id: string;
  label: string;
}

/** Chevron — an SVG, because the ▾/‹/› text glyphs render tiny and off-center.
 * Sized/positioned by the flex row it sits in; inherits currentColor. */
export function Caret({
  className = 'msel-caret',
  dir = 'down',
}: {
  className?: string;
  dir?: 'down' | 'left' | 'right';
}) {
  const horizontal = dir !== 'down';
  const d =
    dir === 'down' ? 'M1.5 1.5l4 4 4-4' : dir === 'left' ? 'M5.5 1.5l-4 4 4 4' : 'M1.5 1.5l4 4-4 4';
  return (
    <svg
      className={className}
      width={horizontal ? 7 : 11}
      height={horizontal ? 11 : 7}
      viewBox={horizontal ? '0 0 7 11' : '0 0 11 7'}
      aria-hidden="true"
    >
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Generic multi-select dropdown: a compact trigger summarizing the selection
 * ("All accounts" / "Main, Saving" / "3 selected") that opens a checkbox menu.
 * An EMPTY selection means "no filter" (= all): the top `allLabel` row clears
 * it. Picking options keeps the menu open (it's a multi-select); outside click
 * or Escape closes it. Style hooks: .msel / .msel-btn / .msel-menu / .msel-item.
 */
/**
 * Single-select sibling of MultiSelect: same trigger + menu look (msel-*
 * style hooks), but radio semantics — picking an option closes the menu.
 */
export function Select({
  options, value, onChange, className, ariaLabel,
}: {
  options: MultiSelectOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const current = options.find((o) => o.id === value);
  return (
    <div className={`msel${className ? ' ' + className : ''}`} ref={ref} aria-label={ariaLabel}>
      <button
        type="button"
        className="msel-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="msel-val">{current?.label ?? value}</span>
        <Caret />
      </button>
      {open && (
        <div className="msel-menu" role="listbox">
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={o.id === value}
              className={o.id === value ? 'msel-item sel' : 'msel-item'}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
            >
              <span className="msel-check">{o.id === value ? '✓' : ''}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function MultiSelect({
  options, values, onChange, allLabel = 'All', className, ariaLabel,
}: {
  options: MultiSelectOption[];
  values: string[];
  onChange: (values: string[]) => void;
  allLabel?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // capture phase so Escape closes the menu without also closing a parent modal
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  const toggle = (id: string) =>
    onChange(values.includes(id) ? values.filter((v) => v !== id) : [...values, id]);
  const summary =
    values.length === 0
      ? allLabel
      : values.length <= 2
        ? options.filter((o) => values.includes(o.id)).map((o) => o.label).join(', ')
        : `${values.length} selected`;
  return (
    <div className={`msel${className ? ' ' + className : ''}`} ref={ref} aria-label={ariaLabel}>
      <button
        type="button"
        className={values.length ? 'msel-btn on' : 'msel-btn'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="msel-val">{summary}</span>
        <Caret />
      </button>
      {open && (
        <div className="msel-menu" role="listbox" aria-multiselectable="true">
          <button
            type="button"
            role="option"
            aria-selected={values.length === 0}
            className={values.length === 0 ? 'msel-item msel-all sel' : 'msel-item msel-all'}
            onClick={() => {
              onChange([]);
              setOpen(false);
            }}
          >
            <span className="msel-check">{values.length === 0 ? '✓' : ''}</span>
            {allLabel}
          </button>
          {options.map((o) => {
            const sel = values.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={sel}
                className={sel ? 'msel-item sel' : 'msel-item'}
                onClick={() => toggle(o.id)}
              >
                <span className="msel-check">{sel ? '✓' : ''}</span>
                {o.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
