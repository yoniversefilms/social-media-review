// compose.js — the studio's render engine, running in the browser.
// Owned by the builder module.
//
// This is a direct port of the composition half of
// New_Workflow/studio/render.mjs (which composes a template + vars into a
// full HTML document and screenshots it in Chrome). Same substitution rules,
// same order, same document shell — so what this file mounts in an iframe is
// pixel-identical by construction to what the studio renders to PNG.
//
// One deliberate divergence: render.mjs dies loudly on a missing var or
// illustration (a factory run must stop); a live preview must not. Here every
// problem becomes a visible red banner INSIDE the slide, naming exactly what
// is missing, and composition continues.
//
// Contract (PLAN.md):
//   await initCompose(assetUrlFn)   — fetches studio/tokens.css + studio/manifest.json once
//   await mountSlide(container, slide) — slide = {template, vars}; sandboxed
//       iframe (srcdoc), true 1080×1350, CSS-scaled to container width;
//       returns the iframe
//   manifest()                      — the loaded studio/manifest.json
//   await composeSlideHTML(slide)   — the raw composed document string
//
// No imports: store.js hands in its assetUrl at init. This file does its own
// (asset-only, read-only) fetching and caches everything in memory.

const W = 1080, H = 1350;

// --- substitution grammar, verbatim from render.mjs -------------------------
const RE_ILL_VAR = /\{\{ill:\$([a-zA-Z0-9_]+)\}\}/g; // drawing chosen by the content
const RE_ILL_LIT = /\{\{ill:([a-z0-9-]+)\}\}/g;      // drawing fixed by the template
const RE_VAR     = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const RE_LEFT    = /\{\{[^}]*\}\}/;
const RE_ILL_NAME = /^[a-z0-9-]+$/;                  // legal illustration file stem

let assetUrl = null;     // store.assetUrl, injected
let tokensCss = null;    // studio/tokens.css with font urls made absolute
let manifestData = null; // studio/manifest.json
let initPromise = null;

const tplCache = new Map(); // template name -> html text | null (miss)
const illCache = new Map(); // illustration name -> svg text | null (miss)
const mounts = new WeakMap(); // container -> {wrapper, iframe, ro}

// ---------------------------------------------------------------- init

