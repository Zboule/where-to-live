import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export interface DropdownOption {
  id: string;
  label: string;
  /** Optional secondary value, aligned to the END of the row (e.g. a per-city move year). */
  end?: string | null;
}

/**
 * A small reusable dropdown that replaces a native <select> wherever the app needs a styled
 * picker. Unlike a native select it: opens DOWNWARD, anchors its menu to the input's LEFT
 * edge, and can show an `end` value right-aligned per row (a clean trailing column). Closes
 * on outside-click / Escape. Pass `className` for the chip wrapper (e.g. the plan-control or
 * scenario-chip styling) and `label` for the leading tag.
 */
export function Dropdown({
  value, options, onChange, label, labelClassName = 'fin-horizon-label', className, ariaLabel, onConfigure,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (id: string) => void;
  label?: ReactNode;
  labelClassName?: string;
  className?: string;
  ariaLabel?: string;
  /** Renders a trailing "⚙ Configure…" row in the menu (e.g. opens the preset editor). */
  onConfigure?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const current = options.find((o) => o.id === value);
  return (
    <div className={`fin-dd${className ? ' ' + className : ''}`} ref={ref} aria-label={ariaLabel}>
      {label != null && <span className={labelClassName}>{label}</span>}
      <button type="button" className="fin-scenario-select fin-dd-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="fin-dd-name">{current?.label ?? value}</span>
        {current?.end != null && <span className="fin-dd-end">{current.end}</span>}
      </button>
      {open && (
        <div className="fin-dd-menu" role="listbox">
          {options.map((o) => (
            <button key={o.id} type="button" role="option" aria-selected={o.id === value}
              className={`fin-dd-item${o.id === value ? ' sel' : ''}`}
              onClick={() => { onChange(o.id); setOpen(false); }}>
              <span className="fin-dd-name">{o.label}</span>
              {o.end != null && <span className="fin-dd-end">{o.end}</span>}
            </button>
          ))}
          {onConfigure && (
            <button type="button" className="fin-dd-item fin-dd-configure"
              onClick={() => { setOpen(false); onConfigure(); }}>
              <span className="fin-dd-name">⚙ Configure…</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
