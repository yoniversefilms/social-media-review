// build.js — «בניית פוסט»: a therapist assembles a carousel from the studio's
// own templates and illustrations. Owner: builder agent.
// Contract: PLAN.md — store.js is the only network module, ui.js supplies the
// shared widgets, compose.js is the studio's render engine in the browser.
// Builder posts save with asset_prefix '' (no PNG renders): they are viewed
// through compose in post.html; the studio renders finals later.

import {
  initStore, assetUrl, getPost, createBuilderPost, uploadPhoto,
  saveDraft, deleteDraft, listDrafts,
  listTemplates, deleteTemplate, whoAmI,
  listAssets, assetRowUrl,
} from './store.js';
import { el as h, navBar, toast, modal } from './ui.js';
import { initCompose, mountSlide, manifest } from './compose.js';
import { initEditor } from './editor.js';

const $ = (id) => document.getElementById(id);

/* ── state ── */
let board = null;              // {board_key, name, local}
let slides = [];               // [{template, vars}]
let sel = -1;                  // selected slide index
let thumbMounts = [];          // per-slide thumbnail mount elements
let stageMount = null;         // big preview mount element
let saving = false;
// The draft's post id is minted at session start (not at save), so photos
// dropped onto the slide can upload with a real post_id right away; save()
// uses it, then mints a fresh one for the next draft.
let draftId = newId();
let draftPhotos = [];          // photos uploaded via drag-drop this session ({url, note})
// v2.0: the board-wide asset library, loaded once at boot and topped up as
// this session uploads. The builder's editor picks from the same one library
// the post page does — a photo a therapist uploaded on a post is usable here.
let libAssets = [];            // sm_assets rows (raw)

function designAssets() {
  return libAssets.map((a) => ({
    id: a.id,
    kind: a.kind || 'other',
    source: a.source || 'upload',
    name: a.name || '',
    label: a.label || '',
    tags: Array.isArray(a.tags) ? a.tags : [],
    post_id: a.post_id || null,
    url: assetRowUrl(a),
  })).filter((a) => a.url);
}

async function refreshAssets() {
  libAssets = await listAssets().catch(() => []);
  if (edCtrl && edCtrl.setAssets) edCtrl.setAssets(designAssets());
}

// Uploads from the builder land on the draft's pre-minted post id, so they
// are already attached when the post saves under that same id — and (v2.0)
// they earn a library row with that post_id, so the «בפוסט הזה» filter works
// on the draft too.
async function uploadToDraft(file) {
  const res = await uploadPhoto({ post_id: draftId, pin_id: null, file, note: 'נוסף מהעורך' });
  if (res && res.url) draftPhotos.push({ url: res.url, note: '' });
  refreshAssets().catch(() => {});
  return res;
}
/* design mode (editor.js over the large preview) */
let designOn = false;
let stageHandle = null;        // compose mountSlide handle for the stage
let edCtrl = null;             // initEditor controller
let edIdx = -1;                // slide index the controller is armed on
let edWrapper = null;          // compose wrapper the overlay lives in
let engineWarned = false;
const sampleCache = new Map(); // template name -> sample vars (frozen master copy)

/* ── boot ── */
(async function boot() {
  try {
    board = await initStore();
  } catch (err) {
    $('stage').replaceChildren(h('div', { class: 'b-empty' },
      h('p', {}, 'לא הצלחנו להתחבר ללוח. בדקו שהקישור שקיבלתם שלם, ונסו לרענן.'),
      h('p', { class: 'small muted' }, String(err && err.message || err))));
    return;
  }
  $('nav').replaceChildren(navBar('build'));

  try {
    await initCompose(assetUrl);
  } catch (err) {
    $('stage').replaceChildren(h('div', { class: 'b-empty' },
      h('p', {}, 'נכסי הסטודיו לא נטענו, אז אי אפשר לבנות כרגע. נסו לרענן.'),
      h('p', { class: 'small muted' }, String(err && err.message || err))));
    return;
  }

  $('b-save').addEventListener('click', save);
  $('b-design').addEventListener('click', toggleDesign);
  wireAutosave();
  refreshAssets().catch(() => {});   // v2.0 library — never blocks the build UI

  // ?from=<post_id> — start from an existing post (a "spin")
  const from = new URLSearchParams(location.search).get('from');
  if (from) await prefillFrom(from);
  else await offerDraftResume(); // v1.3: an unfinished deck draft resumes here

  renderStrip();
  if (slides.length) selectSlide(0);
  else renderEmpty();
  if (from && slides.length) scheduleAutosave(); // a spin is working state too
})();