export function initCompose(assetUrlFn) {
  assetUrl = assetUrlFn;
  if (!initPromise) {
    initPromise = (async () => {
      const [tokRes, manRes] = await Promise.all([
        fetch(assetUrl('studio/tokens.css')),
        fetch(assetUrl('studio/manifest.json')),
      ]);
      if (!tokRes.ok) throw new Error('טעינת tokens.css נכשלה (' + tokRes.status + ')');
      if (!manRes.ok) throw new Error('טעינת manifest.json נכשלה (' + manRes.status + ')');
      const raw = await tokRes.text();
      // tokens.css says url("fonts/heebo.ttf") — relative to the studio root
      // render.mjs serves from. In the composed srcdoc there is no base URL,
      // so every font url is rewritten to an absolute asset URL. This covers
      // all four faces (heebo, assistant, frankruhl, suezone) in one pass.
      const fontsBase = assetUrl('studio/fonts/');
      tokensCss = raw.replace(/url\(\s*(['"]?)fonts\//g, (_, q) => 'url(' + q + fontsBase);
      manifestData = await manRes.json();
      return manifestData;
    })();
    initPromise.catch(() => { initPromise = null; }); // allow retry after a failure
  }
  return initPromise;
}

export function manifest() {
  return manifestData;
}

// ---------------------------------------------------------------- asset fetch

async function loadTemplate(name) {
  if (tplCache.has(name)) return tplCache.get(name);
  let body = null;
  try {
    const res = await fetch(assetUrl('studio/templates/' + name + '.html'));
    if (res.ok) body = await res.text();
  } catch { /* network failure -> miss */ }
  tplCache.set(name, body);
  return body;
}

async function loadIllustration(name) {
  if (illCache.has(name)) return illCache.get(name);
  let svg = null;
  try {
    const res = await fetch(assetUrl('studio/illustrations/' + name + '.svg'));
    if (res.ok) svg = (await res.text()).trim();
  } catch { /* network failure -> miss */ }
  illCache.set(name, svg);
  return svg;
}

// ---------------------------------------------------------------- composing

// Port of render.mjs compose(): same three passes in the same order —
// {{ill:$var}} first, then {{ill:literal}}, then {{var}}, then the leftover
// check — but async (illustrations arrive over HTTP) and problem-collecting
// instead of fatal.
async function composeInner(slide, problems) {
  const tplName = slide && slide.template;
  const vars = (slide && slide.vars) || {};

  if (!tplName) {
    problems.push('לשקופית אין תבנית (template)');
    return '<div class="slide slide--paper"></div>';
  }
  const body = await loadTemplate(tplName);
  if (body == null) {
    problems.push('התבנית ”' + tplName + '“ לא נמצאה בסטודיו');
    return '<div class="slide slide--paper"></div>';
  }

  // Pass 0: collect every illustration this slide needs, fetch them all.
  const needed = new Set();
  for (const m of body.matchAll(RE_ILL_VAR)) {
    const key = m[1];
    if (!(key in vars)) {
      problems.push('חסר המשתנה ”' + key + '“, שבוחר את האיור בתבנית ”' + tplName + '“');
    } else {
      const name = String(vars[key]);
      if (RE_ILL_NAME.test(name)) needed.add(name);
      else problems.push('”' + name + '“ אינו שם איור חוקי (המשתנה ”' + key + '“)');
    }
  }
  for (const m of body.matchAll(RE_ILL_LIT)) needed.add(m[1]);
  await Promise.all([...needed].map(loadIllustration));

  // {{ill:$var}} — the drawing is chosen by the content piece.
  let html = body.replace(RE_ILL_VAR, (_, key) => {
    if (!(key in vars)) return '';                       // reported in pass 0
    const name = String(vars[key]);
    if (!RE_ILL_NAME.test(name)) return '';              // reported in pass 0
    const svg = illCache.get(name);
    if (svg == null) {
      problems.push('האיור ”' + name + '“ לא נמצא בספריית האיורים');
      return '';
    }
    return svg;
  });

  // {{ill:literal-name}} — fixed drawing, structural to the template.
  html = html.replace(RE_ILL_LIT, (_, name) => {
    const svg = illCache.get(name);
    if (svg == null) {
      problems.push('התבנית ”' + tplName + '“ מבקשת את האיור ”' + name + '“, והוא לא נמצא');
      return '';
    }
    return svg;
  });

  // {{var}} — values are raw HTML on purpose (samples use <b> inside prose),
  // exactly like render.mjs.
  html = html.replace(RE_VAR, (_, key) => {
    if (!(key in vars)) {
      problems.push('חסר המשתנה ”' + key + '“ שהתבנית ”' + tplName + '“ דורשת');
      return '';
    }
    return String(vars[key] ?? '');
  });

  const leftover = html.match(RE_LEFT);
  if (leftover) problems.push('נשאר סימון לא מפוענח: ' + leftover[0]);

  return html;
}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function problemBanner(problems) {
  if (!problems.length) return '';
  const items = [...new Set(problems)]
    .map((p) => '<li>' + escapeHtml(p) + '</li>').join('');
  return '<div style="position:fixed;top:0;left:0;right:0;z-index:999;' +
    'background:#b3403a;color:#fff;padding:20px 30px;direction:rtl;' +
    "font:600 26px/1.45 'Assistant',-apple-system,sans-serif;\">" +
    '<div style="font-size:29px;margin-bottom:6px">התצוגה חלקית — חסר משהו:</div>' +
    '<ul style="margin:0;padding-inline-start:34px;font-weight:400">' + items + '</ul></div>';
}

// The document shell, matching render.mjs's doc() — lang=he dir=rtl, tokens
// first — with tokens inlined (a srcdoc has no server to link against).
export async function composeSlideHTML(slide) {
  if (!assetUrl) throw new Error('composeSlideHTML לפני initCompose');
  if (tokensCss == null) await initCompose(assetUrl);
  const problems = [];
  let inner;
  try {
    inner = await composeInner(slide, problems);
  } catch (e) {
    problems.push('שגיאת הרכבה: ' + (e && e.message ? e.message : e));
    inner = '<div class="slide slide--paper"></div>';
  }
  return '<!doctype html>\n<html lang="he" dir="rtl"><head><meta charset="utf-8">\n' +
    '<title>slide</title>\n' +
    '<style>\n' + tokensCss + '\n</style>\n' +
    '</head><body>\n' + inner + '\n' + problemBanner(problems) + '\n</body></html>';
}

// ---------------------------------------------------------------- mounting

function fit(container) {
  const m = mounts.get(container);
  if (!m) return;
  const w = container.clientWidth;
  if (!w) return;
  const scale = w / W;
  m.wrapper.style.height = Math.round(H * scale) + 'px';
  m.iframe.style.transform = 'scale(' + scale + ')';
}

// Renders {template, vars} into `container` at true 1080×1350, CSS-scaled to
// the container's width and kept in step with it via ResizeObserver.
// Re-mounting into the same container reuses the iframe (srcdoc swap), so a
// keystroke-driven preview updates without tearing down the frame.
export async function mountSlide(container, slide) {
  const html = await composeSlideHTML(slide);

  let m = mounts.get(container);
  if (!m || !container.contains(m.wrapper)) {
    if (m && m.ro) m.ro.disconnect();
    container.textContent = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'smr-compose';
    // transform-origin top-RIGHT: this is an RTL surface, the slide hangs off
    // the right edge of its box and scales toward the left.
    wrapper.style.cssText =
      'position:relative;overflow:hidden;width:100%;direction:rtl;';

    const iframe = document.createElement('iframe');
    // allow-same-origin (fonts fetch cleanly), scripts stay blocked — vars
    // are reviewer-editable HTML.
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('title', 'תצוגה מקדימה של שקופית');
    iframe.style.cssText =
      'position:absolute;top:0;right:0;width:' + W + 'px;height:' + H + 'px;' +
      'border:0;display:block;transform-origin:100% 0;pointer-events:none;' +
      'background:transparent;';

    wrapper.appendChild(iframe);
    container.appendChild(wrapper);

    const ro = new ResizeObserver(() => fit(container));
    ro.observe(container);
    m = { wrapper, iframe, ro };
    mounts.set(container, m);
  }

  m.iframe.srcdoc = html;
  fit(container);
  return m.iframe;
}
