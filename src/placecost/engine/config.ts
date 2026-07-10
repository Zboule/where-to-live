import { getPreset, presetEngineItems, readPresets } from './expensePresets';
import { getIncomePreset, incomePresetEngineItem, readIncomePresets } from './incomePresets';
import type { ExpenseConfig, FinanceConfig, IncomeConfig, InvestmentConfig, RealEstateConfig } from './types';
import bundleData from './financeConfig.generated.json';

// ===========================================================================
//  Modular config loader.
//
//  `config/finance.yaml` holds the INVARIANTS (base date/currency, horizons,
//  inflation, fx_rates, cash). Everything that can vary lives in
//  `config/sections/` with ONE uniform layout:
//
//       sections/{category}/{id}/{variant}.yaml
//
//  A CATEGORY is a kind of thing (income, expenses, real-estate, investments); an
//  ID is one entity within it (a salary, a property, a portfolio); a VARIANT is a
//  scenario for that entity. Each variant file carries a `variant_label:`. Most
//  categories are "object" — the file IS one entity. `expenses` is a "bundle" —
//  the file holds many line items under `items:` (a budget swapped as a set).
//
//  The loader assembles each category's list from its entities, picking each
//  entity's `default` variant unless the UI selects another, and skipping entities
//  toggled off. New entities (id folders) and variants (files) are auto-discovered.
//
//  ── I/O seam ──────────────────────────────────────────────────────────────
//  In the original server this module parsed the YAML from disk at load. This
//  standalone browser port has no filesystem and no YAML parser in the bundle, so
//  scripts/gen-placecost.mjs parses the YAML at build time into ONE bundled JSON
//  (financeConfig.generated.json) that we consume here. `base` is the parsed
//  invariants; `sections` is every parsed variant file, in the same sorted-path
//  order the server produced. The assembly logic below is otherwise unchanged.
// ===========================================================================

interface Bundle {
  base: FinanceConfig;
  sections: { path: string; doc: Record<string, any> }[];
  householdSeed: { file: string; doc: Record<string, any> }[];
  incomeSeed: { file: string; doc: Record<string, any> }[];
}
const bundle = bundleData as unknown as Bundle;

// Invariants (one object), used as the fresh-clone template each load.
const base = bundle.base;
// Section variant docs keyed by path — pre-parsed, in the deterministic entity
// order the server's sorted import.meta.glob produced.
const sectionDocs = bundle.sections;

/** The variant applied when nothing else is picked. Every entity folder needs one. */
export const DEFAULT_VARIANT = 'default';

/** Calendar year of meta.base_date — the year the simulation starts from. */
export function baseDateYear(): number {
  const bd = base.meta.base_date as unknown;
  return bd instanceof Date ? bd.getUTCFullYear() : Number(String(bd).slice(0, 4));
}

type CategoryList = IncomeConfig[] | ExpenseConfig[] | RealEstateConfig[] | InvestmentConfig[];

/** Per-category behaviour. The folder name keys the registry; `mode` says how a
 *  variant file maps to entries, and `set` says where the assembled list goes. */
interface Category {
  folder: string;
  label: string;
  /** 'object': the file is one entity. 'bundle': the file's `items:` are the entries. */
  mode: 'object' | 'bundle';
  set: (cfg: FinanceConfig, list: CategoryList) => void;
}

// Display order is registry order.
const CATEGORIES: Category[] = [
  { folder: 'income', label: 'Income', mode: 'object', set: (c, l) => { c.incomes = l as IncomeConfig[]; } },
  { folder: 'expenses', label: 'Expenses', mode: 'bundle', set: (c, l) => { c.expenses = l as ExpenseConfig[]; } },
  { folder: 'real-estate', label: 'Real estate', mode: 'object', set: (c, l) => { c.assets.real_estate = l as RealEstateConfig[]; } },
  { folder: 'investments', label: 'Investment', mode: 'object', set: (c, l) => { c.assets.investments = l as InvestmentConfig[]; } },
];
const CATEGORY_BY_FOLDER = new Map(CATEGORIES.map((c) => [c.folder, c]));

interface VariantFile {
  category: string; // folder
  entityId: string; // id folder
  variant: string; // filename
  variantLabel: string; // for the picker
  entityName: string; // entity display name (from its body)
  entries: any[]; // the engine objects this variant contributes (1 for object, N for bundle)
  defaultOn: boolean; // entity included by default? (false => off until enabled in the UI)
  order?: number; // optional picker sort hint (lets a budget ladder read low→high)
}