/* ── undo/redo (v1.6) — per-user, session-local stacks over the deck ──
   Snapshots of {title, caption, slides, sel} are pushed at each commit
   boundary BEFORE the mutation; same-key commits (a typing burst, a drag)
   fold into one step until the autosave batch lands. Undo/redo restore the
   deck and ride the existing autosave. */

const HIST_DEPTH = 60; // spec: ≥50; a snapshot is a few KB of JSON
let undoStack = [];
let redoStack = [];
let histBatchKey = null;   // open batch key; null = closed
let applyingHist = false;  // restoring — don't re-mark boundaries
let histOpSeq = 0;         // unique keys for one-shot ops (add/move/remove…)
let histUndoBtn = null;
let histRedoBtn = null;

function deckSnapshot() {
  return {
    title: $('b-title').value,
    caption: $('b-caption').value,
    slides: JSON.parse(JSON.stringify(slides)),
    sel,
  };
}

function renderHistButtons() {
  if (histUndoBtn) histUndoBtn.disabled = !undoStack.length;
  if (histRedoBtn) histRedoBtn.disabled = !redoStack.length;
}

// call BEFORE mutating (title/caption use beforeinput for the same reason)
function markUndo(key) {
  if (applyingHist) return;
  if (histBatchKey !== null && histBatchKey === key) return; // same burst
  undoStack.push(deckSnapshot());
  if (undoStack.length > HIST_DEPTH) undoStack.shift();
  redoStack.length = 0; // a fresh edit forks history — redo is gone
  histBatchKey = key;
  renderHistButtons();
}

function markUndoOp() { markUndo('op:' + (histOpSeq++)); } // always a new step

function applyHist(from, to) {
  if (applyingHist || !from.length) return;
  const snap = from.pop();
  to.push(deckSnapshot());
  if (to.length > HIST_DEPTH) to.shift();
  applyingHist = true;
  try {
    $('b-title').value = snap.title;
    $('b-caption').value = snap.caption;
    slides = JSON.parse(JSON.stringify(snap.slides));
    sel = Math.min(snap.sel, slides.length - 1);
    histBatchKey = null;
    disarmEditor();
    renderStrip();
    if (sel >= 0 && slides[sel]) {
      selectSlide(sel);
    } else {
      sel = -1;
      renderEmpty();
      $('fields').replaceChildren();
    }
    scheduleAutosave(); // undo/redo rides the existing deck autosave
  } finally {
    applyingHist = false;
  }
  renderHistButtons();
}

/* ── cloud autosave (v1.3) — the deck survives refresh & devices ── */

let autosaveTimer = 0;
let autosaveChipEl = null;
let draftOnServer = false; // a draft row exists for draftId

function deckPayload() {
  return {
    deck: {
      title: $('b-title').value,
      caption: $('b-caption').value,
      slides,
    },
    savedAt: new Date().toISOString(),
  };
}

function deckIsEmpty() {
  return !slides.length && !$('b-title').value.trim() && !$('b-caption').value.trim();
}

function setAutosaveChip(state) {
  if (!autosaveChipEl) return;
  autosaveChipEl.textContent =
    state === 'saving' ? 'שומר…'
    : state === 'saved' ? 'נשמר ✓'
    : state === 'err' ? 'השמירה לענן נכשלה' : '';
  autosaveChipEl.style.color = state === 'err' ? 'var(--no)' : 'var(--ink-soft)';
}

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  setAutosaveChip('saving');
  autosaveTimer = setTimeout(flushAutosave, 2000);
}

async function flushAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = 0;
  histBatchKey = null; // the batch landed — the next commit is a new undo step
  try {
    if (deckIsEmpty()) {
      if (draftOnServer) { await deleteDraft(draftId); draftOnServer = false; }
      setAutosaveChip('');
    } else {
      await saveDraft(draftId, deckPayload());
      draftOnServer = true;
      setAutosaveChip('saved');
    }
  } catch (err) {
    console.warn('autosave failed', err);
    setAutosaveChip('err');
  }
}

