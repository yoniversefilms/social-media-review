// queue.js — «תור הפרסום» page logic. (owner: pipeline)
// Talks to the backend ONLY through store.js; shared widgets from ui.js.
// Publishing itself never happens from the browser — this page only manages
// sm_publish rows; scripts/publish-meta.mjs (operator machine) consumes them.

import {
  initStore, ensureName, slideUrl,
  listPosts, listVotes, latestVotes, listQueue,
  queuePublish, rescheduleQueue, setQueueStatus, callPublisher, subscribe,
  listAllApprovals, listAllVersions, approvalState,
} from './store.js';
import {
  el, modal, toast, fmtDate, fmtWhen, toLocalInput, fromLocalInput,
  voteGlyph, navBar,
} from './ui.js';

const CAT = {
  par: 'הורות', cpl: 'זוגיות', rel: 'רילוקיישן', fam: 'משפחה',
  ind: 'טיפול פרטני', orig: 'ליבה', builder: 'נבנה בכלי', general: 'כללי',
};
const STAGE = {
  in_review: 'בבדיקה', editing: 'בעריכה', approved: 'מאושר',
  complete: 'הושלם', parked: 'בהמתנה',
};
const QSTATUS = {
  queued: 'בתור', publishing: 'מפרסם…', published: 'פורסם',
  failed: 'נכשל', canceled: 'בוטל',
};
const QSTATUS_ORDER = ['queued', 'publishing', 'published', 'failed', 'canceled'];
const CHANNELS = { instagram: 'אינסטגרם', facebook: 'פייסבוק', both: 'אינסטגרם + פייסבוק' };

let busy = false;
let board = null;                       // {board_key, local} from initStore

/* ---------------- view state (v2.2 schedule board) ----------------
   'list' is the original status-grouped queue. 'grid' is the board: cover
   slides in publish order, drag to swap time slots. The choice is per-browser
   (a preference, not shared state) — the ORDER it edits is shared. */
const VIEW_LS = 'smr:qview';
let view = localStorage.getItem(VIEW_LS) === 'grid' ? 'grid' : 'list';
let arranging = false;                  // grid unlocked for dragging
let dragging = false;                   // a pointer drag is in flight
let gridRows = [];                      // rows the grid last drew, in publish order

/* ---------------- operator key (v2.1 cloud publishing) ----------------
   Publishing is gated on a secret the BOARD KEY does not grant. The reviewer
   link is a capability URL that goes to the JFCS therapists; holding it must
   never be enough to post to the client's live Instagram. This key is typed
   once by the operator, kept in their own browser, and checked inside the
   Edge Function — the browser never holds the Meta token itself. */
const OPKEY_LS = 'smr:opkey';
const opKey = () => localStorage.getItem(OPKEY_LS) || '';

function askOperatorKey() {
  return new Promise((resolve) => {
    const input = el('input', {
      class: 'field__input', type: 'password', autocomplete: 'off',
      placeholder: 'מפתח מפעיל', value: opKey(),
    });
    const save = el('button', { class: 'btn btn--primary' }, ['שמירה']);
    const clear = el('button', { class: 'btn btn--ghost' }, ['מחיקת המפתח']);
    const body = el('div', { class: 'qform' }, [
      el('label', { class: 'field' }, [
        el('div', { class: 'field__label' }, ['מפתח מפעיל (PUBLISH_OPERATOR_KEY)']), input]),
      el('p', { class: 'block__hint' }, [
        'המפתח נשמר רק בדפדפן הזה ומאפשר להריץ פרסום. בלעדיו אפשר לנהל את התור אבל לא לפרסם.']),
      el('div', { class: 'toolbar' }, [save, clear]),
    ]);
    const m = modal('מפתח מפעיל', body);
    save.addEventListener('click', () => {
      const v = input.value.trim();
      if (v) localStorage.setItem(OPKEY_LS, v); else localStorage.removeItem(OPKEY_LS);
      closeModal(m); resolve(v);
    });
    clear.addEventListener('click', () => {
      localStorage.removeItem(OPKEY_LS);
      closeModal(m); resolve('');
    });
    setTimeout(() => input.focus(), 60);
  });
}

/* ---------------- helpers ---------------- */

