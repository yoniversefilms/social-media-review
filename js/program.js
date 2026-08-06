// program.js — «יצירת תוכנית» (spec 14): the living program document.
// Owner: programs module. Hebrew UI, RTL.
//
// WHAT THIS PAGE IS, AND WHY IT REPLACED A FORM
// Spec 13 gave «יצירה עם AI» a workshop intake: eleven fields, filled once,
// submitted, gone. The facts of a real program do not behave like that. The date
// moves, the facilitator changes, someone adds «מה להביא» six weeks in, and the
// next request re-types all of it from memory. So the intake became an OBJECT: a
// row in sm_programs (migration 030) holding a title and an ORDERED list of
// {id, label, value} rows, edited in place by the whole team.
//
// THREE RULES THIS FILE EXISTS TO KEEP
//
// 1. NOTHING HERE TRUSTS ITS OWN DATA. Labels and values are typed by people,
//    and migration 030 grants anon UPDATE by design, so every one of them is
//    attacker-writable text. Every string reaches the DOM through el() /
//    createTextNode / an input's .value property. There is no innerHTML in this
//    file and there must never be one.
//
// 2. A SAVE NEVER CLOBBERS. The editor remembers the `rev` it loaded and the
//    exact bytes it loaded (`loaded`). store.saveProgram sends
//    `rev = loaded + 1` under a `rev=eq.<loaded>` guard, so a save that lost a
//    race matches zero rows and throws `.conflict`. What happens then is the
//    interesting part and it is NOT "reload and lose your typing": mergeOnto()
//    re-applies ONLY the fields THIS person actually changed on top of the other
//    person's fresh row, and a modal names both sides. Nothing is written until
//    they press save again.
//
// 3. THE ORDER IS THE DATA. There is no `sort` column: the array order IS the
//    order, and the drag-reorder rewrites the array. The drag maths are in
//    PHYSICAL pixels (clientY + getBoundingClientRect) for a reason spelled out
//    at beginDrag().

import {
  initStore, subscribe,
  listPrograms, getProgram, createProgram, saveProgram,
  softDeleteProgram, restoreProgram,
  listProgramAssets, programTag, programsMissing,
  uploadAsset, deleteAssets, restoreAssets, assetRowUrl,
} from './store.js';
import {
  el as h, navBar, toast, modal, fmtDate, uploadProgress, undoToast,
  toLocalInput, fromLocalInput,
} from './ui.js';

const $ = (id) => document.getElementById(id);

/* ── §S: the seeded field rows ─────────────────────────────────────────────
   A new program starts as spec 13's workshop intake, one row per field, in the
   contract's order. The IDS ARE A CONTRACT with scripts/fulfill.mjs: a row whose
   id is `when` gets the date-fidelity treatment (workshopWhen there, canonWhen
   here), `register_url` gets the link-in-bio note, and every OTHER row — seeded
   or custom — travels as an opaque fenced label+value pair. Renaming an id here
   without renaming it there does not break anything loudly; it silently drops a
   content rule, which is worse. Change both.

   The LABELS are read-only in the editor (operator directive, 2026-08-05):
   a custom field is named once, in the «+ שדה» dialog, and keeps that name.
   Downstream nothing cares either way, because the label rides to the brief
   beside the value. */
const SEED_FIELDS = () => ([
  { id: 'about',        label: 'על מה הסדנה',           value: '' },
  { id: 'facilitator',  label: 'מי מנחה',                value: '' },
  { id: 'when',         label: 'מתי',                    value: '' },
  { id: 'when_note',    label: 'הערה על המועד',          value: '' },
  { id: 'where',        label: 'איפה',                   value: '' },
  { id: 'audience',     label: 'למי זה מיועד',           value: '' },
  { id: 'cost',         label: 'עלות',                   value: '' },
  { id: 'register_url', label: 'קישור להרשמה',           value: '' },
  { id: 'takeaways',    label: 'מה משתתפים מקבלים',      value: '' },
  { id: 'emphasis',     label: 'דגשים לשיווק',           value: '' },
]);

// Placeholders by seeded id, so a fresh program explains itself without a wall
// of help text. A custom field gets none, which is correct: nobody but the
// person who made it knows what belongs in it.
const SEED_HINTS = {
  about: 'כמה משפטים בשפה שלכם. למשל: ארבעה מפגשים להורים לילדים קטנים.',
  facilitator: 'שם, ושורה אחת עליו או עליה',
  when_note: 'למשל: סדרה של ארבעה מפגשים, או: המועד יתואם בהמשך',
  where: 'זום, או כתובת',
  audience: 'למשל: הורים לילדים עד גיל שש',
  cost: 'טקסט חופשי. למשל: 120 ש"ח למפגש',
  register_url: 'https://',
  takeaways: 'למשל: כלים מעשיים לרגע הסערה, וקבוצה קטנה שאפשר לדבר בה',
  emphasis: 'מה חשוב שיודגש, או מה עדיף לא לכתוב',
};

/* ── state ── */
let board = null;
let programs = [];
let openId = null;        // the program being edited, from ?id=
let cur = null;           // the row as it came back from the server
let loaded = null;        // {title, fields} snapshot of what THIS editor loaded
let draft = null;         // {title, fields} being edited
let baseRev = 0;          // the rev `loaded` came from — the optimistic guard
let locked = true;        // 🔒 editing · 🔓 reordering
let dirty = false;
let saving = false;
let assets = [];
let stale = false;        // someone else saved while we have unsaved text
let gone = false;         // the program was deleted while this editor is open

boot();