function wireAutosave() {
  autosaveChipEl = h('span', {
    id: 'autosaveChip',
    style: 'font-size:.78rem;color:var(--ink-soft);min-height:1em;white-space:nowrap',
  });
  histUndoBtn = h('button', {
    class: 'btn btn--ghost hist-btn', type: 'button', id: 'undoBtn',
    title: 'ביטול', 'aria-label': 'ביטול', disabled: true,
    onclick: () => applyHist(undoStack, redoStack),
  }, '↩︎');
  histRedoBtn = h('button', {
    class: 'btn btn--ghost hist-btn', type: 'button', id: 'redoBtn',
    title: 'ביצוע חוזר', 'aria-label': 'ביצוע חוזר', disabled: true,
    onclick: () => applyHist(redoStack, undoStack),
  }, '↪︎');
  const col = document.querySelector('.b-savecol');
  if (col) {
    col.insertBefore(autosaveChipEl, $('b-saved'));
    col.insertBefore(
      h('span', { style: 'display:inline-flex;gap:6px' }, histUndoBtn, histRedoBtn),
      autosaveChipEl,
    );
  }
  // beforeinput fires BEFORE the value changes — the snapshot must be pre-change
  $('b-title').addEventListener('beforeinput', () => markUndo('title'));
  $('b-caption').addEventListener('beforeinput', () => markUndo('caption'));
  $('b-title').addEventListener('input', scheduleAutosave);
  $('b-caption').addEventListener('input', scheduleAutosave);
  // Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z — but never while typing (native text undo
  // owns inputs/textareas/contentEditable until the value commits)
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) applyHist(redoStack, undoStack);
      else applyHist(undoStack, redoStack);
    }
  });
  const flushNow = () => { if (autosaveTimer) flushAutosave(); };
  window.addEventListener('pagehide', flushNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
}

// On entry: the newest unfinished deck draft (this author's) offers itself.
// Resuming adopts the draft's pre-minted post id, so its uploaded photos are
// already attached and further autosaves land on the same row.
async function offerDraftResume() {
  let rows = [];
  try { rows = await listDrafts(); } catch { return; }
  const row = (rows || []).find((r) => r && r.payload && r.payload.deck &&
    Array.isArray(r.payload.deck.slides));
  if (!row) return;
  const deck = row.payload.deck;
  const n = deck.slides.length;
  await new Promise((done) => {
    modal('נמצאה טיוטה שלא נשמרה', h('div', { style: 'display:grid;gap:8px' },
      h('div', {}, (deck.title ? '”' + deck.title + '“ · ' : '') +
        (n === 1 ? 'שקופית אחת' : n + ' שקופיות') +
        ' · נשמרה אוטומטית ' + new Date(row.updated_at).toLocaleString('he-IL')),
      h('div', { class: 'small muted', style: 'font-size:.8rem;color:var(--ink-soft)' },
        'אפשר להמשיך בדיוק מאיפה שהפסקתם, או להתחיל קרוסלה חדשה.'),
    ), {
      dismissable: false,
      actions: [
        {
          label: 'להמשיך מהטיוטה', primary: true,
          onClick: () => {
            draftId = row.post_id;
            draftOnServer = true;
            $('b-title').value = deck.title || '';
            $('b-caption').value = deck.caption || '';
            slides = deck.slides
              .filter((s) => s && s.template)
              .map((s) => JSON.parse(JSON.stringify(s)));
            // photos the prior session uploaded live inside the deck's
            // designs — put them back in the picker list too
            for (const s of slides) {
              const d = s.design || {};
              const urls = [
                ...(Array.isArray(d.extras) ? d.extras : [])
                  .filter((x) => x && x.type === 'photo' && x.url).map((x) => x.url),
                ...Object.values(d.slots || {}).map((x) => x && x.url).filter(Boolean),
                d.bg && d.bg.photo,
              ].filter(Boolean);
              for (const u of urls) {
                if (!draftPhotos.some((p) => p.url === u)) draftPhotos.push({ url: u, note: '' });
              }
            }
            setAutosaveChip('saved');
            done();
          },
        },
        {
          label: 'התחל מחדש',
          onClick: () => {
            deleteDraft(row.post_id).catch(() => {});
            done();
          },
        },
      ],
    });
  });
}

