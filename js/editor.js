// editor.js — direct manipulation on the composed slide.
// Owner: editor-UI agent. Contract: PLAN.md «Slide design overrides (v1)».
//
// Works ON TOP of a compose.js mountSlide handle ({iframe, update, doc}).
// Every piece of interaction UI — selection outline, drag/resize/rotate
// handles, the editing sidebar, the asset library —
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
// THE SIDEBAR (v2.1) — Canva's model, replacing the old scatter of chrome.
// Everything that is not literally a handle on the artwork now lives in ONE
// sidebar: an icon rail (מאפיינים · ספרייה · רקע · שכבות + איפוס עיצוב at its
// foot) and one panel body that shows the active tab. What used to be a
// floating toolbar pinned near the selection is now the «מאפיינים» tab; the
// two fixed side panels are two more tabs; the asset-library MODAL is now the
// «ספרייה» tab (the modal survives only for pick-and-return flows — filling a
// photo slot, choosing a background photo — where a return value is owed to a
// caller). Nothing overlays the artwork but the selection box, the handles,
// the snap guides, the slot hints and the in-place text ✓/✗.
//
// opts.sidebar (optional): a host element that RECEIVES the sidebar, so the
// page can dock it as a real column (post.html puts it where the review panel
// sits). Without it the sidebar mounts to <body> as a fixed drawer on the
// inline-end edge — which is what build.html gets, and what any unwired host
// gets for free.
//
//   initEditor(handle, slide, {onChange, manifest, photos, assets, postId,
//                              assetUrl, photosEmptyText, uploadFile,
//                              uploadAsset, onTextChange, sidebar})
//     -> {destroy, refresh, setPhotos, setAssets, getDesign, addPhotoExtra,
//         dropFiles, startTextEdit, openTab}
//
// Asset library (v2.0): opts.assets is the board's WHOLE library — reviewer
// uploads and studio drawings alike, each row {id, kind, source, name, label,
// tags, url, post_id} with its URL already resolved by the host (the editor
// never talks to store.js). It feeds ONE «ספריית נכסים» picker that replaced
// the three old ones; opts.postId powers its «בפוסט הזה» filter and
// opts.uploadAsset(file) its upload tile. Without opts.assets the picker
// falls back to manifest illustrations + brand assets + opts.photos, so an
// unwired host still works exactly as it did.
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
// EVERY element is clickable (v1.8, operator: «I'm still not able to click on
// the illustration on some posts. make sure every single line is a clickable
// asset. especially the lines that are behind text or spots of color behind
// illustrations»). Two halves:
//   · the ENGINE now tags all ten kinds — ill:N (the drawing itself),
//     field:N (bands, washes, glows, smudges, mastheads, card shapes),
//     mark:N, line:N, edge:N, type:N (literal template text), sweep:N (the
//     marker blob, PROMOTED out of .sweep::before into a real element),
//     plus v1.6's rule:N / torn:N / lockup. 226 painted elements in the
//     library had no tagged ancestor-or-self before this; now none do.
//     docs/ELEMENT-INVENTORY.md is the measured audit, per template.
//   · HIT-TESTING is depth-aware. elementFromPoint returns only the topmost
//     node, which is why a line behind text or a colour field behind a
//     drawing could never be reached by pointing at it. candidatesAt() reads
//     the whole elementsFromPoint stack, collects every tagged
//     ancestor-or-self of every node in it, and ranks them: extras → slots →
//     text blocks → els (smallest kind first). Clicking the SAME spot again
//     steps one level deeper and wraps; the gold dashed peek box names what
//     the next click will reach; the toolbar carries an «N/M ▼» stepper.
//     Alt is deliberately NOT the cycle key — it already means "free the
//     magnets / bleed past the frame" for the drag that may follow the same
//     pointerdown. When the geometry is hopeless, the layers panel lists
//     every tagged element and selects it on click; that is the reliable path.
//
// design.els + brand assets (v1.6): the engine tags decorative template
// elements; clicking one selects it (after slots and text blocks,
// before free space). Its toolbar: drag to move (els.dx/dy % — the block-drag
// machinery incl. snap+guides and a measured drag-response correction, here
// probed through the element's own transform), scale slider [0.4–2.5]
// (els.scale), palette swatches for every kind except the lockup (v1.8 — the
// engine decides whether the token lands on `color` or `background`), and
// «מחיקה» → hidden "el:<key>" entry (greyed layers row +
// שחזר), and «שכפול» — a rule duplicates as the matching ba-rule-* brand
// extra (exact svg-path match, default ba-rule-wide), torn as ba-torn-band.
// v1.8 keeps שכפול honest for the kinds it widened to: an illustration host
// offers «איור נוסף» (the library, since the composed svg carries no name),
// and the kinds with no extracted twin — fields, sweeps, marks, strokes,
// literal type — say so instead of silently placing a divider.
// the lockup's שכפול is blocked («אין עדיין קובץ לוגו רשמי» — the JFCS
// Logomark Masterfile is still open; never fake the brand stamp). The
// Brand marks place as extras {type:"brand", name, x, y, w} — engine-
// identical to ill extras but sourced from studio/brand-assets/; their
// toolbar has drag/resize/rotate/front-back/delete + color swatches, and NO
// crop/border rows (furniture, not photos). (v1.6 gave them their own
// «נכסי מותג» picker; v2.0 folded that, the illustration picker and the
// photo picker into the single «ספריית נכסים» picker described below.)
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

// Rides alongside PHOTO_DRAG_MIME when the dragged asset is a DRAWING rather
// than a photograph (v2.4). dataTransfer is the only channel the drop handler
// has — it can read the URL but not the library row it came from — so the kind
// has to be put on the wire at dragstart or it is gone by the time it matters.
export const ART_DRAG_MIME = 'application/x-smr-art';

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

// The three approved gradients (brand guide p.10), for an older manifest that
// predates ingest.mjs's buildGradients(). Same role PALETTE_FALLBACK plays:
// the «רקע» panel renders in the APP document and cannot read tokens.css
// custom properties, so it needs the literal CSS. `worst` is the minimum
// contrast of --on-deep across the whole sweep (docs/GRADIENTS-AND-TINTS.md).
const GRADIENT_FALLBACK = [
  { name: 'grad-1', label: 'אדום → פטל',  family: 'red',    safe: true,  worst: 5.39,
    css: 'linear-gradient(to left, #830051 0%, #B73948 100%)' },
  { name: 'grad-2', label: 'אדום → כתום', family: 'orange', safe: false, worst: 3.05,
    css: 'linear-gradient(to left, #830051 0%, #E17000 100%)' },
  { name: 'grad-3', label: 'אדום → כחול', family: 'blue',   safe: true,  worst: 6.94,
    css: 'linear-gradient(to left, #830051 0%, #005996 100%)' },
];
// The guide's four tint groups and six steps. TINT_FAMS mirrors compose.js's
// copy in the PARITY BLOCK — if one moves, both move.
const TINT_FAMS = ['red', 'blue', 'orange', 'gold'];
const TINT_STEP_LIST = [100, 70, 50, 35, 18, 7];

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
  if (d.bg) {
    parts.push(d.bg.photo ? 'תמונת רקע'
      : d.bg.gradient ? 'מעבר צבע'
      : d.bg.tint ? 'גוון'
      : 'רקע');
  }
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

// v2.2 — the element clipboard. MODULE level, not per-editor: moving to the
// next slide destroys this editor and builds a new one, and copy → next slide
// → paste is the whole reason the clipboard exists.
let clipboard = null;


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
    if (Array.isArray(d.locked) && d.locked.length) out.locked = deepCopy(d.locked);
  }
  return out;
}

function isEmptyDesign(d) {
  return !Object.keys(d.blocks).length && !d.extras.length && !d.bg &&
    !(d.slots && Object.keys(d.slots).length) &&
    !(d.els && Object.keys(d.els).length) &&
    !(d.hidden && d.hidden.length) &&
    !(d.locked && d.locked.length);
}

// data-el keys the engine tags (PLAN «design.els + brand assets v1.6 → v1.8»):
// the ten kinds derived in docs/ELEMENT-INVENTORY.md from a measured walk of
// all 47 templates.
const RE_EL_KEY = /^(?:lockup|(?:rule|torn|ill|edge|field|mark|line|type|sweep):\d+)$/;
// design.hidden — var names + "slot:N" + "el:<key>" (v1.2 + els v1.6 + v1.8)
const RE_HIDDEN_KEY =
  /^(?:[a-zA-Z0-9_]+|slot:\d+|el:(?:lockup|(?:rule|torn|ill|edge|field|mark|line|type|sweep):\d+))$/;
// Which kinds accept a palette colour. The lockup keeps its own colours (the
// JFCS Logomark Masterfile is still the open blocker), every other kind is
// either currentColor-driven or a painted field — the ENGINE decides whether
// the token lands on `color` or `background`; the editor only stores it.
const EL_NO_COLOR = new Set(['lockup']);

// The shape library (v2.4), keyed exactly as the engines' DESIGN_SHAPES (the
// PARITY BLOCK in compose.js/render.mjs). The editor only ever stores a KEY —
// the engines own every radius and polygon, so a shape is described once and
// the preview cannot drift from the PNG. `original` leads the list because it
// is the answer to «give me back the picture I uploaded», which the v1.2 engine
// had no way to say: any crop or border key forced the organic blob.
const PHOTO_SHAPES = [
  { key: 'original', label: 'מקורי', fam: 'plain' },
  { key: 'organic', label: 'אורגני', fam: 'organic' },
  { key: 'organic-2', label: 'אורגני 2', fam: 'organic' },
  { key: 'organic-3', label: 'אורגני 3', fam: 'organic' },
  { key: 'blob-soft', label: 'טיפה רכה', fam: 'organic' },
  { key: 'leaf', label: 'עלה', fam: 'organic' },
  { key: 'arch', label: 'קשת', fam: 'organic' },
  { key: 'ellipse', label: 'אליפסה', fam: 'organic' },
  { key: 'rect', label: 'מלבן', fam: 'geo' },
  { key: 'rounded', label: 'פינות מעוגלות', fam: 'geo' },
  { key: 'circle', label: 'עיגול', fam: 'geo' },
  { key: 'hexagon', label: 'משושה', fam: 'geo' },
  { key: 'diamond', label: 'מעוין', fam: 'geo' },
  { key: 'triangle', label: 'משולש', fam: 'geo' },
  { key: 'chevron', label: 'חץ', fam: 'geo' },
  { key: 'notch', label: 'פינה קטומה', fam: 'geo' },
];
const PHOTO_SHAPE_KEYS = new Set(PHOTO_SHAPES.map((s) => s.key));

// Frame ratios, keyed as the engines' DESIGN_RATIOS. «native» means no pinned
// frame — the picture keeps its own proportions — so it is stored as nothing.
const PHOTO_RATIOS = [
  ['native', 'מקורי'], ['1:1', '1:1'], ['4:5', '4:5'], ['5:4', '5:4'],
  ['3:2', '3:2'], ['2:3', '2:3'], ['16:9', '16:9'], ['9:16', '9:16'],
];
const PHOTO_RATIO_KEYS = new Set(PHOTO_RATIOS.map(([k]) => k));

// Palette tokens only — the same law as blocks.color, and the same grammar the
// engines enforce at render (RE_TOKEN, in the PARITY BLOCK). Enforcing it HERE
// as well matters because the engines fall back SILENTLY: a stray "#ff0000"
// becomes gold-50 in a ring and vanishes entirely in a wash, handing a reviewer
// a colour they never picked with nothing on screen to say so. The UI can only
// produce real tokens; imported or hand-edited JSON cannot be trusted to.
const RE_PALETTE_TOKEN = /^[a-z0-9-]+$/;
const paletteToken = (v) => (typeof v === 'string' && RE_PALETTE_TOKEN.test(v) ? v : null);

// Mirrors `fill` in the engines' designPhotoFrame: a photo COVERS its frame
// once that frame is pinned — by a named ratio, or by `circle`, which pins 1/1
// on its own (the `square` flag in DESIGN_SHAPES; keep this in step with it).
// A slot always covers. This is what tells the crop gestures whether panning
// has anywhere to go at zoom 1.
const PHOTO_SQUARE_SHAPES = new Set(['circle']);
const photoPinned = (o) => !!(o && (
  (typeof o.ratio === 'string' && o.ratio !== 'native' && PHOTO_RATIO_KEYS.has(o.ratio)) ||
  PHOTO_SQUARE_SHAPES.has(o.shape)));

// Shared canonicalization for slot fills and photo extras: pos [%,%] (omitted
// at the 50/50 default), zoom clamped 1..3 (omitted at 1), plus everything v2.4
// added — shape, frame ratio, border, colour overlay, opacity.
//
// `border` keeps TWO spellings on purpose. The legacy preset string
// (paper|line|none, paper being the omitted default) is what every design saved
// before v2.4 carries; the v2.4 object is {color: <palette token>, width: px}.
// Width 0 is a real value, not an absent one — it is how «no border» is said —
// so {width: 0} survives pruning, where dropping the key would silently mean
// «the paper default» and put a gold ring back on a photo someone just stripped.
function pruneCropInto(o, src) {
  if (Array.isArray(src.pos) && src.pos.length === 2) {
    const px = round1(clamp(Number(src.pos[0]) || 0, 0, 100));
    const py = round1(clamp(Number(src.pos[1]) || 0, 0, 100));
    if (px !== 50 || py !== 50) o.pos = [px, py];
  }
  const z = Math.round(clamp(Number(src.zoom) || 1, 1, 3) * 100) / 100;
  if (z > 1) o.zoom = z;
  if (typeof src.shape === 'string' && PHOTO_SHAPE_KEYS.has(src.shape)) o.shape = src.shape;
  if (typeof src.ratio === 'string' && PHOTO_RATIO_KEYS.has(src.ratio) &&
      src.ratio !== 'native') o.ratio = src.ratio;      // native is the default = silence
  // Arrays are objects, and an array border would jump a photo onto the framed
  // path while resolving to no ring — a legacy-looking photo silently losing
  // its mat. Only a plain object counts.
  if (src.border && typeof src.border === 'object' && !Array.isArray(src.border)) {
    const w = Math.round(clamp(Number(src.border.width) || 0, 0, 48));
    const c = paletteToken(src.border.color);
    o.border = (w > 0 && c) ? { color: c, width: w } : { width: 0 };
  } else if (src.border === 'line' || src.border === 'none') {
    o.border = src.border;
  } else if (src.border === 'paper' && src.shape === 'original') {
    // «paper» is normally the omitted default, but shape:"original" defaults to
    // NO ring — so on an original photo the word has to be kept to mean it
    o.border = 'paper';
  }
  if (src.overlay && typeof src.overlay === 'object' && !Array.isArray(src.overlay)) {
    const c = paletteToken(src.overlay.color);
    if (c) {
      o.overlay = {
        color: c,
        opacity: clamp(Math.round((Number(src.overlay.opacity) || 0) * 100) / 100, 0, 0.9),
      };
    }
  }
  pruneOpacityInto(o, src);   // slots fade on the frame, exactly as extras do
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
  // gradient + tint (v1.9). Validated against the same shapes the engines
  // accept, so a design that survives pruning is a design render.mjs will not
  // die on. Step is normalised to a NUMBER here — the wire format has one
  // spelling, whatever a form handed us.
  if (typeof bg.gradient === 'string' && /^grad-[123](-ltr)?$/.test(bg.gradient)) {
    o.gradient = bg.gradient;
  }
  if (bg.tint && typeof bg.tint === 'object' &&
      TINT_FAMS.includes(String(bg.tint.color)) &&
      TINT_STEP_LIST.includes(Number(bg.tint.step))) {
    o.tint = { color: String(bg.tint.color), step: Number(bg.tint.step) };
  }
  if (typeof bg.photo === 'string' && bg.photo) {
    o.photo = bg.photo;
    if (Array.isArray(bg.pos) && bg.pos.length === 2) {
      o.pos = [round1(clamp(Number(bg.pos[0]) || 0, 0, 100)),
               round1(clamp(Number(bg.pos[1]) || 0, 0, 100))];
    }
  }
  // The scrim used to live inside the photo branch, because a photo was the
  // only thing it could sit on. It now also scrims a gradient or tint — which
  // is what makes gradient 2 usable for type at all (3.05:1 bare, 4.73:1 under
  // red-100 at 0.35) — so it is pruned against ANY of the three surfaces.
  // Flat bg.color still takes no overlay: that is existing engine behaviour.
  if ((o.photo || o.gradient || o.tint) &&
      bg.overlay && typeof bg.overlay === 'object' && bg.overlay.color) {
    o.overlay = {
      color: String(bg.overlay.color),
      opacity: clamp(Math.round((Number(bg.overlay.opacity) || 0) * 100) / 100, 0, 0.8),
    };
  }
  return Object.keys(o).length ? o : null;
}

// keep in step with RE_ALIGN in the twin PARITY BLOCK (compose.js/render.mjs)
const RE_TEXT_ALIGN = /^(start|center|end|justify)$/;

function pruneBlock(b) {
  const o = {};
  if (b.font) o.font = b.font;
  if (typeof b.size === 'number' && Math.abs(b.size - 1) > 0.001) o.size = Math.round(b.size * 100) / 100;
  if (b.bold === true) o.bold = true;
  if (b.italic === true) o.italic = true;
  if (b.color) o.color = b.color;
  // v2.2 typography — the engines clamp these too (PARITY BLOCK), but a value
  // that survives to the JSON should already be legal and already rounded
  if (RE_TEXT_ALIGN.test(String(b.align || ''))) o.align = b.align;
  if (typeof b.lh === 'number') o.lh = Math.round(clamp(b.lh, 0.7, 3) * 100) / 100;
  if (typeof b.ls === 'number' && Math.abs(b.ls) > 0.0025) {
    o.ls = Math.round(clamp(b.ls, -0.08, 0.6) * 1000) / 1000;
  }
  if (typeof b.opacity === 'number' && b.opacity < 0.999) {
    o.opacity = Math.round(clamp(b.opacity, 0, 1) * 100) / 100;
  }
  if (typeof b.dx === 'number' && round1(b.dx) !== 0) o.dx = round1(b.dx);
  if (typeof b.dy === 'number' && round1(b.dy) !== 0) o.dy = round1(b.dy);
  return Object.keys(o).length ? o : null;
}

// v2.2: opacity is stored the same way everywhere — omitted at fully opaque,
// two decimals otherwise — so one helper writes it into all three shapes
function pruneOpacityInto(o, src) {
  if (typeof src.opacity === 'number' && src.opacity < 0.999) {
    o.opacity = Math.round(clamp(src.opacity, 0, 1) * 100) / 100;
  }
}

