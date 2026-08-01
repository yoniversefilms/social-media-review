// queue.js — «תור הפרסום» page logic. (owner: pipeline)
// Talks to the backend ONLY through store.js; shared widgets from ui.js.
// Publishing itself never happens from the browser — this page only manages
// sm_publish rows; scripts/publish-meta.mjs (operator machine) consumes them.

import {
  initStore, ensureName, slideUrl,
  listPosts, listVotes, latestVotes, listQueue,
  queuePublish, rescheduleQueue, setQueueStatus, callPublisher, subscribe,
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

function openAddModal(post) {
  const sel = el('select', { class: 'field__input' },
    Object.entries(CHANNELS).map(([v, label]) => el('option', { value: v }, [label])));
  const note = el('textarea', { class: 'field__input', rows: '2', placeholder: 'למשל: לפרסם בבוקר, לתייג את העמוד של JFCS' });
  const when = el('input', { class: 'field__input', type: 'datetime-local' });
  const submit = el('button', { class: 'btn btn--primary' }, ['הוסף לתור']);

  const body = el('div', { class: 'qform' }, [
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['ערוץ פרסום']), sel]),
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['הערה למפרסם (לא חובה)']), note]),
    el('label', { class: 'field' }, [el('div', { class: 'field__label' }, ['תזמון (לא חובה — ריק = בהרצה הקרובה)']), when]),
    el('div', { class: 'toolbar' }, [submit]),
  ]);
  const m = modal('הוספה לתור — ' + (post.title || post.id), body);

  submit.addEventListener('click', async () => {
    if (busy) return;
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
      busy = false; submit.disabled = false;
    }
  });
}

/* ---------------- rendering ---------------- */

function candidateRow(post, tallies) {
  const cat = CAT[post.category] || post.category;
  return el('div', { class: 'prow' }, [
    thumbEl(post),
    el('div', { class: 'prow__main' }, [
      titleEl(post, post.id, 'prow__title'),
      el('div', { class: 'prow__meta' }, [
        el('span', { class: 'tag' }, [cat]),
        el('span', { class: 'tag' }, [STAGE[post.stage] || post.stage]),
        tallyEl(tallyOf(tallies.get(post.id))),
      ]),
    ]),
    openBtn(post),
    el('button', { class: 'btn btn--primary', 'data-add': '1' }, ['הוסף לתור']),
  ]);
}

function queueRow(q, postsById) {
  const post = postsById.get(q.post_id);
  const meta = [chanIcons(q.channel)];
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

function render(posts, queue, tallies) {
  const app = document.getElementById('app');
  const postsById = new Map(posts.map((p) => [p.id, p]));

  // "not yet queued" = no active (queued/published) queue row; failed or
  // canceled attempts may be re-queued.
  const active = new Set(queue.filter((q) => q.status === 'queued' || q.status === 'published').map((q) => q.post_id));
  const candidates = posts
    .filter((p) => (p.stage === 'approved' || p.stage === 'complete') && !active.has(p.id))
    .sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(String(b.id)));

  const candSection = el('section', { class: 'block' }, [
    el('h2', {}, ['מוכנים לפרסום']),
    el('p', { class: 'block__hint' }, ['פוסטים שאושרו או הושלמו ועדיין לא נכנסו לתור.']),
    ...(candidates.length
      ? candidates.map((p) => {
          const row = candidateRow(p, tallies);
          row.querySelector('[data-add]').addEventListener('click', () => openAddModal(p));
          return row;
        })
      : [el('p', { class: 'empty' }, ['אין כרגע פוסטים מאושרים שממתינים לתור.'])]),
  ]);

  const groups = QSTATUS_ORDER.map((status) => {
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
      ...rows.map((q) => queueRow(q, postsById)),
    ]);
  }).filter(Boolean);

  // Publisher controls. «תצוגה מקדימה» is a dry run of the whole due queue —
  // the safe way to see exactly what the next cron tick would do.
  const publisherBar = (board && board.local)
    ? el('p', { class: 'block__hint' }, ['מצב מקומי — הפרסום בענן לא זמין כאן. הרצה מקומית: node scripts/publish-meta.mjs'])
    : el('div', { class: 'toolbar', style: 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px' }, [
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
      ]);

  const queueSection = el('section', { class: 'block' }, [
    el('h2', {}, ['התור']),
    publisherBar,
    ...(groups.length ? groups : [el('p', { class: 'empty' }, ['התור ריק.'])]),
  ]);

  app.replaceChildren(candSection, queueSection, infoCard());
}

/* ---------------- data + boot ---------------- */

async function refresh() {
  const [posts, votes, queue] = await Promise.all([listPosts(), listVotes(), listQueue()]);
  render(posts, queue, latestVotes(votes));
}

(async function main() {
  try {
    board = await initStore();      // needed for the post.html links on every row
    await ensureName();
    document.getElementById('nav').replaceChildren(navBar('queue'));
    await refresh();
    subscribe(() => { refresh().catch(() => {}); });
  } catch (err) {
    document.getElementById('app').replaceChildren(
      el('p', { class: 'empty' }, ['שגיאה בטעינה: ' + err.message]));
  }
})();
