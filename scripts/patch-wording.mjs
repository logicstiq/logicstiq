/* patch-wording.mjs — brings the site's own copy in line with two decisions:
 *
 *   1. LogicstIQ is free. Not "free during launch".
 *   2. The roadmap is TMS in beta, then OMS, WMS and Returns. There is no Pro plan.
 *
 * These strings are repeated across about seven pages, including one clause in
 * terms.html. Doing it by hand leaves the legal page saying one thing and the
 * marketing pages saying another, which is exactly the sort of mismatch that gets
 * noticed at the worst moment.
 *
 *   node scripts/patch-wording.mjs --dry
 *   node scripts/patch-wording.mjs
 *
 * Run it BEFORE migrate.mjs. Every replacement is an exact string match, so it
 * either finds its target or reports that it didn't. Nothing is guessed.
 */
import { readFile, writeFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const SKIP = new Set(['node_modules', '.git', '.vercel', 'api', 'js', 'css', 'scripts', 'test', '.migrate-backup']);

/* ---- 1. The Terms clause. This is the one that has to change first. ---- */
const TERMS_OLD =
  '<li><strong>Pricing:</strong> the signed-in tools are free during launch. We reserve the right to introduce paid tiers for some tools in future; the 31 calculators will remain free with no login.</li>';

const TERMS_NEW =
  '<li><strong>Pricing:</strong> LogicstIQ is free to use. The 31 calculators need no account and will remain free with no login. ' +
  'The signed-in tools (AI Demand Planner, Paperwork Hub, Sourcing &amp; Procurement, FBA Planner and TMS) are free as well; ' +
  'the account exists so your saved work stays private to you, not to restrict features. ' +
  'Should we ever offer an optional paid add-on, it will sit alongside the free tools rather than replace them, ' +
  'it will be published on our pricing page before it takes effect, ' +
  'and it will not withdraw access to anything you are already using.</li>';

/* ---- 2. "free during launch" in its several forms ---- */
const LAUNCH = [
  [
    'are also free right now during launch, and only ask for a free account so we can save your work to the cloud',
    'are free as well, and only ask for a free account so we can save your work to the cloud'
  ],
  [
    'are also free right now during launch, and only ask for a free account so your work can be saved to the cloud',
    'are free as well, and only ask for a free account so your work can be saved to the cloud'
  ],
  ['free right now during launch', 'free to use'],
  ['AI Planning Tools — Free During Launch (free account saves your work)',
   'AI Planning Tools — Free (a free account keeps your work private to you)'],
  ['AI Planning Tools &mdash; Free During Launch (free account saves your work)',
   'AI Planning Tools &mdash; Free (a free account keeps your work private to you)'],
  ['Free During Launch', 'Free to Use'],
  ['free during launch, with a free account to save your work',
   'free to use, with a free account so your work stays private to you'],
  ['are also free during launch', 'are free as well'],
  ['free during launch', 'free to use']
];

/* ---- 3. The stale roadmap answer. TMS shipped; saved forecasts already exist. ---- */
const ROADMAP = [
  [
    'Upcoming additions include a TMS (Transportation Management System) for carrier rate comparison and route optimisation, and a Pro plan for teams needing saved forecasts, scheduled reports, and API integrations.',
    'The TMS is in beta now. Order Management, Warehouse Management and Returns Management are in development. Saved forecasts, forecast-versus-actual accuracy and API access are part of the free account, not a paid tier.'
  ],
  [
    'and a Pro plan for teams needing saved forecasts, scheduled reports, and API integrations.',
    'Saved forecasts, forecast-versus-actual accuracy and API access are part of the free account, not a paid tier.'
  ],
  [
    ', and a Pro plan for teams needing saved forecasts, scheduled reports, and API integrations',
    '. Saved forecasts and API access are part of the free account, not a paid tier'
  ]
];

const RULES = [[TERMS_OLD, TERMS_NEW], ...ROADMAP, ...LAUNCH];

async function pages(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      await pages(join(dir, e.name), acc);
    } else if (extname(e.name) === '.html') acc.push(join(dir, e.name));
  }
  return acc;
}

const hits = new Map(RULES.map(([from]) => [from, 0]));
let touched = 0;

for (const file of await pages(ROOT)) {
  const src = await readFile(file, 'utf8');
  let s = src;
  for (const [from, to] of RULES) {
    if (!s.includes(from)) continue;
    const n = s.split(from).length - 1;
    hits.set(from, hits.get(from) + n);
    s = s.split(from).join(to);
  }
  if (s === src) continue;
  touched++;
  if (!DRY) {
    const rel = file.replace(ROOT + '/', '');
    await mkdir(join(ROOT, '.wording-backup', dirname(rel)), { recursive: true });
    await copyFile(file, join(ROOT, '.wording-backup', rel));
    await writeFile(file, s);
  }
  console.log(`  ${DRY ? 'would patch' : 'patched'}  ${file.replace(ROOT + '/', '')}`);
}

console.log(`\n${touched} page(s) ${DRY ? 'would be' : ''} updated`);
const missed = [...hits].filter(([, n]) => n === 0).map(([k]) => k);
console.log('replacements applied:');
for (const [k, n] of hits) if (n) console.log(`  ${n}×  ${k.slice(0, 78)}…`);
if (missed.length) {
  console.log('\nnot found (fine if an earlier, broader rule already covered it):');
  for (const m of missed) console.log(`  –  ${m.slice(0, 78)}…`);
}
if (!DRY) console.log('\noriginals copied to .wording-backup/');
console.log('\nnext: node scripts/migrate.mjs && node scripts/build.mjs');