/* URL helper — always preserve board + local, same rule as index.js. */
function pageLink(page, extra = {}) {
  const q = new URLSearchParams();
  if (board) {
    q.set('board', board.board_key);
    if (board.local) q.set('local', '1');
  }
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${page}?${q.toString()}`;
}

/* v2.1: every row on this page is a way BACK into the review screen. A queued
   post is exactly the post someone still wants to read, fix a typo in, or
   re-check — so the thumbnail and the title are links to post.html, which is
   the full editor, and each row carries an explicit «פתיחה לעריכה» button for
   anyone who doesn't think to click a title. Rows for a post that no longer
   exists on the board (deleted / never ingested) degrade to plain text. */
function postHref(post) {
  return post ? pageLink('post.html', { id: post.id }) : null;
}

function thumbEl(post) {
  const inner = (post && post.asset_prefix)
    ? el('img', { class: 'thumb', src: slideUrl(post, 0), alt: '', loading: 'lazy' })
    : el('div', { class: 'thumb thumb--empty' }, ['—']);
  const href = postHref(post);
  if (!href) return inner;
  return el('a', { class: 'thumb-link', href, title: 'פתיחת הפוסט לבדיקה ולעריכה' }, [inner]);
}

function titleEl(post, fallbackId, cls) {
  const label = post ? (post.title || post.id) : fallbackId;
  const href = postHref(post);
  if (!href) return el('div', { class: cls }, [label]);
  return el('div', { class: cls }, [
    el('a', { class: 'row-open', href, title: 'פתיחת הפוסט לבדיקה ולעריכה' }, [label]),
  ]);
}

function openBtn(post, label = 'פתיחה לעריכה') {
  const href = postHref(post);
  if (!href) return null;
  return el('a', { class: 'btn btn--ghost', href }, [label]);
}

function tallyOf(perAuthor) {
  const t = { yes: 0, no: 0, maybe: 0 };
  if (perAuthor) for (const v of perAuthor.values()) if (t[v.vote] != null) t[v.vote]++;
  return t;
}

function tallyEl(t) {
  return el('span', { class: 'tally', title: 'הצבעות' }, [
    el('span', { class: 'tally__i tally__i--yes' }, [voteGlyph('yes') + ' ' + t.yes]),
    el('span', { class: 'tally__i tally__i--maybe' }, [voteGlyph('maybe') + ' ' + t.maybe]),
    el('span', { class: 'tally__i tally__i--no' }, [voteGlyph('no') + ' ' + t.no]),
  ]);
}

function chanIcons(channel) {
  const wrap = el('span', { class: 'chans' }, []);
  if (channel === 'instagram' || channel === 'both')
    wrap.append(el('span', { class: 'chan chan--ig', title: 'Instagram' }, ['IG']));
  if (channel === 'facebook' || channel === 'both')
    wrap.append(el('span', { class: 'chan chan--fb', title: 'Facebook' }, ['FB']));
  return wrap;
}

/* ================= v2.3 · marketing sign-off on the queue ==============
   This page WARNS about the signature; it never gates on it. The admission
   predicate in render() is untouched (stage approved/complete), and the only
   new obstacle anywhere is a checkbox the operator can always tick. See
   PLAN.md I1 (never infer an approval from `stage`) and the queue-gate
   invariant: no approval state ever makes queuePublish unreachable.

   Nothing here is stored. approvalState() is pure, so every surface — chip,
   modal warning, queued-row tag — recomputes from the same three inputs on
   every render. A post edited after it was queued therefore grows its ⚠️ tag
   on the next poll with no bookkeeping of any kind. */

/* The §9 chip strings, verbatim. `status` decides the words AND the colour;
   the ⚠️ glyph is added separately by the element builders so the label text
   stays exactly the string in the plan. */
function chipLabel(st) {
  if (!st) return '';
  const cur = st.vnum;
  const signed = st.latest ? Number(st.latest.vnum) : null;
  switch (st.status) {
    case 'fresh': {
      const who = (st.latest && String(st.latest.author || '').trim()) || 'לא ידוע';
      return `חתימת שיווק ✓ ${who} · v${Number.isFinite(signed) ? signed : '?'}`;
    }
    case 'stale':
      return `נחתם על v${signed} — נערך מאז (v${cur})`;
    case 'revoked':
      return 'החתימה בוטלה';
    default:
      return 'ללא חתימת שיווק';
  }
}

/* The chip itself. inline-flex + nowrap on the wrapper keeps the ⚠️ / ✓ glyph
   welded to its label — at 390px RTL a bare glyph that wraps onto its own line
   reads as a different element entirely. */
function approvalChip(st) {
  if (!st) return null;
  const status = st.status || 'none';
  const label = chipLabel(st);
  return el('span', { class: 'achip achip--' + status, title: label }, [
    status === 'fresh' ? null : el('span', { class: 'achip__g', 'aria-hidden': 'true' }, ['⚠️']),
    el('span', { class: 'achip__t' }, [label]),
  ].filter(Boolean));
}

/* The small tag a QUEUED/PUBLISHING row carries when its post is no longer
   freshly signed — a post can be edited (or its signature revoked) after it
   was queued, and the row must say so. Recomputed per render, never stored. */
function warnTag(st) {
  if (!st || st.status === 'fresh') return null;
  const label = chipLabel(st);
  return el('span', { class: 'tag tag--warn tag--warn-' + st.status, title: label }, [
    el('span', { 'aria-hidden': 'true' }, ['⚠️']), ' ', label,
  ]);
}

/* Same signal on the board's cover art, where there is no meta row to hang a
   tag on. Glyph only + the full copy as the tooltip. */
function warnBadge(st) {
  if (!st || st.status === 'fresh') return null;
  const label = chipLabel(st);
  return el('span', {
    class: 'scard__warn scard__warn--' + st.status, title: label, 'aria-label': label,
  }, ['⚠️']);
}

// modal() return shape isn't specified by the contract — close defensively.
function closeModal(m) {
  try {
    if (m && typeof m.close === 'function') { m.close(); return; }
    if (m instanceof HTMLElement) { m.remove(); return; }
  } catch { /* fall through */ }
  document.querySelectorAll('.modal').forEach((n) => n.remove());
}

function resultSummary(r) {
  if (!r || typeof r !== 'object' || !Object.keys(r).length) return null;
  const bits = [];
  if (r.instagram && r.instagram.media_id) bits.push('IG media: ' + r.instagram.media_id);
  if (r.facebook && r.facebook.post_id) bits.push('FB post: ' + r.facebook.post_id);
  const errs = Array.isArray(r.errors) ? r.errors : (r.error ? [r.error] : []);
  for (const e of errs) bits.push(typeof e === 'string' ? e : JSON.stringify(e));
  if (!bits.length) bits.push(JSON.stringify(r));
  let s = bits.join(' · ');
  if (s.length > 240) s = s.slice(0, 240) + '…';
  return el('div', { class: 'qrow__result' }, [s]);
}

/* ---------------- add-to-queue modal ---------------- */

function openAddModal(post, st) {
  const sel = el('select', { class: 'field__input' },
    Object.entries(CHANNELS).map(([v, label]) => el('option', { value: v }, [label])));
  const note = el('textarea', { class: 'field__input', rows: '2', placeholder: 'למשל: לפרסם בבוקר, לתייג את העמוד של JFCS' });
  const when = el('input', { class: 'field__input', type: 'datetime-local' });
  const submit = el('button', { class: 'btn btn--primary' }, ['הוסף לתור']);

  /* ---- v2.3 the acknowledgement gate ----------------------------------
     WARN HARD, NEVER BLOCK. When the signature is missing, stale or revoked
     the operator has to SAY so — one checkbox — and then queueing proceeds
     byte-for-byte as it did before v2.3. There is no state, no role and no
     stage that removes this path; the checkbox is the whole obstacle and it
     is always tickable. */
  const needsAck = !!st && st.status !== 'fresh';
  let ack = null;
  const warnPanel = [];

  if (needsAck) {
    // §9 has one warn line per reason. `revoked` shares the «no signature»
    // line — a revoked signature IS no valid signature — and the chip beside
    // it says which of the two it was, so nothing is hidden.
    const headline = st.status === 'stale'
      ? `⚠️ החתימה ניתנה על v${st.latest ? Number(st.latest.vnum) : '?'} אבל הפוסט נערך מאז`
      : '⚠️ הפוסט ייכנס לתור בלי חתימת שיווק';

    ack = el('input', { type: 'checkbox' });
    // Belt and braces: a fresh node is unchecked, but browsers restore form
    // state on some navigation paths and this consent MUST be re-given on
    // every single open. Never remembered, never pre-ticked.
    ack.checked = false;

    const panel = el('div', { class: 'qwarn qwarn--' + st.status }, [
      el('p', { class: 'qwarn__t' }, [headline]),
      el('div', { class: 'qwarn__chip' }, [approvalChip(st)]),
      el('label', { class: 'qwarn__ck' }, [
        ack,
        el('span', {}, ['אני מאשר/ת להכניס לתור בלי חתימת שיווק תקפה']),
      ]),
    ]);
    ack.addEventListener('change', syncSubmit);
    warnPanel.push(panel);
  }

  function syncSubmit() {
    submit.disabled = busy || (needsAck && !ack.checked);
  }

  const body = el('div', { class: 'qform' }, [
    ...warnPanel,
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['ערוץ פרסום']), sel]),
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['הערה למפרסם (לא חובה)']), note]),
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['תזמון (לא חובה — ריק = בהרצה הקרובה)']), when]),
    el('div', { class: 'toolbar' }, [submit]),
  ]);
  syncSubmit();
  const m = modal('הוספה לתור — ' + (post.title || post.id), body);

  submit.addEventListener('click', async () => {
    if (busy) return;
    // The gate is a UI affordance, not a lock: once ticked this handler is
    // identical to the pre-v2.3 one. Nothing about the payload changes.
    if (needsAck && !ack.checked) return;
    busy = true; submit.disabled = true;
    try {
      const payload = { post_id: post.id, channel: sel.value, note: note.value.trim() };
      const iso = fromLocalInput(when.value);   // the field is LOCAL wall-clock
      if (iso) payload.scheduled_for = iso;
      await queuePublish(payload);
      closeModal(m);
      toast('נוסף לתור הפרסום');
      await refresh();
    } catch (err) {
      toast('שגיאה: ' + err.message);
    } finally {
      // Restore to the GATE's answer, not to «enabled» — a failed submit must
      // not quietly un-tick the acknowledgement it already has, nor grant one
      // it never got.
      busy = false; syncSubmit();
    }
  });
}

/* ---------------- rendering ---------------- */

function candidateRow(post, tallies, st) {
  const cat = CAT[post.category] || post.category;
  return el('div', { class: 'prow' }, [
    thumbEl(post),
    el('div', { class: 'prow__main' }, [
      titleEl(post, post.id, 'prow__title'),
      el('div', { class: 'prow__meta' }, [
        el('span', { class: 'tag' }, [cat]),
        // I4: the stage tag and the signature chip sit side by side on purpose.
        // «מאושר» is the LANE a human put the post in; the chip is the only
        // statement about a signature, so a stage-approved post with no
        // signature reads «מאושר» + «ללא חתימת שיווק» and claims nothing.
        el('span', { class: 'tag' }, [STAGE[post.stage] || post.stage]),
        approvalChip(st),
        tallyEl(tallyOf(tallies.get(post.id))),
      ]),
    ]),
    openBtn(post),
    el('button', { class: 'btn btn--primary', 'data-add': '1' }, ['הוסף לתור']),
  ]);
}

function queueRow(q, postsById, states) {
  const post = postsById.get(q.post_id);
  const meta = [chanIcons(q.channel)];
  // A post can be edited — or its signature revoked — AFTER it was queued.
  // Only the live queue statuses are worth flagging: «פורסם» / «בוטל» /
  // «נכשל» are history, and a warning on history is noise.
  if (GRID_STATUSES.has(q.status)) {
    const w = warnTag(post ? states.get(post.id) : null);
    if (w) meta.push(w);
  }
  if (q.requested_by) meta.push(el('span', {}, ['ביקש/ה: ' + q.requested_by]));
  // scheduled_for points at the FUTURE — fmtDate() is past-tense only and
  // would render it as «ממש עכשיו». fmtWhen() is the scheduling formatter.
  if (q.scheduled_for) meta.push(el('span', { class: 'tag' }, ['מתוזמן: ' + fmtWhen(q.scheduled_for)]));
  meta.push(el('span', {}, ['נוסף: ' + fmtDate(q.created_at)]));

  const main = [
    titleEl(post, q.post_id, 'qrow__title'),
    el('div', { class: 'qrow__meta' }, meta),
  ];
  if (q.note) main.push(el('div', { class: 'qrow__note' }, ['הערה: ' + q.note]));
  const res = resultSummary(q.result);
  if (res) main.push(res);

  const actions = [openBtn(post, 'בדיקה ועריכה')];
  if (q.status === 'queued') {
    // cloud publishing only — in local mode there is no Edge Function to call
    if (!board || !board.local) {
      const go = el('button', { class: 'btn btn--primary' }, ['פרסם עכשיו']);
      go.addEventListener('click', () => runPublisher('now', q));
      actions.push(go);
    }
    const t = el('button', { class: 'btn btn--ghost' }, ['שינוי תזמון']);
    t.addEventListener('click', () => openRescheduleModal(q, post));
    actions.push(t);
    const b = el('button', { class: 'btn btn--ghost' }, ['ביטול']);
    b.addEventListener('click', () => changeStatus(q.id, 'canceled'));
    actions.push(b);
  } else if (q.status === 'publishing') {
    actions.push(el('span', { class: 'block__hint' }, ['רץ כרגע…']));
  } else if (q.status === 'canceled') {
    const b = el('button', { class: 'btn btn--ghost' }, ['החזרה לתור']);
    b.addEventListener('click', () => changeStatus(q.id, 'queued'));
    actions.push(b);
  }

  return el('div', { class: 'qrow' }, [
    thumbEl(post),
    el('div', { class: 'qrow__main' }, main),
    ...actions.filter(Boolean),
  ]);
}

/* ================= v2.2 · the schedule board =========================
   A grid of cover slides in the order the publisher will actually send them,
   draggable. Dragging does NOT renumber anything — sm_publish has no `sort`
   column and inventing one would put the board's order and the publisher's
   order out of sync the first time someone edited a date. Instead the board
   holds a fixed set of TIME SLOTS (the scheduled_for values already on the
   queued rows) and a drag reassigns which post sits in which slot. Two rows
   move, two rows are written, and the grid order IS the publish order by
   construction — there is no second source of truth to drift.            */

const GRID_STATUSES = new Set(['queued', 'publishing']);

const stamp = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? 0 : d.getTime(); };

/* Publish order exactly as the Edge Function computes it: selectRows() takes
   `scheduled_for IS NULL OR scheduled_for <= now()` ordered by created_at, so
   an EMPTY schedule means «on the next tick» — the soonest slot, not the last
   one. Sorting nulls to the end would draw a board that lies about what goes
   out first. */
function publishOrder(a, b) {
  const an = !a.scheduled_for, bn = !b.scheduled_for;
  if (an !== bn) return an ? -1 : 1;
  if (an && bn) return stamp(a.created_at) - stamp(b.created_at);
  return stamp(a.scheduled_for) - stamp(b.scheduled_for);
}

function whenLabel(q) {
  if (!q.scheduled_for) {
    return el('span', { class: 'scard__when scard__when--next' }, ['⚡ בהרצה הקרובה']);
  }
  return el('span', { class: 'scard__when' }, [fmtWhen(q.scheduled_for)]);
}

function scheduleCard(q, post, slot, movable, st) {
  const cover = el('div', { class: 'scard__cover' }, [
    (post && post.asset_prefix)
      ? el('img', { src: slideUrl(post, 0), alt: '', loading: 'lazy' })
      : el('div', { class: 'scard__ph' }, ['🖼']),
    el('span', { class: 'scard__slot', title: 'מקום בתור' }, [String(slot)]),
    el('span', { class: 'scard__chans' }, [chanIcons(q.channel)]),
    // v2.3 — the board draws the same queued/publishing rows the list does, so
    // it carries the same signature warning. Bottom corner: the top two are
    // already taken by the slot number and the channel chips.
    warnBadge(st),
  ]);

  const href = postHref(post);
  const label = post ? (post.title || post.id) : q.post_id;
  const title = href
    ? el('a', { class: 'scard__title', href, title: 'פתיחת הפוסט לבדיקה ולעריכה' }, [label])
    : el('div', { class: 'scard__title' }, [label]);

  const foot = [];
  if (q.status === 'publishing') {
    foot.push(el('span', { class: 'dot dot--publishing' }, []), 'מפרסם כרגע — נעול');
  } else if (q.note) {
    foot.push(el('span', { title: q.note }, ['📝 ' + q.note]));
  }

  const acts = [];
  if (q.status === 'queued') {
    const t = el('button', { class: 'btn btn--ghost' }, ['תזמון']);
    t.addEventListener('click', () => openRescheduleModal(q, post));
    acts.push(t);
    const b = el('button', { class: 'btn btn--ghost' }, ['ביטול']);
    b.addEventListener('click', () => changeStatus(q.id, 'canceled'));
    acts.push(b);
  }

  return el('div', {
    class: 'scard',
    dataset: { rowId: q.id, movable: movable ? '1' : '0' },
  }, [
    cover,
    whenLabel(q),
    title,
    foot.length ? el('div', { class: 'scard__foot' }, foot) : null,
    acts.length ? el('div', { class: 'scard__acts' }, acts) : null,
  ]);
}

/* ---------------- drag to swap slots ---------------- */

function onGridPointerDown(e) {
  if (!arranging || dragging) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const card = e.target.closest('.scard');
  const grid = document.getElementById('sgrid');
  if (!card || !grid || card.dataset.movable !== '1') return;
  e.preventDefault();
  const pid = e.pointerId;
  const startX = e.clientX, startY = e.clientY;
  let live = false;

  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    if (!live) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      live = true; dragging = true;
      card.classList.add('is-dragging');
      try { card.setPointerCapture(pid); } catch { /* older browsers */ }
    }
    // Only movable cards are valid drop neighbours — a claimed («מפרסם…») row
    // keeps both its slot and its place.
    const over = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((n) => n !== card && n.parentElement === grid
                && n.classList && n.classList.contains('scard') && n.dataset.movable === '1');
    if (!over) return;
    const r = over.getBoundingClientRect();
    // RTL grid: within a row "earlier" is to the RIGHT; across rows, above.
    const sameRow = ev.clientY >= r.top && ev.clientY <= r.bottom;
    const before = sameRow ? ev.clientX > r.left + r.width / 2 : ev.clientY < r.top;
    const target = before ? over : over.nextSibling;
    if (target !== card && card.nextSibling !== target) grid.insertBefore(card, target);
  };

  const up = (ev) => {
    if (ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!live) return;
    card.classList.remove('is-dragging');
    dragging = false;
    commitSchedule();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

/* Reassign the slot pool to the dropped order and write ONLY the rows whose
   time actually changed. The pool is the movable rows' scheduled_for values
   in their PRE-drag publish order; the k-th movable card in the new DOM order
   takes the k-th slot. Because the pool is already sorted, the new DOM order
   is the new publish order — no re-sort needed to make the screen honest. */
async function commitSchedule() {
  const grid = document.getElementById('sgrid');
  if (!grid) return;
  const ids = [...grid.querySelectorAll('.scard[data-movable="1"]')].map((n) => n.dataset.rowId);
  const byId = new Map(gridRows.map((q) => [String(q.id), q]));
  const dropped = ids.map((id) => byId.get(String(id))).filter(Boolean);
  const slots = gridRows.filter((q) => q.status === 'queued').map((q) => q.scheduled_for || null);
  if (dropped.length !== slots.length) { await refresh(); return; }

  // Every slot in the pool is empty, so a drag CANNOT change anything — the
  // rows are all «בהרצה הקרובה» and the publisher orders those by created_at.
  // Say so instead of accepting a gesture that writes nothing. (The arrange
  // button is hidden in this case; this is the backstop.)
  if (slots.every((s) => s === null)) {
    toast('לכל הפוסטים בתור אין תזמון — קבעו תאריכים כדי לסדר ביניהם.', 'err');
    await refresh();
    return;
  }

  const changed = [];
  dropped.forEach((q, i) => {
    const want = slots[i];
    if ((q.scheduled_for || null) !== want) { q.scheduled_for = want; changed.push({ q, want }); }
  });
  if (!changed.length) return;

  busy = true;
  try {
    await Promise.all(changed.map(({ q, want }) => rescheduleQueue(q.id, { scheduled_for: want })));
    toast(`התזמון עודכן ל-${changed.length} פוסטים ✓`, 'ok');
  } catch (err) {
    toast('הסידור לא נשמר: ' + (err && err.message || err), 'err');
  } finally {
    busy = false;
    await refresh();          // confirm against the shared truth either way
  }
}

/* ---------------- CSV export ----------------
   Nothing consumes this file — the Edge Function is still the publisher. It
   exists so the plan can leave the tool: sent to the JFCS team, opened in
   Sheets, checked against the content calendar. The ﻿ BOM is load-bearing:
   without it Excel reads the Hebrew columns as mojibake. */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function scheduleCsv(rows, postsById) {
  const head = [
    'position', 'scheduled_for', 'date', 'time', 'post_id', 'title',
    'channel', 'status', 'note', 'requested_by', 'caption', 'slide_urls',
  ];
  const lines = [head.join(',')];
  rows.forEach((q, i) => {
    const post = postsById.get(q.post_id);
    // toLocalInput gives local wall-clock 'YYYY-MM-DDTHH:MM' — the date and
    // time the operator actually means, next to the machine-readable ISO.
    const local = toLocalInput(q.scheduled_for);
    // v2.3: board slide DATA is the render source and wins; `slide_count` is
    // the studio's number and nothing on the board updates it, so alone it
    // exported ghost slide URLs for re-rendered posts (same rule as post.js
    // slideTotal() / index.js slideTotalOf()).
    const n = post ? (Array.isArray(post.slides) && post.slides.length
      ? post.slides.length : Math.max(0, Number(post.slide_count) | 0)) : 0;
    const urls = (post && post.asset_prefix)
      ? Array.from({ length: n }, (_, k) => slideUrl(post, k)).join(' | ')
      : '';
    lines.push([
      i + 1,
      q.scheduled_for || '',
      local ? local.slice(0, 10) : '',
      local ? local.slice(11, 16) : '',
      q.post_id,
      post ? (post.title || '') : '',
      q.channel,
      q.status,
      q.note || '',
      q.requested_by || '',
      post ? (post.caption || '') : '',
      urls,
    ].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function downloadCsv(rows, postsById) {
  if (!rows.length) { toast('אין שורות בתור לייצוא', 'err'); return; }
  // Anchor + object URL (same pattern as the slide download in post.js) — a
  // data: URL would ignore the filename in some browsers.
  const blob = new Blob([scheduleCsv(rows, postsById)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const day = toLocalInput(new Date().toISOString()).slice(0, 10);
  const a = el('a', { href: url, download: `schedule-${(board && board.board_key) || 'board'}-${day}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`יוצאו ${rows.length} שורות ✓`, 'ok');
}