/** Parse `{category}/{id}/{variant}.yaml` (the bundled doc) into a VariantFile. */
function parseVariant(path: string, raw: Record<string, any>): VariantFile {
  const [category, entityId, variant] = path.replace(/\.yaml$/, '').split('/');
  const cat = CATEGORY_BY_FOLDER.get(category);
  if (!cat) throw new Error(`finance config: unknown section category "${category}" (${path})`);
  const doc = (raw ?? {}) as Record<string, any>;
  const variantLabel = doc.variant_label ?? prettyLabel(variant);
  const entityName = doc.name ?? entityId;
  const defaultOn = doc.enabled !== false; // entities ship on unless `enabled: false`
  const order = typeof doc.order === 'number' ? doc.order : undefined; // optional picker sort hint
  let entries: any[];
  if (cat.mode === 'bundle') {
    entries = (doc.items ?? []) as any[];
  } else {
    const entity = { ...doc }; // the file IS the entity; drop only the picker-only fields
    delete entity.variant_label;
    delete entity.order;
    entries = [entity];
  }
  return { category, entityId, variant, variantLabel, entityName, entries, defaultOn, order };
}

// Turn every bundled section doc into a VariantFile once at module load.
const variants: VariantFile[] = sectionDocs.map(({ path, doc }) => parseVariant(path, doc));

/** Selection/URL key for an entity. */
function entityKey(category: string, entityId: string): string {
  return `${category}:${entityId}`;
}

/** Entity ids within a category, in first-seen (sorted-path) order. */
function entityIds(category: string): string[] {
  const ids: string[] = [];
  for (const v of variants) if (v.category === category && !ids.includes(v.entityId)) ids.push(v.entityId);
  return ids;
}

// ----------------------------- UI model -----------------------------------

export interface VariantOption {
  id: string;
  label: string;
  order?: number;
}

export interface ConfigGroup {
  /** Stable key used in `Selection` and the URL, e.g. "real-estate:dun_laoghaire". */
  key: string;
  category: string;
  /** Entity display name (e.g. "36 Harbour Court"). */
  label: string;
  id: string;
  /** Every entity can be toggled on/off. */
  toggleable: boolean;
  /** Whether this entity is included unless the UI says otherwise. */
  defaultOn: boolean;
  /** The `default` option first, then any other variants A→Z. */
  variants: VariantOption[];
}

/** Every tunable entity, in category then entity order, for the pickers. */
export function listConfigGroups(): ConfigGroup[] {
  const groups: ConfigGroup[] = [];
  for (const cat of CATEGORIES) {
    for (const id of entityIds(cat.folder)) {
      groups.push({
        key: entityKey(cat.folder, id),
        category: cat.folder,
        label: entityName(cat.folder, id),
        id,
        toggleable: true,
        defaultOn: entityDefaultOn(cat.folder, id),
        variants: variantOptions(cat.folder, id),
      });
    }
  }
  return groups;
}

/** Whether an entity's variants live in a UI-managed preset store instead of
 *  the YAML files (which remain only as the store's seed). */
function isStoreManaged(category: string, entityId: string): boolean {
  return (category === 'expenses' && entityId === 'household') || (category === 'income' && entityId === 'jordane_salary');
}

/** Variant options for one entity, `default` first then the rest A→Z. */
function variantOptions(category: string, entityId: string): VariantOption[] {
  if (isStoreManaged(category, entityId)) {
    const list = category === 'income' ? readIncomePresets() : readPresets();
    return list
      .map((p) => ({ id: p.id, label: p.label, order: p.order }))
      .sort(
        (a, b) =>
          (a.order ?? 0) - (b.order ?? 0) ||
          (a.id === DEFAULT_VARIANT ? -1 : b.id === DEFAULT_VARIANT ? 1 : a.label.localeCompare(b.label)),
      );
  }
  return variants
    .filter((v) => v.category === category && v.entityId === entityId)
    .map((v) => ({ id: v.variant, label: v.variantLabel, order: v.order }))
    .sort((a, b) => {
      // An explicit `order:` on both wins (lets a budget ladder read low→high); otherwise
      // the `default` variant leads, then the rest A→Z by label.
      if (a.order != null && b.order != null) return a.order - b.order;
      return a.id === DEFAULT_VARIANT ? -1 : b.id === DEFAULT_VARIANT ? 1 : a.label.localeCompare(b.label);
    });
}