async function boot() {
  try {
    board = await initStore();
  } catch (err) {
    $('page').replaceChildren(h('p', { class: 'muted' },
      'לא הצלחנו להתחבר ללוח. בדקו שהקישור שקיבלתם שלם, ונסו לרענן. ' +
      String((err && err.message) || err)));
    return;
  }
  $('nav').replaceChildren(navBar('program'));
  openId = new URLSearchParams(location.search).get('id') || null;

  // A half-typed program is worth a browser prompt. The message is the
  // browser's own (they all ignore ours now); returnValue is what arms it.
  window.addEventListener('beforeunload', (e) => {
    if (!dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });

  await refresh();
  subscribe(() => { poll().catch(() => {}); });
}

/* ── data ── */

async function refresh() {
  try {
    programs = await listPrograms();
  } catch (err) {
    $('page').replaceChildren(h('p', { class: 'muted' },
      'רשימת התוכניות לא נטענה: ' + String((err && err.message) || err)));
    return;
  }
  if (!openId) { renderList(); return; }
  cur = programs.find((p) => String(p.id) === String(openId)) || null;
  if (!cur) { renderMissingProgram(); return; }
  adopt(cur);
  await loadAssets();
  renderEditor();
}

// Take a server row as the editor's new base. Deep-copied twice on purpose:
// `loaded` is the immutable record of what this editor was shown (the merge
// needs it byte-for-byte), `draft` is what the person edits.
function adopt(row) {
  const snap = { title: String(row.title || ''), fields: cloneFields(row.fields) };
  loaded = snap;
  draft = { title: snap.title, fields: cloneFields(snap.fields) };
  baseRev = Math.round(Number(row.rev)) || 1;
  dirty = false;
  stale = false;
}

/* PURE. The comparable form of a {title, fields} snapshot: positional arrays,
   never objects. Two snapshots that a person would call identical must produce
   the same string, and object key order cannot be relied on for that once a
   value has been through jsonb and back. Used by the no-op save check (P5). */
function canonSnapshot(s) {
  return JSON.stringify([
    String((s && s.title) || ''),
    ((s && s.fields) || []).map((f) => [
      String((f && f.id) || ''),
      String((f && f.label) != null ? f.label : ''),
      String((f && f.value) != null ? f.value : ''),
    ]),
  ]);
}

function cloneFields(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: String((r && r.id) || ''),
    label: String((r && r.label) != null ? r.label : ''),
    value: String((r && r.value) != null ? r.value : ''),
  }));
}

async function loadAssets() {
  try { assets = await listProgramAssets(openId); }
  catch { assets = []; }
}

/* The background tick. It must never eat typing, so it only acts on the states
   where acting is safe: the LIST (always re-render), and an editor with NO
   unsaved text (adopt the fresh row silently). An editor that IS dirty gets a
   banner instead, because pulling the rug out from under someone mid-sentence is
   the bug this whole file is built to avoid.

   THE DELETED CASE IS NOT SILENCE. getProgram() answers null for a soft-deleted
   row, and the first cut simply returned — so a teammate could delete the
   program and this editor would keep looking perfectly healthy, with a save
   button that was going to fail. It says so now, once, and keeps every typed
   character on screen. */
