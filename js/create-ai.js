// create-ai.js — «יצירה עם AI»: the therapist's request form, and the honest
// status UI beside it. Owner: generation module (spec 08).
//
// This page WRITES A ROW AND STOPS. It does not call a model, it has no key,
// and it cannot make a post appear faster. Generation happens in
// scripts/fulfill.mjs on the operator's machine, inside their own Claude
// session — that is the architecture spec 08 decided, not a limitation to work
// around here. Everything in this file follows from it:
//   · the submit button's job is one insert (store.createGenRequest);
//   · the status card never shows a spinner that implies work is happening in
//     the browser — it shows the row's real status, and says out loud that the
//     wait is minutes-when-the-factory-is-on;
//   · nothing here can move a request forward. There is no such store function,
//     because migration 026 gives anon select+insert and nothing else.
//
// It also exports howMadeBlock(), which post.js mounts for generated posts —
// the «איך זה נוצר» transparency block. One renderer, two pages: the post page
// must not grow a second, drifting copy of the same story.

import {
  initStore, whoAmI, ensureName, subscribe,
  createGenRequest, listGenRequests, campaignsFrom, genRequestForPost,
  GEN_STATUS_LABELS, listPosts, listAssets, assetRowUrl,
  // v2.12 (spec 14) — the workshop tab stopped being a form and became a
  // PICKER. The facts live in sm_programs now, edited on program.html.
  listPrograms, programsMissing,
} from './store.js';
import {
  el as h, navBar, toast, fmtDate, CATEGORIES, stageLabel,
} from './ui.js';

const $ = (id) => document.getElementById(id);

/* ── the layout vocabulary ──────────────────────────────────────────────
   These keys are the CONTRACT with scripts/fulfill.mjs (LAYOUT_HINTS there).
   They are hints, not CSS: the fulfiller scores them against the templates the
   board actually has and tells the therapist when it had to settle for the
   nearest one. Adding a key here without adding it there means the hint
   quietly degrades to "no hint" — change both. */
const LAYOUTS = [
  { key: '',       label: 'שהמפעל יחליט' },
  { key: 'cover',  label: 'כותרת גדולה' },
  { key: 'essay',  label: 'פסקה' },
  { key: 'quote',  label: 'ציטוט גדול' },
  { key: 'list',   label: 'רשימה' },
  { key: 'image',  label: 'תמונה + שורה' },
  { key: 'closer', label: 'סיום / הזמנה' },
];

/* ── state ── */
let board = null;
const MODES = ['post', 'campaign', 'workshop'];
let mode = 'post';                 // 'post' | 'campaign' | 'workshop'
let requests = [];
let campaigns = [];
let submitting = false;

/* ── §W: the workshop tab, v2.12 (spec 14) ─────────────────────────────────
   THE ELEVEN-FIELD FORM THAT USED TO LIVE HERE IS GONE. Spec 13 asked the
   therapist to type an event's facts into this page and submit them; spec 14
   moved those facts into `sm_programs`, where they are a document the whole team
   edits and re-uses. So this tab is now a PICKER plus the three settings that
   belong to THIS request (how many posts, which shelf, which drawings) and one
   free-text note for this request alone.

   WHAT THAT MEANS FOR THE PAYLOAD, AND WHY THE OLD SHAPE STILL EXISTS
   New rows carry {mode:'workshop', program_id, program_rev, note, …}. Rows
   QUEUED BEFORE THIS BUILD carry the inline `workshop:{…}` object, and they
   never expire — a request submitted last night is fulfilled tonight. So
   fulfill.mjs supports BOTH shapes forever, and this file is the only writer of
   the new one. Do not "simplify" the old branch out of the fulfiller.

   `program_rev` is the rev THE PERSON SAW when they picked (§R below, and it is
   deliberately NOT the rev at submit time). It is not what the words get written
   from: the fulfiller re-reads the program LIVE at claim, and this number is
   what lets it say out loud whether the details moved in between. */

// The form's own model. Kept outside the DOM so switching modes (and the
// status poll re-rendering the side column) never eats a half-written request.
//
// `program_id` on post/campaign is the OPTIONAL «משיכת פרטים מתוכנית» (spec 14
// §6): when set, the request carries it and the brief gains a fenced program
// context section. When empty, the payload is byte-identical to v2.11's.
const F = {
  post: { intent: '', slides: [{ what: '', layout: '' }], caption: '', captionFromSlides: true,
          cta: '', category: 'general', illustrations: '', generateImages: true,
          program_id: '', program_rev: 0 },
  campaign: { brief: '', count: 5, lines: [], caption: '', cta: '',
              category: 'general', illustrations: '', generateImages: true,
              revise: false, campaign_id: '', instruction: '', program_id: '',
              program_rev: 0 },
  workshop: { program_id: '', program_rev: 0, note: '', count: 3,
              category: 'general', illustrations: '', generateImages: true },
};

/* The board's live programs, newest first. Loaded once at boot and topped up on
   every subscribe() tick, exactly like the AI shelf: a program created in
   another tab thirty seconds ago must be pickable here without a reload.
   An unapplied migration 030 leaves this [] and programsMissing() true, and
   every picker below then explains itself instead of offering an empty list. */
let programs = [];

async function loadPrograms() {
  try { programs = await listPrograms(); }
  catch { programs = []; }
}

function programById(id) {
  return programs.find((p) => String(p.id) === String(id)) || null;
}

/* ── boot (page only — post.js imports this module for howMadeBlock) ── */
if ($('form')) boot();

async function boot() {
  try {
    board = await initStore();
  } catch (err) {
    $('form').replaceChildren(h('p', { class: 'muted' },
      'לא הצלחנו להתחבר ללוח. בדקו שהקישור שקיבלתם שלם, ונסו לרענן. ' +
      String((err && err.message) || err)));
    return;
  }
  $('nav').replaceChildren(navBar('create-ai'));
  for (const m of MODES) {
    const b = $('mode-' + m);
    if (b) b.addEventListener('click', () => setMode(m));
  }
  // The shelf load also harvests the board's CUSTOM tab names (categories that
  // exist on posts but not in the built-in list), so the «מדף בספרייה» picker
  // offers a tab someone created yesterday. Loaded BEFORE the first form
  // render on purpose — operator bug report 2026-08-03.
  await loadShelf().catch(() => {});
  // BEFORE the first form render, same reason as the shelf: the «סדנה» tab is a
  // picker now, and a picker rendered before its list has loaded is an empty
  // picker with no explanation.
  await loadPrograms();
  renderForm();
  await refreshRequests();
  subscribe(() => {
    refreshRequests();
    loadShelf().catch(() => {});
    loadPrograms().catch(() => {});
  });
}