/** An entity's display name, read from its default variant (any variant as fallback). */
function entityName(category: string, entityId: string): string {
  return entityDefault(category, entityId)?.entityName ?? entityId;
}

/** Whether an entity is included by default (its default variant's `enabled`). */
function entityDefaultOn(category: string, entityId: string): boolean {
  return entityDefault(category, entityId)?.defaultOn ?? true;
}

function entityDefault(category: string, entityId: string): VariantFile | undefined {
  return (
    variants.find((v) => v.category === category && v.entityId === entityId && v.variant === DEFAULT_VARIANT) ??
    variants.find((v) => v.category === category && v.entityId === entityId)
  );
}

/** "high-inflation" -> "High inflation"; "best" -> "Best". */
function prettyLabel(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return (words || id).replace(/^\w/, (c) => c.toUpperCase());
}

// --------------------------- assembly + load ------------------------------

export interface Selection {
  /** entity key -> chosen variant id. Omitted means that entity's `default`. */
  groups?: Record<string, string>;
  /** entity keys explicitly switched ON (overrides a default-off entity). */
  enabled?: string[];
  /** entity keys explicitly switched OFF (overrides a default-on entity). */
  disabled?: string[];
}

/** Whether an entity is active for a selection: an explicit on/off wins, else the
 *  entity's own default (`enabled` in its config). */
export function isEntityActive(key: string, defaultOn: boolean, selection: Selection): boolean {
  if (selection.enabled?.includes(key)) return true;
  if (selection.disabled?.includes(key)) return false;
  return defaultOn;
}

function findVariant(category: string, entityId: string, variant: string): VariantFile | undefined {
  return variants.find((v) => v.category === category && v.entityId === entityId && v.variant === variant);
}

/** Assemble the effective config for a selection: the invariants, plus each
 *  category's list built from its enabled entities at their chosen variants.
 *  Validates before returning. Throws on an invalid/unknown config. */
export function loadFinanceConfig(selection: Selection = {}): FinanceConfig {
  const cfg = structuredClone(base) as FinanceConfig; // invariants (fresh copy each call)
  cfg.assets = cfg.assets ?? {};
  const chosen = selection.groups ?? {};

  for (const cat of CATEGORIES) {
    const list: any[] = [];
    for (const id of entityIds(cat.folder)) {
      const key = entityKey(cat.folder, id);
      if (!isEntityActive(key, entityDefaultOn(cat.folder, id), selection)) continue;
      const variant = chosen[key] ?? DEFAULT_VARIANT;
      if (isStoreManaged(cat.folder, id)) {
        // Household budget / salary presets live in the UI-managed stores, not the YAML.
        if (cat.folder === 'income') list.push(incomePresetEngineItem(getIncomePreset(variant)));
        else list.push(...presetEngineItems(getPreset(variant)));
        continue;
      }
      const file = findVariant(cat.folder, id, variant);
      if (!file) throw new Error(`finance config: no "${variant}" variant for ${cat.folder} "${id}"`);
      list.push(...file.entries);
    }
    cat.set(cfg, list as CategoryList);
  }

  validate(cfg);
  return cfg;
}

/** Minimal sanity checks so a config typo fails loudly instead of silently. */
function validate(cfg: FinanceConfig): void {
  if (!cfg?.meta?.base_date) throw new Error('finance config: meta.base_date is required');
  if (!cfg.meta.base_currency) throw new Error('finance config: meta.base_currency is required');
  if (cfg.meta.inflation_rate == null) throw new Error('finance config: meta.inflation_rate is required');
  if (!cfg.fx_rates?.[cfg.meta.base_currency]) {
    throw new Error(`finance config: fx_rates must include the base currency "${cfg.meta.base_currency}"`);
  }
  const currencies = new Set(Object.keys(cfg.fx_rates));
  const check = (currency: string | undefined, where: string) => {
    if (currency && !currencies.has(currency)) {
      throw new Error(`finance config: ${where} uses currency "${currency}" with no fx_rate`);
    }
  };
  cfg.assets?.real_estate?.forEach((p) => check(p.currency, `real_estate "${p.id}"`));
  cfg.assets?.investments?.forEach((i) => check(i.currency, `investment "${i.id}"`));
  cfg.incomes?.forEach((i) => check(i.currency, `income "${i.id}"`));
  cfg.expenses?.forEach((e) => check(e.currency, `expense "${e.id}"`));
}