async function prefillFrom(postId) {
  try {
    const post = await getPost(postId);
    $('b-title').value = '(גרסה של) ' + (post.title || postId);
    $('b-caption').value = post.caption || '';
    let src = post.slides;
    if (typeof src === 'string') { try { src = JSON.parse(src); } catch { src = []; } }
    if (Array.isArray(src)) {
      // a duplicate carries the hand-crafted design overrides too (v1.4) —
      // they stay ordinary slide.design objects, fully editable
      slides = src
        .filter((s) => s && s.template)
        .map((s) => {
          const out = { template: s.template, vars: { ...(s.vars || {}) } };
          if (s.design && typeof s.design === 'object') {
            out.design = JSON.parse(JSON.stringify(s.design));
          }
          return out;
        });
    }
    if (!slides.length) toast('לפוסט המקורי אין שקופיות מקור — מתחילים מלוח ריק', 'err');
  } catch (err) {
    toast('הפוסט המקורי לא נטען: ' + String(err && err.message || err), 'err');
  }
}

/* ── carousel strip (right column) ── */

function renderStrip() {
  const strip = $('strip');
  thumbMounts = [];
  const items = slides.map((slide, i) => {
    const mount = h('div', { class: 'b-thumb__mount' });
    thumbMounts[i] = mount;
    mountSlide(mount, slide);
    return h('div', {
      class: 'b-thumb' + (i === sel ? ' is-on' : ''),
      role: 'button', tabindex: '0',
      onclick: () => selectSlide(i),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSlide(i); } },
    },
      mount,
      h('div', { class: 'b-thumb__bar' },
        h('span', { class: 'b-thumb__n' }, (i + 1) + ' · ' + tplLabel(slide.template)),
        h('button', {
          class: 'b-mini', type: 'button', title: 'הזזה למעלה', 'aria-label': 'הזזה למעלה',
          disabled: i === 0,
          onclick: (e) => { e.stopPropagation(); moveSlide(i, -1); },
        }, '▲'),
        h('button', {
          class: 'b-mini', type: 'button', title: 'הזזה למטה', 'aria-label': 'הזזה למטה',
          disabled: i === slides.length - 1,
          onclick: (e) => { e.stopPropagation(); moveSlide(i, +1); },
        }, '▼'),
        h('button', {
          class: 'b-mini b-mini--x', type: 'button', title: 'הסרת השקופית', 'aria-label': 'הסרת השקופית',
          onclick: (e) => { e.stopPropagation(); removeSlide(i); },
        }, '✕'),
      ),
    );
  });
  strip.replaceChildren(
    ...items,
    h('button', { class: 'btn btn--ghost b-add', type: 'button', onclick: openTemplatePicker },
      '+ הוספת שקופית'),
  );
}

function moveSlide(i, d) {
  const j = i + d;
  if (j < 0 || j >= slides.length) return;
  markUndoOp(); // structural: its own undo step
  [slides[i], slides[j]] = [slides[j], slides[i]];
  if (sel === i) sel = j; else if (sel === j) sel = i;
  renderStrip();
  if (sel >= 0) selectSlide(sel, { keepFields: false });
  scheduleAutosave();
}

function removeSlide(i) {
  markUndoOp(); // structural: its own undo step
  slides.splice(i, 1);
  scheduleAutosave();
  if (!slides.length) { sel = -1; disarmEditor(); renderStrip(); renderEmpty(); $('fields').replaceChildren(); return; }
  if (sel >= slides.length) sel = slides.length - 1;
  else if (i < sel) sel -= 1;
  renderStrip();
  selectSlide(sel);
}

/* ── template picker ── */

function tplByName(name) {
  const man = manifest();
  return (man && man.templates || []).find((t) => t.name === name) || null;
}

function tplLabel(name) { return name || 'תבנית'; }