async function poll() {
  if (!openId) { await refresh(); return; }
  let fresh;
  try { fresh = await getProgram(openId); } catch { return; }
  if (!fresh) {
    if (!gone) {
      gone = true;
      renderEditor();
      toast('התוכנית נמחקה בינתיים. הטקסט שלכם נשאר על המסך.', 'err');
    }
    return;
  }
  if (gone) { gone = false; renderEditor(); }        // somebody restored it
  const moved = Math.round(Number(fresh.rev)) !== baseRev;
  if (!moved) return;
  if (!dirty) { cur = fresh; adopt(fresh); await loadAssets(); renderEditor(); return; }
  if (!stale) { stale = true; renderEditor(); }
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

/* ── the list ── */

function renderList() {
  // P7: under an unapplied 030 the whole bar goes, button and blurb both. The
  // spec says the ACTIONS hide, and a «+ תוכנית חדשה» that opens a dialog whose
  // confirm always fails is not a hidden action, it is a trap with a friendly
  // face. The migration card below is the only thing this page can honestly
  // offer there.
  if (programsMissing()) {
    $('page').replaceChildren(migrationCard());
    return;
  }

  const head = h('div', { class: 'pg-listbar' },
    h('button', {
      class: 'btn btn--primary', type: 'button', onclick: newProgram,
    }, '+ תוכנית חדשה'),
    h('span', { class: 'pg-hint' },
      'תוכנית חדשה נפתחת עם שדות הסדנה המוכרים, ואפשר להוסיף, לשנות שם ולסדר מחדש.'));

  if (!programs.length) {
    $('page').replaceChildren(head,
      h('p', { class: 'muted pg-empty' },
        'עוד לא נוצרה תוכנית בלוח הזה. התוכנית הראשונה היא בדרך כלל הסדנה הקרובה.'));
    return;
  }

  $('page').replaceChildren(head,
    h('div', { class: 'pg-cards' }, programs.map(programCard)));
}

function programCard(p) {
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const filled = fields.filter((f) => String((f && f.value) || '').trim()).length;
  return h('article', { class: 'card pg-card' },
    h('a', { class: 'pg-card__title', href: pageLink('program.html', { id: p.id }) },
      // createTextNode via el's child path: a title is therapist-typed text and
      // never markup, here or anywhere else on this page.
      // P6: <bdi>, like every other therapist-text sink on this page. Without it
      // a title carrying U+202E (RIGHT-TO-LEFT OVERRIDE) reverses the characters
      // AFTER it in the card, so a program can be made to display a neighbour's
      // name. The isolation is a display fix, not a security boundary; the
      // security boundary is that this is a text node.
      h('bdi', {}, String(p.title || 'ללא שם'))),
    h('p', { class: 'pg-card__meta' },
      h('span', { class: 'pg-chip' }, 'גרסה ' + String(p.rev || 1)),
      h('span', {}, `${filled} מתוך ${fields.length} שדות מלאים`),
      h('span', {}, 'עודכן ' + fmtDate(p.updated_at || p.created_at) +
        (p.updated_by ? ' · ' + String(p.updated_by) : ''))),
    h('div', { class: 'pg-card__acts' },
      h('a', { class: 'btn btn--ghost', href: pageLink('program.html', { id: p.id }) }, 'פתיחה'),
      h('button', {
        class: 'btn btn--ghost', type: 'button', onclick: () => removeProgram(p),
      }, 'מחיקה')));
}

// The Hebrew explanation for a board where 030 has not been applied. It says
// what is missing and what still works, because "something went wrong" on a page
// whose whole job is a table is not information.
function migrationCard() {
  return h('article', { class: 'card pg-mig' },
    h('h2', {}, 'התוכניות עוד לא הופעלו בלוח הזה'),
    h('p', {},
      'הטבלה של התוכניות (מיגרציה 030) עוד לא הורצה בשרת, ולכן אי אפשר ליצור ' +
      'או לשמור תוכנית כאן. זה לא תקלה בדפדפן: המפעיל מריץ את המיגרציה בעצמו.'),
    h('p', { class: 'pg-hint' },
      'עד אז כל שאר הכלי עובד כרגיל, והבוחר של התוכניות פשוט לא מופיע ' +
      'ב«יצירה עם AI» וב«בונים פוסט».'));
}

async function newProgram() {
  const input = h('input', { class: 'field__input', type: 'text', maxlength: '200',
    placeholder: 'למשל: סדנת רילוקיישן, אביב 2026' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(m.close); });
  const go = async (close) => {
    const title = input.value.trim();
    if (!title) { input.focus(); return false; }
    try {
      const row = await createProgram({ title, fields: SEED_FIELDS() });
      if (close) close();
      location.href = pageLink('program.html', { id: row.id });
    } catch (err) {
      toast('התוכנית לא נוצרה: ' + String((err && err.message) || err), 'err');
      return false;
    }
    return true;
  };
  const m = modal('תוכנית חדשה',
    h('div', { class: 'field' },
      h('label', { class: 'field__label' }, 'איך קוראים לתוכנית?'),
      input,
      h('p', { class: 'pg-hint' },
        'השדות של הסדנה ייווצרו מוכנים, ריקים. ממלאים מה שידוע, ומשאירים ריק ' +
        'מה שעוד לא ידוע: שדה ריק פשוט לא מופיע בתוכן שנכתב ממנו.')),
    { actions: [{ label: 'ביטול' }, { label: 'יצירה', primary: true, onClick: (c) => go(c) }] });
  setTimeout(() => input.focus(), 60);
}

function removeProgram(p) {
  modal('מחיקת תוכנית', h('div', null,
    h('p', null, 'התוכנית תרד מהרשימה ומהבוחרים.'),
    h('p', { class: 'pg-hint' },
      'המחיקה רכה: השורה נשמרת, בקשות ופוסטים שכבר נכתבו ממנה לא נשברים, ' +
      'ואפשר לבטל מיד.')),
  { actions: [
    { label: 'ביטול' },
    { label: 'מחיקה', primary: true, onClick: async (close) => {
      try { await softDeleteProgram(p.id); }
      catch (e) { toast((e && e.message) || 'המחיקה נכשלה', 'err'); return false; }
      if (close) close();
      programs = programs.filter((x) => x.id !== p.id);
      renderList();
      undoToast('התוכנית נמחקה', async () => {
        try { await restoreProgram(p.id); }
        catch (e) { toast('השחזור נכשל: ' + ((e && e.message) || e), 'err'); return; }
        await refresh();
        toast('התוכנית שוחזרה', 'ok');
      });
      return true;
    } },
  ] });
}

function renderMissingProgram() {
  $('page').replaceChildren(h('article', { class: 'card pg-mig' },
    h('h2', {}, 'התוכנית לא נמצאה'),
    h('p', {}, programsMissing()
      ? 'התוכניות עוד לא הופעלו בלוח הזה (מיגרציה 030).'
      : 'ייתכן שהיא נמחקה, או שהקישור שייך ללוח אחר.'),
    h('a', { class: 'btn btn--ghost', href: pageLink('program.html') }, 'חזרה לרשימה')));
}

/* ── the editor ── */

function renderEditor() {
  const rows = h('div', { class: 'pg-rows' + (locked ? '' : ' is-reorder') });
  paintRows(rows);

  $('page').replaceChildren(
    h('div', { class: 'pg-backbar' },
      h('a', { class: 'pg-back', href: pageLink('program.html'), onclick: guardLeave }, '‹ כל התוכניות'),
      h('span', { class: 'pg-chip' }, 'גרסה ' + String(baseRev)),
      cur && cur.updated_by
        ? h('span', { class: 'pg-hint' }, 'עודכן לאחרונה על ידי ' + String(cur.updated_by) +
            ' · ' + fmtDate(cur.updated_at || cur.created_at))
        : null),

    gone ? goneBanner() : stale ? staleBanner() : null,

    h('div', { class: 'field pg-title' },
      h('label', { class: 'field__label' }, 'שם התוכנית'),
      (() => {
        const i = h('input', { class: 'field__input', type: 'text', maxlength: '200',
          value: draft.title });
        i.addEventListener('input', () => { draft.title = i.value; markDirty(); });
        i.disabled = !locked;
        return i;
      })()),

    lockBar(),
    rows,
    h('button', {
      class: 'btn btn--ghost pg-add', type: 'button', disabled: !locked,
      onclick: addField,
    }, '+ שדה'),

    saveBar(),
    photosSection());
}

/* The program was deleted while this editor is open. Deliberately NOT a
   read-only lock: the text stays editable so it can be selected and copied, and
   the way back (restore, then save) is named. The save button is left alive on
   purpose too, because pressing it now lands in the conflict path, which hands
   the whole draft back field by field with copy buttons. */
function goneBanner() {
  return h('div', { class: 'pg-stale pg-gone' },
    h('b', {}, 'התוכנית נמחקה בינתיים.'),
    h('span', {},
      ' שום דבר ממה שכתבתם לא נמחק מהמסך, אבל אי אפשר לשמור לתוכנית שנמחקה. ' +
      'אפשר לשחזר אותה מרשימת התוכניות, ואז לשמור שוב.'),
    h('a', { class: 'pg-back', href: pageLink('program.html') }, ' רשימת התוכניות'));
}

/* The pre-save warning. Its wording is load-bearing and was WRONG in the first
   cut: it promised «ונחבר את שני העריכות בלי לדרוס אף אחת», which the merge
   cannot deliver. A field only ONE side touched really is merged. A field BOTH
   sides rewrote cannot be, by anybody, without a human choosing, so the honest
   promise is the one made here: what does not collide is merged, what does
   collide is SHOWN so it can be combined by hand. */
function staleBanner() {
  return h('div', { class: 'pg-stale' },
    h('b', {}, 'מישהו ערך את התוכנית עכשיו.'),
    h('span', {},
      ' הטקסט שלכם כאן לא נגעו בו. כשתשמרו, נחבר את מה שכל צד שינה בנפרד, ' +
      'ואם שניכם כתבתם באותו שדה נראה לכם את הטקסט שלהם כדי שתחליטו מה נשאר.'));
}

/* The lock. Locked is the normal state: values are editable (labels never
   are), and a pointer drag does nothing. Unlocked turns every row into a
   handle and freezes the text, because a control that is both a text field
   and a drag target is a control that eats one of the two on every device. */
function lockBar() {
  const btn = h('button', {
    class: 'btn btn--ghost pg-lock' + (locked ? '' : ' is-on'), type: 'button',
    'aria-pressed': locked ? 'false' : 'true',
    onclick: () => { locked = !locked; renderEditor(); },
  }, (locked ? '🔒' : '🔓') + ' סידור שדות');
  return h('div', { class: 'pg-lockbar' }, btn,
    h('span', { class: 'pg-hint' }, locked
      ? 'לפתיחת מצב סידור, כדי לגרור שדות למקום אחר.'
      : 'גוררים שדה למעלה או למטה, או משתמשים בחצים. הטקסט נעול בינתיים.'));
}

function paintRows(box) {
  box.replaceChildren(...draft.fields.map((f, i) => fieldRow(f, i, box)));
  if (!draft.fields.length) {
    box.replaceChildren(h('p', { class: 'muted' },
      'אין שדות בתוכנית הזאת. אפשר להוסיף אחד עם «+ שדה».'));
  }
}

function fieldRow(f, i, box) {
  const grip = locked ? null : h('span', {
    class: 'pg-grip', title: 'גרירה לסידור מחדש', 'aria-hidden': 'true',
  }, '⠿');

  // Labels are READ-ONLY in the editor (operator directive, 2026-08-05): a
  // label is the field's name, set once when the field is created. Renaming a
  // label mid-life silently re-labels the fact for every teammate and every
  // brief that reads it, so the input that used to live here is gone.
  const labelEl = h('div', { class: 'pg-label pg-label--static' },
    h('bdi', {}, f.label || 'שדה ללא שם'));

  const valueEl = locked ? valueControl(f) : staticValue(f);

  const acts = locked
    ? h('button', {
        class: 'pg-x', type: 'button', title: 'הסרת השדה', 'aria-label': 'הסרת השדה',
        onclick: () => { draft.fields.splice(i, 1); markDirty(); paintRows(box); },
      }, '✕')
    : h('span', { class: 'pg-moves' },
        h('button', {
          class: 'pg-x', type: 'button', title: 'למעלה', 'aria-label': 'העברה למעלה',
          disabled: i === 0,
          onclick: () => moveField(i, i - 1),
        }, '▲'),
        h('button', {
          class: 'pg-x', type: 'button', title: 'למטה', 'aria-label': 'העברה למטה',
          disabled: i === draft.fields.length - 1,
          onclick: () => moveField(i, i + 1),
        }, '▼'));

  const row = h('div', { class: 'pg-row' + (locked ? '' : ' is-handle') },
    h('div', { class: 'pg-row__head' }, grip, labelEl, acts),
    valueEl,
    (locked && SEED_HINTS[f.id])
      ? h('p', { class: 'pg-hint' }, SEED_HINTS[f.id]) : null);

  if (!locked) row.addEventListener('pointerdown', (e) => beginDrag(e, i, row, box));
  return row;
}

// `when` keeps the datetime-local input BY ID (spec 14 §4). Everything else is
// multiline free text, because a program's facts are sentences far more often
// than they are values.
function valueControl(f) {
  if (f.id === 'when') {
    const i = h('input', { class: 'field__input', type: 'datetime-local', value: f.value });
    i.addEventListener('input', () => { f.value = i.value; markDirty(); });
    return i;
  }
  const t = h('textarea', { rows: '3', placeholder: SEED_HINTS[f.id] ? '' : 'התוכן של השדה' },
    f.value);
  t.addEventListener('input', () => { f.value = t.value; markDirty(); });
  return t;
}

// The frozen read of a value while reordering. A <bdi> because a program field
// can hold a URL or an English name inside an RTL block, and without isolation
// the punctuation jumps to the wrong end of the line.
function staticValue(f) {
  const v = String(f.value || '').trim();
  return h('p', { class: 'pg-value pg-value--static' },
    v ? h('bdi', {}, v) : h('span', { class: 'muted' }, 'ריק'));
}

function addField() {
  // The label is asked for HERE, once, because labels are read-only in the
  // editor (operator directive, 2026-08-05). Naming happens at birth; after
  // that the label is the field's identity.
  const input = h('input', { class: 'field__input', type: 'text',
    maxlength: '120', placeholder: 'למשל: מה להביא' });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(m.close); });
  const go = (close) => {
    const label = input.value.trim();
    if (!label) { input.focus(); return false; }
    draft.fields.push({ id: 'f-' + newFieldId(), label, value: '' });
    markDirty();
    if (close) close();
    renderEditor();
    // Focus the VALUE of the row that was just added: it has a name already,
    // and the useful next keystroke is its content.
    const rows = document.querySelectorAll('.pg-row textarea');
    const last = rows[rows.length - 1];
    if (last && last.focus) setTimeout(() => last.focus(), 0);
    return true;
  };
  const m = modal('שדה חדש',
    h('div', { class: 'field' },
      h('label', { class: 'field__label' }, 'איך קוראים לשדה?'),
      input,
      h('p', { class: 'pg-hint' },
        'השם נקבע פעם אחת וישמש את כל הצוות. את התוכן ממלאים אחר כך, בעורך.')),
    { actions: [{ label: 'ביטול' }, { label: 'הוספה', primary: true, onClick: (c) => go(c) }] });
  setTimeout(() => input.focus(), 60);
}

