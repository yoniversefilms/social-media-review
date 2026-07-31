// index.js — gallery (board home). Owner: gallery agent.
// Contract: PLAN.md — store.js is the only network module; ui.js supplies
// the shared widgets (el, navBar, toast, voteGlyph, stage/category tables).
import {
  initStore, whoAmI, ensureName, slideUrl,
  listPosts, listVotes, latestVotes, listAllPins,
  setStage, subscribe,
} from './store.js';
import {
  el as h, navBar, toast, voteGlyph,
  STAGES, CATEGORIES, STAGE_LABELS, CATEGORY_LABELS,
} from './ui.js';

const VOTE_LABELS = { yes: 'בעד', no: 'נגד', maybe: 'מתלבטים' };

/* ── state ── */
let board = null;                 // {board_key, name, local} from initStore()
let me = { name: '', author_id: '' };
let posts = [];
let agg = new Map();              // post_id -> {yes,no,maybe,mine,discuss}
const filters = { cat: 'all', stage: 'all', sort: 'new', q: '' };
let refreshing = false;

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
  if (refreshing) return; refreshing = true;
  try {
    const [p, voteRows, pinRows] = await Promise.all([listPosts(), listVotes(), listAllPins()]);
    posts = p || [];
    me = safeWho();
    agg = aggregate(posts, voteRows || [], pinRows || []);
    renderAll();
  } catch (err) {
    if (first) {
      $('grid').replaceChildren(h('div', { class: 'g-empty' },
        h('p', {}, 'משהו השתבש בטעינת הלוח. נסו לרענן את הדף.'),
        h('p', { style: 'font-size:.85rem;opacity:.7' }, String(err && err.message || err))));
    }
  } finally { refreshing = false; }
}

function aggregate(postRows, voteRows, pinRows) {
  const byPost = latestVotes(voteRows); // Map post_id -> Map author -> {vote,reason,created_at}
  const out = new Map();
  for (const p of postRows) {
    const a = { yes: 0, no: 0, maybe: 0, mine: null, discuss: 0 };
    const authors = byPost.get(p.id);
    if (authors) {
      for (const [author, v] of authors) {
        if (a[v.vote] !== undefined) a[v.vote]++;
        if (author === me.author_id || (me.name && author === me.name)) a.mine = v.vote;
      }
    }
    out.set(p.id, a);
  }
  for (const pin of pinRows) {
    const a = out.get(pin.post_id);
    if (!a) continue;
    a.discuss += 1 + (Number(pin.reply_count ?? 0) || 0);
  }
  return out;
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
  $('sort').addEventListener('change', (e) => { filters.sort = e.target.value; renderGrid(); });
  let deb;
  $('search').addEventListener('input', (e) => {
    clearTimeout(deb);
    deb = setTimeout(() => { filters.q = e.target.value.trim(); renderAll(); }, 150);
  });
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
function sortPosts(list) {
  const s = filters.sort;
  const n = (id, k) => agg.get(id)?.[k] || 0;
  const arr = [...list];
  if (s === 'yes') arr.sort((a, b) => n(b.id, 'yes') - n(a.id, 'yes') || byNew(a, b));
  else if (s === 'no') arr.sort((a, b) => n(b.id, 'no') - n(a.id, 'no') || byNew(a, b));
  else if (s === 'talk') arr.sort((a, b) => n(b.id, 'discuss') - n(a.id, 'discuss') || byNew(a, b));
  else if (s === 'unvoted') arr.sort((a, b) => (agg.get(a.id)?.mine ? 1 : 0) - (agg.get(b.id)?.mine ? 1 : 0) || byNew(a, b));
  else arr.sort(byNew);
  return arr;
}

/* ── grid ── */
function renderGrid() {
  closeMenu();
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

  const tally = h('span', { class: 'g-meta__votes' },
    ['yes', 'no', 'maybe'].map((v) =>
      h('span', { class: a[v] ? '' : 'is-zero', title: VOTE_LABELS[v] }, `${voteGlyph(v)} ${a[v]}`)));

  const version = p.version == null ? null
    : (/^v/i.test(String(p.version)) ? String(p.version) : `v${p.version}`);

  const tags = [
    CATEGORY_LABELS[p.category] ? h('span', { class: 'tag' }, CATEGORY_LABELS[p.category]) : null,
    STAGE_LABELS[p.stage] ? h('span', { class: 'tag' }, STAGE_LABELS[p.stage]) : null,
    version ? h('span', { class: 'tag' }, version) : null,
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
      h('span', {}, slideCountLabel(p.slide_count ?? (p.slides ? p.slides.length : 0)))),
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