// One-line hint derived from the manifest fields: what this template carries.
function tplHint(t) {
  const kinds = { text: 0, multiline: 0, ill: 0 };
  for (const f of t.fields || []) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
  const bits = [];
  if (kinds.multiline) bits.push(kinds.multiline === 1 ? 'פסקה אחת' : kinds.multiline + ' פסקאות');
  if (kinds.text) bits.push(kinds.text === 1 ? 'שורת טקסט' : kinds.text + ' שורות טקסט');
  if (kinds.ill) bits.push('איור לבחירה');
  return bits.join(' · ') || 'תבנית קבועה';
}

function openTemplatePicker() {
  const list = (manifest().templates || []).filter((t) => t.builder);
  if (!list.length) { toast('אין תבניות זמינות לבנייה בלוח הזה', 'err'); return; }
  let m = null;
  const grid = h('div', { class: 'b-pickgrid' },
    list.map((t) => h('button', {
      class: 'b-pick', type: 'button',
      onclick: () => { if (m) m.close(); addSlide(t); },
    },
      h('img', { src: assetUrl('studio/' + t.preview), alt: t.name, loading: 'lazy' }),
      h('span', { class: 'b-pick__name' }, t.name),
      h('span', { class: 'b-pick__hint' }, tplHint(t)),
    )),
  );
  const derivedWrap = h('div');
  m = modal('באיזו תבנית נשתמש?', h('div', {}, grid, derivedWrap));
  renderDerivedSection(derivedWrap, () => { if (m) m.close(); });
}

/* ── derived templates (v1.4) — «תבניות שלכם» in the picker ── */

// Board-level templates saved from hand-crafted slides («שמור כתבנית» in the
// review screen). Composed live: base template + design + sample vars. The
// section renders only when templates exist; a stale row (base template gone
// from the manifest) shows disabled instead of breaking.
async function renderDerivedSection(wrap, closeModal) {
  let rows = [];
  try { rows = (await listTemplates()) || []; } catch { return; }
  if (!rows.length) return;
  const me = whoAmI();

  const draw = () => {
    if (!rows.length) { wrap.replaceChildren(); return; }
    const cards = rows.map((row) => {
      const base = tplByName(row.base_template);
      const mount = h('div', {
        style: 'width:100%;border-radius:6px;overflow:hidden;background:#fff;pointer-events:none',
      });
      if (base) {
        const composed = { template: row.base_template, vars: { ...(row.sample_vars || {}) } };
        if (row.design && typeof row.design === 'object') composed.design = row.design;
        mountSlide(mount, composed);
      }
      const pick = h('button', {
        class: 'b-pick', type: 'button',
        style: 'width:100%' + (base ? '' : ';opacity:.55;cursor:not-allowed'),
        disabled: !base,
        title: base ? (row.name || '') : 'התבנית הבסיסית לא זמינה',
        onclick: () => { if (!base) return; closeModal(); addDerivedSlide(row); },
      },
        mount,
        h('span', { class: 'b-pick__name' }, row.name || row.base_template),
        h('span', { class: 'b-pick__hint' },
          base ? ('מאת ' + (row.author || 'לא ידוע')) : 'התבנית הבסיסית לא זמינה'),
      );
      // delete only your own templates — others' rows get no ✕ at all
      const mine = row.author_id && me.author_id && row.author_id === me.author_id;
      const del = mine ? h('button', {
        class: 'b-mini b-mini--x', type: 'button',
        title: 'מחיקת התבנית', 'aria-label': 'מחיקת התבנית',
        style: 'position:absolute;top:6px;inset-inline-end:6px;z-index:2',
        onclick: (e) => {
          e.stopPropagation();
          if (!confirm('למחוק את התבנית ”' + (row.name || row.base_template) + '“? המחיקה סופית.')) return;
          deleteTemplate(row.id).then(() => {
            rows = rows.filter((r) => r.id !== row.id);
            draw();
            toast('התבנית נמחקה');
          }).catch((err) => toast('המחיקה נכשלה: ' + String(err && err.message || err), 'err'));
        },
      }, '✕') : null;
      return h('div', { style: 'position:relative' }, pick, del);
    });
    wrap.replaceChildren(
      h('h4', { style: 'margin:18px 0 8px;font-size:.95rem' }, 'תבניות שלכם'),
      h('div', { class: 'b-pickgrid' }, cards),
    );
  };
  draw();
}

