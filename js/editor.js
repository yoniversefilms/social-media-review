// editor.js — direct manipulation on the composed slide.
// Owner: editor-UI agent. Contract: PLAN.md «Slide design overrides (v1)».
//
// Works ON TOP of a compose.js mountSlide handle ({iframe, update, doc}).
// Every piece of interaction UI — selection outline, drag/resize/rotate
// handles, the floating toolbar, the add-illustration / add-photo flows —
// (see the v1.6 note at the bottom of this header for els + brand assets and
// the frame-edge stop that every drag now respects)
// lives in the PARENT document, positioned over the iframe, so re-composition
// (which rebuilds the iframe's srcdoc) never kills it. Hit-testing reaches
// into the iframe via doc.elementFromPoint; the composed spans are
// scripting-disabled, so no listener is ever attached inside the frame.
//
// The editor mutates a deep-copied working `design` and reports it out through
// onChange(design) (debounced 250ms); it re-applies via
// handle.update({...slide, design}). Pure drags translate live via inline
// style and commit on release, with Canva-style magnetic snapping to the
// slide center lines + 96px brand margins (accent guide lines while engaged;
// Alt = free drag; drag gestures only — never crop-pan/resize/rotate). It
// NEVER talks to store.js — host pages wire saving.
//
// opts.actionBar (optional): a host container ABOVE the slide that receives
// the non-contextual action buttons (הוסף איור/תמונה, רקע, שכבות, איפוס)
// instead of floating them over the artwork. Contextual UI (selection
// toolbar, handles, guides, slot hints) always stays on the slide.
//
//   initEditor(handle, slide, {onChange, manifest, photos, assetUrl,
//                              photosEmptyText, uploadFile, onTextChange,
//                              actionBar})
//     -> {destroy, refresh, setPhotos, getDesign, addPhotoExtra, dropFiles,
//         startTextEdit}
//
// Drag & drop: while armed, the overlay accepts (a) desktop image-file drops —
// uploaded through the host's opts.uploadFile(file) -> {url}, then placed as a
// photo extra centered on the drop point, cascading +4% per extra file — and
// (b) in-app photo-thumbnail drags carrying PHOTO_DRAG_MIME (no re-upload).
//
// In-place text editing: double-click a block (or ✏️ in its toolbar) makes the
// composed span contentEditable — text reflows live under the template's own
// CSS, NO re-compose while typing. Commit on blur/Enter (one-liners) or ✓;
// Esc/✗ reverts. Commits sanitize to the template vocabulary (<b>, <br>),
// write slide.vars[key], re-compose once, and report via onTextChange(key,
// value) — hosts feed that into the עריכת טקסט proposal path / builder vars.
//
// Background (design.bg) + layers: «רקע» panel — brand-field swap (preferred),
// flat palette color (with a legibility clash hint), background photo with
// focal point + scrim; «שכבות» panel — front extras · template blocks (fixed)
// · back extras ("back": true) · background, drag-reorder within bands.
//
// Photo slots (design.slots v1.2): the engine tags every template .photo
// placeholder data-slot="N"; empty slots get a UI-only hint overlay in the
// PARENT document (never rendered content) — double-click or drop fills them
// (slot hit-testing beats free-extra placement). A selected filled slot IS
// crop mode: drag pans `pos`, slider/wheel zooms (1–3), rule-of-thirds grid
// while cropping, border picker (נייר/קו/בלי), replace, remove. Photo extras
// get the same crop via an explicit ✂️ toolbar toggle (out of crop mode drag
// still moves the frame). design.hidden (v1.2): the delete button works on
// ANY selected item — extras splice out, template blocks/slots go into
// `hidden` (engine display:none) and can be restored from the layers panel.
// «איפוס עיצוב» opens one dialog — this slide only / the whole deck — and
// reports the choice through opts.onReset(scope); proposals already in
// sm_edits are never touched.
//
// design.els + brand assets (v1.6): the engine tags decorative template
// elements (.rule → data-el="rule:N", .lockup → data-el="lockup", .torn →
// data-el="torn:N"); clicking one selects it (after slots and text blocks,
// before free space). Its toolbar: drag to move (els.dx/dy % — the block-drag
// machinery incl. snap+guides and a measured drag-response correction, here
// probed through the element's own transform), scale slider [0.4–2.5]
// (els.scale), palette swatches for RULES only (currentColor; lockup/torn
// keep their own ink), «מחיקה» → hidden "el:<key>" entry (greyed layers row +
// שחזר), and «שכפול» — a rule duplicates as the matching ba-rule-* brand
// extra (exact svg-path match, default ba-rule-wide), torn as ba-torn-band;
// the lockup's שכפול is blocked («אין עדיין קובץ לוגו רשמי» — the JFCS
// Logomark Masterfile is still open; never fake the brand stamp). The
// «נכסי מותג» action-bar button opens a picker of manifest.brandAssets
// (inline SVG previews, Hebrew labels) and places extras {type:"brand",
// name, x, y, w} — engine-identical to ill extras but sourced from
// studio/brand-assets/; their toolbar has drag/resize/rotate/front-back/
// delete + color swatches, and NO crop/border rows (furniture, not photos).
//
// Edge offsets (operator directive, v1.6): EVERY drag — extra, block or el —
// hard-stops when the dragged box reaches the slide frame, so nothing walks
// off the artboard by accident. The bounds are solved at pointerdown in the
// gesture's own value space through the same measured response the magnets
// use (so the auto-margin templates stop at the true visual edge, not a
// nominal one); a box already bleeding when the drag starts keeps its
// position, and a box bigger than the frame flips to the dual rule (the frame
// stays covered). Alt is the ONE deliberate-bleed modifier — the same key
// that frees the magnets — and every draggable selection's toolbar says so.

import { el, modal, toast } from './ui.js';

// dataTransfer MIME for photo drags that originate inside the app (grid
// thumbnails → slide). Carrying the public URL means no re-upload on drop.
export const PHOTO_DRAG_MIME = 'application/x-smr-photo';

const W = 1080, H = 1350;
const ROT_SNAP = 3;      // deg
// Canva-style magnetic snapping — DRAG gestures only (never crop-pan, resize
// or rotate). Targets: the slide center lines (x=50%/y=50%), the 96px brand
// margins, and — for template blocks — dx/dy=0 (this absorbs the old
// snap-to-0). Thresholds live in slide-space %: pointer deltas are divided by
// the preview scale before comparing, so the magnet feels identical at every
// preview size. Engaged snaps hold until the pointer pulls SNAP_R× past the
// capture radius (hysteresis = the "sticky line" feel without trapping).
const SNAP_T = 1.2;      // % of slide — capture radius per axis
const SNAP_R = 1.6;      // release multiplier — disengage past SNAP_T*SNAP_R
const MARGIN_PX = 96;    // brand margin in 1080×1350 design px
const CHANGE_MS = 250;   // onChange debounce (contract)

// Registry fallbacks — used only until studio/manifest.json ships
// {fonts:[{key,label,family}]} and {palette:[{name,css}]} (engine/ingest side
// of the contract). Keys match the PLAN registry; css values match tokens.css.
const FONT_FALLBACK = [
  { key: 'body',        label: 'גוף (Assistant)',      family: 'Assistant',  file: 'assistant.ttf' },
  { key: 'serif',       label: 'ספרותי (FrankRuhl)',   family: 'FrankRuhl',  file: 'frankruhl.ttf' },
  { key: 'display',     label: 'כותרת (Heebo)',        family: 'Heebo',      file: 'heebo.ttf' },
  { key: 'heavy',       label: 'הצהרתי (SuezOne)',     family: 'SuezOne',    file: 'suezone.ttf' },
  { key: 'handwriting', label: 'כתב יד',               family: 'Handwriting', file: 'handwriting.ttf' },
];
const FONT_FILES = Object.fromEntries(FONT_FALLBACK.map((f) => [f.key, f.file]));

// Brand assets (v1.6) — the manifest ships {brandAssets:[{name,label}]}
// (built by ingest from studio/brand-assets/MANIFEST.md). This fallback keeps
// the picker alive if a stale manifest lacks the block; names must match the
// files in studio/brand-assets/.
const BRAND_FALLBACK = [
  { name: 'ba-rule-wide', label: 'קו מפריד רחב' },
  { name: 'ba-rule-soft', label: 'קו מפריד רך' },
  { name: 'ba-rule-lift', label: 'קו מפריד מתרומם' },
  { name: 'ba-rule-thin', label: 'קו מפריד דק' },
  { name: 'ba-underline-double', label: 'קו הדגשה כפול' },
  { name: 'ba-torn-band', label: 'שפה קרועה' },
  { name: 'ba-photo-blob', label: 'מסגרת תמונה אורגנית' },
  { name: 'ba-sweep-band', label: 'מריחת מרקר' },
  { name: 'ba-sweep-round', label: 'כתם מרקר עגול' },
  { name: 'ba-dot-marker', label: 'נקודת מרקר' },
  { name: 'ba-asterisk', label: 'כוכבית' },
  { name: 'ba-quote-marks', label: 'מרכאות' },
  { name: 'ba-corner-stroke', label: 'קשת פינה' },
];

// «שכפול» of a rule places the brand extra of THAT divider. Every extracted
// ba-rule-* keeps its source path verbatim (brand-assets/MANIFEST.md), so the
// rule's inline svg path is an exact fingerprint. Unmapped wobbles (templates
// carry a few one-off rules) default to ba-rule-wide per the contract.
const RULE_D_TO_ASSET = {
  'M4 9 C70 3 140 12 208 6 C268 1 330 11 396 5': 'ba-rule-wide',
  'M4 8 C68 4 138 11 206 6 C266 2 332 10 396 6': 'ba-rule-soft',
  'M4 7 C72 12 138 2 204 8 C266 13 332 4 396 9': 'ba-rule-lift',
  'M4 8 C74 3 142 12 210 6 C270 2 334 11 396 6': 'ba-rule-thin',
};

const PALETTE_FALLBACK = [
  { name: 'ink',       css: '#830051' },
  { name: 'ink-soft',  css: '#6d2a4e' },
  { name: 'ink-black', css: '#1c1418' },
  { name: 'on-deep',   css: '#fdf8f4' },
  { name: 'red-100',   css: '#830051' },
  { name: 'red-70',    css: '#8b4a6a' },
  { name: 'red-50',    css: '#a27186' },
  { name: 'red-35',    css: '#bc9aa8' },
  { name: 'red-18',    css: '#d2bdc4' },
  { name: 'gold-100',  css: '#B3995D' },
  { name: 'gold-70',   css: '#c4a77b' },
  { name: 'gold-50',   css: '#d5be9e' },
  { name: 'gold-35',   css: '#e4d5be' },
  { name: 'gold-18',   css: '#efe5d9' },
  { name: 'gold-7',    css: '#f7f2ec' },
];

// ---------------------------------------------------------------- canonical

// Stable stringify (sorted object keys, arrays in order) — the wire format of
// design proposals: sm_edits old_text/new_text hold exactly this string.
export function canonicalJSON(v) {
  if (v === undefined || v === null) return '';
  return JSON.stringify(sortVal(v));
}
function sortVal(v) {
  if (Array.isArray(v)) return v.map(sortVal);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortVal(v[k]);
    return o;
  }
  return v;
}

// Hebrew one-liner describing a design object (or its canonical JSON) — used
// by host pages when listing design proposals.
export function designSummary(d) {
  if (typeof d === 'string') {
    if (!d.trim()) return 'איפוס העיצוב (חזרה לתבנית)';
    try { d = JSON.parse(d); } catch { return 'עיצוב (JSON לא תקין)'; }
  }
  if (!d || typeof d !== 'object') return 'איפוס העיצוב (חזרה לתבנית)';
  const parts = [];
  const blocks = Object.keys(d.blocks || {});
  if (blocks.length) parts.push('טקסט: ' + blocks.join(', '));
  const extras = d.extras || [];
  const nIll = extras.filter((e) => e.type === 'ill').length;
  const nPh = extras.filter((e) => e.type === 'photo').length;
  const nBr = extras.filter((e) => e.type === 'brand').length;
  if (nIll) parts.push(nIll === 1 ? 'איור' : nIll + ' איורים');
  if (nPh) parts.push(nPh === 1 ? 'תמונה' : nPh + ' תמונות');
  if (nBr) parts.push(nBr === 1 ? 'נכס מותג' : nBr + ' נכסי מותג');
  const nEls = d.els && typeof d.els === 'object' ? Object.keys(d.els).length : 0;
  if (nEls) parts.push(nEls === 1 ? 'אלמנט מעוצב' : nEls + ' אלמנטים מעוצבים');
  if (d.bg) parts.push(d.bg.photo ? 'תמונת רקע' : 'רקע');
  const nSlots = d.slots && typeof d.slots === 'object' ? Object.keys(d.slots).length : 0;
  if (nSlots) parts.push(nSlots === 1 ? 'תמונה במשבצת' : nSlots + ' תמונות במשבצות');
  const nHid = Array.isArray(d.hidden) ? d.hidden.length : 0;
  if (nHid) parts.push(nHid === 1 ? 'פריט מוסתר' : nHid + ' פריטים מוסתרים');
  return parts.length ? parts.join(' · ') : 'איפוס העיצוב (חזרה לתבנית)';
}

// ---------------------------------------------------------------- utils

const deepCopy = (v) => (typeof structuredClone === 'function'
  ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
const round1 = (v) => Math.round(v * 10) / 10;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));


const BG_FIELDS = ['deep', 'paper', 'warm'];

function normalizeDesign(d) {
  const out = { blocks: {}, extras: [] };
  if (d && typeof d === 'object') {
    if (d.blocks && typeof d.blocks === 'object') out.blocks = deepCopy(d.blocks);
    if (Array.isArray(d.extras)) out.extras = deepCopy(d.extras);
    if (d.bg && typeof d.bg === 'object') out.bg = deepCopy(d.bg);
    if (d.slots && typeof d.slots === 'object' && Object.keys(d.slots).length) {
      out.slots = deepCopy(d.slots);
    }
    if (d.els && typeof d.els === 'object' && Object.keys(d.els).length) {
      out.els = deepCopy(d.els);
    }
    if (Array.isArray(d.hidden) && d.hidden.length) out.hidden = deepCopy(d.hidden);
  }
  return out;
}

function isEmptyDesign(d) {
  return !Object.keys(d.blocks).length && !d.extras.length && !d.bg &&
    !(d.slots && Object.keys(d.slots).length) &&
    !(d.els && Object.keys(d.els).length) &&
    !(d.hidden && d.hidden.length);
}

// design.hidden — var names + "slot:N" + "el:<key>" (v1.2 + els v1.6)
const RE_HIDDEN_KEY = /^(?:[a-zA-Z0-9_]+|slot:\d+|el:(?:rule|torn):\d+|el:lockup)$/;
// data-el keys the engine tags (PLAN «design.els + brand assets (v1.6)»)
const RE_EL_KEY = /^(?:(?:rule|torn):\d+|lockup)$/;

// Shared crop canonicalization for slot fills and photo extras: pos [%,%]
// (omitted at the 50/50 default), zoom clamped 1..3 (omitted at 1), border
// paper (default, omitted) / line / none.
function pruneCropInto(o, src) {
  if (Array.isArray(src.pos) && src.pos.length === 2) {
    const px = round1(clamp(Number(src.pos[0]) || 0, 0, 100));
    const py = round1(clamp(Number(src.pos[1]) || 0, 0, 100));
    if (px !== 50 || py !== 50) o.pos = [px, py];
  }
  const z = Math.round(clamp(Number(src.zoom) || 1, 1, 3) * 100) / 100;
  if (z > 1) o.zoom = z;
  if (src.border === 'line' || src.border === 'none') o.border = src.border;
  return o;
}

function pruneSlotSpec(s) {
  if (!s || typeof s !== 'object' || typeof s.url !== 'string' || !s.url) return null;
  return pruneCropInto({ url: s.url }, s);
}

// design.bg sanitizer — PLAN «design.bg (v1.1)»: photo > color > field;
// pos and overlay only meaningful with photo; overlay opacity clamped ≤ 0.8.
function pruneBg(bg) {
  if (!bg || typeof bg !== 'object') return null;
  const o = {};
  if (BG_FIELDS.includes(bg.field)) o.field = bg.field;
  if (typeof bg.color === 'string' && bg.color) o.color = bg.color;
  if (typeof bg.photo === 'string' && bg.photo) {
    o.photo = bg.photo;
    if (Array.isArray(bg.pos) && bg.pos.length === 2) {
      o.pos = [round1(clamp(Number(bg.pos[0]) || 0, 0, 100)),
               round1(clamp(Number(bg.pos[1]) || 0, 0, 100))];
    }
    if (bg.overlay && typeof bg.overlay === 'object' && bg.overlay.color) {
      o.overlay = {
        color: String(bg.overlay.color),
        opacity: clamp(Math.round((Number(bg.overlay.opacity) || 0) * 100) / 100, 0, 0.8),
      };
    }
  }
  return Object.keys(o).length ? o : null;
}

