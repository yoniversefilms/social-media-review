// discuss.js — «שיחות», the board-wide discussions hub. (owner: discussions)
// Two views over one live dataset:
//   «שיחות»  — every pin on every post with its reply thread, newest activity
//              first; reply, resolve, jump to the post — without opening posts
//              one by one.
//   «הצבעות» — vote activity grouped by post: current tally + each reviewer's
//              latest vote with their reason.
// Talks to the backend ONLY through store.js.

import {
  initStore, ensureName, slideUrl, photoUrl,
  listPosts, listAllPins, listAllReplies, listAllPhotos,
  listVotes, latestVotes,
  addReply, resolvePin, subscribe,
} from './store.js';
import { el, modal, toast, fmtDate, voteGlyph, navBar } from './ui.js';

const SEEN_KEY = 'smr:seen-threads';
const VOTE_LABELS = { yes: 'כן', no: 'לא', maybe: 'אולי' };

const S = {
  postsById: new Map(),
  threads: [],            // [{pin, post, replies, photos, lastActivity}]
  votesByPost: new Map(), // latestVotes(): post_id -> Map author -> {vote, reason, created_at}
  voteGroups: [],         // [{post_id, post, entries:[{author,vote,reason,created_at}], lastActivity}]
  view: 'threads',        // 'threads' | 'votes'
  filter: { status: 'all', post: '', author: '' },
  seenAtLoad: {},         // snapshot at page load — «חדש» tags compare to THIS
  firstVisit: false,      // never been here on this device → don't tag everything
  pendingRender: false,
};

// ---------------------------------------------------------------- seen store
// Per-device memory of the latest activity seen per thread (localStorage).
// Tags compare against the page-load snapshot so a «חדש» badge survives the
// live refreshes of one sitting, while the persisted map advances so the
// NEXT visit starts clean.

function loadSeen() {
  try { return JSON.parse(localStorage.getItem(SEEN_KEY)) || {}; } catch { return {}; }
}

function persistSeen() {
  const cur = loadSeen();
  for (const t of S.threads) {
    if (!cur[t.pin.id] || new Date(t.lastActivity) > new Date(cur[t.pin.id])) {
      cur[t.pin.id] = t.lastActivity;
    }
  }
  // drop entries whose pin no longer exists (deleted pins)
  const alive = new Set(S.threads.map((t) => t.pin.id));
  for (const id of Object.keys(cur)) if (!alive.has(id)) delete cur[id];
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(cur)); } catch { /* full/blocked */ }
}

function isNew(t) {
  if (S.firstVisit) return false;
  const seen = S.seenAtLoad[t.pin.id];
  return !seen || new Date(t.lastActivity) > new Date(seen);
}

// ---------------------------------------------------------------- links

function keepParams() {
  const params = new URLSearchParams(location.search);
  const q = new URLSearchParams();
  if (params.get('board')) q.set('board', params.get('board'));
  if (params.get('local')) q.set('local', params.get('local'));
  return q;
}

function postHref(post_id) {
  const q = keepParams();
  q.set('id', post_id);
  return 'post.html?' + q.toString();
}

// ---------------------------------------------------------------- data