/* ---------------- grid section ---------------- */

function setArranging(on) {
  arranging = !!on;
  const grid = document.getElementById('sgrid');
  if (grid) grid.classList.toggle('is-arranging', arranging);
  const btn = document.getElementById('arrange');
  if (btn) btn.textContent = arranging ? '🔒 נעילת הסידור' : '🔓 סידור חופשי';
}

function setView(next) {
  view = next === 'grid' ? 'grid' : 'list';
  localStorage.setItem(VIEW_LS, view);
  if (view !== 'grid') arranging = false;
  refresh().catch(() => {});
}

function viewTabs() {
  const mk = (key, label) => {
    const b = el('button', { type: 'button', class: view === key ? 'is-on' : '' }, [label]);
    b.addEventListener('click', () => { if (view !== key) setView(key); });
    return b;
  };
  return el('div', { class: 'viewtabs' }, [mk('list', '☰ רשימה'), mk('grid', '▦ לוח')]);
}

function gridSection(queue, postsById, states) {
  gridRows = queue.filter((q) => GRID_STATUSES.has(q.status)).sort(publishOrder);
  const movable = gridRows.filter((q) => q.status === 'queued');
  const movableCount = movable.length;
  // Rearranging swaps TIMES between rows, so it needs at least one real time
  // to swap. With nothing scheduled there is no slot pool and every drag would
  // be a no-op — don't offer the gesture at all.
  const slotted = movable.filter((q) => q.scheduled_for).length;
  const canArrange = movableCount >= 2 && slotted >= 1;
  if (!canArrange && arranging) arranging = false;

  const arrange = el('button', {
    id: 'arrange', class: 'btn btn--ghost', type: 'button',
    hidden: canArrange ? null : true,
  }, [arranging ? '🔒 נעילת הסידור' : '🔓 סידור חופשי']);
  arrange.addEventListener('click', () => setArranging(!arranging));

  const csv = el('button', { class: 'btn btn--ghost', type: 'button' }, ['⬇︎ ייצוא CSV']);
  csv.addEventListener('click', () => downloadCsv(gridRows, postsById));

  const grid = el('div', {
    id: 'sgrid', class: 'sgrid' + (arranging ? ' is-arranging' : ''),
  }, gridRows.length
    ? gridRows.map((q, i) => scheduleCard(
        q, postsById.get(q.post_id), i + 1, q.status === 'queued', states.get(q.post_id)))
    : [el('p', { class: 'empty sgrid__empty' }, ['אין פוסטים מתוזמנים. הוסיפו פוסט מ«מוכנים לפרסום» למעלה.'])]);
  grid.addEventListener('pointerdown', onGridPointerDown);

  let hint;
  if (canArrange) {
    hint = 'הסדר כאן הוא סדר הפרסום בפועל. «סידור חופשי» ← גררו כרטיס למקום אחר והוא יקבל את התאריך של המקום הזה. התאריכים עצמם לא זזים — רק מי יושב בכל אחד.';
  } else if (movableCount >= 2) {
    hint = 'הסדר כאן הוא סדר הפרסום בפועל. לסידור בגרירה צריך שלפחות פוסט אחד יהיה מתוזמן לתאריך — «בהרצה הקרובה» אינו מקום בלוח.';
  } else {
    hint = 'הסדר כאן הוא סדר הפרסום בפועל. צריך שני פוסטים בתור לפחות כדי לסדר מחדש.';
  }

  return el('section', { class: 'block' }, [
    el('h2', {}, ['לוח התזמון']),
    el('p', { class: 'block__hint' }, [hint]),
    el('div', { class: 'qbar' }, [arrange, csv]),
    grid,
  ]);
}

