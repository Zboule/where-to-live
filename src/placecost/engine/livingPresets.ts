import { listConfigGroups, loadFinanceConfig } from './config';
import { CITIES } from './scenarios';
import type { ExpenseConfig } from './types';

// ===========================================================================
//  UI-managed destination cost-of-life presets.
//
//  Each destination (city) has two presets — Comfortable and Simple — that the
//  place-cost explorer uses as the post-move cost of living. They started as
//  YAML variant files (destination_living/<city>[-simple].yaml); the Place-cost
//  "Edit life" modal OWNS them as data, SEEDED once from the YAML then edited.
//
//  ── Persistence seam ────────────────────────────────────────────────────────
//  The server saved edits to a JSON file on disk. This standalone browser port
//  saves them to localStorage instead, one key per (city, preset):
//  `wtl-living-<city>-<comfortable|simple>`. getLivingPreset returns the seed
//  overlaid with any stored edit; save/reset write/remove the key. The seed
//  itself is computed EXACTLY as the server did (from the bundled config), so
//  unedited numbers match the backend by construction.
// ===========================================================================

const STORE_PREFIX = 'wtl-living-';
const storeKey = (cityId: string, preset: Preset) => `${STORE_PREFIX}${cityId}-${preset}`;

/** Categories the editor offers — the Expenses-tab taxonomy plus Education
 *  (a major, distinct relocation cost the living budgets have always tracked). */
export const LIVING_CATEGORIES = [
  'Home',
  'Food',
  'Transport',
  'Travel',
  'Staff',
  'Lifestyle',
  'Education',
  'Other',
] as const;

export type Preset = 'comfortable' | 'simple';

export interface LivingItem {
  id: string;
  name: string;
  category: string;
  currency: string;
  per_year: number;
  growth_rate: number;
}

export interface LivingPreset {
  currency: string;
  items: LivingItem[];
}

// ---- category remap: old dl_ categories → the full taxonomy -----------------
function remapCategory(id: string, cat: string): string {
  if (/grocer|restaurant|\bfood\b/i.test(id)) return 'Food';
  if (/travel|holiday|flight/i.test(id)) return 'Travel';
  if (cat === 'Education') return 'Education';
  if ((LIVING_CATEGORIES as readonly string[]).includes(cat)) return cat;
  return 'Other';
}

// ---- store I/O (localStorage, one key per city+preset) ----------------------
function readEdit(cityId: string, preset: Preset): LivingPreset | undefined {
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(storeKey(cityId, preset));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as LivingPreset;
  } catch {
    return undefined;
  }
}

function writeEdit(cityId: string, preset: Preset, value: LivingPreset): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(storeKey(cityId, preset), JSON.stringify(value));
}

function removeEdit(cityId: string, preset: Preset): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.removeItem(storeKey(cityId, preset));
}

// ---- seed from the bundled config -------------------------------------------
const seedCache = new Map<string, LivingPreset>();

/** The living variant id for a (city, preset): the city's variant, or its
 *  `-simple` sibling when it exists (else the comfortable one). */
function variantFor(cityLiving: string, preset: Preset): string {
  if (preset === 'comfortable') return cityLiving;
  const ids = listConfigGroups().find((g) => g.key === 'expenses:destination_living')?.variants.map((v) => v.id) ?? [];
  return ids.includes(`${cityLiving}-simple`) ? `${cityLiving}-simple` : cityLiving;
}

