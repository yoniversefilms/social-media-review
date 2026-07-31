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
//   await mountSlide(container, slide) — slide = {template, vars, design?};
//       sandboxed iframe (srcdoc), true 1080×1350, CSS-scaled to container
//       width; returns a handle {iframe, update(slide), doc()}. For backward
//       compatibility the handle IS the iframe element with those properties
//       attached (h.iframe === h), so pre-handle callers that treated the
//       return value as the iframe keep working unchanged.
//   manifest()                      — the loaded studio/manifest.json
//   await composeSlideHTML(slide)   — the raw composed document string
//
// Design overrides (PLAN.md "Slide design overrides" v1→v1.6): slide.design
// may carry {blocks, extras, bg, slots, hidden, els}. Composition order is
// substitute → wrap → apply blocks → bg → slots → els → append extras, and
// the block marked PARITY below must stay textually identical to its twin in
// studio/render.mjs.
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
const brandCache = new Map(); // brand-asset name -> svg text | null (miss)
const mounts = new WeakMap(); // container -> {wrapper, iframe, ro}

// ---------------------------------------------------------------- init

export function initCompose(assetUrlFn) {
  assetUrl = assetUrlFn;
  if (!initPromise) {
    initPromise = (async () => {
      const [tokRes, manRes] = await Promise.all([
        // cache-busted: storage serves cache-control ~1h, and a stale
        // tokens.css means new design CSS (borders etc.) silently no-ops.
        fetch(assetUrl('studio/tokens.css') + '?v=' + Date.now()),
        fetch(assetUrl('studio/manifest.json') + '?v=' + Date.now()),
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

// Brand assets (v1.6): marks, dividers, ornaments — the brand's furniture,
// a distinct asset class from illustrations, same fetch-and-inline pipeline.
async function loadBrandAsset(name) {
  if (brandCache.has(name)) return brandCache.get(name);
  let svg = null;
  try {
    const res = await fetch(assetUrl('studio/brand-assets/' + name + '.svg'));
    if (res.ok) svg = (await res.text()).trim();
  } catch { /* network failure -> miss */ }
  brandCache.set(name, svg);
  return svg;
}

/* == PARITY BLOCK — design overrides (v1 + bg v1.1 + slots/hidden v1.2 + els/brand v1.6)
   This block MUST stay textually identical to the same block in
   New_Workflow/studio/render.mjs. compose.js (browser preview) and render.mjs
   (final PNG) apply slide.design through these exact functions; any drift
   breaks the render-parity invariant in PLAN.md. Edit both files together.

   Stacking inside .slide (isolation:isolate, grain ::after at z40):
     bg photo/color z-30 · bg overlay z-20 · back extras z-10 ·
     template content (in-flow + positioned z0..30) · front extras z35 ·
     grain z40.
   Negative z keeps the bg band under ALL template content — including
   non-positioned in-flow text, which any positive z-index would cover —
   while still painting over the slide's own field background. */
const DESIGN_W = 1080, DESIGN_H = 1350;
const DESIGN_FONTS = {
  body: "'Assistant',sans-serif",
  serif: "'FrankRuhl','Assistant',serif",
  display: "'Heebo','Assistant',sans-serif",
  heavy: "'SuezOne','Heebo',sans-serif",
  handwriting: "'Handwriting','Assistant',cursive",
};
const RE_TOKEN = /^[a-z0-9-]+$/;                     // legal palette token name
const RE_PHOTO_URL = /^(https?:|data:image\/|blob:)/; // legal photo src (extras + bg)
const RE_FIELD = /^(deep|paper|warm)$/;              // legal bg.field values
const dnum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const dround = (v) => Math.round(v * 100) / 100;
const dclamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const dattr = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// Inline style for one design.blocks entry. dx/dy are % of slide W/H, applied
// as position:relative px offsets (transforms don't apply to inline boxes;
// relative offsets do, and shift every line box of a wrapped span together).
function designBlockStyle(b) {
  if (!b || typeof b !== 'object') return '';
  let s = '';
  if (b.font && DESIGN_FONTS[b.font]) s += 'font-family:' + DESIGN_FONTS[b.font] + ';';
  const size = dnum(b.size);
  if (size !== null && size > 0) s += 'font-size:' + dround(size) + 'em;';
  if (b.color && RE_TOKEN.test(String(b.color))) s += 'color:var(--' + b.color + ');';
  if (b.bold) s += 'font-weight:700;';
  if (b.italic) s += 'font-style:italic;';
  const dx = dnum(b.dx) || 0, dy = dnum(b.dy) || 0;
  if (dx || dy) {
    s += 'position:relative;left:' + dround(dx * DESIGN_W / 100) + 'px;top:' +
      dround(dy * DESIGN_H / 100) + 'px;';
  }
  return s;
}

// A {{var}} whose match offset sits between an unclosed '<' and its '>' is in
// attribute position: substituted raw, never wrapped.
function insideTag(src, off) {
  return src.lastIndexOf('<', off) > src.lastIndexOf('>', off);
}

// Border variants for photo slots and photo extras (design.slots v1.2):
// paper = the default .photo mat ring · line = gold hairline (tokens.css
// .photo--line) · none = bare organic mask (.photo--none). Unknown values
// fall back to paper (caller reports). hasOwnProperty guards against
// prototype keys arriving via reviewer JSON.
const DESIGN_BORDERS = { paper: '', line: ' photo--line', none: ' photo--none' };
const designBorderClass = (b) =>
  Object.prototype.hasOwnProperty.call(DESIGN_BORDERS, b) ? DESIGN_BORDERS[b] : '';

// One rule, injected once per slide when any slot is filled: the pending
// label of a filled slot disappears without touching the template's markup.
const SLOT_FILLED_CSS = '<style>[data-slot-filled] .photo__label{display:none}</style>';

// Shared crop for slot fills (cover=true: the img fills the slot frame) and
// photo extras (cover=false: natural aspect, zoom-only crop). pos is the
// focal point in % (clamped 0..100, default centre); zoom clamps to 1..3 and
// scales around that same focal point, so pan and zoom stay anchored to each
// other. The surrounding .photo frame is overflow:hidden — it clips the
// scaled image.
function designCropStyle(s, cover) {
  const pos = Array.isArray(s.pos) ? s.pos : [];
  const px = dclamp(dnum(pos[0]) ?? 50, 0, 100);
  const py = dclamp(dnum(pos[1]) ?? 50, 0, 100);
  const z = dclamp(dnum(s.zoom) ?? 1, 1, 3);
  let st = cover
    ? 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'object-position:' + dround(px) + '% ' + dround(py) + '%;'
    : 'display:block;width:100%;height:auto;';
  if (z > 1) {
    st += 'transform:scale(' + dround(z) + ');transform-origin:' +
      dround(px) + '% ' + dround(py) + '%;';
  }
  return st;
}

// design.slots + hidden "slot:N" entries. Tags every .photo element
// data-slot="0..N" in DOM order (always, so the editor can hit-test empty
// slots), fills the slots named in `slots`, and display:none-hides the slot
// numbers in `hiddenSlots` (deletion without DOM removal — neighbors reflow,
// restore is trivial). Runs BEFORE extras are appended, so extra .photo
// wrappers are never tagged as slots. Template .photo tags carry no inline
// style attribute (checked across the library), so injecting one to hide is
// safe. Unfilled slots keep their pending label untouched. Returns {html,
// count, filled, bad} — bad lists slot keys whose url failed the allowlist.
function applySlots(html, slots, hiddenSlots) {
  let count = 0;
  const filled = [], bad = [];
  const out = html.replace(/<([a-z][a-z0-9]*)\s([^>]*?)class="([^"]*)"([^>]*)>/g,
    (m0, tag, pre, cls, post) => {
      if (!cls.split(/\s+/).includes('photo')) return m0;
      const i = count++;
      const hide = hiddenSlots && hiddenSlots.has(String(i))
        ? ' style="display:none"' : '';
      const s = slots ? slots[String(i)] : null;
      if (!s || typeof s !== 'object' ||
          !(typeof s.url === 'string' && RE_PHOTO_URL.test(s.url))) {
        if (s != null) bad.push(String(i));
        return '<' + tag + ' ' + pre + 'class="' + cls + '" data-slot="' + i + '"' +
          hide + post + '>';
      }
      filled.push(String(i));
      const img = '<img data-slot-img="' + i + '" src="' + dattr(s.url) + '" alt="" ' +
        'style="' + designCropStyle(s, true) + '">';
      return '<' + tag + ' ' + pre + 'class="' + cls + designBorderClass(s.border) +
        '" data-slot="' + i + '" data-slot-filled=""' + hide + post + '>' + img;
    });
  return { html: out, count, filled, bad };
}

// Decorative template elements (design.els v1.6). .rule / .lockup / .torn
// are tagged data-el at compose time; an els entry moves/scales/recolors one.
// dx/dy are % of slide W/H; scale clamps to [0.4, 2.5]; both ride a single
// transform, so the element's layout footprint never changes (rules are
// in-flow blocks — an offset that reflowed neighbors would wreck the column).
// color becomes inline color: only on currentColor-driven elements (rule,
// torn); the lockup keeps its own colors — the caller validates and reports.
const RE_EL_KEY = /^(?:rule:\d+|torn:\d+|lockup)$/;
function designElStyle(e, allowColor) {
  if (!e || typeof e !== 'object') return '';
  let t = '';
  const dx = dnum(e.dx) || 0, dy = dnum(e.dy) || 0;
  if (dx || dy) {
    t += 'translate(' + dround(dx * DESIGN_W / 100) + 'px,' +
      dround(dy * DESIGN_H / 100) + 'px)';
  }
  const sc = dnum(e.scale);
  if (sc !== null && sc !== 1) {
    t += (t ? ' ' : '') + 'scale(' + dround(dclamp(sc, 0.4, 2.5)) + ')';
  }
  let s = t ? 'transform:' + t + ';' : '';
  if (allowColor && e.color && RE_TOKEN.test(String(e.color))) {
    s += 'color:var(--' + e.color + ');';
  }
  return s;
}

// Tags decorative elements in DOM order — .rule → data-el="rule:N", .torn →
// data-el="torn:N", .lockup → data-el="lockup" (templates carry one; every
// match is tagged) — and applies els styles plus hidden "el:" entries as
// inline style. Runs ALWAYS (the editor needs the tags for hit-testing) and
// BEFORE extras are appended, so extras are never tagged. Template
// rule/lockup/torn tags carry no inline style attribute (checked across the
// library), so injecting one is safe. Returns {html, counts}.
function applyEls(html, els, hiddenEls) {
  const counts = { rule: 0, torn: 0, lockup: 0 };
  const out = html.replace(/<([a-z][a-z0-9]*)\s([^>]*?)class="([^"]*)"([^>]*)>/g,
    (m0, tag, pre, cls, post) => {
      const names = cls.split(/\s+/);
      let key = null;
      if (names.includes('rule')) key = 'rule:' + counts.rule++;
      else if (names.includes('torn')) key = 'torn:' + counts.torn++;
      else if (names.includes('lockup')) { key = 'lockup'; counts.lockup++; }
      if (!key) return m0;
      const e = els ? els[key] : null;
      const style = designElStyle(e, key !== 'lockup') +
        (hiddenEls && hiddenEls.has(key) ? 'display:none;' : '');
      return '<' + tag + ' ' + pre + 'class="' + cls + '" data-el="' + key + '"' +
        (style ? ' style="' + style + '"' : '') + post + '>';
    });
  return { html: out, counts };
}

// design.bg.field — swap the slide root's field class (slide--deep/--paper/
// --warm). The PREFERRED background change: every text token re-resolves with
// the class, exactly as templates already work. Invalid/absent field: no-op
// (caller reports). Non-global regex touches only the first slide class attr.
function applyBgField(html, field) {
  if (!RE_FIELD.test(String(field || ''))) return html;
  return html.replace(/class="([^"]*\bslide\b[^"]*)"/, (_, cls) => {
    const kept = cls.split(/\s+/)
      .filter((c) => c && !/^slide--(deep|paper|warm)$/.test(c));
    kept.push('slide--' + field);
    return 'class="' + kept.join(' ') + '"';
  });
}

// design.bg color/photo/overlay layers. Precedence: photo > color > field —
// a valid photo suppresses the flat color; the overlay scrim only exists
// with a photo. pos clamps to 0..100 (default 50,50); overlay opacity clamps
// to 0..0.8 (default 0.35). Invalid tokens/urls: layer skipped (caller
// reports).
function designBgHtml(bg) {
  if (!bg || typeof bg !== 'object') return '';
  let out = '';
  if (typeof bg.photo === 'string' && RE_PHOTO_URL.test(bg.photo)) {
    const pos = Array.isArray(bg.pos) ? bg.pos : [];
    const px = dclamp(dnum(pos[0]) ?? 50, 0, 100);
    const py = dclamp(dnum(pos[1]) ?? 50, 0, 100);
    out += '<img data-bg="photo" src="' + dattr(bg.photo) + '" alt="" ' +
      'style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'object-position:' + dround(px) + '% ' + dround(py) + '%;z-index:-30">';
    const ov = bg.overlay;
    if (ov && typeof ov === 'object' && ov.color && RE_TOKEN.test(String(ov.color))) {
      const op = dclamp(dnum(ov.opacity) ?? 0.35, 0, 0.8);
      out += '<div data-bg="overlay" style="position:absolute;inset:0;' +
        'background:var(--' + ov.color + ');opacity:' + dround(op) + ';z-index:-20"></div>';
    }
  } else if (bg.color && RE_TOKEN.test(String(bg.color))) {
    out += '<div data-bg="color" style="position:absolute;inset:0;' +
      'background:var(--' + bg.color + ');z-index:-30"></div>';
  }
  return out;
}

// One design.extras layer. Positioned inside .slide: x/y/w in % of the slide
// box. Band: front (default) z35 — above template content, below the grain
// layer at 40; back ("back": true) z-10 — above bg/scrim, below template
// content. Within each band, array order = DOM order = stacking order.
// `svg` is the resolved markup for type 'ill' (illustrations/) and type
// 'brand' (brand-assets/, v1.6) — both caller-verified and engine-identical
// from here: same .ill wrapper, currentColor, x/y/w/rot/back. crop and
// border never apply to brand marks — they are furniture, not photos.
function designExtraHtml(ex, i, svg) {
  const x = dnum(ex.x) ?? 0, y = dnum(ex.y) ?? 0, w = dnum(ex.w) ?? 20;
  const rot = dnum(ex.rot) || 0;
  const z = ex.back === true ? -10 : 35;
  // Template-scoped CSS also matches these wrapper classes (.t-hook .ill
  // sizes the template's own drawing to 640px and pins it to the bottom,
  // .t-essay-v3 .ill caps height at 404px, …). The extra's geometry contract
  // is % of the slide, full stop — so every geometry property templates
  // scope onto .ill/.photo is neutralized inline first; the extra's own
  // left/top/width follow in the same declaration list and win. Without
  // this, an extra on hook inherits height:640px + bottom pinning and its
  // mark centers itself clean off the slide.
  let pos = 'position:absolute;inset:auto;margin:0;height:auto;max-height:none;' +
    'min-height:0;aspect-ratio:auto;' +
    'z-index:' + z + ';left:' + dround(x) + '%;top:' + dround(y) +
    '%;width:' + dround(w) + '%;';
  if (rot) pos += 'transform:rotate(' + dround(rot) + 'deg);';
  if (ex.type === 'ill' || ex.type === 'brand') {
    const color = ex.color && RE_TOKEN.test(String(ex.color))
      ? 'color:var(--' + ex.color + ');' : '';
    return '<div class="ill" data-extra="' + i + '" style="' + pos + color + '">' + svg + '</div>';
  }
  if (ex.type === 'photo') {
    // pos/zoom/border engage the crop-frame path: the img keeps its natural
    // aspect (the frame's height follows it — transforms don't affect
    // layout), the .photo wrapper masks and clips, the border class picks
    // the ring. Extras with none of those keys keep the exact legacy markup
    // (shape:"organic" = the paper mat, else a bare rectangular img).
    const crop = ex.pos != null || ex.zoom != null || ex.border != null;
    const img = '<img src="' + dattr(ex.url) + '" alt="" ' +
      (crop ? 'style="' + designCropStyle(ex, false) + '"'
            : 'style="display:block;width:100%;height:auto"') + '>';
    if (crop || ex.shape === 'organic') {
      return '<div class="photo' + designBorderClass(ex.border) + '" data-extra="' + i +
        '" style="' + pos + '">' + img + '</div>';
    }
    return '<div data-extra="' + i + '" style="' + pos + '">' + img + '</div>';
  }
  return '';
}

// Extras land just before the slide's closing tag — the string's last </div>.
function injectBeforeSlideEnd(html, extraStr) {
  if (!extraStr) return html;
  const i = html.lastIndexOf('</div>');
  return i < 0 ? html + extraStr : html.slice(0, i) + extraStr + html.slice(i);
}
/* ==== END PARITY BLOCK ==================================================== */

// ---------------------------------------------------------------- composing

// Port of render.mjs compose(): same three passes in the same order —
// {{ill:$var}} first, then {{ill:literal}}, then {{var}}, then the leftover
// check — but async (illustrations arrive over HTTP) and problem-collecting
// instead of fatal.
async function composeInner(slide, problems) {
  const tplName = slide && slide.template;
  const vars = (slide && slide.vars) || {};
  const design = (slide && slide.design && typeof slide.design === 'object')
    ? slide.design : null;
  const blocks = (design && design.blocks && typeof design.blocks === 'object')
    ? design.blocks : {};
  const extras = (design && Array.isArray(design.extras)) ? design.extras : [];
  const bg = (design && design.bg && typeof design.bg === 'object')
    ? design.bg : null;
  const slots = (design && design.slots && typeof design.slots === 'object')
    ? design.slots : null;
  const els = (design && design.els && typeof design.els === 'object')
    ? design.els : null;
  // design.hidden — var names, "slot:N" and "el:…" keys, split three ways.
  // Malformed entries are collected and reported, never fatal in preview.
  const hiddenVars = new Set(), hiddenSlots = new Set(), hiddenEls = new Set(),
    hiddenBad = [];
  if (design && Array.isArray(design.hidden)) {
    for (const entry of design.hidden) {
      if (typeof entry !== 'string' || !entry) { hiddenBad.push(String(entry)); continue; }
      const sm = entry.match(/^slot:(\d+)$/);
      const em = entry.match(/^el:((?:rule|torn):\d+|lockup)$/);
      if (sm) hiddenSlots.add(sm[1]);
      else if (em) hiddenEls.add(em[1]);
      else if (/^[a-zA-Z0-9_]+$/.test(entry)) hiddenVars.add(entry);
      else hiddenBad.push(entry);
    }
  }

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
  const neededBrand = new Set();
  for (const ex of extras) {
    if (!ex || !RE_ILL_NAME.test(String(ex.name || ''))) continue;
    if (ex.type === 'ill') needed.add(String(ex.name));
    else if (ex.type === 'brand') neededBrand.add(String(ex.name));
  }
  await Promise.all([
    ...[...needed].map(loadIllustration),
    ...[...neededBrand].map(loadBrandAsset),
  ]);

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
  // exactly like render.mjs. Text-position placeholders are wrapped in
  // <span data-var> (the design style/drag target); attribute-position
  // placeholders — detected by offset against the pre-pass string — are
  // substituted raw, never wrapped. Same rule, verbatim, in render.mjs.
  const src = html;
  const wrappedVars = new Set();
  html = src.replace(RE_VAR, (_, key, off) => {
    if (!(key in vars)) {
      problems.push('חסר המשתנה ”' + key + '“ שהתבנית ”' + tplName + '“ דורשת');
      return '';
    }
    const val = String(vars[key] ?? '');
    if (insideTag(src, off)) return val;
    wrappedVars.add(key);
    const style = designBlockStyle(blocks[key]) +
      (hiddenVars.has(key) ? 'display:none;' : '');
    return '<span data-var="' + key + '"' +
      (style ? ' style="' + style + '"' : '') + '>' + val + '</span>';
  });

  const leftover = html.match(RE_LEFT);
  if (leftover) problems.push('נשאר סימון לא מפוענח: ' + leftover[0]);

  // design.bg — field swap first (retokens all text), then the bg layers.
  // Invalid values degrade to a visible problem, never a throw.
  if (bg) {
    if (bg.field != null && !RE_FIELD.test(String(bg.field))) {
      problems.push('ערך רקע (field) לא חוקי: ”' + String(bg.field) + '“');
    }
    if (bg.photo != null && !(typeof bg.photo === 'string' && RE_PHOTO_URL.test(bg.photo))) {
      problems.push('כתובת תמונת רקע לא חוקית');
    }
    if (bg.color != null && !RE_TOKEN.test(String(bg.color))) {
      problems.push('צבע רקע לא חוקי: ”' + String(bg.color) + '“');
    }
    if (bg.overlay != null && !(bg.overlay && typeof bg.overlay === 'object' &&
        bg.overlay.color && RE_TOKEN.test(String(bg.overlay.color)))) {
      problems.push('שכבת ההכהיה (overlay) חסרה צבע חוקי');
    }
    html = applyBgField(html, bg.field);
  }

  // design.slots + hidden slots — tag every .photo placeholder, fill/hide
  // the specified ones, then validate what the design referenced.
  const slotRes = applySlots(html, slots, hiddenSlots);
  html = slotRes.html;
  if (slots) {
    for (const k of Object.keys(slots)) {
      if (!/^\d+$/.test(k) || Number(k) >= slotRes.count) {
        problems.push('אין משבצת תמונה מספר ' + k + ' בתבנית ”' + tplName + '“');
        continue;
      }
      const s = slots[k];
      if (s && typeof s === 'object' && s.border != null &&
          !Object.prototype.hasOwnProperty.call(DESIGN_BORDERS, String(s.border))) {
        problems.push('סוג מסגרת לא מוכר במשבצת ' + k + ': ”' + String(s.border) +
          '“ (נבחרה ברירת המחדל)');
      }
    }
    for (const k of slotRes.bad) {
      problems.push('כתובת תמונה לא חוקית במשבצת ' + k);
    }
  }
  for (const k of hiddenSlots) {
    if (Number(k) >= slotRes.count) {
      problems.push('אין משבצת תמונה מספר ' + k + ' להסתרה בתבנית ”' + tplName + '“');
    }
  }

  // design.els + hidden "el:" entries — tag every decorative element (always,
  // in DOM order, before extras), style the ones the design names, then
  // validate what it referenced. Lockup color is ignored + reported: the
  // logo keeps its own colors.
  const elRes = applyEls(html, els, hiddenEls);
  html = elRes.html;
  const elExists = (key) => {
    const m = key.match(/^(rule|torn):(\d+)$/);
    if (m) return Number(m[2]) < elRes.counts[m[1]];
    return key === 'lockup' && elRes.counts.lockup > 0;
  };
  if (els) {
    for (const k of Object.keys(els)) {
      if (!RE_EL_KEY.test(k)) {
        problems.push('מפתח אלמנט לא מוכר בעיצוב: ”' + k + '“');
        continue;
      }
      if (!elExists(k)) {
        problems.push('אין אלמנט ”' + k + '“ בתבנית ”' + tplName + '“');
        continue;
      }
      const e = els[k];
      if (k === 'lockup' && e && typeof e === 'object' && e.color != null) {
        problems.push('הלוגו (lockup) שומר על הצבעים שלו — הצבע לא הוחל');
      }
    }
  }
  for (const k of hiddenEls) {
    if (!elExists(k)) {
      problems.push('אין אלמנט ”' + k + '“ להסתרה בתבנית ”' + tplName + '“');
    }
  }

  for (const v of hiddenVars) {
    if (!wrappedVars.has(v)) {
      problems.push('אין פריט טקסט ”' + v + '“ להסתרה בתבנית ”' + tplName + '“');
    }
  }
  for (const e of hiddenBad) {
    problems.push('ערך הסתרה לא חוקי: ”' + e + '“');
  }

  // design.extras — bg layers first, then extras; z-index bands do the
  // layering (back extras under template content, front extras above it),
  // DOM/array order stacks within each band.
  let extraStr = (slotRes.filled.length ? SLOT_FILLED_CSS : '') +
    (bg ? designBgHtml(bg) : '');
  extras.forEach((ex, i) => {
    if (!ex || typeof ex !== 'object') return;
    if (ex.type === 'ill') {
      const name = String(ex.name || '');
      if (!RE_ILL_NAME.test(name)) {
        problems.push('”' + name + '“ אינו שם איור חוקי (שכבת עיצוב ' + (i + 1) + ')');
        return;
      }
      const svg = illCache.get(name);
      if (svg == null) {
        problems.push('האיור ”' + name + '“ (שכבת עיצוב ' + (i + 1) + ') לא נמצא בספריית האיורים');
        return;
      }
      extraStr += designExtraHtml(ex, i, svg);
    } else if (ex.type === 'brand') {
      const name = String(ex.name || '');
      if (!RE_ILL_NAME.test(name)) {
        problems.push('”' + name + '“ אינו שם נכס מותג חוקי (שכבת עיצוב ' + (i + 1) + ')');
        return;
      }
      const svg = brandCache.get(name);
      if (svg == null) {
        problems.push('נכס המותג ”' + name + '“ (שכבת עיצוב ' + (i + 1) + ') לא נמצא');
        return;
      }
      extraStr += designExtraHtml(ex, i, svg);
    } else if (ex.type === 'photo') {
      if (!RE_PHOTO_URL.test(String(ex.url || ''))) {
        problems.push('כתובת תמונה לא חוקית בשכבת עיצוב ' + (i + 1));
        return;
      }
      if (ex.border != null &&
          !Object.prototype.hasOwnProperty.call(DESIGN_BORDERS, String(ex.border))) {
        problems.push('סוג מסגרת לא מוכר בשכבת עיצוב ' + (i + 1) + ' (נבחרה ברירת המחדל)');
      }
      extraStr += designExtraHtml(ex, i, null);
    } else {
      problems.push('סוג שכבת עיצוב לא מוכר: ”' + String(ex.type) + '“');
    }
  });

  return injectBeforeSlideEnd(html, extraStr);
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

function ensureMount(container) {
  let m = mounts.get(container);
  if (m && container.contains(m.wrapper)) return m;
  if (m && m.ro) m.ro.disconnect();
  container.textContent = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'smr-compose';
  // transform-origin top-RIGHT: this is an RTL surface, the slide hangs off
  // the right edge of its box and scales toward the left.
  wrapper.style.cssText =
    'position:relative;overflow:hidden;width:100%;direction:rtl;';

  const iframe = document.createElement('iframe');
  // allow-same-origin (fonts fetch cleanly, and h.doc() stays reachable),
  // scripts stay blocked — vars are reviewer-editable HTML.
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
  m = { wrapper, iframe, ro, seq: 0, written: 0 };
  mounts.set(container, m);
  return m;
}

// srcdoc swap that resolves once the new document has loaded, so h.doc() is
// valid immediately after `await mountSlide(...)` / `await h.update(...)`.
function setSrcdoc(iframe, html) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      iframe.removeEventListener('load', finish);
      resolve();
    };
    iframe.addEventListener('load', finish);
    iframe.srcdoc = html;
    setTimeout(finish, 4000); // safety valve; load always fires for srcdoc
  });
}

// The handle contract (PLAN.md): {iframe, update(slide), doc()}. It is
// implemented ON the iframe element itself — h.iframe === h — so existing
// callers (post.js, build.js) that treat the return value as the iframe are
// untouched, while editor.js gets the full handle API.
function asHandle(container, m) {
  const f = m.iframe;
  if (!f.update) {
    f.iframe = f;
    f.update = (slide) => mountSlide(container, slide);
    f.doc = () => f.contentDocument;
  }
  return f;
}

// Renders {template, vars, design?} into `container` at true 1080×1350,
// CSS-scaled to the container's width and kept in step with it via
// ResizeObserver. Re-mounting into the same container reuses the iframe
// (srcdoc swap), so a keystroke-driven preview updates without tearing down
// the frame. Overlapping calls settle newest-wins: a slower, older compose
// never overwrites a newer document.
export async function mountSlide(container, slide) {
  const m = ensureMount(container);
  const seq = ++m.seq;
  const html = await composeSlideHTML(slide);
  if (seq > m.written) {
    m.written = seq;
    await setSrcdoc(m.iframe, html);
  }
  fit(container);
  return asHandle(container, m);
}
