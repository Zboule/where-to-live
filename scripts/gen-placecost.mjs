// Build-time generator for the place-cost engine.
//
// The finance engine originally read its YAML config from the filesystem at
// module load (config/finance.yaml + config/sections/**). In this standalone
// browser app there is no filesystem and no YAML parser in the bundle, so this
// script parses ALL the committed YAML once (at build time) and emits ONE
// bundled JSON that the adapted loaders (engine/config.ts, engine/expensePresets.ts,
// engine/incomePresets.ts) import instead of touching the disk.
//
// It reads ONLY from data/placecost/config/** (committed into this repo — the CI
// build checks out this repo alone). Run by `npm run gen` before `vite build`.

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(HERE, '..', 'data', 'placecost', 'config');
const SECTIONS_DIR = join(CONFIG_DIR, 'sections');
const OUT = join(HERE, '..', 'src', 'placecost', 'engine', 'financeConfig.generated.json');

// The invariants (base date/currency, horizons, inflation, fx_rates, cash, …).
const base = parse(readFileSync(join(CONFIG_DIR, 'finance.yaml'), 'utf8')) ?? {};

// Every section variant file, keyed by its {category}/{entity}/{variant}.yaml
// path, in the SAME deterministic order the server used (sorted by absolute
// path — which, sharing a common prefix, equals sorting the relative paths).
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return name.endsWith('.yaml') ? [p] : [];
  });
const sectionPaths = walk(SECTIONS_DIR).sort();
const sections = sectionPaths.map((p) => ({
  // POSIX-style relative path so the loader can split it into category/entity/variant
  path: relative(SECTIONS_DIR, p).split(sep).join('/'),
  doc: parse(readFileSync(p, 'utf8')) ?? {},
}));

// The store-managed presets (household budget, salary) are seeded from their own
// YAML folders. The engine's seedFromYaml logic stays in the TS modules; here we
// only provide the parsed docs (filename-sorted, matching readdirSync().sort()).
const seedDir = (parts) => {
  const dir = join(SECTIONS_DIR, ...parts);
  return readdirSync(dir)
    .filter((n) => n.endsWith('.yaml'))
    .sort()
    .map((file) => ({ file, doc: parse(readFileSync(join(dir, file), 'utf8')) ?? {} }));
};
const householdSeed = seedDir(['expenses', 'household']);
const incomeSeed = seedDir(['income', 'jordane_salary']);

const bundle = { base, sections, householdSeed, incomeSeed };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle));

console.log(
  `gen-placecost: wrote ${relative(join(HERE, '..'), OUT)} — ${sections.length} section files, ` +
    `${householdSeed.length} household + ${incomeSeed.length} salary seed presets`,
);