/* ── the AI-posts shelf + custom tabs (operator 2026-08-03) ─────────────────
   One horizontal, scrollable row of every post the factory wrote (origin
   'ai'), newest first, right at the top of this page — so a finished post is
   FOUND here, not hunted for in the gallery. The same load feeds the category
   pickers their custom tab names. */
let aiPosts = [];
let aiThumbs = new Map();     // post id -> url of its first generated drawing
let customCats = [];          // tab names that exist on posts, beyond CATEGORIES
const freshPosts = new Set(); // post ids that finished during THIS visit

async function loadShelf() {
  let posts = [];
  let assets = [];
  try {
    [posts, assets] = await Promise.all([listPosts(), listAssets()]);
  } catch { return; }
  const known = new Set(CATEGORIES.map((c) => c.key));
  customCats = [...new Set(posts.map((p) => String(p.category || '')))]
    .filter((c) => c && c !== 'general' && !known.has(c))
    .sort((a, b) => a.localeCompare(b, 'he'));
  aiPosts = posts.filter((p) => p.origin === 'ai')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  aiThumbs = new Map();
  const ill = assets.filter((a) => a.kind === 'illustration' && a.post_id);
  for (const a of ill) {          // prefer the storyboard primary…
    if ((a.derived || {}).storyboard === 'primary' && !aiThumbs.has(a.post_id)) {
      aiThumbs.set(a.post_id, assetRowUrl(a));
    }
  }
  for (const a of ill) {          // …fall back to any drawing of the post
    if (!aiThumbs.has(a.post_id)) aiThumbs.set(a.post_id, assetRowUrl(a));
  }
  renderShelf();
}

