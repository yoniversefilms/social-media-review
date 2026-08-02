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

/* == PARITY BLOCK — design overrides (v1 + bg v1.1 + slots/hidden v1.2 +
   els/brand v1.6 + full-library element tagging v1.8 +
   text spacing & opacity v2.2)
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
// v2.2 text alignment. LOGICAL values only — `start`/`end` mean right/left in
// this RTL library and would have to be flipped by hand if they were physical,
// which is exactly the bug an English-language editor would ship here.
const RE_ALIGN = /^(start|center|end|justify)$/;
// Gradients + tints (v1.9), straight off the brand guide pp. 9-10.
// RE_GRAD covers both geometries: `grad-2` runs magenta-first in reading
// order (the RTL default), `grad-2-ltr` is the printed left-to-right one.
const RE_GRAD = /^grad-[123](?:-ltr)?$/;             // legal bg.gradient values
const RE_TINT_CLASS = /^slide--tint-(?:red|blue|orange|gold)-\d+$/;
const RE_GRAD_CLASS = /^slide--grad-[123](?:-ltr)?$/;
const TINT_FAMS = ['red', 'blue', 'orange', 'gold']; // the guide's four groups
const TINT_STEPS = [100, 70, 50, 35, 18, 7];         // and their six steps
// The only steps dark enough to take light type. Everything else in every
// family — including orange-100 and gold-100, which read far lighter than
// they look beside the burgundy — pairs with the paper polarity. Measured in
// docs/GRADIENTS-AND-TINTS.md; do not widen this by eye.
const RE_TINT_DEEP = /^(?:red|blue)-(?:100|70)$/;
// "<family>-<step>" for a valid bg.tint, else null. step is accepted as a
// number or a numeric string — the editor writes numbers, hand-authored JSON
// and anything that has been through a form does not always.
const tintKey = (t) => {
  if (!t || typeof t !== 'object') return null;
  const fam = String(t.color || '');
  const step = Number(t.step);
  return (TINT_FAMS.includes(fam) && TINT_STEPS.includes(step))
    ? fam + '-' + step : null;
};
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
  // v2.2 typography. line-height and letter-spacing are what actually decide
  // whether Hebrew display type reads — more than bold or italic ever do.
  // Alignment needs display:block: a {{var}} is substituted as an inline
  // span, and text-align on an inline box does nothing at all. Block makes it
  // fill the line box its template already gave it, so the alignment has
  // something to align INSIDE, without changing where the box sits.
  if (b.align && RE_ALIGN.test(String(b.align))) {
    s += 'display:block;text-align:' + b.align + ';';
  }
  const lh = dnum(b.lh);
  if (lh !== null) s += 'line-height:' + dround(dclamp(lh, 0.7, 3)) + ';';
  const ls = dnum(b.ls);
  if (ls !== null) s += 'letter-spacing:' + dround(dclamp(ls, -0.08, 0.6)) + 'em;';
  const bop = dnum(b.opacity);
  if (bop !== null) s += 'opacity:' + dround(dclamp(bop, 0, 1)) + ';';
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

// ---- photo styling (v2.4) --------------------------------------------------
// Shape library for photo slots and photo extras. Two mechanisms in one table:
// `r` is a border-radius string, `c` a clip-path. `original` is the escape
// hatch — no mask at all, so a photo keeps the edges it was uploaded with,
// which is the one thing the v1.2 engine could not express (any crop or border
// key forced the blob). `organic`'s radius is byte-identical to tokens.css
// .photo, so a design that names it renders to the same pixels either way.
const DESIGN_SHAPES = {
  original:    null,
  organic:     { r: '47% 53% 44% 56% / 55% 42% 58% 45%' },
  'organic-2': { r: '62% 38% 55% 45% / 48% 60% 40% 52%' },
  'organic-3': { r: '38% 62% 41% 59% / 63% 39% 61% 37%' },
  'blob-soft': { r: '42% 58% 46% 54% / 52% 48% 52% 48%' },
  leaf:        { r: '68% 6% 68% 6% / 68% 6% 68% 6%' },
  arch:        { r: '50% 50% 4% 4% / 38% 38% 3% 3%' },
  rect:        { r: '0' },
  rounded:     { r: '6%' },
  circle:      { r: '50%', square: true },
  ellipse:     { r: '50%' },
  hexagon:     { c: 'polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)' },
  diamond:     { c: 'polygon(50% 0%,100% 50%,50% 100%,0% 50%)' },
  triangle:    { c: 'polygon(50% 0%,100% 100%,0% 100%)' },
  chevron:     { c: 'polygon(0% 0%,100% 0%,100% 82%,50% 100%,0% 82%)' },
  notch:       { c: 'polygon(0% 0%,88% 0%,100% 12%,100% 100%,0% 100%)' },
};
const designShape = (n) =>
  Object.prototype.hasOwnProperty.call(DESIGN_SHAPES, n) ? DESIGN_SHAPES[n] : undefined;

// Frame aspect ratios. `native` (and the absence of the key) means the frame
// follows the picture — its own proportions for an extra, the template's box
// for a slot. Any other value PINS the frame and the image covers it, which is
// what makes cropping a crop rather than only a zoom.
const DESIGN_RATIOS = {
  native: null, '1:1': '1/1', '4:5': '4/5', '5:4': '5/4',
  '3:2': '3/2', '2:3': '2/3', '16:9': '16/9', '9:16': '9/16',
};
const designRatio = (r) =>
  Object.prototype.hasOwnProperty.call(DESIGN_RATIOS, r) ? DESIGN_RATIOS[r] : null;

// The legacy presets, restated in the painted mechanism below so ONE code path
// draws every ring. Widths and tokens are lifted from tokens.css (.photo::after
// = 3px gold-50 · .photo--line = 2px gold-70), so a design that names a preset
// AND a shape gets the ring it always had — on a shape that could never carry
// one before.
const DESIGN_BORDER_PRESETS = {
  paper: { color: 'gold-50', width: 3 },
  line:  { color: 'gold-70', width: 2 },
  none:  null,
};

// What ring a photo carries. Legacy spelling is a preset string; v2.4 adds
// {color:<palette token>, width:<px>} for any thickness in any palette colour.
// `bare` is the default for shape:"original" — "exactly what I uploaded" should
// not arrive wearing a gold ring nobody asked for.
function designBorderSpec(b, bare) {
  if (b == null) return bare ? null : DESIGN_BORDER_PRESETS.paper;
  if (typeof b === 'string') {
    return Object.prototype.hasOwnProperty.call(DESIGN_BORDER_PRESETS, b)
      ? DESIGN_BORDER_PRESETS[b] : DESIGN_BORDER_PRESETS.paper;
  }
  if (typeof b !== 'object') return DESIGN_BORDER_PRESETS.paper;
  const w = dclamp(dnum(b.width) ?? 0, 0, 48);
  if (!(w > 0)) return null;
  return {
    color: (b.color && RE_TOKEN.test(String(b.color))) ? String(b.color) : 'gold-50',
    width: dround(w),
  };
}

// True when a photo carries something v2.4 introduced, i.e. when it needs the
// framed path below. `organic` is deliberately NOT counted: it is the one shape
// name that predates this version (it selected the paper mat), so a design
// whose only new-looking key is shape:"organic" stays on the legacy path —
// otherwise every slide saved before v2.4 would silently lose its mat and its
// ring the moment this shipped.
function designPhotoStyled(s) {
  if (s == null || typeof s !== 'object') return false;
  if (s.overlay != null || s.ratio != null) return true;
  if (s.border != null && typeof s.border === 'object') return true;
  return s.shape != null && s.shape !== 'organic';
}

// The v2.4 frame. ONE mechanism serves both shape families, because the old one
// could not: an inset box-shadow follows border-radius but IGNORES clip-path,
// so a hexagon or a triangle would answer the border control and draw nothing —
// the shape correct, the ring silently absent. Instead the OUTER box is painted
// in the border colour and padded by the border width, and the INNER box
// repeats the same shape, so the ring is a true inset that percentage radii and
// percentage polygons both recompute against the smaller box. Deterministic CSS
// only — no filters, no masks, nothing headless Chrome renders differently
// between the two engines. Returns the two style strings plus whether the image
// must cover (a pinned frame) or keep its own proportions.
function designPhotoFrame(s, cover) {
  const shape = designShape(s.shape);
  const bd = designBorderSpec(s.border, s.shape === 'original');
  const ratio = designRatio(s.ratio);
  // Naming a shape pins BOTH mask properties — the radius and the clip — even
  // when the chosen shape only uses one of them. A slot's element is the
  // TEMPLATE's `.photo`, which already carries a blob radius (tokens.css) and,
  // on the cut-out templates, a `clip-path: url(#…-cut)`. Emitting only the
  // property the new shape happens to use leaves the other one standing, so a
  // circle on a cut-out template would silently keep the template's cut and the
  // picker would look inert. Reset both, always.
  let mask = '';
  if (s.shape != null) {
    mask += 'border-radius:' + ((shape && shape.r) ? shape.r : '0') + ';' +
      'clip-path:' + ((shape && shape.c) ? shape.c : 'none') + ';';
  }
  // a circle stays a circle: it pins 1/1 unless the design names a ratio itself
  const ar = ratio || ((shape && shape.square) ? '1/1' : null);
  let outer = mask;
  if (ar) outer += 'aspect-ratio:' + ar + ';height:auto;';
  outer += bd
    ? 'background:var(--' + bd.color + ');padding:' + bd.width + 'px;box-sizing:border-box;'
    : 'background:transparent;padding:0;';
  const fill = !!(ar || cover);
  // The inner box must wear the SAME mask as the outer or the ring breaks. When
  // no shape is named the outer's mask comes from CSS we cannot read here (the
  // template's class), so the inner INHERITS it — the same trick tokens.css
  // uses on `.photo::after`. Without this, a border on an unshaped slot paints
  // a rectangle inside a blob and survives only as two crescents.
  const innerMask = s.shape != null ? mask : 'border-radius:inherit;clip-path:inherit;';
  const inner = innerMask + 'position:relative;overflow:hidden;' +
    (fill ? 'width:100%;height:100%;' : 'display:block;width:100%;');
  return { outer, inner, cover: fill };
}

// The colour wash over a photo — same {color, opacity} shape as design.bg's
// scrim, so it is one concept in two places. It lives INSIDE the mask, which is
// why it takes the photo's shape instead of squaring it off.
function designPhotoOverlay(ov) {
  if (!ov || typeof ov !== 'object' ||
      !(ov.color && RE_TOKEN.test(String(ov.color)))) return '';
  const op = dclamp(dnum(ov.opacity) ?? 0.35, 0, 0.9);
  return '<div data-photo="overlay" style="position:absolute;inset:0;background:var(--' +
    ov.color + ');opacity:' + dround(op) + ';pointer-events:none"></div>';
}

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
      const s = slots ? slots[String(i)] : null;
      // v2.4: opacity rides on the FRAME for a slot exactly as it does for an
      // extra (designExtraHtml), so a photo fades together with its mat and its
      // ring instead of through them. With no opacity key this collapses to the
      // v1.2 markup, which is what keeps the parity baseline honest.
      const sop = (s && typeof s === 'object') ? dnum(s.opacity) : null;
      const frame = (hiddenSlots && hiddenSlots.has(String(i)) ? 'display:none;' : '') +
        (sop !== null ? 'opacity:' + dround(dclamp(sop, 0, 1)) + ';' : '');
      // the styled path below wants the trailing ';' (it concatenates f.outer
      // after it); the legacy attribute drops it, so a slide with no opacity
      // key emits the byte-identical v1.2 markup and the parity baseline can be
      // compared by hash, not only by eye
      const hide = frame ? ' style="' + frame.replace(/;$/, '') + '"' : '';
      if (!s || typeof s !== 'object' ||
          !(typeof s.url === 'string' && RE_PHOTO_URL.test(s.url))) {
        if (s != null) bad.push(String(i));
        return '<' + tag + ' ' + pre + 'class="' + cls + '" data-slot="' + i + '"' +
          hide + post + '>';
      }
      filled.push(String(i));
      // v2.4: a styled slot keeps the template's .photo element (it is the
      // template's, not ours) but wears photo--none so the class ring stops
      // fighting the painted one, and takes the frame inline. Everything else
      // still renders exactly the v1.2 markup.
      if (designPhotoStyled(s)) {
        const f = designPhotoFrame(s, true);
        const simg = '<img data-slot-img="' + i + '" src="' + dattr(s.url) + '" alt="" ' +
          'style="' + designCropStyle(s, f.cover) + '">';
        return '<' + tag + ' ' + pre + 'class="' + cls + ' photo--none" data-slot="' + i +
          '" data-slot-filled="" style="' + frame + f.outer + '"' + post + '>' +
          '<div style="' + f.inner + '">' + simg + designPhotoOverlay(s.overlay) + '</div>';
      }
      const img = '<img data-slot-img="' + i + '" src="' + dattr(s.url) + '" alt="" ' +
        'style="' + designCropStyle(s, true) + '">';
      return '<' + tag + ' ' + pre + 'class="' + cls + designBorderClass(s.border) +
        '" data-slot="' + i + '" data-slot-filled=""' + hide + post + '>' + img;
    });
  return { html: out, count, filled, bad };
}

// Decorative template elements (design.els v1.6, widened to the whole library
// in v1.8). Every visually distinct thing a template draws is tagged data-el
// at compose time — the editor cannot hit-test what the engine never tagged,
// and v1.6 tagged three classes out of the library's forty, which is why
// clicking an illustration did nothing on most posts.
// docs/ELEMENT-INVENTORY.md is the measured audit this table was derived from
// (all 47 templates walked in Chrome: 635 painted elements, 226 of them with
// no tagged ancestor-or-self at all), and smr-els2-doc.mjs re-checks it — a
// template that draws something whose class is in no row below fails the
// guard instead of shipping unclickable.
//
// [class, kind, tagFilter, paint]. tagFilter narrows a class that means two
// different things in this library: span.mark is list-soft's hand-drawn
// ornament, p.mark is house-e-marker's TEXT paragraph, and putting a
// decorative key on a block of type would shadow the text block underneath.
// paint names the property a palette colour writes — svg/currentColor
// elements take `color`, painted fields take `background`, the lockup takes
// neither (it keeps its own colours; the caller validates and reports).
const DESIGN_EL_KINDS = [
  ['lockup', 'lockup', null, null],
  ['rule', 'rule', null, 'color'],
  ['torn', 'torn', null, 'color'],
  ['ill', 'ill', null, 'color'],
  ['cut', 'edge', null, 'color'],
  ['portrait', 'edge', null, 'color'],
  ['field__cut', 'edge', null, 'color'],
  ['band', 'field', null, 'background'],
  ['wash', 'field', null, 'background'],
  ['glow', 'field', null, 'background'],
  ['smudge', 'field', null, 'background'],
  ['masthead', 'field', null, 'background'],
  ['mast', 'field', null, 'background'],
  ['qa__shape', 'field', null, 'color'],
  ['portrait__fill', 'field', null, 'background'],
  ['mark', 'mark', 'span', 'color'],
  ['dash', 'mark', null, 'color'],
  ['tick', 'mark', null, 'color'],
  ['svc__mark', 'mark', null, 'color'],
  ['label-mark', 'mark', null, 'color'],
  ['kicker__mark', 'mark', null, 'color'],
  ['wing', 'mark', null, 'color'],
  ['cue', 'mark', null, 'color'],
  ['stamp__tick', 'mark', null, 'color'],
  ['series__mark', 'mark', null, 'color'],
  ['stroke', 'line', null, 'color'],
  ['underline', 'line', null, 'color'],
  ['emph__ul', 'line', null, 'color'],
  ['spine', 'line', null, 'color'],
  ['item__n', 'type', null, 'color'],
  ['tel', 'type', null, 'color'],
  ['tel__num', 'type', null, 'color'],
  ['foot__a', 'type', null, 'color'],
  ['foot__b', 'type', null, 'color'],
  ['tag', 'type', null, 'color'],
];
const EL_PAINT = { sweep: 'background' };            // promoted, not a class row
for (const [, kind, , paint] of DESIGN_EL_KINDS) {
  if (!(kind in EL_PAINT)) EL_PAINT[kind] = paint;
}
const RE_EL_KEY =
  /^(?:lockup|(?:rule|torn|ill|edge|field|mark|line|type|sweep):\d+)$/;

// dx/dy are % of slide W/H; scale clamps to [0.4, 2.5]. Both ride the
// INDIVIDUAL `translate`/`scale` properties, never the `transform` shorthand:
// house-e-marker rotates the very elements v1.8 newly tags (.stroke--a/b/c,
// .underline, .smudge and the sweep blob all carry transform:rotate), and a
// shorthand written here would silently drop that rotation the first time a
// reviewer nudged one. The individual properties compose as
// translate ∘ rotate ∘ scale ∘ transform and a uniform scale commutes with
// the template's rotation, so an element with no els entry — and a rule/torn/
// lockup with a v1.6-era one — resolves to exactly the matrix it did before.
// Neither property affects layout, so an offset never reflows the column.
function designElStyle(e, paint) {
  if (!e || typeof e !== 'object') return '';
  let s = '';
  const dx = dnum(e.dx) || 0, dy = dnum(e.dy) || 0;
  if (dx || dy) {
    s += 'translate:' + dround(dx * DESIGN_W / 100) + 'px ' +
      dround(dy * DESIGN_H / 100) + 'px;';
  }
  const sc = dnum(e.scale);
  if (sc !== null && sc !== 1) {
    s += 'scale:' + dround(dclamp(sc, 0.4, 2.5)) + ';';
  }
  if (paint && e.color && RE_TOKEN.test(String(e.color))) {
    s += paint + ':var(--' + e.color + ');';
  }
  const op = dnum(e.opacity);           // v2.2
  if (op !== null) s += 'opacity:' + dround(dclamp(op, 0, 1)) + ';';
  return s;
}

// .sweep::before is the marker blob painted BEHIND the type — the operator's
// «spots of color behind illustrations … lines that are behind text». A
// pseudo-element is not in the DOM: it can never be hit-tested and never
// styled per slide. So the engine emits a real first child that carries the
// key and switches the pseudo off. The declarations are tokens.css's
// `.sweep::before` verbatim; template rules targeting that pseudo are
// rewritten onto the same child, which preserves their relative specificity
// (both sides gain one class and lose one pseudo-element); and this block is
// prepended BEFORE the template's own <style> so those overrides still win.
// smr-els2-verify.mjs compares the promoted child's computed box against the
// pseudo's in the null build rather than trusting this copy to stay in step.
const SWEEP_CSS = '<style>' +
  '.sweep--el::before{display:none!important}' +
  '.sweep__blob{position:absolute;z-index:0;inset-inline:-18px -10px;' +
  'top:12%;bottom:6%;background:var(--gold-35);' +
  'border-radius:42% 58% 46% 54% / 62% 44% 56% 38%;' +
  'transform:rotate(-.7deg)}' +
  '</style>';
const rewriteSweepCss = (html) => html.replace(/<style>([\s\S]*?)<\/style>/g,
  (m0, css) => '<style>' +
    css.replace(/(\.sweep(?:--[A-Za-z0-9_-]+)?)::before/g, '$1>.sweep__blob') +
    '</style>');

// Tags every decorative element in DOM order — kind:N per the table above,
// .lockup keeping its bare "lockup" key (templates carry one) — and applies
// els styles plus hidden "el:" entries as inline style. Runs ALWAYS (the
// editor needs the tags for hit-testing) and BEFORE extras are appended, so
// extras are never tagged. The tagged template elements carry no inline style
// attribute (checked across the library), so injecting one is safe.
// Returns {html, counts}: counts is instances-per-kind, which is what the
// caller's existence check needs.
function applyEls(html, els, hiddenEls) {
  const counts = Object.create(null);
  const styleFor = (key, paint) => {
    const st = designElStyle(els ? els[key] : null, paint) +
      (hiddenEls && hiddenEls.has(key) ? 'display:none;' : '');
    return st ? ' style="' + st + '"' : '';
  };
  const out = html.replace(/<([a-z][a-z0-9]*)\s([^>]*?)class="([^"]*)"([^>]*)>/g,
    (m0, tag, pre, cls, post) => {
      const names = cls.split(/\s+/);
      // The sweep host wraps the type, so it keeps its own box and stays
      // untagged; the promoted blob is what carries the key and the style.
      if (names.includes('sweep')) {
        counts.sweep = (counts.sweep || 0) + 1;
        const key = 'sweep:' + (counts.sweep - 1);
        return '<' + tag + ' ' + pre + 'class="' + cls + ' sweep--el"' + post + '>' +
          '<i class="sweep__blob" data-el="' + key + '"' +
          styleFor(key, 'background') + '></i>';
      }
      let kind = null, paint = null;
      for (const [c, k, wantTag, p] of DESIGN_EL_KINDS) {
        if (!names.includes(c)) continue;
        if (wantTag && tag !== wantTag) continue;
        kind = k; paint = p; break;
      }
      if (kind == null) return m0;
      counts[kind] = (counts[kind] || 0) + 1;
      const key = kind === 'lockup' ? 'lockup' : kind + ':' + (counts[kind] - 1);
      return '<' + tag + ' ' + pre + 'class="' + cls + '" data-el="' + key + '"' +
        styleFor(key, paint) + post + '>';
    });
  return { html: counts.sweep ? SWEEP_CSS + rewriteSweepCss(out) : out, counts };
}

// design.bg.field / .gradient / .tint — swap the classes on the slide root.
// The PREFERRED background change: every text token re-resolves with the
// class, exactly as templates already work, so the surface cannot end up
// carrying type its own contrast table disagrees with.
//
// A gradient/tint emits its class ALONGSIDE a field class rather than instead
// of one. tokens.css scopes nothing to the field today, but all 47 templates
// carry it on their root div and template CSS is free to use it, so the
// light/dark polarity has to stay legible there. The implied field comes from
// the surface's own measured polarity (deep = takes light type); an explicit
// bg.field overrides WHICH field class is written, never the surface itself —
// the gradient/tint rules are declared after the field variants in tokens.css
// and restate `color`, so legibility survives any combination.
//
// gradient beats tint if a design somehow carries both. Invalid/absent
// values: no-op (caller reports). Non-global regex touches only the first
// slide class attr.
function applyBgClasses(html, bg) {
  const b = (bg && typeof bg === 'object') ? bg : {};
  const grad = RE_GRAD.test(String(b.gradient || '')) ? String(b.gradient) : null;
  const tint = grad ? null : tintKey(b.tint);
  let field = RE_FIELD.test(String(b.field || '')) ? String(b.field) : null;
  if (!field && grad) field = 'deep';        // all three gradients take --on-deep
  if (!field && tint) field = RE_TINT_DEEP.test(tint) ? 'deep' : 'paper';
  if (!field && !grad && !tint) return html;
  return html.replace(/class="([^"]*\bslide\b[^"]*)"/, (_, cls) => {
    const kept = cls.split(/\s+/).filter((c) => c &&
      !/^slide--(deep|paper|warm)$/.test(c) &&
      !RE_GRAD_CLASS.test(c) && !RE_TINT_CLASS.test(c));
    if (field) kept.push('slide--' + field);
    if (grad) kept.push('slide--' + grad);
    else if (tint) kept.push('slide--tint-' + tint);
    return 'class="' + kept.join(' ') + '"';
  });
}

// design.bg color/photo/overlay layers. Precedence: photo > color >
// gradient/tint > field — a valid photo suppresses the flat color, and
// gradient/tint paint on the slide root (above) rather than as a layer here.
// pos clamps to 0..100 (default 50,50); overlay opacity clamps to 0..0.8
// (default 0.35). Invalid tokens/urls: layer skipped (caller reports).
//
// The overlay scrim used to exist only with a photo. It now also applies over
// a gradient or tint, because gradient 2 (red -> orange) needs it: --on-deep
// decays from 9.55:1 at the magenta end to 3.05:1 at the orange end, crossing
// the 4.5:1 floor at 68% of the sweep, and a red-100 scrim at 0.35 restores
// 4.73:1 across the whole sweep. Flat bg.color deliberately still takes no
// overlay — that is existing behaviour and changing it would repaint slides
// nobody asked us to touch.
function designBgHtml(bg) {
  if (!bg || typeof bg !== 'object') return '';
  let out = '';
  let scrimmable = false;
  if (typeof bg.photo === 'string' && RE_PHOTO_URL.test(bg.photo)) {
    const pos = Array.isArray(bg.pos) ? bg.pos : [];
    const px = dclamp(dnum(pos[0]) ?? 50, 0, 100);
    const py = dclamp(dnum(pos[1]) ?? 50, 0, 100);
    out += '<img data-bg="photo" src="' + dattr(bg.photo) + '" alt="" ' +
      'style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;' +
      'object-position:' + dround(px) + '% ' + dround(py) + '%;z-index:-30">';
    scrimmable = true;
  } else if (bg.color && RE_TOKEN.test(String(bg.color))) {
    out += '<div data-bg="color" style="position:absolute;inset:0;' +
      'background:var(--' + bg.color + ');z-index:-30"></div>';
  } else if (RE_GRAD.test(String(bg.gradient || '')) || tintKey(bg.tint)) {
    scrimmable = true;
  }
  const ov = bg.overlay;
  if (scrimmable && ov && typeof ov === 'object' && ov.color &&
      RE_TOKEN.test(String(ov.color))) {
    const op = dclamp(dnum(ov.opacity) ?? 0.35, 0, 0.8);
    out += '<div data-bg="overlay" style="position:absolute;inset:0;' +
      'background:var(--' + ov.color + ');opacity:' + dround(op) + ';z-index:-20"></div>';
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
  // v2.2: opacity rides on the wrapper, so a photo extra fades WITH its paper
  // mat and its border ring rather than through them
  const exop = dnum(ex.opacity);
  if (exop !== null) pos += 'opacity:' + dround(dclamp(exop, 0, 1)) + ';';
  if (ex.type === 'ill' || ex.type === 'brand') {
    const color = ex.color && RE_TOKEN.test(String(ex.color))
      ? 'color:var(--' + ex.color + ');' : '';
    return '<div class="ill" data-extra="' + i + '" style="' + pos + color + '">' + svg + '</div>';
  }
  if (ex.type === 'photo') {
    // v2.4 keys (a named shape · a painted border · an overlay · a pinned
    // ratio) take the framed path: nested boxes, everything inline, no .photo
    // class at all. A photo without them falls through to the v1.2 markup
    // below byte for byte — which is what holds the pixel-parity baseline for
    // every design saved before this version.
    if (designPhotoStyled(ex)) {
      const f = designPhotoFrame(ex, false);
      const fimg = '<img src="' + dattr(ex.url) + '" alt="" style="' +
        designCropStyle(ex, f.cover) + '">';
      return '<div data-extra="' + i + '" style="' + pos + f.outer + '">' +
        '<div style="' + f.inner + '">' + fimg + designPhotoOverlay(ex.overlay) +
        '</div></div>';
    }
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

// One validator for everything a photo can carry (v2.4), so a slot and an extra
// report the same wrong value the same way. Deliberately OUTSIDE the parity
// block: render.mjs dies on a bad design, this one collects and draws anyway.
// Every check here describes a FALLBACK, never a refusal — but a fallback the
// reviewer did not ask for is exactly what the problem banner exists to name.
// `where` is already inflected for the «ב» prefix its callers supply.
function designPhotoProblems(s, where, problems) {
  if (!s || typeof s !== 'object') return;
  if (s.shape != null && designShape(s.shape) === undefined) {
    problems.push('צורת תמונה לא מוכרת ב' + where + ': ”' + String(s.shape) + '“');
  }
  if (s.ratio != null &&
      !Object.prototype.hasOwnProperty.call(DESIGN_RATIOS, String(s.ratio))) {
    problems.push('יחס צדדים לא מוכר ב' + where + ': ”' + String(s.ratio) + '“');
  }
  if (s.border != null) {
    if (typeof s.border === 'object') {
      if (s.border.color != null && !RE_TOKEN.test(String(s.border.color))) {
        problems.push('צבע מסגרת לא חוקי ב' + where + ' (נבחרה ברירת המחדל)');
      }
    } else if (!Object.prototype.hasOwnProperty.call(DESIGN_BORDERS, String(s.border))) {
      problems.push('סוג מסגרת לא מוכר ב' + where + ': ”' + String(s.border) +
        '“ (נבחרה ברירת המחדל)');
    }
  }
  if (s.overlay != null &&
      !(typeof s.overlay === 'object' && s.overlay.color &&
        RE_TOKEN.test(String(s.overlay.color)))) {
    problems.push('שכבת צבע לא חוקית ב' + where + ' (לא צוירה)');
  }
}

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
      const em = entry.match(/^el:(.+)$/);
      if (em && !RE_EL_KEY.test(em[1])) { hiddenBad.push(entry); continue; }
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
    if (bg.gradient != null && !RE_GRAD.test(String(bg.gradient))) {
      problems.push('מעבר צבע לא חוקי: ”' + String(bg.gradient) + '“');
    }
    if (bg.tint != null && !tintKey(bg.tint)) {
      problems.push('גוון לא חוקי — צריך משפחה (אדום/כחול/כתום/זהב) ודרגה');
    }
    html = applyBgClasses(html, bg);
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
      designPhotoProblems(slots[k], 'משבצת ' + k, problems);
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
    if (key === 'lockup') return (elRes.counts.lockup || 0) > 0;
    const m = key.match(/^([a-z]+):(\d+)$/);
    return !!m && Number(m[2]) < (elRes.counts[m[1]] || 0);
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
      designPhotoProblems(ex, 'שכבת עיצוב ' + (i + 1), problems);
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
