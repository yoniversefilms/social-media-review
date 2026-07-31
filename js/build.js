// build.js — «בניית פוסט»: a therapist assembles a carousel from the studio's
// own templates and illustrations. Owner: builder agent.
// Contract: PLAN.md — store.js is the only network module, ui.js supplies the
// shared widgets, compose.js is the studio's render engine in the browser.
// Builder posts save with asset_prefix '' (no PNG renders): they are viewed
// through compose in post.html; the studio renders finals later.

import { initStore, assetUrl, getPost, createBuilderPost } from './store.js';
import { el as h, navBar, toast, modal } from './ui.js';
import { initCompose, mountSlide, manifest } from './compose.js';

const $ = (id) => document.getElementById(id);

/* ── state ── */
let board = null;              // {board_key, name, local}
let slides = [];               // [{template, vars}]
let sel = -1;                  // selected slide index
let thumbMounts = [];          // per-slide thumbnail mount elements
let stageMount = null;         // big preview mount element
let saving = false;
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

  // ?from=<post_id> — start from an existing post (a "spin")
  const from = new URLSearchParams(location.search).get('from');
  if (from) await prefillFrom(from);

  renderStrip();
  if (slides.length) selectSlide(0);
  else renderEmpty();
})();

async function prefillFrom(postId) {
  try {
    const post = await getPost(postId);
    $('b-title').value = '(גרסה של) ' + (post.title || postId);
    $('b-caption').value = post.caption || '';
    let src = post.slides;
    if (typeof src === 'string') { try { src = JSON.parse(src); } catch { src = []; } }
    if (Array.isArray(src)) {
      slides = src
        .filter((s) => s && s.template)
        .map((s) => ({ template: s.template, vars: { ...(s.vars || {}) } }));
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
  [slides[i], slides[j]] = [slides[j], slides[i]];
  if (sel === i) sel = j; else if (sel === j) sel = i;
  renderStrip();
  if (sel >= 0) selectSlide(sel, { keepFields: false });
}

function removeSlide(i) {
  slides.splice(i, 1);
  if (!slides.length) { sel = -1; renderStrip(); renderEmpty(); $('fields').replaceChildren(); return; }
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
  m = modal('באיזו תבנית נשתמש?', grid);
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
  slides.push({ template: t.name, vars });
  renderStrip();
  selectSlide(slides.length - 1);
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
  if (sel < 0 || !slides[sel]) return;
  mountSlide(ensureStageMount(), slides[sel]);
  if (thumbMounts[sel]) mountSlide(thumbMounts[sel], slides[sel]);
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
  for (const spec of specs) kids.push(fieldWidget(slide, spec));
  box.replaceChildren(...kids);
}

function fieldWidget(slide, spec) {
  const val = slide.vars[spec.key] ?? '';
  if (spec.kind === 'ill') return illField(slide, spec);
  const input = spec.kind === 'multiline'
    ? h('textarea', { oninput: onEdit }, String(val))
    : h('input', { class: 'field__input', type: 'text', value: String(val), oninput: onEdit });
  function onEdit() { slide.vars[spec.key] = input.value; schedulePreview(); }
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
      slide.vars[spec.key] = name;
      img.src = illSrc(name);
      nameEl.textContent = name;
      clearTimeout(previewTimer);
      updatePreview();
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
    const id = newId();
    await createBuilderPost({
      id,
      title,
      caption: $('b-caption').value.trim(),
      slides,
      slide_count: slides.length,
    });
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