function seedPreset(cityId: string, preset: Preset): LivingPreset {
  const key = `${cityId}:${preset}`;
  const cached = seedCache.get(key);
  if (cached) return structuredClone(cached);

  const city = CITIES.find((c) => c.id === cityId);
  if (!city) throw Object.assign(new Error(`unknown city "${cityId}"`), { statusCode: 404 });
  const variant = variantFor(city.living, preset);
  const cfg = loadFinanceConfig({
    groups: { 'expenses:destination_living': variant },
    enabled: ['expenses:destination_living'],
  });
  const items: LivingItem[] = (cfg.expenses ?? [])
    .filter((e) => e.id.startsWith('dl_'))
    .map((e) => {
      const g = e.growth?.[0];
      const perYear = g ? (g.per_year ?? (g.per_month ?? 0) * 12) : (e.per_year ?? (e.per_month ?? 0) * 12);
      return {
        id: e.id,
        name: e.name,
        category: remapCategory(e.id, e.category ?? 'Other'),
        currency: e.currency,
        per_year: Math.round(perYear),
        growth_rate: g?.growth_rate ?? (e.grows_with === 'none' ? 0 : 0.02),
      };
    });
  const seeded: LivingPreset = { currency: items[0]?.currency ?? 'EUR', items };
  seedCache.set(key, structuredClone(seeded));
  return seeded;
}

// ---- public API -------------------------------------------------------------

/** The effective preset for a (city, preset): the stored edit, or the seed. */
export function getLivingPreset(cityId: string, preset: Preset): LivingPreset {
  const stored = readEdit(cityId, preset);
  return stored ?? seedPreset(cityId, preset);
}

/** Whether this (city, preset) has been edited (differs from the seed). */
export function isLivingEdited(cityId: string, preset: Preset): boolean {
  return !!readEdit(cityId, preset);
}

/** Engine expense items for the place-cost living schedule. */
export function livingEngineItems(cityId: string, preset: Preset, baseYear: number): ExpenseConfig[] {
  return getLivingPreset(cityId, preset).items.map((it) => ({
    id: it.id,
    name: it.name,
    category: it.category,
    currency: it.currency,
    growth: [{ year: baseYear, per_year: it.per_year, growth_rate: it.growth_rate }],
  }));
}

// ---- mutations --------------------------------------------------------------
const isMoney = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isRate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > -1 && v < 1;

function fail(msg: string, code = 400): never {
  throw Object.assign(new Error(msg), { statusCode: code });
}

function validate(cityId: string, preset: Preset, p: LivingPreset): void {
  if (!CITIES.some((c) => c.id === cityId)) fail(`unknown city "${cityId}"`, 404);
  if (preset !== 'comfortable' && preset !== 'simple') fail(`preset must be comfortable|simple`);
  if (!p.currency?.trim()) fail('currency is required');
  if (!Array.isArray(p.items) || !p.items.length) fail('a preset needs at least one item');
  const seen = new Set<string>();
  for (const it of p.items) {
    const where = `item "${it.id || it.name || '?'}"`;
    if (!/^[a-z0-9_]+$/.test(it.id ?? '')) fail(`${where}: id must be a snake_case slug`);
    if (!it.name?.trim()) fail(`${where}: name is required`);
    if (!(LIVING_CATEGORIES as readonly string[]).includes(it.category)) fail(`${where}: unknown category "${it.category}"`);
    if (!isMoney(it.per_year)) fail(`${where}: per_year must be a number >= 0`);
    if (!isRate(it.growth_rate)) fail(`${where}: growth_rate must be a decimal rate`);
    if (seen.has(it.id)) fail(`${where}: duplicate item id`);
    seen.add(it.id);
  }
}

/** Save an edited preset (validated). Overrides the seed until reset. */
export function saveLivingPreset(cityId: string, preset: Preset, value: LivingPreset): LivingPreset {
  // normalize currency onto every item so the engine converts correctly
  const items = value.items.map((it) => ({ ...it, currency: it.currency || value.currency }));
  const next: LivingPreset = { currency: value.currency, items };
  validate(cityId, preset, next);
  writeEdit(cityId, preset, next);
  return next;
}

/** Reset a (city, preset) back to its (bundled) YAML seed. */
export function resetLivingPreset(cityId: string, preset: Preset): LivingPreset {
  removeEdit(cityId, preset);
  return seedPreset(cityId, preset);
}