function renderShelf() {
  const wrap = $('shelf-wrap');
  if (!wrap) return;
  if (!aiPosts.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('ai-shelf').replaceChildren(...aiPosts.map((p) => h('a', {
    class: 'ai-shelfcard', href: pageLink('post.html', { id: p.id }),
    title: p.title || p.id,
  },
    freshPosts.has(p.id) ? h('span', { class: 'ai-new' }, 'חדש') : null,
    aiThumbs.get(p.id)
      ? h('span', { class: 'ai-shelfthumb', style: `--vec:url("${aiThumbs.get(p.id)}")` })
      : h('span', { class: 'ai-shelfthumb ai-shelfthumb--empty' }, '🎨'),
    h('span', { class: 'ai-shelftitle' }, p.title || p.id),
    h('span', { class: 'ai-shelfstage' }, stageLabel(p.stage)))));
}

function setMode(m) {
  if (mode === m) return;
  mode = m;
  for (const k of MODES) {
    const b = $('mode-' + k);
    if (!b) continue;
    b.classList.toggle('is-on', k === m);
    b.setAttribute('aria-selected', String(k === m));
  }
  renderForm();
}

/* ── URL helpers (board + local ride every internal link) ── */
function pageLink(page, extra = {}) {
  const q = new URLSearchParams();
  if (board) {
    q.set('board', board.board_key);
    if (board.local) q.set('local', '1');
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${page}?${q.toString()}`;
}

/* ── small field builders ── */

function field(label, control, hint) {
  return h('div', { class: 'field ai-field' },
    h('label', { class: 'field__label' }, label),
    control,
    hint ? h('p', { class: 'ai-hint' }, hint) : null);
}

function textarea(value, oninput, placeholder, rows = 3) {
  const t = h('textarea', { placeholder: placeholder || '', rows: String(rows) }, value || '');
  t.addEventListener('input', () => oninput(t.value));
  return t;
}

function input(value, oninput, placeholder) {
  const i = h('input', { class: 'field__input', type: 'text', value: value || '',
    placeholder: placeholder || '' });
  i.addEventListener('input', () => oninput(i.value));
  return i;
}

function select(options, value, onchange) {
  const s = h('select', { class: 'ai-select' },
    options.map((o) => h('option', { value: o.key, selected: o.key === value }, o.label)));
  s.addEventListener('change', () => onchange(s.value));
  return s;
}

// A clamped stepper. `lo`/`hi` are enforced here AND again in submit(), because
// a number field accepts a pasted 99, a 0 and an empty box just as happily.
// On commit the BOX snaps to the value the request will actually carry: a
// field reading 0 while the payload says 3 is a lie the therapist only finds
// out about when three posts arrive.
function numberInput(value, lo, hi, oninput) {
  let cur = value;
  const i = h('input', { class: 'field__input ai-num', type: 'number',
    min: String(lo), max: String(hi), value: String(value) });
  i.addEventListener('input', () => { cur = clampCount(i.value, lo, hi, cur); oninput(cur); });
  i.addEventListener('change', () => { i.value = String(cur); });
  return i;
}

function clampCount(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

/* WHERE THE DATE GUARD WENT (v2.12, and read this before "restoring" it here).
   v2.11 owned a `whenInput()` and a `canonWhen()` on this page, because the
   workshop's date was TYPED here. It is not any more: spec 14 moved the date
   into the program document, so the datetime-local input and the
   calendar-overflow guard moved WITH it, verbatim, to app/js/program.js
   (`valueControl` for the `when` field, `canonWhen` at save).

   The guard itself is unchanged and still load-bearing: ECMA-262 ROLLS
   '2026-02-29T19:00' to March 1 instead of failing, and a rolled date presented
   as binding would put the wrong evening on every post. The written day must
   survive the round trip or the value drops to ''. The READ side of the same
   contract (workshopWhen) is still in scripts/fulfill.mjs and now runs over the
   program's `when` field as well as an old inline payload's.

   A second copy here would be a second thing to drift, so there is none. */

/* ── §D: the image-generation switch (spec 09) ─────────────────────────────
   DEFAULT OFF, and it stays off unless someone deliberately turns it on: this
   is the only control in the app that spends money on a therapist's click. It
   rides the payload as `generate_images` and is what gates §A in
   scripts/fulfill.mjs — with it off, a wish with no library match behaves
   exactly as it did in 08.

   The status line under it states the COST MODEL, not a reassurance. «עד 2
   גליונות» is the fulfiller's real per-request budget (MAX_SHEETS_PER_REQUEST),
   not a rounded number. OPERATOR CHANGE 2026-08-03: generation is now the
   DEFAULT and fal-first — the library is only the stand-in/fallback. If the
   fulfiller's rule changes again, change the sentence here too: a switch that
   describes a rule it no longer has is worse than no switch. */
function generateToggle(model) {
  const box = h('input', {
    type: 'checkbox', checked: model.generateImages,
    onchange: (e) => { model.generateImages = e.target.checked; },
  });
  return h('div', { class: 'ai-gen' },
    h('label', { class: 'ai-check' }, box,
      h('span', {}, '🎨 איורים חדשים ב-AI לכל שקופית (ברירת המחדל)')),
    h('p', { class: 'ai-hint' },
      'כל איור נוצר חדש, בסגנון הלוח, במיוחד לפוסט הזה — ',
      h('b', {}, 'עד 2 גליונות fal לבקשה'),
      ' (תשעה ציורים בגיליון). עד שהאיור מוכן, ואם היצירה נכשלת, מוצב ',
      'האיור הקרוב ביותר מהספרייה. האיורים שנוצרו נשמרים בספרייה תחת ',
      '«AI Generated». כיבוי המתג חוזר לאיורי הספרייה בלבד. ',
      'בקמפיין זה חל על כל פוסט בסדרה.'));
}

const CATEGORY_OPTIONS = [
  { key: 'general', label: 'כללי' },
  ...CATEGORIES.filter((c) => c.key !== 'builder').map((c) => ({ key: c.key, label: c.label })),
];

/* A category picker with «+ tab חדשה…» at the bottom. A custom tab is just a
   category string — the Hebrew name itself is stored on the post, and the
   library's tab row picks it up automatically (categoryLabel falls back to
   the raw string). No schema change, no registry: the post carrying the name
   IS the tab's existence. */
function categorySelect(value, onchange) {
  const NEW = '__new__';
  let current = value;
  // customCats (loadShelf) makes tabs created on OTHER posts reappear here —
  // a custom tab is only a category string, so the posts are its registry.
  const opts = [
    ...CATEGORY_OPTIONS,
    ...customCats.map((c) => ({ key: c, label: c })),
    { key: NEW, label: '+ tab חדשה…' },
  ];
  const s = h('select', { class: 'ai-select' },
    opts.map((o) => h('option', { value: o.key, selected: o.key === value }, o.label)));
  if (value && !opts.some((o) => o.key === value)) {
    // an already-chosen custom tab (e.g. a campaign revision) — show it
    s.insertBefore(h('option', { value, selected: true }, value), s.lastChild);
  }
  s.addEventListener('change', () => {
    if (s.value !== NEW) { current = s.value; onchange(current); return; }
    const name = (window.prompt('איך לקרוא ל-tab החדשה בגלריה?') || '').trim();
    if (!name) { s.value = current; return; }
    if (![...s.options].some((o) => o.value === name)) {
      s.insertBefore(h('option', { value: name }, name), s.lastChild);
    }
    s.value = name;
    current = name;
    onchange(name);
  });
  return s;
}

/* ── the form ── */

function renderForm() {
  $('form').replaceChildren(
    mode === 'workshop' ? workshopForm()
      : mode === 'campaign' ? campaignForm()
        : postForm());
}

function postForm() {
  const p = F.post;

  const slideRows = h('div', { class: 'ai-rows' });
  const drawRows = () => {
    slideRows.replaceChildren(...p.slides.map((row, i) => h('div', { class: 'ai-row' },
      h('span', { class: 'ai-row__n' }, String(i + 1)),
      textarea(row.what, (v) => { row.what = v; }, 'מה יופיע בשקופית הזאת', 2),
      select(LAYOUTS, row.layout, (v) => { row.layout = v; }),
      h('button', {
        class: 'ai-x', type: 'button', title: 'הסרת השקופית', 'aria-label': 'הסרת השקופית',
        onclick: () => { p.slides.splice(i, 1); if (!p.slides.length) p.slides.push({ what: '', layout: '' }); drawRows(); },
      }, '✕'))),
    h('button', {
      class: 'btn btn--ghost ai-add', type: 'button',
      onclick: () => { p.slides.push({ what: '', layout: '' }); drawRows(); },
    }, '+ עוד שקופית'));
  };
  drawRows();

  const capBox = textarea(p.caption, (v) => { p.caption = v; }, 'מה שהכיתוב צריך להגיד');
  capBox.disabled = p.captionFromSlides;
  const capToggle = h('label', { class: 'ai-check' },
    h('input', {
      type: 'checkbox', checked: p.captionFromSlides,
      onchange: (e) => { p.captionFromSlides = e.target.checked; capBox.disabled = p.captionFromSlides; },
    }),
    h('span', {}, 'שהמפעל יכתוב את הכיתוב מהשקופיות'));

  return h('div', { class: 'ai-formbody' },
    field('מה הפוסט', textarea(p.intent, (v) => { p.intent = v; },
      'זרם מחשבה מתקבל בברכה — בעברית או באנגלית. למשל: משהו על הורים שמרגישים אשמה כשהם צריכים רגע לעצמם.', 5),
      'זה השדה היחיד שחייב להיות מלא. כל השאר — אם תשאירו ריק, המפעל יחליט.'),

    h('details', { class: 'ai-more' },
      h('summary', {}, 'פירוט לפי שקופיות (לא חובה)'),
      h('p', { class: 'ai-hint' },
        'רמז הפריסה נבדק מול התבניות שכבר קיימות בלוח. אם אין תבנית שמתאימה ' +
        'בדיוק, המפעל ייקח את הקרובה ביותר ויכתוב לכם בדיוק מה הוא עשה — ' +
        'הוא לא ממציא עיצוב חדש.'),
      slideRows),

    field('כיתוב (קפשן)', h('div', {}, capToggle, capBox)),
    field('סיום / קריאה לפעולה', input(p.cta, (v) => { p.cta = v; },
      'למשל: אם זה מהדהד לכם, אנחנו כאן.')),
    field('מדף בספרייה', categorySelect(p.category, (v) => { p.category = v; }),
      'לאיזו לשונית בגלריה הפוסט ייכנס. אפשר גם לפתוח tab חדשה.'),
    field('איורים', textarea(p.illustrations, (v) => { p.illustrations = v; },
      'תיאור חופשי — למשל: דלת פתוחה קצת, או שתי ידיים שלא נוגעות.', 2),
      'המפעל מחפש קודם כול בין האיורים הקיימים לפי התיאור העברי שלהם. ' +
      'אם אין התאמה, הוא רושם «רוצים איור חדש» — או, אם תדליקו את המתג למטה, ' +
      'מצייר איור חדש בקו של הלוח.'),
    generateToggle(p),
    programPullField(p),

    submitBar('שליחה ליצירה'));
}

function campaignForm() {
  const c = F.campaign;

  const linesBox = h('div', { class: 'ai-rows' });
  const drawLines = () => {
    linesBox.replaceChildren(...c.lines.map((row, i) => h('div', { class: 'ai-row' },
      h('span', { class: 'ai-row__n' }, String(i + 1)),
      input(row.line, (v) => { row.line = v; }, `שורה אחת על פוסט ${i + 1}`),
      h('button', {
        class: 'ai-x', type: 'button', title: 'למעלה', 'aria-label': 'למעלה', disabled: i === 0,
        onclick: () => { const t = c.lines[i - 1]; c.lines[i - 1] = c.lines[i]; c.lines[i] = t; drawLines(); },
      }, '▲'),
      h('button', {
        class: 'ai-x', type: 'button', title: 'למטה', 'aria-label': 'למטה', disabled: i === c.lines.length - 1,
        onclick: () => { const t = c.lines[i + 1]; c.lines[i + 1] = c.lines[i]; c.lines[i] = t; drawLines(); },
      }, '▼'),
      h('button', {
        class: 'ai-x', type: 'button', title: 'הסרה', 'aria-label': 'הסרה',
        onclick: () => { c.lines.splice(i, 1); drawLines(); },
      }, '✕'))),
    h('button', {
      class: 'btn btn--ghost ai-add', type: 'button',
      onclick: () => { c.lines.push({ line: '' }); drawLines(); },
    }, '+ עוד פוסט בסדרה'));
  };
  drawLines();

  const newWrap = h('div', {},
    field('מה הקמפיין', textarea(c.brief, (v) => { c.brief = v; },
      'כמה משפטים. למשל: סדרה של 5 פוסטים על שחיקה אצל הורים מהגרים, מהקל אל הכבד, פוסט אחרון עם הזמנה לשיחה.', 5),
      'זה השדה היחיד שחייב להיות מלא בקמפיין חדש.'),
    field('כמה פוסטים', (() => {
      const i = h('input', { class: 'field__input ai-num', type: 'number', min: '2', max: '8',
        value: String(c.count) });
      i.addEventListener('input', () => { c.count = Math.max(2, Math.min(8, Number(i.value) || 3)); });
      return i;
    })(), 'משמש רק כשלא כתבתם שורות לפוסטים בנפרד.'),
    h('details', { class: 'ai-more' },
      h('summary', {}, 'שורה אחת לכל פוסט, בסדר הנכון (לא חובה)'),
      linesBox),
    field('סיום / קריאה לפעולה', input(c.cta, (v) => { c.cta = v; },
      'מה שסוגר את הפוסט האחרון בסדרה')),
    field('מדף בספרייה', categorySelect(c.category, (v) => { c.category = v; })),
    field('איורים', textarea(c.illustrations, (v) => { c.illustrations = v; },
      'תיאור חופשי לכל הסדרה', 2)),
    generateToggle(c),
    programPullField(c));

  const reviseWrap = h('div', {},
    field('איזה קמפיין', campaigns.length
      ? select([{ key: '', label: 'בחרו קמפיין…' },
          ...campaigns.map((x) => ({
            key: x.campaign_id,
            label: `${x.campaign_id} · ${x.posts.length} פוסטים · ${fmtDate(x.created_at)}`,
          }))], c.campaign_id, (v) => { c.campaign_id = v; })
      : h('p', { class: 'muted' }, 'עוד לא נוצר קמפיין בלוח הזה.')),
    field('מה לשנות', textarea(c.instruction, (v) => { c.instruction = v; },
      'למשל: להוריד את הפוסט האמצעי, או: שכל הסדרה תהיה חמה יותר.', 4),
      'המפעל קורא מחדש את כל הפוסטים בסדרה כפי שהם עכשיו בלוח. ' +
      'פוסט שערכתם ביד מאז — העריכה שלכם גוברת, הוא לא נדרס, ' +
      'וזה נכתב בהערות. כל שינוי שכן מוחל נשמר כגרסה חדשה עם מספר, ' +
      'שאפשר לחזור אליה.'));

  const modeToggle = h('label', { class: 'ai-check' },
    h('input', {
      type: 'checkbox', checked: c.revise,
      onchange: (e) => { c.revise = e.target.checked; renderForm(); },
    }),
    h('span', {}, 'רביזיה לקמפיין קיים (במקום קמפיין חדש)'));

  return h('div', { class: 'ai-formbody' },
    modeToggle,
    c.revise ? reviseWrap : newWrap,
    submitBar(c.revise ? 'שליחת הרביזיה' : 'שליחה ליצירה'));
}

/* ── §W: the workshop tab, v2.12 (spec 14) ─────────────────────────────────
   A PICKER, not an intake. The facts of the event live on program.html; what
   this tab asks for is which program, how many posts, where they land, and one
   optional note that belongs to this request and not to the program.

   Every hint here describes a rule the fulfiller actually enforces (spec 13's
   content rules, still written into briefFor, now fed from the program). If a
   rule changes there, change the sentence here: a form that promises a rule the
   factory no longer keeps is worse than a form that promises nothing. */

const OPT = ' (לא חובה)';

// The «אין תוכניות» state, shared by all three tabs. It never says "something
// went wrong": there are exactly two reasons the list is empty, they need
// different actions, and the person reading this can do one of them.
function noProgramsNote() {
  return programsMissing()
    ? h('p', { class: 'ai-hint' },
        'התוכניות עוד לא הופעלו בלוח הזה (מיגרציה 030), ולכן אי אפשר לבחור ' +
        'תוכנית. המפעיל מריץ את זה בעצמו, וכל שאר הכלי עובד כרגיל.')
    : h('p', { class: 'ai-hint' },
        'עוד לא נוצרה תוכנית בלוח הזה. פותחים אחת בעמוד «יצירת תוכנית», ' +
        'ממלאים מה שידוע, וחוזרים לכאן.');
}

/* ── §R: THE RECEIPT IS FROZEN AT PICK TIME ────────────────────────────────
   `program_rev` is a RECEIPT: the version of the program the human was looking
   at when they decided to send this request. The fulfiller compares it against
   the live rev at claim and tells the therapist, in words, whether the details
   moved in between. That alarm is the whole point of the column.

   THE BUG THIS REPLACED, because it is subtle enough to be re-introduced by a
   tidy-up. The rev used to be read at SUBMIT time, out of the `programs` array
   that subscribe() refreshes every ten seconds. So: a therapist picks a program
   whose option reads «גרסה 1»; a colleague changes the price and saves; the poll
   quietly refreshes the array while the OPTION ON SCREEN still says «גרסה 1»;
   the therapist presses send. The payload got rev 2, the fulfiller compared 2
   against a live 2, and the brief said «לא היה שינוי בתוכנית בין שליחת הבקשה
   לבין הכתיבה» — an affirmative all-clear, printed at the exact moment the
   price had in fact changed behind the therapist's back. The alarm disarmed
   itself precisely when it was needed.

   So the rev is captured from the row that BACKS THE LABEL BEING RENDERED, and
   never re-read afterwards:
   · programSelect closes over a SNAPSHOT of the rows its <option>s were built
     from, so a refresh between paint and click cannot substitute a newer rev;
   · freezeRev() re-takes it whenever a form is (re)rendered, which is the only
     moment a fresh label reaches the screen (renderForm runs on mode switch, on
     pick and after submit — never on the background poll);
   · submit() reads the frozen number and does not consult `programs` for it.
   The receipt is therefore "what the human saw", by construction rather than by
   luck. ────────────────────────────────────────────────────────────────── */

// One picker, three tabs. `optional` decides whether the empty option means
// «בלי תוכנית» (post/campaign) or «בחרו תוכנית…» (a workshop, where it is the
// whole request). onchange receives (id, rev) where `rev` belongs to the row
// whose label the person actually clicked.
function programSelect(value, onchange, { optional } = {}) {
  // The rows these options are rendered FROM. Held, not re-read: `programs` is
  // replaced wholesale by every poll tick.
  const shown = programs.slice();
  const opts = [
    { key: '', label: optional ? 'בלי תוכנית' : 'בחרו תוכנית…' },
    ...shown.map((p) => ({
      key: p.id,
      label: `${String(p.title || 'ללא שם')} · גרסה ${p.rev || 1}`,
    })),
  ];
  const s = h('select', { class: 'ai-select' },
    opts.map((o) => h('option', { value: o.key, selected: o.key === value }, o.label)));
  s.addEventListener('change', () => {
    const row = shown.find((p) => String(p.id) === String(s.value)) || null;
    onchange(s.value, revOf(row));
  });
  return s;
}

const revOf = (row) => {
  const n = Math.round(Number(row && row.rev));
  return Number.isFinite(n) && n >= 1 ? n : 1;
};

/* Re-freeze a form model's receipt from the row that is about to be RENDERED.
   Called at the top of every form that carries a picker, which covers the edge
   the pick handler cannot: switching to «קמפיין» and back re-paints a label
   that may now read «גרסה 3», and the receipt has to move with the label or it
   describes a screen nobody ever saw. A program that vanished from the board
   drops the selection rather than leaving a pointer at nothing. */
function freezeRev(model) {
  if (!model.program_id) { model.program_rev = 0; return; }
  const row = programById(model.program_id);
  if (!row) { model.program_id = ''; model.program_rev = 0; return; }
  model.program_rev = revOf(row);
}

// The frozen receipt, read at submit. Never `programById(...).rev`.
function frozenRev(model) {
  const n = Math.round(Number(model && model.program_rev));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// What the picked program actually holds, in one line, plus the way back to it.
// A therapist who is about to spend the factory's time on a program deserves to
// see that six of its ten fields are still empty BEFORE they press send.
function programSummary(id) {
  const p = programById(id);
  if (!p) return null;
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const filled = fields.filter((f) => String((f && f.value) || '').trim()).length;
  return h('p', { class: 'ai-hint' },
    `${filled} מתוך ${fields.length} שדות מלאים · גרסה ${p.rev || 1} · עודכן ` +
      fmtDate(p.updated_at || p.created_at) + ' · ',
    h('a', { href: pageLink('program.html', { id: p.id }) }, 'פתיחת התוכנית'),
    ' (שדה ריק פשוט לא יופיע בפוסטים: אנחנו לא ממציאים תאריך, מחיר או פרטים ' +
    'על המנחה.)');
}

function workshopForm() {
  const s = F.workshop;
  // §R: the label about to be painted and the receipt must agree.
  freezeRev(s);
  const has = programs.length > 0;

  return h('div', { class: 'ai-formbody' },
    h('p', { class: 'ai-hint' },
      'בוחרים תוכנית, והמפעל בונה ממנה סדרת פוסטים לגלריה. הפרטים נקראים ' +
      'מהתוכנית ברגע שהמפעל מתחיל לכתוב, כך שעדכון שתעשו בתוכנית עד אז ייכנס ' +
      'לפוסטים.'),

    has
      ? field('איזו תוכנית',
          programSelect(s.program_id, (v, rev) => {
            s.program_id = v; s.program_rev = v ? rev : 0; renderForm();
          }),
          'התוכניות של הלוח הזה, החדשה למעלה.')
      : field('איזו תוכנית', noProgramsNote()),
    programSummary(s.program_id),

    field('דגשים לבקשה הזאת' + OPT, textarea(s.note, (v) => { s.note = v; },
      'מה חשוב דווקא בסדרה הזאת. למשל: להדגיש שיש עוד שני מקומות, או: בלי ' +
      'להזכיר מחיר הפעם.', 3),
      'ההערה הזאת שייכת לבקשה, לא לתוכנית: היא לא נשמרת בתוכנית ולא משנה אותה.'),

    field('כמה פוסטים', numberInput(s.count, 1, 5, (v) => { s.count = v; }),
      'ברירת המחדל היא שלושה: הכרזה, פוסט ערך, ותזכורת אחרונה לפני המועד. ' +
      'פוסט אחד יהיה ההכרזה בלבד, ומעל שלושה נוספים פוסטי ערך, לא הכרזות נוספות.'),

    field('מדף בספרייה', categorySelect(s.category, (v) => { s.category = v; }),
      'לאיזו לשונית בגלריה הסדרה תיכנס. אפשר גם לפתוח tab חדשה.'),
    field('איורים' + OPT, textarea(s.illustrations, (v) => { s.illustrations = v; },
      'תיאור חופשי לכל הסדרה', 2)),
    generateToggle(s),

    h('p', { class: 'ai-hint' },
      'קישור ההרשמה ייכתב בכיתוב של הפוסט. באינסטגרם קישור בכיתוב אינו לחיץ, ' +
      'ולכן ההפניה שם היא לקישור שבביו; בפייסבוק הוא כן לחיץ. המפעל כותב את ' +
      'זה בהערות של הבקשה.'),

    submitBar('שליחה ליצירה'));
}

// The OPTIONAL picker on «פוסט אחד» and «קמפיין». Hidden entirely when the board
// has no programs, because an empty optional control is pure noise on a form
// whose whole virtue is that one field is required and the rest are not.
function programPullField(model) {
  // §R, same reason as workshopForm: re-freeze from the row backing the label
  // this call is about to render.
  freezeRev(model);
  if (!programs.length) return null;
  return h('div', {},
    field('משיכת פרטים מתוכנית' + OPT,
      programSelect(model.program_id, (v, rev) => {
        model.program_id = v; model.program_rev = v ? rev : 0; renderForm();
      }, { optional: true }),
      'העובדות של התוכנית ייקראו לבקשה הזאת כרקע. הן לא נכתבות אוטומטית ' +
      'לפוסט: המפעל משתמש בהן רק כשהן רלוונטיות למה שביקשתם.'),
    programSummary(model.program_id));
}

function submitBar(label) {
  const btn = h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, label);
  return h('div', { class: 'ai-submit' },
    btn,
    h('span', { class: 'ai-hint' },
      'הפוסט ינחת בגלריה בשלב «בעריכה» על שמכם — אף פעם לא ישר לבדיקה, ' +
      'כדי שתמיד יעבור עליו בן אדם קודם.'));
}

/* ── submit ── */

/* The optional program pointer on a post or a campaign. MUTATES the payload,
   and only when a program was actually chosen — that is the whole point. A
   payload with no program must come out BYTE-IDENTICAL to the one v2.11 wrote,
   because the fulfiller's old-shape briefs are byte-compared against it and
   because a key that is present-but-empty reads downstream as "a program was
   picked and then lost", which is a different and much worse fact. */
function addProgram(payload, model) {
  const prog = programById(model.program_id);
  if (!prog) return payload;
  payload.program_id = prog.id;
  // §R: the FROZEN receipt, not prog.rev. prog is only consulted for existence.
  payload.program_rev = frozenRev(model);
  return payload;
}

async function submit() {
  if (submitting) return;
  // §W: a workshop RIDES kind 'campaign'. sm_gen_requests.kind has a CHECK
  // constraint (post|campaign|style|export) and a workshop genuinely is a
  // campaign — one whose brief happens to be structured. payload.mode is what
  // tells the two apart, everywhere, in both directions.
  const kind = (mode === 'campaign' || mode === 'workshop') ? 'campaign' : 'post';
  let payload;

  if (mode === 'workshop') {
    const s = F.workshop;
    const prog = programById(s.program_id);
    if (!prog) { toast('בחרו קודם תוכנית', 'err'); return; }
    // THE v2.12 SHAPE. No `workshop:{…}` object: the facts are in the program,
    // and the request carries a POINTER plus the rev it pointed at. The
    // fulfiller re-reads the program live at claim, so a detail edited between
    // this click and that claim is the detail that gets written; program_rev is
    // what lets it say so out loud.
    payload = {
      mode: 'workshop',
      program_id: prog.id,
      // §R: the rev of the row whose label they picked, NOT prog.rev, which the
      // background poll may have moved since they looked.
      program_rev: frozenRev(s),
      note: s.note.trim(),
      count: clampCount(s.count, 1, 5, 3),
      category: s.category,
      illustrations: s.illustrations.trim(),
      // §D — the switch applies to every post in the series.
      generate_images: !!s.generateImages,
    };
  } else if (kind === 'post') {
    const p = F.post;
    if (!p.intent.trim()) { toast('כתבו קודם מה הפוסט — זה השדה היחיד שחייב', 'err'); return; }
    payload = {
      mode: 'post',
      intent: p.intent.trim(),
      slides: p.slides.filter((s) => s.what.trim() || s.layout)
        .map((s) => ({ what: s.what.trim(), layout: s.layout || '' })),
      caption: p.captionFromSlides ? 'from-slides' : p.caption.trim(),
      cta: p.cta.trim(),
      category: p.category,
      illustrations: p.illustrations.trim(),
      // §D. Always sent, never inferred: the fulfiller treats a missing field as
      // OFF, and an explicit false is the record of what the therapist chose.
      generate_images: !!p.generateImages,
    };
    addProgram(payload, p);
  } else {
    const c = F.campaign;
    if (c.revise) {
      if (!c.campaign_id) { toast('בחרו איזה קמפיין לתקן', 'err'); return; }
      if (!c.instruction.trim()) { toast('כתבו מה לשנות', 'err'); return; }
      payload = { mode: 'campaign', revise: { campaign_id: c.campaign_id, instruction: c.instruction.trim() } };
    } else {
      if (!c.brief.trim()) { toast('כתבו קודם מה הקמפיין', 'err'); return; }
      payload = {
        mode: 'campaign',
        brief: c.brief.trim(),
        count: c.count,
        posts: c.lines.filter((l) => l.line.trim()).map((l) => ({ line: l.line.trim() })),
        cta: c.cta.trim(),
        category: c.category,
        illustrations: c.illustrations.trim(),
        // §D — in campaign mode the switch applies to every member post.
        generate_images: !!c.generateImages,
      };
      addProgram(payload, c);
    }
  }

  submitting = true;
  try {
    await ensureName();                 // the request carries who asked for it
    await createGenRequest({ kind, payload });
    toast('הבקשה נכנסה לתור ✓', 'ok');
    // v2.12: the only per-REQUEST text a workshop still carries is the note, so
    // that is what resets. The chosen program does NOT: a team usually sends two
    // or three requests about the same workshop, and re-picking it every time
    // was the friction spec 14 set out to remove. Count, shelf, illustrations
    // and the image switch survive, like everywhere else.
    if (mode === 'workshop') F.workshop.note = '';
    else if (kind === 'post') F.post.intent = '';
    else if (!F.campaign.revise) F.campaign.brief = '';
    else F.campaign.instruction = '';
    renderForm();
    await refreshRequests();
  } catch (err) {
    toast('הבקשה לא נשלחה: ' + String((err && err.message) || err), 'err');
  } finally {
    submitting = false;
  }
}

/* ── the status column ────────────────────────────────────────────────
   Honest by construction: it prints the row's real status and nothing else.
   «בתור» means nobody has picked it up yet — which, when the factory session
   is off, can be hours. Saying that plainly is the feature. */

async function refreshRequests() {
  let rows = [];
  try { rows = (await listGenRequests()) || []; }
  catch (err) {
    $('requests').replaceChildren(h('p', { class: 'muted' },
      'רשימת הבקשות לא נטענה: ' + String((err && err.message) || err)));
    return;
  }
  requests = rows;
  campaigns = campaignsFrom(rows);
  renderRequests();
}

// request id -> the last status this browser rendered. A queued/working →
// done transition observed HERE is the moment the therapist's post is born —
// that is when the ready banner pops and the shelf gains a «חדש» card.
const seenStatus = new Map();

function renderRequests() {
  const newlyDone = [];
  for (const r of requests) {
    const prev = seenStatus.get(r.id);
    if (prev && prev !== 'done' && r.status === 'done') newlyDone.push(r);
    seenStatus.set(r.id, r.status);
  }
  if (newlyDone.length) {
    for (const r of newlyDone) {
      for (const p of ((r.result || {}).posts || [])) {
        if (p.post_id) freshPosts.add(p.post_id);
      }
    }
    toast('🎉 הפוסט מוכן! הקישור למעלה ובמדף', 'ok');
    loadShelf().catch(() => {});
  }

  const me = whoAmI();
  const mine = requests.filter((r) => r.author_id && me.author_id && r.author_id === me.author_id);
  const list = mine.length ? mine : requests;
  const box = $('requests');
  if (!list.length) {
    box.replaceChildren(h('p', { class: 'muted' }, 'עוד לא שלחתם בקשה.'));
    return;
  }
  const ready = list.find((r) => r.status === 'done' &&
    ((r.result || {}).posts || []).some((p) => freshPosts.has(p.post_id)));
  box.replaceChildren(
    ready ? readyBanner(ready) : null,
    ...(mine.length ? [] : [h('p', { class: 'ai-hint' }, 'הבקשות של כל הצוות בלוח:')]),
    ...list.slice(0, 30).map(requestCard));
}

// The «it's ready» card — pinned above the request list from the moment the
// factory finishes until the page is left. The post stops being something to
// hunt for in the gallery.
function readyBanner(r) {
  const posts = ((r.result || {}).posts || []).filter((p) => p.post_id);
  return h('article', { class: 'card ai-ready' },
    h('p', { class: 'ai-ready__head' }, '🎉 הפוסט מוכן!'),
    ...posts.map((p) => h('a', {
      class: 'btn btn--primary ai-ready__link',
      href: pageLink('post.html', { id: p.post_id }),
    }, (p.seq ? `${p.seq}. ` : '') + (p.title || p.post_id) + ' ←')));
}

/* The honest progress row: three real stages of the queue, no fake percent.
   queued = the row exists; working = the factory session claimed it (writing,
   voice gate, drawing); done = the card above takes over. */
function progressRow(status) {
  if (status !== 'queued' && status !== 'working') return null;
  const steps = ['בתור', 'המפעל כותב ומצייר', 'מוכן'];
  const on = status === 'queued' ? 0 : 1;
  return h('div', { class: 'ai-prog' },
    h('div', { class: 'ai-prog__bar' },
      h('div', {
        class: 'ai-prog__fill' + (status === 'working' ? ' ai-prog__fill--anim' : ''),
        style: `width:${status === 'queued' ? 14 : 58}%`,
      })),
    h('div', { class: 'ai-prog__steps' },
      ...steps.map((s, i) => h('span', { class: 'ai-prog__step' + (i <= on ? ' is-on' : '') }, s))));
}

function requestCard(r) {
  const status = String(r.status || 'queued');
  const res = r.result || {};
  const posts = res.posts || [];

  const head = h('div', { class: 'ai-req__head' },
    h('span', { class: `ai-chip ai-chip--${status}` }, GEN_STATUS_LABELS[status] || status),
    h('span', { class: 'ai-req__kind' }, kindWord(r)),
    h('span', { class: 'ai-req__when' }, fmtDate(r.created_at)));

  const what = summarise(r);

  // The waiting states say what waiting MEANS, every time — not once in a
  // footnote. A therapist who left the tab open for an hour deserves the
  // reason, not a spinner.
  const waiting = status === 'queued'
    ? h('p', { class: 'ai-hint' },
        'ממתין שסשן המפעל יאסוף את הבקשה. כשהוא פעיל — דקות; כשהוא כבוי — ' +
        'הבקשה נשמרת ותיאסף כשהוא נדלק.')
    : status === 'working'
      ? h('p', { class: 'ai-hint' }, 'המפעל עובד על זה עכשיו.')
      : null;

  const links = posts.filter((p) => p.post_id).map((p) => h('a', {
    class: 'ai-postlink', href: pageLink('post.html', { id: p.post_id }),
  }, (p.seq ? `${p.seq}. ` : '') + (p.title || p.post_id)));

  const fail = status === 'failed'
    ? h('div', { class: 'ai-fail' },
        h('b', {}, 'למה זה נכשל'),
        h('p', {}, res.error || 'לא נמסרה סיבה.'),
        (res.notes || []).length
          ? h('ul', {}, (res.notes || []).map((n) => h('li', {}, n)))
          : null)
    : null;

  return h('article', { class: 'card ai-req' },
    head,
    h('p', { class: 'ai-req__what' }, what),
    progressRow(status),
    waiting,
    links.length ? h('div', { class: 'ai-links' }, links) : null,
    fail,
    (status === 'done' || status === 'failed') ? howMadeBlock(r) : null);
}

function summarise(r) {
  const p = r.payload || {};
  if (r.kind === 'campaign') {
    if (p.revise) return `רביזיה ל־${p.revise.campaign_id}: ${p.revise.instruction || ''}`;
    // §W. Two shapes live here forever (see §W above): the v2.12 pointer
    // {program_id, program_rev} and v2.11's inline `workshop` OBJECT — which the
    // campaign fallback below would print as «[object Object]» the moment an old
    // queued row reached this list. Both read the same way to a therapist: the
    // name of the thing, and how many posts were asked for.
    if (p.mode === 'workshop') {
      const n = Number(p.count) || 3;
      if (p.program_id) {
        const prog = programById(p.program_id);
        // The row records which REV it was sent against; if the program has moved
        // since, say so here rather than only in the fulfiller's notes.
        const title = prog ? String(prog.title || 'ללא שם') : 'תוכנית שלא נמצאה';
        const moved = prog && Number(prog.rev) !== Number(p.program_rev)
          ? ` · התוכנית עודכנה מאז (גרסה ${p.program_rev} ⟵ ${prog.rev})` : '';
        return `תוכנית «${title}» · ${n} פוסטים${moved}`;
      }
      const w = p.workshop || {};
      const title = String(w.title || '').trim() || 'ללא שם';
      return `סדנה «${title}» · ${n} פוסטים`;
    }
    return p.brief || 'קמפיין';
  }
  // spec 09 §B — a style request has no intent and no brief; what it has is a
  // name and a pile of references.
  if (r.kind === 'style') {
    const n = (p.refs || []).length;
    return `סגנון «${p.name || 'ללא שם'}»` + (n ? ` · ${n} רפרנסים` : ' · בלי רפרנסים');
  }
  return p.intent || 'פוסט';
}

const KIND_WORD = { campaign: 'קמפיין', style: 'סגנון', post: 'פוסט' };

// The chip beside the status. A workshop row's `kind` really is 'campaign', so
// the word comes from the payload, not from the column: the therapist who sent
// «סדנה» should read «סדנה» back.
function kindWord(r) {
  if (r.kind === 'campaign' && ((r.payload || {}).mode === 'workshop')) return 'סדנה';
  return KIND_WORD[r.kind] || 'פוסט';
}

/* =====================================================================
 * «איך זה נוצר» — the transparency block. Rendered here, mounted by BOTH
 * this page and post.js (mountHowMade below). The fulfiller's own words,
 * unedited: which templates it chose and why, which drawings it placed, what
 * it could not honor, and the per-stage timeline it logged.
 * ===================================================================== */

const STAGE_LABELS = {
  'brief': 'קריאת הבקשה',
  'generation': 'כתיבה',
  'voice gate': 'שער הקול (VOICE.md)',
  'template fit': 'התאמת תבניות',
  'render check': 'בדיקת גלישה',
  'illustration generation': 'יצירת איורים',
  'style': 'שמירת הסגנון',
  'write': 'שמירה ללוח',
  'campaign revision': 'רביזיית קמפיין',
};

// `only` narrows the post-level detail to one post id (post.html shows the
// story of THIS post, not of every post in the campaign).
export function howMadeBlock(request, { only = null, open = false } = {}) {
  if (!request) return null;
  const res = request.result || {};
  const posts = (res.posts || []).filter((p) => !only || p.post_id === only);
  const log = res.log || [];

  const perPost = posts.map((p) => h('div', { class: 'hm-post' },
    posts.length > 1 && !only
      ? h('b', { class: 'hm-post__t' }, (p.seq ? `${p.seq}. ` : '') + (p.title || p.post_id))
      : null,
    (p.templates || []).length
      ? h('ul', { class: 'hm-list' }, (p.templates || []).map((t, i) => h('li', {},
          h('span', { class: 'hm-k' }, `שקופית ${i + 1}`),
          h('code', {}, t.template),
          t.why ? h('span', { class: 'hm-why' }, ' — ' + t.why) : null)))
      : null,
    (p.illustrations || []).length
      ? h('ul', { class: 'hm-list' }, (p.illustrations || []).map((s) => h('li', {},
          h('span', { class: 'hm-k' }, 'איור'),
          h('code', {}, s.name || '—'),
          s.label ? h('span', {}, ' · ' + s.label) : null,
          s.why ? h('span', { class: 'hm-why' }, ' — ' + s.why) : null)))
      : null,
    (p.notes || []).length
      ? h('ul', { class: 'hm-list hm-list--notes' }, (p.notes || []).map((n) => h('li', {}, n)))
      : null,
    p.vnum ? h('p', { class: 'ai-hint' }, `נשמר כגרסה v${p.vnum} בשרשרת הגרסאות.`) : null));

  const timeline = log.length
    ? h('ol', { class: 'hm-log' }, log.map((l) => h('li', { class: l.ok ? '' : 'is-bad' },
        h('span', { class: 'hm-log__i' }, l.ok ? '✓' : '✗'),
        h('span', { class: 'hm-log__s' }, STAGE_LABELS[l.stage] || l.stage),
        h('span', { class: 'hm-log__ms' }, `${l.ms}ms`),
        l.detail ? h('span', { class: 'hm-log__d' }, l.detail) : null)))
    : null;

  const notes = (res.notes || []).length
    ? h('ul', { class: 'hm-list hm-list--notes' }, (res.notes || []).map((n) => h('li', {}, n)))
    : null;

  return h('details', { class: 'hm', open: open || undefined },
    h('summary', {}, 'איך זה נוצר'),
    h('div', { class: 'hm-body' },
      h('p', { class: 'ai-hint' },
        'נוצר בבקשה של ' + (request.author || 'לא ידוע') + ' · ' + fmtDate(request.created_at) +
        // kindWord, not the raw column: a workshop's row is a campaign, and
        // post.html mounts this same block.
        (request.kind === 'campaign' ? ' · ' + kindWord(request) : '')),
      notes,
      ...perPost,
      timeline
        ? h('div', {}, h('b', { class: 'hm-post__t' }, 'שלבי הצינור'), timeline)
        : null));
}

// The ONE call post.js makes. It hands over the post row and the board's
// request rows it already fetched; this decides whether there is anything to
// show and mounts it. Returns true when it rendered something.
export function mountHowMade(slot, post, requestRows) {
  if (!slot) return false;
  slot.replaceChildren();
  if (!post || post.origin !== 'ai') return false;
  // store.js owns the "which request tells this post's story" rule — one
  // definition, so this page and any future surface answer the same way.
  const req = genRequestForPost(requestRows, post.id);
  if (!req) {
    // origin 'ai' but no request row we can read: say so rather than hide it.
    slot.replaceChildren(h('details', { class: 'hm' },
      h('summary', {}, 'איך זה נוצר'),
      h('div', { class: 'hm-body' },
        h('p', { class: 'ai-hint' },
          'הפוסט נוצר עם AI, אבל רשומת הבקשה שהפיקה אותו כבר לא זמינה בלוח.'))));
    return true;
  }
  const block = howMadeBlock(req, { only: post.id });
  if (!block) return false;
  slot.replaceChildren(block);
  return true;
}
