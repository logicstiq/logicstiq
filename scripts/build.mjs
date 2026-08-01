/* build.mjs — injects partials/nav.html and partials/footer.html into every page.
 *
 * Pages carry <!--#NAV--> and <!--#FOOTER--> markers. This writes the partial
 * between the marker and a closing <!--/#NAV--> tag, so re-running replaces the
 * previous injection instead of stacking copies. Safe to run on every deploy.
 *
 *   node scripts/build.mjs
 *
 * Wire it to Vercel with  "vercel-build": "node scripts/build.mjs"  in package.json.
 * Injection happens at build time, not in the browser, so the nav's internal links
 * are in the HTML that crawlers receive.
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'api', 'js', 'css', 'partials', 'scripts', 'test']);

const PARTIALS = [
  { name: 'NAV', file: 'partials/nav.html' },
  { name: 'FOOTER', file: 'partials/footer.html' }
];

async function loadPartials() {
  const out = [];
  for (const p of PARTIALS) {
    try {
      out.push({ ...p, html: (await readFile(join(ROOT, p.file), 'utf8')).trim() });
    } catch {
      console.error(`build: missing ${p.file}`);
      process.exit(1);
    }
  }
  return out;
}

async function htmlFiles(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await htmlFiles(join(dir, entry.name), acc);
    } else if (extname(entry.name) === '.html') {
      acc.push(join(dir, entry.name));
    }
  }
  return acc;
}

function inject(html, name, partial) {
  const open = `<!--#${name}-->`;
  const close = `<!--/#${name}-->`;
  if (!html.includes(open)) return { html, hit: false };

  // Drop a previous injection, if any, then write a fresh one.
  const between = new RegExp(
    `${open.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${close.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );
  const block = `${open}\n${partial}\n${close}`;

  return {
    html: between.test(html) ? html.replace(between, block) : html.replace(open, block),
    hit: true
  };
}

const partials = await loadPartials();
const files = await htmlFiles(ROOT);
let changed = 0, missing = [];

for (const file of files) {
  const before = await readFile(file, 'utf8');
  let after = before, hits = 0;

  for (const p of partials) {
    const r = inject(after, p.name, p.html);
    after = r.html;
    if (r.hit) hits++;
  }

  if (hits === 0) missing.push(file.replace(ROOT + '/', ''));
  if (after !== before) {
    await writeFile(file, after);
    changed++;
  }
}

console.log(`build: ${files.length} pages scanned, ${changed} updated`);
if (missing.length) {
  console.log(`build: ${missing.length} page(s) have no markers yet (run scripts/migrate.mjs):`);
  for (const m of missing.slice(0, 12)) console.log(`  ${m}`);
  if (missing.length > 12) console.log(`  …and ${missing.length - 12} more`);
}
