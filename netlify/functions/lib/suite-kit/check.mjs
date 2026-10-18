#!/usr/bin/env node
// Fails when a file in this vendored suite-kit copy was edited in place (compares MANIFEST.json hashes).
// Run it from the app's own tests: node <this folder>/check.mjs
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const m = JSON.parse(readFileSync(join(here, 'MANIFEST.json'), 'utf8'));
const bad = [];
for (const [f, h] of Object.entries(m.files)) {
  let got = null;
  try { got = createHash('sha256').update(readFileSync(join(here, f))).digest('hex'); } catch { got = 'missing'; }
  if (got !== h) bad.push(f);
}
const extra = readdirSync(here).filter((f) => !(f in m.files) && !['MANIFEST.json', 'check.mjs', 'README.md'].includes(f));
if (bad.length || extra.length) {
  console.error('suite-kit copy drifted: ' + [...bad.map((f) => f + ' changed'), ...extra.map((f) => f + ' added')].join(', '));
  process.exit(1);
}
console.log('suite-kit ' + m.version + ' (' + m.format + '): ' + Object.keys(m.files).length + ' files match MANIFEST.json');