async function refresh(force = false) {
  const [posts, pins, replies, photos, votes] = await Promise.all([
    listPosts(), listAllPins(), listAllReplies(), listAllPhotos(), listVotes(),
  ]);
  S.postsById = new Map(posts.map((p) => [p.id, p]));

  const repliesByPin = new Map();
  for (const r of replies) {
    if (!repliesByPin.has(r.pin_id)) repliesByPin.set(r.pin_id, []);
    repliesByPin.get(r.pin_id).push(r);
  }
  const photosByPin = new Map();
  for (const ph of photos) {
    if (!ph.pin_id) continue;
    if (!photosByPin.has(ph.pin_id)) photosByPin.set(ph.pin_id, []);
    photosByPin.get(ph.pin_id).push(ph);
  }

  S.threads = pins.map((pin) => {
    const rs = repliesByPin.get(pin.id) || [];
    let last = pin.created_at;
    for (const r of rs) if (new Date(r.created_at) > new Date(last)) last = r.created_at;
    return {
      pin,
      post: S.postsById.get(pin.post_id) || null,
      replies: rs,
      photos: photosByPin.get(pin.id) || [],
      lastActivity: last,
    };
  }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  // votes: one fetch, latest-per-author computed in memory (contract helper)
  S.votesByPost = latestVotes(votes);
  S.voteGroups = [...S.votesByPost.entries()].map(([post_id, perAuthor]) => {
    const entries = [...perAuthor.entries()]
      .map(([author, v]) => ({ author, ...v }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return {
      post_id,
      post: S.postsById.get(post_id) || null,
      entries,
      lastActivity: entries.length ? entries[0].created_at : '',
    };
  }).sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity));

  render(force);
  persistSeen();
}

function tallyOf(post_id) {
  const t = { yes: 0, no: 0, maybe: 0 };
  const perAuthor = S.votesByPost.get(post_id);
  if (perAuthor) for (const v of perAuthor.values()) if (t[v.vote] != null) t[v.vote]++;
  return t;
}

function filteredThreads() {
  return S.threads.filter((t) => {
    if (S.filter.status === 'open' && t.pin.status === 'resolved') return false;
    if (S.filter.status === 'resolved' && t.pin.status !== 'resolved') return false;
    if (S.filter.post && t.pin.post_id !== S.filter.post) return false;
    if (S.filter.author) {
      const inPin = (t.pin.author || '') === S.filter.author;
      const inReplies = t.replies.some((r) => (r.author || '') === S.filter.author);
      if (!inPin && !inReplies) return false;
    }
    return true;
  });
}

function filteredVoteGroups() {
  return S.voteGroups
    .filter((g) => !S.filter.post || g.post_id === S.filter.post)
    .map((g) => {
      if (!S.filter.author) return g;
      const entries = g.entries.filter((e) => e.author === S.filter.author);
      return entries.length ? { ...g, entries } : null;
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------- render

// focus guard (post.js pattern): a live refresh never clobbers a reply the
// reviewer is typing — defer the re-render until focus leaves the feed.
function render(force = false) {
  const feed = document.getElementById('feed');
  if (!force && feed.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    if (!S.pendingRender) {
      S.pendingRender = true;
      feed.addEventListener('focusout', () => {
        setTimeout(() => {
          if (!S.pendingRender) return;
          if (feed.contains(document.activeElement) &&
              /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
          S.pendingRender = false;
          render(true);
        }, 80);
      }, { once: true });
    }
    return;
  }
  S.pendingRender = false;

  renderToolbar();
  if (S.view === 'votes') renderVoteFeed(feed);
  else renderThreadFeed(feed);
}

function renderThreadFeed(feed) {
  const shown = filteredThreads();
  if (!S.threads.length) {
    feed.replaceChildren(el('div', { class: 'empty' },
      el('p', null, el('b', null, 'עוד אין שיחות על הלוח.')),
      el('p', null, 'הערה ראשונה מתחילים מתוך פוסט: פותחים אותו, לוחצים «📍 הוסף הערה על השקף» — והשיחה תופיע כאן.'),
    ));
    return;
  }
  if (!shown.length) {
    feed.replaceChildren(el('div', { class: 'empty' },
      'אין שיחות שמתאימות לסינון הזה — נסו «הכל».'));
    return;
  }
  feed.replaceChildren(...shown.map(threadCard));
}

function renderVoteFeed(feed) {
  const shown = filteredVoteGroups();
  if (!S.voteGroups.length) {
    feed.replaceChildren(el('div', { class: 'empty' },
      el('p', null, el('b', null, 'עוד אין הצבעות על הלוח.')),
      el('p', null, 'מצביעים מתוך פוסט — בלשונית «הצבעה» — וכל ההצבעות יתרכזו כאן.'),
    ));
    return;
  }
  if (!shown.length) {
    feed.replaceChildren(el('div', { class: 'empty' },
      'אין הצבעות שמתאימות לסינון הזה.'));
    return;
  }
  feed.replaceChildren(...shown.map(voteGroupCard));
}

function renderToolbar() {
  const bar = document.getElementById('toolbar');

  // view tabs: «שיחות» / «הצבעות»
  const openCount = S.threads.filter((t) => t.pin.status !== 'resolved').length;
  const tabs = [
    { key: 'threads', label: 'שיחות', n: S.threads.length },
    { key: 'votes', label: 'הצבעות', n: S.voteGroups.length },
  ].map((v) => {
    const b = el('button', {
      class: 'd-tab' + (S.view === v.key ? ' d-tab--on' : ''), type: 'button',
    }, v.label, v.n ? el('span', { class: 'd-tab__n' }, String(v.n)) : null);
    b.addEventListener('click', () => { S.view = v.key; render(true); });
    return b;
  });

  // open/resolved chips are a THREADS concept — hidden on the votes view
  const chips = S.view === 'threads'
    ? [
        { key: 'all', label: 'הכל' },
        { key: 'open', label: 'פתוחות' },
        { key: 'resolved', label: 'טופלו' },
      ].map((c) => {
        const b = el('button', {
          class: 'chip' + (S.filter.status === c.key ? ' chip--on' : ''), type: 'button',
        }, c.label);
        b.addEventListener('click', () => { S.filter.status = c.key; render(true); });
        return b;
      })
    : [];

  // per-post filter — posts that have activity in the current view
  const postIds = S.view === 'votes'
    ? S.voteGroups.map((g) => g.post_id)
    : [...new Set(S.threads.map((t) => t.pin.post_id))];
  const postSel = el('select', { 'aria-label': 'סינון לפי פוסט' },
    el('option', { value: '' }, 'כל הפוסטים'),
    postIds.map((id) => {
      const p = S.postsById.get(id);
      return el('option', { value: id }, p ? (p.title || p.id) : id);
    }),
  );
  if (S.filter.post && !postIds.includes(S.filter.post)) S.filter.post = '';
  postSel.value = S.filter.post;
  postSel.addEventListener('change', () => { S.filter.post = postSel.value; render(true); });

  // per-author filter — anyone who wrote a pin, a reply, or a vote
  const authors = [...new Set([
    ...S.threads.map((t) => t.pin.author || ''),
    ...S.threads.flatMap((t) => t.replies.map((r) => r.author || '')),
    ...S.voteGroups.flatMap((g) => g.entries.map((e) => e.author || '')),
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  const authorSel = el('select', { 'aria-label': 'סינון לפי כותב/ת' },
    el('option', { value: '' }, 'כל הכותבים'),
    authors.map((a) => el('option', { value: a }, a)),
  );
  if (S.filter.author && !authors.includes(S.filter.author)) S.filter.author = '';
  authorSel.value = S.filter.author;
  authorSel.addEventListener('change', () => { S.filter.author = authorSel.value; render(true); });

  const count = el('span', { class: 'd-count' },
    S.view === 'votes'
      ? `${S.voteGroups.length} פוסטים עם הצבעות`
      : `${openCount} שיחות פתוחות מתוך ${S.threads.length}`);

  bar.replaceChildren(
    el('div', { class: 'd-row' }, tabs, el('span', { style: { marginInlineStart: 'auto' } }, count)),
    el('div', { class: 'd-row' }, chips, postSel, authorSel),
  );
}

// small tally chip row (👍/🤔/👎 counts) — shared by both views
function tallyEl(post_id) {
  const t = tallyOf(post_id);
  if (!t.yes && !t.no && !t.maybe) return null;
  return el('span', { class: 'th-tally', title: 'הצבעות על הפוסט' },
    el('span', { class: 'vote-yes' }, voteGlyph('yes') + ' ' + t.yes),
    el('span', { class: 'vote-maybe' }, voteGlyph('maybe') + ' ' + t.maybe),
    el('span', { class: 'vote-no' }, voteGlyph('no') + ' ' + t.no),
  );
}

// ---------------------------------------------------------------- thread card

function threadCard(t) {
  const { pin, post } = t;
  const resolved = pin.status === 'resolved';
  const href = postHref(pin.post_id);

  // slide thumbnail with the pin's exact position marked.
  // pin.x/y are fractions of the slide measured from the LEFT/top edge
  // (post.js: (clientX - rect.left) / width) — so absolute left/top, not
  // inset-inline-start, which in RTL would mirror the point.
  const thumb = el('a', { class: 'th-thumb', href, title: 'פתיחה בפוסט' },
    post ? el('img', { src: slideUrl(post, Number(pin.slide) || 0), alt: '', loading: 'lazy' }) : null,
    el('span', {
      class: 'th-dot',
      style: { left: (Number(pin.x) * 100) + '%', top: (Number(pin.y) * 100) + '%' },
    }),
  );

  const postline = el('div', { class: 'th-postline' },
    el('a', { class: 'title', href }, post ? (post.title || post.id) : pin.post_id),
    el('span', { class: 'tag' }, `שקף ${(Number(pin.slide) || 0) + 1}`),
    isNew(t) ? el('span', { class: 'tag tag--new' }, 'חדש') : null,
    resolved ? el('span', { class: 'tag tag--resolved' }, 'טופל') : null,
    tallyEl(pin.post_id),
  );

  const head = el('div', { class: 'th-head' },
    el('span', { class: 'who' }, pin.author || 'אלמוני'),
    el('time', null, fmtDate(pin.created_at)),
  );

  const photosEl = t.photos.length
    ? el('div', { class: 'th-photos' }, t.photos.map((ph) => {
        const img = el('img', { src: photoUrl(ph), alt: ph.note || 'תמונה מצורפת', loading: 'lazy' });
        img.addEventListener('click', () => modal(ph.note || 'תמונה מצורפת',
          el('img', { src: photoUrl(ph), alt: '', style: { maxWidth: '100%', borderRadius: '10px' } })));
        return img;
      }))
    : null;

  const repliesEl = t.replies.length
    ? el('div', { class: 'th-replies' }, t.replies.map((r) => el('div', { class: 'th-reply' },
        el('span', { class: 'who' }, r.author || 'אלמוני'),
        el('time', null, fmtDate(r.created_at)),
        el('div', { class: 'body' }, r.body),
      )))
    : null;

  // inline reply — answering from the hub is the whole point
  const rInput = el('input', { class: 'field__input', type: 'text', placeholder: 'תגובה…' });
  const rSend = el('button', { class: 'btn btn--ghost', type: 'button' }, 'שלח');
  const sendReply = async () => {
    const body = rInput.value.trim();
    if (!body) return;
    rSend.disabled = true;
    try {
      await ensureName();
      await addReply({ pin_id: pin.id, body });
      rInput.value = '';
      await refresh(true); // own action: re-render even while the input has focus
    } catch (e) {
      toast('התגובה לא נשלחה: ' + e.message, 'err');
    } finally {
      rSend.disabled = false;
    }
  };
  rSend.addEventListener('click', sendReply);
  rInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReply(); });

  const resolveBtn = el('button', { class: 'btn btn--ghost', type: 'button' },
    resolved ? 'פתיחה מחדש' : 'סמן כטופל');
  resolveBtn.addEventListener('click', async () => {
    resolveBtn.disabled = true;
    try {
      await resolvePin(pin.id, resolved ? 'open' : 'resolved');
      toast(resolved ? 'השיחה נפתחה מחדש' : 'סומן כטופל', 'ok');
      await refresh(true);
    } catch (e) {
      toast('לא הצליח: ' + e.message, 'err');
      resolveBtn.disabled = false;
    }
  });

  return el('div', { class: 'th-card' + (resolved ? ' resolved' : ''), id: 'thread-' + pin.id },
    el('div', { class: 'th-top' },
      thumb,
      el('div', { class: 'th-main' },
        postline, head,
        el('div', { class: 'th-body' }, pin.body),
      ),
    ),
    photosEl,
    repliesEl,
    el('div', { class: 'th-replybox' }, rInput, rSend),
    el('div', { class: 'th-foot' },
      resolveBtn,
      el('span', { class: 'spacer' }),
      el('a', { class: 'btn btn--ghost', href }, 'פתח בפוסט'),
    ),
  );
}

// ---------------------------------------------------------------- vote group card

function voteGroupCard(g) {
  const href = postHref(g.post_id);
  const thumb = el('a', { class: 'th-thumb', href, title: 'פתיחה בפוסט' },
    g.post ? el('img', { src: slideUrl(g.post, 0), alt: '', loading: 'lazy' }) : null);

  const rows = g.entries.map((v) => el('div', { class: 'v-row' },
    el('span', { class: 'who' }, v.author || 'אלמוני'),
    el('span', { class: 'v-vote vote-' + v.vote }, voteGlyph(v.vote) + ' ' + (VOTE_LABELS[v.vote] || v.vote)),
    el('time', null, fmtDate(v.created_at)),
    v.reason ? el('div', { class: 'v-reason' }, v.reason) : null,
  ));

  return el('div', { class: 'th-card' },
    el('div', { class: 'th-top' },
      thumb,
      el('div', { class: 'th-main' },
        el('div', { class: 'th-postline' },
          el('a', { class: 'title', href }, g.post ? (g.post.title || g.post.id) : g.post_id),
          tallyEl(g.post_id),
        ),
        el('div', { class: 'v-rows' }, rows),
      ),
    ),
    el('div', { class: 'th-foot' },
      el('span', { class: 'd-count' }, `${g.entries.length} הצביעו`),
      el('span', { class: 'spacer' }),
      el('a', { class: 'btn btn--ghost', href }, 'פתח בפוסט'),
    ),
  );
}

// ---------------------------------------------------------------- boot

(async function main() {
  try {
    await initStore();
    await ensureName();
    document.getElementById('nav').replaceChildren(navBar('discuss'));
    S.firstVisit = localStorage.getItem(SEEN_KEY) === null;
    S.seenAtLoad = loadSeen();
    await refresh(true);
    subscribe(() => { refresh().catch(() => {}); });
  } catch (err) {
    document.getElementById('feed').replaceChildren(
      el('p', { class: 'empty' }, 'שגיאה בטעינה: ' + err.message));
  }
})();
