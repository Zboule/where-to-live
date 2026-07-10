import type { SalaryIncome, SalarySegment } from './types';
import bundleData from './financeConfig.generated.json';

// ===========================================================================
//  UI-managed salary presets (the pre-move UAE income trajectories).
//
//  Same model as the household expense presets: the YAML variant files
//  (sections/income/jordane_salary/*.yaml) were the one-time seed for a server
//  store. In this standalone place-cost port the salary is NOT user-editable
//  (it only feeds the config loader's validation — the place-cost numbers don't
//  use it), so this module is READ-ONLY: it returns the presets SEEDED from the
//  bundled YAML docs (financeConfig.generated.json → incomeSeed). The seed logic
//  is unchanged; only its source (disk YAML → bundle) moved.
// ===========================================================================

export interface IncomePreset {
  id: string;
  label: string;
  order?: number;
  name: string; // entity display name ("Jordane — Salary (UAE)")
  currency: string;
  tax_rate: number;
  segments: SalarySegment[];
}

const incomeSeed = (bundleData as unknown as {
  incomeSeed: { file: string; doc: Record<string, any> }[];
}).incomeSeed;

function seedFromYaml(): IncomePreset[] {
  const presets: IncomePreset[] = [];
  for (const { file, doc } of incomeSeed) {
    presets.push({
      id: file.replace(/\.yaml$/, ''),
      label: doc.variant_label ?? file,
      order: doc.order,
      name: doc.name ?? 'Salary',
      currency: doc.currency ?? 'USD',
      tax_rate: doc.tax_rate ?? 0,
      segments: (doc.growth ?? []).map((s: any) => ({
        year: s.year,
        gross_per_year: s.gross_per_year,
        growth_rate: s.growth_rate ?? 0,
      })),
    });
  }
  return presets;
}

let cache: IncomePreset[] | null = null;

export function readIncomePresets(): IncomePreset[] {
  if (!cache) cache = seedFromYaml();
  return cache;
}

export function getIncomePreset(id: string): IncomePreset {
  const p = readIncomePresets().find((x) => x.id === id);
  if (!p) throw Object.assign(new Error(`unknown income preset "${id}"`), { statusCode: 404 });
  return p;
}

/** The engine `SalaryIncome` for one preset (what the loader assembles). */
export function incomePresetEngineItem(preset: IncomePreset): SalaryIncome {
  return {
    id: 'jordane_salary',
    name: preset.name,
    type: 'salary',
    currency: preset.currency,
    tax_rate: preset.tax_rate,
    growth: [...preset.segments].sort((a, b) => a.year - b.year),
  };
}
