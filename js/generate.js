// generate.js — the «יצירת תמונות» tab: illustrations · photos · styles · conversion.
// Owner: image-generation module (v2.5). Contract: docs/next-sessions/07.
// Talks to the backend ONLY through store.js; shared UI through ui.js.
//
// WHAT LIVES WHERE, and why the split is not arbitrary:
//
//   fal.ai  → the `generate` Edge Function (store.callGenerator). FAL_KEY must
//             never reach this file. Nothing here knows a fal model id except
//             to render one back from the function's dry-run plan.
//   canvas  → HERE. Two jobs are done in the browser on purpose:
//             (a) SLICING the 9-up sheet into tiles. Deno Edge has no raster
//                 library; a <canvas> gutter-finder is free, deterministic and
//                 inspectable, and the sheet's bytes are already stored so
//                 nothing is lost if this page closes mid-review.
//             (b) BAKING the exact-pixel crop and the feathered edge fade.
//                 Spec 07 is explicit: fades are a client-side alpha mask, not
//                 something to ask fal for — deterministic, free, and editable
//                 later because the recipe rides in the asset's `derived`.
//
// THE COMPOSE PATH IS NOT INVOLVED. A baked fade is alpha in the PNG, so every
// asset this module produces is an ordinary photo/illustration as far as
// compose.js and render.mjs are concerned. Nothing here adds an extra type, a
// design key, or a render branch — the twin PARITY BLOCK gains nothing and
// must not.
//
// STATE SURVIVES TAB SWITCHES. post.js's renderActiveTab() calls
// replaceChildren() on the panel body, which would destroy an in-flight
// generation. So this module builds ONE root element on first mount and hands
// the same node back every time — the same trick post.js already uses for the
// design editor's mount host. A 90-second sheet must survive someone clicking
// «הערות» to re-read a comment.

import {
  callGenerator, listStyles, createStyle, updateStyle, archiveStyle,
  requestStyleFromRefs, saveDerivedAsset, assetChain,
  listAssets, listPhotos, assetRowUrl, photoUrl, uploadAsset,
  GEN_DIMS, dimByKey, FAL_LONG_SIDE_CAP,
} from './store.js';
import { el, modal, toast, fmtDate } from './ui.js';

/* ================================================================== twins */

// ── DIVISION RULE (twin block) ────────────────────────────────────────
// This logic exists TWICE — here and in supabase/functions/generate/index.ts
// divide9() — and MUST stay behaviourally identical. This copy tells the
// reviewer «3 וריאציות לכל שורה» BEFORE they spend $0.16 on a sheet; the
// function's copy decides what the sheet actually contains. If they disagree,
// the preview lies about a purchase.
// Verify: same inputs 1..9 must produce the same array from both.
// Spec 07 §"Route 1": N=9 → one cell each; N<9 → the 9 cells divide evenly,
// remainder to the FIRST inputs (4 → 2 each + 1 extra for the first).
const CELLS = 9;
function divide9(n) {
  const k = Math.max(1, Math.min(CELLS, n | 0));
  const base = Math.floor(CELLS / k);
  const extra = CELLS % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}
// ── END DIVISION RULE (twin block) ────────────────────────────────────

// A COURTESY check, not the gate. The binding English-only guard is gate 4 in
// the Edge Function, which also does the translating and the refusing; this
// copy exists so a therapist typing a Hebrew prompt_en into the style form
// hears about it immediately instead of after a round trip. Never treat a pass
// here as permission — the function checks again, on its own copy, after
// translation.
const ALLOWED_EN = /^[\t\n\r\u0020-\u007E\u00A0-\u024F\u2010-\u2027\u2030-\u205E]*$/;
const englishSafe = (s) => ALLOWED_EN.test(String(s ?? ''));

/* ================================================================== state */

const KIND_LABEL = { illustration: 'איור', photo: 'תמונה' };
const ROUTES = [
  { key: 'ill', label: '✏️ איורים' },
  { key: 'photo', label: '📷 תמונות' },
  { key: 'styles', label: '🎨 סגנונות' },
  { key: 'convert', label: '🔁 המרה לסגנון' },
];
const FADE_SIDES = [
  { key: 'right', label: 'ימין' },
  { key: 'left', label: 'שמאל' },
  { key: 'top', label: 'למעלה' },
  { key: 'bottom', label: 'למטה' },
];
const OP_LABEL = {
  'illustration-sheet': 'גיליון איורים',
  vectorize: 'המרה לוקטור',
  photo: 'יצירת תמונה',
  fade: 'גזירה ודהיית קצה',
  convert: 'המרה לסגנון',
};
const LS_OPKEY = 'smr:genop';

// Local mode has no Edge Function — store.callGenerator() throws by design, so
// every route in this tab is cloud-only. Read straight off the URL rather than
// asking store.js for a new export: `?local=1` is the same signal initStore()
// itself reads, and this file only needs it to say so in words instead of
// letting someone press a button that cannot work. (spec 09 §C)
const IS_LOCAL = new URLSearchParams(location.search).get('local') === '1';

let ROOT = null;          // the persistent element handed back to post.js
let HOST = null;          // the body inside it that each route renders into

const S = {
  postId: null,
  onSaved: null,
  route: 'ill',
  booted: false,
  caps: null,             // the Edge Function's mode:'plan' report
  capsError: '',
  styles: [],
  assets: [],
  photos: [],
  busy: '',               // a human sentence, or '' — one job at a time
  ill: { lines: '', styleId: '', sheet: null, cells: [], tiles: [], picks: new Set(), sliceNote: '' },
  photo: {
    lines: '', styleId: '', dim: GEN_DIMS[0].key, count: 1,
    fadeOn: false, sides: new Set(['right']), feather: 0.18, results: [],
    // §C «אצווה»: one queue, one call in flight, and a state object that is the
    // single source of truth for the progress line — no second counter.
    batch: {
      on: false, lines: '', running: false, cancel: false,
      done: 0, total: 0, landed: 0, current: '', stopped: '', errors: [],
    },
  },
  convert: { src: null, styleId: '', results: [] },
};

const opKey = () => localStorage.getItem(LS_OPKEY) || '';

/* ================================================================== mount */

/**
 * The tab renderer post.js mounts. Builds once, then returns the SAME element
 * forever so an in-flight generation survives a tab switch (see the header).
 */
export function generateTab({ postId = null, onSaved = null } = {}) {
  S.postId = postId;
  if (onSaved) S.onSaved = onSaved;
  if (!ROOT) {
    HOST = el('div', { class: 'gen-body' });
    ROOT = el('div', { class: 'gen', dir: 'rtl' },
      el('div', { class: 'gen-banner', id: 'genBanner' }),
      el('div', { class: 'gen-routes', id: 'genRoutes' }),
      HOST);
    renderRoutes();
    renderBanner();
    render();
    boot().catch(() => {});
  }
  return ROOT;
}

// One cheap probe on first mount: mode:'plan' calls no model, writes no byte
// and spends no budget, so it is safe to fire on boot. It answers the two
// questions the UI cannot answer honestly without it — is the function
// deployed, and is it armed.
async function boot() {
  S.booted = true;
  try {
    const [caps, styles] = await Promise.all([
      callGenerator({ mode: 'plan', operator_key: opKey() }),
      listStyles().catch(() => []),
    ]);
    S.caps = caps;
    // The function reports styles too; prefer the direct read (it is the same
    // rows through the anon grant) and fall back to the function's copy.
    S.styles = styles.length ? styles : (caps.styles || []);
  } catch (e) {
    S.capsError = (e && e.message) || String(e);
    S.styles = await listStyles().catch(() => []);
  }
  pickDefaultStyles();
  refreshAssets().catch(() => {});
  renderBanner();
  render();
}

function pickDefaultStyles() {
  const live = S.styles.filter((s) => !s.archived);
  if (!S.ill.styleId) S.ill.styleId = (live.find((s) => s.kind === 'illustration') || {}).id || '';
  if (!S.photo.styleId) S.photo.styleId = (live.find((s) => s.kind === 'photo') || {}).id || '';
  if (!S.convert.styleId) S.convert.styleId = (live[0] || {}).id || '';
}