/* ---------------- running the publisher ----------------
   Nothing publishes from the browser. These buttons ask the `publish` Edge
   Function to act; it holds the Meta token and is itself dry-run unless the
   operator set PUBLISH_LIVE=true on the deployment. So «פרסם עכשיו» is safe to
   press before go-live: it comes back with the plan and posts nothing. */

function resultModal(title, data) {
  const rows = Array.isArray(data.results) ? data.results : [];
  const kids = [];

  kids.push(el('p', { class: 'block__hint' }, [
    data.live
      ? '⚠️ הרצה חיה — הפוסטים נשלחו למטא.'
      : '🧪 הרצה יבשה — שום דבר לא פורסם. כדי לפרסם באמת צריך PUBLISH_LIVE=true בפונקציה.',
  ]));

  if (!rows.length) kids.push(el('p', { class: 'empty' }, ['אין שורות מתאימות כרגע.']));

  for (const r of rows) {
    const bits = [`${r.post_id} → ${CHANNELS[r.channel] || r.channel}`, `סטטוס: ${r.status}`];
    if (r.reason) bits.push(r.reason);
    if (r.result && r.result.instagram) bits.push('IG media: ' + r.result.instagram.media_id);
    if (r.result && r.result.facebook) bits.push('FB post: ' + r.result.facebook.post_id);
    if (r.result && r.result.errors) bits.push('שגיאות: ' + r.result.errors.join(' | '));
    if (r.bookkeeping_error) {
      bits.push('⚠️ פורסם אבל עדכון השורה נכשל: ' + r.bookkeeping_error);
    }
    kids.push(el('div', { class: 'qrow__note' }, [bits.join(' · ')]));
    if (Array.isArray(r.plan) && r.plan.length) {
      kids.push(el('pre', { class: 'qrow__result' }, [r.plan.join('\n')]));
    }
  }
  modal(title, el('div', {}, kids));
}