// Picking a derived template adds an ordinary slide carrying the design —
// thereafter it is edited exactly like any other slide.
function addDerivedSlide(row) {
  const slide = {
    template: row.base_template,
    vars: JSON.parse(JSON.stringify(row.sample_vars || {})),
  };
  if (row.design && typeof row.design === 'object') {
    slide.design = JSON.parse(JSON.stringify(row.design));
  }
  markUndoOp(); // structural: its own undo step
  slides.push(slide);
  renderStrip();
  selectSlide(slides.length - 1);
  scheduleAutosave();
}

// Every new slide starts from the template's sample vars, so the preview is
// never empty and the fields teach by example.
async function sampleVars(name) {
  if (sampleCache.has(name)) return { ...sampleCache.get(name) };
  let vars = null;
  try {
    const res = await fetch(assetUrl('studio/templates/' + name + '.sample.json'));
    if (res.ok) {
      const sample = await res.json();
      vars = { ...(sample.vars || sample) }; // render.mjs: sample.vars || sample
    }
  } catch { /* fall through to empty vars */ }
  if (!vars) {
    vars = {};
    const t = tplByName(name);
    for (const f of (t && t.fields) || []) vars[f.key] = '';
    toast('הדוגמה של התבנית לא נטענה — מתחילים משדות ריקים', 'err');
  }
  sampleCache.set(name, { ...vars });
  return vars;
}

async function addSlide(t) {
  const vars = await sampleVars(t.name);
  markUndoOp(); // structural: its own undo step
  slides.push({ template: t.name, vars });
  renderStrip();
  selectSlide(slides.length - 1);
  scheduleAutosave();
}

/* ── center preview ── */

function renderEmpty() {
  $('stage').replaceChildren(h('div', { class: 'b-empty' },
    h('p', {}, 'קרוסלה חדשה מתחילה בשקופית הראשונה.'),
    h('button', { class: 'btn btn--primary', type: 'button', onclick: openTemplatePicker },
      'בחירת תבנית לשקופית הראשונה'),
  ));
}

function ensureStageMount() {
  if (stageMount && $('stage').contains(stageMount)) return stageMount;
  stageMount = h('div', { class: 'b-stage__mount' });
  $('stage').replaceChildren(stageMount);
  return stageMount;
}

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 250);
}

function updatePreview() {
  if (sel < 0 || !slides[sel]) { disarmEditor(); return; }
  Promise.resolve(mountSlide(ensureStageMount(), slides[sel]))
    .then((handle) => { stageHandle = handle; if (designOn) armEditor(); })
    .catch(() => {});
  if (thumbMounts[sel]) mountSlide(thumbMounts[sel], slides[sel]);
}

/* ── design mode (direct manipulation on the large preview) ── */

function toggleDesign() {
  if (!designOn && (sel < 0 || !slides[sel])) {
    toast('קודם מוסיפים שקופית — ואז מעצבים אותה', 'err');
    return;
  }
  designOn = !designOn;
  $('b-design').classList.toggle('on', designOn);
  if (designOn) armEditor();
  else disarmEditor();
}

