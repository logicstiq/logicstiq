/* migrate.mjs — one-time codemod that brings the existing pages onto the shared
 * stylesheet and the shared shell. Run it once, commit the diff, then use
 * build.mjs from then on.
 *
 *   node scripts/migrate.mjs --dry     inspect the plan, write nothing
 *   node scripts/migrate.mjs           apply
 *
 * Per page it will:
 *   1. Replace the copy-pasted <nav class="lnav">…</nav> with a <!--#NAV--> marker.
 *   2. Replace <footer>…</footer> with a <!--#FOOTER--> marker.
 *   3. Delete .lnav / #lnav / .liq-theme-btn rules from the page's inline <style>,
 *      since liq.css owns the shell now.
 *   4. Delete the old inline theme script (the one with function place()).
 *   5. Add the liq.css <link> as the last item in <head>, so it wins over any
 *      inline CSS the page still carries.
 *   6. Add js/liq-shell.js, and js/liq-live.js on pages that have a calculator.
 *   7. Drop the AdSense tag and the unused xlsx script where nothing parses a file.
 *
 * It does not touch the calculator maths, the API, or any page-specific styling.
 */
import { readFile, writeFile, readdir, copyFile, mkdir } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';

const ROOT = process.cwd();
const DRY = process.argv.includes('--dry');
const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel', 'api', 'js', 'css', 'partials', 'scripts', 'test']);

const CSS_LINK = '<link rel="stylesheet" href="/css/liq.css?v=1">';
const PRE_PAINT = `<script>try{var t=localStorage.getItem('liq-theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}</script>`;
const SHELL_JS = '<script defer src="/js/liq-shell.js?v=1"></script>';
const LIVE_JS = '<script defer src="/js/liq-live.js?v=1"></script>';
const FONT_LINK = '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">';

async function htmlFiles(dir, acc = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await htmlFiles(join(dir, e.name), acc);
    } else if (extname(e.name) === '.html') acc.push(join(dir, e.name));
  }
  return acc;
}

/* Remove whole CSS rules whose selector list mentions the shell. Works inside
   @media blocks too, because we only ever match a single {...} body. */
function stripShellCss(css) {
  return css.replace(
    /(^|[\s,{}])((?:[^{}]*?(?:\.lnav|#lnav|\.liq-theme-btn|\.lfoot)[^{}]*?))\{[^{}]*\}/g,
    (m, lead) => lead
  );
}

const report = [];

for (const file of await htmlFiles(ROOT)) {
  const rel = file.replace(ROOT + '/', '');
  const src = await readFile(file, 'utf8');
  let s = src;
  const did = [];

  /* Tool pages with their own app chrome keep it; they get the stylesheet and
     scripts but not a second navigation bar. */
  const appShell = /<header[^>]*class="[^"]*\bshell\b/.test(s) || /class="shell-tabs"/.test(s);

  /* 1. nav -> marker */
  if (/<nav[^>]*class="[^"]*\blnav\b/.test(s)) {
    s = s.replace(/<nav[^>]*class="[^"]*\blnav\b[\s\S]*?<\/nav>/, '<!--#NAV-->');
    did.push('nav');
  } else if (!s.includes('<!--#NAV-->') && !appShell) {
    /* Page had no navigation at all. Give it the shared one. */
    s = s.replace(/(<body[^>]*>)/, '$1\n\n<!--#NAV-->\n');
    did.push('nav+');
  } else if (appShell) {
    report.push({ rel, warn: 'app shell kept, no shared nav injected' });
  }

  /* 2. footer -> marker */
  if (/<footer[\s\S]*?<\/footer>/.test(s)) {
    s = s.replace(/<footer[\s\S]*?<\/footer>/, '<!--#FOOTER-->');
    did.push('footer');
  } else if (!s.includes('<!--#FOOTER-->') && !appShell) {
    s = s.replace(/<\/body>/, '\n<!--#FOOTER-->\n</body>');
    did.push('footer+');
  }

  /* 3. strip shell rules from inline <style> */
  s = s.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (m, a, css, b) => {
    const out = stripShellCss(css);
    if (out !== css) did.push('css');
    return a + out + b;
  });

  /* 4. drop the old inline theme script */
  s = s.replace(/<script>\s*\(function\(\)\{[\s\S]*?liq-theme-btn[\s\S]*?function place\([\s\S]*?<\/script>/g, () => {
    did.push('theme-js');
    return '';
  });

  /* 7a. drop AdSense (live or commented) */
  s = s.replace(/[ \t]*<!--[^>]*AdSense[\s\S]*?-->[ \t]*\n?/gi, () => { did.push('adsense'); return ''; });
  s = s.replace(/[ \t]*<script[^>]*pagead2\.googlesyndication\.com[^>]*>\s*<\/script>[ \t]*\n?/gi,
    () => { did.push('adsense'); return ''; });

  /* 7b. xlsx only where a file actually gets parsed */
  const parsesFiles = /type=["']file["']|XLSX\.|FileReader/.test(s);
  if (!parsesFiles) {
    s = s.replace(/[ \t]*<script[^>]*libs\/xlsx[^>]*>\s*<\/script>[ \t]*\n?/gi,
      () => { did.push('xlsx'); return ''; });
  }

  /* 5. head additions, liq.css last so it beats leftover inline CSS */
  if (!s.includes('/css/liq.css')) {
    const add = (s.includes('fonts.googleapis.com') ? '' : FONT_LINK + '\n')
      + CSS_LINK + '\n'
      + (s.includes("localStorage.getItem('liq-theme')") ? '' : PRE_PAINT + '\n');
    s = s.replace('</head>', add + '</head>');
    did.push('css-link');
  }

  /* 6. body scripts.
        The repo uses both btn-calc and calc-btn for the same thing, so match both. */
  const hasCalc = /\bbtn-calc\b|\bcalc-btn\b/i.test(src);
  let tail = '';
  if (!s.includes('/js/liq-shell.js')) tail += SHELL_JS + '\n';
  if (hasCalc && !s.includes('/js/liq-live.js')) { tail += LIVE_JS + '\n'; did.push('live-js'); }
  if (tail) {
    s = s.includes('</body>') ? s.replace('</body>', tail + '</body>') : s + tail;
    did.push('shell-js');
  }

  s = s.replace(/\n{3,}/g, '\n\n');

  const saved = src.length - s.length;
  report.push({ rel, did, saved, changed: s !== src });

  if (!DRY && s !== src) {
    await mkdir(join(ROOT, '.migrate-backup', dirname(rel)), { recursive: true });
    await copyFile(file, join(ROOT, '.migrate-backup', rel));
    await writeFile(file, s);
  }
}

const changed = report.filter(r => r.changed);
const totalSaved = changed.reduce((a, r) => a + (r.saved || 0), 0);
const warns = report.filter(r => r.warn);

console.log(`${DRY ? 'DRY RUN — ' : ''}${report.length} pages scanned, ${changed.length} ${DRY ? 'would change' : 'changed'}`);
console.log(`bytes removed from HTML: ${(totalSaved / 1024).toFixed(1)} KB`);
if (!DRY) console.log('originals copied to .migrate-backup/ (add it to .gitignore)');
for (const w of warns) console.log(`  warn  ${w.rel}: ${w.warn}`);
console.log('\nnext: node scripts/build.mjs');