async function runPublisher(mode, row) {
  if (busy) return;
  let key = opKey();
  if (!key) {
    key = await askOperatorKey();
    if (!key) return;
  }
  busy = true;
  toast(mode === 'now' ? 'מריץ פרסום…' : 'מכין תצוגה מקדימה…');
  try {
    const data = await callPublisher({ mode, row_id: row ? row.id : null, operator_key: key });
    resultModal(mode === 'now' ? 'תוצאות הפרסום' : 'תצוגה מקדימה (הרצה יבשה)', data);
    await refresh();
  } catch (err) {
    if (err.status === 401) {
      toast('המפתח שגוי — נסו שוב');
      localStorage.removeItem(OPKEY_LS);
    } else {
      toast('שגיאה: ' + err.message);
    }
  } finally {
    busy = false;
  }
}

/* Move an existing queued row's time/note in place — re-queueing to change a
   date would leave a duplicate row behind. Channel is not editable here (the
   grant forbids it); switching channel is cancel + re-add. */
function openRescheduleModal(q, post) {
  const when = el('input', {
    class: 'field__input', type: 'datetime-local', value: toLocalInput(q.scheduled_for),
  });
  const note = el('input', { class: 'field__input', type: 'text', value: q.note || '' });
  const submit = el('button', { class: 'btn btn--primary' }, ['שמירה']);

  const body = el('div', { class: 'qform' }, [
    el('label', { class: 'field' }, [
      el('div', { class: 'field__label' }, ['תזמון (ריק = בהרצה הקרובה)']), when]),
    el('label', { class: 'field' }, [
      el('div', { class: 'field__label' }, ['הערה למפרסם']), note]),
    el('p', { class: 'block__hint' }, ['לשינוי ערוץ: ביטול השורה והוספה מחדש.']),
    el('div', { class: 'toolbar' }, [submit]),
  ]);
  const m = modal('שינוי תזמון — ' + (post ? (post.title || post.id) : q.post_id), body);

  submit.addEventListener('click', async () => {
    if (busy) return;
    busy = true; submit.disabled = true;
    try {
      await rescheduleQueue(q.id, {
        scheduled_for: fromLocalInput(when.value),
        note: note.value.trim(),
      });
      closeModal(m);
      toast('התזמון עודכן');
      await refresh();
    } catch (err) {
      toast('שגיאה: ' + err.message);
    } finally {
      busy = false; submit.disabled = false;
    }
  });
}