function newFieldId() {
  // crypto.randomUUID is present in every browser this tool supports; the
  // fallback is there because a page that throws while adding a field is worse
  // than a slightly less random id.
  try { return crypto.randomUUID().slice(0, 8); }
  catch { return Math.random().toString(16).slice(2, 10); }
}

function moveField(from, to) {
  if (to < 0 || to >= draft.fields.length) return;
  const [row] = draft.fields.splice(from, 1);
  draft.fields.splice(to, 0, row);
  markDirty();
  renderEditor();
  // Keyboard focus follows the row it moved, not the position it left — the
  // second press of ▲ must keep moving the SAME field.
  const btns = document.querySelectorAll('.pg-row .pg-moves .pg-x');
  const want = btns[to * 2 + (to < from ? 0 : 1)];
  if (want && !want.disabled) setTimeout(() => want.focus(), 0);
}

// The unsaved marker is repainted in place rather than through a re-render:
// re-rendering the editor on the first keystroke would blur the field being
// typed into, which is the classic way a "live" editor becomes unusable.
let dirtyNote = null;

function markDirty() {
  if (dirty) return;
  dirty = true;
  if (dirtyNote) dirtyNote.textContent = 'יש שינויים שלא נשמרו.';
}

/* ── drag-reorder ─────────────────────────────────────────────────────────
   PHYSICAL PIXELS ONLY, and this is the trap the whole build was warned about:
   Chromium resolves `inset-inline-start` / `offsetLeft`-flavoured logical
   offsets against the ELEMENT'S OWN direction, so on an RTL page a "logical"
   drag position is measured from the right on one element and from the left on
   another, and rows snap to the wrong slot at random. clientY and
   getBoundingClientRect() are viewport coordinates: physical, direction-blind,
   and identical under `dir=rtl` and `dir=ltr`. Nothing in here reads a logical
   offset, and nothing here should learn to.

   The reorder is vertical only, so no horizontal maths exists to get wrong.

   pointercancel is treated exactly like pointerup with the move ABANDONED (a
   cancelled gesture is not a choice), and setPointerCapture means a pointer that
   leaves the row keeps delivering to it. */