async function refreshAssets() {
  const [assets, photos] = await Promise.all([
    listAssets().catch(() => []),
    S.postId ? listPhotos(S.postId).catch(() => []) : Promise.resolve([]),
  ]);
  S.assets = assets;
  S.photos = photos;
  if (S.route === 'convert') render();
}

function setBusy(msg) {
  S.busy = msg || '';
  renderBanner();
  render();
}

/* ================================================================== chrome */

function renderRoutes() {
  const wrap = ROOT.querySelector('#genRoutes');
  wrap.replaceChildren(...ROUTES.map((r) => {
    const b = el('button', {
      class: 'chip' + (S.route === r.key ? ' chip--on' : ''),
      type: 'button',
      onclick: () => { S.route = r.key; renderRoutes(); render(); },
    }, r.label);
    return b;
  }));
}

// The banner states the truth about what this tab can do RIGHT NOW, in words.
// Spec 08's honesty rule applies here too: no fake spinners, no pretending a
// dry run made a picture.
function renderBanner() {
  const wrap = ROOT.querySelector('#genBanner');
  const bits = [];

  if (S.busy) {
    bits.push(el('div', { class: 'gen-note gen-note--work' },
      el('span', { class: 'gen-spin', 'aria-hidden': 'true' }),
      S.busy,
      el('span', { class: 'gen-sub' }, ' — יצירת תמונה לוקחת בין 20 שניות לשתי דקות. אפשר לעבור טאב, העבודה נמשכת.')));
  }

  if (IS_LOCAL) {
    // Not an error — a fact about where this feature lives. The local board has
    // no Edge Function and never will, so saying "unavailable" with a reason
    // beats letting someone press a button that throws.
    bits.push(el('div', { class: 'gen-note gen-note--dry' },
      el('b', null, 'מצב מקומי — יצירת תמונות לא זמינה כאן. '),
      'היא רצה ב-Edge Function בענן, שמחזיק את מפתח fal; ללוח המקומי אין כזה. ',
      'הסגנונות והספרייה כן נקראים, אבל שום כפתור כאן לא ייצור תמונה.'));
  } else if (S.capsError) {
    bits.push(el('div', { class: 'gen-note gen-note--err' },
      el('b', null, 'שירות היצירה לא זמין. '), S.capsError));
  } else if (S.caps && !S.caps.live) {
    bits.push(el('div', { class: 'gen-note gen-note--dry' },
      el('b', null, 'מצב הדגמה. '),
      'השירות מותקן אבל לא מופעל (GENERATE_LIVE), אז כל פעולה מחזירה את הקריאות שהיו נשלחות — ולא נוצרת תמונה ולא מחויב תשלום.'));
  } else if (S.caps && S.caps.live) {
    const g = S.caps.gates || {};
    const left = Math.max(0, (g.daily_image_budget || 0) - (g.images_last_24h || 0));
    bits.push(el('div', { class: 'gen-note' },
      `נותרו ${left} תמונות במכסה היומית של הלוח (${g.images_last_24h || 0} מתוך ${g.daily_image_budget || 0} נוצלו ב-24 השעות האחרונות).`,
      g.translation_available
        ? ' אפשר לכתוב בעברית — התרגום לאנגלית נעשה בשרת.'
        : el('b', null, ' חשוב: כרגע צריך לכתוב את התיאור באנגלית. תרגום אוטומטי לא מוגדר, ועברית לא נשלחת החוצה בשום מקרה.')));
  }

  wrap.replaceChildren(...bits);
}

function render() {
  const fn = { ill: renderIll, photo: renderPhoto, styles: renderStyles, convert: renderConvert }[S.route]
    || renderIll;
  HOST.replaceChildren(...[fn() || []].flat(Infinity).filter(Boolean));
}

/* small shared builders */

function field(label, controlEl, note) {
  return el('div', { class: 'field' },
    el('label', { class: 'field__label' }, label),
    controlEl,
    note ? el('div', { class: 'pv-note' }, note) : null);
}

function styleSelect(kind, current, onChange) {
  const live = S.styles.filter((s) => !s.archived && (!kind || s.kind === kind));
  const sel = el('select', { class: 'field__input', onchange: () => onChange(sel.value) });
  if (!live.length) {
    sel.appendChild(el('option', { value: '' }, 'אין סגנון מתאים — צרו אחד בלשונית «סגנונות»'));
    sel.disabled = true;
    return sel;
  }
  for (const s of live) {
    const o = el('option', { value: s.id }, `${s.name} · v${s.version}${kind ? '' : ` · ${KIND_LABEL[s.kind]}`}`);
    if (s.id === current) o.selected = true;
    sel.appendChild(o);
  }
  return sel;
}

const disabledWhileBusy = () => Boolean(S.busy);

/* ================================================================== canvas */

// Load any URL as a bitmap WITHOUT tainting a canvas. Storage objects live on
// the Supabase origin, so an <img> + getImageData would need crossOrigin to be
// honoured; fetch → blob → createImageBitmap sidesteps the taint question
// entirely, and a CORS failure surfaces as a plain fetch error we can name
// instead of a SecurityError thrown three functions later.
async function bitmapFrom(src) {
  if (src instanceof Blob) return createImageBitmap(src);
  const r = await fetch(src, { mode: 'cors' });
  if (!r.ok) throw new Error(`לא הצלחנו לטעון את התמונה (${r.status})`);
  return createImageBitmap(await r.blob());
}

/**
 * CONTENT-AWARE SLICING, and it fails loudly.
 *
 * The grid in the prompt is a REQUEST, not a guarantee (fal-api.md §8: the
 * layout is produced by the prompt and is therefore never guaranteed), so this
 * finds the white gutters between drawings rather than cutting a fixed 3×3.
 * If it does not find exactly nine cells it returns ok:false and cuts nothing —
 * a sheet that silently yields seven tiles from nine looks like success in the
 * grid and surfaces weeks later as a drawing nobody made. The UI then offers a
 * fixed-grid cut as an EXPLICIT choice.
 *
 * The row-band → column-box walk IS reading order; do not re-sort it. (The
 * studio slicer learned this the hard way: re-sorting by the tallest box
 * rotated tiles 6/7/8 against their labels, and every tile was a good crop of
 * a good drawing, so the contact sheet looked healthy until you read it.)
 */
const INK = 200;          // luminance below this counts as ink
const PAD = 0.158;        // matches studio/art/slice.py: drawing across ~76% of the tile
const TILE = 1024;        // comfortably inside the vectoriser's 256..4096 band

async function sliceSheet(src, { fixed = false } = {}) {
  const bmp = await bitmapFrom(src);
  // 4K sheets are 4096px; work at 2048 so getImageData stays cheap. Tiles come
  // out ~680px before the TILE upscale, still well inside the tracer's band.
  const scale = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
  const W = Math.max(1, Math.round(bmp.width * scale));
  const H = Math.max(1, Math.round(bmp.height * scale));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);

  let boxes;
  let note = '';
  if (fixed) {
    boxes = fixedGrid(W, H);
    note = 'נחתך ברשת קבועה 3×3 לפי בקשה — ייתכן שחלק מהציורים ייחתכו.';
  } else {
    const found = gutterBoxes(ctx, W, H);
    if (found.length === CELLS) {
      boxes = found;
    } else {
      const rescued = gridRescue(found, W, H);
      if (!rescued) {
        return { ok: false, count: found.length, tiles: [], bmp,
          reason: `זוהו ${found.length} ציורים בגיליון במקום ${CELLS}` };
      }
      boxes = rescued;
      note = `זוהו ${found.length} גושי דיו אבל כולם יושבים נקי בתאי רשת 3×3 — נחתך לפי הרשת (ציורים מרובי-חלקים).`;
    }
  }

  const tiles = [];
  for (const [i, b] of boxes.entries()) {
    // Square the box around its own centre, then pad — a tall drawing and a
    // wide one must arrive at the tracer the same shape.
    const side = Math.max(b.w, b.h) * (1 + PAD * 2);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const t = document.createElement('canvas');
    t.width = TILE; t.height = TILE;
    const tc = t.getContext('2d');
    tc.fillStyle = '#ffffff';
    tc.fillRect(0, 0, TILE, TILE);
    tc.drawImage(c, cx - side / 2, cy - side / 2, side, side, 0, 0, TILE, TILE);
    tiles.push({ cell: i + 1, dataUrl: t.toDataURL('image/png') });
  }
  return { ok: true, tiles, note, count: tiles.length };
}

