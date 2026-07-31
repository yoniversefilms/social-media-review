// queue.js — «תור הפרסום» page logic. (owner: pipeline)
// Talks to the backend ONLY through store.js; shared widgets from ui.js.
// Publishing itself never happens from the browser — this page only manages
// sm_publish rows; scripts/publish-meta.mjs (operator machine) consumes them.

import {
  initStore, ensureName, slideUrl,
  listPosts, listVotes, latestVotes, listQueue,
  queuePublish, setQueueStatus, subscribe,
} from './store.js';
import { el, modal, toast, fmtDate, voteGlyph, navBar } from './ui.js';

const CAT = {
  par: 'הורות', cpl: 'זוגיות', rel: 'רילוקיישן', fam: 'משפחה',
  ind: 'טיפול פרטני', orig: 'ליבה', builder: 'נבנה בכלי', general: 'כללי',
};
const STAGE = {
  in_review: 'בבדיקה', editing: 'בעריכה', approved: 'מאושר',
  complete: 'הושלם', parked: 'בהמתנה',
};
const QSTATUS = { queued: 'בתור', published: 'פורסם', failed: 'נכשל', canceled: 'בוטל' };
const QSTATUS_ORDER = ['queued', 'published', 'failed', 'canceled'];
const CHANNELS = { instagram: 'אינסטגרם', facebook: 'פייסבוק', both: 'אינסטגרם + פייסבוק' };

let busy = false;

/* ---------------- helpers ---------------- */

function thumbEl(post) {
  if (post && post.asset_prefix) {
    return el('img', { class: 'thumb', src: slideUrl(post, 0), alt: '', loading: 'lazy' });
  }
  return el('div', { class: 'thumb thumb--empty' }, ['—']);
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
      if (when.value) payload.scheduled_for = new Date(when.value).toISOString();
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
      el('div', { class: 'prow__title' }, [post.title || post.id]),
      el('div', { class: 'prow__meta' }, [
        el('span', { class: 'tag' }, [cat]),
        el('span', { class: 'tag' }, [STAGE[post.stage] || post.stage]),
        tallyEl(tallyOf(tallies.get(post.id))),
      ]),
    ]),
    el('button', { class: 'btn btn--primary' }, ['הוסף לתור']),
  ]);
}

function queueRow(q, postsById) {
  const post = postsById.get(q.post_id);
  const meta = [chanIcons(q.channel)];
  if (q.requested_by) meta.push(el('span', {}, ['ביקש/ה: ' + q.requested_by]));
  if (q.scheduled_for) meta.push(el('span', { class: 'tag' }, ['מתוזמן: ' + fmtDate(q.scheduled_for)]));
  meta.push(el('span', {}, ['נוסף: ' + fmtDate(q.created_at)]));

  const main = [
    el('div', { class: 'qrow__title' }, [post ? (post.title || post.id) : q.post_id]),
    el('div', { class: 'qrow__meta' }, meta),
  ];
  if (q.note) main.push(el('div', { class: 'qrow__note' }, ['הערה: ' + q.note]));
  const res = resultSummary(q.result);
  if (res) main.push(res);

  const actions = [];
  if (q.status === 'queued') {
    const b = el('button', { class: 'btn btn--ghost' }, ['ביטול']);
    b.addEventListener('click', () => changeStatus(q.id, 'canceled'));
    actions.push(b);
  } else if (q.status === 'canceled') {
    const b = el('button', { class: 'btn btn--ghost' }, ['החזרה לתור']);
    b.addEventListener('click', () => changeStatus(q.id, 'queued'));
    actions.push(b);
  }

  return el('div', { class: 'qrow' }, [
    thumbEl(post),
    el('div', { class: 'qrow__main' }, main),
    ...actions,
  ]);
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
      'העמוד הזה מנהל את התור בלבד — שום דבר לא מתפרסם אוטומטית מכאן. ',
      'הפרסום עצמו רץ מהמחשב של המפעיל באמצעות הסקריפט ',
      el('code', {}, ['scripts/publish-meta.mjs']),
      ', שקורא את התור ומפרסם לאינסטגרם ולפייסבוק דרך ה-API של Meta.',
    ]),
    el('p', {}, [
      'ברירת המחדל של הסקריפט היא הרצה ”יבשה“ שמדפיסה תוכנית בלבד; פרסום אמיתי דורש הפעלה מפורשת עם ',
      el('code', {}, ['--live']),
      '. פוסטים מתוזמנים ממתינים בתור עד שמועדם מגיע והמפעיל מריץ את הסקריפט.',
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
          row.querySelector('button').addEventListener('click', () => openAddModal(p));
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

  const queueSection = el('section', { class: 'block' }, [
    el('h2', {}, ['התור']),
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
    await initStore();
    await ensureName();
    document.getElementById('nav').replaceChildren(navBar('queue'));
    await refresh();
    subscribe(() => { refresh().catch(() => {}); });
  } catch (err) {
    document.getElementById('app').replaceChildren(
      el('p', { class: 'empty' }, ['שגיאה בטעינה: ' + err.message]));
  }
})();