function armEditor() {
  if (!designOn || !stageHandle) return;
  const wrapper = stageHandle.iframe && stageHandle.iframe.parentElement;
  if (edCtrl && edIdx === sel && edWrapper === wrapper && wrapper && wrapper.isConnected) {
    edCtrl.refresh();
    return;
  }
  disarmEditor();
  const idx = sel;
  if (idx < 0 || !slides[idx]) return;
  try {
    // v1.6: the editor gets a working COPY (post.js pattern) — mutations reach
    // the real slide only through the callbacks below, so each callback can
    // snapshot the pre-change deck for undo
    const composed = { template: slides[idx].template, vars: { ...slides[idx].vars } };
    if (slides[idx].design) composed.design = JSON.parse(JSON.stringify(slides[idx].design));
    edCtrl = initEditor(stageHandle, composed, {
      manifest: manifest(),
      assetUrl,
      photos: draftPhotos,
      assets: designAssets(),
      postId: draftId,
      photosEmptyText: 'עוד אין נכסים בלוח — אפשר להעלות קובץ כאן, או לגרור תמונה מהמחשב ישירות אל השקף.',
      uploadFile: uploadToDraft,
      uploadAsset: uploadToDraft,
      onChange: (design) => {
        const s = slides[idx];
        if (!s) return;
        markUndo('design.' + idx); // drags/styling fold per autosave batch
        if (design) s.design = design; else delete s.design;
        if (thumbMounts[idx]) mountSlide(thumbMounts[idx], s); // thumb follows
        scheduleAutosave();
      },
      // in-place text edit: the editor edited its copy — commit to the deck
      onTextChange: (key, value) => {
        const s = slides[idx];
        if (!s || key === undefined) return;
        if (String(s.vars[key] ?? '') !== String(value ?? '')) {
          markUndoOp(); // each in-place text commit is its own undo step
          s.vars[key] = String(value ?? '');
        }
        if (sel === idx) renderFields();
        if (thumbMounts[idx]) mountSlide(thumbMounts[idx], slides[idx]);
        scheduleAutosave();
      },
      // «איפוס עיצוב»: in the builder everything IS the working deck, so the
      // reset clears design objects only — the text stays (it's content)
      onReset: (scope) => {
        markUndoOp(); // one undo step for the whole reset
        if (scope === 'deck') for (const s of slides) delete s.design;
        else if (slides[idx]) delete slides[idx].design;
        disarmEditor();
        renderStrip();
        clearTimeout(previewTimer);
        updatePreview();
        scheduleAutosave();
        toast(scope === 'deck' ? 'עיצוב הקרוסלה אופס' : 'עיצוב השקופית אופס');
      },
    });
    edIdx = idx;
    edWrapper = wrapper;
  } catch (err) {
    // the compose handle doesn't expose update/doc yet (engine piece pending)
    designOn = false;
    $('b-design').classList.remove('on');
    if (!engineWarned) {
      engineWarned = true;
      toast('עורך העיצוב עוד לא זמין — מנוע התצוגה טרם עודכן לעריכה ישירה', 'err');
    }
    console.warn('initEditor unavailable:', err && err.message);
  }
}

function disarmEditor() {
  if (edCtrl) { edCtrl.destroy(); edCtrl = null; }
  edIdx = -1;
  edWrapper = null;
}

function selectSlide(i, opts = {}) {
  sel = i;
  [...$('strip').querySelectorAll('.b-thumb')].forEach((n, k) =>
    n.classList.toggle('is-on', k === sel));
  if (opts.keepFields !== true) renderFields();
  clearTimeout(previewTimer);
  updatePreview();
}

/* ── fields (left column) ── */

// Fields come from the manifest for the slide's template. A slide whose
// template is not in the manifest (e.g. a spin of an older post) still gets
// editable fields, inferred from its own vars.
function fieldSpecs(slide) {
  const t = tplByName(slide.template);
  if (t && t.fields && t.fields.length) return t.fields;
  const man = manifest();
  const known = new Set((man && man.illustrations) || []);
  return Object.keys(slide.vars || {}).map((key) => ({
    key,
    kind: known.has(String(slide.vars[key])) ? 'ill'
      : String(slide.vars[key] ?? '').length > 60 ? 'multiline' : 'text',
    limit: null,
  }));
}

function renderFields() {
  const box = $('fields');
  if (sel < 0 || !slides[sel]) { box.replaceChildren(); return; }
  const slide = slides[sel];
  const specs = fieldSpecs(slide);
  const kids = [
    h('div', { class: 'b-fields__tpl' }, 'שקופית ' + (sel + 1) + ' — תבנית ' + tplLabel(slide.template)),
  ];
  if (!specs.length) kids.push(h('p', { class: 'muted' }, 'לתבנית הזאת אין שדות לעריכה.'));
  for (const spec of specs) kids.push(fieldWidget(slide, spec, sel));
  box.replaceChildren(...kids);
}