async function changeStatus(id, status) {
  if (busy) return;
  busy = true;
  try {
    await setQueueStatus(id, status);
    toast(status === 'canceled' ? 'הוסר מהתור' : 'הוחזר לתור');
    await refresh();
  } catch (err) {
    toast('שגיאה: ' + err.message);
  } finally {
    busy = false;
  }
}

function infoCard() {
  return el('div', { class: 'card card--info' }, [
    el('h2', {}, ['איך הפרסום עובד בפועל?']),
    el('p', {}, [
      'הפרסום רץ בענן, לא ממחשב מסוים: פונקציית ',
      el('code', {}, ['publish']),
      ' ב-Supabase מחזיקה את מפתח ה-API של Meta (הדפדפן לעולם לא רואה אותו), ותזמון קבוע ',
      el('code', {}, ['pg_cron']),
      ' מעיר אותה כל חמש דקות ומפרסם כל שורה שהגיע זמנה. ',
      'לאינסטגרם אין תזמון מובנה ב-API — ולכן התזמון הוא שלנו.',
    ]),
    el('p', {}, [
      'הפונקציה יבשה כברירת מחדל: בלי ',
      el('code', {}, ['PUBLISH_LIVE=true']),
      ' היא רק מחזירה את התוכנית ולא מפרסמת דבר. «תצוגה מקדימה של התור» מראה בדיוק מה היה קורה. ',
      'הסקריפט המקומי ',
      el('code', {}, ['scripts/publish-meta.mjs']),
      ' נשאר כגיבוי ידני.',
    ]),
  ]);
}