function pruneBlock(b) {
  const o = {};
  if (b.font) o.font = b.font;
  if (typeof b.size === 'number' && Math.abs(b.size - 1) > 0.001) o.size = Math.round(b.size * 100) / 100;
  if (b.bold === true) o.bold = true;
  if (b.italic === true) o.italic = true;
  if (b.color) o.color = b.color;
  if (typeof b.dx === 'number' && round1(b.dx) !== 0) o.dx = round1(b.dx);
  if (typeof b.dy === 'number' && round1(b.dy) !== 0) o.dy = round1(b.dy);
  return Object.keys(o).length ? o : null;
}

function pruneExtra(e) {
  const o = { type: e.type, x: round1(e.x || 0), y: round1(e.y || 0), w: round1(e.w || 20) };
  // brand marks (v1.6) carry a name like ills — and never crop/border keys
  if (e.type === 'ill' || e.type === 'brand') o.name = e.name;
  else {
    o.url = e.url;
    if (e.shape) o.shape = e.shape;
    pruneCropInto(o, e);               // slots v1.2: photo extras crop the same way
  }
  if (e.color) o.color = e.color;
  const rot = Math.round(e.rot || 0);
  if (rot) o.rot = rot;
  if (e.back === true) o.back = true;   // layering v1.1: renders below template content
  return o;
}

// design.els entry (v1.6): dx/dy % (omitted at 0), scale clamped [0.4, 2.5]
// (omitted at 1), color = palette token — engine-honored on rules and torn,
// but the UI only offers it on rules; the lockup NEVER keeps a color (the
// engine would ignore it and flag a problem banner).
function pruneEl(e, key) {
  if (!e || typeof e !== 'object') return null;
  const o = {};
  if (typeof e.dx === 'number' && round1(e.dx) !== 0) o.dx = round1(e.dx);
  if (typeof e.dy === 'number' && round1(e.dy) !== 0) o.dy = round1(e.dy);
  if (typeof e.scale === 'number') {
    const s = Math.round(clamp(e.scale, 0.4, 2.5) * 100) / 100;
    if (Math.abs(s - 1) > 0.001) o.scale = s;
  }
  if (e.color && key !== 'lockup') o.color = e.color;
  return Object.keys(o).length ? o : null;
}

// ---------------------------------------------------------------- styles

let stylesDone = false;
function injectStyles() {
  if (stylesDone) return;
  stylesDone = true;
  const s = document.createElement('style');
  s.id = 'smr-editor-css';
  s.textContent = `
.smr-edov{position:absolute;inset:0;z-index:8;touch-action:none;user-select:none;
  -webkit-user-select:none;cursor:default}
.smr-edov.is-hit{cursor:pointer}
.smr-edov.is-drag{cursor:grabbing}
.smr-edbox{position:absolute;pointer-events:none;border-radius:2px}
.smr-edbox--hover{outline:1.5px dashed rgba(131,0,81,.55)}
.smr-edbox--sel{outline:2px solid #830051;box-shadow:0 0 0 4px rgba(131,0,81,.15)}
.smr-edbox--sel.is-snap{outline-color:#2e7d4f;box-shadow:0 0 0 4px rgba(46,125,79,.25)}
.smr-edh{position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;
  border:2px solid #830051;box-shadow:0 1px 4px rgba(0,0,0,.3);pointer-events:auto}
.smr-edh--rz{bottom:-9px;left:-9px;cursor:nwse-resize}
.smr-edh--rot{top:-30px;left:50%;transform:translateX(-50%);cursor:grab}
.smr-edh--rot::after{content:'';position:absolute;top:14px;left:50%;width:2px;height:14px;
  background:#830051;transform:translateX(-50%)}
.smr-edadd{position:absolute;top:8px;inset-inline-start:8px;display:flex;gap:6px;z-index:3}
.smr-edadd .btn{padding:5px 10px;font-size:.8rem;background:rgba(255,253,249,.92);
  box-shadow:0 2px 8px rgba(0,0,0,.14)}
.smr-eddrop[hidden],.smr-edbusy[hidden]{display:none}
.smr-eddrop{position:absolute;inset:10px;z-index:6;pointer-events:none;
  display:flex;align-items:center;justify-content:center;border-radius:14px;
  border:3px dashed var(--accent,#830051);background:rgba(255,253,249,.72);
  font-weight:700;font-size:1.05rem;color:var(--accent,#830051);text-align:center;
  padding:20px}
.smr-edbusy{position:absolute;bottom:10px;inset-inline-start:10px;z-index:6;
  pointer-events:none;background:rgba(255,253,249,.94);
  border:1px solid var(--line,rgba(36,29,32,.12));border-radius:999px;
  padding:6px 14px;font-size:.85rem;font-weight:600;color:var(--ink,#241d20);
  box-shadow:0 2px 10px rgba(0,0,0,.15)}
.smr-edtb[hidden]{display:none}
.smr-edtb{position:fixed;z-index:1200;background:var(--paper,#fffdf9);
  border:1px solid var(--line,rgba(36,29,32,.12));border-radius:12px;
  box-shadow:0 14px 44px rgba(36,29,32,.28);padding:10px;display:grid;gap:8px;
  max-width:min(420px,92vw);font-size:.88rem}
.smr-edtb__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.smr-edtb__name{font-weight:700;font-size:.8rem;color:var(--ink-soft,#6b5f63);
  direction:ltr;font-family:ui-monospace,monospace}
.smr-edtb select{max-width:190px}
.smr-edtb input[type=range]{width:130px;accent-color:var(--accent,#830051)}
.smr-edtb__sz{font-size:.78rem;color:var(--ink-soft,#6b5f63);min-width:44px;direction:ltr}
.smr-edtg{appearance:none;border:1px solid var(--line,rgba(36,29,32,.15));background:var(--paper,#fffdf9);
  border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:.95rem;color:var(--ink,#241d20)}
.smr-edtg.on{background:var(--accent,#830051);color:#fff;border-color:var(--accent,#830051)}
.smr-edtg--b{font-weight:800}
.smr-edtg--i{font-style:italic;font-family:serif}
.smr-edsw{appearance:none;width:22px;height:22px;border-radius:50%;cursor:pointer;
  border:1px solid rgba(36,29,32,.25);padding:0}
.smr-edsw.on{outline:2px solid var(--accent,#830051);outline-offset:2px}
.smr-edtb .btn{padding:5px 10px;font-size:.8rem}
.smr-edtb__del{color:#b3403a}
.smr-edpick{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;
  max-height:min(56vh,560px);overflow-y:auto;padding:2px}
.smr-edpick button{appearance:none;border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:10px;background:var(--paper,#fffdf9);cursor:pointer;padding:8px;font:inherit;
  display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--ink,#241d20)}
.smr-edpick button:hover{border-color:var(--accent,#830051)}
.smr-edpick img{width:64px;height:64px;object-fit:contain;display:block}
.smr-edpick--ph img{width:100%;height:84px;object-fit:cover;border-radius:6px}
.smr-edpick .nm{font-size:.7rem;direction:ltr;overflow-wrap:anywhere;color:var(--ink-soft,#6b5f63)}
.smr-edcta[hidden]{display:none}
.smr-edcta{position:fixed;z-index:1300;display:flex;gap:6px;background:var(--paper,#fffdf9);
  border:1px solid var(--line,rgba(36,29,32,.12));border-radius:10px;padding:6px;
  box-shadow:0 10px 30px rgba(36,29,32,.25)}
.smr-edcta .btn{padding:4px 12px;font-size:.82rem}
.smr-edcta__ok{color:#2e7d4f;font-weight:700}
.smr-edcta__no{color:#b3403a}
.smr-edpanel[hidden]{display:none}
.smr-edpanel{position:fixed;z-index:1150;width:264px;background:var(--paper,#fffdf9);
  border:1px solid var(--line,rgba(36,29,32,.12));border-radius:14px;
  box-shadow:0 14px 44px rgba(36,29,32,.28);padding:12px;display:grid;gap:10px;
  font-size:.86rem;max-height:min(76vh,720px);overflow-y:auto}
.smr-edpanel h5{margin:0;font-size:.8rem;color:var(--ink-soft,#6b5f63);font-weight:700;
  display:flex;align-items:center;gap:6px}
.smr-edpanel__x{margin-inline-start:auto;appearance:none;border:0;background:none;
  cursor:pointer;font-size:1rem;color:var(--ink-soft,#6b5f63);line-height:1}
.smr-edpanel .rec{font-size:.68rem;background:var(--accent,#830051);color:#fff;
  border-radius:999px;padding:2px 8px;font-weight:600}
.smr-edbgf{display:flex;gap:8px}
.smr-edbgf button{appearance:none;cursor:pointer;flex:1;height:52px;border-radius:10px;
  border:1px solid var(--line,rgba(36,29,32,.18));display:flex;align-items:flex-end;
  justify-content:center;padding:4px;font:inherit;font-size:.7rem;font-weight:600}
.smr-edbgf button.on{outline:2px solid var(--accent,#830051);outline-offset:2px}
.smr-edwarn{font-size:.78rem;color:#8a5a00;background:#fdf3dd;border-radius:8px;padding:6px 10px}
.smr-edfoc{position:relative;width:128px;height:160px;border-radius:10px;background-size:cover;
  background-position:center;border:1px solid var(--line,rgba(36,29,32,.18));
  cursor:crosshair;touch-action:none;justify-self:center}
.smr-edfoc__dot{position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;
  border:2px solid var(--accent,#830051);box-shadow:0 1px 5px rgba(0,0,0,.4);
  transform:translate(-50%,-50%);pointer-events:none}
.smr-edbgph{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.smr-edbgph button{appearance:none;border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:8px;padding:0;overflow:hidden;cursor:pointer;height:52px;background:#eee}
.smr-edbgph button.on{outline:2px solid var(--accent,#830051);outline-offset:1px}
.smr-edbgph img{width:100%;height:100%;object-fit:cover;display:block}
.smr-edlyr{display:grid;gap:2px}
.smr-edlyr__band{font-size:.68rem;color:var(--ink-soft,#6b5f63);margin-top:6px;
  text-transform:none;letter-spacing:.02em}
.smr-edlyr__row{display:flex;align-items:center;gap:6px;border-radius:8px;padding:4px 6px;
  cursor:pointer;border:1px solid transparent;background:none;min-height:32px}
.smr-edlyr__row:hover{background:rgba(131,0,81,.05)}
.smr-edlyr__row.on{border-color:var(--accent,#830051);background:rgba(131,0,81,.07)}
.smr-edlyr__row.is-dragover{border-top:2px solid var(--accent,#830051)}
.smr-edlyr__row img{width:22px;height:22px;object-fit:cover;border-radius:4px;flex:none}
/* vector layers (ill/brand): the whole mark, not a square crop of its middle
   — cover turns a wide divider into an anonymous black bar */
.smr-edlyr__row img.is-vec{object-fit:contain;border-radius:0;opacity:.72}
.smr-edlyr__nm{flex:1;font-size:.78rem;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;direction:ltr;text-align:end}
.smr-edlyr__row .mini{appearance:none;border:0;background:none;cursor:pointer;
  font-size:.8rem;padding:2px 4px;border-radius:6px;color:var(--ink-soft,#6b5f63);flex:none}
.smr-edlyr__row .mini:hover{background:rgba(131,0,81,.12);color:var(--accent,#830051)}
.smr-edlyr__grip{cursor:grab;color:var(--ink-soft,#6b5f63);font-size:.85rem;flex:none;
  user-select:none}
.smr-edlyr__row.is-off{opacity:.45}
.smr-edlyr__row.is-off:hover{opacity:.7}
.smr-edlyr__row .mini--restore{font-size:.72rem;font-weight:700;color:var(--accent,#830051)}
.smr-edslots{position:absolute;inset:0;pointer-events:none}
.smr-edslot{position:absolute;pointer-events:none;display:flex;align-items:flex-end;
  justify-content:center;text-align:center;border:2.5px dashed rgba(131,0,81,.45);
  border-radius:16px;background:rgba(131,0,81,.03);padding:14px}
.smr-edslot span{background:rgba(255,253,249,.94);border-radius:999px;padding:7px 16px;
  font-size:.85rem;font-weight:700;color:var(--accent,#830051);
  box-shadow:0 2px 10px rgba(0,0,0,.14);max-width:92%}
.smr-edslot.is-target{border-color:var(--accent,#830051);border-style:solid;
  background:rgba(131,0,81,.14)}
.smr-edgrid{position:absolute;pointer-events:none;z-index:5;
  outline:1px solid rgba(255,255,255,.55);
  filter:drop-shadow(0 0 1px rgba(0,0,0,.55));
  background:
    linear-gradient(rgba(255,255,255,.75),rgba(255,255,255,.75)) left 0 top 33.33%/100% 1.5px no-repeat,
    linear-gradient(rgba(255,255,255,.75),rgba(255,255,255,.75)) left 0 top 66.66%/100% 1.5px no-repeat,
    linear-gradient(rgba(255,255,255,.75),rgba(255,255,255,.75)) left 33.33% top 0/1.5px 100% no-repeat,
    linear-gradient(rgba(255,255,255,.75),rgba(255,255,255,.75)) left 66.66% top 0/1.5px 100% no-repeat}
.smr-edgrid[hidden]{display:none}
.smr-edguide{position:absolute;pointer-events:none;z-index:6;
  background:var(--accent,#830051);opacity:0;transition:opacity 150ms ease}
.smr-edguide--v{width:1px}
.smr-edguide--h{height:1px}
.smr-edguide.on{opacity:1}
.smr-edadd--bar{position:static;inset-inline-start:auto}
.smr-edtg--w{width:auto;padding:0 10px;font-size:.8rem}
.smr-edpick--br button{align-items:stretch}
.smr-edpick--br .bsvg{display:flex;align-items:center;justify-content:center;
  height:52px;color:var(--accent,#830051)}
.smr-edpick--br .bsvg svg{width:86%;max-height:100%;overflow:visible}
.smr-edpick--br .nm{direction:rtl;text-align:center;font-size:.75rem;
  color:var(--ink,#241d20)}
.smr-edtb .is-off{opacity:.45;cursor:not-allowed}
`;
  document.head.appendChild(s);
}

let facesDone = false;
function injectFontFaces(fonts, assetUrl) {
  if (facesDone) return;
  facesDone = true;
  const rules = [];
  for (const f of fonts) {
    const file = f.file || FONT_FILES[f.key];
    if (!file || !f.family) continue;
    rules.push(`@font-face{font-family:'${f.family}';src:url('${assetUrl('studio/fonts/' + file)}') format('truetype');font-display:swap;}`);
  }
  if (!rules.length) return;
  const s = document.createElement('style');
  s.id = 'smr-editor-fonts';
  s.textContent = rules.join('\n');
  document.head.appendChild(s);
}

function normalizePhotos(list) {
  return (Array.isArray(list) ? list : []).map((p) => {
    if (typeof p === 'string') return { url: p, note: '' };
    return { url: p.url || '', note: p.note || '' };
  }).filter((p) => p.url);
}

// ================================================================ initEditor