function fixedGrid(W, H) {
  const out = [];
  const cw = W / 3, ch = H / 3;
  for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
    out.push({ x: col * cw, y: r * ch, w: cw, h: ch });
  }
  return out;
}

// GRID RESCUE (2026-08-03). A drawing made of DISCONNECTED parts — «two chairs
// facing each other», a broken-off cup handle beside its cup — detects as two
// ink boxes, so a perfectly drawn sheet counts ≠9 and was refused. If every
// detected box sits wholly inside one cell of the requested 3×3 grid, the grid
// is real and slicing by cells cuts through nothing: accept, union the boxes
// per cell, reading order by construction. A box straddling a cell boundary,
// or an empty cell, still refuses. Twin of scripts/lib/fal-client.mjs
// gridRescue() — keep them identical.
function gridRescue(found, W, H) {
  if (!found.length) return null;
  const cw = W / 3, ch = H / 3;
  const sx = cw * 0.02, sy = ch * 0.02;          // 2% slack on the boundary
  const cellOf = (b) => {
    const c0 = Math.floor((b.x + sx) / cw), c1 = Math.floor((b.x + b.w - 1 - sx) / cw);
    const r0 = Math.floor((b.y + sy) / ch), r1 = Math.floor((b.y + b.h - 1 - sy) / ch);
    if (c0 !== c1 || r0 !== r1) return -1;       // straddles a gutter line
    const c = Math.min(2, Math.max(0, c0));
    const r = Math.min(2, Math.max(0, r0));
    return r * 3 + c;
  };
  const cells = Array.from({ length: CELLS }, () => null);
  for (const b of found) {
    const i = cellOf(b);
    if (i < 0) return null;
    const u = cells[i];
    cells[i] = u ? {
      x: Math.min(u.x, b.x),
      y: Math.min(u.y, b.y),
      w: Math.max(u.x + u.w, b.x + b.w) - Math.min(u.x, b.x),
      h: Math.max(u.y + u.h, b.y + b.h) - Math.min(u.y, b.y),
    } : { x: b.x, y: b.y, w: b.w, h: b.h };
  }
  if (cells.some((cell) => !cell)) return null;  // a missing drawing stays a refusal
  return cells;
}

// Row bands first (top→bottom), then columns inside each band (left→right, and
// in an RTL UI that is still the model's reading order — the prompt asks for
// left-to-right). Output order IS reading order.
function gutterBoxes(ctx, W, H) {
  const img = ctx.getImageData(0, 0, W, H).data;
  const rowInk = new Uint32Array(H);
  const colInkAll = new Uint32Array(W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      // Rec. 601 luma is plenty for "is this ink on white".
      const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
      if (img[p + 3] > 16 && lum < INK) { rowInk[y]++; colInkAll[x]++; }
    }
  }
  const bands = runs(rowInk, H);
  const boxes = [];
  for (const band of bands) {
    const colInk = new Uint32Array(W);
    for (let y = band.a; y <= band.b; y++) {
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
        if (img[p + 3] > 16 && lum < INK) colInk[x]++;
      }
    }
    for (const col of runs(colInk, W)) {
      boxes.push({ x: col.a, y: band.a, w: col.b - col.a + 1, h: band.b - band.a + 1 });
    }
  }
  return boxes;
}

// Contiguous runs of "has ink", ignoring specks. MIN_RUN keeps a stray dot
// from being read as a tenth drawing; MIN_GAP keeps a drawing whose parts do
// not touch (a figure and the object beside it) from splitting in two.
function runs(profile, n) {
  const MIN_RUN = Math.max(8, Math.round(n * 0.02));
  const MIN_GAP = Math.max(6, Math.round(n * 0.015));
  const out = [];
  let a = -1, gap = 0;
  for (let i = 0; i < n; i++) {
    if (profile[i] > 0) {
      if (a < 0) a = i;
      gap = 0;
    } else if (a >= 0) {
      gap++;
      if (gap >= MIN_GAP) {
        const b = i - gap;
        if (b - a + 1 >= MIN_RUN) out.push({ a, b });
        a = -1; gap = 0;
      }
    }
  }
  if (a >= 0 && n - a >= MIN_RUN) out.push({ a, b: n - 1 });
  return out;
}

/**
 * Bake the exact-pixel crop and (optionally) the feathered edge fade.
 *
 * The crop is a COVER crop to the requested pixel size — the Edge Function
 * asked fal for the nearest aspect ratio, and this is the "…and center-crops to
 * exact" half of spec 07's dimensions rule. The fade is a straight alpha mask:
 * destination-out with a linear gradient erases toward the chosen edge, which
 * is why it needs PNG (JPEG has no alpha) and why it is exactly reproducible
 * from the recipe stored in the asset's `derived`.
 *
 * v2.5.1 (spec 10 §C) — THE UPSCALE RULE. The preset list now runs past what
 * the model can draw (6K at 6144px, against fal's ~4096px ceiling), and a cover
 * crop enlarges without comment: ask for 6K, get 6K-shaped pixels that carry
 * 1K of detail, and nothing on screen says so. So this returns what it did:
 * `upscaledFrom` is the MEASURED source size whenever the target is bigger than
 * the source in either axis, and null when it is not.
 *
 * Measured, deliberately, not read off GEN_DIMS[].native. The table says what
 * the model SHOULD return at each preset; the bitmap says what it did. Those are
 * different facts — today the Edge Function does not send `res` at all, so most
 * sources come back around 1K and a table-driven chip would understate the
 * enlargement on every preset above it. The chip has to be true, not tidy.
 */
async function bakePhoto(src, { dim, fade }) {
  const preset = dimByKey(dim) || GEN_DIMS[0];
  const bmp = await bitmapFrom(src);
  const c = document.createElement('canvas');
  c.width = preset.w; c.height = preset.h;
  const ctx = c.getContext('2d');

  const scale = Math.max(preset.w / bmp.width, preset.h / bmp.height);
  const dw = bmp.width * scale, dh = bmp.height * scale;
  ctx.drawImage(bmp, (preset.w - dw) / 2, (preset.h - dh) / 2, dw, dh);

  if (fade && fade.sides && fade.sides.length) {
    const f = Math.min(0.9, Math.max(0.02, Number(fade.feather) || 0.18));
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    for (const side of fade.sides) {
      const span = (side === 'left' || side === 'right') ? preset.w * f : preset.h * f;
      let g;
      if (side === 'right') g = ctx.createLinearGradient(preset.w, 0, preset.w - span, 0);
      else if (side === 'left') g = ctx.createLinearGradient(0, 0, span, 0);
      else if (side === 'top') g = ctx.createLinearGradient(0, 0, 0, span);
      else g = ctx.createLinearGradient(0, preset.h, 0, preset.h - span);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, preset.w, preset.h);
    }
    ctx.restore();
  }

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('לא הצלחנו ליצור את הקובץ');
  const file = new File([blob], `gen-${dim}${fade && fade.sides.length ? '-fade' : ''}.png`, { type: 'image/png' });
  const upscaledFrom = (preset.w > bmp.width || preset.h > bmp.height)
    ? { w: bmp.width, h: bmp.height }
    : null;
  return { file, preset, upscaledFrom };
}

// The chip's words, spec §C verbatim. One place, so the tag on the asset and
// the toast at save time can never say two different numbers.
function upscaleChip(from) {
  return `הוגדל תוכנתית מ-${from.w}×${from.h}`;
}

/* ================================================================== route: illustrations */

