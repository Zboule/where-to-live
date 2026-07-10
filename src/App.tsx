import { useEffect, useState } from 'react';
import { PlacesPage } from './city/PlacesPage';
import { PlaceCostPage } from './placecost/PlaceCostPage';

// Two tools for one relocation decision, extracted from the family dashboard
// into a standalone public app (same model as Mortgage Rider): everything runs
// in the browser — the district dataset, the Kid-Raising scoring, the cost
// engine and the finance place-cost engine are all bundled at build time.

type Tab = 'places' | 'placecost';
const TABS: Tab[] = ['places', 'placecost'];
const DEFAULT_TAB: Tab = 'places';

const PAGES: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'places', label: 'Places', icon: '🌍' },
  { tab: 'placecost', label: 'Place cost', icon: '🧳' },
];

/** Read the active page from the `?tab=` query param (falls back to the default). */
function readTabFromUrl(): Tab {
  try {
    const v = new URLSearchParams(window.location.search).get('tab');
    return TABS.includes(v as Tab) ? (v as Tab) : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>(readTabFromUrl);
  const [menuOpen, setMenuOpen] = useState(false);

  // keep the URL in sync so the chosen page survives reloads and is shareable
  const selectTab = (next: Tab) => {
    setTab(next);
    setMenuOpen(false);
    try {
      const url = new URL(window.location.href);
      if (next === DEFAULT_TAB) url.searchParams.delete('tab');
      else url.searchParams.set('tab', next);
      window.history.replaceState(null, '', url);
    } catch {
      /* ignore (non-browser env) */
    }
  };

  // Escape closes the drawer
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const current = PAGES.find((p) => p.tab === tab)!;

  return (
    <div className="app">
      <header>
        <div className="header-left">
          <button
            className="nav-burger"
            aria-label="Open menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <span />
            <span />
            <span />
          </button>
          <h1>{current.label}</h1>
        </div>
        {/* pages inject header actions here */}
        <div className="header-actions" id="header-actions" />
      </header>

      {menuOpen && <div className="nav-backdrop" onClick={() => setMenuOpen(false)} />}

      <aside className={menuOpen ? 'nav-drawer open' : 'nav-drawer'} aria-hidden={!menuOpen}>
        <div className="nav-drawer-head">
          <span className="nav-drawer-title">Where to Live</span>
          <button className="nav-close" aria-label="Close menu" onClick={() => setMenuOpen(false)}>
            ✕
          </button>
        </div>
        <nav className="nav-links">
          <div className="nav-group">
            {PAGES.map((p) => (
              <button
                key={p.tab}
                className={tab === p.tab ? 'nav-link active' : 'nav-link'}
                onClick={() => selectTab(p.tab)}
              >
                <span className="nav-icon">{p.icon}</span>
                {p.label}
              </button>
            ))}
          </div>
        </nav>
        <div className="nav-sep" />
        <nav className="nav-links">
          {/* sibling public app — the cross-country mortgage calculator */}
          <a
            className="nav-link external"
            href="https://zboule.github.io/mortgage-rider/"
            target="_blank"
            rel="noopener"
          >
            <span className="nav-icon">🏇</span>
            Mortgage Rider
            <span className="nav-ext">↗</span>
          </a>
        </nav>
      </aside>

      {tab === 'places' ? <PlacesPage /> : <PlaceCostPage />}
    </div>
  );
}