export function initEditor(handle, slide, opts = {}) {
  if (!handle || typeof handle.update !== 'function' ||
      typeof handle.doc !== 'function' || !handle.iframe) {
    throw new Error('מנוע התצוגה עדיין לא תומך בעורך העיצוב (חסר handle.update/doc)');
  }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const man = opts.manifest || {};
  const assetUrl = typeof opts.assetUrl === 'function' ? opts.assetUrl : (p) => p;
  const fonts = (Array.isArray(man.fonts) && man.fonts.length) ? man.fonts : FONT_FALLBACK;
  const palette = (Array.isArray(man.palette) && man.palette.length) ? man.palette : PALETTE_FALLBACK;
  const illNames = Array.isArray(man.illustrations) ? man.illustrations : [];
  // v1.6 — brand assets: manifest {brandAssets:[{name,label}]} (Hebrew labels
  // from studio/brand-assets/MANIFEST.md); labels fall back to prettified
  // file names, the list itself to the known collection.
  const brandAssets = (Array.isArray(man.brandAssets) && man.brandAssets.length)
    ? man.brandAssets.map((b) => (typeof b === 'string' ? { name: b } : b))
        .filter((b) => b && b.name)
        .map((b) => ({ name: String(b.name), label: b.label || prettyBrandName(b.name) }))
    : BRAND_FALLBACK;
  const brandLabel = (name) => {
    const b = brandAssets.find((x) => x.name === name);
    return b ? b.label : prettyBrandName(name);
  };
  function prettyBrandName(n) {
    return String(n).replace(/^ba-/, '').replace(/-/g, ' ');
  }
  const brandSvg = new Map(); // name -> svg text | null (miss) — picker previews
  async function brandSvgText(name) {
    if (brandSvg.has(name)) return brandSvg.get(name);
    let svg = null;
    try {
      const res = await fetch(assetUrl('studio/brand-assets/' + name + '.svg'));
      if (res.ok) svg = await res.text();
    } catch { /* preview stays empty */ }
    brandSvg.set(name, svg);
    return svg;
  }
  const photosEmptyText = opts.photosEmptyText ||
    'אין עדיין תמונות לפוסט הזה — מעלים תמונות בלשונית ”תמונות“ וחוזרים לכאן.';

  let photos = normalizePhotos(opts.photos);
  let design = normalizeDesign(slide.design);
  let sel = null;        // {kind:'block', name} | {kind:'extra', index} | {kind:'slot', n}
  let destroyed = false;
  let changeT = null, applyT = null;
  let editing = null;    // in-place text edit session (see startTextEdit)
  let pendingApply = false; // an applyNow deferred because a text edit is live
  let extraCropOn = false;  // ✂️ crop mode for the selected photo extra
  let zoomUI = null;        // {input, val} of the live zoom slider (wheel sync)
  const aspect = new Map();     // extra asset key -> width/height ratio
  const natural = new Map();    // photo url -> {w,h} | 0 (loading) — crop pan math

  const iframe = handle.iframe;
  const wrapper = iframe.parentElement;

  injectStyles();
  injectFontFaces(fonts, assetUrl);

  // ---------------- parent-document UI ----------------

  const hoverBox = el('div', { class: 'smr-edbox smr-edbox--hover', hidden: true });
  const selBox = el('div', { class: 'smr-edbox smr-edbox--sel', hidden: true });
  const hRot = el('div', { class: 'smr-edh smr-edh--rot', title: 'סיבוב' });
  const hRz = el('div', { class: 'smr-edh smr-edh--rz', title: 'שינוי גודל' });
  selBox.append(hRot, hRz);
  // opts.actionBar: a host-provided container ABOVE the slide for the
  // non-contextual action buttons (they don't sit on the artwork). Without
  // it the row floats over the slide's top corner as before. Either way the
  // row keeps the .smr-edadd class — hosts/tests target the buttons by it.
  const barHost = (opts.actionBar && opts.actionBar.nodeType === 1) ? opts.actionBar : null;
  const addBar = el('div', { class: 'smr-edadd' + (barHost ? ' smr-edadd--bar' : '') },
    el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => pickIll() }, '+ הוסף איור'),
    el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => pickPhoto() }, '+ הוסף תמונה'),
    el('button', { class: 'btn btn--ghost', type: 'button', title: 'חותמות, קווים ועיטורים של המותג', onclick: () => pickBrand() }, 'נכסי מותג'),
    el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => togglePanel('bg') }, 'רקע'),
    el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => togglePanel('layers') }, 'שכבות'),
    el('button', { class: 'btn btn--ghost', type: 'button', title: 'איפוס העיצוב — שקף אחד או כל הקרוסלה', onclick: () => resetDialog() }, 'איפוס עיצוב'),
  );
  const dropHint = el('div', { class: 'smr-eddrop', hidden: true }, 'שחררו כאן כדי להוסיף את התמונה');
  const busyEl = el('div', { class: 'smr-edbusy', hidden: true }, 'מעלים תמונה…');
  // UI-only hints over empty photo slots (parent document — never rendered
  // content) + the rule-of-thirds grid shown while cropping + the accent
  // snap guides (1px lines across the full slide while a magnet is engaged).
  const slotHints = el('div', { class: 'smr-edslots' });
  const gridBox = el('div', { class: 'smr-edgrid', hidden: true });
  const guideV = el('div', { class: 'smr-edguide smr-edguide--v' });
  const guideH = el('div', { class: 'smr-edguide smr-edguide--h' });
  const overlay = el('div', { class: 'smr-edov', dir: 'rtl' },
    slotHints, hoverBox, selBox, gridBox, guideV, guideH, dropHint, busyEl);
  if (barHost) barHost.appendChild(addBar); else overlay.appendChild(addBar);
  wrapper.appendChild(overlay);

  const toolbar = el('div', { class: 'smr-edtb', dir: 'rtl', hidden: true });
  toolbar.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(toolbar);

  // in-place text editing: floating ✓/✗ near the edited block. pointerdown +
  // preventDefault so pressing them never steals focus (focus loss = blur =
  // commit, which would fire before the click).
  const ctaOk = el('button', { class: 'btn btn--ghost smr-edcta__ok', type: 'button' }, '✓ שמירה');
  const ctaNo = el('button', { class: 'btn btn--ghost smr-edcta__no', type: 'button' }, '✗ ביטול');
  ctaOk.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); commitTextEdit(); });
  ctaNo.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); cancelTextEdit(); });
  const editBar = el('div', { class: 'smr-edcta', dir: 'rtl', hidden: true }, ctaOk, ctaNo);
  document.body.appendChild(editBar);

  // side panels (רקע / שכבות) — one open at a time
  const bgPanel = el('div', { class: 'smr-edpanel', dir: 'rtl', hidden: true });
  const layersPanel = el('div', { class: 'smr-edpanel', dir: 'rtl', hidden: true });
  bgPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  layersPanel.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.append(bgPanel, layersPanel);

  // ---------------- geometry ----------------

  function irect() { return iframe.getBoundingClientRect(); }
  function scale() { return (irect().width / W) || 1; }
  function doc() { try { return handle.doc(); } catch { return null; } }

  function docPoint(e) {
    const r = irect(), s = (r.width / W) || 1;
    return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
  }

  function blockEl(name) {
    const d = doc();
    if (!d) return null;
    try { return d.querySelector(`[data-var="${CSS.escape(name)}"]`); } catch { return null; }
  }

  function extraEl(i) {
    const d = doc();
    if (!d) return null;
    let n = null;
    try { n = d.querySelector(`[data-extra="${i}"]`); } catch { /* fall through */ }
    if (n) return n;
    const all = d.querySelectorAll('[data-extra]');
    return all[i] || null;
  }

  // ---------------- photo slots (design.slots v1.2) ----------------
  // The engine tags every template .photo placeholder data-slot="0..N" in DOM
  // order (extras' .photo wrappers are never tagged). The design is the
  // authority on what is filled; the doc is the authority on geometry.

  const slotKeyOf = (n) => 'slot:' + n;
  const hiddenKeys = () => (Array.isArray(design.hidden) ? design.hidden : []);
  const isHiddenKey = (k) => hiddenKeys().includes(k);

  function slotEl(n) {
    const d = doc();
    if (!d) return null;
    return d.querySelector('[data-slot="' + Number(n) + '"]');
  }

  function slotEls() {
    const d = doc();
    if (!d) return [];
    return [...d.querySelectorAll('[data-slot]')]
      .filter((el2) => !el2.hasAttribute('data-extra'));
  }

  function slotImgEl(n) {
    const d = doc();
    if (!d) return null;
    return d.querySelector('img[data-slot-img="' + Number(n) + '"]');
  }

  // the fill spec, or null when the slot is empty
  function slotSpec(n) {
    const s = design.slots && design.slots[String(n)];
    return (s && typeof s === 'object' && typeof s.url === 'string' && s.url) ? s : null;
  }

  function slotAt(p) {
    for (const el2 of slotEls()) {
      const r = el2.getBoundingClientRect();
      if (!r.width || !r.height) continue;             // hidden slots don't hit
      if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
        return Number(el2.getAttribute('data-slot'));
      }
    }
    return null;
  }

  // ---------------- decorative elements (design.els v1.6) ----------------
  // The engine tags .rule/.lockup/.torn data-el="rule:N"/"lockup"/"torn:N"
  // in DOM order, always. The design's els entries move/scale/recolor them;
  // hidden rides design.hidden with an "el:" prefix.

  const elHiddenKey = (key) => 'el:' + key;

  function elEl(key) {
    const d = doc();
    if (!d) return null;
    try { return d.querySelector(`[data-el="${CSS.escape(key)}"]`); } catch { return null; }
  }

  function elKeysInDoc() {
    const d = doc();
    if (!d) return [];
    return [...d.querySelectorAll('[data-el]')]
      .map((n) => n.getAttribute('data-el'))
      .filter((k) => k && RE_EL_KEY.test(k));
  }

  function elOf(key) {
    if (!design.els || typeof design.els !== 'object') design.els = {};
    if (!design.els[key]) design.els[key] = {};
    return design.els[key];
  }

  // the inline transform the ENGINE writes for an els entry (parity: compose
  // and live drag must move the element identically) — translate in design
  // px, then scale about the element's own origin
  function elTransform(dx, dy, sc) {
    let t = '';
    if (dx || dy) {
      t += 'translate(' + round1(dx * W / 100) + 'px,' + round1(dy * H / 100) + 'px)';
    }
    const s = typeof sc === 'number' ? clamp(sc, 0.4, 2.5) : 1;
    if (Math.abs(s - 1) > 0.001) t += (t ? ' ' : '') + 'scale(' + s + ')';
    return t;
  }

  function elLabelOf(key) {
    if (key === 'lockup') return 'חתימת המותג (לוגו)';
    const m = key.match(/^(rule|torn):(\d+)$/);
    if (!m) return key;
    const base = m[1] === 'rule' ? 'קו מפריד' : 'שפה קרועה';
    // number the label only when the template carries siblings of the kind
    const twins = elKeysInDoc().filter((k) => k.startsWith(m[1] + ':')).length;
    return twins > 1 ? base + ' ' + (Number(m[2]) + 1) : base;
  }

  function natSize(url) {
    if (natural.has(url)) return natural.get(url) || null;
    natural.set(url, 0);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        natural.set(url, { w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.src = url;
    return null;
  }

  function extraAspect(ex) {
    const key = ex.type === 'photo' ? ex.url : ex.type + ':' + ex.name;
    if (aspect.has(key)) return aspect.get(key) || 1;
    aspect.set(key, 0); // loading marker
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth && img.naturalHeight) {
        aspect.set(key, img.naturalWidth / img.naturalHeight);
        refreshUI();
      }
    };
    img.src = ex.type === 'ill' ? assetUrl('studio/illustrations/' + ex.name + '.svg')
      : ex.type === 'brand' ? assetUrl('studio/brand-assets/' + ex.name + '.svg')
      : ex.url;
    return 1;
  }

  // geometry of a selection target, in doc units (1080×1350 space):
  // {cx, cy, w, h, rot}
  function geomOf(t) {
    if (!t) return null;
    if (t.kind === 'block' || t.kind === 'slot' || t.kind === 'el') {
      const n = t.kind === 'block' ? blockEl(t.name)
        : t.kind === 'slot' ? slotEl(t.n) : elEl(t.key);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, rot: 0 };
    }
    const ex = design.extras[t.index];
    if (!ex) return null;
    const n = extraEl(t.index);
    if (n) {
      const r = n.getBoundingClientRect();
      const w = n.offsetWidth || r.width, h = n.offsetHeight || r.height;
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w, h, rot: ex.rot || 0 };
    }
    // engine hasn't rendered this extra (or tags it differently) — compute
    // from the design object itself so the editor still works.
    const w = (ex.w || 20) / 100 * W;
    const h = w / (extraAspect(ex) || 1);
    const x = (ex.x || 0) / 100 * W, y = (ex.y || 0) / 100 * H;
    return { cx: x + w / 2, cy: y + h / 2, w, h, rot: ex.rot || 0 };
  }

  function pointInGeom(p, g) {
    if (!g) return false;
    const a = -(g.rot || 0) * Math.PI / 180;
    const dx = p.x - g.cx, dy = p.y - g.cy;
    const lx = dx * Math.cos(a) - dy * Math.sin(a);
    const ly = dx * Math.sin(a) + dy * Math.cos(a);
    return Math.abs(lx) <= g.w / 2 && Math.abs(ly) <= g.h / 2;
  }

  function hitAt(e) {
    const p = docPoint(e);
    // extras first, topmost (= last in array) wins
    for (let i = design.extras.length - 1; i >= 0; i--) {
      if (pointInGeom(p, geomOf({ kind: 'extra', index: i }))) return { kind: 'extra', index: i };
    }
    const d = doc();
    if (d) {
      let n = null;
      try { n = d.elementFromPoint(p.x, p.y); } catch { /* ignore */ }
      // walk up: a photo-slot ancestor beats any var inside it (the slot's
      // pending label IS a var — clicking it must hit the slot, not the text);
      // decorative data-el elements (v1.6) rank after slots and text blocks,
      // before free space
      let varName = null, elKey = null;
      while (n && n.nodeType === 1) {
        if (varName == null && n.hasAttribute && n.hasAttribute('data-var')) {
          varName = n.getAttribute('data-var');
        }
        if (elKey == null && n.hasAttribute && n.hasAttribute('data-el')) {
          elKey = n.getAttribute('data-el');
        }
        if (n.hasAttribute && n.hasAttribute('data-slot') && !n.hasAttribute('data-extra')) {
          return { kind: 'slot', n: Number(n.getAttribute('data-slot')) };
        }
        n = n.parentElement;
      }
      if (varName != null) return { kind: 'block', name: varName };
      if (elKey != null && RE_EL_KEY.test(elKey)) return { kind: 'el', key: elKey };
    }
    return null;
  }

  function sameSel(a, b) {
    return !!a && !!b && a.kind === b.kind &&
      (a.kind === 'block' ? a.name === b.name
        : a.kind === 'slot' ? a.n === b.n
        : a.kind === 'el' ? a.key === b.key : a.index === b.index);
  }

  // ---------------- painting selection UI ----------------

  function placeBox(box, g) {
    if (!g) { box.hidden = true; return; }
    const s = scale();
    const ir = irect(), or = overlay.getBoundingClientRect();
    box.hidden = false;
    box.style.width = g.w * s + 'px';
    box.style.height = g.h * s + 'px';
    box.style.left = (ir.left - or.left + g.cx * s) + 'px';
    box.style.top = (ir.top - or.top + g.cy * s) + 'px';
    box.style.transform = `translate(-50%,-50%) rotate(${g.rot || 0}deg)`;
  }

  // Accent guide lines across the full slide while a snap is engaged —
  // parent-document overlay elements, never rendered content. gx/gy are
  // doc-space line coords (or null = no line on that axis); both can be live
  // at once (x+y simultaneously). Hiding removes .on and lets the CSS
  // opacity transition fade the line out over ~150ms.
  function paintGuides(gx, gy) {
    const s = scale(), ir = irect(), or = overlay.getBoundingClientRect();
    if (gx != null) {
      guideV.style.left = (ir.left - or.left + gx * s) + 'px';
      guideV.style.top = (ir.top - or.top) + 'px';
      guideV.style.height = (H * s) + 'px';
      guideV.classList.add('on');
    } else guideV.classList.remove('on');
    if (gy != null) {
      guideH.style.top = (ir.top - or.top + gy * s) + 'px';
      guideH.style.left = (ir.left - or.left) + 'px';
      guideH.style.width = (W * s) + 'px';
      guideH.classList.add('on');
    } else guideH.classList.remove('on');
  }

  function positionToolbar(g) {
    if (!g || toolbar.hidden) return;
    const s = scale(), ir = irect();
    const tw = toolbar.offsetWidth || 300, th = toolbar.offsetHeight || 60;
    const ax = ir.left + g.cx * s;
    // extras carry a rotate handle 30px above the box and a resize handle on
    // the bottom corner — keep the toolbar clear of both
    const gap = sel && sel.kind === 'extra' ? 52 : 14;
    let top = ir.top + (g.cy - g.h / 2) * s - th - gap;
    if (top < 8) top = ir.top + (g.cy + g.h / 2) * s + gap;
    top = clamp(top, 8, Math.max(8, window.innerHeight - th - 8));
    const left = clamp(ax - tw / 2, 8, Math.max(8, window.innerWidth - tw - 8));
    toolbar.style.left = left + 'px';
    toolbar.style.top = top + 'px';
  }

  // the target whose crop gestures (pan drag / wheel / grid) are live:
  // a selected FILLED slot is always in crop mode; a photo extra only with ✂️ on
  function cropTarget() {
    if (!sel) return null;
    if (sel.kind === 'slot' && slotSpec(sel.n)) return sel;
    if (sel.kind === 'extra' && extraCropOn) {
      const ex = design.extras[sel.index];
      if (ex && ex.type === 'photo') return sel;
    }
    return null;
  }

  // UI-only overlays over EMPTY, visible slots — parent-document elements
  // that never exist in any render (the operator's explicit requirement).
  function paintSlotHints() {
    const boxes = [];
    for (const el2 of slotEls()) {
      const n = Number(el2.getAttribute('data-slot'));
      if (slotSpec(n) || isHiddenKey(slotKeyOf(n))) continue;
      const g = geomOf({ kind: 'slot', n });
      if (!g) continue;
      const box = el('div', { class: 'smr-edslot', 'data-slot-hint': String(n) },
        el('span', null, '📷 לחצו פעמיים או גררו תמונה לכאן'));
      placeBox(box, g);
      boxes.push(box);
    }
    slotHints.replaceChildren(...boxes);
  }

  function refreshUI() {
    if (destroyed) return;
    paintSlotHints();
    if (sel && sel.kind === 'extra' && !design.extras[sel.index]) sel = null;
    if (sel && sel.kind === 'slot' && !slotEl(sel.n)) sel = null;
    if (sel && sel.kind === 'el' && !elEl(sel.key)) sel = null;
    const g = sel ? geomOf(sel) : null;
    if (!sel) { selBox.hidden = true; toolbar.hidden = true; gridBox.hidden = true; return; }
    placeBox(selBox, g);
    const showHandles = sel.kind === 'extra';
    hRot.style.display = showHandles ? '' : 'none';
    hRz.style.display = showHandles ? '' : 'none';
    const ct = cropTarget();
    if (ct && g) placeBox(gridBox, g); else gridBox.hidden = true;
    toolbar.hidden = false;
    positionToolbar(g);
  }

  // ---------------- mutations ----------------

  function buildSlide() {
    const out = { ...slide };
    if (isEmptyDesign(design)) delete out.design;
    else out.design = deepCopy(design);
    return out;
  }

  function prune() {
    const nb = {};
    for (const [k, b] of Object.entries(design.blocks)) {
      const p = pruneBlock(b);
      if (p) nb[k] = p;
    }
    design.blocks = nb;
    design.extras = design.extras.map(pruneExtra);
    if (design.slots) {
      const ns = {};
      for (const [k, s] of Object.entries(design.slots)) {
        const p = pruneSlotSpec(s);
        if (p) ns[k] = p;
      }
      if (Object.keys(ns).length) design.slots = ns; else delete design.slots;
    }
    if (design.els) {
      const ne = {};
      for (const [k, e] of Object.entries(design.els)) {
        if (!RE_EL_KEY.test(k)) continue;
        const p = pruneEl(e, k);
        if (p) ne[k] = p;
      }
      if (Object.keys(ne).length) design.els = ne; else delete design.els;
    }
    if (design.hidden) {
      const h = [];
      for (const k0 of design.hidden) {
        const k = String(k0);
        if (RE_HIDDEN_KEY.test(k) && !h.includes(k)) h.push(k);
      }
      if (h.length) design.hidden = h; else delete design.hidden;
    }
  }

  function fireChange() {
    clearTimeout(changeT);
    changeT = setTimeout(() => {
      if (destroyed) return;
      onChange(isEmptyDesign(design) ? null : deepCopy(design));
    }, CHANGE_MS);
  }

  function applyNow() {
    clearTimeout(applyT);
    applyT = null;
    // never re-compose under a live contenteditable session — the edited span
    // IS the template DOM; recomposition would destroy it mid-typing
    if (editing) { pendingApply = true; return; }
    Promise.resolve(handle.update(buildSlide()))
      .then(() => requestAnimationFrame(refreshUI))
      .catch(() => {});
  }

  // defer: trailing-debounce the re-compose (slider drags); onChange always 250ms
  function commit(o = {}) {
    prune();
    fireChange();
    if (o.defer) {
      clearTimeout(applyT);
      applyT = setTimeout(applyNow, o.defer);
    } else {
      applyNow();
    }
  }

  function blockOf(name) {
    if (!design.blocks[name]) design.blocks[name] = {};
    return design.blocks[name];
  }

  // ---------------- selection & toolbar ----------------

  function select(t) {
    if (!sameSel(t, sel)) extraCropOn = false; // crop mode never survives retargeting
    sel = t;
    hoverBox.hidden = true;
    renderToolbar();
    refreshUI();
    renderLayersPanel(); // highlight follows selection
  }

  function deselect() {
    sel = null;
    extraCropOn = false;
    selBox.hidden = true;
    toolbar.hidden = true;
    gridBox.hidden = true;
    renderLayersPanel();
  }

  // hide/restore template items (design.hidden) — the delete path for
  // template blocks and photo slots; extras just splice out of the array
  function hideKey(key) {
    if (!Array.isArray(design.hidden)) design.hidden = [];
    if (!design.hidden.includes(key)) design.hidden.push(key);
    deselect();
    commit();
    renderLayersPanel();
  }

  function restoreKey(key) {
    if (Array.isArray(design.hidden)) {
      design.hidden = design.hidden.filter((k) => k !== key);
    }
    commit();
    renderLayersPanel();
  }

  function swatchRow(current, onPick) {
    return el('div', { class: 'smr-edtb__row' },
      palette.map((p) => {
        const b = el('button', {
          class: 'smr-edsw' + (current === p.name ? ' on' : ''),
          type: 'button', title: p.name,
          style: { background: p.css },
          onclick: () => onPick(current === p.name ? null : p.name),
        });
        return b;
      }),
    );
  }

  function renderToolbar() {
    zoomUI = null;
    if (!sel) { toolbar.hidden = true; return; }
    toolbar.hidden = false;
    if (sel.kind === 'block') renderBlockToolbar(sel.name);
    else if (sel.kind === 'slot') renderSlotToolbar(sel.n);
    else if (sel.kind === 'el') renderElToolbar(sel.key);
    else renderExtraToolbar(sel.index);
    requestAnimationFrame(() => positionToolbar(sel ? geomOf(sel) : null));
  }

  // «נייר» = the .photo paper mat (default) · «קו» = gold hairline · «בלי» = bare mask
  function borderRow(current, onPick) {
    const cur = current === 'line' || current === 'none' ? current : 'paper';
    return el('div', { class: 'smr-edtb__row' },
      el('span', null, 'מסגרת'),
      [['paper', 'נייר'], ['line', 'קו'], ['none', 'בלי']].map(([v, lab]) =>
        el('button', {
          class: 'smr-edtg smr-edtg--w' + (cur === v ? ' on' : ''),
          type: 'button',
          onclick: () => onPick(v),
        }, lab)),
    );
  }

  // Edge offsets (operator directive): a drag hard-stops at the slide frame,
  // and Alt is the single deliberate-bleed modifier — the same key that frees
  // the magnets. It only helps if it is on screen, so every toolbar whose
  // selection can be DRAGGED (block · extra · el) carries this line.
  const DRAG_HINT = 'גרירה נעצרת בשולי השקף · Alt = תזוזה חופשית וחריגה מעבר לשוליים';
  const dragHint = () => el('div', {
    class: 'smr-edtb__row',
    style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' },
  }, DRAG_HINT);

  // shared zoom slider (slots + crop-mode photo extras); wheel-over-frame
  // updates the same UI through zoomUI. getObj re-resolves the live object on
  // every event — commit()'s prune replaces the stored objects, so a captured
  // reference would go stale after the first commit.
  function zoomRow(getObj, target) {
    const z0 = clamp(Number((getObj() || {}).zoom) || 1, 1, 3);
    const val = el('span', { class: 'smr-edtb__sz' }, '×' + z0.toFixed(2));
    const range = el('input', {
      type: 'range', min: '1', max: '3', step: '0.05', value: String(z0),
    });
    range.addEventListener('input', () => {
      const obj = getObj();
      if (!obj) return;
      obj.zoom = Number(range.value);
      val.textContent = '×' + obj.zoom.toFixed(2);
      liveCrop(target, obj);
      commit({ defer: 150 });
    });
    range.addEventListener('change', () => commit());
    zoomUI = { input: range, val };
    return el('div', { class: 'smr-edtb__row' }, el('span', null, 'זום'), range, val);
  }

  function renderSlotToolbar(n) {
    const s = slotSpec(n);
    const name = el('span', { class: 'smr-edtb__name' }, 'slot ' + n);
    if (!s) {
      const addB = el('button', { class: 'btn btn--ghost', type: 'button' }, '📷 הוספת תמונה');
      addB.addEventListener('click', () => pickPhoto({
        title: 'איזו תמונה נכנסת למשבצת?',
        onPick: (url) => fillSlot(n, url),
      }));
      const hideB = el('button', { class: 'btn btn--ghost smr-edtb__del', type: 'button', title: 'הסתרת המשבצת מהשקף — משחזרים מלוח השכבות' }, 'מחיקת המשבצת');
      hideB.addEventListener('click', () => hideKey(slotKeyOf(n)));
      toolbar.replaceChildren(
        el('div', { class: 'smr-edtb__row' }, name, addB, hideB),
        el('div', { class: 'smr-edtb__row', style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' } },
          'לחיצה כפולה או גרירת תמונה ממלאות את המשבצת'),
      );
      return;
    }
    const swapB = el('button', { class: 'btn btn--ghost', type: 'button' }, 'החלפה');
    swapB.addEventListener('click', () => pickPhoto({
      title: 'החלפת התמונה במשבצת',
      onPick: (url) => fillSlot(n, url),
    }));
    const rmB = el('button', { class: 'btn btn--ghost smr-edtb__del', type: 'button', title: 'המשבצת נשארת — התמונה יוצאת' }, 'הסרה');
    rmB.addEventListener('click', () => {
      if (design.slots) delete design.slots[String(n)];
      commit();
      renderToolbar();
      renderLayersPanel();
    });
    const hideB = el('button', { class: 'btn btn--ghost smr-edtb__del', type: 'button', title: 'הסתרת המשבצת כולה — משחזרים מלוח השכבות' }, 'מחיקת המשבצת');
    hideB.addEventListener('click', () => hideKey(slotKeyOf(n)));
    toolbar.replaceChildren(
      el('div', { class: 'smr-edtb__row' }, name, swapB, rmB, hideB),
      zoomRow(() => slotSpec(n), { kind: 'slot', n }),
      borderRow(s.border, (v) => {
        const cur = slotSpec(n);
        if (!cur) return;
        if (v === 'paper') delete cur.border; else cur.border = v;
        commit();
        renderToolbar();
      }),
      el('div', { class: 'smr-edtb__row', style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' } },
        'גוררים את התמונה בתוך המסגרת כדי למקם אותה · גלגלת = זום'),
    );
  }

  function renderBlockToolbar(name) {
    const b = design.blocks[name] || {};

    const fontSel = el('select', { class: 'field__input' },
      el('option', { value: '' }, 'גופן התבנית'),
      fonts.map((f) => {
        const o = el('option', { value: f.key, style: { fontFamily: `'${f.family}', Assistant, sans-serif` } }, f.label);
        if (b.font === f.key) o.selected = true;
        return o;
      }),
    );
    fontSel.addEventListener('change', () => {
      const blk = blockOf(name);
      if (fontSel.value) blk.font = fontSel.value; else delete blk.font;
      commit();
    });

    const szVal = el('span', { class: 'smr-edtb__sz' }, '×' + (b.size || 1).toFixed(2));
    const szRange = el('input', {
      type: 'range', min: '0.6', max: '1.8', step: '0.05', value: String(b.size || 1),
    });
    szRange.addEventListener('input', () => {
      const blk = blockOf(name);
      blk.size = Number(szRange.value);
      szVal.textContent = '×' + blk.size.toFixed(2);
      commit({ defer: 120 });
    });
    szRange.addEventListener('change', () => commit());

    const boldB = el('button', { class: 'smr-edtg smr-edtg--b' + (b.bold ? ' on' : ''), type: 'button', title: 'מודגש' }, 'B');
    boldB.addEventListener('click', () => {
      const blk = blockOf(name);
      blk.bold = !blk.bold;
      boldB.classList.toggle('on', blk.bold);
      commit();
    });
    const italB = el('button', { class: 'smr-edtg smr-edtg--i' + (b.italic ? ' on' : ''), type: 'button', title: 'נטוי' }, 'I');
    italB.addEventListener('click', () => {
      const blk = blockOf(name);
      blk.italic = !blk.italic;
      italB.classList.toggle('on', blk.italic);
      commit();
    });

    const resetB = el('button', { class: 'btn btn--ghost', type: 'button' }, 'איפוס');
    resetB.addEventListener('click', () => {
      delete design.blocks[name];
      commit();
      renderToolbar();
    });

    const editTextB = el('button', {
      class: 'btn btn--ghost', type: 'button',
      title: 'עריכת הטקסט ישירות על השקף (או לחיצה כפולה עליו)',
    }, '✏️ ערוך טקסט');
    editTextB.addEventListener('click', () => startTextEdit(name, null));

    // design.hidden — delete works on ANY selected item; template blocks are
    // hidden (display:none), restorable from the layers panel
    const delB = el('button', {
      class: 'btn btn--ghost smr-edtb__del', type: 'button',
      title: 'הסתרת הטקסט מהשקף — משחזרים מלוח השכבות',
    }, 'מחיקה');
    delB.addEventListener('click', () => hideKey(name));

    toolbar.replaceChildren(
      el('div', { class: 'smr-edtb__row' },
        el('span', { class: 'smr-edtb__name' }, name),
        fontSel, boldB, italB,
      ),
      el('div', { class: 'smr-edtb__row' },
        el('span', null, 'גודל'), szRange, szVal, editTextB, resetB, delB,
      ),
      swatchRow(b.color || null, (color) => {
        const blk = blockOf(name);
        if (color) blk.color = color; else delete blk.color;
        commit();
        renderToolbar();
      }),
      dragHint(),
    );
  }

  // computed CSS color -> nearest palette token (exactish match only) — used
  // to carry a rule's rendered ink onto its duplicated brand extra
  function cssToRgb(c) {
    let m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(String(c || '').trim());
    if (m) return [+m[1], +m[2], +m[3]];
    m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim());
    if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    return null;
  }
  function nearestToken(cssColor) {
    const rgb = cssToRgb(cssColor);
    if (!rgb) return null;
    let best = null, bd = 24 * 24 * 3; // tight: only a real palette ink matches
    for (const p of palette) {
      const q = cssToRgb(p.css);
      if (!q) continue;
      const d = (rgb[0] - q[0]) ** 2 + (rgb[1] - q[1]) ** 2 + (rgb[2] - q[2]) ** 2;
      if (d < bd) { bd = d; best = p.name; }
    }
    return best;
  }

  // «שכפול» (v1.6): a rule duplicates as the brand extra of THAT divider —
  // its inline svg path is an exact fingerprint of the extracted asset
  // (RULE_D_TO_ASSET); unmapped one-off wobbles default to ba-rule-wide.
  // torn → ba-torn-band. Placed at the element's position (nudged +3% down so
  // the copy is visible beside its source), same width, same rendered ink.
  function duplicateEl(key) {
    const node = elEl(key);
    const g = geomOf({ kind: 'el', key });
    let name = 'ba-rule-wide';
    if (key.startsWith('torn')) name = 'ba-torn-band';
    else if (node) {
      const path = node.querySelector('svg path');
      const d = path && path.getAttribute('d');
      const hit = d && RULE_D_TO_ASSET[d.replace(/\s+/g, ' ').trim()];
      if (hit) name = hit;
    }
    const ex = { type: 'brand', name, x: 35, y: 40, w: 30 };
    if (g) {
      ex.w = round1(clamp(g.w / W * 100, 2, 100));
      ex.x = round1(clamp((g.cx - g.w / 2) / W * 100, -15, 98));
      ex.y = round1(clamp((g.cy - g.h / 2) / H * 100 + 3, -15, 98));
    }
    let tok = ((design.els || {})[key] || {}).color || null;
    if (!tok && node) {
      try {
        tok = nearestToken(node.ownerDocument.defaultView.getComputedStyle(node).color);
      } catch { /* no color carried */ }
    }
    if (tok) ex.color = tok;
    design.extras.push(ex);
    commit();
    select({ kind: 'extra', index: design.extras.length - 1 });
    toast('נכס המותג ”' + brandLabel(name) + '“ נוסף — גררו אותו למקומו');
  }

  // decorative-element toolbar (v1.6): drag hint, scale, color (rules only),
  // duplicate, delete-to-hidden, reset. The lockup's שכפול is blocked — the
  // JFCS Logomark Masterfile is still the open blocker; the brand stamp is
  // never faked from live-typed HTML.
  function renderElToolbar(key) {
    const e = (design.els || {})[key] || {};
    const isRule = key.startsWith('rule:');
    const isLockup = key === 'lockup';
    const name = el('span', {
      class: 'smr-edtb__name',
      title: 'גרירה נעצרת בשולי השקף · Alt = תזוזה חופשית',
    }, key);

    const scVal = el('span', { class: 'smr-edtb__sz' }, '×' + (e.scale || 1).toFixed(2));
    const scRange = el('input', {
      type: 'range', min: '0.4', max: '2.5', step: '0.05', value: String(e.scale || 1),
    });
    scRange.addEventListener('input', () => {
      const cur = elOf(key);
      cur.scale = Number(scRange.value);
      scVal.textContent = '×' + cur.scale.toFixed(2);
      const node = elEl(key);
      if (node) node.style.transform = elTransform(cur.dx || 0, cur.dy || 0, cur.scale);
      if (sel) placeBox(selBox, geomOf(sel));
      commit({ defer: 150 });
    });
    scRange.addEventListener('change', () => commit());

    const dupB = isLockup
      ? el('button', {
          class: 'btn btn--ghost is-off', type: 'button', 'aria-disabled': 'true',
          title: 'אין עדיין קובץ לוגו רשמי',
          onclick: () => toast('אין עדיין קובץ לוגו רשמי — חתימת המותג נשארת חלק מהתבנית', 'err'),
        }, 'שכפול')
      : el('button', {
          class: 'btn btn--ghost', type: 'button',
          title: 'שכפול כנכס מותג חופשי — אפשר לגרור, לסובב ולמחוק',
          onclick: () => duplicateEl(key),
        }, 'שכפול');

    const resetB = el('button', { class: 'btn btn--ghost', type: 'button', title: 'ביטול ההתאמות של האלמנט הזה' }, 'איפוס');
    resetB.addEventListener('click', () => {
      if (design.els) delete design.els[key];
      commit();
      renderToolbar();
    });

    const delB = el('button', {
      class: 'btn btn--ghost smr-edtb__del', type: 'button',
      title: 'הסתרת האלמנט מהשקף — משחזרים מלוח השכבות',
    }, 'מחיקה');
    delB.addEventListener('click', () => hideKey(elHiddenKey(key)));

    toolbar.replaceChildren(...[
      el('div', { class: 'smr-edtb__row' },
        name, el('span', null, elLabelOf(key)), dupB, resetB, delB),
      el('div', { class: 'smr-edtb__row' },
        el('span', null, 'גודל'), scRange, scVal),
      isRule
        ? swatchRow(e.color || null, (color) => {
            const cur = elOf(key);
            if (color) cur.color = color; else delete cur.color;
            commit();
            renderToolbar();
          })
        : null,
      dragHint(),
    ].filter(Boolean));
  }

  function renderExtraToolbar(i) {
    const ex = design.extras[i];
    if (!ex) { toolbar.hidden = true; return; }

    const fwd = el('button', { class: 'btn btn--ghost', type: 'button', disabled: i >= design.extras.length - 1, title: 'שכבה אחת קדימה' }, 'קדימה ▲');
    fwd.addEventListener('click', () => {
      const a = design.extras;
      [a[i], a[i + 1]] = [a[i + 1], a[i]];
      sel = { kind: 'extra', index: i + 1 };
      commit();
      renderToolbar();
    });
    const back = el('button', { class: 'btn btn--ghost', type: 'button', disabled: i <= 0, title: 'שכבה אחת אחורה' }, 'אחורה ▼');
    back.addEventListener('click', () => {
      const a = design.extras;
      [a[i], a[i - 1]] = [a[i - 1], a[i]];
      sel = { kind: 'extra', index: i - 1 };
      commit();
      renderToolbar();
    });

    const delB = el('button', { class: 'btn btn--ghost smr-edtb__del', type: 'button' }, 'מחיקה');
    delB.addEventListener('click', () => {
      design.extras.splice(i, 1);
      deselect();
      commit();
    });

    // ✂️ explicit crop toggle for photo extras (PLAN v1.2): with it ON, drag
    // pans `pos` inside the frame and wheel/slider zooms; OFF, drag moves the
    // frame itself — the two gestures stay unambiguous.
    let cropB = null;
    if (ex.type === 'photo') {
      cropB = el('button', {
        class: 'smr-edtg smr-edtg--w' + (extraCropOn ? ' on' : ''), type: 'button',
        title: extraCropOn ? 'יציאה ממצב חיתוך — גרירה תזיז את המסגרת'
          : 'מצב חיתוך — גרירה תזיז את התמונה בתוך המסגרת',
      }, '✂️ חיתוך');
      cropB.addEventListener('click', () => {
        extraCropOn = !extraCropOn;
        if (extraCropOn) natSize(ex.url);
        renderToolbar();
        refreshUI(); // thirds grid appears/disappears with the mode
      });
    }

    toolbar.replaceChildren(...[
      el('div', { class: 'smr-edtb__row' },
        el('span', { class: 'smr-edtb__name' }, ex.type === 'photo' ? 'photo' : ex.name),
        ex.type === 'brand' ? el('span', null, brandLabel(ex.name)) : null,
        cropB, fwd, back, delB,
      ),
      // brand marks color like ills (currentColor); they never crop/border
      ex.type === 'ill' || ex.type === 'brand'
        ? swatchRow(ex.color || null, (color) => {
            if (color) ex.color = color; else delete ex.color;
            commit();
            renderToolbar();
          })
        : null,
      ex.type === 'photo' && extraCropOn
        ? zoomRow(() => design.extras[i], { kind: 'extra', index: i })
        : null,
      ex.type === 'photo' && extraCropOn
        ? borderRow(ex.border, (v) => {
            const cur = design.extras[i];
            if (!cur) return;
            if (v === 'paper') delete cur.border; else cur.border = v;
            commit();
            renderToolbar();
          })
        : null,
      ex.type === 'photo' && extraCropOn
        ? el('div', { class: 'smr-edtb__row', style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' } },
            'גוררים את התמונה בתוך המסגרת · גלגלת = זום')
        // out of crop mode the drag moves the FRAME — so the edge rule applies
        : dragHint(),
    ].filter(Boolean));
  }

  // ---------------- add flows ----------------

  // Every modal the editor opens goes through here: the floating toolbar and
  // side panels are position:fixed ABOVE the shared modal overlay (z 1200/
  // 1150 vs .modal-overlay's z 100 — shell-owned CSS), so an open toolbar
  // can sit on top of a picker and swallow its clicks (bug found when the
  // host layout shifted: the block toolbar covered the illustration grid).
  // Hide them for the modal's lifetime; ui.js modal() has no close hook, so
  // restoration watches for the modal root leaving the DOM (covers ✕,
  // backdrop, Esc and action-button closes alike).
  function edModal(title, body, opts) {
    const prev = { tb: toolbar.hidden, bg: bgPanel.hidden, ly: layersPanel.hidden };
    toolbar.hidden = true;
    bgPanel.hidden = true;
    layersPanel.hidden = true;
    const m = modal(title, body, opts);
    const watch = () => {
      if (destroyed) return;
      if (document.body.contains(m.root)) { requestAnimationFrame(watch); return; }
      if (!prev.tb && sel) renderToolbar();
      if (!prev.bg) { bgPanel.hidden = false; renderBgPanel(); placePanel(bgPanel); }
      if (!prev.ly) { layersPanel.hidden = false; renderLayersPanel(); placePanel(layersPanel); }
    };
    requestAnimationFrame(watch);
    return m;
  }

  function pickIll() {
    if (!illNames.length) return;
    let m = null;
    const grid = el('div', { class: 'smr-edpick' });
    const draw = (q) => {
      const names = q ? illNames.filter((n) => n.includes(q)) : illNames;
      grid.replaceChildren(...(names.length
        ? names.map((n) => el('button', {
            type: 'button', title: n,
            onclick: () => {
              if (m) m.close();
              design.extras.push({ type: 'ill', name: n, x: 36, y: 34, w: 28 });
              commit();
              select({ kind: 'extra', index: design.extras.length - 1 });
            },
          },
            el('img', { src: assetUrl('studio/illustrations/' + n + '.svg'), alt: n, loading: 'lazy' }),
            el('span', { class: 'nm' }, n),
          ))
        : [el('p', { class: 'pv-note' }, 'אין איור שמתאים לחיפוש הזה.')]));
    };
    const search = el('input', {
      class: 'field__input', type: 'search',
      placeholder: 'חיפוש בין ' + illNames.length + ' איורים (באנגלית, למשל bridge)',
      oninput: () => draw(search.value.trim().toLowerCase()),
    });
    draw('');
    m = edModal('איזה איור מוסיפים?', el('div', null, search, el('div', { style: { height: '10px' } }), grid));
    setTimeout(() => search.focus(), 60);
  }

  // o.onPick(url) redirects the choice (slot filling); default adds a free
  // photo extra mid-slide. o.title labels the modal for the flow it serves.
  function pickPhoto(o = {}) {
    const onPick = typeof o.onPick === 'function'
      ? o.onPick : (url) => addPhotoExtra(url, 50, 52);
    if (!photos.length) {
      edModal(o.title || 'הוספת תמונה', el('div', { class: 'pv-note' }, photosEmptyText));
      return;
    }
    let m = null;
    const grid = el('div', { class: 'smr-edpick smr-edpick--ph' },
      photos.map((p) => {
        const card = el('button', {
          type: 'button', title: p.note || '', draggable: 'true',
          onclick: () => {
            if (m) m.close();
            onPick(p.url);
          },
        },
          el('img', { src: p.url, alt: p.note || 'תמונה', loading: 'lazy' }),
          p.note ? el('span', { class: 'nm' }, p.note) : null,
        );
        // draggable straight onto the slide: hide the modal a tick after
        // dragstart (removing/hiding the source synchronously aborts the drag)
        card.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData(PHOTO_DRAG_MIME, p.url);
          e.dataTransfer.effectAllowed = 'copy';
          setTimeout(() => { if (m) m.root.style.display = 'none'; }, 0);
        });
        card.addEventListener('dragend', () => { if (m) m.close(); });
        return card;
      }),
    );
    m = edModal(o.title || 'איזו תמונה מוסיפים? (אפשר גם לגרור ישירות אל השקף)', grid);
  }

  // «נכסי מותג» picker (v1.6): the 13 brand marks as inline-SVG previews
  // (currentColor renders in the accent ink) with their Hebrew labels; a pick
  // places a front-band brand extra (default w 30) and selects it so the full
  // extra toolbar (drag/resize/rotate/front-back/delete + swatches) is live.
  function pickBrand() {
    let m = null;
    const grid = el('div', { class: 'smr-edpick smr-edpick--br' },
      brandAssets.map(({ name, label }) => {
        const holder = el('span', { class: 'bsvg' });
        brandSvgText(name).then((svg) => {
          if (svg && !destroyed) holder.innerHTML = svg;
        });
        return el('button', {
          type: 'button', title: name,
          onclick: () => {
            if (m) m.close();
            design.extras.push({ type: 'brand', name, x: 35, y: 40, w: 30 });
            commit();
            select({ kind: 'extra', index: design.extras.length - 1 });
          },
        }, holder, el('span', { class: 'nm' }, label));
      }));
    m = edModal('איזה נכס מותג מוסיפים?', grid);
  }

  // ---------------- slot filling & crop (design.slots v1.2) ----------------

  // Fill (or replace) a template photo slot. A fresh photo starts uncropped;
  // the border choice is a property of the FRAME, so it survives replacement.
  function fillSlot(n, url) {
    if (!design.slots || typeof design.slots !== 'object') design.slots = {};
    const prev = design.slots[String(n)];
    const spec = { url };
    if (prev && (prev.border === 'line' || prev.border === 'none')) spec.border = prev.border;
    design.slots[String(n)] = spec;
    natSize(url); // preload natural size for the pan math
    commit();
    select({ kind: 'slot', n });
  }

  // File dropped straight onto a slot: upload through the host, then fill.
  async function fillSlotFile(n, file) {
    if (typeof opts.uploadFile !== 'function') {
      toast('העלאת תמונות לא מחוברת בעמוד הזה', 'err');
      return;
    }
    busyEl.hidden = false;
    try {
      const res = await opts.uploadFile(file);
      if (res && res.url) fillSlot(n, res.url);
    } catch (err) {
      toast('ההעלאה נכשלה: ' + (err && err.message || err), 'err');
    } finally {
      busyEl.hidden = true;
    }
  }

  // Pan/zoom a crop target LIVE (no re-compose): style the engine's <img>
  // exactly the way designCropStyle will on the next commit — object-position
  // (cover slots) + scale around the same focal point.
  function liveCrop(t, obj) {
    if (!t || !obj) return;
    const pos = Array.isArray(obj.pos) ? obj.pos : [50, 50];
    const px = clamp(Number(pos[0]) || 0, 0, 100);
    const py = clamp(Number(pos[1]) || 0, 0, 100);
    const z = clamp(Number(obj.zoom) || 1, 1, 3);
    let img = null;
    if (t.kind === 'slot') {
      img = slotImgEl(t.n);
      if (img) img.style.objectPosition = px + '% ' + py + '%';
    } else {
      const n = extraEl(t.index);
      img = n && n.querySelector('img');
    }
    if (!img) return;
    if (z > 1) {
      img.style.transform = 'scale(' + z + ')';
      img.style.transformOrigin = px + '% ' + py + '%';
    } else {
      img.style.transform = '';
      img.style.transformOrigin = px + '% ' + py + '%';
    }
    const g = geomOf(t);
    if (g) placeBox(gridBox, g);
  }

  // How many doc-units of image hang outside the frame on each axis — the
  // denominator that maps a pan drag to object-position %. Cover slots
  // overflow from the cover fit itself (needs the natural size) plus zoom;
  // photo extras (natural aspect) overflow from zoom alone.
  function cropOverflow(t) {
    const g = geomOf(t);
    if (!g) return null;
    const obj = t.kind === 'slot' ? slotSpec(t.n) : design.extras[t.index];
    if (!obj) return null;
    const z = clamp(Number(obj.zoom) || 1, 1, 3);
    if (t.kind === 'slot') {
      const nat = natSize(obj.url);
      let bx = 0, by = 0;
      if (nat) {
        const s0 = Math.max(g.w / nat.w, g.h / nat.h);
        bx = Math.max(0, nat.w * s0 - g.w);
        by = Math.max(0, nat.h * s0 - g.h);
      } else {
        // natural size still loading — a workable sensitivity so the first
        // drag never feels dead; the real ratio takes over next gesture
        bx = g.w * 0.35; by = g.h * 0.35;
      }
      return { x: z * bx + (z - 1) * g.w, y: z * by + (z - 1) * g.h };
    }
    return { x: (z - 1) * g.w, y: (z - 1) * g.h };
  }

  // ---------------- reset dialog (PLAN «Reset», v1.2) ----------------
  // One dialog, one choice: this slide only / the whole carousel. Clears the
  // WORKING design (and, via the host's onReset, uncommitted in-place text)
  // for the chosen scope. Proposals already in sm_edits are never touched.
  function resetDialog() {
    let scope = 'slide';
    const mkChoice = (val, lab) => {
      const r = el('input', { type: 'radio', name: 'smr-reset-scope', value: val });
      if (val === scope) r.checked = true;
      r.addEventListener('change', () => { if (r.checked) scope = val; });
      return el('label', {
        style: { display: 'flex', gap: '8px', alignItems: 'center', cursor: 'pointer' },
      }, r, lab);
    };
    edModal('איפוס עיצוב', el('div', { style: { display: 'grid', gap: '10px' } },
      el('div', null, 'מה מאפסים? הפעולה מנקה את שינויי העיצוב ואת עריכות הטקסט שעוד לא נשלחו.'),
      mkChoice('slide', 'רק את השקף הזה'),
      mkChoice('deck', 'את כל הקרוסלה'),
      el('div', { class: 'pv-note', style: { fontSize: '.8rem' } }, 'הצעות שכבר נשלחו לא יימחקו.'),
    ), {
      actions: [
        { label: 'איפוס', primary: true, onClick: () => doReset(scope) },
        { label: 'ביטול' },
      ],
    });
  }

  function doReset(scope) {
    if (editing) cancelTextEdit();
    deselect();
    design = normalizeDesign(null);
    commit();
    if (typeof opts.onReset === 'function') opts.onReset(scope);
  }

  // Add a photo extra centered on a slide point (%, defaults to mid-slide),
  // select it so handles + toolbar appear immediately. Also used by host
  // pages for drops that land outside the armed overlay.
  function addPhotoExtra(url, xPct, yPct) {
    const w = 40;
    const ex = {
      type: 'photo', url,
      x: round1(clamp((typeof xPct === 'number' ? xPct : 50) - w / 2, -15, 95)),
      y: round1(clamp((typeof yPct === 'number' ? yPct : 52) - w / 2, -15, 95)),
      w, shape: 'organic',
    };
    design.extras.push(ex);
    if (!photos.some((p) => p.url === url)) photos.push({ url, note: '' });
    commit();
    select({ kind: 'extra', index: design.extras.length - 1 });
    return ex;
  }

  // ---------------- drag & drop onto the slide ----------------

  function dtAccepts(dt) {
    if (!dt) return false;
    const types = Array.from(dt.types || []);
    return types.includes(PHOTO_DRAG_MIME) || types.includes('Files');
  }

  // Files dropped on the slide: host wires the actual upload (opts.uploadFile
  // -> {url}); the editor owns placement, cascade, busy state and selection.
  async function dropFiles(files, xPct, yPct) {
    const imgs = files.filter((f) => /^image\//.test(f.type || ''));
    if (!imgs.length) {
      toast('אפשר לגרור לכאן רק קובצי תמונה', 'err');
      return;
    }
    if (imgs.length < files.length) toast('קבצים שאינם תמונה דולגו');
    if (typeof opts.uploadFile !== 'function') {
      toast('העלאת תמונות לא מחוברת בעמוד הזה', 'err');
      return;
    }
    busyEl.hidden = false;
    let placed = 0;
    try {
      for (const f of imgs) {
        try {
          const res = await opts.uploadFile(f);
          if (res && res.url) {
            // cascade: each additional file lands +4% toward bottom-left
            addPhotoExtra(res.url, xPct + 4 * placed, yPct + 4 * placed);
            placed++;
          }
        } catch (err) {
          toast('ההעלאה של ' + (f.name || 'התמונה') + ' נכשלה: ' + (err && err.message || err), 'err');
        }
      }
    } finally {
      busyEl.hidden = true;
    }
  }

  // slot-aware targeting while a photo drag hovers the slide: slots win
  // hit-testing over free-extra placement (PLAN «design.slots (v1.2)»)
  function markDropTarget(sn) {
    for (const b of slotHints.querySelectorAll('.smr-edslot')) {
      b.classList.toggle('is-target', sn != null && b.getAttribute('data-slot-hint') === String(sn));
    }
  }

  let dragDepth = 0;
  function onDragEnter(e) {
    if (!dtAccepts(e.dataTransfer)) return;
    e.preventDefault();
    dragDepth++;
    dropHint.hidden = false;
  }
  function onDragOver(e) {
    if (!dtAccepts(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const sn = slotAt(docPoint(e));
    markDropTarget(sn);
    // over a slot the highlight speaks — the free-drop banner would cover it
    dropHint.hidden = sn != null;
  }
  function onDragLeave() {
    if (--dragDepth <= 0) { dragDepth = 0; dropHint.hidden = true; markDropTarget(null); }
  }
  function onDropEv(e) {
    if (!dtAccepts(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation(); // the host page's fallback drop target must not double-handle
    dragDepth = 0;
    dropHint.hidden = true;
    markDropTarget(null);
    const p = docPoint(e);
    const xPct = p.x / W * 100, yPct = p.y / H * 100;
    const url = e.dataTransfer.getData(PHOTO_DRAG_MIME);
    const files = [...(e.dataTransfer.files || [])];
    const sn = slotAt(p);
    if (sn != null && !isHiddenKey(slotKeyOf(sn))) {
      // drop lands INSIDE a photo slot — fill/replace it, never a free extra
      if (url) { fillSlot(sn, url); return; }
      const imgs = files.filter((f) => /^image\//.test(f.type || ''));
      if (imgs.length) {
        fillSlotFile(sn, imgs[0]);
        // additional files still cascade as free extras beside the slot
        if (imgs.length > 1) dropFiles(imgs.slice(1), xPct, yPct);
        return;
      }
    }
    if (url) { addPhotoExtra(url, xPct, yPct); return; }
    dropFiles(files, xPct, yPct);
  }

  // ---------------- in-place text editing ----------------
  //
  // The composed span IS the template DOM, so while a block is contentEditable
  // the text reflows with the template's own CSS — no re-compose until commit.
  // contentEditable + focus + parent-attached listeners all work inside the
  // sandbox="allow-same-origin" iframe (probed headless before building).
  // Bidi: dir attributes are never touched — the template handles RTL/Latin.

  // Reduce edited innerHTML to the template vocabulary: text, <b>, <br>.
  // <div>/<p> boundaries (paste artifacts) become <br>; everything else is
  // unwrapped; styles/classes are dropped with their tags.
  function sanitizeRich(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      } else if (child.nodeType === 1) {
        const tag = child.tagName;
        if (tag === 'BR') out += '<br>';
        else if (tag === 'B' || tag === 'STRONG') out += '<b>' + sanitizeRich(child) + '</b>';
        else if (tag === 'DIV' || tag === 'P') out += (out ? '<br>' : '') + sanitizeRich(child);
        else out += sanitizeRich(child);
      }
    }
    return out;
  }
  const trimRich = (s) => s.replace(/^(?:\s|<br>)+/, '').replace(/(?:\s|<br>)+$/, '')
    .replace(/&nbsp;/g, ' ');

  function insertBrAtCaret(idoc) {
    try {
      const s = idoc.getSelection();
      if (!s.rangeCount) return;
      const range = s.getRangeAt(0);
      range.deleteContents();
      const br = idoc.createElement('br');
      range.insertNode(br);
      range.setStartAfter(br);
      range.collapse(true);
      s.removeAllRanges();
      s.addRange(range);
    } catch { /* caret stays */ }
  }

  function placeEditBar() {
    if (!editing) return;
    const g = geomOf({ kind: 'block', name: editing.name });
    if (!g) return;
    const s = scale(), ir = irect();
    const bw = editBar.offsetWidth || 150, bh = editBar.offsetHeight || 40;
    let top = ir.top + (g.cy - g.h / 2) * s - bh - 10;
    if (top < 8) top = ir.top + (g.cy + g.h / 2) * s + 10;
    editBar.style.top = clamp(top, 8, Math.max(8, window.innerHeight - bh - 8)) + 'px';
    editBar.style.left = clamp(ir.left + g.cx * s - bw / 2, 8, Math.max(8, window.innerWidth - bw - 8)) + 'px';
  }

  function startTextEdit(name, ev) {
    if (editing) commitTextEdit();
    const node = blockEl(name);
    const idoc = doc();
    if (!node || !idoc) { toast('אי אפשר לערוך את הטקסט הזה כאן', 'err'); return; }
    deselect();
    toolbar.hidden = true;
    const origVal = String(slide.vars[name] ?? '');
    // multiline heuristic (matches the builder's field-kind inference):
    // Enter = <br> in long/broken text, Enter = commit in one-liners
    const multiline = /<br/i.test(origVal) || origVal.length > 60;
    const ed = {
      name, node,
      origHTML: node.innerHTML,
      origStyle: node.getAttribute('style'),
      multiline,
      onKeyDown(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelTextEdit(); }
        else if (e.key === 'Enter') {
          e.preventDefault();
          if (multiline) { insertBrAtCaret(idoc); placeEditBar(); }
          else commitTextEdit();
        }
      },
      onBlur() { commitTextEdit(); },
      onInput() { placeEditBar(); },
    };
    node.contentEditable = 'true';
    node.style.outline = '2px dashed rgba(131,0,81,.45)';
    node.style.outlineOffset = '4px';
    node.style.cursor = 'text';
    node.style.minWidth = '30px'; // a fully-emptied block stays reachable
    node.addEventListener('keydown', ed.onKeyDown);
    node.addEventListener('blur', ed.onBlur);
    node.addEventListener('input', ed.onInput);
    // the overlay must stop swallowing the mouse — text selection happens
    // inside the iframe now; the floating ✓/✗ keep their own pointer events
    overlay.style.pointerEvents = 'none';
    editing = ed;
    editBar.hidden = false;
    placeEditBar();
    node.focus();
    try { // caret at the click point (double-click path), else at the end
      const s = idoc.getSelection();
      let range = null;
      if (ev && idoc.caretRangeFromPoint) {
        const p = docPoint(ev);
        range = idoc.caretRangeFromPoint(p.x, p.y);
      }
      if (!range || !node.contains(range.startContainer)) {
        range = idoc.createRange();
        range.selectNodeContents(node);
        range.collapse(false);
      }
      s.removeAllRanges();
      s.addRange(range);
    } catch { /* default caret */ }
  }

  function teardownTextEdit() {
    const ed = editing;
    editing = null;
    editBar.hidden = true;
    overlay.style.pointerEvents = '';
    ed.node.removeEventListener('keydown', ed.onKeyDown);
    ed.node.removeEventListener('blur', ed.onBlur);
    ed.node.removeEventListener('input', ed.onInput);
    ed.node.removeAttribute('contenteditable');
    if (ed.origStyle == null) ed.node.removeAttribute('style');
    else ed.node.setAttribute('style', ed.origStyle);
    return ed;
  }

  function cancelTextEdit() {
    if (!editing) return;
    const ed = teardownTextEdit();
    ed.node.innerHTML = ed.origHTML;               // Esc/✗ reverts
    if (pendingApply) { pendingApply = false; applyNow(); }
    select({ kind: 'block', name: ed.name });
  }

  function commitTextEdit() {
    if (!editing) return;
    const ed = teardownTextEdit();
    const newVal = trimRich(sanitizeRich(ed.node));
    // unchanged? compare sanitized-old vs sanitized-new (entity-encoding safe)
    const tmp = document.createElement('div');
    tmp.innerHTML = ed.origHTML;
    if (newVal === trimRich(sanitizeRich(tmp))) {
      ed.node.innerHTML = ed.origHTML;
      if (pendingApply) { pendingApply = false; applyNow(); }
      select({ kind: 'block', name: ed.name });
      return;
    }
    slide.vars[ed.name] = newVal;                  // the working slide's var
    pendingApply = false;
    if (typeof opts.onTextChange === 'function') opts.onTextChange(ed.name, newVal);
    applyNow();                                    // ONE re-compose, post-commit
    select({ kind: 'block', name: ed.name });
  }

  // ---------------- background panel (design.bg) ----------------

  const FIELD_LABELS = { deep: 'כהה', paper: 'בהיר', warm: 'חמים' };
  const FIELD_PREVIEW = {
    deep: 'linear-gradient(150deg,#5b0038,#830051)',
    paper: '#fffdf9',
    warm: '#f7f2ec',
  };

  function paletteCss(name) {
    const p = palette.find((x) => x.name === name);
    return p ? p.css : null;
  }

  function currentField() {
    if (design.bg && BG_FIELDS.includes(design.bg.field)) return design.bg.field;
    const d = doc();
    const root = d && d.querySelector('.slide');
    const m = root && /slide--(deep|paper|warm)/.exec(root.className || '');
    return m ? m[1] : 'paper';
  }

  function hexLum(css) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(css || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  }

  // light-on-light / dark-on-dark heuristic: deep field = light text, so a
  // light flat color clashes; paper/warm = dark text, so a dark color clashes
  function bgClash() {
    const bg = design.bg || {};
    if (!bg.color || bg.photo) return false;
    const lum = hexLum(paletteCss(bg.color));
    if (lum == null) return false;
    return currentField() === 'deep' ? lum > 0.55 : lum < 0.4;
  }

  function mutateBg(fn) {
    if (!design.bg || typeof design.bg !== 'object') design.bg = {};
    fn(design.bg);
    commit();
    renderBgPanel();
    renderLayersPanel();
  }

  function togglePanel(which) {
    const p = which === 'bg' ? bgPanel : layersPanel;
    const other = which === 'bg' ? layersPanel : bgPanel;
    if (p.hidden) {
      other.hidden = true;              // one panel open at a time
      p.hidden = false;
      if (which === 'bg') renderBgPanel(); else renderLayersPanel();
      placePanel(p);
    } else {
      p.hidden = true;
    }
  }

  function placePanel(p) {
    if (!p || p.hidden) return;
    const ir = irect();
    const pw = p.offsetWidth || 264;
    let left = ir.left - pw - 14;                  // beside the slide…
    if (left < 8) left = Math.min(ir.right + 14, window.innerWidth - pw - 8);
    p.style.left = Math.max(8, left) + 'px';
    p.style.top = clamp(ir.top, 8, Math.max(8, window.innerHeight - (p.offsetHeight || 320) - 8)) + 'px';
  }

  function renderBgPanel() {
    if (bgPanel.hidden) return;
    const bg = design.bg || {};
    const kids = [];

    kids.push(el('h5', null, 'רקע השקף',
      el('button', { class: 'smr-edpanel__x', type: 'button', title: 'סגירה', onclick: () => { bgPanel.hidden = true; } }, '✕')));

    // --- brand fields (recommended) ---
    kids.push(el('h5', null, 'שדות המותג', el('span', { class: 'rec' }, 'מומלץ')));
    kids.push(el('div', { class: 'smr-edbgf' },
      BG_FIELDS.map((f) => el('button', {
        type: 'button',
        class: bg.field === f && !bg.color && !bg.photo ? 'on' : '',
        style: { background: FIELD_PREVIEW[f], color: f === 'deep' ? '#fff' : 'inherit' },
        title: 'החלפת שדה הרקע — הטקסט מתאים את עצמו אוטומטית',
        onclick: () => mutateBg((b) => {
          b.field = f;
          delete b.color; delete b.photo; delete b.pos; delete b.overlay;
        }),
      }, FIELD_LABELS[f]))));

    // --- flat color ---
    kids.push(el('h5', null, 'צבע אחיד'));
    kids.push(swatchRow(bg.color || null, (color) => mutateBg((b) => {
      if (color) { b.color = color; delete b.photo; delete b.pos; delete b.overlay; }
      else delete b.color;
    })));
    if (bgClash()) {
      kids.push(el('div', { class: 'smr-edwarn' }, '⚠ כדאי לבדוק את קריאות הטקסט על הצבע הזה'));
    }

    // --- background photo ---
    kids.push(el('h5', null, 'תמונת רקע'));
    if (bg.photo) {
      // focal-point control: drag the dot over a mini preview -> bg.pos
      const pos = Array.isArray(bg.pos) ? bg.pos : [50, 50];
      const dot = el('div', { class: 'smr-edfoc__dot', style: { left: pos[0] + '%', top: pos[1] + '%' } });
      const foc = el('div', {
        class: 'smr-edfoc', title: 'גוררים את הנקודה למוקד התמונה',
        style: { backgroundImage: `url("${bg.photo}")`, backgroundPosition: `${pos[0]}% ${pos[1]}%` },
      }, dot);
      let focDrag = false;
      const setFoc = (e) => {
        const r = foc.getBoundingClientRect();
        const x = round1(clamp((e.clientX - r.left) / r.width * 100, 0, 100));
        const y = round1(clamp((e.clientY - r.top) / r.height * 100, 0, 100));
        dot.style.left = x + '%'; dot.style.top = y + '%';
        foc.style.backgroundPosition = `${x}% ${y}%`;
        if (design.bg) design.bg.pos = [x, y];
      };
      foc.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        focDrag = true;
        try { foc.setPointerCapture(e.pointerId); } catch { /* ok */ }
        setFoc(e);
      });
      foc.addEventListener('pointermove', (e) => { if (focDrag) setFoc(e); });
      foc.addEventListener('pointerup', () => { if (focDrag) { focDrag = false; commit(); } });
      kids.push(foc);

      // scrim (overlay) for legibility
      kids.push(el('h5', null, 'כיסוי לקריאות'));
      const ovl = bg.overlay || null;
      kids.push(swatchRow(ovl ? ovl.color : null, (color) => mutateBg((b) => {
        if (color) b.overlay = { color, opacity: (b.overlay && b.overlay.opacity) || 0.35 };
        else delete b.overlay;
      })));
      if (ovl) {
        const opVal = el('span', { class: 'smr-edtb__sz' }, Math.round((ovl.opacity || 0.35) * 100) + '%');
        const opRange = el('input', { type: 'range', min: '0', max: '0.8', step: '0.05', value: String(ovl.opacity ?? 0.35) });
        opRange.addEventListener('input', () => {
          if (design.bg && design.bg.overlay) design.bg.overlay.opacity = Number(opRange.value);
          opVal.textContent = Math.round(Number(opRange.value) * 100) + '%';
          commit({ defer: 150 });
        });
        opRange.addEventListener('change', () => commit());
        kids.push(el('div', { class: 'smr-edtb__row' }, el('span', null, 'עוצמה'), opRange, opVal));
      }
      kids.push(el('button', {
        class: 'btn btn--ghost smr-edtb__del', type: 'button',
        onclick: () => mutateBg((b) => { delete b.photo; delete b.pos; delete b.overlay; }),
      }, 'הסר את תמונת הרקע'));
    } else {
      if (photos.length) {
        kids.push(el('div', { class: 'smr-edbgph' },
          photos.map((p) => el('button', {
            type: 'button', title: p.note || 'לקבוע כתמונת רקע',
            onclick: () => mutateBg((b) => {
              b.photo = p.url;
              b.pos = [50, 50];
              delete b.color;
              // default scrim when the field's text is light (deep field)
              if (currentField() === 'deep') b.overlay = { color: 'red-100', opacity: 0.35 };
            }),
          }, el('img', { src: p.url, alt: '', loading: 'lazy' })))));
      } else {
        kids.push(el('div', { class: 'pv-note' }, photosEmptyText));
      }
      if (typeof opts.uploadFile === 'function') {
        const fileIn = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
        fileIn.addEventListener('change', async () => {
          const f = fileIn.files && fileIn.files[0];
          if (!f) return;
          busyEl.hidden = false;
          try {
            const res = await opts.uploadFile(f);
            if (res && res.url) {
              if (!photos.some((p) => p.url === res.url)) photos.push({ url: res.url, note: '' });
              mutateBg((b) => {
                b.photo = res.url; b.pos = [50, 50]; delete b.color;
                if (currentField() === 'deep') b.overlay = { color: 'red-100', opacity: 0.35 };
              });
            }
          } catch (err) {
            toast('ההעלאה נכשלה: ' + (err && err.message || err), 'err');
          } finally { busyEl.hidden = true; }
        });
        kids.push(el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => fileIn.click() },
          'העלאת קובץ…'), fileIn);
      }
    }

    if (design.bg && Object.keys(design.bg).length) {
      kids.push(el('button', {
        class: 'btn btn--ghost smr-edtb__del', type: 'button',
        onclick: () => { delete design.bg; commit(); renderBgPanel(); renderLayersPanel(); },
      }, 'הסרת הרקע (חזרה לתבנית)'));
    }

    bgPanel.replaceChildren(...kids);
    requestAnimationFrame(() => placePanel(bgPanel));
  }

  // ---------------- layers panel ----------------
  //
  // Narrow, calm list, front-most first: front extras · template blocks
  // (fixed band) · back extras · background. Extras drag-reorder within their
  // band and can hop bands via the front/back toggle ("back": true). The
  // extras array is kept canonical: [backs…, fronts…], order within band =
  // stacking order.

  let lyrDrag = null; // {ex} while a layer row drags

  function bandLists() {
    const backs = design.extras.filter((e) => e.back === true);
    const fronts = design.extras.filter((e) => e.back !== true);
    return { backs, fronts };
  }

  function rebuildExtras(backs, fronts, keepEx) {
    design.extras = [...backs, ...fronts];
    const idx = keepEx ? design.extras.indexOf(keepEx) : -1;
    commit(); // prune() replaces the objects, so resolve the index FIRST
    if (idx >= 0) select({ kind: 'extra', index: idx });
    else if (sel && sel.kind === 'extra') deselect();
    renderLayersPanel();
  }

  function extraLabel(ex) {
    return ex.type === 'ill' ? ex.name
      : ex.type === 'brand' ? brandLabel(ex.name) : 'תמונה';
  }

  function layerRow(ex, band) {
    const i = design.extras.indexOf(ex);
    const isSel = sel && sel.kind === 'extra' && sel.index === i;
    const thumb = ex.type === 'ill'
      ? el('img', { class: 'is-vec', src: assetUrl('studio/illustrations/' + ex.name + '.svg'), alt: '' })
      : ex.type === 'brand'
        ? el('img', { class: 'is-vec', src: assetUrl('studio/brand-assets/' + ex.name + '.svg'), alt: '' })
        : el('img', { src: ex.url, alt: '' });
    const flip = el('button', {
      class: 'mini', type: 'button',
      title: ex.back ? 'החזרה לקדמת השקף' : 'העברה מאחורי הטקסט',
    }, ex.back ? '⬆' : '⬇');
    flip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (ex.back) delete ex.back; else ex.back = true;
      const { backs, fronts } = bandLists();
      rebuildExtras(backs, fronts, ex);
    });
    const del = el('button', { class: 'mini', type: 'button', title: 'מחיקת השכבה' }, '✕');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const at = design.extras.indexOf(ex);
      if (at >= 0) design.extras.splice(at, 1);
      if (sel && sel.kind === 'extra') deselect();
      commit();
      renderLayersPanel();
    });
    const row = el('div', {
      class: 'smr-edlyr__row' + (isSel ? ' on' : ''),
      draggable: 'true',
      onclick: () => select({ kind: 'extra', index: design.extras.indexOf(ex) }),
    },
      el('span', { class: 'smr-edlyr__grip', title: 'גוררים לשינוי הסדר' }, '⋮⋮'),
      thumb,
      el('span', { class: 'smr-edlyr__nm' }, extraLabel(ex)),
      flip, del,
    );
    row.addEventListener('dragstart', (e) => {
      lyrDrag = { ex, band };
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', 'layer'); } catch { /* ok */ }
    });
    row.addEventListener('dragend', () => { lyrDrag = null; });
    row.addEventListener('dragover', (e) => {
      if (!lyrDrag || lyrDrag.band !== band || lyrDrag.ex === ex) return;
      e.preventDefault();
      row.classList.add('is-dragover');
    });
    row.addEventListener('dragleave', () => row.classList.remove('is-dragover'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('is-dragover');
      if (!lyrDrag || lyrDrag.band !== band || lyrDrag.ex === ex) return;
      e.preventDefault();
      e.stopPropagation();
      const { backs, fronts } = bandLists();
      const list = band === 'back' ? backs : fronts;
      const from = list.indexOf(lyrDrag.ex);
      if (from < 0 || list.indexOf(ex) < 0) return;
      list.splice(from, 1);
      // panel lists front-most first (array end first); dropping A on B puts
      // A just above B in the display = just after B in the array
      list.splice(list.indexOf(ex) + 1, 0, lyrDrag.ex);
      rebuildExtras(backs, fronts, lyrDrag.ex);
    });
    return row;
  }

  function bgRowSummary() {
    const bg = design.bg;
    if (!bg) return 'ברירת המחדל של התבנית';
    if (bg.photo) return 'תמונת רקע' + (bg.overlay ? ' + כיסוי' : '');
    if (bg.color) return 'צבע: ' + bg.color;
    if (bg.field) return 'שדה: ' + (FIELD_LABELS[bg.field] || bg.field);
    return 'ברירת המחדל של התבנית';
  }

  // one template-band row: block (by var name), photo slot ("slot:N") or
  // decorative element ("el:<key>", v1.6). Hidden items stay listed, greyed
  // out, with a «שחזר» restore action — that is the ONLY way back from
  // delete (PLAN «design.hidden (v1.2)»).
  function templateRow(t, label) {
    const key = t.kind === 'block' ? t.name
      : t.kind === 'el' ? elHiddenKey(t.key) : slotKeyOf(t.n);
    const off = isHiddenKey(key);
    const isSel = !off && sameSel(sel, t);
    const row = el('div', {
      class: 'smr-edlyr__row' + (isSel ? ' on' : '') + (off ? ' is-off' : ''),
      title: off ? 'הוסתר מהשקף — «שחזר» מחזיר אותו'
        : 'שכבת תבנית — אפשר לבחור ולעצב, הסדר קבוע',
    },
      el('span', { class: 'smr-edlyr__grip', style: { visibility: 'hidden' } }, '⋮⋮'),
      el('span', { class: 'smr-edlyr__nm' }, label),
      off ? el('button', {
        class: 'mini mini--restore', type: 'button', title: 'החזרת הפריט לשקף',
        onclick: (e) => { e.stopPropagation(); restoreKey(key); },
      }, 'שחזר') : null,
    );
    if (!off) row.addEventListener('click', () => select(t));
    return row;
  }

  function renderLayersPanel() {
    if (layersPanel.hidden) return;
    const { backs, fronts } = bandLists();
    const d = doc();
    const blockNames = [];
    if (d) {
      for (const n of d.querySelectorAll('[data-var]')) {
        const nm = n.getAttribute('data-var');
        if (nm && !blockNames.includes(nm)) blockNames.push(nm);
      }
    }
    const slotNums = slotEls()
      .map((n) => Number(n.getAttribute('data-slot')))
      .sort((a, b) => a - b);
    // decorative els (v1.6) get their own band label — they are template
    // furniture, not text, and the 🔒 says the same thing it says above:
    // selectable and stylable, but the stacking order is the template's.
    const elKeys = elKeysInDoc();
    const kids = [
      el('h5', null, 'שכבות',
        el('button', { class: 'smr-edpanel__x', type: 'button', title: 'סגירה', onclick: () => { layersPanel.hidden = true; } }, '✕')),
      el('div', { class: 'smr-edlyr' },
        el('div', { class: 'smr-edlyr__band' }, 'מעל הטקסט'),
        fronts.length
          ? [...fronts].reverse().map((ex) => layerRow(ex, 'front'))
          : el('div', { class: 'pv-note', style: { fontSize: '.75rem' } }, '—'),
        el('div', { class: 'smr-edlyr__band', title: 'שכבות הטקסט של התבנית — הסדר שלהן קבוע' }, 'טקסט התבנית 🔒'),
        blockNames.map((nm) => templateRow({ kind: 'block', name: nm }, nm)),
        slotNums.map((n) => templateRow({ kind: 'slot', n },
          'משבצת תמונה ' + (n + 1) + (slotSpec(n) ? ' · מלאה' : ''))),
        // decorative els (v1.6): selectable, fixed band, hide/restore like
        // any template item
        elKeys.length
          ? el('div', {
              class: 'smr-edlyr__band',
              title: 'קווים, חתימת המותג ושפות קרועות של התבנית — אפשר להזיז, להגדיל ולהסתיר; הסדר קבוע',
            }, 'עיטורי התבנית 🔒')
          : null,
        elKeys.map((k) => templateRow({ kind: 'el', key: k }, elLabelOf(k))),
        el('div', { class: 'smr-edlyr__band' }, 'מאחורי הטקסט'),
        backs.length
          ? [...backs].reverse().map((ex) => layerRow(ex, 'back'))
          : el('div', { class: 'pv-note', style: { fontSize: '.75rem' } }, '—'),
        el('div', { class: 'smr-edlyr__band' }, 'רקע'),
        el('div', {
          class: 'smr-edlyr__row', title: 'פתיחת עורך הרקע',
          onclick: () => { layersPanel.hidden = true; togglePanel('bg'); },
        },
          el('span', { class: 'smr-edlyr__grip', style: { visibility: 'hidden' } }, '⋮⋮'),
          el('span', { class: 'smr-edlyr__nm' }, bgRowSummary()),
        ),
      ),
    ];
    layersPanel.replaceChildren(...kids);
    requestAnimationFrame(() => placePanel(layersPanel));
  }

  // ---------------- pointer interactions ----------------

  // gesture: {mode:'drag'|'resize'|'rotate', moved, startX, startY, target,
  //           el, baseTf, ...per-mode fields}
  let ges = null;

  function targetEl(t) {
    return t.kind === 'block' ? blockEl(t.name)
      : t.kind === 'el' ? elEl(t.key) : extraEl(t.index);
  }

  // ---- magnetic snapping (drag gestures only) ----
  //
  // How many doc-px the box ACTUALLY moves per design-% (as px) on each axis.
  // TRAP: templates style the extras' generic wrapper classes too — e.g.
  // cover-ill's `.ill{inset-inline:0;margin-inline:auto}` leaves right:0 on
  // the extra, so its auto margins absorb HALF of every inline left change
  // (the box renders at (x+100-w)/2 and tracks at half speed). Assuming
  // left:x% maps 1:1 would draw "aligned" guides on unaligned boxes. So the
  // response is measured: nudge the inline style +5%, read the rect, restore
  // (two reflows, pointerdown only). ~1 on clean templates, 0.5 under the
  // auto-margin collision, ~0 when the template pins the box outright.
  function measureDragResponse(node) {
    const save = { left: node.style.left, top: node.style.top };
    const r0 = node.getBoundingClientRect();
    const bx = parseFloat(save.left) || 0, by = parseFloat(save.top) || 0;
    node.style.left = (bx + 5) + '%';
    node.style.top = (by + 5) + '%';
    const r1 = node.getBoundingClientRect();
    node.style.left = save.left;
    node.style.top = save.top;
    return { ax: (r1.left - r0.left) / (0.05 * W), ay: (r1.top - r0.top) / (0.05 * H) };
  }

  // Same probe for a decorative element (v1.6), through its OWN transform —
  // els never move via left/top (they are in-flow blocks; an offset that
  // reflowed neighbours would wreck the column), so the +5% nudge is written
  // as the engine writes it: translate first, scale after. Normally 1:1, but
  // an ancestor transform (a template that scales a decorative group) would
  // show up here rather than drawing guides on a lying box.
  function measureElResponse(node, cur) {
    const save = node.style.transform;
    const r0 = node.getBoundingClientRect();
    node.style.transform = elTransform((cur.dx || 0) + 5, (cur.dy || 0) + 5, cur.scale);
    const r1 = node.getBoundingClientRect();
    node.style.transform = save;
    return { ax: (r1.left - r0.left) / (0.05 * W), ay: (r1.top - r0.top) / (0.05 * H) };
  }

  // one entry point per gesture: blocks move position:relative left/top px,
  // which is always 1:1 — no probe needed (and no reflow spent on one).
  function measureResponse(t, node) {
    if (!node) return { ax: 1, ay: 1 };
    try {
      if (t.kind === 'extra') return measureDragResponse(node);
      if (t.kind === 'el') return measureElResponse(node, (design.els || {})[t.key] || {});
    } catch { /* fall through to 1:1 */ }
    return { ax: 1, ay: 1 };
  }

  // ---- edge offsets: a drag hard-stops at the slide frame ----
  //
  // Operator directive: "allow for proper offset from the edges for all
  // elements in the frame". A dragged box stops when its edge reaches the
  // slide frame (0..W / 0..H) — nothing walks off the artboard by accident.
  // Alt is the ONE deliberate-bleed modifier (it already turns snapping off),
  // so one held key buys both free movement and a bleed past the edge.
  // Bounds are solved in the gesture's own value space through the SAME
  // measured response the magnets use, at pointerdown. Two honest edge cases:
  //   · a box WIDER than the frame can never sit inside it — the dual rule
  //     applies there (the frame stays covered by the box), same feel;
  //   · a box that ALREADY bleeds when the drag starts is never yanked inward
  //     — its own starting value is folded into the range.
  function clampAxis(base, a, span, c0, size) {
    if (!isFinite(a) || Math.abs(a) < 0.1) return null;
    const solve = (room) => base + room / (a * span) * 100;
    const lead = solve(0 - (c0 - size / 2));            // box edge -> frame start
    const trail = solve(span - (c0 + size / 2));        // box edge -> frame end
    let lo = size <= span ? lead : trail;
    let hi = size <= span ? trail : lead;
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return { lo: Math.min(lo, base), hi: Math.max(hi, base) };
  }

  function buildClampSpec(t, g0, baseDx, baseDy, resp) {
    if (!g0) return { x: null, y: null };
    // the AABB again (found headless: a mark at 38° cleared the frame by 65px
    // while its un-rotated layout box "fit")
    const eb = effSize(g0);
    return {
      x: clampAxis(baseDx, resp.ax, W, g0.cx, eb.w),
      y: clampAxis(baseDy, resp.ay, H, g0.cy, eb.h),
    };
  }

  // Candidates are computed ONCE at pointerdown, in the gesture's own value
  // space (blocks: dx/dy %, extras: x/y %): {v, line} — v is the exact value
  // to commit while engaged (already at round1 storage precision for extras,
  // so live == committed), line the doc-space guide coordinate (null = no
  // guide, e.g. the dx=0 target). Extras: their CENTER snaps to the center
  // lines, their EDGES snap to the margin lines — each candidate solves the
  // design value that puts the MEASURED box dead on the line, through the
  // measured response above. Blocks (position:relative left/top always moves
  // 1:1): the same geometry, plus dx/dy = 0 (the old snap-to-0, absorbed).
  // The box a magnet or an edge stop reasons about: for a rotated extra that
  // is the axis-aligned bounding box (its corners are what reaches the margin
  // and what pokes off the artboard), for everything else the layout box.
  // Snapping and clamping MUST agree on this — if the magnet aimed at the
  // layout edge while the stop held the AABB, the margin line nearest a frame
  // edge could never be reached.
  function effSize(g) {
    const rad = (g.rot || 0) * Math.PI / 180;
    if (!rad) return { w: g.w, h: g.h };
    const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    return { w: g.w * c + g.h * s, h: g.w * s + g.h * c };
  }

  function buildSnapSpec(t, g0, baseDx, baseDy, resp) {
    const x = [], y = [];
    // blocks keep dx/dy = 0 as a target of its own (the old snap-to-0)
    if (t.kind === 'block') {
      x.push({ v: 0, line: null });
      y.push({ v: 0, line: null });
    }
    if (!g0) return { x, y };
    const { ax, ay } = resp;
    const eb = effSize(g0);
    // els (v1.6) ride exactly the same geometry as extras — only the value
    // space differs (els.dx/dy % vs extras x/y %), and the measured response
    // already absorbs that difference.
    if (Math.abs(ax) > 0.1) {
      const solve = (line, at) => round1(baseDx + (line - at) / (ax * W) * 100);
      x.push({ v: solve(W / 2, g0.cx), line: W / 2 });
      x.push({ v: solve(MARGIN_PX, g0.cx - eb.w / 2), line: MARGIN_PX });
      x.push({ v: solve(W - MARGIN_PX, g0.cx + eb.w / 2), line: W - MARGIN_PX });
    }
    if (Math.abs(ay) > 0.1) {
      const solve = (line, at) => round1(baseDy + (line - at) / (ay * H) * 100);
      y.push({ v: solve(H / 2, g0.cy), line: H / 2 });
      y.push({ v: solve(MARGIN_PX, g0.cy - eb.h / 2), line: MARGIN_PX });
      y.push({ v: solve(H - MARGIN_PX, g0.cy + eb.h / 2), line: H - MARGIN_PX });
    }
    return { x, y };
  }

  // One axis per move: engage the nearest candidate inside SNAP_T; once
  // engaged (cur), hold until the raw value pulls past SNAP_T*SNAP_R — the
  // larger release radius is what makes the line sticky without trapping the
  // drag. A different candidate inside the capture radius that is strictly
  // closer steals the engagement (adjacent lines stay reachable).
  function snapAxis(raw, cands, cur) {
    if (cur && Math.abs(raw - cur.v) <= SNAP_T * SNAP_R) {
      let best = cur;
      for (const c of cands) {
        if (Math.abs(raw - c.v) < Math.abs(raw - best.v)) best = c;
      }
      return (best !== cur && Math.abs(raw - best.v) <= SNAP_T) ? best : cur;
    }
    let best = null, bd = SNAP_T;
    for (const c of cands) {
      const d = Math.abs(raw - c.v);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  // Live-drag styling mirrors EXACTLY how compose.js applies the committed
  // values (parity block): blocks move via position:relative + left/top px
  // (transforms don't move inline boxes); extras via left/top %.
  function liveMove(t, node, nx, ny) {
    if (!node) return;
    if (t.kind === 'block') {
      node.style.position = 'relative';
      node.style.left = (nx * W / 100) + 'px';
      node.style.top = (ny * H / 100) + 'px';
    } else if (t.kind === 'el') {
      // els carry ONE transform (translate + scale) — write the total the way
      // designElStyle will on the next compose, scale included
      node.style.transform = elTransform(nx, ny, ((design.els || {})[t.key] || {}).scale);
    } else {
      node.style.left = nx + '%';
      node.style.top = ny + '%';
    }
  }

  function onDown(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.smr-edadd')) return; // let the add buttons click
    e.preventDefault();
    e.stopPropagation();

    const hEl = e.target.closest && e.target.closest('.smr-edh');
    if (hEl && sel && sel.kind === 'extra') {
      const ex = design.extras[sel.index];
      const g = geomOf(sel);
      const node = targetEl(sel);
      const mode = hEl.classList.contains('smr-edh--rot') ? 'rotate' : 'resize';
      ges = {
        mode, moved: false, startX: e.clientX, startY: e.clientY,
        target: sel, el: node,
        baseW: ex.w || 20, baseRot: ex.rot || 0, geom: g,
      };
      if (mode === 'rotate' && g) {
        const s = scale(), ir = irect();
        ges.cx = ir.left + g.cx * s;
        ges.cy = ir.top + g.cy * s;
        ges.startAng = Math.atan2(e.clientY - ges.cy, e.clientX - ges.cx) * 180 / Math.PI;
      }
      overlay.setPointerCapture(e.pointerId);
      return;
    }

    const hit = hitAt(e);
    if (!hit) { deselect(); return; }
    if (!sameSel(hit, sel)) select(hit);

    // crop-pan: a selected FILLED slot is always in crop mode; a photo extra
    // only with ✂️ on — dragging pans `pos` inside the frame, not the frame
    const ct = cropTarget();
    if (ct && sameSel(hit, ct)) {
      const obj = ct.kind === 'slot' ? slotSpec(ct.n) : design.extras[ct.index];
      const pos = (obj && Array.isArray(obj.pos)) ? obj.pos : [50, 50];
      ges = {
        mode: 'croppan', moved: false, startX: e.clientX, startY: e.clientY,
        target: ct, basePX: pos[0], basePY: pos[1],
      };
      overlay.setPointerCapture(e.pointerId);
      return;
    }
    // slots never move as frames — an empty slot click just selects it
    if (hit.kind === 'slot') return;

    const node = targetEl(hit);
    let base;
    if (hit.kind === 'block') {
      const b = design.blocks[hit.name] || {};
      base = { dx: b.dx || 0, dy: b.dy || 0 };
    } else if (hit.kind === 'el') {
      // decorative element (v1.6) — the drag writes els.dx/dy, not x/y
      const b = (design.els || {})[hit.key] || {};
      base = { dx: b.dx || 0, dy: b.dy || 0 };
    } else {
      const ex = design.extras[hit.index];
      if (!ex) return;
      base = { dx: ex.x || 0, dy: ex.y || 0 };
    }
    const g0 = geomOf(hit);
    const resp = measureResponse(hit, node);
    ges = {
      mode: 'drag', moved: false, startX: e.clientX, startY: e.clientY,
      target: hit, el: node,
      baseDx: base.dx, baseDy: base.dy,
      liveDx: base.dx, liveDy: base.dy,
      snap: buildSnapSpec(hit, g0, base.dx, base.dy, resp),
      clamp: buildClampSpec(hit, g0, base.dx, base.dy, resp),
      snapX: null, snapY: null,   // the engaged candidate per axis (or null)
    };
    overlay.setPointerCapture(e.pointerId);
  }

  let hoverRaf = 0;
  function onMove(e) {
    if (ges) {
      e.preventDefault();
      e.stopPropagation();
      const dxc = e.clientX - ges.startX, dyc = e.clientY - ges.startY;
      if (!ges.moved && Math.hypot(dxc, dyc) < 3) return;
      ges.moved = true;
      overlay.classList.add('is-drag');
      const s = scale();

      if (ges.mode === 'drag') {
        // client delta -> % of slide (already scale-corrected: /s puts the
        // delta in doc px, so the snap thresholds compare in slide-space)
        let nx = ges.baseDx + (dxc / s) / W * 100;
        let ny = ges.baseDy + (dyc / s) / H * 100;
        // Alt = free drag: no magnets, no guides, no edge stop. Checked live,
        // so pressing Alt mid-drag releases an engaged snap — and lets the box
        // continue past the frame — immediately.
        const free = e.altKey;
        const cx0 = !free && ges.clamp && ges.clamp.x;
        const cy0 = !free && ges.clamp && ges.clamp.y;
        if (cx0) nx = clamp(nx, cx0.lo, cx0.hi);
        if (cy0) ny = clamp(ny, cy0.lo, cy0.hi);
        ges.snapX = free ? null : snapAxis(nx, ges.snap.x, ges.snapX);
        ges.snapY = free ? null : snapAxis(ny, ges.snap.y, ges.snapY);
        if (ges.snapX) nx = ges.snapX.v;
        if (ges.snapY) ny = ges.snapY.v;
        // the frame wins over a magnet: a candidate that would push the box
        // out (possible for a box bigger than the margin band) is dropped,
        // guide and all, rather than drawn on a box that isn't there
        if (cx0 && (nx < cx0.lo - 0.001 || nx > cx0.hi + 0.001)) {
          nx = clamp(nx, cx0.lo, cx0.hi); ges.snapX = null;
        }
        if (cy0 && (ny < cy0.lo - 0.001 || ny > cy0.hi + 0.001)) {
          ny = clamp(ny, cy0.lo, cy0.hi); ges.snapY = null;
        }
        selBox.classList.toggle('is-snap', !!(ges.snapX || ges.snapY));
        paintGuides(ges.snapX ? ges.snapX.line : null,
                    ges.snapY ? ges.snapY.line : null);
        ges.liveDx = nx; ges.liveDy = ny;
        liveMove(ges.target, ges.el, nx, ny);
        // move the outline live even when the engine element is missing
        const g = geomOf(ges.target);
        if (g && !ges.el) {
          g.cx += (nx - ges.baseDx) / 100 * W;
          g.cy += (ny - ges.baseDy) / 100 * H;
        }
        placeBox(selBox, g);
        positionToolbar(g);
      } else if (ges.mode === 'resize') {
        const rot = (ges.baseRot || 0) * Math.PI / 180;
        // project pointer delta on the box's local x axis (handle sits on a corner)
        const local = dxc * Math.cos(rot) + dyc * Math.sin(rot);
        ges.liveW = clamp(ges.baseW + (local / s) / W * 100, 4, 100);
        if (ges.el) ges.el.style.width = ges.liveW + '%';
        const g = geomOf(ges.target);
        if (g && !ges.el) { const w = ges.liveW / 100 * W; g.h *= w / g.w; g.w = w; }
        placeBox(selBox, g);
        positionToolbar(g);
      } else if (ges.mode === 'croppan') {
        // pointer delta (doc units) -> object-position %: pos runs 0..100
        // across the overflow band, and moving content right = revealing the
        // left of the image = pos decreasing (hence the minus)
        if (!ges.ov) ges.ov = cropOverflow(ges.target);
        const ov = ges.ov;
        const obj = ges.target.kind === 'slot'
          ? slotSpec(ges.target.n) : design.extras[ges.target.index];
        if (!ov || !obj) return;
        const px = clamp(ges.basePX - (ov.x > 0.5 ? (dxc / s) / ov.x * 100 : 0), 0, 100);
        const py = clamp(ges.basePY - (ov.y > 0.5 ? (dyc / s) / ov.y * 100 : 0), 0, 100);
        obj.pos = [round1(px), round1(py)];
        liveCrop(ges.target, obj);
      } else if (ges.mode === 'rotate') {
        const ang = Math.atan2(e.clientY - ges.cy, e.clientX - ges.cx) * 180 / Math.PI;
        let rot = ges.baseRot + (ang - ges.startAng);
        rot = ((rot + 540) % 360) - 180;
        if (Math.abs(rot) < ROT_SNAP) rot = 0;
        selBox.classList.toggle('is-snap', rot === 0);
        ges.liveRot = rot;
        // extras carry exactly one transform (rotate) — set the total directly
        if (ges.el) ges.el.style.transform = rot ? `rotate(${rot}deg)` : '';
        const g = geomOf(ges.target);
        if (g) g.rot = rot;
        placeBox(selBox, g);
      }
      return;
    }

    // idle: hover feedback (throttled to a frame)
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (destroyed || ges) return;
      const hit = hitAt(e);
      overlay.classList.toggle('is-hit', !!hit);
      if (hit && !sameSel(hit, sel)) placeBox(hoverBox, geomOf(hit));
      else hoverBox.hidden = true;
    });
  }

  function endGesture(commitIt) {
    if (!ges) return;
    const g = ges;
    ges = null;
    overlay.classList.remove('is-drag');
    selBox.classList.remove('is-snap');
    paintGuides(null, null); // engaged guides fade out (~150ms CSS transition)
    if (!g.moved) { refreshUI(); return; }
    if (!commitIt) {
      // cancel: a crop pan mutated the design live — put the base pos back
      if (g.mode === 'croppan') {
        const obj = g.target.kind === 'slot'
          ? slotSpec(g.target.n) : design.extras[g.target.index];
        if (obj) obj.pos = [g.basePX, g.basePY];
      }
      applyNow(); // re-compose from the design as-is
      return;
    }

    if (g.mode === 'croppan') {
      // obj.pos was written live during the pan — prune+fire+re-compose
      commit();
      return;
    }
    if (g.mode === 'drag') {
      if (g.target.kind === 'block') {
        const blk = blockOf(g.target.name);
        blk.dx = round1(g.liveDx);
        blk.dy = round1(g.liveDy);
      } else if (g.target.kind === 'el') {
        const cur = elOf(g.target.key);      // design.els[key], created on demand
        cur.dx = round1(g.liveDx);
        cur.dy = round1(g.liveDy);
      } else {
        const ex = design.extras[g.target.index];
        if (ex) { ex.x = round1(g.liveDx); ex.y = round1(g.liveDy); }
      }
    } else if (g.mode === 'resize') {
      const ex = design.extras[g.target.index];
      if (ex && typeof g.liveW === 'number') ex.w = round1(g.liveW);
    } else if (g.mode === 'rotate') {
      const ex = design.extras[g.target.index];
      if (ex && typeof g.liveRot === 'number') ex.rot = Math.round(g.liveRot);
    }
    commit();
  }

  function onUp(e) {
    if (!ges) return;
    e.preventDefault();
    e.stopPropagation();
    try { overlay.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    endGesture(true);
  }
  function onCancel() { endGesture(false); }

  function onKey(e) {
    if (e.key === 'Escape' && sel) { deselect(); }
  }

  // wheel over the live crop target = zoom (1..3), anchored to the current
  // focal point; the toolbar's zoom slider follows through zoomUI
  function onWheel(e) {
    const ct = cropTarget();
    if (!ct) return;
    const g = geomOf(ct);
    if (!g || !pointInGeom(docPoint(e), g)) return;
    e.preventDefault();
    const obj = ct.kind === 'slot' ? slotSpec(ct.n) : design.extras[ct.index];
    if (!obj) return;
    const z = clamp((Number(obj.zoom) || 1) - e.deltaY * 0.0015, 1, 3);
    obj.zoom = Math.round(z * 100) / 100;
    if (zoomUI) {
      zoomUI.input.value = String(obj.zoom);
      zoomUI.val.textContent = '×' + obj.zoom.toFixed(2);
    }
    liveCrop(ct, obj);
    commit({ defer: 250 });
  }

  // double-click: a text block -> in-place edit; an empty photo slot -> the
  // fill flow («לחצו פעמיים או גררו תמונה לכאן»)
  function onDblClick(e) {
    const hit = hitAt(e);
    if (!hit) return;
    if (hit.kind === 'slot') {
      e.preventDefault();
      e.stopPropagation();
      if (isHiddenKey(slotKeyOf(hit.n))) return;
      select(hit);
      if (!slotSpec(hit.n)) {
        pickPhoto({
          title: 'איזו תמונה נכנסת למשבצת?',
          onPick: (url) => fillSlot(hit.n, url),
        });
      }
      return;
    }
    if (hit.kind !== 'block') return;
    e.preventDefault();
    e.stopPropagation();
    startTextEdit(hit.name, e);
  }

  const reposition = () => {
    if (ges) return;
    refreshUI();
    if (editing) placeEditBar();
    placePanel(bgPanel);
    placePanel(layersPanel);
  };

  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointermove', onMove);
  overlay.addEventListener('pointerup', onUp);
  overlay.addEventListener('pointercancel', onCancel);
  overlay.addEventListener('dblclick', onDblClick);
  overlay.addEventListener('wheel', onWheel, { passive: false });
  overlay.addEventListener('dragenter', onDragEnter);
  overlay.addEventListener('dragover', onDragOver);
  overlay.addEventListener('dragleave', onDragLeave);
  overlay.addEventListener('drop', onDropEv);
  document.addEventListener('keydown', onKey);
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  iframe.addEventListener('load', reposition);
  const ro = new ResizeObserver(reposition);
  ro.observe(wrapper);

  // ---------------- public handle ----------------

  return {
    destroy() {
      if (destroyed) return;
      if (editing) { try { commitTextEdit(); } catch { /* best effort */ } }
      destroyed = true;
      clearTimeout(changeT);
      clearTimeout(applyT);
      overlay.remove();
      addBar.remove(); // no-op inside the overlay; needed in a host actionBar
      toolbar.remove();
      editBar.remove();
      bgPanel.remove();
      layersPanel.remove();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      iframe.removeEventListener('load', reposition);
      ro.disconnect();
    },
    refresh: refreshUI,
    setPhotos(list) {
      photos = normalizePhotos(list);
      renderBgPanel();
    },
    getDesign() { return isEmptyDesign(design) ? null : deepCopy(design); },
    addPhotoExtra,   // (url, xPct, yPct) — host fallback for off-overlay drops
    dropFiles,       // (files, xPct, yPct) — same, for file drops
    startTextEdit,   // (name, ev?) — in-place text editing entry point
  };
}