function linesOf(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function renderIll() {
  const ta = el('textarea', {
    class: 'field__input gen-lines gen-lines--en', rows: '5', value: S.ill.lines, dir: 'ltr',
    placeholder: 'ENGLISH ONLY — one line = one drawing.\ne.g.  a kettle on the stove with steam\ne.g.  an empty chair by a window',
    oninput: () => { S.ill.lines = ta.value; hint.replaceChildren(...divisionHint(linesOf(ta.value))); },
  });
  const hint = el('div', { class: 'pv-note gen-hint' }, ...divisionHint(linesOf(S.ill.lines)));

  const go = (dry) => async () => {
    const lines = linesOf(S.ill.lines);
    if (!lines.length) { toast('צריך לפחות שורה אחת', 'err'); return; }
    if (lines.length > CELLS) { toast(`עד ${CELLS} שורות בגיליון אחד`, 'err'); return; }
    setBusy(dry ? 'בודקים מה יישלח…' : 'יוצרים גיליון של 9 ציורים…');
    try {
      const res = await callGenerator({
        mode: 'illustration', dry,
        lines, style_id: S.ill.styleId || undefined,
        post_id: S.postId || undefined,
        operator_key: opKey(),
      });
      if (res.status === 'refused') { toast(res.reason || 'הבקשה נדחתה', 'err'); return; }
      if (res.status === 'planned') { showPlan('מה היה נשלח ל-fal', res); return; }
      S.ill.sheet = res.sheet ? { ...res.sheet, url: res.url } : null;
      S.ill.cells = res.cells || [];
      S.ill.picks = new Set();
      S.ill.tiles = [];
      S.ill.sliceNote = '';
      setBusy('חותכים את הגיליון ל-9 ציורים…');
      await doSlice(false);
    } catch (e) {
      toast((e && e.message) || String(e), 'err');
    } finally {
      setBusy('');
    }
  };

  const controls = el('div', { class: 'gen-controls' },
    field('סגנון', styleSelect('illustration', S.ill.styleId, (v) => { S.ill.styleId = v; })),
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--primary', type: 'button', disabled: disabledWhileBusy(), onclick: go(false) }, 'יצירת גיליון'),
      el('button', { class: 'btn btn--ghost', type: 'button', disabled: disabledWhileBusy(), onclick: go(true) }, 'תצוגה יבשה'),
    ));

  return [
    el('p', { class: 'pv-note' },
      'גיליון אחד = תשעה ציורים באותו קו. כותבים שורה לכל ציור שרוצים; אם יש פחות מתשע שורות, ',
      'התאים מתחלקים ביניהן ומקבלים כמה וריאציות לכל שורה. הכול נשמר אוטומטית — וריאציות נערמות כגרסאות בספרייה.'),
    field('מה לצייר', ta),
    hint,
    controls,
    ...renderSheet(),
  ];
}

function divisionHint(lines) {
  if (!lines.length) return ['כל שורה כאן הופכת לציור.'];
  const per = divide9(lines.length);
  if (lines.length === CELLS) return ['תשע שורות — ציור אחד לכל שורה.'];
  return [
    `${lines.length} שורות → `,
    ...per.map((n, i) => el('span', { class: 'gen-chip' }, `שורה ${i + 1}: ${n} וריאציות`)),
  ];
}

async function doSlice(fixed) {
  if (!S.ill.sheet) return;
  try {
    const out = await sliceSheet(S.ill.sheet.url, { fixed });
    if (!out.ok) {
      S.ill.tiles = [];
      S.ill.sliceNote = out.reason;
    } else {
      S.ill.tiles = out.tiles;
      S.ill.sliceNote = out.note || '';
      S.ill.picks = new Set();
    }
  } catch (e) {
    S.ill.tiles = [];
    S.ill.sliceNote = 'החיתוך נכשל: ' + ((e && e.message) || e);
  }
  render();
  // OPERATOR CHANGE 2026-08-03: no pick step. Every sliced drawing files
  // itself to the post + library automatically (variants of one line carry a
  // shared stack tag and pile up as versions there). This runs after BOTH cut
  // paths — the automatic gutter walk and the manual 3×3 rescue.
  if (S.ill.tiles.length) await fileAll();
}

function renderSheet() {
  const sheet = S.ill.sheet;
  if (!sheet) return [];
  const out = [
    el('h4', { class: 'gen-h' }, 'הגיליון'),
    el('img', { class: 'gen-sheet', src: sheet.url, alt: 'גיליון איורים שנוצר', loading: 'lazy' }),
  ];

  if (S.ill.sliceNote && !S.ill.tiles.length) {
    // LOUD, not silent. A sheet that yields the wrong number of cells is the
    // one failure that looks like success in a grid, so the fixed-grid cut is
    // an explicit choice the reviewer makes, never a fallback we take for them.
    out.push(el('div', { class: 'gen-note gen-note--err' },
      el('b', null, 'החיתוך האוטומטי לא הסתדר. '), S.ill.sliceNote, ' ',
      el('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: () => doSlice(true),
      }, 'חיתוך ברשת קבועה 3×3')));
    return out;
  }
  if (S.ill.sliceNote) out.push(el('div', { class: 'gen-note' }, S.ill.sliceNote));
  if (!S.ill.tiles.length) return out;

  const labelFor = (cell) => {
    const c = (S.ill.cells || []).find((x) => x.cell === cell);
    return (c && c.label) || '';
  };

  // Result gallery, not a picker (operator change 2026-08-03): every tile is
  // already on its way to the library, so the cards just show what landed.
  out.push(el('div', { class: 'gen-tiles' }, S.ill.tiles.map((t) => {
    const saved = S.ill.picks.has(t.cell);   // picks now means "filed" ✓
    return el('div', { class: 'gen-tile' + (saved ? ' is-on' : '') },
      el('img', { src: t.dataUrl, alt: labelFor(t.cell) || `ציור ${t.cell}`, loading: 'lazy' }),
      el('div', { class: 'gen-tile__meta' },
        el('span', { class: 'gen-tile__label' }, labelFor(t.cell) || `תא ${t.cell}`),
        el('span', { class: 'gen-tile__mark' }, saved ? '✓ נשמר' : '')));
  })));

  out.push(el('div', { class: 'gen-acts' },
    el('span', { class: 'pv-note' },
      'הכול נשמר אוטומטית לפוסט ולספרייה. וריאציות של אותה שורה נערמות ',
      'כגרסאות של איור אחד — בספרייה לוחצים על איור כדי לדפדף ביניהן, ',
      'וגוררים את הגרסה שרואים אל השקף.')));
  return out;
}

// Files EVERY sliced tile — the pick/save step is gone (operator, 2026-08-03).
// Each pick carries its input-line index so the function can stamp the shared
// stack tag that makes variants of one line pile up as versions in the library.
async function fileAll() {
  const picks = S.ill.tiles.map((t) => {
    const c = (S.ill.cells || []).find((x) => x.cell === t.cell);
    return {
      cell: t.cell,
      label: (c && c.label) || '',
      line: c && Number.isFinite(c.line_index) ? c.line_index : null,
      image: t.dataUrl,
    };
  });
  setBusy(`ממירים ושומרים ${picks.length} ציורים…`);
  try {
    const res = await callGenerator({
      mode: 'illustration-pick',
      sheet_id: S.ill.sheet.id,
      picks, rejected: [],
      post_id: S.postId || undefined,
      operator_key: opKey(),
    });
    if (res.status === 'refused') { toast(res.reason || 'הבקשה נדחתה', 'err'); return; }
    if (res.status === 'planned') { showPlan('מה היה נשלח ל-fal', res); return; }
    if (res.errors && res.errors.length) toast(res.errors.join(' · '), 'err');
    const n = (res.saved || []).length;
    if (n) {
      S.ill.picks = new Set((res.saved || []).map((s) => s.cell).filter((x) => x != null));
      if (!S.ill.picks.size) S.ill.picks = new Set(picks.map((p) => p.cell));
      toast(n === 1 ? 'הציור נשמר בפוסט ובספרייה' : `${n} ציורים נשמרו בפוסט ובספרייה`, 'ok');
      await refreshAssets();
      if (S.onSaved) S.onSaved();
      render();
    }
  } catch (e) {
    toast((e && e.message) || String(e), 'err');
  } finally {
    setBusy('');
  }
}

