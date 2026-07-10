import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { RankedDistrict } from './cityRanking';

/** Fallback tier colours — the real ones are the table's CSS vars `--tier-*`, read
 *  live at render so a pin is exactly the colour of that district's total-score chip. */
const TIER_FALLBACK: Record<string, string> = {
  exceptional: '#16a34a',
  strong: '#22b8cf',
  good: '#eab308',
  acceptable: '#f97316',
  weak: '#ef4444',
};

/** A Leaflet map (OpenStreetMap tiles) with one score-coloured pin per district.
 *  Pins recolour live when the weighting changes (rows carry the weighted total). */
export function MapView({
  rows, onSelect, selected,
}: {
  rows: RankedDistrict[];
  onSelect: (id: string) => void;
  selected: string | null;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);
  const fitted = useRef(false);

  // Initialise the map once.
  useEffect(() => {
    if (!elRef.current || mapRef.current) return;
    const map = L.map(elRef.current, { scrollWheelZoom: true }).setView([50, 9], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      fitted.current = false;
    };
  }, []);

  // (Re)draw pins whenever the ranking/selection changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    // Read the table's live tier colours so each pin == its total-score chip.
    const cs = getComputedStyle(map.getContainer());
    const tierColor = (key: string) => cs.getPropertyValue(`--tier-${key}`).trim() || TIER_FALLBACK[key] || '#888';
    const pts: [number, number][] = [];
    for (const r of rows) {
      const c = r.coords; // geocoded server-side (see the city-ranking service)
      if (!c) continue;
      pts.push(c);
      const isSel = r.data.id === selected;
      const marker = L.circleMarker(c, {
        radius: isSel ? 11 : 7,
        fillColor: tierColor(r.tier.key),
        color: isSel ? '#111' : '#fff',
        weight: isSel ? 3 : 1,
        fillOpacity: 0.92,
      });
      marker.bindTooltip(`<b>${r.data.district}</b> · ${r.total.toFixed(1)}${r.dealbreaker ? ' ⚠' : ''}`, {
        direction: 'top',
        offset: [0, -4],
      });
      marker.on('click', () => onSelect(r.data.id));
      layer.addLayer(marker);
    }
    if (!fitted.current && pts.length) {
      map.fitBounds(L.latLngBounds(pts).pad(0.12));
      fitted.current = true;
    }
    setTimeout(() => map.invalidateSize(), 0); // in case the container just became visible
  }, [rows, selected, onSelect]);

  // Fly to the selected pin — e.g. arriving from the table's "Show on map".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;
    const c = rows.find((r) => r.data.id === selected)?.coords;
    if (!c) return;
    const t = setTimeout(() => {
      map.invalidateSize();
      map.flyTo(c, Math.max(map.getZoom(), 9), { duration: 0.6 });
    }, 60);
    return () => clearTimeout(t);
  }, [selected, rows]);

  const missing = rows.filter((r) => !r.coords).length;
  return (
    <div className="places-mapwrap">
      <div className="places-map" ref={elRef} aria-label="Map of districts coloured by score" />
      {missing > 0 && <div className="places-map-note">{missing} district(s) not yet located — run the geocoder.</div>}
    </div>
  );
}
