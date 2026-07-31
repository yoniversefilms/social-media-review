// index.js — gallery (board home). Owner: gallery agent.
// Contract: PLAN.md — store.js is the only network module; ui.js supplies
// the shared widgets (el, navBar, toast, voteGlyph, stage/category tables).
import {
  initStore, whoAmI, ensureName, slideUrl, assetUrl,
  listPosts, listVotes, latestVotes, listAllPins, listAllVersions,
  setStage, savePostOrder, subscribe,
} from './store.js';
import { initCompose, mountSlide } from './compose.js';
import {
  el as h, navBar, toast, voteGlyph, fmtDate,
  STAGES, CATEGORIES, STAGE_LABELS, CATEGORY_LABELS,
} from './ui.js';

const VOTE_LABELS = { yes: 'בעד', no: 'נגד', maybe: 'מתלבטים' };

/* ── state ── */
let board = null;                 // {board_key, name, local} from initStore()
let me = { name: '', author_id: '' };
let posts = [];
let agg = new Map();              // post_id -> {yes,no,maybe,mine,discuss,last}
let versions = new Map();         // post_id -> [sm_post_versions row] vnum desc
const viewing = new Map();        // post_id -> vnum | 'studio' (per-card VIEW state only)
const filters = { cat: 'all', stage: 'all', sort: 'manual', q: '' };
let refreshing = false;
let arranging = false;            // «🔓 סידור חופשי» unlocked (manual sort, no filters)
let dragging = false;             // a card is mid-drag right now
let lastDigest = '';              // gates refresh-driven re-renders (see stateDigest)

const $ = (id) => document.getElementById(id);

/* ── boot ── */
(async function boot() {
  renderSkeleton();
  try {
    board = await initStore();
  } catch (err) {
    $('grid').replaceChildren(h('div', { class: 'g-empty' },
      h('p', {}, 'לא הצלחנו להתחבר ללוח. בדקו שהקישור שקיבלתם שלם, ונסו לרענן.'),
      h('p', { style: 'font-size:.85rem;opacity:.7' }, String(err && err.message || err))));
    return;
  }
  me = safeWho();
  $('nav').replaceChildren(navBar('index'));
  wireToolbar();
  await refresh(true);
  subscribe(() => { refresh(false); });
})();

function safeWho() {
  try { return whoAmI() || { name: '', author_id: '' }; }
  catch { return { name: '', author_id: '' }; }
}

/* ── data ── */
async function refresh(first) {
  if (refreshing || dragging) return; refreshing = true;
  try {
    const [p, voteRows, pinRows, verRows] = await Promise.all([
      listPosts(), listVotes(), listAllPins(), listAllVersions().catch(() => []),
    ]);
    posts = p || [];
    me = safeWho();
    agg = aggregate(posts, voteRows || [], pinRows || []);
    versions = groupVersions(verRows || []);
    // A poll that changed nothing must NOT rebuild the grid: re-rendering
    // tears down every live-composed cover and re-mounts it. And an open
    // popup means the reviewer is mid-interaction — leave the DOM alone and
    // let the next refresh (digest still unrecorded) pick the change up.
    const d = stateDigest(posts, voteRows, pinRows, verRows);
    if (!first && d === lastDigest) return;
    if (!first && openMenu) return;
    lastDigest = d;
    renderAll();
  } catch (err) {
    if (first) {
      $('grid').replaceChildren(h('div', { class: 'g-empty' },
        h('p', {}, 'משהו השתבש בטעינת הלוח. נסו לרענן את הדף.'),
        h('p', { style: 'font-size:.85rem;opacity:.7' }, String(err && err.message || err))));
    }
  } finally { refreshing = false; }
}

// Timestamps come from two drivers with different ISO flavors ('Z' vs
// '+00:00'), so compare via Date.parse, never string order.
const ts = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? 0 : t; };