/* ================================================================== route: photos */

/* ---------------------------------------------------------- §C: batch mode
 * N subject lines → a QUEUE of ordinary photo calls, run one at a time.
 *
 * Three things this deliberately does NOT do:
 *   · it does not invent a second save path. Every call is the same
 *     mode:'photo' the single route already makes, and the function's own
 *     auto-upload is what lands the images in the library (spec 07). Batch adds
 *     a loop and a progress line, nothing else.
 *   · it does not run calls in parallel. fal rate-limits burst submits
 *     (fal-api.md §7, 429) and the per-board daily budget is checked
 *     server-side per call — firing twelve at once would race the budget check
 *     and blow past it.
 *   · it does not keep going after a refusal. A refused call means the board's
 *     daily budget is gone; the honest thing is to stop and say how many
 *     landed, not to hammer the function eleven more times for eleven more
 *     refusals.
 * Cancel stops the queue AFTER the call in flight — that image is already paid
 * for, so abandoning it would throw away something the board was charged for.
 */
async function runBatch() {
  const b = S.photo.batch;
  const lines = linesOf(b.lines);
  if (!lines.length) { toast('צריך לפחות שורה אחת', 'err'); return; }
  if (!S.photo.styleId) { toast('צריך לבחור סגנון תמונה', 'err'); return; }

  Object.assign(b, {
    running: true, cancel: false, done: 0, total: lines.length,
    landed: 0, current: '', stopped: '', errors: [],
  });

  for (const [i, line] of lines.entries()) {
    if (b.cancel) { b.stopped = `בוטל אחרי ${b.done} שורות.`; break; }
    b.current = line;
    setBusy(`אצווה: שורה ${i + 1} מתוך ${lines.length}…`);
    try {
      const res = await callGenerator({
        mode: 'photo',
        lines: [line], style_id: S.photo.styleId,
        dim: S.photo.dim, count: S.photo.count,
        post_id: S.postId || undefined,
        operator_key: opKey(),
      });
      if (res.status === 'refused') { b.stopped = res.reason || 'הבקשה נדחתה'; break; }
      if (res.status === 'planned') {
        // A dry run of a batch is a plan for the FIRST line, not twelve plans.
        b.stopped = 'מצב הדגמה — הוצגו הקריאות של השורה הראשונה בלבד.';
        showPlan('מה היה נשלח ל-fal', res);
        break;
      }
      const saved = res.saved || [];
      b.landed += saved.length;
      S.photo.results = [...saved, ...S.photo.results];
      if (res.errors && res.errors.length) b.errors.push(...res.errors);
    } catch (e) {
      // 429 IS the budget. Anything else is one bad line, and one bad line must
      // not throw away the eleven good ones behind it.
      if (e && e.status === 429) { b.stopped = (e && e.message) || 'המכסה היומית נגמרה'; break; }
      b.errors.push(`«${line.slice(0, 40)}»: ${(e && e.message) || String(e)}`);
    }
    b.done = i + 1;
  }

  b.running = false;
  b.current = '';
  setBusy('');
  await refreshAssets().catch(() => {});
  if (S.onSaved) S.onSaved();
  toast(b.stopped
    ? `האצווה נעצרה — ${b.landed} תמונות נשמרו בספרייה.`
    : `האצווה הסתיימה — ${b.landed} תמונות נשמרו בספרייה.`,
    b.stopped ? 'err' : 'ok');
  render();
}

function renderBatch() {
  const b = S.photo.batch;

  if (IS_LOCAL) {
    return [el('div', { class: 'gen-note gen-note--dry' },
      el('b', null, 'אצווה לא זמינה במצב מקומי. '),
      'יצירת תמונות רצה ב-Edge Function בענן, ובמצב המקומי אין לו קיום — ',
      'אז אין כאן כפתור שמתחזה לעבוד. פותחים את הלוח בענן וזה עובד.')];
  }

  const ta = el('textarea', {
    class: 'field__input gen-lines gen-lines--en', dir: 'ltr', rows: '6', value: b.lines,
    placeholder: 'ENGLISH ONLY — one line = one subject.\ne.g.  a cup of tea on a windowsill, soft morning light\ne.g.  an empty chair in a kitchen\ne.g.  a folded blanket on a sofa',
    oninput: () => { b.lines = ta.value; count.replaceChildren(...batchHint()); },
    disabled: b.running,
  });
  const batchHint = () => {
    const n = linesOf(b.lines).length;
    if (!n) return ['כל שורה כאן הופכת לקריאה נפרדת.'];
    return [`${n} שורות × ${S.photo.count} וריאציות = ${n * S.photo.count} תמונות, ` +
            `ב-${n} קריאות שרצות אחת אחרי השנייה.`];
  };
  const count = el('div', { class: 'pv-note gen-hint' }, ...batchHint());

  const bar = b.total
    ? el('div', { class: 'gen-prog' },
        el('div', { class: 'gen-prog__track' },
          el('div', {
            class: 'gen-prog__fill',
            style: { width: `${Math.round((b.done / Math.max(1, b.total)) * 100)}%` },
          })),
        el('div', { class: 'gen-prog__txt' },
          el('span', { class: 'ltr' }, `${b.done}/${b.total}`),
          ` · ${b.landed} תמונות נשמרו`,
          b.current ? ` · עכשיו: ${b.current.slice(0, 40)}` : ''))
    : null;

  const stopped = b.stopped
    ? el('div', { class: 'gen-note gen-note--err' },
        el('b', null, 'האצווה נעצרה. '), b.stopped, ' ',
        `נשמרו ${b.landed} תמונות מתוך ${b.total} שורות (${b.done} שורות רצו).`)
    : null;

  const errs = b.errors.length
    ? el('div', { class: 'gen-note gen-note--err' },
        el('b', null, `${b.errors.length} שורות נכשלו: `), b.errors.slice(0, 6).join(' · '))
    : null;

  return [
    el('p', { class: 'pv-note' },
      'מדביקים רשימת נושאים, ובוחרים סגנון וגודל למעלה. ',
      'הקריאות רצות אחת אחרי השנייה, לא במקביל, וכל תמונה נשמרת בספרייה מיד. ',
      el('b', null, 'אם המכסה היומית של הלוח נגמרת באמצע — האצווה נעצרת ואומרת כמה נשמרו.')),
    field('הנושאים', ta),
    count,
    bar,
    stopped,
    errs,
    el('div', { class: 'gen-acts' },
      el('button', {
        class: 'btn btn--primary', type: 'button',
        disabled: b.running || Boolean(S.busy),
        onclick: runBatch,
      }, b.running ? 'רץ…' : 'הפעלת האצווה'),
      b.running
        ? el('button', {
            class: 'btn btn--ghost', type: 'button', disabled: b.cancel,
            onclick: () => { b.cancel = true; render(); },
          }, b.cancel ? 'עוצר אחרי הקריאה הנוכחית…' : 'ביטול')
        : null),
  ];
}