function fieldWidget(slide, spec, idx) {
  const val = slide.vars[spec.key] ?? '';
  if (spec.kind === 'ill') return illField(slide, spec);
  const input = spec.kind === 'multiline'
    ? h('textarea', { oninput: onEdit }, String(val))
    : h('input', { class: 'field__input', type: 'text', value: String(val), oninput: onEdit });
  // beforeinput: snapshot BEFORE the keystroke lands in slide.vars
  input.addEventListener('beforeinput', () => markUndo('var.' + idx + '.' + spec.key));
  function onEdit() { slide.vars[spec.key] = input.value; schedulePreview(); scheduleAutosave(); }
  return h('div', { class: 'field' },
    h('label', { class: 'field__label' }, spec.key),
    input,
  );
}

function illField(slide, spec) {
  const current = () => String(slide.vars[spec.key] || '');
  const img = h('img', { src: illSrc(current()), alt: '' });
  const nameEl = h('span', {}, current() || 'בחירת איור…');
  const btn = h('button', {
    class: 'btn btn--ghost b-illbtn', type: 'button',
    onclick: () => openIllPicker((name) => {
      markUndoOp(); // an illustration swap is its own undo step
      slide.vars[spec.key] = name;
      img.src = illSrc(name);
      nameEl.textContent = name;
      clearTimeout(previewTimer);
      updatePreview();
      scheduleAutosave();
    }),
  }, img, nameEl);
  return h('div', { class: 'field' },
    h('label', { class: 'field__label' }, spec.key + ' (איור)'),
    btn,
  );
}

function illSrc(name) {
  return name ? assetUrl('studio/illustrations/' + name + '.svg') : '';
}

function openIllPicker(onPick) {
  const all = (manifest().illustrations || []);
  let m = null;
  const grid = h('div', { class: 'b-pickgrid b-illgrid' });
  const draw = (q) => {
    const kids = q ? all.filter((n) => n.includes(q)) : all;
    grid.replaceChildren(...(kids.length
      ? kids.map((n) => h('button', {
          class: 'b-pick', type: 'button', title: n,
          onclick: () => { if (m) m.close(); onPick(n); },
        },
          h('img', { src: illSrc(n), alt: n, loading: 'lazy' }),
          h('span', { class: 'b-pick__name' }, n),
        ))
      : [h('p', { class: 'muted' }, 'אין איור שמתאים לחיפוש הזה.')]));
  };
  const search = h('input', {
    class: 'field__input b-search', type: 'search',
    placeholder: 'חיפוש בין ' + all.length + ' איורים (באנגלית, למשל bridge)',
    oninput: () => draw(search.value.trim().toLowerCase()),
  });
  draw('');
  m = modal('איזה איור?', h('div', {}, search, grid));
  setTimeout(() => search.focus(), 60);
}

/* ── save ── */

function newId() {
  const suffix = (Math.random().toString(36).slice(2) + '0000').slice(0, 4);
  return 'b-' + Date.now().toString(36) + '-' + suffix;
}

function postHref(id) {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get('board')) keep.set('board', params.get('board'));
  if (params.get('local')) keep.set('local', params.get('local'));
  keep.set('id', id);
  return 'post.html?' + keep.toString();
}

async function save() {
  if (saving) return;
  const title = $('b-title').value.trim();
  if (!title) { toast('לפוסט צריך שם — הוא מזהה אותו בגלריה', 'err'); $('b-title').focus(); return; }
  if (!slides.length) { toast('אי אפשר לשמור קרוסלה בלי שקופיות', 'err'); return; }

  saving = true;
  const btn = $('b-save');
  btn.disabled = true;
  try {
    const id = draftId;
    await createBuilderPost({
      id,
      title,
      caption: $('b-caption').value.trim(),
      slides,
      slide_count: slides.length,
    });
    // the deck is on the board now — its autosave draft is done
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
    deleteDraft(id).catch(() => {});
    draftOnServer = false;
    setAutosaveChip('');
    draftId = newId(); // the next save is a new post, not a duplicate id
    toast('הפוסט נשמר לסקירת הצוות', 'ok');
    $('b-saved').replaceChildren(
      h('a', { class: 'b-viewlink', href: postHref(id) }, 'לצפייה בפוסט ←'),
    );
  } catch (err) {
    toast('השמירה נכשלה: ' + String(err && err.message || err), 'err');
  } finally {
    saving = false;
    btn.disabled = false;
  }
}