function beginDrag(e, idx, rowEl, box) {
  if (locked || e.button > 0) return;
  const rows = [...box.querySelectorAll('.pg-row')];
  if (rows.length < 2) return;
  e.preventDefault();

  const rects = rows.map((r) => r.getBoundingClientRect());
  const height = rects[idx].height;
  // The visual gap between rows, read off the real layout rather than assumed
  // from the stylesheet: the shift below has to move a row by exactly one slot.
  const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
  const step = height + gap;
  const startY = e.clientY;
  let target = idx;

  try { rowEl.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  rowEl.classList.add('is-dragging');

  const shiftOthers = () => {
    for (let i = 0; i < rows.length; i++) {
      if (i === idx) continue;
      let d = 0;
      if (target > idx && i > idx && i <= target) d = -step;
      if (target < idx && i < idx && i >= target) d = step;
      rows[i].style.transform = d ? `translateY(${d}px)` : '';
    }
  };

  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    rowEl.style.transform = `translateY(${dy}px)`;
    const y = ev.clientY;
    let t = idx;
    for (let i = 0; i < rects.length; i++) {
      const mid = rects[i].top + rects[i].height / 2;
      if (i < idx && y < mid) { t = i; break; }
      if (i > idx && y > mid) { t = i; }
    }
    if (t !== target) { target = t; shiftOthers(); }
  };

  const finish = (commit) => {
    rowEl.removeEventListener('pointermove', onMove);
    rowEl.removeEventListener('pointerup', onUp);
    rowEl.removeEventListener('pointercancel', onCancel);
    try { rowEl.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    for (const r of rows) r.style.transform = '';
    rowEl.classList.remove('is-dragging');
    if (commit && target !== idx) {
      const [moved] = draft.fields.splice(idx, 1);
      draft.fields.splice(target, 0, moved);
      markDirty();
    }
    renderEditor();
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);

  rowEl.addEventListener('pointermove', onMove);
  rowEl.addEventListener('pointerup', onUp);
  rowEl.addEventListener('pointercancel', onCancel);
}

/* ── save ── */

function saveBar() {
  const btn = h('button', {
    class: 'btn btn--primary', type: 'button', onclick: save,
  }, 'שמירה');
  dirtyNote = h('b', { class: 'pg-dirty' }, dirty ? 'יש שינויים שלא נשמרו.' : '');
  return h('div', { class: 'pg-savebar' }, btn, dirtyNote,
    h('span', { class: 'pg-hint' },
      'כל שמירה מעלה את מספר הגרסה. המפעל קורא את התוכנית מחדש בכל פעם שהוא ' +
      'מתחיל לכתוב, ורושם אם הפרטים זזו מאז שהבקשה נשלחה.'));
}

async function save() {
  if (saving) return;
  saving = true;
  try {
    // The calendar-overflow guard, applied at the door (spec 14 hard rules).
    // ECMA-262 ROLLS '2026-02-29T19:00' to March 1 instead of failing, and a
    // rolled date would ride into the brief as a real evening nobody wrote.
    const when = draft.fields.find((f) => f.id === 'when');
    if (when && String(when.value || '').trim()) {
      const canon = canonWhen(when.value);
      if (!canon) {
        when.value = '';
        toast('התאריך לא היה תקין, אז הוא נשמר ריק. אפשר לכתוב אותו ב«הערה על המועד».', 'err');
      } else {
        when.value = canon;
      }
    }
    /* P5: a save that changes NOTHING must not move the rev. `rev` is the signal
       the whole factory reads: it puts «התוכנית עודכנה» in the fulfiller's
       --watch log, «התוכנית עודכנה מאז» on the request card, and a
       "the details moved" paragraph in the brief. Firing all of that because
       somebody pressed שמירה twice is crying wolf at the one place that must
       stay believable.

       CANONICAL compare, not JSON.stringify of the raw rows: a field object's
       key order is not stable across the paths that build it (a seeded row, a
       merged row and a row that came back from jsonb do not agree), so the
       naive compare reports "changed" on identical content. canonSnapshot
       flattens to positional arrays, which is the same discipline the jsonb
       round trip forces. */
    if (canonSnapshot(draft) === canonSnapshot(loaded)) {
      dirty = false;
      if (dirtyNote) dirtyNote.textContent = '';
      toast('אין שינויים לשמירה', 'ok');
      return;
    }
    let row;
    try {
      row = await saveProgram(openId, {
        title: draft.title, fields: draft.fields, expected_rev: baseRev,
      });
    } catch (err) {
      if (err && err.conflict) { await onConflict(); return; }
      toast('לא נשמר: ' + String((err && err.message) || err), 'err');
      return;
    }
    cur = row;
    adopt(row);
    await refreshList();
    renderEditor();
    toast(`נשמר ✓ גרסה ${baseRev}`, 'ok');
  } finally {
    saving = false;
  }
}

async function refreshList() {
  try { programs = await listPrograms(); } catch { /* the editor is the page */ }
}

// The datetime-local bridge plus the round-trip check, the same pair
// create-ai.js uses. A value whose written day does not survive the round trip
// is not a date, and it drops to ''.
function canonWhen(v) {
  const s = String(v || '').trim();
  const out = s ? toLocalInput(fromLocalInput(s)) : '';
  return out && out.slice(0, 10) === s.slice(0, 10) ? out : '';
}

/* THE CONFLICT PATH. Zero rows matched: either somebody saved between our load
   and our save, or the program was deleted underneath us. Both cases end the
   same way — NOTHING is written, and every character this person typed is still
   on screen — but they need different dialogs, so they are told apart first.

   THE MERGE, AND THE THING IT CANNOT DO (the fix this file exists to record).
   A field only ONE side changed merges cleanly, and that is most of them. A
   field BOTH sides rewrote does not merge, by anybody, without a human choosing
   which sentence survives. The first cut kept MINE and told the person «לא
   דרסנו כלום», which was simply false: their colleague's paragraph had already
   been overwritten in the draft that was about to be saved.

   So collisions are now first-class. Mine still wins IN THE EDITOR (the person
   holding the keyboard is the one who decides, and a dialog that reverted their
   typing would be its own kind of theft) — but THEIR text is printed verbatim
   in the dialog, per field, with a copy button, under a heading that says what
   it is. And the reassurance «לא דרסנו כלום» is only allowed to appear when the
   collision list is empty. */
async function onConflict() {
  let fresh = null;
  try { fresh = await getProgram(openId); } catch { /* handled below */ }

  // getProgram() returns null for a soft-deleted row (live() filters it), so
  // this is also the "deleted under the editor" branch — reachable now that
  // saveProgram's guard carries `deleted_at is null` and the delete bumps rev.
  if (!fresh) { deletedDialog(); return; }

  const mine = { title: draft.title, fields: cloneFields(draft.fields) };
  const theirSnap = { title: String(fresh.title || ''), fields: cloneFields(fresh.fields) };
  const clashes = collisions(theirSnap, loaded, mine);
  const merged = mergeOnto(fresh, loaded, mine);

  const theirs = describeChanges(loaded, theirSnap);
  const kept = describeChanges(loaded, mine);

  cur = fresh;
  loaded = { title: String(fresh.title || ''), fields: cloneFields(fresh.fields) };
  draft = merged;
  baseRev = Math.round(Number(fresh.rev)) || 1;
  dirty = true;
  stale = false;
  renderEditor();

  const who = fresh.updated_by ? `, נשמרה על ידי ${String(fresh.updated_by)}` : '';
  modal('מישהו ערך בינתיים', h('div', null,
    h('p', null, `הגרסה בשרת היא כבר ${baseRev}${who}.` +
      (clashes.length
        ? ' בחלק מהשדות שניכם כתבתם, ושם אי אפשר לחבר אוטומטית.'
        : ' לא דרסנו כלום.')),
    clashes.length ? collisionBlock(clashes) : null,
    changeList('מה שהם שינו', theirs),
    changeList('מה שנשמר מהעריכה שלכם', kept),
    h('p', { class: 'pg-hint' }, clashes.length
      ? 'בשדות שלמעלה מוצג הטקסט שלהם, והוא לא נכנס לעורך. העורך מחזיק את ' +
        'הטקסט שלכם. מעתיקים משם מה שצריך, מחברים ביד, ואז «שמירה» שוב.'
      : 'העורך מציג עכשיו את השילוב של השניים, עוד לפני שמירה. עוברים עליו, ' +
        'מתקנים אם צריך, ולוחצים «שמירה» שוב.')));
}

/* The program is gone. There is nothing to merge into, so the ONLY remaining
   value of the text on screen is that a human can copy it out, and this dialog
   hands it to them rather than describing it. */
function deletedDialog() {
  const rows = [
    ...(String(draft.title || '').trim()
      ? [{ label: 'שם התוכנית', text: draft.title }] : []),
    ...draft.fields
      .filter((f) => String(f.value || '').trim())
      .map((f) => ({ label: f.label || 'שדה ללא שם', text: f.value })),
  ];
  modal('התוכנית כבר לא קיימת', h('div', null,
    h('p', null, 'מישהו מחק את התוכנית בזמן שערכתם אותה, אז אין לאן לשמור.'),
    h('p', { class: 'pg-hint' },
      'שום דבר ממה שכתבתם לא נמחק מהמסך. הנה הטקסט להעתקה, ואפשר לשחזר את ' +
      'התוכנית מרשימת התוכניות ואז להדביק בחזרה.'),
    rows.length
      ? h('div', { class: 'pg-conflict' }, rows.map(copyRow))
      : h('p', { class: 'pg-hint' }, 'לא היה טקסט בעורך.')));
}

/* PURE. The fields (and the title) that BOTH sides rewrote, where the two
   results differ. `theirs` is what is at risk of being lost, so it is exactly
   what the dialog prints.

   Two sub-cases beyond the obvious one:
   · they DELETED a field this editor edited. Their removal cannot survive
     alongside my edit, so it is a collision too, with no text to copy.
   · I deleted a field they edited. mergeOnto already KEEPS theirs in that case
     (nothing of theirs is lost), so it is deliberately NOT listed here.
   Two sides that happened to type the identical string are not a collision:
   nothing is at risk, and flagging it would suppress «לא דרסנו כלום» for a
   conflict that cost nobody anything. */
function collisions(base, was, mine) {
  const out = [];
  if (was.title !== mine.title && was.title !== base.title && base.title !== mine.title) {
    out.push({ label: 'שם התוכנית', text: base.title, removed: false });
  }
  const baseById = new Map(base.fields.map((f) => [f.id, f]));
  const wasById = new Map(was.fields.map((f) => [f.id, f]));
  for (const m of mine.fields) {
    const w = wasById.get(m.id);
    if (!w) continue;                                   // added here, no base side
    const changedHere = w.label !== m.label || w.value !== m.value;
    if (!changedHere) continue;
    const b = baseById.get(m.id);
    if (!b) { out.push({ label: w.label || 'שדה ללא שם', text: '', removed: true }); continue; }
    const changedThere = w.label !== b.label || w.value !== b.value;
    if (!changedThere) continue;
    if (b.label === m.label && b.value === m.value) continue;   // same result
    out.push({ label: b.label || w.label || 'שדה ללא שם', text: b.value, removed: false });
  }
  return out;
}

function collisionBlock(list) {
  return h('div', { class: 'pg-conflict pg-clash' },
    h('b', {}, 'התנגשות באותו שדה: הטקסט שלהם'),
    h('p', { class: 'pg-hint' },
      'בשדות האלה גם הם וגם אתם כתבתם. הטקסט שלהם לא נכנס לעורך, והוא כאן ' +
      'כדי שלא ייעלם.'),
    list.map((c) => (c.removed
      ? h('div', { class: 'pg-clashrow' },
          h('b', { class: 'pg-clashrow__l' }, h('bdi', {}, c.label)),
          h('p', { class: 'pg-hint' }, 'הם הסירו את השדה הזה, ואתם ערכתם אותו. השדה נשאר אצלכם.'))
      : copyRow(c))));
}

/* One label + the verbatim text + a copy button. Every string here reaches the
   DOM through el()'s child path (createTextNode) and NEVER innerHTML: this
   dialog now prints ANOTHER person's untrusted bytes, which is exactly the sink
   an XSS battery goes looking for. */
function copyRow(c) {
  const btn = h('button', {
    class: 'btn btn--ghost pg-copy', type: 'button',
    onclick: () => copyText(String(c.text || ''), btn),
  }, 'העתקה');
  return h('div', { class: 'pg-clashrow' },
    h('div', { class: 'pg-clashrow__head' },
      h('b', { class: 'pg-clashrow__l' }, h('bdi', {}, String(c.label || ''))), btn),
    h('p', { class: 'pg-clashrow__v' }, h('bdi', {}, String(c.text || ''))));
}

/* Clipboard with the fallback that works on an insecure origin and when the
   document is not focused. The button says which happened, because a copy
   button that looks identical either way is how the PREVIOUS thing on the
   clipboard gets pasted into a client's program. */
async function copyText(text, btn) {
  const say = (ok) => {
    if (btn) {
      btn.textContent = ok ? 'הועתק ✓' : 'לא הועתק';
      setTimeout(() => { btn.textContent = 'העתקה'; }, 1600);
    }
    if (!ok) toast('ההעתקה לא עבדה. אפשר לסמן ולהעתיק ביד.', 'err');
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      say(true);
      return true;
    }
  } catch { /* fall through to the textarea path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    say(!!ok);
    return !!ok;
  } catch {
    say(false);
    return false;
  }
}

function changeList(head, items) {
  return h('div', { class: 'pg-conflict' },
    h('b', {}, head),
    items.length
      ? h('ul', {}, items.map((t) => h('li', {}, h('bdi', {}, t))))
      : h('p', { class: 'pg-hint' }, 'שום דבר.'));
}

/* PURE. The three-way merge, by field id.
   base  = the other person's fresh row (the winner by default)
   was   = what THIS editor loaded
   mine  = what THIS editor holds now
   A field is re-applied only where mine differs from was. Order: if this editor
   reordered, its order wins for the ids it knows and any base-only ids are
   appended; otherwise the base order stands. */
function mergeOnto(base, was, mine) {
  const baseFields = cloneFields(base.fields);
  const wasById = new Map(was.fields.map((f) => [f.id, f]));
  const mineById = new Map(mine.fields.map((f) => [f.id, f]));
  const out = new Map();

  for (const f of baseFields) out.set(f.id, { ...f });

  // changed or added here
  for (const f of mine.fields) {
    const w = wasById.get(f.id);
    if (!w) { out.set(f.id, { ...f }); continue; }              // added here
    if (w.label !== f.label || w.value !== f.value) out.set(f.id, { ...f });
  }
  // removed here, but only while the other side left it untouched: a field they
  // just edited is a field they still want.
  for (const w of was.fields) {
    if (mineById.has(w.id)) continue;
    const b = out.get(w.id);
    if (b && b.label === w.label && b.value === w.value) out.delete(w.id);
  }

  const reordered = mine.fields.map((f) => f.id).join('') !==
                    was.fields.map((f) => f.id).join('');
  const order = [];
  const seen = new Set();
  const push = (id) => { if (out.has(id) && !seen.has(id)) { seen.add(id); order.push(out.get(id)); } };
  if (reordered) {
    for (const f of mine.fields) push(f.id);
    for (const f of baseFields) push(f.id);
  } else {
    for (const f of baseFields) push(f.id);
    for (const f of mine.fields) push(f.id);
  }

  const title = mine.title !== was.title ? mine.title : String(base.title || '');
  return { title, fields: order };
}

// PURE. A human-readable diff of two snapshots, by LABEL (the id is ours, the
// label is theirs). Used only to explain a conflict.
function describeChanges(was, now) {
  const out = [];
  if (was.title !== now.title) out.push(`שם התוכנית: «${now.title}»`);
  const wasById = new Map(was.fields.map((f) => [f.id, f]));
  const nowById = new Map(now.fields.map((f) => [f.id, f]));
  for (const f of now.fields) {
    const w = wasById.get(f.id);
    const name = f.label || 'שדה ללא שם';
    if (!w) { out.push(`שדה חדש: ${name}`); continue; }
    if (w.label !== f.label) out.push(`שם שדה: «${w.label || 'ללא שם'}» הפך ל«${f.label}»`);
    if (w.value !== f.value) out.push(`תוכן: ${name}`);
  }
  for (const w of was.fields) {
    if (!nowById.has(w.id)) out.push(`שדה שהוסר: ${w.label || 'שדה ללא שם'}`);
  }
  const wasOrder = was.fields.map((f) => f.id).join('');
  const nowOrder = now.fields.filter((f) => wasById.has(f.id)).map((f) => f.id).join('');
  const kept = was.fields.filter((f) => nowById.has(f.id)).map((f) => f.id).join('');
  if (wasOrder && nowOrder && kept === wasOrder && nowOrder !== wasOrder) out.push('סדר השדות');
  return out;
}

function guardLeave(e) {
  if (!dirty) return;
  if (!window.confirm('יש עריכה שלא נשמרה. לעזוב בכל זאת?')) e.preventDefault();
}

/* ── photos ───────────────────────────────────────────────────────────────
   A program's photos ride sm_assets with a `program:<id>` TAG — the exact
   pattern v2.10's `folder:` tags use, so there is no photo schema here at all,
   uploads go through the one normalising store path (imgprep included), and the
   pictures show up in «נכסים» like everything else. A photo can carry a folder
   tag AND a program tag: the prefixes are different and each consumer filters
   for its own. */
function photosSection() {
  const grid = h('div', { class: 'pg-photos' });
  const prog = uploadProgress();
  const file = h('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });

  const paint = () => {
    if (!assets.length) {
      grid.replaceChildren(h('p', { class: 'muted' },
        'עוד לא הועלו תמונות לתוכנית הזאת.'));
      return;
    }
    grid.replaceChildren(...assets.map(photoCard));
  };
  paint();

  const send = async (files) => {
    const list = [...files];
    if (!list.length) return;
    prog.start(list.length);
    let done = 0;
    const failed = [];
    for (const f of list) {
      try {
        await uploadAsset({
          file: f, kind: 'photo', label: '',
          tags: [programTag(openId)], post_id: null,
        });
      } catch (err) {
        failed.push(`${f.name || 'קובץ'}: ${String((err && err.message) || err)}`);
      }
      prog.tick(++done, f.name || '');
    }
    prog.hide();
    await loadAssets();
    paint();
    if (failed.length) toast(`${failed.length} קבצים לא עלו. ${failed[0]}`, 'err');
    else toast(`${list.length} תמונות נוספו לתוכנית ✓`, 'ok');
  };

  const dock = h('div', { class: 'pg-drop' },
    h('div', { style: { fontSize: '1.4rem' } }, '🖼️'),
    h('div', null, h('b', null, 'גוררים לכאן תמונות'), ', או לוחצים לבחירה'),
    h('div', { class: 'pg-hint' },
      'התמונות נשמרות בספרייה הרגילה ומתויגות לתוכנית הזאת, כדי שאפשר יהיה ' +
      'למצוא אותן גם ב«נכסים».'),
    prog.root);
  dock.addEventListener('click', () => file.click());
  dock.addEventListener('dragover', (e) => { e.preventDefault(); dock.classList.add('over'); });
  dock.addEventListener('dragleave', () => dock.classList.remove('over'));
  dock.addEventListener('drop', (e) => {
    e.preventDefault();
    dock.classList.remove('over');
    send(e.dataTransfer.files || []);
  });
  file.addEventListener('change', async () => {
    // A byte snapshot is NOT taken here the way assets.js does it, because this
    // dock takes a handful of pictures rather than a phone folder: uploadAsset
    // reads each File once, immediately, in order.
    const picked = [...file.files];
    await send(picked);
    file.value = '';
  });

  return h('section', { class: 'pg-photosec' },
    h('h2', { class: 'pg-h2' }, 'תמונות של התוכנית'),
    dock, file, grid);
}

function photoCard(a) {
  const url = assetRowUrl(a);
  return h('figure', { class: 'pg-photo' },
    h('img', { src: url, alt: String(a.label || a.name || 'תמונה של התוכנית'), loading: 'lazy' }),
    h('figcaption', {},
      h('bdi', {}, String(a.label || a.name || '')),
      h('button', {
        class: 'pg-x', type: 'button', title: 'מחיקה', 'aria-label': 'מחיקת התמונה',
        onclick: () => removePhoto(a),
      }, '✕')));
}

async function removePhoto(a) {
  try { await deleteAssets([a.id]); }
  catch (e) { toast((e && e.message) || 'המחיקה נכשלה', 'err'); return; }
  assets = assets.filter((x) => x.id !== a.id);
  renderEditor();
  undoToast('התמונה נמחקה', async () => {
    try { await restoreAssets([a.id]); }
    catch (e) { toast('השחזור נכשל: ' + ((e && e.message) || e), 'err'); return; }
    await loadAssets();
    renderEditor();
    toast('התמונה שוחזרה', 'ok');
  });
}