function renderPhoto() {
  const ta = el('textarea', {
    class: 'field__input gen-lines gen-lines--en', dir: 'ltr', rows: '4', value: S.photo.lines,
    placeholder: 'ENGLISH ONLY — one line = one photo.\ne.g.  a cup of tea on a windowsill, soft morning light',
    oninput: () => { S.photo.lines = ta.value; },
  });

  // §C: the size list runs past the model's reach, so the one preset the model
  // cannot draw says so BEFORE the money is spent, not after. The note is
  // driven off the table (long side vs FAL_LONG_SIDE_CAP), never off a
  // hard-coded «6k» — add a 8K preset tomorrow and this warns about it too.
  const dimWarn = el('div', { class: 'pv-note' });
  const syncDimWarn = () => {
    const d = dimByKey(S.photo.dim);
    const over = d && Math.max(d.w, d.h) > FAL_LONG_SIDE_CAP;
    dimWarn.hidden = !over;
    dimWarn.textContent = over
      ? `הגודל הזה גדול ממה שהמודל יודע לצייר (עד ${FAL_LONG_SIDE_CAP} פיקסלים בצלע הארוכה). ` +
        'התמונה תוגדל תוכנתית בשמירה, והנכס יסומן בתגית שאומרת מאיזה גודל — בלי הגדלה שקטה.'
      : '';
  };
  const dimSel = el('select', {
    class: 'field__input',
    onchange: () => { S.photo.dim = dimSel.value; syncDimWarn(); },
  });
  for (const d of GEN_DIMS) {
    const o = el('option', { value: d.key }, d.label);
    if (d.key === S.photo.dim) o.selected = true;
    dimSel.appendChild(o);
  }
  syncDimWarn();

  const countSel = el('select', { class: 'field__input', onchange: () => { S.photo.count = Number(countSel.value); } });
  for (const n of [1, 2, 4, 6]) {
    const o = el('option', { value: String(n) }, `${n} וריאציות לכל שורה`);
    if (n === S.photo.count) o.selected = true;
    countSel.appendChild(o);
  }

  const fadeToggle = el('button', {
    class: 'chip' + (S.photo.fadeOn ? ' chip--on' : ''), type: 'button',
    onclick: () => { S.photo.fadeOn = !S.photo.fadeOn; render(); },
  }, S.photo.fadeOn ? 'דהיית קצה' : 'מסגרת חדה');

  const sideChips = S.photo.fadeOn
    ? el('div', { class: 'a-row' },
        FADE_SIDES.map((s) => el('button', {
          class: 'chip' + (S.photo.sides.has(s.key) ? ' chip--on' : ''), type: 'button',
          onclick: () => {
            if (S.photo.sides.has(s.key)) S.photo.sides.delete(s.key); else S.photo.sides.add(s.key);
            render();
          },
        }, s.label)),
        el('button', {
          class: 'chip', type: 'button',
          onclick: () => { S.photo.sides = new Set(FADE_SIDES.map((s) => s.key)); render(); },
        }, 'כל הצדדים'))
    : null;

  const feather = S.photo.fadeOn
    ? el('div', { class: 'gen-range' },
        el('label', { class: 'field__label' }, `עומק הדהייה: ${Math.round(S.photo.feather * 100)}%`),
        el('input', {
          type: 'range', min: '2', max: '60', value: String(Math.round(S.photo.feather * 100)),
          oninput: (e) => { S.photo.feather = Number(e.target.value) / 100; render(); },
        }))
    : null;

  const go = (dry) => async () => {
    const lines = linesOf(S.photo.lines);
    if (!lines.length) { toast('צריך לפחות שורה אחת', 'err'); return; }
    if (!S.photo.styleId) { toast('צריך לבחור סגנון תמונה', 'err'); return; }
    setBusy(dry ? 'בודקים מה יישלח…' : `יוצרים ${lines.length * S.photo.count} תמונות…`);
    try {
      const res = await callGenerator({
        mode: 'photo', dry,
        lines, style_id: S.photo.styleId,
        dim: S.photo.dim, count: S.photo.count,
        post_id: S.postId || undefined,
        operator_key: opKey(),
      });
      if (res.status === 'refused') { toast(res.reason || 'הבקשה נדחתה', 'err'); return; }
      if (res.status === 'planned') { showPlan('מה היה נשלח ל-fal', res); return; }
      if (res.errors && res.errors.length) toast(res.errors.join(' · '), 'err');
      S.photo.results = res.saved || [];
      await refreshAssets();
      if (S.onSaved) S.onSaved();
      toast(`${S.photo.results.length} תמונות נשמרו בספרייה`, 'ok');
    } catch (e) {
      toast((e && e.message) || String(e), 'err');
    } finally {
      setBusy('');
    }
  };

  const b = S.photo.batch;
  const modeChips = el('div', { class: 'a-row gen-modes' },
    el('button', {
      class: 'chip' + (b.on ? '' : ' chip--on'), type: 'button', disabled: b.running,
      onclick: () => { b.on = false; render(); },
    }, 'יחיד'),
    el('button', {
      class: 'chip' + (b.on ? ' chip--on' : ''), type: 'button', disabled: b.running,
      onclick: () => { b.on = true; render(); },
    }, '📚 אצווה'));

  // The style/size/count controls are SHARED by both modes on purpose: they are
  // the same three fal parameters either way, and a second copy would be a
  // second thing to keep in step.
  const controls = el('div', { class: 'gen-grid2' },
    field('סגנון', styleSelect('photo', S.photo.styleId, (v) => { S.photo.styleId = v; })),
    field('גודל', el('div', null, dimSel, dimWarn)),
    field('כמות', countSel),
    b.on ? null
      : field('קצה', el('div', null, el('div', { class: 'a-row' }, fadeToggle), sideChips, feather)),
  );

  if (b.on) {
    return [modeChips, controls, ...renderBatch(), ...renderPhotoResults()];
  }

  return [
    modeChips,
    el('p', { class: 'pv-note' },
      'התמונות שנוצרות נשמרות מיד בספרייה בגודל שהמודל החזיר. ',
      'החיתוך המדויק לגודל שבחרתם והדהייה בקצה נעשים כאן בדפדפן בשמירה — ',
      'כך אפשר לשנות או לבטל אותם אחר כך, והמקור נשאר.'),
    field('מה לצלם', ta),
    controls,
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--primary', type: 'button', disabled: disabledWhileBusy(), onclick: go(false) }, 'יצירת תמונות'),
      el('button', { class: 'btn btn--ghost', type: 'button', disabled: disabledWhileBusy(), onclick: go(true) }, 'תצוגה יבשה'),
    ),
    ...renderPhotoResults(),
  ];
}

function renderPhotoResults() {
  if (!S.photo.results.length) return [];
  return [
    el('h4', { class: 'gen-h' }, 'מה נוצר'),
    el('div', { class: 'gen-tiles' }, S.photo.results.map((r) => el('div', { class: 'gen-tile' },
      el('img', { src: r.url, alt: r.label || 'תמונה שנוצרה', loading: 'lazy' }),
      el('div', { class: 'gen-tile__meta' },
        el('span', { class: 'gen-tile__label' }, r.label || ''),
        el('button', {
          class: 'btn btn--ghost', type: 'button', disabled: disabledWhileBusy(),
          onclick: () => bakeAndSave(r),
        }, S.photo.fadeOn ? 'שמירה עם דהייה' : 'שמירה בגודל מדויק'))))),
  ];
}

async function bakeAndSave(row) {
  const dim = S.photo.dim;
  const fade = S.photo.fadeOn ? { sides: [...S.photo.sides], feather: S.photo.feather } : null;
  if (S.photo.fadeOn && !fade.sides.length) { toast('צריך לבחור לפחות צד אחד לדהייה', 'err'); return; }
  setBusy('מכינים את הקובץ…');
  try {
    const { file, preset, upscaledFrom } = await bakePhoto(row.url, { dim, fade });
    const res = await saveDerivedAsset({
      file,
      kind: 'photo',
      label: row.label || '',
      // §C: the enlargement is a TAG, not a footnote — tags are what the library
      // renders as chips and what its search box reads, so «הוגדל תוכנתית מ-…»
      // travels with the file to whoever finds it six months from now.
      tags: ['generated', 'photo', fade ? 'fade' : 'crop',
        ...(upscaledFrom ? [upscaleChip(upscaledFrom)] : [])],
      post_id: S.postId || null,
      parent_id: row.id,
      // The RECIPE, not the result. This is what makes the fade removable:
      // re-bake from parent_id with a different `fade`, or with none.
      derived: {
        op: 'fade',
        from: row.id,
        // `dim` is stored as the key that was CHOSEN. dimByKey() reads both the
        // §C names and the pre-§C '<w>x<h>' spellings, so a row written before
        // today still resolves and a row written today still will after the
        // next rename.
        crop: { w: preset.w, h: preset.h, dim },
        fade: fade || null,
        upscaled_from: upscaledFrom,   // null when the source was big enough
      },
    });
    if (res.lineage_dropped) toast('נשמר, אבל בלי שרשרת הגזירה (מיגרציה 025 לא הוחלה)', 'err');
    else if (upscaledFrom) toast(`נשמר · ${upscaleChip(upscaledFrom)}`, 'ok');
    else toast('נשמר בספרייה', 'ok');
    await refreshAssets();
    if (S.onSaved) S.onSaved();
  } catch (e) {
    toast((e && e.message) || String(e), 'err');
  } finally {
    setBusy('');
  }
}