function render(posts, queue, tallies, approvals, versions) {
  const app = document.getElementById('app');
  const postsById = new Map(posts.map((p) => [p.id, p]));

  /* v2.3 — derived HERE, every render, from the raw rows. Never cached across
     renders and never written anywhere: staleness is a function of the version
     trail, so the moment a poll brings a new version row the chips and tags are
     right again with no invalidation logic to get wrong. */
  const states = new Map(posts.map((p) => [p.id, approvalState(p, approvals, versions)]));

  // "not yet queued" = no active (queued/published) queue row; failed or
  // canceled attempts may be re-queued.
  const active = new Set(queue.filter((q) => q.status === 'queued' || q.status === 'published').map((q) => q.post_id));
  // ADMISSION PREDICATE — v2.3 deliberately does NOT touch this line. What is
  // admissible to the queue is a question about the STAGE and nothing else
  // (PLAN I1); the signature only decides how loudly we warn.
  const candidates = posts
    .filter((p) => (p.stage === 'approved' || p.stage === 'complete') && !active.has(p.id))
    .sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));

  const candSection = el('section', { class: 'block' }, [
    el('h2', {}, ['מוכנים לפרסום']),
    el('p', { class: 'block__hint' }, ['פוסטים שאושרו או הושלמו ועדיין לא נכנסו לתור.']),
    ...(candidates.length
      ? candidates.map((p) => {
          const row = candidateRow(p, tallies, states.get(p.id));
          row.querySelector('[data-add]').addEventListener('click', () => openAddModal(p, states.get(p.id)));
          return row;
        })
      : [el('p', { class: 'empty' }, ['אין כרגע פוסטים מאושרים שממתינים לתור.'])]),
  ]);

  // In grid view the queued/publishing rows are drawn as the board, so the
  // list below it shows only what the board can't: the settled statuses.
  const listStatuses = view === 'grid'
    ? QSTATUS_ORDER.filter((s) => !GRID_STATUSES.has(s))
    : QSTATUS_ORDER;

  const groups = listStatuses.map((status) => {
    const rows = queue
      .filter((q) => q.status === status)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!rows.length) return null;
    return el('div', { class: 'qgroup' }, [
      el('div', { class: 'qgroup__head' }, [
        el('span', { class: 'dot dot--' + status }, []),
        QSTATUS[status] || status,
        el('span', { class: 'qgroup__count' }, ['(' + rows.length + ')']),
      ]),
      ...rows.map((q) => queueRow(q, postsById, states)),
    ]);
  }).filter(Boolean);

  // Publisher controls. «תצוגה מקדימה» is a dry run of the whole due queue —
  // the safe way to see exactly what the next cron tick would do.
  const publisherBtns = (board && board.local)
    ? [el('span', { class: 'block__hint' }, ['מצב מקומי — הפרסום בענן לא זמין כאן. הרצה מקומית: node scripts/publish-meta.mjs'])]
    : [
        (() => {
          const b = el('button', { class: 'btn btn--ghost' }, ['תצוגה מקדימה של התור']);
          b.addEventListener('click', () => runPublisher('plan', null));
          return b;
        })(),
        (() => {
          const b = el('button', { class: 'btn btn--ghost' }, [opKey() ? '🔑 מפתח מפעיל' : '🔑 הזנת מפתח מפעיל']);
          b.addEventListener('click', () => askOperatorKey().then(() => refresh()));
          return b;
        })(),
      ];

  const emptyLabel = view === 'grid' ? 'אין שורות שהסתיימו עדיין.' : 'התור ריק.';
  const queueSection = el('section', { class: 'block' }, [
    el('h2', {}, ['התור']),
    el('div', { class: 'qbar' }, [
      viewTabs(),
      el('span', { class: 'qbar__spacer' }, []),
      ...publisherBtns,
    ]),
    ...(groups.length ? groups : [el('p', { class: 'empty' }, [emptyLabel])]),
  ]);

  const page = document.getElementById('page');
  if (page) page.classList.toggle('page--wide', view === 'grid');

  app.replaceChildren(
    candSection,
    ...(view === 'grid' ? [gridSection(queue, postsById, states)] : []),
    queueSection,
    infoCard(),
  );
  if (view === 'grid' && arranging) setArranging(true);   // re-apply after re-render
}

/* ---------------- data + boot ---------------- */

async function refresh() {
  // Two extra WHOLE-BOARD reads, not a fan-out: listAllApprovals /
  // listAllVersions are one request each for every post on the board, so the
  // page cost is +2 requests regardless of how many candidates there are.
  const [posts, votes, queue, approvals, versions] = await Promise.all([
    listPosts(), listVotes(), listQueue(), listAllApprovals(), listAllVersions(),
  ]);
  render(posts, queue, latestVotes(votes), approvals, versions);
}

(async function main() {
  try {
    board = await initStore();      // needed for the post.html links on every row
    await ensureName();
    document.getElementById('nav').replaceChildren(navBar('queue'));
    await refresh();
    // A realtime tick (or the 10s poll) mid-drag would re-render the grid out
    // from under the pointer and lose the gesture — and mid-write it would
    // draw the pre-write truth. Skip those ticks; commitSchedule refreshes.
    subscribe(() => { if (dragging || busy) return; refresh().catch(() => {}); });
  } catch (err) {
    document.getElementById('app').replaceChildren(
      el('p', { class: 'empty' }, ['שגיאה בטעינה: ' + err.message]));
  }
})();
