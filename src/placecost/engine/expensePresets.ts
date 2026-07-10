import type { ExpenseConfig, ExpenseSegment } from './types';
import bundleData from './financeConfig.generated.json';

// ===========================================================================
//  UI-managed household expense presets.
//
//  The lifestyle presets (Simple / Good / Gorgeous …) started as YAML variant
//  files; on the server the dashboard's "Expense configuration" editor OWNED
//  them as an editable JSON store, seeded once from the YAML files.
//
//  In this standalone place-cost port the household budget is NOT user-editable
//  (it only feeds the config loader's validation — the place-cost numbers depend
//  on the relocation home + destination living presets, not this). So this module
//  is READ-ONLY: it just returns the presets SEEDED from the bundled YAML docs
//  (financeConfig.generated.json → householdSeed), exactly as the server seeded
//  them. The seed logic is unchanged; only its source (disk YAML → bundle) moved.
// ===========================================================================

/** Categories the dashboard knows how to color/group. */
export const EXPENSE_CATEGORIES = ['Home', 'Transport', 'Staff', 'Lifestyle', 'Travel', 'Food', 'Other'] as const;

export interface PresetBudgetRef {
  categories: string[]; // budget category ids summed
  /** THIS CALENDAR YEAR's monthly figure: (actual months so far + remaining
   *  months forecast at the trailing-12m average) / 12. */
  resolved_per_month: number;
  anchor_month: string; // last statement month the figure is computed at, YYYY-MM
  resolved_at?: string; // when it was computed (staleness hint)
  /** Legacy trailing-window length (pre calendar-year semantics). Ignored. */
  months?: number;
}

export interface PresetBase {
  mode: 'manual' | 'budget';
  year: number; // the base segment's calendar year
  per_month?: number; // manual amount; for 'budget' the pre-anchor fallback
  growth_rate: number; // decimal / yr
  budget?: PresetBudgetRef; // mode 'budget' only
}

export interface PresetStep {
  year: number;
  per_month: number;
  growth_rate?: number; // omit => keep the base rate
}

export interface PresetItem {
  id: string;
  name: string;
  category: string;
  currency: string; // AED for the household budget
  base: PresetBase;
  steps?: PresetStep[];
}

export interface ExpensePreset {
  id: string;
  label: string;
  order?: number; // picker sort hint (ladder reads low→high)
  items: PresetItem[];
}

// ------------------------------ seeding -----------------------------------

const householdSeed = (bundleData as unknown as {
  householdSeed: { file: string; doc: Record<string, any> }[];
}).householdSeed;

const monthly = (s: { per_month?: number; per_year?: number }): number =>
  s.per_month ?? (s.per_year != null ? Math.round(s.per_year / 12) : 0);

/** One-time conversion of the (bundled) YAML variant docs into store presets. */
function seedFromYaml(): ExpensePreset[] {
  const presets: ExpensePreset[] = [];
  for (const { file, doc } of householdSeed) {
    const id = file.replace(/\.yaml$/, '');
    const items: PresetItem[] = (doc.items ?? []).map((it: any) => {
      const segs: any[] = it.growth ?? [{ year: 2026, per_month: it.per_month, per_year: it.per_year, growth_rate: 0.02 }];
      const [first, ...rest] = segs;
      return {
        id: it.id,
        name: it.name,
        category: it.category ?? 'Other',
        currency: it.currency ?? 'AED',
        base: { mode: 'manual', year: first.year, per_month: monthly(first), growth_rate: first.growth_rate ?? 0.02 },
        ...(rest.length
          ? { steps: rest.map((s) => ({ year: s.year, per_month: monthly(s), growth_rate: s.growth_rate })) }
          : {}),
      };
    });
    presets.push({ id, label: doc.variant_label ?? id, order: doc.order, items });
  }
  return presets;
}

// ------------------------------ store I/O ---------------------------------
// Read-only: the seed is the store (no persistence in the place-cost port).
let cache: ExpensePreset[] | null = null;

export function readPresets(): ExpensePreset[] {
  if (!cache) cache = seedFromYaml();
  return cache;
}

export function getPreset(id: string): ExpensePreset {
  const p = readPresets().find((x) => x.id === id);
  if (!p) throw Object.assign(new Error(`unknown expense preset "${id}"`), { statusCode: 404 });
  return p;
}

// --------------------------- engine conversion ----------------------------

/** A store item's engine growth schedule. Budget bases restart the schedule at
 *  the anchor year (the resolved average is "spend as of the last statements");
 *  the manual/seeded amount covers the years before it. */
function scheduleOf(it: PresetItem): ExpenseSegment[] {
  const b = it.base;
  const segs: ExpenseSegment[] = [];
  if (b.mode === 'budget' && b.budget) {
    const anchorYear = Number(b.budget.anchor_month.slice(0, 4));
    if (b.per_month != null && anchorYear > b.year) {
      segs.push({ year: b.year, per_month: b.per_month, growth_rate: b.growth_rate });
    }
    // The resolved figure IS the anchor year's calendar-year average (actuals +
    // remaining-month forecast), so it sits naturally on the engine's Jan-1
    // year grid — no sub-year rebasing needed.
    segs.push({ year: anchorYear, per_month: b.budget.resolved_per_month, growth_rate: b.growth_rate });
  } else {
    segs.push({ year: b.year, per_month: b.per_month ?? 0, growth_rate: b.growth_rate });
  }
  for (const st of it.steps ?? []) {
    const i = segs.findIndex((s) => s.year === st.year);
    const seg = { year: st.year, per_month: st.per_month, growth_rate: st.growth_rate ?? b.growth_rate };
    if (i >= 0) segs[i] = seg;
    else segs.push(seg);
  }
  return segs.sort((a, b2) => a.year - b2.year);
}

/** The engine `ExpenseConfig[]` for one preset (what the loader assembles). */
export function presetEngineItems(preset: ExpensePreset): ExpenseConfig[] {
  return preset.items.map((it) => ({
    id: it.id,
    name: it.name,
    category: it.category,
    currency: it.currency,
    growth: scheduleOf(it),
  }));
}