/* ================================================================== route: styles */

function renderStyles() {
  const rows = S.styles.slice().sort((a, b) => Number(a.archived) - Number(b.archived));
  return [
    el('p', { class: 'pv-note' },
      'סגנון הוא ניסוח קבוע באנגלית שמלווה כל יצירה — «היד», לא הנושא. ',
      'כל נכס שנוצר זוכר איזה סגנון ואיזו גרסה יצרו אותו, ולכן עריכה של הניסוח מעלה גרסה.'),
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--primary', type: 'button', onclick: () => styleForm(null) }, 'סגנון חדש'),
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: refStyleForm }, 'יצירת סגנון מרפרנסים'),
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: operatorKeyForm }, 'מפתח מפעיל'),
    ),
    rows.length
      ? el('div', { class: 'gen-styles' }, rows.map(styleCard))
      : el('div', { class: 'pv-note' },
          'אין עדיין סגנונות בלוח הזה. אם מיגרציה 025 כבר הוחלה, «קו הבית (סטודיו)» אמור להופיע כאן.'),
  ];
}

function styleCard(s) {
  return el('div', { class: 'gen-style' + (s.archived ? ' is-off' : '') },
    el('div', { class: 'gen-style__head' },
      el('b', null, s.name),
      el('span', { class: 'tag' }, KIND_LABEL[s.kind] || s.kind),
      el('span', { class: 'tag' }, el('span', { class: 'ltr' }, `v${s.version}`)),
      s.archived ? el('span', { class: 'tag' }, 'בארכיון') : null),
    s.notes ? el('div', { class: 'gen-style__notes' }, s.notes) : null,
    el('div', { class: 'gen-style__prompt ltr' }, s.prompt_en || '(אין ניסוח)'),
    el('div', { class: 'a-sub' },
      [s.author ? `נוצר ע״י ${s.author}` : '', s.created_at ? fmtDate(s.created_at) : '']
        .filter(Boolean).join(' · ')),
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => styleForm(s) }, 'עריכה'),
      el('button', {
        class: 'btn btn--ghost', type: 'button',
        onclick: async () => {
          try {
            await archiveStyle(s.id, !s.archived);
            S.styles = await listStyles();
            render();
            toast(s.archived ? 'הוחזר לשימוש' : 'הועבר לארכיון', 'ok');
          } catch (e) { toast((e && e.message) || String(e), 'err'); }
        },
      }, s.archived ? 'החזרה לשימוש' : 'לארכיון')));
}

function styleForm(existing) {
  const kindSel = el('select', { class: 'field__input' },
    el('option', { value: 'illustration' }, 'איור'),
    el('option', { value: 'photo' }, 'תמונה'));
  if (existing) { kindSel.value = existing.kind; kindSel.disabled = true; }

  const name = el('input', { class: 'field__input', type: 'text', maxlength: '80', value: existing ? existing.name : '' });
  const prompt = el('textarea', { class: 'field__input gen-lines ltr', rows: '8', dir: 'ltr', value: existing ? existing.prompt_en : '' });
  const notes = el('textarea', { class: 'field__input', rows: '3', value: existing ? existing.notes : '' });

  const submit = async (close) => {
    const p = prompt.value.trim();
    // Courtesy check only — the Edge Function is the binding guard and will
    // refuse (or translate) again on its own copy. Saying it here just saves a
    // round trip and gives a better sentence.
    if (!englishSafe(p)) {
      toast('הניסוח חייב להיות באנגלית — הוא נשלח למודל, והפלט שלו יושב על CDN ציבורי', 'err');
      return false;
    }
    try {
      if (existing) {
        const bump = p !== (existing.prompt_en || '');
        await updateStyle(existing.id, {
          name: name.value.trim(),
          prompt_en: p,
          notes: notes.value.trim(),
          // Version moves ONLY when the scaffold moves. A rename or a note is
          // not a new hand, and bumping for one would make every earlier asset
          // claim a version that produced nothing different.
          ...(bump ? { version: (existing.version || 1) + 1 } : {}),
        });
      } else {
        await createStyle({
          kind: kindSel.value, name: name.value.trim(), prompt_en: p, notes: notes.value.trim(), refs: [],
        });
      }
      S.styles = await listStyles();
      pickDefaultStyles();
      render();
      toast('נשמר', 'ok');
      if (close) close();
    } catch (e) {
      toast((e && e.message) || String(e), 'err');
      return false;
    }
    return true;
  };

  modal(existing ? 'עריכת סגנון' : 'סגנון חדש', el('div', null,
    field('סוג', kindSel),
    field('שם', name),
    field('הניסוח (אנגלית בלבד)', prompt,
      'זה מה שנשלח למודל. עברית לא עוברת — הפלט של המודל יושב על CDN ציבורי.'),
    field('הערות (עברית בסדר גמור)', notes, 'ההערות נשארות אצלנו ולא נשלחות לשום מקום.'),
    existing ? el('div', { class: 'pv-note' },
      'שינוי הניסוח מעלה את הגרסה, כדי שכל נכס קיים ימשיך להצביע על הניסוח שיצר אותו.') : null,
  ), { actions: [{ label: 'ביטול' }, { label: 'שמירה', primary: true, onClick: (c) => submit(c) }] });
}

// «יצירת סגנון מרפרנסים» — the queue route. Deriving a scaffold from images is
// a vision task, and spec 07 keeps it inside the factory rather than giving an
// Edge Function an API bill: the request queues, the operator's local session
// reads the references and writes the row. State the latency honestly.
function refStyleForm() {
  const kindSel = el('select', { class: 'field__input' },
    el('option', { value: 'illustration' }, 'איור'),
    el('option', { value: 'photo' }, 'תמונה'));
  const name = el('input', { class: 'field__input', type: 'text', maxlength: '80', placeholder: 'איך לקרוא לסגנון' });
  const notes = el('textarea', { class: 'field__input', rows: '3', placeholder: 'מה אהבתם שם? מה חשוב שיישמר?' });
  const refs = el('textarea', {
    class: 'field__input ltr', dir: 'ltr', rows: '4',
    placeholder: 'קישור לבורד ב-Pinterest, או קישורים לתמונות — אחד בכל שורה',
  });

  modal('יצירת סגנון מרפרנסים', el('div', null,
    el('p', { class: 'pv-note' },
      'הבקשה נכנסת לתור. מי שמריץ את הסטודיו מסתכל על הרפרנסים, כותב את הניסוח, והסגנון מופיע כאן. ',
      el('b', null, 'זה לוקח זמן — דקות עד שהסשן במשרד רץ, לא שניות.')),
    field('סוג', kindSel),
    field('שם', name),
    field('רפרנסים', refs),
    field('הערות', notes),
  ), {
    actions: [{ label: 'ביטול' }, {
      label: 'שליחה לתור', primary: true,
      onClick: async (close) => {
        try {
          await requestStyleFromRefs({
            kind: kindSel.value,
            name: name.value.trim(),
            notes: notes.value.trim(),
            refs: linesOf(refs.value).map((url) => ({ kind: 'url', url })),
          });
          toast('הבקשה נשלחה לתור', 'ok');
          if (close) close();
        } catch (e) {
          toast(e && e.pending08
            ? 'תור הבקשות עוד לא הותקן בשרת — אפשר בינתיים ליצור סגנון ידנית'
            : ((e && e.message) || String(e)), 'err');
          return false;
        }
        return true;
      },
    }],
  });
}