function pruneExtra(e) {
  const o = { type: e.type, x: round1(e.x || 0), y: round1(e.y || 0), w: round1(e.w || 20) };
  // brand marks (v1.6) carry a name like ills — and never crop/border keys
  if (e.type === 'ill' || e.type === 'brand') o.name = e.name;
  else {
    o.url = e.url;
    // shape is pruned by pruneCropInto (v2.4) against the shape table. The old
    // unguarded `if (e.shape) o.shape = e.shape` that used to sit here let an
    // extra keep a shape name a SLOT would have stripped — the one sanitizer
    // drifting into two, which is exactly what sharing it was meant to prevent.
    pruneCropInto(o, e);               // slots v1.2: photo extras crop the same way
  }
  if (e.color) o.color = e.color;
  const rot = Math.round(e.rot || 0);
  if (rot) o.rot = rot;
  if (e.back === true) o.back = true;   // layering v1.1: renders below template content
  pruneOpacityInto(o, e);               // v2.2
  // v2.2 lock: editor-only (nothing in the render engines reads it), but it
  // rides in the design so it survives a reload and reaches everyone
  if (e.lock === true) o.lock = true;
  // v2.4 art: same deal — an <img> extra that is a DRAWING, not a photograph.
  // The engines ignore it; the editor uses it to decide which toolbar a
  // selection deserves, and it has to survive a reload or an uploaded logo
  // would come back wearing crop handles.
  if (e.art === true) o.art = true;
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
  pruneOpacityInto(o, e);               // v2.2
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
/* v1.8 depth peek — the thing UNDER what you are hovering. Gold, not brand
   red, so it never reads as the live selection; the tag hangs above the box
   and is pointer-transparent so it can never eat the click it advertises. */
.smr-edbox--peek{outline:1.5px dashed rgba(179,153,93,.95);
  background:rgba(179,153,93,.10);pointer-events:none}
.smr-edbox__tag{position:absolute;inset-inline-start:0;bottom:100%;
  margin-bottom:3px;white-space:nowrap;pointer-events:none;
  background:#B3995D;color:#fff;border-radius:4px;padding:1px 6px;
  font:600 11px/1.6 'Assistant',-apple-system,sans-serif}
.smr-edbox--sel{outline:2px solid #830051;box-shadow:0 0 0 4px rgba(131,0,81,.15)}
/* v2.2 group companions: the same brand ink as the primary but hollow and
   without handles, so which box a resize would grab stays unambiguous */
.smr-edbox--more{outline:2px dashed rgba(131,0,81,.75);
  background:rgba(131,0,81,.06)}
.smr-edbox--sel.is-snap{outline-color:#2e7d4f;box-shadow:0 0 0 4px rgba(46,125,79,.25)}
.smr-edh{position:absolute;width:16px;height:16px;border-radius:50%;background:#fff;
  border:2px solid #830051;box-shadow:0 1px 4px rgba(0,0,0,.3);pointer-events:auto}
.smr-edh--rz{bottom:-9px;left:-9px;cursor:nwse-resize}
.smr-edh--rot{top:-30px;left:50%;transform:translateX(-50%);cursor:grab}
.smr-edh--rot::after{content:'';position:absolute;top:14px;left:50%;width:2px;height:14px;
  background:#830051;transform:translateX(-50%)}
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
/* ============ the editing sidebar (v2.1) ============
   One shell for every non-artwork control. Two parts side by side: the icon
   rail on the OUTER edge and the panel body next to the slide — Canva's
   geometry, mirrored into RTL by the flex direction, not by hand-written
   left/right. The whole thing is in normal flow when a host hands us a
   container; ".smr-sb--float" is the fixed-drawer fallback. */
.smr-sb{display:flex;align-items:stretch;gap:0;min-height:0;
  background:var(--paper,#fffdf9);border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:14px;overflow:hidden;box-shadow:var(--shadow,0 2px 12px rgba(36,29,32,.08));
  font-size:.88rem;color:var(--ink,#241d20)}
.smr-sb[hidden]{display:none}
/* fallback for hosts that pass no container: a drawer pinned to the
   viewport's inline-end edge. z-index stays UNDER .modal-overlay (100) so a
   pick-and-return modal is never covered by it. */
.smr-sb--float{position:fixed;z-index:90;inset-block:12px;inset-inline-end:12px;
  width:min(392px,94vw);border-radius:14px;
  box-shadow:0 18px 54px rgba(36,29,32,.26);
  animation:smr-sb-in .18s ease-out}
@keyframes smr-sb-in{from{opacity:0;transform:translateX(0) scale(.985)}to{opacity:1;transform:none}}

.smr-sb__rail{order:2;flex:none;width:74px;display:flex;flex-direction:column;
  gap:2px;padding:8px 6px;background:color-mix(in srgb,var(--ink,#241d20) 4%,var(--paper,#fffdf9));
  border-inline-start:1px solid var(--line,rgba(36,29,32,.12))}
.smr-sb__tab{appearance:none;border:0;background:none;cursor:pointer;font:inherit;
  border-radius:10px;padding:8px 2px 6px;display:flex;flex-direction:column;
  align-items:center;gap:3px;color:var(--ink-soft,#6b5f63);line-height:1.1;
  transition:background .12s ease,color .12s ease}
.smr-sb__tab:hover{background:rgba(131,0,81,.07);color:var(--ink,#241d20)}
.smr-sb__tab.on{background:color-mix(in srgb,var(--accent,#830051) 12%,transparent);
  color:var(--accent,#830051);font-weight:700}
.smr-sb__tab .ic{font-size:1.15rem;line-height:1}
.smr-sb__tab .lb{font-size:.66rem}
.smr-sb__tab:disabled{opacity:.38;cursor:default;background:none}
.smr-sb__railgap{flex:1}
.smr-sb__tab--danger:hover{background:rgba(179,64,58,.12);color:#b3403a}

.smr-sb__panel{order:1;flex:1;min-width:0;display:flex;flex-direction:column}
.smr-sb__head{display:flex;align-items:center;gap:8px;padding:11px 13px 9px;
  border-bottom:1px solid var(--line,rgba(36,29,32,.12))}
.smr-sb__title{margin:0;font-size:.92rem;font-weight:700;color:var(--ink,#241d20)}
.smr-sb__eye{margin-inline-start:auto;appearance:none;border:1px solid transparent;
  background:none;cursor:pointer;font-size:1rem;line-height:1;padding:4px 7px;
  border-radius:8px;color:var(--ink-soft,#6b5f63)}
.smr-sb__eye:hover{background:rgba(131,0,81,.07);color:var(--ink,#241d20)}
.smr-sb__eye.on{background:color-mix(in srgb,var(--accent,#830051) 12%,transparent);
  color:var(--accent,#830051);border-color:color-mix(in srgb,var(--accent,#830051) 30%,transparent)}
/* deck strip (v2.2) */
.smr-edslides{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:8px}
.smr-edslide{appearance:none;padding:0;border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:9px;overflow:hidden;background:var(--paper,#fffdf9);cursor:pointer;
  position:relative;display:block;line-height:0}
.smr-edslide:hover{border-color:var(--accent,#830051)}
.smr-edslide.on{border-color:var(--accent,#830051);
  box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#830051) 35%,transparent)}
.smr-edslide img{width:100%;aspect-ratio:4/5;object-fit:cover;display:block}
.smr-edslide__ph{display:flex;align-items:center;justify-content:center;
  aspect-ratio:4/5;color:var(--ink-soft,#6b5f63);font-size:.9rem;line-height:1}
.smr-edslide__n{position:absolute;inset-block-end:3px;inset-inline-start:3px;
  background:rgba(36,29,32,.72);color:#fff;border-radius:5px;padding:0 5px;
  font:600 11px/1.7 'Assistant',-apple-system,sans-serif}
.smr-sb__body{flex:1;min-height:0;overflow-y:auto;padding:12px 13px 16px;
  display:grid;gap:10px;align-content:start}
/* one scroller only (Canva's rule): panes stretch, the body scrolls */
.smr-sb__pane[hidden]{display:none}
.smr-sb__pane{display:grid;gap:10px;align-content:start;min-width:0}
.smr-sb__empty{color:var(--ink-soft,#6b5f63);line-height:1.55;font-size:.86rem}
.smr-sb__hint{color:var(--ink-soft,#6b5f63);font-size:.78rem;line-height:1.5}

/* narrow: the sidebar becomes a bottom sheet so the slide stays on screen */
@media (max-width:920px){
  .smr-sb,.smr-sb--float{position:fixed;z-index:90;inset-inline:0;inset-block:auto 0;
    width:auto;max-height:58vh;border-radius:16px 16px 0 0;border-bottom:0;
    box-shadow:0 -12px 40px rgba(36,29,32,.24);animation:smr-sb-up .2s ease-out}
  .smr-sb__rail{width:64px}
}
@keyframes smr-sb-up{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}

/* the selection toolbar, docked: same rows, stacked full-width in the panel */
.smr-edtb[hidden]{display:none}
.smr-edtb{display:grid;gap:9px;font-size:.88rem}
.smr-edtb__row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.smr-edtb__name{font-weight:700;font-size:.8rem;color:var(--ink-soft,#6b5f63);
  direction:ltr;font-family:ui-monospace,monospace}
.smr-edtb select{max-width:100%;flex:1;min-width:120px}
.smr-edtb input[type=range]{flex:1;min-width:110px;max-width:100%;accent-color:var(--accent,#830051)}
.smr-edtb__sz{font-size:.78rem;color:var(--ink-soft,#6b5f63);min-width:44px;direction:ltr}
.smr-edtg{appearance:none;border:1px solid var(--line,rgba(36,29,32,.15));background:var(--paper,#fffdf9);
  border-radius:8px;width:32px;height:32px;cursor:pointer;font-size:.95rem;color:var(--ink,#241d20)}
.smr-edtg.on{background:var(--accent,#830051);color:#fff;border-color:var(--accent,#830051)}
.smr-edtg--b{font-weight:800}
.smr-edtg--i{font-style:italic;font-family:serif}
.smr-edsw{appearance:none;width:22px;height:22px;border-radius:50%;cursor:pointer;
  border:1px solid rgba(36,29,32,.25);padding:0}
.smr-edsw.on{outline:2px solid var(--accent,#830051);outline-offset:2px}
/* shape picker (v2.4) — a grid of tiles that each DRAW their shape, because a
   list of words makes you translate «משושה» into a hexagon in your head before
   you can choose. Four to a row fits the 300px panel with the label under each
   tile; the tile itself is a filled square wearing the same radius/clip-path the
   engine will apply, so what you point at is what you get. */
.smr-edshapes{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:2px 0}
/* min-width:0 + the wrap rule below are a GUARD, not a fix for an observed
   break: measured in Chrome, the current labels fit at every sidebar width down
   to 230px with or without them. They are here because a grid item defaults to
   min-width:auto, so a longer label — a rename, a new shape, another language —
   would widen its track past 1fr and push the picker sideways out of the panel
   instead of wrapping. Cheap insurance against a change nobody would think to
   re-measure. */
.smr-edshape{appearance:none;background:none;border:1px solid transparent;cursor:pointer;
  border-radius:8px;padding:5px 2px 4px;display:flex;flex-direction:column;align-items:center;
  gap:4px;font:inherit;color:var(--ink-soft,#6b5f63);min-width:0}
.smr-edshape:hover{border-color:var(--line,rgba(36,29,32,.12))}
.smr-edshape.on{border-color:var(--accent,#830051);color:var(--accent,#830051)}
.smr-edshape i{display:block;width:30px;height:30px;background:var(--gold-50,#b3995d)}
.smr-edshape.on i{background:var(--accent,#830051)}
.smr-edshape span{font-size:.63rem;line-height:1.2;text-align:center;
  overflow-wrap:anywhere;hyphens:none}
/* «מקורי» is the ABSENCE of a mask — drawing it as a shape would misdescribe
   what it does, so it reads as an empty dashed frame instead */
.smr-edshape__orig{background:none !important;border:1.5px dashed currentColor}
.smr-edtb .btn{padding:5px 10px;font-size:.8rem}
.smr-edtb__del{color:#b3403a}
.smr-edtb__hint{font-size:.75rem;color:var(--ink-soft,#6b5f63);line-height:1.5}
/* numeric position/size boxes (v2.2) — four to a row at 1fr each, so the row
   holds X · Y · width · rotation without wrapping in a 300px panel */
.smr-ednum__row{display:grid;grid-template-columns:repeat(auto-fit,minmax(58px,1fr));
  gap:6px;align-items:end}
/* «apply to every slide» — a full-width ghost button, because it is the one
   control here that changes slides you cannot currently see */
.smr-edall{width:100%;justify-content:center}
.smr-ednum__f{display:grid;gap:2px;min-width:0}
.smr-ednum__f > span{font-size:.68rem;color:var(--ink-soft,#6b5f63)}
.smr-ednum{width:100%;min-width:0;padding:4px 6px;font-size:.8rem;direction:ltr;
  text-align:center}
.smr-ednum::-webkit-outer-spin-button,.smr-ednum::-webkit-inner-spin-button{
  -webkit-appearance:none;margin:0}
.smr-ednum{-moz-appearance:textfield}
.smr-edpick{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;
  max-height:min(56vh,560px);overflow-y:auto;padding:2px}
.smr-edpick button{appearance:none;border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:10px;background:var(--paper,#fffdf9);cursor:pointer;padding:8px;font:inherit;
  display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--ink,#241d20)}
.smr-edpick button:hover{border-color:var(--accent,#830051)}
.smr-edpick img{width:64px;height:64px;object-fit:contain;display:block}
.smr-edpick--ph img{width:100%;height:84px;object-fit:cover;border-radius:6px}
.smr-edpick .nm{font-size:.7rem;direction:ltr;overflow-wrap:anywhere;color:var(--ink-soft,#6b5f63)}
/* «ספריית נכסים» (v2.0) — one picker over the whole board library */
.smr-edlibbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.smr-edlibbar .field__input{flex:1;min-width:180px}
.smr-edchips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px}
.smr-edcount{font-size:.76rem;color:var(--ink-soft,#6b5f63)}
.smr-edpick--lib{grid-template-columns:repeat(auto-fill,minmax(104px,1fr))}
.smr-edpick--lib button{align-items:stretch;position:relative}
.smr-edpick--lib .nm{direction:rtl;text-align:center;font-size:.72rem;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.smr-edpick--lib > button > img{width:100%;height:84px;object-fit:cover;border-radius:6px}
.smr-edpick--lib .bsvg{display:flex;align-items:center;justify-content:center;
  height:84px;color:var(--accent,#830051)}
.smr-edpick--lib .bsvg svg{width:86%;max-height:100%;overflow:visible}
.smr-edpick--lib .bsvg img{width:100%;height:84px;object-fit:contain}
/* inside the sidebar the library is the whole pane: no nested scroller (the
   body scrolls), and a tighter grid for the narrower column */
.smr-sb .smr-edpick{max-height:none;overflow:visible;padding:0}
.smr-sb .smr-edpick--lib{grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}
.smr-sb .smr-edlibbar{margin-bottom:0}
.smr-sb .smr-edlibbar .btn{width:100%}
.smr-sb .smr-edchips{margin-bottom:0}
.smr-edbadge{position:absolute;inset-block-start:4px;inset-inline-start:4px;
  background:var(--accent,#830051);color:#fff;border-radius:999px;
  font-size:.62rem;line-height:1;padding:3px 6px}
/* quick actions (v2.3) — glyph-sized verbs beside the selection. z 95 keeps
   it above the floating sidebar (90) and UNDER .modal-overlay (100), so a
   picker is never covered by it. */
.smr-edqb[hidden]{display:none}
.smr-edqb{position:fixed;z-index:95;display:flex;align-items:center;gap:2px;
  background:var(--paper,#fffdf9);border:1px solid var(--line,rgba(36,29,32,.12));
  border-radius:11px;padding:4px;box-shadow:0 8px 26px rgba(36,29,32,.26);
  animation:smr-edqb-in .12s ease-out}
@keyframes smr-edqb-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.smr-edqb__b{appearance:none;border:0;background:none;cursor:pointer;
  width:30px;height:30px;border-radius:8px;padding:0;line-height:1;
  font:inherit;font-size:.92rem;color:var(--ink,#241d20);
  display:flex;align-items:center;justify-content:center;
  transition:background .12s ease,color .12s ease}
.smr-edqb__b:hover{background:rgba(131,0,81,.09)}
.smr-edqb__b.on{background:var(--accent,#830051);color:#fff}
.smr-edqb__b.is-danger:hover{background:rgba(179,64,58,.13);color:#b3403a}
.smr-edqb__sep{width:1px;align-self:stretch;margin:2px 3px;
  background:var(--line,rgba(36,29,32,.14))}
.smr-edqb__n{font-size:.74rem;font-weight:700;color:var(--ink-soft,#6b5f63);
  padding:0 6px}
/* «⋯» pulse: the first press should SHOW you where the rest of the options
   went, not just silently swap a tab */
.smr-sb__panel.is-pulse{animation:smr-sb-pulse .6s ease-out}
@keyframes smr-sb-pulse{
  0%{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--accent,#830051) 65%,transparent)}
  100%{box-shadow:inset 0 0 0 2px transparent}}
.smr-edcta[hidden]{display:none}
.smr-edcta{position:fixed;z-index:1300;display:flex;gap:6px;background:var(--paper,#fffdf9);
  border:1px solid var(--line,rgba(36,29,32,.12));border-radius:10px;padding:6px;
  box-shadow:0 10px 30px rgba(36,29,32,.25)}
.smr-edcta .btn{padding:4px 12px;font-size:.82rem}
.smr-edcta__ok{color:#2e7d4f;font-weight:700}
.smr-edcta__no{color:#b3403a}
.smr-edpanel[hidden]{display:none}
.smr-edpanel{display:grid;gap:10px;align-content:start;font-size:.86rem;min-width:0}
.smr-edpanel h5{margin:0;font-size:.8rem;color:var(--ink-soft,#6b5f63);font-weight:700;
  display:flex;align-items:center;gap:6px}
.smr-edpanel .rec{font-size:.68rem;background:var(--accent,#830051);color:#fff;
  border-radius:999px;padding:2px 8px;font-weight:600}
.smr-edbgf{display:flex;gap:8px}
.smr-edbgf button{appearance:none;cursor:pointer;flex:1;height:52px;border-radius:10px;
  border:1px solid var(--line,rgba(36,29,32,.18));display:flex;align-items:flex-end;
  justify-content:center;padding:4px;font:inherit;font-size:.7rem;font-weight:600}
.smr-edbgf button.on{outline:2px solid var(--accent,#830051);outline-offset:2px}
.smr-edwarn{font-size:.78rem;color:#8a5a00;background:#fdf3dd;border-radius:8px;padding:6px 10px}
/* gradients (v1.9) — wide bars, because a gradient read at swatch size is
   just a muddy colour; the sweep IS the thing being chosen */
.smr-edgrad{display:grid;gap:6px}
.smr-edgrad button{appearance:none;cursor:pointer;height:34px;border-radius:8px;
  border:1px solid var(--line,rgba(36,29,32,.18));padding:0 9px;font:inherit;
  font-size:.72rem;font-weight:600;color:#fdf8f4;display:flex;align-items:center;
  justify-content:space-between;gap:8px;text-shadow:0 1px 2px rgba(0,0,0,.45)}
.smr-edgrad button.on{outline:2px solid var(--accent,#830051);outline-offset:2px}
.smr-edgrad .warn{font-size:.66rem;opacity:.95;font-weight:500}
/* tint ramps (v1.9) — one row per family, the guide's six steps in order.
   The family label sits outside the row so these read as four separate
   groups, which is what the guide's "do not mix colors" rule means. */
.smr-edtint{display:grid;gap:5px}
.smr-edtint__fam{display:flex;align-items:center;gap:7px}
.smr-edtint__nm{font-size:.7rem;color:var(--ink-soft,#6b5f63);min-width:32px;font-weight:600}
.smr-edtint__ramp{display:flex;flex:1;border-radius:7px;overflow:hidden;
  border:1px solid var(--line,rgba(36,29,32,.18))}
.smr-edtint__ramp button{appearance:none;border:0;cursor:pointer;flex:1;height:26px;padding:0}
.smr-edtint__ramp button.on{outline:2px solid var(--accent,#830051);outline-offset:-2px;
  position:relative;z-index:1}
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
.smr-edlyr__row.is-locked .smr-edlyr__nm{opacity:.65}
.smr-edlyr__row .mini--locked{color:var(--accent,#830051)}
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
/* safe-area guides (v2.2) — sized in % of the slide, so they follow the frame
   at any scale without a single line of positioning JS. 1080×1350: the grid
   square is the middle 80% vertically; the brand margin is 96/1080 = 8.89%
   inline and 96/1350 = 7.11% block. */
.smr-edsafelayer{position:absolute;inset:0;z-index:4;pointer-events:none}
.smr-edsafelayer[hidden]{display:none}
.smr-edsafe{position:absolute;pointer-events:none}
.smr-edsafe--sq{inset:10% 0;border-block:1.5px dashed rgba(255,255,255,.92);
  box-shadow:0 0 0 1px rgba(36,29,32,.28) inset}
.smr-edsafe--mg{inset:7.11% 8.89%;outline:1.5px dashed rgba(179,153,93,.95)}
.smr-edsafe__tag{position:absolute;inset-inline-start:6px;top:4px;
  background:rgba(36,29,32,.72);color:#fff;border-radius:4px;padding:1px 6px;
  font:600 11px/1.6 'Assistant',-apple-system,sans-serif}
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
  // v2.2 multi-select: `sel` stays THE selection — every existing renderer,
  // gesture and toolbar reads it and none of them had to learn about groups.
  // Shift-click adds companions here instead, and the handful of operations
  // that are genuinely group-shaped (nudge, delete, drag, align, distribute)
  // go through targets(). A plain click clears the group.
  let selMore = [];
  // v1.8: where the current selection sits in the stack under the last click
  // ({i, n}), or null when it was the only candidate. Drives the toolbar's
  // depth stepper so the reviewer can walk the pile without pixel-hunting.
  let depth = null;
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
  // v1.8 depth peek: when more than one thing sits under the pointer, this
  // dashed box outlines what the NEXT click will step to, with an N/M badge.
  // Without it depth-cycling is invisible — a reviewer has no way to know
  // there is a colour field under the paragraph they are hovering.
  const peekTag = el('span', { class: 'smr-edbox__tag' }, '');
  const peekBox = el('div', { class: 'smr-edbox smr-edbox--peek', hidden: true }, peekTag);
  const selBox = el('div', { class: 'smr-edbox smr-edbox--sel', hidden: true });
  const hRot = el('div', { class: 'smr-edh smr-edh--rot', title: 'סיבוב' });
  const hRz = el('div', { class: 'smr-edh smr-edh--rz', title: 'שינוי גודל' });
  selBox.append(hRot, hRz);
  const dropHint = el('div', { class: 'smr-eddrop', hidden: true }, 'שחררו כאן כדי להוסיף את התמונה');
  const busyEl = el('div', { class: 'smr-edbusy', hidden: true }, 'מעלים תמונה…');
  // UI-only hints over empty photo slots (parent document — never rendered
  // content) + the rule-of-thirds grid shown while cropping + the accent
  // snap guides (1px lines across the full slide while a magnet is engaged).
  const slotHints = el('div', { class: 'smr-edslots' });
  // v2.2 safe-area guides. Two things get cropped off a 1080×1350 post and
  // people keep forgetting both: Instagram's grid thumbnail takes the CENTRE
  // SQUARE (1080×1080, so 135px off the top and bottom), and the brand's own
  // 96px margin is where type is supposed to stop. Off by default — this is a
  // check you turn on, not a cage you work inside.
  const safeSq = el('div', { class: 'smr-edsafe smr-edsafe--sq' },
    el('span', { class: 'smr-edsafe__tag' }, 'ריבוע הגריד'));
  const safeMg = el('div', { class: 'smr-edsafe smr-edsafe--mg' });
  const safeBox = el('div', { class: 'smr-edsafelayer', hidden: true }, safeSq, safeMg);
  const gridBox = el('div', { class: 'smr-edgrid', hidden: true });
  const guideV = el('div', { class: 'smr-edguide smr-edguide--v' });
  const guideH = el('div', { class: 'smr-edguide smr-edguide--h' });
  const overlay = el('div', { class: 'smr-edov', dir: 'rtl' },
    slotHints, safeBox, hoverBox, peekBox, selBox, gridBox, guideV, guideH,
    dropHint, busyEl);
  wrapper.appendChild(overlay);

  // in-place text editing: floating ✓/✗ near the edited block. pointerdown +
  // preventDefault so pressing them never steals focus (focus loss = blur =
  // commit, which would fire before the click).
  const ctaOk = el('button', { class: 'btn btn--ghost smr-edcta__ok', type: 'button' }, '✓ שמירה');
  const ctaNo = el('button', { class: 'btn btn--ghost smr-edcta__no', type: 'button' }, '✗ ביטול');
  ctaOk.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); commitTextEdit(); });
  ctaNo.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); cancelTextEdit(); });
  const editBar = el('div', { class: 'smr-edcta', dir: 'rtl', hidden: true }, ctaOk, ctaNo);
  document.body.appendChild(editBar);

  // ---------------- quick actions (v2.3) ----------------
  //
  // The few verbs you reach for WHILE looking at the thing you selected —
  // beside it, not across the room. Everything else stays in the sidebar, and
  // «⋯» is the door between the two.
  //
  // This is NOT the old floating toolbar coming back. That one carried the
  // whole property set — font pickers, sliders, a thirty-swatch palette —
  // which is exactly why it covered the artwork and had to go. This is at
  // most six single-glyph buttons: the high-frequency verbs plus the two
  // destructive ones that should never be a hunt. The rule the sidebar
  // established still holds: anything that needs a label, a slider or a grid
  // lives in the panel. Only glyph-sized verbs may sit on the canvas.
  const quickBar = el('div', { class: 'smr-edqb', dir: 'rtl', hidden: true });
  quickBar.addEventListener('pointerdown', (e) => e.stopPropagation());
  document.body.appendChild(quickBar);

  // ---------------- the sidebar (v2.1) ----------------
  //
  // Four panes, one visible at a time, in ONE shell. The panes are built once
  // and kept in the DOM (hidden), because every renderer here writes into its
  // own element with replaceChildren and re-parenting them per tab switch
  // would strip the listeners the library grid's drag sources depend on.

  const toolbar = el('div', { class: 'smr-edtb', dir: 'rtl', hidden: true });
  const propsEmpty = el('p', { class: 'smr-sb__empty' },
    'לוחצים על טקסט, תמונה או צורה בשקף — וכל האפשרויות שלהם מופיעות כאן.');
  const propsPane = el('div', { class: 'smr-sb__pane', hidden: true }, toolbar, propsEmpty);
  const libPane = el('div', { class: 'smr-sb__pane', hidden: true });
  // the two former floating panels keep their own class + renderers; they are
  // panes now, so their .hidden tracks the active tab and nothing else
  const bgPanel = el('div', { class: 'smr-edpanel smr-sb__pane', hidden: true });
  const layersPanel = el('div', { class: 'smr-edpanel smr-sb__pane', hidden: true });

  // v2.2 — the deck, when the host has one. `go(i)` moves the whole page to
  // another slide; the editor never touches the deck itself (it only ever
  // knows about ONE slide) — it just draws the strip and forwards the click.
  const deck = (opts.deck && typeof opts.deck.go === 'function' &&
    Number(opts.deck.count) > 1) ? opts.deck : null;
  const slidesPane = el('div', { class: 'smr-sb__pane', hidden: true });

  const TABS = [
    { key: 'props', icon: '✎', label: 'מאפיינים', title: 'מאפייני הבחירה', pane: propsPane },
    { key: 'lib', icon: '🖼', label: 'ספרייה', title: 'ספריית נכסים', pane: libPane },
    { key: 'bg', icon: '🎨', label: 'רקע', title: 'רקע השקף', pane: bgPanel },
    { key: 'layers', icon: '☰', label: 'שכבות', title: 'שכבות השקף', pane: layersPanel },
    ...(deck ? [{ key: 'slides', icon: '▤', label: 'שקפים', title: 'שקפי הקרוסלה', pane: slidesPane }] : []),
  ];
  let activeTab = 'props';

  const sbTitle = el('h4', { class: 'smr-sb__title' }, 'מאפייני הבחירה');
  // safe-area toggle lives in the head, not the rail: it is a way of LOOKING
  // at the slide, not a set of controls, and it stays on across tab switches
  const safeBtn = el('button', {
    class: 'smr-sb__eye', type: 'button', 'aria-pressed': 'false',
    title: 'קווי בטיחות: ריבוע הגריד של אינסטגרם (1080×1080) ושולי המותג (96px)',
    onclick: () => {
      safeBox.hidden = !safeBox.hidden;
      safeBtn.classList.toggle('on', !safeBox.hidden);
      safeBtn.setAttribute('aria-pressed', safeBox.hidden ? 'false' : 'true');
    },
  }, '⊞');
  const sbBody = el('div', { class: 'smr-sb__body' }, ...TABS.map((t) => t.pane));
  const sbPanel = el('div', { class: 'smr-sb__panel' },
    el('div', { class: 'smr-sb__head' }, sbTitle, safeBtn), sbBody);
  const railBtns = new Map();
  const sbRail = el('div', { class: 'smr-sb__rail' },
    TABS.map((t) => {
      const b = el('button', {
        class: 'smr-sb__tab', type: 'button', title: t.title,
        'aria-pressed': 'false',
        onclick: () => openTab(t.key),
      }, el('span', { class: 'ic' }, t.icon), el('span', { class: 'lb' }, t.label));
      railBtns.set(t.key, b);
      return b;
    }),
    el('span', { class: 'smr-sb__railgap' }),
    el('button', {
      class: 'smr-sb__tab smr-sb__tab--danger', type: 'button',
      title: 'איפוס העיצוב — שקף אחד או כל הקרוסלה',
      onclick: () => resetDialog(),
    }, el('span', { class: 'ic' }, '⟲'), el('span', { class: 'lb' }, 'איפוס')),
  );
  const sbHost = (opts.sidebar && opts.sidebar.nodeType === 1) ? opts.sidebar : null;
  const sidebar = el('aside', {
    class: 'smr-sb' + (sbHost ? '' : ' smr-sb--float'), dir: 'rtl',
    'aria-label': 'כלי עריכת השקף',
  }, sbPanel, sbRail);
  // clicks inside the sidebar must never reach the slide's deselect handler
  sidebar.addEventListener('pointerdown', (e) => e.stopPropagation());
  (sbHost || document.body).appendChild(sidebar);

  function openTab(key, o = {}) {
    if (!TABS.some((t) => t.key === key)) return;
    activeTab = key;
    for (const t of TABS) {
      t.pane.hidden = t.key !== key;
      const b = railBtns.get(t.key);
      b.classList.toggle('on', t.key === key);
      b.setAttribute('aria-pressed', t.key === key ? 'true' : 'false');
      if (t.key === key) sbTitle.textContent = t.title;
    }
    if (key === 'slides') renderSlidesPane();
    if (key === 'lib') renderLibraryPane();
    if (key === 'bg') renderBgPanel();
    if (key === 'layers') renderLayersPanel();
    if (key === 'props') syncPropsPane();
    if (!o.keepScroll) sbBody.scrollTop = 0;
  }

  function syncPropsPane() {
    propsEmpty.hidden = !toolbar.hidden;
  }

  // the deck strip: which slide you are on, and one click to any other. The
  // thumbs are the studio's own PNG renders when the host has them — cheap,
  // and they are what the reviewer already recognises from the viewer.
  function renderSlidesPane() {
    if (!deck || slidesPane.hidden) return;
    const n = Number(deck.count) || 0;
    const cur = Number(deck.index);
    const kids = [];
    for (let i = 0; i < n; i++) {
      const url = typeof deck.thumb === 'function' ? deck.thumb(i) : null;
      const b = el('button', {
        class: 'smr-edslide' + (i === cur ? ' on' : ''), type: 'button',
        title: typeof deck.label === 'function' ? deck.label(i) : ('שקף ' + (i + 1)),
        onclick: () => { if (i !== cur) deck.go(i); },
      },
        url ? el('img', { src: url, alt: '', loading: 'lazy' })
          : el('span', { class: 'smr-edslide__ph' }, '—'),
        el('span', { class: 'smr-edslide__n' }, String(i + 1)),
      );
      kids.push(b);
    }
    slidesPane.replaceChildren(
      el('p', { class: 'smr-sb__hint' },
        'מעבר בין שקפי הקרוסלה בלי לצאת ממצב העריכה. העתקה מכאן והדבקה שם — ⌘C ואז ⌘V.'),
      el('div', { class: 'smr-edslides' }, kids),
    );
  }

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

  // ---------------- lock (v2.2) ----------------
  //
  // Locked = still there, still visible, still stylable — just not movable and
  // not in the way. Template things (blocks, slots, els) lock by key in
  // `design.locked`, the same shape `design.hidden` uses. Extras lock ON the
  // object (`ex.lock`), because an extra is identified by its INDEX and the
  // layers panel reorders that array — a key-based lock would follow the
  // position instead of the thing.
  //
  // The real payoff is hit-testing: a locked background photo drops out of the
  // candidate stack entirely, so clicking the text on top of it just works.
  // The layers panel still reaches it — that is where you unlock it.
  const lockedKeys = () => (Array.isArray(design.locked) ? design.locked : []);
  const lockKeyOf = (t) => (t.kind === 'block' ? t.name
    : t.kind === 'el' ? elHiddenKey(t.key)
    : t.kind === 'slot' ? slotKeyOf(t.n) : null);

  function isLocked(t) {
    if (!t) return false;
    if (t.kind === 'extra') {
      const ex = design.extras[t.index];
      return !!(ex && ex.lock === true);
    }
    const k = lockKeyOf(t);
    return !!k && lockedKeys().includes(k);
  }

  function toggleLock(t) {
    if (!t) return;
    if (t.kind === 'extra') {
      const ex = design.extras[t.index];
      if (!ex) return;
      if (ex.lock) delete ex.lock; else ex.lock = true;
    } else {
      const k = lockKeyOf(t);
      if (!k) return;
      const cur = lockedKeys();
      design.locked = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
      if (!design.locked.length) delete design.locked;
    }
    commit();
    renderToolbar();
    renderLayersPanel();
  }

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

  // The live-drag equivalent of what the ENGINE writes for an els entry —
  // parity: compose and drag must move the element identically. v1.8 moved
  // both engines off the `transform` shorthand onto the INDIVIDUAL
  // `translate`/`scale` properties, because house-e-marker rotates the very
  // elements v1.8 newly tags (.stroke, .underline, .smudge, the sweep blob)
  // and a shorthand written here would wipe that rotation mid-drag — the
  // element would visibly snap straight the moment the reviewer touched it.
  // Writes both properties every time (never a partial style), so clearing a
  // scale during a drag cannot leave a stale one behind.
  function applyElTransform(node, dx, dy, sc) {
    if (!node) return;
    node.style.translate = (dx || dy)
      ? round1(dx * W / 100) + 'px ' + round1(dy * H / 100) + 'px' : '';
    const s = typeof sc === 'number' ? clamp(sc, 0.4, 2.5) : 1;
    node.style.scale = Math.abs(s - 1) > 0.001 ? String(s) : '';
  }

  // Hebrew names for every kind the engine tags (v1.8). The label is what the
  // layers panel lists and the toolbar titles, so it has to read like the
  // thing on the slide, not like a key.
  const EL_KIND_LABEL = {
    rule: 'קו מפריד', torn: 'שפה קרועה', ill: 'איור', edge: 'שפת גזירה',
    field: 'שדה צבע', mark: 'סימן', line: 'קו', type: 'טקסט קבוע',
    sweep: 'משיחת מרקר',
  };
  function elLabelOf(key) {
    if (key === 'lockup') return 'חתימת המותג (לוגו)';
    const m = key.match(/^([a-z]+):(\d+)$/);
    if (!m) return key;
    const base = EL_KIND_LABEL[m[1]] || m[1];
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

  // ---------------- depth-aware hit-testing (v1.8) ----------------
  // `elementFromPoint` returns ONLY the topmost node, which is why a colour
  // field behind a paragraph, or a marker sweep under its own type, could
  // never be selected however precisely a reviewer clicked: the text box
  // swallowed the click and the walk up from it never reached the thing
  // underneath. `elementsFromPoint` returns the whole stack, so the editor
  // can rank EVERY candidate at the point and offer the ones below the top.
  //
  // Ordering is by STACK DEPTH first, and only then by kind — which is the
  // one thing a flat "slots → blocks → els" ranking gets wrong. A rule nudged
  // up over a paragraph is painted on top of it and is the thing the reviewer
  // is pointing at; ranking all text above all decoration would hand them the
  // paragraph underneath instead. (The v1.6 regression suite caught exactly
  // that: a dragged rule stopped being re-selectable.)
  //
  // So: walk the elementsFromPoint stack top-down, and for each node collect
  // its own tagged ancestor-or-self chain. Within one chain a photo slot wins
  // outright — a slot's pending label IS a text block, and clicking it must
  // fill the slot, not edit the label (v1.2) — and everything else is
  // innermost-first, so the colour fill inside a portrait beats the portrait.
  // candidates[0] is therefore byte-for-byte what the old top-of-stack walk
  // returned; everything the old walk could never see follows behind it.
  function candidatesAt(e) {
    const p = docPoint(e);
    const out = [];
    const seen = new Set();
    const push = (t) => {
      const k = t.kind + ':' + (t.kind === 'block' ? t.name
        : t.kind === 'slot' ? t.n : t.kind === 'el' ? t.key : t.index);
      if (seen.has(k)) return;
      seen.add(k);
      if (isLocked(t)) return;   // v2.2: a locked thing is not in the way
      out.push(t);
    };
    // extras first, topmost (= last in array) wins
    for (let i = design.extras.length - 1; i >= 0; i--) {
      if (pointInGeom(p, geomOf({ kind: 'extra', index: i }))) push({ kind: 'extra', index: i });
    }
    const d = doc();
    if (!d) return out;
    let stack = [];
    try {
      stack = d.elementsFromPoint ? [...d.elementsFromPoint(p.x, p.y)]
        : [d.elementFromPoint(p.x, p.y)].filter(Boolean);
    } catch { /* ignore */ }
    for (const top of stack) {
      const chain = [];
      let slot = null;
      for (let n = top; n && n.nodeType === 1; n = n.parentElement) {
        if (!n.hasAttribute) continue;
        if (slot == null && n.hasAttribute('data-slot') && !n.hasAttribute('data-extra')) {
          slot = { kind: 'slot', n: Number(n.getAttribute('data-slot')) };
        }
        if (n.hasAttribute('data-var')) chain.push({ kind: 'block', name: n.getAttribute('data-var') });
        if (n.hasAttribute('data-el')) {
          const key = n.getAttribute('data-el');
          if (RE_EL_KEY.test(key)) chain.push({ kind: 'el', key });
        }
      }
      if (slot) push(slot);
      chain.forEach(push);
    }
    return out;
  }

  // The plain answer — what a single click selects.
  function hitAt(e) {
    const c = candidatesAt(e);
    return c.length ? c[0] : null;
  }

  // Where the last click landed, so the toolbar's depth stepper can re-probe
  // the same point without a pointer event of its own.
  let cycle = null;   // {x, y, cx, cy, i}

  // The pick used by pointerdown: the TOP candidate, always, plus how deep the
  // stack goes so the caller can offer the way down.
  //
  // Stepping deeper is deliberately NOT bound to a repeat click or to
  // Alt-click, which is what this brief first proposed. Both collide with
  // bindings a reviewer already relies on: a second click on a selected
  // element is the ordinary "I'm about to drag this" gesture (and the v1.6
  // regression suite caught the selection silently jumping away when it
  // cycled), and Alt is the free-the-magnets / bleed-past-the-frame modifier
  // for the drag that may follow this very pointerdown. Double-click is taken
  // twice over (edit text, fill a slot). So the way down is an explicit
  // control — «מתחת N/M ▼» in the toolbar — advertised by the peek box and
  // backed by the layers panel. Same reach, no gesture stolen.
  function pickAt(e) {
    const list = candidatesAt(e);
    if (!list.length) { cycle = null; return null; }
    const p = docPoint(e);
    cycle = { x: p.x, y: p.y, cx: e.clientX, cy: e.clientY, i: 0 };
    return { target: list[0], index: 0, count: list.length };
  }

  // What is directly UNDER the top candidate at this point (drives the peek
  // box). Null when the point is unambiguous, so ordinary hovering is quiet.
  function peekAt(e) {
    const list = candidatesAt(e);
    if (list.length < 2) return null;
    return { target: list[1], index: 1, count: list.length };
  }

  function labelOfTarget(t) {
    if (!t) return '';
    if (t.kind === 'block') return 'טקסט: ' + t.name;
    if (t.kind === 'slot') return 'משבצת תמונה ' + (t.n + 1);
    if (t.kind === 'el') return elLabelOf(t.key);
    const ex = design.extras[t.index];
    if (!ex) return 'שכבה';
    if (ex.type !== 'photo') return 'נכס שנוסף';
    return ex.art ? 'איור שנוסף' : 'תמונה שנוספה';
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

  // the target whose crop gestures (pan drag / wheel / grid) are live:
  // a selected FILLED slot is always in crop mode; a photo extra only with ✂️ on
  function cropTarget() {
    if (!sel) return null;
    if (sel.kind === 'slot' && slotSpec(sel.n)) return sel;
    if (sel.kind === 'extra' && extraCropOn) {
      const ex = design.extras[sel.index];
      // `art` never enters crop mode — there is no ✂️ to turn it on, but
      // extraCropOn is sticky across selections, so without this a leftover
      // «on» from the last photo would hand a drawing live crop gestures
      if (ex && ex.type === 'photo' && !ex.art) return sel;
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

  // UI-ONLY, injected into the composed iframe after every compose — it is
  // never part of a render (like the empty-slot hints, PLAN v1.2).
  //
  // Some decorations are `pointer-events: none` in the template on purpose
  // (house-b-statement's .glow is a 1020px scrim; letting it eat clicks would
  // be wrong in a page). In a render that property means nothing, and in the
  // editor it means the element is unhittable at every pixel — the exact
  // failure v1.8 exists to end, and one that no amount of depth-cycling can
  // fix, because `elementsFromPoint` never reports the element at all.
  // Re-enabling it here (not in the parity block) keeps the composed output a
  // faithful render and still makes every tagged element reachable.
  // !important is load-bearing: the templates scope pointer-events onto their
  // own classes (.t-house-b-statement-v2 .glow), which outranks [data-el].
  const EDITOR_ONLY_CSS = '[data-el]{pointer-events:auto!important}';
  function armIframeHitTesting() {
    const d = doc();
    if (!d || !d.head) return;
    if (d.getElementById('smr-ed-hit')) return;   // survives until the next srcdoc
    const st = d.createElement('style');
    st.id = 'smr-ed-hit';
    st.textContent = EDITOR_ONLY_CSS;
    d.head.appendChild(st);
  }

  function refreshUI() {
    if (destroyed) return;
    armIframeHitTesting();
    paintSlotHints();
    if (sel && sel.kind === 'extra' && !design.extras[sel.index]) sel = null;
    if (sel && sel.kind === 'slot' && !slotEl(sel.n)) sel = null;
    if (sel && sel.kind === 'el' && !elEl(sel.key)) sel = null;
    // companions can go stale the same way the primary can (a deck refresh, an
    // undo that removed an extra) — drop them before anything paints
    selMore = selMore.filter((t) => t.kind !== 'extra' || design.extras[t.index]);
    const g = sel ? geomOf(sel) : null;
    if (!sel) {
      selMore = [];
      selBox.hidden = true; toolbar.hidden = true; gridBox.hidden = true;
      quickBar.hidden = true;
      paintMoreBoxes();
      return;
    }
    placeBox(selBox, g);
    const showHandles = sel.kind === 'extra';
    hRot.style.display = showHandles ? '' : 'none';
    hRz.style.display = showHandles ? '' : 'none';
    const ct = cropTarget();
    if (ct && g) placeBox(gridBox, g); else gridBox.hidden = true;
    paintMoreBoxes();
    toolbar.hidden = false;
    syncPropsPane();
    // follows the selection through scroll, resize and every re-compose; the
    // bar itself is only REBUILT when the selection or its state changes
    if (!editing && !ges) {
      if (quickBar.hidden) renderQuickBar();
      placeQuickBar();
    }
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
    // v2.2: locked keys use the same vocabulary as hidden ones, so the same
    // regex validates them — an unknown key is dropped rather than persisted
    if (design.locked) {
      const l = [];
      for (const k0 of design.locked) {
        const k = String(k0);
        if (RE_HIDDEN_KEY.test(k) && !l.includes(k)) l.push(k);
      }
      if (l.length) design.locked = l; else delete design.locked;
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

  // `d` = {i, n} when the caller picked out of a stack under a point (v1.8);
  // omitted for layers-panel and programmatic selection, which carry no
  // position and so have no stack to step through.
  // v2.1: selecting something on the slide swings the sidebar to «מאפיינים»,
  // the way clicking an object in Canva brings up its controls — EXCEPT when
  // the click came from the layers list (o.keepTab), where yanking the list
  // out from under the pointer would make the next row unreachable.
  function select(t, d, o = {}) {
    if (!sameSel(t, sel)) extraCropOn = false; // crop mode never survives retargeting
    sel = t;
    if (!o.keepGroup) selMore = [];            // a plain click starts a new group
    depth = (d && d.n > 1) ? d : null;
    hoverBox.hidden = true;
    peekBox.hidden = true;
    renderToolbar();
    refreshUI();
    renderLayersPanel(); // highlight follows selection
    if (!o.keepTab && activeTab !== 'props') openTab('props');
  }

  function deselect() {
    sel = null;
    selMore = [];
    extraCropOn = false;
    depth = null;
    cycle = null;
    selBox.hidden = true;
    peekBox.hidden = true;
    toolbar.hidden = true;
    gridBox.hidden = true;
    quickBar.hidden = true;
    paintMoreBoxes();
    syncPropsPane();
    renderLayersPanel();
  }

  // ---------------- multi-select (v2.2) ----------------

  // Everything currently selected, primary first. The ONLY entry point for
  // group-shaped operations — everything else in this file still reads `sel`.
  function targets() {
    return sel ? [sel, ...selMore] : [];
  }

  // A slot has no position of its own (the template owns its box), so it can
  // be selected but never joins a group move or an align.
  const MOVABLE = new Set(['block', 'extra', 'el']);
  const movable = (t) => !!t && MOVABLE.has(t.kind);

  // shift-click: add to the group, or drop it back out if it was already in.
  // Shift-clicking the primary promotes the next companion, so the modifier
  // both adds and removes and never leaves an empty primary behind.
  function toggleInGroup(hit) {
    if (!movable(hit)) return;
    if (!sel) { select(hit); return; }
    if (!movable(sel)) { select(hit); return; }
    if (sameSel(hit, sel)) {
      if (!selMore.length) { deselect(); return; }
      sel = selMore.shift();
    } else {
      const at = selMore.findIndex((t) => sameSel(t, hit));
      if (at >= 0) selMore.splice(at, 1);
      else selMore.push(hit);
    }
    extraCropOn = false;
    depth = null;
    hoverBox.hidden = true;
    peekBox.hidden = true;
    renderToolbar();
    refreshUI();
    renderLayersPanel();
    if (activeTab !== 'props') openTab('props');
  }

  // one outline per companion, pooled — the primary keeps selBox and its
  // handles, so at a glance you can still tell which one a resize would hit
  const moreBoxes = [];
  function paintMoreBoxes() {
    const gs = selMore.map((t) => geomOf(t));
    while (moreBoxes.length < gs.length) {
      const b = el('div', { class: 'smr-edbox smr-edbox--more', hidden: true });
      moreBoxes.push(b);
      overlay.insertBefore(b, selBox);
    }
    for (let i = 0; i < moreBoxes.length; i++) {
      if (i < gs.length && gs[i]) placeBox(moreBoxes[i], gs[i]);
      else moreBoxes[i].hidden = true;
    }
  }

  // Move one target by a delta in slide %. Extras carry an absolute x/y;
  // blocks and els carry an offset FROM wherever the template put them — so
  // "move by" is the only verb that means the same thing for all three, and
  // every group operation is expressed in it.
  function moveTargetBy(t, dx, dy) {
    if (isLocked(t)) return false;
    if (t.kind === 'extra') {
      const ex = design.extras[t.index];
      if (!ex) return false;
      ex.x = round1(clamp((Number(ex.x) || 0) + dx, -20, 100));
      ex.y = round1(clamp((Number(ex.y) || 0) + dy, -20, 100));
      return true;
    }
    if (t.kind === 'block' || t.kind === 'el') {
      const o = t.kind === 'block' ? blockOf(t.name) : elOf(t.key);
      o.dx = round1(clamp((Number(o.dx) || 0) + dx, -60, 60));
      o.dy = round1(clamp((Number(o.dy) || 0) + dy, -60, 60));
      return true;
    }
    return false;   // slot
  }

  // geomOf reports in DOC units (the rects come from inside the iframe), so
  // the arithmetic below is all in 1080×1350 space and only the final delta
  // is converted to the % the design stores.
  function alignSel(edge) {
    const list = targets().filter(movable);
    if (!list.length) return;
    const gs = list.map((t) => ({ t, g: geomOf(t) })).filter((x) => x.g);
    if (!gs.length) return;
    // one thing selected → align it to the slide; a group → align the group's
    // members to each other, which is what every editor means by "align left"
    // once more than one thing is in hand
    let lo, hi;
    const horiz = edge === 'left' || edge === 'center' || edge === 'right';
    if (gs.length === 1) {
      lo = 0; hi = horiz ? W : H;
    } else {
      lo = Math.min(...gs.map((x) => (horiz ? x.g.cx - x.g.w / 2 : x.g.cy - x.g.h / 2)));
      hi = Math.max(...gs.map((x) => (horiz ? x.g.cx + x.g.w / 2 : x.g.cy + x.g.h / 2)));
    }
    const mid = (lo + hi) / 2;
    let moved = false;
    for (const { t, g } of gs) {
      const half = horiz ? g.w / 2 : g.h / 2;
      const cur = horiz ? g.cx : g.cy;
      const want = (edge === 'left' || edge === 'top') ? lo + half
        : (edge === 'right' || edge === 'bottom') ? hi - half : mid;
      const dpx = want - cur;
      if (Math.abs(dpx) < 0.5) continue;
      const dPct = dpx / (horiz ? W : H) * 100;
      if (moveTargetBy(t, horiz ? dPct : 0, horiz ? 0 : dPct)) moved = true;
    }
    if (!moved) return;
    commit();
    renderToolbar();
  }

  // Even the GAPS, not the centres — three boxes of different widths spaced by
  // centre still look uneven, which is the whole reason "distribute" exists.
  function distributeSel(axis) {
    const list = targets().filter(movable);
    if (list.length < 3) return;
    const gs = list.map((t) => ({ t, g: geomOf(t) })).filter((x) => x.g);
    if (gs.length < 3) return;
    const horiz = axis === 'x';
    const size = (x) => (horiz ? x.g.w : x.g.h);
    const start = (x) => (horiz ? x.g.cx - x.g.w / 2 : x.g.cy - x.g.h / 2);
    gs.sort((a, b) => start(a) - start(b));
    const first = gs[0], last = gs[gs.length - 1];
    const span = (start(last) + size(last)) - start(first);
    const used = gs.reduce((s, x) => s + size(x), 0);
    const gap = (span - used) / (gs.length - 1);
    let cursor = start(first) + size(first) + gap;
    let moved = false;
    for (let i = 1; i < gs.length - 1; i++) {
      const x = gs[i];
      const dpx = cursor - start(x);
      cursor += size(x) + gap;
      if (Math.abs(dpx) < 0.5) continue;
      const dPct = dpx / (horiz ? W : H) * 100;
      if (moveTargetBy(x.t, horiz ? dPct : 0, horiz ? 0 : dPct)) moved = true;
    }
    if (!moved) return;
    commit();
    renderToolbar();
  }

  // v1.8: the depth stepper — «2/4 ▼» in every selection toolbar when more
  // than one thing sits under the click that made the selection. Clicking it
  // walks one level further down the same stack, which is the keyboard-free,
  // no-modifier way past a paragraph that is sitting on the thing you want.
  // Returns null when the selection was unambiguous, so ordinary toolbars are
  // unchanged.
  function depthStepper() {
    if (!depth || depth.n < 2 || !cycle) return null;
    return el('button', {
      class: 'btn btn--ghost smr-edtb__depth', type: 'button',
      title: 'מתחת לסימון הזה יש עוד ' + (depth.n - 1) +
        ' — לחיצה כאן עוברת לשכבה הבאה. גם לוח «שכבות» מגיע לכל אחת מהן.',
      onclick: () => {
        const at = { clientX: cycle.cx, clientY: cycle.cy };
        const list = candidatesAt(at);
        if (list.length < 2) { depth = null; renderToolbar(); return; }
        const i = ((depth.i + 1) % list.length);
        cycle.i = i;
        select(list[i], { i, n: list.length });
      },
    }, (depth.i + 1) + '/' + depth.n + ' ▼');
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

  // ---------------- align & distribute UI (v2.2) ----------------

  const ALIGN_H = [
    ['left', '⇤', 'יישור לשמאל'],
    ['center', '↔', 'מרכוז לרוחב'],
    ['right', '⇥', 'יישור לימין'],
  ];
  const ALIGN_V = [
    ['top', '⤒', 'יישור למעלה'],
    ['middle', '↕', 'מרכוז לגובה'],
    ['bottom', '⤓', 'יישור למטה'],
  ];

  // One row, in every toolbar whose selection can move. With one thing in
  // hand it aligns to the SLIDE; with a group it aligns the group's members
  // to each other — the label says which, because the same six buttons doing
  // two different things is only obvious once you already know.
  function alignRow() {
    const n = targets().filter(movable).length;
    if (!n) return null;
    const btn = ([edge, glyph, title]) => el('button', {
      class: 'smr-edtg', type: 'button', title,
      onclick: () => alignSel(edge),
    }, glyph);
    const rows = [
      el('div', { class: 'smr-edtb__row' },
        el('span', null, n > 1 ? 'יישור זה לזה' : 'יישור לשקף'),
        ALIGN_H.map(btn), ALIGN_V.map(btn)),
    ];
    if (n > 2) {
      rows.push(el('div', { class: 'smr-edtb__row' },
        el('span', null, 'פיזור אחיד'),
        el('button', {
          class: 'smr-edtg smr-edtg--w', type: 'button',
          title: 'מרווחים שווים לרוחב', onclick: () => distributeSel('x'),
        }, '⇹ לרוחב'),
        el('button', {
          class: 'smr-edtg smr-edtg--w', type: 'button',
          title: 'מרווחים שווים לגובה', onclick: () => distributeSel('y'),
        }, '⇳ לגובה')));
    }
    return rows;
  }

  // ---------------- numeric position & size (v2.2) ----------------
  //
  // Everything here was drag-only, which means two slides could never be made
  // to match exactly. The boxes read and write PIXELS at 1080×1350 — the
  // design stores %, but nobody thinks in "3.7% of the slide", and px is what
  // every other editor shows.

  function numBox(label, title, get, set, o = {}) {
    const input = el('input', {
      class: 'field__input smr-ednum', type: 'number',
      step: String(o.step || 1), value: String(Math.round(get())),
    });
    const apply = () => {
      const v = Number(input.value);
      if (!Number.isFinite(v)) { input.value = String(Math.round(get())); return; }
      set(v);
      commit({ defer: 120 });
      refreshUI();
    };
    input.addEventListener('change', apply);
    // Enter commits without waiting for blur; arrows inside the box are the
    // browser's spinner, NOT the editor's nudge (onKey bails on fields)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    return el('label', { class: 'smr-ednum__f', title },
      el('span', null, label), input);
  }

  // ---------------- apply to every slide (v2.2) ----------------
  //
  // A carousel is 5–10 slides, so "change the background" is really "change it
  // ten times". The editor only ever holds ONE slide, so it can't do this
  // itself — it hands the host a description of the change and the host walks
  // its own deck (post.js commits per slide; build.js writes the deck). No
  // host callback → no button, rather than a button that quietly does nothing.
  function applyAllBtn(label, confirmText, payload) {
    if (typeof opts.onApplyAll !== 'function') return null;
    if (!deck) return null;
    const b = el('button', { class: 'btn btn--ghost smr-edall', type: 'button' }, label);
    b.addEventListener('click', () => {
      edModal('החלה על כל הקרוסלה', el('div', { style: { lineHeight: '1.6' } }, confirmText), {
        actions: [
          {
            label: 'החל על כל השקפים',
            primary: true,
            onClick: () => {
              const p = payload();
              if (p) opts.onApplyAll(p);
            },
          },
          { label: 'ביטול' },
        ],
      });
    });
    return b;
  }

  // The lock line, in every single-selection toolbar. When something IS locked
  // this is the only way back — the canvas can't reach it, by design.
  function lockRow() {
    if (!sel || selMore.length) return null;
    if (!lockKeyOf(sel) && sel.kind !== 'extra') return null;
    const on = isLocked(sel);
    const b = el('button', {
      class: 'smr-edtg smr-edtg--w' + (on ? ' on' : ''), type: 'button',
      title: on ? 'שחרור הנעילה — הפריט יחזור לזוז וללחיצות'
        : 'נעילה: הפריט נשאר על השקף אבל לא זז ולא נתפס בלחיצה',
      onclick: () => toggleLock(sel),
    }, on ? '🔒 נעול' : '🔓 נעילה');
    return el('div', { class: 'smr-edtb__row' },
      b,
      on ? el('span', { class: 'smr-edtb__hint' }, 'נעול — לחיצות עוברות דרכו') : null);
  }

  function posRow() {
    if (!sel || !movable(sel) || selMore.length) return null;
    if (isLocked(sel)) return null;
    const px = (pct, dim) => (pct || 0) / 100 * dim;
    const pct = (v, dim) => round1(v / dim * 100);
    const fields = [];
    if (sel.kind === 'extra') {
      const ex = () => design.extras[sel.index];
      if (!ex()) return null;
      fields.push(numBox('X', 'מרחק משמאל השקף, בפיקסלים (רוחב השקף 1080)',
        () => px(ex().x, W), (v) => { ex().x = clamp(pct(v, W), -20, 100); }));
      fields.push(numBox('Y', 'מרחק מראש השקף, בפיקסלים (גובה השקף 1350)',
        () => px(ex().y, H), (v) => { ex().y = clamp(pct(v, H), -20, 100); }));
      fields.push(numBox('רוחב', 'רוחב הפריט בפיקסלים',
        () => px(ex().w || 20, W), (v) => { ex().w = clamp(pct(v, W), 4, 100); }));
      fields.push(numBox('°', 'סיבוב במעלות',
        () => ex().rot || 0, (v) => { ex().rot = Math.round(clamp(v, -180, 180)); }));
    } else {
      const o = () => (sel.kind === 'block' ? blockOf(sel.name) : elOf(sel.key));
      fields.push(numBox('X', 'הזזה מהמקום שהתבנית קבעה, בפיקסלים',
        () => px(o().dx, W), (v) => { o().dx = clamp(pct(v, W), -60, 60); }));
      fields.push(numBox('Y', 'הזזה מהמקום שהתבנית קבעה, בפיקסלים',
        () => px(o().dy, H), (v) => { o().dy = clamp(pct(v, H), -60, 60); }));
    }
    return el('div', { class: 'smr-edtb__row smr-ednum__row' }, fields);
  }

  // what a group selection shows instead of one thing's properties: what is
  // in hand, how to align it, and the two verbs that work on all of it
  function renderGroupToolbar() {
    const list = targets();
    const delB = el('button', {
      class: 'btn btn--ghost smr-edtb__del', type: 'button',
      title: 'מחיקת כל הפריטים המסומנים',
    }, 'מחיקת הכל');
    delB.addEventListener('click', () => deleteSel());
    toolbar.replaceChildren(...[
      el('div', { class: 'smr-edtb__row' },
        el('span', { class: 'smr-edtb__name' }, list.length + ' פריטים מסומנים'),
        delB),
      alignRow(),
      el('div', { class: 'smr-edtb__row smr-edtb__hint' },
        'Shift + לחיצה מוסיפה או מורידה פריט · חצים מזיזים את כולם יחד'),
    ].flat().filter(Boolean));
  }

  function renderToolbar() {
    zoomUI = null;
    if (!sel) { toolbar.hidden = true; quickBar.hidden = true; return; }
    toolbar.hidden = false;
    if (selMore.length) {
      renderGroupToolbar();
      syncPropsPane();
      renderQuickBar();
      requestAnimationFrame(placeQuickBar);
      return;
    }
    if (sel.kind === 'block') renderBlockToolbar(sel.name);
    else if (sel.kind === 'slot') renderSlotToolbar(sel.n);
    else if (sel.kind === 'el') renderElToolbar(sel.key);
    else renderExtraToolbar(sel.index);
    // v1.8: every sub-renderer calls replaceChildren, so the depth stepper is
    // appended after the dispatch — one place, every kind of selection.
    // v2.2 does the same for the two rows that belong to every movable
    // selection, so no sub-renderer had to grow them: exact numbers, and
    // align-to-slide (which is what "align" means with one thing in hand).
    if (!toolbar.hidden) {
      const lr = lockRow();
      if (lr) toolbar.appendChild(lr);
      const pr = posRow();
      if (pr) toolbar.appendChild(pr);
      if (movable(sel)) {
        const ar = alignRow();
        if (ar) for (const r of ar) toolbar.appendChild(r);
      }
    }
    const st = depthStepper();
    if (st && !toolbar.hidden) {
      toolbar.appendChild(el('div', { class: 'smr-edtb__row' },
        el('span', { class: 'smr-edtb__depthlbl' }, 'מתחת'), st));
    }
    syncPropsPane();
    // the canvas bar mirrors the same state, so it is rebuilt from the same
    // call — a bold toggle lights up in both places or in neither
    renderQuickBar();
    requestAnimationFrame(placeQuickBar);
  }

  // ---------------- quick actions: contents & placement (v2.3) ----------------

  function qbBtn(glyph, title, onClick, o = {}) {
    const b = el('button', {
      class: 'smr-edqb__b' + (o.danger ? ' is-danger' : '') + (o.on ? ' on' : '') +
        (o.wide ? ' is-wide' : ''),
      type: 'button', title,
    }, glyph);
    // pointerdown + preventDefault: a quick-bar press must never take focus
    // away from an in-place text edit before its own handler runs (the same
    // trap the ✓/✗ bar documents), and must never reach the slide's deselect.
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); });
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  const qbSep = () => el('span', { class: 'smr-edqb__sep' });

  // «⋯» — the door to the full set. It opens the sidebar's מאפיינים tab and
  // pulses it, so the first time someone presses it they SEE where the rest of
  // the options live, instead of wondering what just happened.
  function qbMore() {
    return qbBtn('⋯', 'כל האפשרויות — בסרגל הצד', () => {
      openTab('props');
      sbPanel.classList.remove('is-pulse');
      void sbPanel.offsetWidth;              // restart the animation
      sbPanel.classList.add('is-pulse');
    });
  }

  function qbLockDel(t, delFn, delTitle) {
    const locked = isLocked(t);
    return [
      qbBtn(locked ? '🔒' : '🔓', locked ? 'שחרור הנעילה' : 'נעילה — נשאר על השקף, מפסיק לזוז',
        () => toggleLock(t), { on: locked }),
      qbBtn('🗑', delTitle, delFn, { danger: true }),
    ];
  }

  function renderQuickBar() {
    if (!sel) { quickBar.hidden = true; return; }
    const kids = [];

    if (selMore.length) {
      kids.push(el('span', { class: 'smr-edqb__n' }, String(targets().length)));
      kids.push(qbBtn('🗑', 'מחיקת כל המסומנים', () => deleteSel(), { danger: true }));
    } else if (sel.kind === 'block') {
      const b = design.blocks[sel.name] || {};
      kids.push(qbBtn('✏️', 'עריכת הטקסט על השקף (או לחיצה כפולה)',
        () => startTextEdit(sel.name, null)));
      kids.push(qbBtn('B', 'מודגש', () => {
        const blk = blockOf(sel.name);
        blk.bold = !blk.bold;
        commit();
        renderToolbar();
      }, { on: !!b.bold }));
      kids.push(qbBtn('I', 'נטוי', () => {
        const blk = blockOf(sel.name);
        blk.italic = !blk.italic;
        commit();
        renderToolbar();
      }, { on: !!b.italic }));
      kids.push(qbSep());
      kids.push(...qbLockDel(sel, () => hideKey(sel.name),
        'הסתרת הטקסט — משחזרים מלוח השכבות'));
    } else if (sel.kind === 'extra') {
      const ex = design.extras[sel.index];
      if (!ex) { quickBar.hidden = true; return; }
      kids.push(qbBtn('⧉', 'שכפול (⌘D)', () => duplicateSel()));
      if (ex.type === 'photo' && !ex.art) {
        kids.push(qbBtn('✂️', extraCropOn ? 'סיום החיתוך' : 'חיתוך ומיקום בתוך המסגרת', () => {
          extraCropOn = !extraCropOn;
          renderToolbar();
          refreshUI();
        }, { on: extraCropOn }));
      }
      // Re-resolved INSIDE the handler, not captured: the quick bar is only
      // rebuilt while it is hidden (refreshUI), so any row that commits without
      // one — every v2.4 photo row does — leaves the `ex` above pointing at an
      // object prune() has already replaced. Writing `back` onto that orphan
      // moved nothing and silently deselected the extra, because indexOf() of a
      // stale object in the fresh array is -1.
      kids.push(qbBtn(ex.back ? '⬆' : '⬇', ex.back ? 'החזרה לקדמת השקף' : 'העברה מאחורי הטקסט', () => {
        const cur = design.extras[sel.index];
        if (!cur) return;
        if (cur.back) delete cur.back; else cur.back = true;
        const { backs, fronts } = bandLists();
        rebuildExtras(backs, fronts, cur);
      }));
      kids.push(qbSep());
      kids.push(...qbLockDel(sel, () => {
        design.extras.splice(sel.index, 1);
        deselect();
        commit();
        renderLayersPanel();
      }, 'מחיקת הפריט'));
    } else if (sel.kind === 'el') {
      kids.push(...qbLockDel(sel, () => hideKey(elHiddenKey(sel.key)),
        'הסתרת האלמנט — משחזרים מלוח השכבות'));
    } else if (sel.kind === 'slot') {
      kids.push(qbBtn('📷', slotSpec(sel.n) ? 'החלפת התמונה' : 'הוספת תמונה למשבצת', () => {
        pickPhoto({
          title: slotSpec(sel.n) ? 'החלפת התמונה במשבצת' : 'איזו תמונה נכנסת למשבצת?',
          onPick: (url) => fillSlot(sel.n, url),
        });
      }));
      kids.push(qbSep());
      kids.push(qbBtn('🗑', 'הסתרת המשבצת — משחזרים מלוח השכבות',
        () => hideKey(slotKeyOf(sel.n)), { danger: true }));
    }

    kids.push(qbSep(), qbMore());
    quickBar.replaceChildren(...kids);
    quickBar.hidden = false;
  }

  // Above the selection, flipped below when the top would clip, clamped to the
  // viewport on both axes. Extras carry a rotate handle 30px above their box,
  // so they get a wider berth — otherwise the bar sits ON the handle and the
  // first thing a drag grabs is a button.
  function placeQuickBar() {
    if (quickBar.hidden || !sel) return;
    const g = geomOf(sel);
    if (!g) { quickBar.hidden = true; return; }
    const s = scale(), ir = irect();
    const bw = quickBar.offsetWidth || 180, bh = quickBar.offsetHeight || 36;
    const gap = sel.kind === 'extra' ? 46 : 12;
    let top = ir.top + (g.cy - g.h / 2) * s - bh - gap;
    if (top < 8) top = ir.top + (g.cy + g.h / 2) * s + gap;
    top = clamp(top, 8, Math.max(8, window.innerHeight - bh - 8));
    const left = clamp(ir.left + g.cx * s - bw / 2, 8, Math.max(8, window.innerWidth - bw - 8));
    quickBar.style.top = top + 'px';
    quickBar.style.left = left + 'px';
  }

  // ---------------- shared property rows (v2.2) ----------------

  // One slider + its readout. getObj() is re-resolved on every event because
  // commit()'s prune replaces the stored objects — a captured reference goes
  // stale after the first change (the same trap zoomRow documents).
  function sliderRow(label, o) {
    const val = el('span', { class: 'smr-edtb__sz' }, o.fmt(o.get()));
    const range = el('input', {
      type: 'range', min: String(o.min), max: String(o.max), step: String(o.step),
      value: String(o.get()),
    });
    range.addEventListener('input', () => {
      o.set(Number(range.value));
      val.textContent = o.fmt(Number(range.value));
      commit({ defer: 140 });
    });
    range.addEventListener('change', () => commit());
    const row = el('div', { class: 'smr-edtb__row' }, el('span', null, label), range, val);
    if (o.reset) {
      const r = el('button', {
        class: 'mini', type: 'button', title: 'חזרה לברירת המחדל של התבנית',
        onclick: () => { o.reset(); commit(); renderToolbar(); },
      }, '↺');
      row.appendChild(r);
    }
    return row;
  }

  // opacity — the one property every editor has and this one did not. Stops at
  // 10%: a 0% element is invisible AND unclickable, which reads as "it broke".
  function opacityRow(getObj) {
    return sliderRow('שקיפות', {
      min: 0.1, max: 1, step: 0.05,
      get: () => { const o = getObj(); return (o && typeof o.opacity === 'number') ? o.opacity : 1; },
      set: (v) => {
        const o = getObj();
        if (!o) return;
        if (v >= 0.999) delete o.opacity; else o.opacity = Math.round(v * 100) / 100;
      },
      fmt: (v) => Math.round(v * 100) + '%',
    });
  }

  // text alignment, in LOGICAL values — «start» is the RIGHT edge in Hebrew,
  // which is why the labels say ימין/שמאל and the values do not. Words, not
  // glyphs: the arrow glyphs that read as "align right" in an English editor
  // (⯈ ⯇) are missing from the brand's Hebrew faces and rendered as tofu.
  const TEXT_ALIGN = [
    ['start', 'ימין', 'יישור לתחילת השורה (ימין)'],
    ['center', 'מרכז', 'מרכוז'],
    ['end', 'שמאל', 'יישור לסוף השורה (שמאל)'],
    ['justify', 'מלא', 'מיושר לשני הצדדים'],
  ];

  function textRows(name) {
    const b = () => design.blocks[name] || {};
    const alignBtns = TEXT_ALIGN.map(([v, glyph, title]) => el('button', {
      class: 'smr-edtg smr-edtg--w' + (b().align === v ? ' on' : ''), type: 'button', title,
      onclick: () => {
        const blk = blockOf(name);
        if (blk.align === v) delete blk.align; else blk.align = v;
        commit();
        renderToolbar();
      },
    }, glyph));
    return [
      el('div', { class: 'smr-edtb__row' }, el('span', null, 'יישור'), alignBtns),
      sliderRow('גובה שורה', {
        min: 0.8, max: 2.2, step: 0.05,
        get: () => (typeof b().lh === 'number' ? b().lh : 1.2),
        set: (v) => { blockOf(name).lh = Math.round(v * 100) / 100; },
        fmt: (v) => v.toFixed(2),
        reset: () => { delete blockOf(name).lh; },
      }),
      sliderRow('ריווח אותיות', {
        min: -0.05, max: 0.3, step: 0.005,
        get: () => (typeof b().ls === 'number' ? b().ls : 0),
        set: (v) => {
          const blk = blockOf(name);
          if (Math.abs(v) < 0.0025) delete blk.ls; else blk.ls = Math.round(v * 1000) / 1000;
        },
        fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + 'em',
        reset: () => { delete blockOf(name).ls; },
      }),
      opacityRow(() => blockOf(name)),
    ];
  }

  // ---------------- photo styling rows (v2.4) ----------------

  // The border a photo wears, as three rows that read top to bottom: how thick ·
  // what colour · the two presets that predate this control. Thickness is the
  // switch — 0 px IS «no border», so there is no separate on/off toggle to
  // disagree with the slider. The presets stay because designs on disk name
  // them, and because «נייר»/«קו» are how the template library talks.
  //
  // getObj is re-resolved on every event: commit()'s prune REPLACES the stored
  // objects, so a captured reference goes stale after the first change. That
  // trap has bitten zoomRow and sliderRow already; this row inherits the fix.
  function borderRows(getObj) {
    const spec = () => {
      const o = getObj() || {};
      const b = o.border;
      if (b && typeof b === 'object') {
        return { width: Math.round(clamp(Number(b.width) || 0, 0, 48)), color: b.color || 'gold-50' };
      }
      // the legacy presets, in the same numbers the engines resolve them to
      if (b === 'none') return { width: 0, color: 'gold-50' };
      if (b === 'line') return { width: 2, color: 'gold-70' };
      if (b === 'paper') return { width: 3, color: 'gold-50' };
      // NO border key: the default is the paper ring everywhere EXCEPT on
      // shape:"original", where designBorderSpec's `bare` argument means no ring
      // at all. This row has to agree with the engine or the slider reads 3px
      // over a photo that is visibly wearing nothing.
      return o.shape === 'original'
        ? { width: 0, color: 'gold-50' }
        : { width: 3, color: 'gold-50' };
    };
    const write = (patch) => {
      const o = getObj();
      if (!o) return;
      const next = Object.assign(spec(), patch);
      o.border = next.width > 0 ? { color: next.color, width: next.width } : { width: 0 };
    };
    const thickness = sliderRow('עובי מסגרת', {
      min: 0, max: 48, step: 1,
      get: () => spec().width,
      set: (v) => write({ width: Math.round(v) }),
      fmt: (v) => (v > 0 ? Math.round(v) + 'px' : 'בלי'),
    });
    const colors = el('div', { class: 'smr-edtb__row' },
      el('span', null, 'צבע מסגרת'),
      palette.map((p) => el('button', {
        class: 'smr-edsw' + (spec().color === p.name && spec().width > 0 ? ' on' : ''),
        type: 'button', title: p.name,
        style: { background: p.css },
        onclick: () => {
          // picking a colour on a border nobody has thickened yet means "show
          // me one" — otherwise the swatch would answer with nothing visible
          const cur = spec();
          write({ color: p.name, width: cur.width > 0 ? cur.width : 3 });
          commit();
          renderToolbar();
        },
      })));
    const presets = el('div', { class: 'smr-edtb__row' },
      el('span', null, 'מוכנות'),
      [['paper', 'נייר'], ['line', 'קו'], ['none', 'בלי']].map(([v, lab]) =>
        el('button', {
          class: 'smr-edtg smr-edtg--w', type: 'button',
          onclick: () => {
            const o = getObj();
            if (!o) return;
            // «נייר» is normally said by saying nothing — but on shape:"original"
            // absence means NO ring, so there the word has to be written down or
            // the button that names the paper mat would remove it instead.
            if (v !== 'paper') o.border = v;
            else if (o.shape === 'original') o.border = 'paper';
            else delete o.border;
            commit();
            renderToolbar();
          },
        }, lab)));
    return [thickness, colors, presets];
  }

  // The shape library. Every tile draws ITS OWN shape from the same geometry the
  // engines use, so the picker is a preview rather than a word list — «משושה» is
  // not a thing anyone recognises faster than a hexagon. Radius shapes and
  // clip-path shapes are both here; the engine, not this list, owns the values.
  const SHAPE_TILE_CSS = {
    original: '', organic: 'border-radius:47% 53% 44% 56% / 55% 42% 58% 45%',
    'organic-2': 'border-radius:62% 38% 55% 45% / 48% 60% 40% 52%',
    'organic-3': 'border-radius:38% 62% 41% 59% / 63% 39% 61% 37%',
    'blob-soft': 'border-radius:42% 58% 46% 54% / 52% 48% 52% 48%',
    leaf: 'border-radius:68% 6% 68% 6% / 68% 6% 68% 6%',
    arch: 'border-radius:50% 50% 4% 4% / 38% 38% 3% 3%',
    ellipse: 'border-radius:50%', rect: '', rounded: 'border-radius:6%',
    circle: 'border-radius:50%',
    hexagon: 'clip-path:polygon(25% 0%,75% 0%,100% 50%,75% 100%,25% 100%,0% 50%)',
    diamond: 'clip-path:polygon(50% 0%,100% 50%,50% 100%,0% 50%)',
    triangle: 'clip-path:polygon(50% 0%,100% 100%,0% 100%)',
    chevron: 'clip-path:polygon(0% 0%,100% 0%,100% 82%,50% 100%,0% 82%)',
    notch: 'clip-path:polygon(0% 0%,88% 0%,100% 12%,100% 100%,0% 100%)',
  };

  function shapeRow(getObj) {
    const cur = () => (getObj() || {}).shape || null;
    const tile = (s) => {
      const swatch = el('i', { style: { cssText: SHAPE_TILE_CSS[s.key] || '' } });
      // «מקורי» is the absence of a mask, so it is drawn as a plain frame with a
      // dashed edge — a shape tile would be a lie about what it does
      if (s.key === 'original') swatch.classList.add('smr-edshape__orig');
      return el('button', {
        class: 'smr-edshape' + (cur() === s.key ? ' on' : ''),
        type: 'button', title: s.label,
        onclick: () => {
          const o = getObj();
          if (!o) return;
          if (o.shape === s.key) delete o.shape; else o.shape = s.key;
          commit();
          renderToolbar();
        },
      }, swatch, el('span', null, s.label));
    };
    return [
      el('div', { class: 'smr-edtb__row' }, el('span', null, 'צורה')),
      el('div', { class: 'smr-edshapes' },
        PHOTO_SHAPES.filter((s) => s.fam !== 'geo').map(tile)),
      el('div', { class: 'smr-edtb__row smr-edtb__hint' }, 'גיאומטריות'),
      el('div', { class: 'smr-edshapes' },
        PHOTO_SHAPES.filter((s) => s.fam === 'geo').map(tile)),
    ];
  }

  // Frame ratio — what makes cropping a CROP. «מקורי» leaves the frame following
  // the picture (an extra keeps its upload's proportions, a slot keeps the
  // template's box); anything else pins the frame and the picture covers it, so
  // pan and zoom finally have somewhere to move inside.
  function ratioRow(getObj) {
    const cur = () => (getObj() || {}).ratio || 'native';
    return el('div', { class: 'smr-edtb__row' },
      el('span', null, 'יחס'),
      PHOTO_RATIOS.map(([v, lab]) => el('button', {
        class: 'smr-edtg smr-edtg--w' + (cur() === v ? ' on' : ''),
        type: 'button',
        onclick: () => {
          const o = getObj();
          if (!o) return;
          if (v === 'native') delete o.ratio; else o.ratio = v;
          commit();
          renderToolbar();
        },
      }, lab)));
  }

  // The colour wash. Same {color, opacity} shape as the background scrim, and
  // deliberately the same two controls in the same order, so it is one thing to
  // learn. Clicking the active swatch clears it — every colour control here
  // toggles that way (swatchRow does it too), and a wash you cannot remove is
  // worse than one you cannot add.
  function overlayRows(getObj) {
    const ov = () => (getObj() || {}).overlay || null;
    const colors = el('div', { class: 'smr-edtb__row' },
      el('span', null, 'שכבת צבע'),
      palette.map((p) => el('button', {
        class: 'smr-edsw' + ((ov() || {}).color === p.name ? ' on' : ''),
        type: 'button', title: p.name,
        style: { background: p.css },
        onclick: () => {
          const o = getObj();
          if (!o) return;
          if (o.overlay && o.overlay.color === p.name) delete o.overlay;
          else o.overlay = { color: p.name, opacity: (o.overlay || {}).opacity ?? 0.35 };
          commit();
          renderToolbar();
        },
      })));
    const rows = [colors];
    if (ov()) {
      rows.push(sliderRow('עוצמת השכבה', {
        min: 0.05, max: 0.9, step: 0.05,
        get: () => (ov() || {}).opacity ?? 0.35,
        set: (v) => {
          const o = getObj();
          if (o && o.overlay) o.overlay.opacity = Math.round(v * 100) / 100;
        },
        fmt: (v) => Math.round(v * 100) + '%',
      }));
    }
    return rows;
  }

  // Every photo control, in one place, for both surfaces that own a photo — a
  // template slot and a free extra. v1.2 hid crop, border and the rest behind
  // the ✂️ toggle, which is most of why the panel read as «not many options»:
  // the shape and the border have nothing to do with cropping and are always on
  // show now. Only the pan/zoom pair still belongs to crop mode.
  function photoRows(getObj, opts) {
    return [
      shapeRow(getObj),
      ratioRow(getObj),
      borderRows(getObj),
      overlayRows(getObj),
      opacityRow(getObj),
      (opts && opts.zoom) || null,
    ].flat().filter(Boolean);
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
    // a selected filled slot IS crop mode, so its zoom row is always on show —
    // unlike an extra, where ✂️ has to disambiguate drag-the-frame from
    // drag-the-picture-inside-it
    toolbar.replaceChildren(...[
      el('div', { class: 'smr-edtb__row' }, name, swapB, rmB, hideB),
      photoRows(() => slotSpec(n),
        { zoom: zoomRow(() => slotSpec(n), { kind: 'slot', n }) }),
      el('div', { class: 'smr-edtb__row', style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' } },
        'גוררים את התמונה בתוך המסגרת כדי למקם אותה · גלגלת = זום'),
    ].flat().filter(Boolean));
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

    // v2.2: the same text, styled the same way, on every slide of the carousel
    const allB = applyAllBtn('החלת הסגנון על כל השקפים',
      'כל שקף שיש בו טקסט בשם «' + name + '» יקבל את הגופן, הגודל, הצבע, ' +
      'היישור והריווח של השקף הזה. הטקסט עצמו לא משתנה — רק הסגנון.',
      () => ({ type: 'blockStyle', name, style: styleOfBlock(name) }));

    toolbar.replaceChildren(...[
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
      textRows(name),
      allB ? el('div', { class: 'smr-edtb__row' }, allB) : null,
      dragHint(),
    ].flat().filter(Boolean));
  }

  // What "the style" means when it travels to another slide: everything the
  // block carries EXCEPT where it sits. dx/dy are this slide's nudge — copying
  // them would drag the other slides' text off its own layout.
  function styleOfBlock(name) {
    const b = design.blocks[name] || {};
    const out = {};
    for (const k of ['font', 'size', 'bold', 'italic', 'color', 'align', 'lh', 'ls', 'opacity']) {
      if (b[k] !== undefined) out[k] = b[k];
    }
    return out;
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
  // Only called for rule:N / torn:N — the two kinds with an exact extracted
  // twin in brand-assets/ (renderElToolbar gates the button).
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

  // decorative-element toolbar (v1.6, widened v1.8): drag hint, scale, palette
  // colour, duplicate, delete-to-hidden, reset — now for every kind the engine
  // tags, not just rules. Colour is offered wherever the ENGINE can honour it
  // (EL_NO_COLOR is the one exception, the lockup), because the token lands on
  // `color` for currentColor-driven marks and on `background` for painted
  // fields and the sweep blob — that choice belongs to the parity block, and
  // duplicating it here is how the two would drift. The lockup's שכפול stays
  // blocked: the JFCS Logomark Masterfile is still the open blocker and the
  // brand stamp is never faked from live-typed HTML.
  function renderElToolbar(key) {
    const e = (design.els || {})[key] || {};
    const kind = key === 'lockup' ? 'lockup' : key.split(':')[0];
    const isLockup = kind === 'lockup';
    const canColor = !EL_NO_COLOR.has(kind);
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
      applyElTransform(elEl(key), cur.dx || 0, cur.dy || 0, cur.scale);
      if (sel) placeBox(selBox, geomOf(sel));
      commit({ defer: 150 });
    });
    scRange.addEventListener('change', () => commit());

    // «שכפול» only where an EQUIVALENT asset really exists: rules and torn
    // edges were extracted into brand-assets/ and match by svg path, so the
    // copy is the same object. An illustration host has no name left in the
    // composed DOM (the svg is inlined), so its שכפול opens the library at
    // the illustrations instead of guessing — and the kinds with no extracted
    // twin at all (fields, sweeps, marks, strokes, literal type) say so
    // plainly. Silently placing ba-rule-wide for a colour field, which is
    // what a shared default would do, is the failure worth avoiding.
    const dupB = isLockup
      ? el('button', {
          class: 'btn btn--ghost is-off', type: 'button', 'aria-disabled': 'true',
          title: 'אין עדיין קובץ לוגו רשמי',
          onclick: () => toast('אין עדיין קובץ לוגו רשמי — חתימת המותג נשארת חלק מהתבנית', 'err'),
        }, 'שכפול')
      : (kind === 'rule' || kind === 'torn')
        ? el('button', {
            class: 'btn btn--ghost', type: 'button',
            title: 'שכפול כנכס מותג חופשי — אפשר לגרור, לסובב ולמחוק',
            onclick: () => duplicateEl(key),
          }, 'שכפול')
        : kind === 'ill'
          ? el('button', {
              class: 'btn btn--ghost', type: 'button',
              title: 'הוספת איור נוסף מהספרייה — האיור שבתבנית נשאר במקומו',
              onclick: () => pickAsset({ kind: 'ill' }),
            }, 'איור נוסף')
          : el('button', {
              class: 'btn btn--ghost is-off', type: 'button', 'aria-disabled': 'true',
              title: 'לאלמנט הזה אין נכס מותג מקביל בספרייה',
              onclick: () => toast('ל”' + elLabelOf(key) +
                '“ אין נכס מקביל בספריית המותג — אפשר להזיז, להגדיל, לצבוע ולהסתיר אותו', 'err'),
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
      canColor
        ? swatchRow(e.color || null, (color) => {
            const cur = elOf(key);
            if (color) cur.color = color; else delete cur.color;
            commit();
            renderToolbar();
          })
        : null,
      opacityRow(() => elOf(key)),
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
    if (ex.type === 'photo' && !ex.art) {
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
        el('span', { class: 'smr-edtb__name' },
          ex.type === 'photo' ? (ex.art ? 'art' : 'photo') : ex.name),
        ex.type === 'brand' ? el('span', null, brandLabel(ex.name)) : null,
        cropB, fwd, back, delB,
      ),
      // brand marks color like ills (currentColor); they never crop/border
      // re-resolved in the handler for the same reason every v2.4 row is: the
      // sibling opacityRow commits without re-rendering this toolbar, so `ex`
      // captured above is an orphan by the time a swatch is clicked
      ex.type === 'ill' || ex.type === 'brand'
        ? swatchRow(ex.color || null, (color) => {
            const cur = design.extras[i];
            if (!cur) return;
            if (color) cur.color = color; else delete cur.color;
            commit();
            renderToolbar();
          })
        : null,
      // v2.4: shape · ratio · border · wash · fade are always on show for a
      // photo. Only the zoom slider is crop-mode work, because only IT competes
      // with the drag gesture; the rest never did, and hiding them behind ✂️ is
      // what made the panel look like it had nothing in it.
      // A drawing that travels as <img> (`art`) gets the plain furniture rows —
      // size, rotation, layer, fade — and none of the photo apparatus. Shape,
      // ratio, crop, ring and wash all assume a photograph; on a logo they are
      // noise at best and a way to mangle it at worst.
      ex.type === 'photo' && !ex.art
        ? photoRows(() => design.extras[i], {
            zoom: extraCropOn
              ? zoomRow(() => design.extras[i], { kind: 'extra', index: i })
              : null,
          })
        : opacityRow(() => design.extras[i]),
      ex.type === 'photo' && !ex.art && extraCropOn
        ? el('div', { class: 'smr-edtb__row', style: { fontSize: '.78rem', color: 'var(--ink-soft,#6b5f63)' } },
            'גוררים את התמונה בתוך המסגרת · גלגלת = זום')
        // out of crop mode the drag moves the FRAME — so the edge rule applies
        : dragHint(),
    ].flat().filter(Boolean));
  }

  // ---------------- add flows ----------------

  // v2.1: the editor's chrome lives in the sidebar now, which sits in normal
  // flow (or, floating, at z 90 — deliberately UNDER .modal-overlay's z 100),
  // so nothing of ours can cover a picker any more. The old hide-and-restore
  // dance around every modal is gone; this stays as the single door so that
  // rule has one place to live if the z-order ever moves again.
  function edModal(title, body, opts) {
    return modal(title, body, opts);
  }

  // ---------------- «ספריית נכסים» — ONE picker (v2.0) ----------------
  //
  // Replaces the three separate pickers (photos / illustrations / brand
  // assets). Everything the board owns is one list: reviewer uploads
  // (source 'upload', bytes in sm-photos) and the studio's own drawings
  // (source 'studio', bytes already in the sm-assets mirror). The host hands
  // the list in through opts.assets with each row's URL already resolved —
  // the editor still never touches the network for state; only for preview
  // bytes it already fetched before (inline brand SVG).
  //
  // What a pick DOES is decided by the asset, not by which button opened the
  // picker — that is the whole point of unifying them:
  //   studio + illustration → {type:'ill',   name}   (inline SVG, recolorable)
  //   studio + brand        → {type:'brand', name}   (inline SVG, recolorable)
  //   any upload            → {type:'photo', url}    (<img>; see below)
  // Uploaded SVGs place as photo extras rather than inline vector extras:
  // inlining would put reviewer-supplied markup into the composed document
  // that render.mjs also rasterizes, and would need a new extra type in the
  // twin PARITY BLOCK (ENGINEERING-NOTES §9). Through <img>/data-URI the
  // vector still scales cleanly; it just does not take a palette colour.

  const KIND_CHIPS = [
    { key: 'all',          label: 'כל הנכסים' },
    { key: 'photo',        label: 'תמונות' },
    { key: 'illustration', label: 'איורים' },
    { key: 'brand',        label: 'נכסי מותג' },
    { key: 'logo',         label: 'לוגו' },
  ];

  // Fallback library for hosts that have not been wired to opts.assets yet:
  // the manifest's studio assets plus whatever photos were handed in. Same
  // shape as a real sm_assets row, so one code path renders both.
  function fallbackAssets() {
    return [
      ...photos.map((p) => ({
        id: 'ph:' + p.url, kind: 'photo', source: 'upload',
        name: p.note || '', label: p.note || '', tags: [], url: p.url, post_id: null,
      })),
      ...illNames.map((n) => ({
        id: 'ill:' + n, kind: 'illustration', source: 'studio',
        name: n, label: '', tags: [],
        url: assetUrl('studio/illustrations/' + n + '.svg'), post_id: null,
      })),
      ...brandAssets.map((b) => ({
        id: 'br:' + b.name, kind: 'brand', source: 'studio',
        name: b.name, label: b.label || '', tags: [],
        url: assetUrl('studio/brand-assets/' + b.name + '.svg'), post_id: null,
      })),
    ];
  }

  function library() {
    const given = Array.isArray(opts.assets) ? opts.assets : null;
    if (!given || !given.length) return fallbackAssets();
    // uploads first (a reviewer's own photo is what they came for), then the
    // studio's drawings; within each, host order (newest-first from store).
    const rank = (a) => (a.source === 'studio' ? 1 : 0);
    return [...given].sort((a, b) => rank(a) - rank(b));
  }

  function assetTitle(a) {
    return a.label || a.name || 'נכס';
  }

  function assetMatches(a, q) {
    if (!q) return true;
    const hay = [a.name, a.label, ...(Array.isArray(a.tags) ? a.tags : [])]
      .join(' ').toLowerCase();
    return hay.includes(q);
  }

  // Place an asset on the slide (the default action when no onPick redirect).
  function placeAsset(a) {
    if (a.source === 'studio' && a.kind === 'illustration') {
      design.extras.push({ type: 'ill', name: a.name, x: 36, y: 34, w: 28 });
      commit();
      select({ kind: 'extra', index: design.extras.length - 1 });
      return;
    }
    if (a.source === 'studio' && a.kind === 'brand') {
      design.extras.push({ type: 'brand', name: a.name, x: 35, y: 40, w: 30 });
      commit();
      select({ kind: 'extra', index: design.extras.length - 1 });
      return;
    }
    // Everything else places as an <img> extra — but an UPLOADED drawing is
    // still a drawing. Only studio assets resolve to the recolourable inline
    // types above (the engines look those up by name in studio/illustrations),
    // so a reviewer's own illustration or logo has to travel as <img>; marking
    // it `art` is what stops the editor from then treating it as a photograph.
    addPhotoExtra(a.url, 50, 52, { art: isArtAsset(a) });
  }

  // What counts as a drawing. KIND is the authority when the library knows it;
  // the URL sniff is the fallback for a file dragged straight off the desktop,
  // where all we have is the name. A PNG logo uploaded as kind:"logo" is caught
  // by the first test, an .svg with no metadata by the second.
  const ART_KINDS = new Set(['illustration', 'brand', 'logo']);
  const isArtUrl = (u) => /^data:image\/svg\+xml/i.test(String(u || '')) ||
    /\.svg(?:[?#]|$)/i.test(String(u || ''));
  const isArtAsset = (a) => !!(a && (ART_KINDS.has(a.kind) || isArtUrl(a.url)));

  // buildLibrary — the one library UI, in two dresses (v2.1).
  //
  //   sidebar «ספרייה» tab : o.inline — a pick PLACES the asset and the pane
  //                          stays open, so adding three things is three
  //                          clicks and no re-opening.
  //   pick-and-return modal: o.onPick(url) — a pick resolves to a URL for the
  //                          caller (fill a photo slot, choose a background)
  //                          and o.dismiss() closes the host modal.
  //
  // o.kind pre-selects a filter chip. Returns {root, draw, focus} — draw() is
  // how the host refreshes it after the board library changes.
  function buildLibrary(o = {}) {
    const inline = !!o.inline;
    const dismiss = typeof o.dismiss === 'function' ? o.dismiss : () => {};
    const hideHost = typeof o.hideHost === 'function' ? o.hideHost : () => {};
    let kind = o.kind || 'all';
    let onlyPost = false;
    let q = '';
    const postId = opts.postId || null;
    const onPick = typeof o.onPick === 'function' ? o.onPick : null;

    const grid = el('div', { class: 'smr-edpick smr-edpick--lib' });
    const chipRow = el('div', { class: 'smr-edchips' });
    const count = el('span', { class: 'smr-edcount' });

    const visible = () => library().filter((a) =>
      (kind === 'all' || a.kind === kind) &&
      (!onlyPost || (postId && a.post_id === postId)) &&
      assetMatches(a, q));

    function card(a) {
      const isVec = a.source === 'studio';
      const holder = isVec ? el('span', { class: 'bsvg' }) : null;
      if (isVec) {
        // brand marks preview as inline SVG so currentColor picks up the
        // accent ink; illustrations are fine (and cheaper) as <img>.
        if (a.kind === 'brand') {
          brandSvgText(a.name).then((svg) => { if (svg && !destroyed) holder.innerHTML = svg; });
        } else {
          holder.appendChild(el('img', { src: a.url, alt: a.name, loading: 'lazy' }));
        }
      }
      const btn = el('button', {
        type: 'button', title: a.name || a.label || '',
        draggable: onPick ? 'false' : 'true',
        onclick: () => {
          dismiss();
          if (onPick) onPick(a.url);
          else placeAsset(a);
        },
      },
        isVec ? holder : el('img', { src: a.url, alt: assetTitle(a), loading: 'lazy' }),
        el('span', { class: 'nm' }, assetTitle(a)),
        a.post_id && postId && a.post_id === postId
          ? el('span', { class: 'smr-edbadge' }, 'בפוסט הזה') : null,
      );
      // uploads stay draggable straight onto the slide (no re-upload). In the
      // modal, hide it a tick after dragstart — removing the source
      // synchronously aborts the drag. In the sidebar there is nothing in the
      // way, so the drag just runs and the pane stays put.
      if (!onPick && a.source !== 'studio') {
        btn.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData(PHOTO_DRAG_MIME, a.url);
          // the library knows this asset's kind; the drop handler will not, so
          // the answer travels WITH the drag. Without it, dragging an uploaded
          // illustration onto the slide made a photo out of it while CLICKING
          // the same tile placed it correctly — the same asset, two behaviours.
          if (isArtAsset(a)) e.dataTransfer.setData(ART_DRAG_MIME, '1');
          e.dataTransfer.effectAllowed = 'copy';
          setTimeout(hideHost, 0);
        });
        btn.addEventListener('dragend', () => dismiss());
      }
      return btn;
    }

    function draw() {
      const list = visible();
      count.textContent = list.length ? `${list.length} נכסים` : '';
      const empty = library().length
        ? 'אין נכס שמתאים לסינון הזה. אפשר להעלות קובץ חדש למעלה.'
        : photosEmptyText;
      grid.replaceChildren(...(list.length
        ? list.map(card)
        : [el('p', { class: 'pv-note' }, empty)]));
    }

    for (const c of KIND_CHIPS) {
      const b = el('button', {
        class: 'chip' + (kind === c.key ? ' chip--on' : ''), type: 'button',
        onclick: () => {
          kind = c.key;
          for (const other of chipRow.children) other.classList.remove('chip--on');
          b.classList.add('chip--on');
          draw();
        },
      }, c.label);
      chipRow.appendChild(b);
    }
    if (postId) {
      const b = el('button', {
        class: 'chip', type: 'button', title: 'רק נכסים שהועלו ישירות לפוסט הזה',
        onclick: () => { onlyPost = !onlyPost; b.classList.toggle('chip--on', onlyPost); draw(); },
      }, 'בפוסט הזה');
      chipRow.appendChild(b);
    }

    const search = el('input', {
      class: 'field__input', type: 'search',
      placeholder: 'חיפוש לפי שם, תווית או תגית',
      oninput: () => { q = search.value.trim().toLowerCase(); draw(); },
    });

    // upload tile — the library is writable from inside the editor, so a
    // reviewer never has to leave the slide to bring in a new photo or logo.
    const file = el('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
      multiple: true, style: { display: 'none' },
    });
    // the label stays short: full-width in the sidebar's narrow panel, the old
    // «(SVG · PNG · JPG · WEBP)» tail wrapped mid-parenthesis in RTL
    const UP_LABEL = '+ העלאת קובץ';
    const upBtn = el('button', {
      class: 'btn btn--ghost', type: 'button',
      title: 'SVG · PNG · JPG · WEBP',
      onclick: () => file.click(),
    }, UP_LABEL);
    file.addEventListener('change', async () => {
      const files = [...file.files];
      file.value = '';
      if (!files.length) return;
      const up = typeof opts.uploadAsset === 'function'
        ? (f) => opts.uploadAsset(f)
        : (typeof opts.uploadFile === 'function' ? (f) => opts.uploadFile(f) : null);
      if (!up) { toast('העלאת נכסים לא מחוברת בעמוד הזה', 'err'); return; }
      upBtn.disabled = true;
      upBtn.textContent = 'מעלים…';
      let last = null;
      for (const f of files) {
        try {
          const res = await up(f);
          if (res && res.url) last = res;
        } catch (err) {
          toast('ההעלאה של ' + (f.name || 'הקובץ') + ' נכשלה: ' + (err && err.message || err), 'err');
        }
      }
      upBtn.disabled = false;
      upBtn.textContent = UP_LABEL;
      if (!last) return;
      // one file: place it immediately (that is what "upload here" means);
      // several: leave them in the grid so the reviewer chooses.
      if (files.length === 1) {
        dismiss();
        if (onPick) onPick(last.url);
        else addPhotoExtra(last.url, 50, 52);
        draw();
        return;
      }
      toast(files.length + ' נכסים נוספו לספרייה');
      draw();
    });

    draw();
    const root = el('div', { class: inline ? 'smr-sb__pane' : null },
      el('div', { class: 'smr-edlibbar' }, search, upBtn, file),
      chipRow,
      count,
      inline ? null : el('div', { style: { height: '8px' } }),
      grid,
    );
    return { root, draw, focus: () => search.focus() };
  }

  // the sidebar's «ספרייה» tab — built once, redrawn whenever it is opened or
  // the host swaps the board library under us (setAssets)
  let libUI = null;
  function renderLibraryPane() {
    if (!libUI) {
      libUI = buildLibrary({ inline: true });
      libPane.replaceChildren(
        el('p', { class: 'smr-sb__hint' },
          'לחיצה מוסיפה לשקף · אפשר גם לגרור נכס ישירות למקום שרוצים.'),
        libUI.root,
      );
    } else {
      libUI.draw();
    }
  }

  // pick-and-return: the library in a modal, handing a URL back to the caller
  function pickAsset(o = {}) {
    let m = null;
    const lib = buildLibrary({
      ...o,
      dismiss: () => { if (m) m.close(); },
      hideHost: () => { if (m) m.root.style.display = 'none'; },
    });
    m = edModal(o.title || 'ספריית נכסים', lib.root);
    setTimeout(() => lib.focus(), 60);
    return m;
  }

  // Slot fill/replace still asks for "a picture" — same one library, opened
  // on the תמונות chip, returning a URL through onPick.
  function pickPhoto(o = {}) {
    pickAsset({ ...o, kind: o.kind || 'photo' });
  }

  // ---------------- slot filling & crop (design.slots v1.2) ----------------

  // Fill (or replace) a template photo slot. A fresh photo starts uncropped;
  // the border choice is a property of the FRAME, so it survives replacement.
  function fillSlot(n, url) {
    if (!design.slots || typeof design.slots !== 'object') design.slots = {};
    const prev = design.slots[String(n)];
    // «החלפה» swaps the PICTURE, not the styling someone spent time on: the
    // shape, ratio, ring, wash and fade all survive a replacement. Only the crop
    // is dropped, because pos/zoom are coordinates into the OLD picture and
    // carrying them across would land the new one somewhere arbitrary.
    // (v1.2 preserved the two legacy border strings and nothing else, so every
    // v2.4 key was silently lost on swap.)
    const spec = prev && typeof prev === 'object'
      ? pruneCropInto({ url }, { ...prev, pos: undefined, zoom: undefined })
      : { url };
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
      // a pinned extra renders object-fit:cover exactly as a slot does, so its
      // pan lives in object-position too; keyed on kind alone, the live drag
      // showed nothing and the move only appeared on the next re-compose
      if (img && photoPinned(obj)) img.style.objectPosition = px + '% ' + py + '%';
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
    // A slot always covers its frame; an EXTRA covers only once its frame is
    // pinned (v2.4 ratio, or circle). Without that second case an extra at
    // ratio 4:5 and zoom 1 reported zero overflow, so the drag guard refused to
    // move `pos` at all — the crop was dead in exactly the gesture the ratio
    // control exists to enable.
    if (t.kind === 'slot' || photoPinned(obj)) {
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
  // o.art (v2.4): this is a DRAWING that happens to travel as <img> — an
  // uploaded illustration, brand mark or logo, or any dropped SVG. It renders
  // exactly like a photo (the engines have one <img> extra type and adding
  // another would mean a new shape in the twin PARITY BLOCK), but the EDITOR
  // must not dress it as one: cropping, masking and matting a drawing is
  // meaningless, and offering it reads as the tool not knowing what it is
  // holding. `art` is editor-only — nothing in either engine reads it — and
  // rides in the design so it survives a reload, exactly as `lock` does.
  function addPhotoExtra(url, xPct, yPct, o) {
    const w = 40;
    const art = !!(o && o.art);
    const ex = {
      type: 'photo', url,
      x: round1(clamp((typeof xPct === 'number' ? xPct : 50) - w / 2, -15, 95)),
      y: round1(clamp((typeof yPct === 'number' ? yPct : 52) - w / 2, -15, 95)),
      w,
      // A photo now arrives as the PICTURE THAT WAS UPLOADED — its own edges,
      // its own proportions, no ring. v1.2 dropped every photo straight into
      // the organic blob, which is a strong design decision to make on someone's
      // behalf before they have even looked at it; the blob is one click away in
      // the shape picker for anyone who wants it. A drawing takes no shape key
      // at all, so it renders as a bare <img> with nothing around it.
      ...(art ? { art: true } : { shape: 'original' }),
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
            // cascade: each additional file lands +4% toward bottom-left.
            // An SVG off the desktop is a drawing — the file's own type says so
            // before any upload URL exists to sniff.
            addPhotoExtra(res.url, xPct + 4 * placed, yPct + 4 * placed,
              { art: /svg/i.test(f.type || '') || isArtUrl(res.url) });
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
    if (url) {
      const art = e.dataTransfer.getData(ART_DRAG_MIME) === '1' || isArtUrl(url);
      addPhotoExtra(url, xPct, yPct, { art });
      return;
    }
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
    quickBar.hidden = true;   // the ✓/✗ bar owns this spot while typing
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

  // Gradients + tints (v1.9). The manifest carries the resolved CSS because
  // this panel renders in the app document, not the slide iframe.
  const gradients = (Array.isArray(man.gradients) && man.gradients.length)
    ? man.gradients : GRADIENT_FALLBACK;
  const TINT_FAM_LABELS = { red: 'אדום', gold: 'זהב', blue: 'כחול', orange: 'כתום' };
  // House families first — red is the primary and gold is the chosen
  // secondary (BRAND.md open decision #1). Blue and orange are the guide's
  // other two groups, available but not the system's default reach.
  const TINT_FAM_ORDER = ['red', 'gold', 'blue', 'orange'];

  function paletteCss(name) {
    const p = palette.find((x) => x.name === name);
    return p ? p.css : null;
  }

  // Every tint family this slide is committed to, from ANY source — the
  // background, but also every recoloured block, element and extra. The
  // guide's rule is about the slide, not the background: "select one group of
  // tints (do not mix colors)".
  // Scoping this to design.bg (as it was first written) made it very nearly
  // unfireable, because choosing a tint clears the gradient AND the flat
  // colour, so nothing was left for it to disagree with. The real mixing
  // happens between a tinted background and recoloured marks.
  function tintFamiliesInUse(exclude) {
    const fams = new Set();
    const addToken = (v) => {
      const m = /^(red|blue|orange|gold)-\d+$/.exec(String(v || ''));
      if (m) fams.add(m[1]);
    };
    const bg = design.bg || {};
    if (bg.tint && TINT_FAM_LABELS[bg.tint.color]) fams.add(bg.tint.color);
    addToken(bg.color);
    if (bg.overlay) addToken(bg.overlay.color);
    const g = bg.gradient && gradients.find((x) => x.name === bg.gradient);
    if (g && g.family) fams.add(g.family);
    for (const src of [design.blocks, design.els]) {
      for (const k of Object.keys(src || {})) addToken((src[k] || {}).color);
    }
    for (const ex of (design.extras || [])) addToken((ex || {}).color);
    // Red is every gradient's anchor and the system's primary, so it never
    // makes a slide "mixed" — flagging it would fire on nearly every slide
    // and the warning would stop meaning anything.
    fams.delete('red');
    if (exclude) fams.delete(exclude);
    return [...fams];
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

  function renderBgPanel() {
    if (bgPanel.hidden) return;
    const bg = design.bg || {};
    const kids = [];
    // (the pane's own title is the sidebar header — no in-pane heading here)

    // The scrim control, shared by all three surfaces that can carry one:
    // a photo (as before) and, since v1.9, a gradient or tint. It is the fix
    // for gradient 2's 3.05:1 light end, so it has to be reachable without a
    // photo in play.
    function scrimUI() {
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
    }

    // --- brand fields (recommended) ---
    kids.push(el('h5', null, 'שדות המותג', el('span', { class: 'rec' }, 'מומלץ')));
    kids.push(el('div', { class: 'smr-edbgf' },
      BG_FIELDS.map((f) => el('button', {
        type: 'button',
        class: bg.field === f && !bg.color && !bg.photo && !bg.gradient && !bg.tint ? 'on' : '',
        style: { background: FIELD_PREVIEW[f], color: f === 'deep' ? '#fff' : 'inherit' },
        title: 'החלפת שדה הרקע — הטקסט מתאים את עצמו אוטומטית',
        onclick: () => mutateBg((b) => {
          b.field = f;
          delete b.color; delete b.photo; delete b.pos; delete b.overlay;
          delete b.gradient; delete b.tint;
        }),
      }, FIELD_LABELS[f]))));

    // --- gradients (guide p.10) ---
    // Second, per the brief. Three bars, real sweeps, drawn in reading order.
    kids.push(el('h5', null, 'מעברי צבע'));
    kids.push(el('div', { class: 'smr-edgrad' },
      gradients.map((g) => el('button', {
        type: 'button',
        class: bg.gradient === g.name ? 'on' : '',
        style: { background: g.css },
        title: g.safe
          ? `${g.name} — ניגודיות ${g.worst}:1 לאורך כל המעבר`
          : `${g.name} — יורד ל־${g.worst}:1 בקצה הבהיר; לכותרות בלבד, או עם שכבת הכהיה`,
        onclick: () => mutateBg((b) => {
          if (b.gradient === g.name) { delete b.gradient; return; }
          b.gradient = g.name;
          delete b.tint; delete b.color; delete b.photo; delete b.pos;
        }),
      }, el('span', null, g.label), g.safe ? null : el('span', { class: 'warn' }, '⚠')))));

    // Gradient 2 is the measured failure: --on-deep decays 9.55 -> 3.05 and
    // crosses the 4.5:1 floor at 68% of the sweep. Offer the fix inline rather
    // than only naming the problem — the scrim is one tap away.
    const gSel = bg.gradient && gradients.find((x) => x.name === bg.gradient);
    if (gSel && !gSel.safe && !bg.overlay) {
      kids.push(el('div', { class: 'smr-edwarn' },
        'המעבר הזה בהיר מדי בקצה אחד לטקסט גוף. מתאים לכותרות ולעיטורים, ',
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          style: { padding: '2px 8px', fontSize: '.74rem' },
          onclick: () => mutateBg((b) => { b.overlay = { color: 'red-100', opacity: 0.35 }; }),
        }, 'או הוסיפו שכבת הכהיה')));
    }

    // --- tint ramps (guide p.9) ---
    kids.push(el('h5', null, 'גוונים'));
    kids.push(el('div', { class: 'smr-edtint' },
      TINT_FAM_ORDER.map((fam) => el('div', { class: 'smr-edtint__fam' },
        el('span', { class: 'smr-edtint__nm' }, TINT_FAM_LABELS[fam]),
        el('div', { class: 'smr-edtint__ramp' },
          TINT_STEP_LIST.map((step) => {
            const css = paletteCss(`${fam}-${step}`);
            if (!css) return null;
            const on = bg.tint && bg.tint.color === fam && Number(bg.tint.step) === step;
            return el('button', {
              type: 'button',
              class: on ? 'on' : '',
              style: { background: css },
              title: `${fam}-${step} · ${css}`,
              onclick: () => mutateBg((b) => {
                if (b.tint && b.tint.color === fam && Number(b.tint.step) === step) {
                  delete b.tint; return;
                }
                b.tint = { color: fam, step };
                delete b.gradient; delete b.color; delete b.photo; delete b.pos;
              }),
            });
          })),
      ))));

    // The guide's one rule about tints, enforced as a warning. Never a block:
    // a deliberate two-family slide is the operator's call, not the tool's.
    if (bg.tint) {
      const others = tintFamiliesInUse(bg.tint.color);
      if (others.length) {
        kids.push(el('div', { class: 'smr-edwarn' },
          '⚠ המדריך מתיר קבוצת גוונים אחת לשקף. כאן מעורבות גם: ' +
          others.map((f) => TINT_FAM_LABELS[f] || f).join(', ')));
      }
    }

    // Scrim for a gradient/tint surface. With a photo it renders further down,
    // beside the focal-point control, where it has always lived.
    if ((bg.gradient || bg.tint) && !bg.photo) scrimUI();

    // --- flat color ---
    kids.push(el('h5', null, 'צבע אחיד'));
    kids.push(swatchRow(bg.color || null, (color) => mutateBg((b) => {
      if (color) {
        b.color = color;
        delete b.photo; delete b.pos; delete b.overlay;
        delete b.gradient; delete b.tint;
      } else delete b.color;
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

      scrimUI();
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
      const all = applyAllBtn('החלת הרקע הזה על כל השקפים',
        'כל שקפי הקרוסלה יקבלו בדיוק את הרקע הזה. אפשר לבטל עם ⌘Z.',
        () => ({ type: 'bg', bg: deepCopy(design.bg) }));
      if (all) kids.push(all);
      kids.push(el('button', {
        class: 'btn btn--ghost smr-edtb__del', type: 'button',
        onclick: () => { delete design.bg; commit(); renderBgPanel(); renderLayersPanel(); },
      }, 'הסרת הרקע (חזרה לתבנית)'));
    }

    bgPanel.replaceChildren(...kids);
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
    if (idx >= 0) select({ kind: 'extra', index: idx }, null, { keepTab: true });
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
    const lock = lockMini({ kind: 'extra', index: i });
    const row = el('div', {
      class: 'smr-edlyr__row' + (isSel ? ' on' : '') + (ex.lock ? ' is-locked' : ''),
      draggable: 'true',
      onclick: () => select({ kind: 'extra', index: design.extras.indexOf(ex) }, null, { keepTab: true }),
    },
      el('span', { class: 'smr-edlyr__grip', title: 'גוררים לשינוי הסדר' }, '⋮⋮'),
      thumb,
      el('span', { class: 'smr-edlyr__nm' }, extraLabel(ex)),
      lock, flip, del,
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

  // the 🔒 in a layers row — the fast way to lock something down, and the ONLY
  // way back once it is locked (the canvas can't reach a locked thing)
  function lockMini(t) {
    const on = isLocked(t);
    const b = el('button', {
      class: 'mini' + (on ? ' mini--locked' : ''), type: 'button',
      title: on ? 'שחרור הנעילה' : 'נעילה — נשאר על השקף, מפסיק לזוז ולתפוס לחיצות',
    }, on ? '🔒' : '🔓');
    b.addEventListener('click', (e) => { e.stopPropagation(); toggleLock(t); });
    return b;
  }

  function bgRowSummary() {
    const bg = design.bg;
    if (!bg) return 'ברירת המחדל של התבנית';
    if (bg.photo) return 'תמונת רקע' + (bg.overlay ? ' + כיסוי' : '');
    if (bg.gradient) {
      const g = gradients.find((x) => x.name === bg.gradient);
      return 'מעבר: ' + ((g && g.label) || bg.gradient) + (bg.overlay ? ' + כיסוי' : '');
    }
    if (bg.tint) {
      return 'גוון: ' + (TINT_FAM_LABELS[bg.tint.color] || bg.tint.color) +
        ' ' + bg.tint.step + '%' + (bg.overlay ? ' + כיסוי' : '');
    }
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
      class: 'smr-edlyr__row' + (isSel ? ' on' : '') + (off ? ' is-off' : '') +
        (!off && isLocked(t) ? ' is-locked' : ''),
      title: off ? 'הוסתר מהשקף — «שחזר» מחזיר אותו'
        : 'שכבת תבנית — אפשר לבחור ולעצב, הסדר קבוע',
    },
      el('span', { class: 'smr-edlyr__grip', style: { visibility: 'hidden' } }, '⋮⋮'),
      el('span', { class: 'smr-edlyr__nm' }, label),
      off ? el('button', {
        class: 'mini mini--restore', type: 'button', title: 'החזרת הפריט לשקף',
        onclick: (e) => { e.stopPropagation(); restoreKey(key); },
      }, 'שחזר') : lockMini(t),
    );
    if (!off) row.addEventListener('click', () => select(t, null, { keepTab: true }));
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
              title: 'כל מה שהתבנית מציירת — איורים, שדות צבע, קווים, סימנים, ' +
                'משיחות מרקר, חתימת המותג וטקסט קבוע. אפשר להזיז, להגדיל, ' +
                'לצבוע ולהסתיר; הסדר קבוע. זה המסלול הבטוח לכל אלמנט שקשה ללחוץ עליו.',
            }, 'עיטורי התבנית 🔒 (' + elKeys.length + ')')
          : null,
        elKeys.map((k) => templateRow({ kind: 'el', key: k }, elLabelOf(k))),
        el('div', { class: 'smr-edlyr__band' }, 'מאחורי הטקסט'),
        backs.length
          ? [...backs].reverse().map((ex) => layerRow(ex, 'back'))
          : el('div', { class: 'pv-note', style: { fontSize: '.75rem' } }, '—'),
        el('div', { class: 'smr-edlyr__band' }, 'רקע'),
        el('div', {
          class: 'smr-edlyr__row', title: 'פתיחת עורך הרקע',
          onclick: () => openTab('bg'),
        },
          el('span', { class: 'smr-edlyr__grip', style: { visibility: 'hidden' } }, '⋮⋮'),
          el('span', { class: 'smr-edlyr__nm' }, bgRowSummary()),
        ),
      ),
    ];
    layersPanel.replaceChildren(...kids);
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
    const save = [node.style.translate, node.style.scale];
    const r0 = node.getBoundingClientRect();
    applyElTransform(node, (cur.dx || 0) + 5, (cur.dy || 0) + 5, cur.scale);
    const r1 = node.getBoundingClientRect();
    [node.style.translate, node.style.scale] = save;
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
      // els move on the individual translate/scale properties — write the
      // total the way designElStyle will on the next compose, scale included,
      // and leave any template `transform: rotate(...)` on the element alone
      applyElTransform(node, nx, ny, ((design.els || {})[t.key] || {}).scale);
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

    // v1.8: pickAt returns the whole stack under the pointer and steps one
    // level deeper when the same spot is clicked again — the only way to
    // reach a line behind text or a colour field behind a drawing by
    // pointing at it. Alt is NOT the cycle key here: it already means
    // "free the magnets / bleed past the frame" for the drag that may follow
    // this very pointerdown, and one modifier cannot mean two things in one
    // gesture. Repeat-click cycles, the peek box says what is next, and the
    // layers panel reaches anything the geometry hides completely.
    const pick = pickAt(e);
    const hit = pick && pick.target;
    if (!hit) { deselect(); return; }
    // v2.2 — Shift adds to (or removes from) the group and starts no gesture:
    // a shift-drag would be ambiguous the moment two things are in hand
    if (e.shiftKey) { toggleInGroup(hit); return; }
    const d = { i: pick.index, n: pick.count };
    if (!sameSel(hit, sel)) select(hit, d);
    else if (!depth || depth.n !== pick.count) { depth = pick.count > 1 ? d : null; renderToolbar(); }

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
    // a locked thing selects (from the layers panel it still can) but never
    // drags; the toolbar says so and offers the unlock
    if (isLocked(hit)) return;

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
      // v2.2: the rest of the group rides along. Only the primary snaps and
      // clamps — a magnet per member would fight itself and tear the group
      // apart, so they all take the primary's committed delta.
      mates: sameSel(hit, sel) ? mateSpecs(hit) : [],
    };
    overlay.setPointerCapture(e.pointerId);
  }

  // base positions of every companion, captured at gesture start
  function mateSpecs(primary) {
    return selMore.filter((t) => movable(t) && !sameSel(t, primary)).map((t) => {
      if (t.kind === 'extra') {
        const ex = design.extras[t.index];
        if (!ex) return null;
        return { t, el: targetEl(t), baseDx: ex.x || 0, baseDy: ex.y || 0 };
      }
      const o = (t.kind === 'block' ? design.blocks : (design.els || {}))[
        t.kind === 'block' ? t.name : t.key] || {};
      return { t, el: targetEl(t), baseDx: o.dx || 0, baseDy: o.dy || 0 };
    }).filter(Boolean);
  }

  let hoverRaf = 0;
  function onMove(e) {
    if (ges) {
      e.preventDefault();
      e.stopPropagation();
      const dxc = e.clientX - ges.startX, dyc = e.clientY - ges.startY;
      if (!ges.moved && Math.hypot(dxc, dyc) < 3) return;
      // the quick bar gets out of the way the moment a click becomes a DRAG —
      // a bar chasing the box it belongs to is noise, and it would sit under
      // the pointer at exactly the wrong moment. refreshUI brings it back on
      // release. A click that never moves keeps it, which is the common case.
      if (!ges.moved) quickBar.hidden = true;
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
        if (ges.mates && ges.mates.length) {
          const ddx = nx - ges.baseDx, ddy = ny - ges.baseDy;
          for (const m of ges.mates) liveMove(m.t, m.el, m.baseDx + ddx, m.baseDy + ddy);
        }
        // move the outline live even when the engine element is missing
        const g = geomOf(ges.target);
        if (g && !ges.el) {
          g.cx += (nx - ges.baseDx) / 100 * W;
          g.cy += (ny - ges.baseDy) / 100 * H;
        }
        placeBox(selBox, g);
      } else if (ges.mode === 'resize') {
        const rot = (ges.baseRot || 0) * Math.PI / 180;
        // project pointer delta on the box's local x axis (handle sits on a corner)
        const local = dxc * Math.cos(rot) + dyc * Math.sin(rot);
        ges.liveW = clamp(ges.baseW + (local / s) / W * 100, 4, 100);
        if (ges.el) ges.el.style.width = ges.liveW + '%';
        const g = geomOf(ges.target);
        if (g && !ges.el) { const w = ges.liveW / 100 * W; g.h *= w / g.w; g.w = w; }
        placeBox(selBox, g);
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
      // v1.8 depth peek — what a second click here would reach, and how deep
      // the stack goes. Only shown when it would say something new.
      const pk = peekAt(e);
      if (pk && !sameSel(pk.target, hit)) {
        placeBox(peekBox, geomOf(pk.target));
        // Short on purpose: the tag hangs over whatever is above the box, and
        // the «מתחת ▼» button it points at is already on screen.
        peekTag.textContent = '▼ ' + labelOfTarget(pk.target) +
          ' (' + (pk.index + 1) + '/' + pk.count + ')';
      } else peekBox.hidden = true;
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
      // the group takes the same delta the primary actually landed on —
      // after its magnets and its edge stop, not the raw pointer movement
      if (g.mates && g.mates.length) {
        const ddx = g.liveDx - g.baseDx, ddy = g.liveDy - g.baseDy;
        for (const m of g.mates) moveTargetBy(m.t, ddx, ddy);
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

  // ---------------- keyboard (v2.2) ----------------
  //
  // The editor used to answer exactly one key (Escape). Everything below is
  // the muscle memory anyone arrives with. Two guards decide whether a
  // keystroke is ours at all, and they matter more than the shortcuts:
  //   · an open in-place text edit owns the keyboard completely;
  //   · so does any focused field — the sidebar now HAS fields (the library
  //     search, the numeric position boxes), and without this guard typing
  //     "delete" into the search box would delete the selected element.
  // Undo/redo are not ours to implement: the deck lives in the host, so we
  // just forward to opts.onUndo/onRedo (post.js's stack, build.js's stack).

  const NUDGE = 0.1;        // % of the slide — ≈1px at 1080×1350
  const NUDGE_BIG = 1;      // with Shift — ≈11px

  function typingInField(t) {
    if (!t || t === document.body) return false;
    if (t.isContentEditable) return true;
    return /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '');
  }

  function onKey(e) {
    if (destroyed || editing) return;
    if (typingInField(e.target)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key;

    if (k === 'Escape') {
      if (sel) { deselect(); e.preventDefault(); }
      return;
    }
    if (mod && (k === 'z' || k === 'Z')) {
      const fn = e.shiftKey ? opts.onRedo : opts.onUndo;
      if (typeof fn === 'function') { e.preventDefault(); fn(); }
      return;
    }
    if (mod && (k === 'y' || k === 'Y')) {
      if (typeof opts.onRedo === 'function') { e.preventDefault(); opts.onRedo(); }
      return;
    }
    if (mod && (k === 'c' || k === 'C')) { if (copySel()) e.preventDefault(); return; }
    if (mod && (k === 'v' || k === 'V')) { if (pasteClip()) e.preventDefault(); return; }
    // ⌘D is "bookmark this page" in Chrome, so it is swallowed unconditionally
    // while the editor is armed — offering it and then letting the bookmark
    // dialog open on a text block would be worse than not offering it at all
    if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateSel(); return; }
    if (mod) return;                      // every other ⌘/Ctrl combo is the browser's

    if (k === 'Delete' || k === 'Backspace') {
      if (!sel) return;
      e.preventDefault();
      deleteSel();
      return;
    }
    const step = e.shiftKey ? NUDGE_BIG : NUDGE;
    const d = k === 'ArrowLeft' ? [-step, 0] : k === 'ArrowRight' ? [step, 0]
      : k === 'ArrowUp' ? [0, -step] : k === 'ArrowDown' ? [0, step] : null;
    if (d && sel) { e.preventDefault(); nudgeSel(d[0], d[1]); }
  }

  function nudgeSel(dx, dy) {
    let moved = false;
    for (const t of targets()) if (moveTargetBy(t, dx, dy)) moved = true;
    if (!moved) return;
    // defer the re-compose so a held arrow key streams instead of stuttering
    commit({ defer: 180 });
    renderToolbar();
  }

  function deleteSel() {
    // extras go by index, so delete them high-index-first or the earlier
    // splices shift the later ones out from under us
    const list = targets();
    const idx = list.filter((t) => t.kind === 'extra').map((t) => t.index)
      .sort((a, b) => b - a);
    for (const i of idx) design.extras.splice(i, 1);
    for (const t of list) {
      if (t.kind === 'block') hideOne(t.name);
      else if (t.kind === 'el') hideOne(elHiddenKey(t.key));
      else if (t.kind === 'slot') hideOne(slotKeyOf(t.n));
    }
    deselect();
    commit();
    renderLayersPanel();
  }

  // hideKey() deselects + commits + re-renders on every call; when a delete
  // covers several things we want exactly one of each, at the end
  function hideOne(key) {
    if (!Array.isArray(design.hidden)) design.hidden = [];
    if (!design.hidden.includes(key)) design.hidden.push(key);
  }

  // ---------------- clipboard (v2.2) ----------------
  //
  // `clipboard` is MODULE-level on purpose: moving to the next slide destroys
  // this editor and builds a new one, and copy→next slide→paste is the whole
  // point. Only extras travel — a block or a template element exists because
  // the template drew it, so there is nothing to paste it into.

  function copySel() {
    const ex = sel && sel.kind === 'extra' ? design.extras[sel.index] : null;
    if (!ex) return false;
    clipboard = deepCopy(ex);
    toast('הועתק — הדבקה עם ⌘V, גם בשקף אחר');
    return true;
  }

  function pasteClip() {
    if (!clipboard) return false;
    const ex = deepCopy(clipboard);
    ex.x = round1(clamp((Number(ex.x) || 0) + 3, -20, 100));
    ex.y = round1(clamp((Number(ex.y) || 0) + 3, -20, 100));
    design.extras.push(ex);
    if (ex.type === 'photo' && ex.url && !photos.some((p) => p.url === ex.url)) {
      photos.push({ url: ex.url, note: '' });
    }
    commit();
    select({ kind: 'extra', index: design.extras.length - 1 });
    return true;
  }

  function duplicateSel() {
    if (!sel || sel.kind !== 'extra') return false;
    const ex = design.extras[sel.index];
    if (!ex) return false;
    clipboard = deepCopy(ex);
    return pasteClip();
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

  // open on «מאפיינים» with its empty state: the first thing the sidebar says
  // is what to do next (click something on the slide), not a wall of controls
  openTab('props');

  // ---------------- public handle ----------------

  return {
    destroy() {
      if (destroyed) return;
      if (editing) { try { commitTextEdit(); } catch { /* best effort */ } }
      destroyed = true;
      clearTimeout(changeT);
      clearTimeout(applyT);
      overlay.remove();
      sidebar.remove(); // takes the rail, the toolbar and both panes with it
      editBar.remove();
      quickBar.remove();
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
    // v2.0: the host refreshes the whole board library the same way it
    // refreshes photos — the picker reads opts.assets on every open, so this
    // is all it takes for a new upload to be pickable everywhere at once.
    setAssets(list) {
      opts.assets = Array.isArray(list) ? list : [];
      if (activeTab === 'lib' && libUI) libUI.draw();
    },
    getDesign() { return isEmptyDesign(design) ? null : deepCopy(design); },
    addPhotoExtra,   // (url, xPct, yPct) — host fallback for off-overlay drops
    dropFiles,       // (files, xPct, yPct) — same, for file drops
    startTextEdit,   // (name, ev?) — in-place text editing entry point
    openTab,         // ('props'|'lib'|'bg'|'layers'|'slides') — host tab switch
    // v2.2: hosts bind their own document-level keys (post.js pages slides
    // with the arrows). They need to know whether an arrow press has anything
    // to nudge before they page away from it.
    hasSelection() { return !!sel; },
  };
}