function aggregate(postRows, voteRows, pinRows) {
  const byPost = latestVotes(voteRows); // Map post_id -> Map author -> {vote,reason,created_at}
  const out = new Map();
  const bump = (a, iso) => { if (iso && ts(iso) > ts(a.last)) a.last = iso; };
  for (const p of postRows) {
    // last = newest activity: updated_at covers direct edits (v1.5 — every
    // PATCH bumps it), votes and pins bump it below.
    const a = { yes: 0, no: 0, maybe: 0, mine: null, discuss: 0,
                last: p.updated_at || p.created_at || '' };
    const authors = byPost.get(p.id);
    if (authors) {
      for (const [author, v] of authors) {
        if (a[v.vote] !== undefined) a[v.vote]++;
        if (author === me.author_id || (me.name && author === me.name)) a.mine = v.vote;
        bump(a, v.created_at);
      }
    }
    out.set(p.id, a);
  }
  for (const pin of pinRows) {
    const a = out.get(pin.post_id);
    if (!a) continue;
    a.discuss += 1 + (Number(pin.reply_count ?? 0) || 0);
    bump(a, pin.created_at);
  }
  return out;
}

// post_id -> version rows, newest vnum first. Board versions continue the
// studio numbering (studio v4 -> board v5, v6 …), so vnum sorts numerically.
function groupVersions(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || !r.post_id) continue;
    if (!out.has(r.post_id)) out.set(r.post_id, []);
    out.get(r.post_id).push(r);
  }
  for (const list of out.values()) list.sort((a, b) => Number(b.vnum) - Number(a.vnum));
  return out;
}

// Cheap fingerprint of everything the grid draws. sm_posts.updated_at is
// bumped by every PATCH in BOTH drivers, so it covers slide edits too.
function stateDigest(postRows, voteRows, pinRows, verRows) {
  const tail = (rows) => {
    let n = 0; let last = '';
    for (const r of rows || []) { n++; const c = String(r.created_at || ''); if (c > last) last = c; }
    return `${n}:${last}`;
  };
  let replies = 0;
  for (const r of pinRows || []) replies += Number(r.reply_count ?? 0) || 0;
  const p = (postRows || []).map((x) =>
    `${x.id}|${x.sort}|${x.stage}|${x.category}|${x.version}|${x.updated_at}|${x.title}`).join('~');
  return `${p}#${tail(voteRows)}#${tail(pinRows)}/${replies}#${tail(verRows)}`;
}

/* ── URL helpers (always preserve board + local) ── */
function pageLink(page, extra = {}) {
  const q = new URLSearchParams();
  q.set('board', board.board_key);
  if (board.local) q.set('local', '1');
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  return `${page}?${q.toString()}`;
}
const postLink = (id) => pageLink('post.html', { id });

/* ── toolbar (persistent inputs; chips/tabs re-rendered with live counts) ── */
function wireToolbar() {
  $('toolbar').hidden = false;
  $('sort').value = filters.sort;
  $('sort').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  let deb;
  $('search').addEventListener('input', (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { filters.q = e.target.value.trim(); renderAll(); }, 150);
  });
  $('arrange').addEventListener('click', () => setArranging(!arranging));
  wireArrange();
}

