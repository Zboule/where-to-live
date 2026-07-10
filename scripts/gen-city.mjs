import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// ===========================================================================
//  Build-time district dataset generator.
//
//  Port of city-ranking's src/ranking/config.ts loader (loadDistricts), but
//  run at build time instead of at server-request time: reads every
//  data/city/places/*.yaml in this repo (committed source, never the sibling
//  city-ranking repo), flattens each file's `districts:` list, validates and
//  dedupes exactly like the original loader, and writes the flattened array
//  to src/city/ranking/districts.generated.json for config.ts to import.
// ===========================================================================

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLACES_DIR = join(SCRIPT_DIR, '..', 'data', 'city', 'places');
const OUT_FILE = join(SCRIPT_DIR, '..', 'src', 'city', 'ranking', 'districts.generated.json');

// Required researched scores (the 7 hand-scored dimensions). 'optionality' and
// 'stability' were dropped from the framework, and 'health_nature' was split into
// 'health' + 'nature'; older files may still carry the obsolete keys (ignored).
const DIMENSION_KEYS = [
  'education',
  'safe_independence',
  'peer_environment',
  'mental_health',
  'family_practicality',
  'health',
  'nature',
];

/** Validate one district, throwing a path-tagged error on the first problem. */
function validateDistrict(d, where) {
  const need = (cond, msg) => {
    if (!cond) throw new Error(`places config: ${where} — ${msg}`);
  };
  need(d && typeof d === 'object', 'district is not an object');
  need(typeof d.id === 'string' && d.id, 'missing id');
  need(typeof d.city === 'string' && d.city, `"${d.id}" missing city`);
  need(typeof d.district === 'string' && d.district, `"${d.id}" missing district`);
  need(d.price_per_sqm && typeof d.price_per_sqm.average === 'number', `"${d.id}" missing price_per_sqm.average`);
  need(d.travel && typeof d.travel.paris_hours === 'number', `"${d.id}" missing travel.paris_hours`);
  need(typeof d.travel.yerevan_hours === 'number', `"${d.id}" missing travel.yerevan_hours`);
  need(d.scores && typeof d.scores === 'object', `"${d.id}" missing scores`);
  for (const k of DIMENSION_KEYS) {
    const v = d.scores[k];
    need(typeof v === 'number' && v >= 0 && v <= 5, `"${d.id}" scores.${k} must be a number 0–5 (got ${v})`);
  }
}

function main() {
  const files = readdirSync(PLACES_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  const all = [];
  const seen = new Set();

  for (const f of files) {
    const path = join(PLACES_DIR, f);
    const raw = readFileSync(path, 'utf8');
    const doc = parse(raw) ?? {};
    const list = doc.districts ?? [];
    if (!Array.isArray(list)) throw new Error(`places config: ${path} — "districts" must be a list`);
    list.forEach((d, i) => {
      validateDistrict(d, `${path}[${i}]`);
      if (seen.has(d.id)) throw new Error(`places config: duplicate district id "${d.id}" (${path})`);
      seen.add(d.id);
      all.push(d);
    });
  }

  writeFileSync(OUT_FILE, JSON.stringify(all, null, 2) + '\n');
  console.log(`gen-city: wrote ${all.length} districts from ${files.length} file(s) to ${OUT_FILE}`);
}

main();
