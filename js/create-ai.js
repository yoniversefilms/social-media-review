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
} from './store.js';
import {
  el as h, navBar, toast, fmtDate, CATEGORIES, stageLabel,
  toLocalInput, fromLocalInput,
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

/* ── §W: the workshop event's own fields (spec 13) ─────────────────────────
   These eleven keys ARE the payload's `workshop` object, in the contract's
   order, and they are the therapist's typed facts about a real event. Two are
   required (title, about); the other nine say «לא חובה» in their label,
   because a blank one is not a gap to fill in later, it is an instruction to
   the factory: a fact nobody gave is a fact no post may claim.

   `when` holds LOCAL wall-clock exactly as <input type="datetime-local">
   produces it ('2026-09-14T19:00', no Z). It is NOT run through
   .toISOString(): the fulfiller and the generating session read this string as
   the hour on the invitation, and a Z would move that hour by the UTC offset
   in silence. toLocalInput/fromLocalInput (ui.js) are still what normalise it,
   round-tripping local → instant → local so a garbage value drops out. */
const WORKSHOP_FIELDS = () => ({
  title: '', about: '', facilitator: '', when: '', when_note: '', where: '',
  audience: '', cost: '', register_url: '', takeaways: '', emphasis: '',
});

// The form's own model. Kept outside the DOM so switching modes (and the
// status poll re-rendering the side column) never eats a half-written request.
const F = {
  post: { intent: '', slides: [{ what: '', layout: '' }], caption: '', captionFromSlides: true,
          cta: '', category: 'general', illustrations: '', generateImages: true },
  campaign: { brief: '', count: 5, lines: [], caption: '', cta: '',
              category: 'general', illustrations: '', generateImages: true,
              revise: false, campaign_id: '', instruction: '' },
  workshop: { w: WORKSHOP_FIELDS(), count: 3,
              category: 'general', illustrations: '', generateImages: true },
};

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
  renderForm();
  await refreshRequests();
  subscribe(() => { refreshRequests(); loadShelf().catch(() => {}); });
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

// The datetime-local bridge, the same one post.js and queue.js use. The value
// that reaches the model is LOCAL wall-clock, never an ISO Z string: see §W.
function whenInput(value, oninput) {
  const i = h('input', { class: 'field__input', type: 'datetime-local',
    value: value || '' });
  i.addEventListener('input', () => oninput(i.value));
  return i;
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

// The datetime-local bridge, plus one guard the bridge lacks: ECMA-262 ROLLS a
// calendar-overflow date ('2026-02-29' parses as March 1) instead of failing,
// and a rolled date would ride the payload as a real evening the therapist
// never wrote. The written day must survive the round trip, or the value
// drops to '' exactly like an unparsable one.
function canonWhen(v) {
  const s = String(v || '').trim();
  const out = s ? toLocalInput(fromLocalInput(s)) : '';
  return out && out.slice(0, 10) === s.slice(0, 10) ? out : '';
}

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
    generateToggle(c));

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

/* ── §W: the workshop intake (spec 13) ─────────────────────────────────────
   A structured form, not a brief. The therapist types the event's real facts
   once, and the factory writes the series from them. The row this produces is
   an ordinary kind:'campaign' carrying payload.mode 'workshop', so campaign
   revision, versions, the author shelf and «איך זה נוצר» all work the day it
   lands, with no schema change and no new queue kind.

   Every hint here describes a rule the fulfiller actually enforces (spec 13's
   content rules, written into briefFor). If a rule changes there, change the
   sentence here: a form that promises a rule the factory no longer keeps is
   worse than a form that promises nothing. */

const OPT = ' (לא חובה)';

function workshopForm() {
  const s = F.workshop;
  const w = s.w;

  return h('div', { class: 'ai-formbody' },
    h('p', { class: 'ai-hint' },
      'ממלאים כאן את הפרטים האמיתיים של הסדנה, והמפעל בונה מהם סדרת פוסטים ' +
      'לגלריה. שדה שתשאירו ריק פשוט לא יופיע בפוסטים: אנחנו לא ממציאים ' +
      'תאריך, מחיר או פרטים על המנחה.'),

    field('שם הסדנה', input(w.title, (v) => { w.title = v; },
      'איך קוראים לסדנה')),
    field('על מה הסדנה', textarea(w.about, (v) => { w.about = v; },
      'כמה משפטים בשפה שלכם. למשל: ארבעה מפגשים להורים לילדים קטנים, על הרגעים ' +
      'שבהם נגמרת הסבלנות ומה עושים איתם.', 5),
      'שני השדות האלה חייבים להיות מלאים. כל השאר לא חובה.'),

    field('מי מנחה' + OPT, input(w.facilitator, (v) => { w.facilitator = v; },
      'שם, ושורה אחת עליו או עליה'),
      'ייכתב בדיוק כפי שתכתבו כאן. המפעל לא מוסיף תארים והסמכות מעצמו.'),

    field('מתי' + OPT, whenInput(w.when, (v) => { w.when = v; }),
      'תאריך ושעה לפי השעון המקומי שלכם. יום בשבוע והתאריך ייכתבו בפוסטים ' +
      'מהערך הזה בלבד.'),
    field('הערה על המועד' + OPT, input(w.when_note, (v) => { w.when_note = v; },
      'למשל: סדרה של ארבעה מפגשים, או: המועד יתואם בהמשך'),
      'אם עוד אין תאריך מדויק, כתבו כאן מה כן ידוע, וזה יופיע במקומו.'),

    field('איפה' + OPT, input(w.where, (v) => { w.where = v; },
      'זום, או כתובת')),
    field('למי זה מיועד' + OPT, input(w.audience, (v) => { w.audience = v; },
      'למשל: הורים לילדים עד גיל שש')),
    field('עלות' + OPT, input(w.cost, (v) => { w.cost = v; },
      'טקסט חופשי. למשל: 120 ש"ח למפגש')),
    h('p', { class: 'ai-hint' },
      'שדה העלות ריק פירושו שהפוסטים לא יזכירו מחיר בכלל. הם לא יכתבו «חינם» ' +
      'ולא ינחשו סכום.'),

    field('קישור להרשמה' + OPT, input(w.register_url, (v) => { w.register_url = v; },
      'https://')),
    field('מה משתתפים מקבלים' + OPT, textarea(w.takeaways, (v) => { w.takeaways = v; },
      'למשל: כלים מעשיים לרגע הסערה, וקבוצה קטנה שאפשר לדבר בה', 3)),
    field('דגשים לשיווק' + OPT, textarea(w.emphasis, (v) => { w.emphasis = v; },
      'מה חשוב שיודגש, או מה עדיף לא לכתוב', 3)),

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

function submitBar(label) {
  const btn = h('button', { class: 'btn btn--primary', type: 'button', onclick: submit }, label);
  return h('div', { class: 'ai-submit' },
    btn,
    h('span', { class: 'ai-hint' },
      'הפוסט ינחת בגלריה בשלב «בעריכה» על שמכם — אף פעם לא ישר לבדיקה, ' +
      'כדי שתמיד יעבור עליו בן אדם קודם.'));
}

/* ── submit ── */

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
    const w = s.w;
    if (!w.title.trim()) { toast('כתבו קודם את שם הסדנה', 'err'); return; }
    if (!w.about.trim()) { toast('כתבו על מה הסדנה', 'err'); return; }
    // All eleven keys ride every time, empty ones included: the brief shows
    // the session exactly which facts it was and was NOT given, and an absent
    // key would look like a field this build forgot rather than a field the
    // therapist left blank on purpose.
    payload = {
      mode: 'workshop',
      workshop: {
        title: w.title.trim(),
        about: w.about.trim(),
        facilitator: w.facilitator.trim(),
        // Normalised through the bridge in both directions, so what lands is
        // canonical local wall-clock; unparsable AND rolled-over values drop
        // to '' (canonWhen).
        when: canonWhen(w.when),
        when_note: w.when_note.trim(),
        where: w.where.trim(),
        audience: w.audience.trim(),
        cost: w.cost.trim(),
        register_url: w.register_url.trim(),
        takeaways: w.takeaways.trim(),
        emphasis: w.emphasis.trim(),
      },
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
    }
  }

  submitting = true;
  try {
    await ensureName();                 // the request carries who asked for it
    await createGenRequest({ kind, payload });
    toast('הבקשה נכנסה לתור ✓', 'ok');
    // The workshop's EVENT fields reset, its settings do not: the next request
    // is a different event, and leaving a facilitator or an address behind is
    // how a second workshop gets announced with the first one's details. Count,
    // shelf, illustrations and the image switch survive, like everywhere else.
    if (mode === 'workshop') F.workshop.w = WORKSHOP_FIELDS();
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
    // §W. `workshop` is an OBJECT, so the campaign fallback below would print
    // «[object Object]» the moment a workshop row reaches this list. It reads
    // the title, and says how many posts were asked for.
    if (p.mode === 'workshop') {
      const w = p.workshop || {};
      const title = String(w.title || '').trim() || 'ללא שם';
      const n = Number(p.count) || 3;
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