// The operator key is a SECOND secret beyond the board key: it lifts the
// function's per-board daily image budget. Kept in localStorage like the
// publisher's, and never sent anywhere but the generate function.
function operatorKeyForm() {
  const input = el('input', { class: 'field__input', type: 'password', value: opKey(), autocomplete: 'off' });
  modal('מפתח מפעיל', el('div', null,
    el('p', { class: 'pv-note' },
      'לא חובה. בלי מפתח אפשר ליצור עד המכסה היומית של הלוח; עם מפתח המכסה לא חלה. ',
      'המפתח נשמר רק בדפדפן הזה.'),
    field('המפתח', input),
  ), {
    actions: [{ label: 'ביטול' }, {
      label: 'שמירה', primary: true,
      onClick: async (close) => {
        const v = input.value.trim();
        if (v) localStorage.setItem(LS_OPKEY, v); else localStorage.removeItem(LS_OPKEY);
        S.booted = false;
        await boot().catch(() => {});
        if (close) close();
        return true;
      },
    }],
  });
}

/* ================================================================== route: convert */

function renderConvert() {
  const file = el('input', {
    type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' },
  });
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0];
    file.value = '';
    if (!f) return;
    // Upload first so the source is a real library asset with an id — that is
    // what lets the derivation chain start at the ORIGINAL rather than at
    // "something someone dragged in once".
    setBusy('מעלים את תמונת המקור…');
    try {
      const up = await uploadAsset({ file: f, kind: 'photo', post_id: S.postId || undefined });
      S.convert.src = { id: up.row.id, url: up.url, label: up.row.label || up.row.name };
      await refreshAssets();
    } catch (e) {
      toast((e && e.message) || String(e), 'err');
    } finally { setBusy(''); }
  });

  const candidates = [
    ...S.photos.map((p) => ({ id: null, url: photoUrl(p), label: p.note || 'תמונה מהפוסט', from: 'post' })),
    ...S.assets.filter((a) => a.kind === 'photo').slice(0, 24)
      .map((a) => ({ id: a.id, url: assetRowUrl(a), label: a.label || a.name, from: 'lib' })),
  ];

  const picker = el('div', { class: 'gen-tiles gen-tiles--sm' }, candidates.map((c) => {
    const on = S.convert.src && S.convert.src.url === c.url;
    const card = el('div', { class: 'gen-tile' + (on ? ' is-on' : '') },
      el('img', { src: c.url, alt: c.label, loading: 'lazy' }),
      el('div', { class: 'gen-tile__meta' }, el('span', { class: 'gen-tile__label' }, c.label)));
    card.addEventListener('click', () => { S.convert.src = c; render(); });
    return card;
  }));

  const go = (dry) => async () => {
    if (!S.convert.src) { toast('צריך לבחור תמונת מקור', 'err'); return; }
    if (!S.convert.styleId) { toast('צריך לבחור סגנון יעד', 'err'); return; }
    setBusy(dry ? 'בודקים מה יישלח…' : 'ממירים לסגנון…');
    try {
      const res = await callGenerator({
        mode: 'convert', dry,
        source: { url: S.convert.src.url, asset_id: S.convert.src.id || undefined },
        style_id: S.convert.styleId,
        label: S.convert.src.label || '',
        post_id: S.postId || undefined,
        operator_key: opKey(),
      });
      if (res.status === 'refused') { toast(res.reason || 'הבקשה נדחתה', 'err'); return; }
      if (res.status === 'planned') { showPlan('מה היה נשלח ל-fal', res); return; }
      if (res.errors && res.errors.length) toast(res.errors.join(' · '), 'err');
      S.convert.results = res.saved || [];
      await refreshAssets();
      if (S.onSaved) S.onSaved();
      toast('ההמרה נשמרה בספרייה', 'ok');
    } catch (e) {
      toast((e && e.message) || String(e), 'err');
    } finally { setBusy(''); }
  };

  return [
    el('p', { class: 'pv-note' },
      'לוקחים תמונה קיימת ומעבירים אותה לסגנון אחר. ',
      el('b', null, 'שימו לב: תמונת המקור נשלחת לשירות חיצוני. '),
      'לא להעלות לכאן תמונות עם פרטים מזהים של מטופלים.'),
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => file.click() }, 'העלאת תמונה'),
      file),
    candidates.length ? el('h4', { class: 'gen-h' }, 'או בוחרים מהפוסט ומהספרייה') : null,
    candidates.length ? picker : null,
    S.convert.src
      ? el('div', { class: 'gen-note' }, 'נבחר: ', el('b', null, S.convert.src.label || 'תמונה'))
      : null,
    field('סגנון יעד', styleSelect(null, S.convert.styleId, (v) => { S.convert.styleId = v; }),
      'המרה לסגנון איור מייצרת איור; המרה לסגנון תמונה מייצרת תמונה.'),
    el('div', { class: 'gen-acts' },
      el('button', { class: 'btn btn--primary', type: 'button', disabled: disabledWhileBusy(), onclick: go(false) }, 'המרה'),
      el('button', { class: 'btn btn--ghost', type: 'button', disabled: disabledWhileBusy(), onclick: go(true) }, 'תצוגה יבשה')),
    ...renderConvertResults(),
  ];
}

function renderConvertResults() {
  if (!S.convert.results.length) return [];
  const out = [
    el('h4', { class: 'gen-h' }, 'התוצאה'),
    el('div', { class: 'gen-tiles' }, S.convert.results.map((r) => el('div', { class: 'gen-tile' },
      el('img', { src: r.url, alt: r.label || 'תוצאת המרה', loading: 'lazy' }),
      el('div', { class: 'gen-tile__meta' },
        el('span', { class: 'gen-tile__label' }, `${KIND_LABEL[r.kind] || r.kind}`))))),
  ];
  const head = S.convert.results[0];
  if (head) out.push(chainView(head.id));
  return out;
}

/**
 * The derivation chain, rendered. Spec 07 asks for this on library hover/detail
 * for ANY asset; this build surfaces it here, where a chain is actually being
 * created and the reviewer can see the original, the restyle, and the trace
 * lined up. Wiring the same view into assets.js / the editor's picker is not
 * done — see the report's known gaps.
 */
function chainView(id) {
  const { node, ancestors, descendants } = assetChain(S.assets, id);
  if (!node) return el('div', { class: 'pv-note' }, 'שרשרת הגזירה תופיע אחרי רענון.');
  const step = (a, here) => el('div', { class: 'gen-chain__step' + (here ? ' is-here' : '') },
    el('img', { src: assetRowUrl(a), alt: a.label || a.name, loading: 'lazy' }),
    el('div', { class: 'a-sub' },
      el('div', null, a.label || a.name || '(ללא שם)'),
      el('div', null, (a.derived && OP_LABEL[a.derived.op]) || (a.source === 'upload' ? 'הועלה' : 'מקור'))));
  return el('div', { class: 'gen-chain' },
    el('h4', { class: 'gen-h' }, 'שרשרת הגזירה'),
    el('div', { class: 'gen-chain__row' },
      ...ancestors.map((a) => step(a, false)),
      step(node, true),
      ...descendants.map((a) => step(a, false))));
}

/* ================================================================== dry-run plan */

// A dry run's whole value is that it is READABLE. Show the exact calls, not a
// green tick — «נבדק» that hides the payload teaches nothing and is the same
// class of false-success this project keeps paying for.
function showPlan(title, res) {
  const lines = [];
  const p = res.plan || {};
  if (p.fal_calls) lines.push(...p.fal_calls);
  if (p.then) lines.push('', p.then);
  if (p.note) lines.push('', p.note);
  modal(title, el('div', null,
    el('div', { class: 'pv-note' },
      `מצב יבש — לא נוצרה תמונה ולא חויב תשלום. תמונות שהיו נוצרות: ${res.images ?? '—'}.`),
    res.translated ? el('div', { class: 'pv-note' }, 'הטקסט היה מתורגם לאנגלית בשרת לפני השליחה.') : null,
    el('pre', { class: 'gen-plan ltr', dir: 'ltr' }, lines.join('\n') || JSON.stringify(res, null, 2)),
  ));
}