function matches(p, { skipCat = false, skipStage = false } = {}) {
  if (!skipCat && filters.cat !== 'all' && p.category !== filters.cat) return false;
  if (!skipStage && filters.stage !== 'all' && p.stage !== filters.stage) return false;
  if (filters.q) {
    const q = filters.q.toLowerCase();
    const hay = `${p.title || ''} ${p.caption || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function renderAll() { renderChips(); renderTabs(); renderProgress(); renderGrid(); }

function renderChips() {
  const pool = posts.filter((p) => matches(p, { skipCat: true }));
  const count = (cat) => (cat === 'all' ? pool.length : pool.filter((p) => p.category === cat).length);
  const chip = (cat, label) => h('button', {
    class: `chip${filters.cat === cat ? ' chip--on' : ''}`,
    type: 'button',
    onclick: () => { filters.cat = filters.cat === cat ? 'all' : cat; renderAll(); },
  }, label, h('span', { class: 'g-chip-n' }, count(cat)));
  const cats = CATEGORIES.filter((c) =>
    c.key !== 'builder' || posts.some((p) => p.category === 'builder'));
  $('cat-chips').replaceChildren(
    chip('all', 'הכל'),
    ...cats.map((c) => chip(c.key, c.label)));
}

function renderTabs() {
  const pool = posts.filter((p) => matches(p, { skipStage: true }));
  const count = (st) => (st === 'all' ? pool.length : pool.filter((p) => p.stage === st).length);
  const tab = (st, label) => h('button', {
    class: `g-tab${filters.stage === st ? ' is-on' : ''}`,
    type: 'button', role: 'tab', 'aria-selected': String(filters.stage === st),
    onclick: () => { filters.stage = st; renderAll(); },
  }, `${label} `, h('span', { class: 'g-chip-n' }, count(st)));
  $('stage-tabs').replaceChildren(
    tab('all', 'הכל'),
    ...STAGES.map((s) => tab(s.key, s.label)));
}

/* ── progress strip: personal review-pass progress over the whole board ── */
function renderProgress() {
  const strip = $('progress');
  const total = posts.length;
  if (!total) { strip.hidden = true; return; }
  strip.hidden = false;
  const voted = posts.filter((p) => agg.get(p.id)?.mine).length;
  const pct = Math.round((voted / total) * 100);
  const done = voted === total;
  strip.replaceChildren(
    h('span', { class: 'g-progress__txt' },
      done ? 'הצבעת על הכול — תודה! 🎉'
           : ['הצבעת על ', h('b', {}, voted), ' מתוך ', h('b', {}, total)]),
    h('div', {
      class: 'g-progress__track', role: 'progressbar',
      'aria-valuenow': String(voted), 'aria-valuemin': '0', 'aria-valuemax': String(total),
    }, h('div', { class: `g-progress__fill${done ? ' is-done' : ''}`, style: `width:${pct}%` })),
    h('span', { class: 'g-progress__txt' }, `${pct}%`));
}

/* ── sorting ── */
const byNew = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
// Manual order key: sm_posts.sort int; unset/invalid goes last, ties fall
// back to id order (stable across clients).
function manualKey(p) {
  if (p.sort == null || p.sort === '') return Number.MAX_SAFE_INTEGER;
  const v = Number(p.sort);
  return Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER;
}
const byManual = (a, b) => manualKey(a) - manualKey(b) || String(a.id).localeCompare(String(b.id));
function sortPosts(list) {
  const s = filters.sort;
  const n = (id, k) => agg.get(id)?.[k] || 0;
  const last = (id) => ts(agg.get(id)?.last);
  const rated = (id) => n(id, 'yes') + n(id, 'no') + n(id, 'maybe'); // distinct-author latest votes
  const arr = [...list];
  if (s === 'manual') arr.sort(byManual);
  else if (s === 'activity') arr.sort((a, b) => last(b.id) - last(a.id) || byNew(a, b));
  else if (s === 'rated') arr.sort((a, b) => rated(b.id) - rated(a.id) || n(b.id, 'yes') - n(a.id, 'yes') || byNew(a, b));
  else if (s === 'yes') arr.sort((a, b) => n(b.id, 'yes') - n(a.id, 'yes') || byNew(a, b));
  else if (s === 'no') arr.sort((a, b) => n(b.id, 'no') - n(a.id, 'no') || byNew(a, b));
  else if (s === 'talk') arr.sort((a, b) => n(b.id, 'discuss') - n(a.id, 'discuss') || byNew(a, b));
  else if (s === 'unvoted') arr.sort((a, b) => (agg.get(a.id)?.mine ? 1 : 0) - (agg.get(b.id)?.mine ? 1 : 0) || byNew(a, b));
  else arr.sort(byNew);
  return arr;
}

/* ── manual arrangement: unlock & drag (shared order, everyone's default) ── */
// Arranging is allowed on the full board AND inside a single category (the
// operator arranges category by category). The filters BELOW the category
// chips — stage, search — and any other sort still override the manual layout;
// clearing them reverts to it untouched, because overriding never writes.
function arrangeEligible() {
  return filters.sort === 'manual'
      && filters.stage === 'all' && !filters.q && posts.length > 1;
}

function setArranging(on) {
  arranging = !!on;
  const btn = $('arrange');
  btn.classList.toggle('is-on', arranging);
  btn.textContent = arranging ? '🔒 נעילת הסידור' : '🔓 סידור חופשי';
  $('grid').classList.toggle('is-arranging', arranging);
}

// Any filter/other sort overrides the manual layout: the toggle hides and
// arrange mode exits (also restores link navigation).
function renderArrangeBtn() {
  const ok = arrangeEligible();
  if (!ok && arranging) setArranging(false);
  $('arrange').hidden = !ok;
}

function wireArrange() {
  const grid = $('grid');
  // Cards are links — while unlocked, clicks must not navigate (or open menus).
  grid.addEventListener('click', (e) => {
    if (arranging) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  // Kill native image/link dragging so pointer-reorder owns the gesture.
  grid.addEventListener('dragstart', (e) => { if (arranging) e.preventDefault(); });
  grid.addEventListener('pointerdown', onArrangePointerDown);
}

function onArrangePointerDown(e) {
  if (!arranging || dragging) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const cardEl = e.target.closest('.g-card');
  if (!cardEl || cardEl.classList.contains('g-skel')) return;
  e.preventDefault();
  const grid = $('grid');
  const pid = e.pointerId;
  const startX = e.clientX, startY = e.clientY;
  let live = false;

  const move = (ev) => {
    if (ev.pointerId !== pid) return;
    if (!live) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
      live = true; dragging = true;
      cardEl.classList.add('is-dragging');
      try { cardEl.setPointerCapture(pid); } catch { /* older browsers */ }
    }
    const over = document.elementsFromPoint(ev.clientX, ev.clientY)
      .find((el2) => el2 !== cardEl && el2.parentElement === grid
                  && el2.classList && el2.classList.contains('g-card'));
    if (!over) return;
    const r = over.getBoundingClientRect();
    // RTL grid: within a row, "earlier" is to the RIGHT; across rows, above.
    const sameRow = ev.clientY >= r.top && ev.clientY <= r.bottom;
    const before = sameRow ? ev.clientX > r.left + r.width / 2 : ev.clientY < r.top;
    const target = before ? over : over.nextSibling;
    if (target !== cardEl && cardEl.nextSibling !== target) grid.insertBefore(cardEl, target);
  };

  const up = (ev) => {
    if (ev.pointerId !== pid) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!live) return;
    cardEl.classList.remove('is-dragging');
    dragging = false;
    commitOrder();
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// Renumber to index*10 spacing from the dropped DOM order; write ONLY the
// rows whose sort actually changed. The arrangement is shared board state.
async function commitOrder() {
  const ids = [...$('grid').querySelectorAll('.g-card')].map((el2) => el2.dataset.id);
  const byId = new Map(posts.map((p) => [String(p.id), p]));
  const shown = ids.map((id) => byId.get(String(id))).filter(Boolean);
  const changed = [];
  // The visible cards keep the set of sort slots they already held; only WHICH
  // card sits in which slot changes. On the full board that is the old
  // index*10 renumber; inside a category it leaves every other category's
  // positions exactly where they were.
  const slots = shown.map((p) => Number(p.sort))
    .map((n) => (Number.isFinite(n) ? n : null));
  const usable = slots.every((n) => n !== null) && new Set(slots).size === slots.length;
  const targets = usable
    ? slots.slice().sort((a, b) => a - b)
    : shown.map((_, i) => (i + 1) * 10);
  shown.forEach((p, i) => {
    const want = targets[i];
    if (Number(p.sort) !== want) { p.sort = want; changed.push({ id: p.id, sort: want }); }
  });
  if (!changed.length) return;
  try {
    await ensureName();
    await savePostOrder(changed);
    toast('הסידור נשמר לכולם ✓', 'ok');
  } catch (err) {
    toast(`הסידור לא נשמר: ${err && err.message || err}`, 'err');
    refresh(false); // fall back to the shared truth
  }
}

/* ── versions (v1.7) ─────────────────────────────────────────────────
   A post is "edited" once the board holds a version snapshot for it, or once
   any of its slides carries a `design` override — either way its rendered PNG
   is stale, so the card composes slide 0 live instead of showing the PNG. */

function studioVnum(p) {
  const n = parseInt(String(p && p.version || '').replace(/^v/i, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function hasDesign(p) {
  return Array.isArray(p.slides)
    && p.slides.some((s) => s && s.design && Object.keys(s.design).length > 0);
}

function isEdited(p) {
  return (versions.get(p.id) || []).length > 0 || hasDesign(p);
}

function latestVnum(p) {
  const rows = versions.get(p.id) || [];
  return rows.length ? Number(rows[0].vnum) : studioVnum(p);
}

// Which slide 0 this card should show right now: the live shared state, or a
// snapshot the viewer picked. 'studio' means "the original render" — no slide,
// the static PNG stands in for it, which is exactly what it is.
function coverSlide(p) {
  const sel = viewing.get(p.id);
  if (sel === 'studio') return null;
  if (sel != null) {
    const row = (versions.get(p.id) || []).find((r) => Number(r.vnum) === Number(sel));
    return row && Array.isArray(row.slides) ? (row.slides[0] || null) : null;
  }
  return (Array.isArray(p.slides) && p.slides[0]) || null;
}

/* ── live covers: lazy, capped, released on scroll ──────────────────── */
// 119 cards on this board. The rules that keep that survivable:
//   · ONLY edited posts ever get an iframe; everyone else stays an <img>
//   · nothing composes until it is near the viewport (nearObs)
//   · at most LIVE_INFLIGHT composes run at once, the rest queue
//   · at most LIVE_CAP iframes exist at once (furthest-from-viewport evicted)
//   · a cover that drifts far outside the viewport is unmounted (farObs)
const LIVE_INFLIGHT = 4;
const LIVE_CAP = 12;
const RELEASE_PX = 700;   // distance past the viewport at which a cover is dropped

const liveCovers = new Set();  // cover elements with a mounted iframe
const liveQueue = [];          // cover elements waiting for a compose slot
let liveRunning = 0;
let composePromise = null;

function ensureCompose() {
  if (!composePromise) {
    composePromise = initCompose(assetUrl);
    composePromise.catch(() => { composePromise = null; }); // allow a retry
  }
  return composePromise;
}

const nearObs = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) enqueueLive(e.target);
}, { rootMargin: '250px 0px' });

const farObs = new IntersectionObserver((entries) => {
  for (const e of entries) if (!e.isIntersecting) unmountLive(e.target);
}, { rootMargin: `${RELEASE_PX}px 0px` });

// The reviewer can scroll a card out of range WHILE its compose is in flight;
// farObs has already fired by then and will not fire again, so the finished
// mount has to check for itself instead of parking an iframe off-screen.
function outOfRange(cover) {
  const r = cover.getBoundingClientRect();
  return r.top > window.innerHeight + RELEASE_PX || r.bottom < -RELEASE_PX;
}

function watchCover(cover) { nearObs.observe(cover); farObs.observe(cover); }

function enqueueLive(cover) {
  if (cover.__live || cover.__queued || !cover.__slide) return;
  cover.__queued = true;
  liveQueue.push(cover);
  pumpLive();
}

function pumpLive() {
  while (liveRunning < LIVE_INFLIGHT && liveQueue.length) {
    const cover = liveQueue.shift();
    cover.__queued = false;
    // scrolled away while it waited for a slot — nearObs re-enqueues it if it
    // comes back, so dropping it here just saves a compose nobody would see
    if (!cover.isConnected || cover.__live || !cover.__slide || outOfRange(cover)) continue;
    liveRunning++;
    mountLive(cover).catch(() => {}).then(() => { liveRunning--; pumpLive(); });
  }
}

async function mountLive(cover) {
  const slide = cover.__slide;
  if (!slide) return;
  try { await ensureCompose(); } catch { return; } // no engine -> the PNG stands
  if (!cover.isConnected || cover.__live) return;
  evictLive(cover);
  const box = h('div', { class: 'g-live' });
  cover.appendChild(box);
  await mountSlide(box, slide);
  if (!cover.isConnected || outOfRange(cover)) { box.remove(); return; }
  cover.classList.add('is-live');
  cover.__live = true;
  liveCovers.add(cover);
}

function unmountLive(cover) {
  if (!cover.__live) return;
  const box = cover.querySelector('.g-live');
  if (box) box.remove(); // drops the iframe; compose.js's mount entry goes with it
  cover.classList.remove('is-live');
  cover.__live = false;
  liveCovers.delete(cover);
}

// Furthest-from-viewport-centre eviction, so the cap never steals the frame
// the reviewer is actually looking at.
function evictLive(keep) {
  const mid = window.innerHeight / 2;
  while (liveCovers.size >= LIVE_CAP) {
    let worst = null; let worstD = -1;
    for (const c of liveCovers) {
      if (c === keep) continue;
      const r = c.getBoundingClientRect();
      const d = Math.abs((r.top + r.bottom) / 2 - mid);
      if (d > worstD) { worstD = d; worst = c; }
    }
    if (!worst) return;
    unmountLive(worst);
  }
}

// Called before the grid's children are replaced: release every iframe and
// stop watching covers that are about to be thrown away.
function releaseLive() {
  for (const cover of [...liveCovers]) unmountLive(cover);
  for (const cover of liveQueue) cover.__queued = false;
  liveQueue.length = 0;
  nearObs.disconnect();
  farObs.disconnect();
}

function dropCover(cover) {
  if (!cover) return;
  unmountLive(cover);
  nearObs.unobserve(cover);
  farObs.unobserve(cover);
}

/* ── version badge + dropdown ── */
function versionBadge(p) {
  const sel = viewing.get(p.id);
  const shown = sel == null ? latestVnum(p) : (sel === 'studio' ? studioVnum(p) : Number(sel));
  return h('button', {
    class: `tag g-ver${sel == null ? '' : ' g-ver--past'}`,
    type: 'button', 'aria-haspopup': 'true', title: 'גרסאות הפוסט',
    onclick: (e) => {
      e.preventDefault(); e.stopPropagation();
      toggleVersions(e.currentTarget.closest('.g-card'), p);
    },
  }, h('span', { class: 'g-ver__n' }, `v${shown}`), h('span', { class: 'g-ver__caret' }, '▾'));
}

function toggleVersions(cardEl, p) {
  const wasOpen = openMenu && openMenu.parentElement === cardEl && openMenu.dataset.kind === 'ver';
  closeMenu();
  if (wasOpen || !cardEl) return;
  const rows = versions.get(p.id) || [];
  const sel = viewing.get(p.id) ?? null;
  const sv = studioVnum(p);

  const item = (on, label, meta, onpick) => h('button', {
    class: `g-verlist__item${on ? ' is-on' : ''}`, type: 'button',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); onpick(); },
  }, h('b', {}, label), meta ? h('span', { class: 'g-verlist__meta' }, meta) : null);

  const items = rows.map((r, i) => {
    const n = Number(r.vnum);
    const current = i === 0; // newest snapshot == what the board is showing
    const meta = [current ? 'הגרסה הנוכחית' : null, r.author || null, fmtDate(r.created_at)]
      .filter(Boolean).join(' · ');
    return item(sel == null ? current : sel === n, `v${n}`, meta,
      () => pickVersion(p, current ? null : n));
  });
  // The studio base always closes the list: it IS the rendered PNG.
  items.push(item(sel === 'studio' || (sel == null && !rows.length),
    `גרסת הסטודיו v${sv}`, 'הרינדור המקורי',
    () => pickVersion(p, rows.length || hasDesign(p) ? 'studio' : null)));

  openMenu = h('div', {
    class: 'g-pop g-verlist', dataset: { kind: 'ver' },
    onclick: (e) => e.stopPropagation(),
  }, h('label', {}, 'גרסאות'), ...items);
  cardEl.appendChild(openMenu);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// View state only — never touches the board, and post.html always opens the
// current state regardless of what this card is previewing.
function pickVersion(p, v) {
  if (v == null) viewing.delete(p.id); else viewing.set(p.id, v);
  closeMenu();
  const grid = $('grid');
  const cardEl = [...grid.children].find((c) => c.dataset && c.dataset.id === String(p.id));
  if (!cardEl) return;
  dropCover(cardEl.querySelector('.g-cover'));
  cardEl.replaceWith(card(p));
}

/* ── grid ── */
function renderGrid() {
  closeMenu();
  releaseLive();
  renderArrangeBtn();
  const grid = $('grid');
  if (!posts.length) {
    grid.replaceChildren(h('div', { class: 'g-empty' },
      h('p', {}, 'הלוח עדיין ריק — הפוסטים בדרך.')));
    return;
  }
  const list = sortPosts(posts.filter((p) => matches(p)));
  if (!list.length) {
    grid.replaceChildren(h('div', { class: 'g-empty' },
      h('p', {}, 'שום פוסט לא עונה לסינון הזה. אולי לנקות את המסננים ולנסות שוב?'),
      h('button', { class: 'btn btn--ghost', type: 'button', onclick: clearFilters }, 'ניקוי מסננים')));
    return;
  }
  grid.replaceChildren(...list.map(card));
}

function clearFilters() {
  filters.cat = 'all'; filters.stage = 'all'; filters.q = '';
  $('search').value = '';
  renderAll();
}

function card(p) {
  const a = agg.get(p.id) || { yes: 0, no: 0, maybe: 0, mine: null, discuss: 0 };
  const mineCls = a.mine ? ` g-card--mine-${a.mine}` : '';

  // cover — slide 1, lazy; builder posts without renders get a placeholder
  const cover = h('div', { class: 'g-cover' },
    h('div', { class: 'g-cover__ph' }, '🖼️'));
  if (p.asset_prefix) {
    cover.prepend(h('img', {
      src: slideUrl(p, 0), alt: '', loading: 'lazy', decoding: 'async',
      onerror: () => cover.classList.add('is-broken'),
    }));
  } else {
    cover.classList.add('is-broken');
  }

  // Edited post: the PNG is stale, so slide 0 gets composed live over it (the
  // PNG stays underneath as the placeholder until the compose lands). Nothing
  // mounts here — watchCover hands the card to the lazy queue.
  const edited = isEdited(p);
  const viewingOld = viewing.has(p.id);
  if (edited) {
    cover.__slide = coverSlide(p);
    cover.classList.add('g-cover--edited');
    if (cover.__slide) watchCover(cover);
  }
  if (viewingOld) {
    cover.appendChild(h('div', { class: 'g-verhint' },
      h('span', {}, 'צופים בגרסה קודמת'),
      h('button', {
        class: 'g-verhint__reset', type: 'button',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); pickVersion(p, null); },
      }, 'חזרה לנוכחית')));
  }

  const tally = h('span', { class: 'g-meta__votes' },
    ['yes', 'no', 'maybe'].map((v) =>
      h('span', { class: a[v] ? '' : 'is-zero', title: VOTE_LABELS[v] }, `${voteGlyph(v)} ${a[v]}`)));

  // Edited posts trade the flat version tag for the interactive badge (one
  // version marker per card, never two disagreeing numbers).
  const version = p.version == null ? null
    : (/^v/i.test(String(p.version)) ? String(p.version) : `v${p.version}`);

  const tags = [
    CATEGORY_LABELS[p.category] ? h('span', { class: 'tag' }, CATEGORY_LABELS[p.category]) : null,
    STAGE_LABELS[p.stage] ? h('span', { class: 'tag' }, STAGE_LABELS[p.stage]) : null,
    edited ? versionBadge(p) : (version ? h('span', { class: 'tag' }, version) : null),
    p.origin === 'builder' && p.category !== 'builder'
      ? h('span', { class: 'tag' }, 'נבנה בכלי') : null,
  ];

  const menuBtn = h('button', {
    class: 'g-menu-btn', type: 'button', 'aria-label': 'שינוי שלב',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(e.currentTarget.closest('.g-card'), p); },
  }, '⋯');

  return h('article', { class: `card g-card${mineCls}`, dataset: { id: p.id } },
    cover,
    h('a', { class: 'g-title', href: postLink(p.id) }, p.title || 'ללא כותרת'),
    h('div', { class: 'g-tags' }, tags),
    h('div', { class: 'g-meta' },
      tally,
      h('span', { title: 'הערות ותגובות' }, `💬 ${a.discuss}`),
      h('span', {}, slideCountLabel(p.slide_count ?? (p.slides ? p.slides.length : 0))),
      filters.sort === 'activity' && a.last
        ? h('span', { class: 'g-when', title: 'פעילות אחרונה' }, fmtDate(a.last))
        : null),
    menuBtn);
}

function slideCountLabel(n) {
  n = Number(n) || 0;
  if (n === 1) return 'שקף אחד';
  return `${n} שקפים`;
}

/* ── overflow menu: quick stage triage (the ONE stage control on this page) ── */
let openMenu = null;
function closeMenu() {
  if (openMenu) { openMenu.remove(); openMenu = null; }
  document.removeEventListener('click', onDocClick, true);
}
function onDocClick(e) {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}
function toggleMenu(cardEl, p) {
  const wasOpen = openMenu && openMenu.parentElement === cardEl;
  closeMenu();
  if (wasOpen || !cardEl) return;
  const sel = h('select', {
    onchange: async (e) => {
      const stage = e.target.value;
      if (!stage || stage === p.stage) { closeMenu(); return; }
      try {
        await ensureName();
        await setStage(p.id, stage);
        p.stage = stage;
        toast(`השלב עודכן: ${STAGE_LABELS[stage] || stage}`, 'ok');
        closeMenu();
        renderAll();
      } catch (err) {
        toast(`השינוי לא נשמר: ${err && err.message || err}`, 'err');
      }
    },
  }, STAGES.map((s) => h('option', { value: s.key, selected: p.stage === s.key }, s.label)));
  openMenu = h('div', { class: 'g-pop', onclick: (e) => e.stopPropagation() },
    h('label', {}, 'שנה שלב'), sel);
  cardEl.appendChild(openMenu);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

/* ── skeleton while loading ── */
function renderSkeleton() {
  $('grid').replaceChildren(...Array.from({ length: 8 }, () =>
    h('article', { class: 'card g-card g-skel', 'aria-hidden': 'true' },
      h('div', { class: 'g-cover' }),
      h('div', { class: 'g-sk-line' }),
      h('div', { class: 'g-sk-line g-sk-line--short' }))));
}
