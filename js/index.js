// index.js — gallery (board home). Owner: gallery agent.
// Contract: PLAN.md — store.js is the only network module; ui.js supplies
// the shared widgets (el, navBar, toast, voteGlyph, stage/category tables).
//
// v2.13 (spec 13) gives the gallery its first BULK surface: «בחירה» turns the
// grid into a picker, and a selection can be deleted (softly, undoable),
// hidden, downloaded as a zip of slide PNGs, or sent for review with one date.
// The same four actions live on each card's ⋯ menu for a single post. The
// category tabs also became hideable board-wide (sm_prefs, migration 031).
import {
  initStore, whoAmI, ensureName, slideUrl, assetUrl,
  listPosts, listVotes, latestVotes, listAllPins, listAllVersions,
  listAllApprovals, approvalState, getRole,
  setStage, savePostOrder, subscribe,
  // v2.5 (spec 08) — the author shelf. PURE helper: it just groups the posts
  // this page already has, so the filter costs no request.
  authorShelf,
  // v2.13 (spec 13) — the four bulk verbs and the board preference store.
  deletePosts, restorePosts, hidePosts, unhidePosts, setReviewAt,
  getPref, setPref,
} from './store.js';
import { initCompose, mountSlide } from './compose.js';
import {
  el as h, navBar, toast, modal, voteGlyph, fmtDate, fmtWhen,
  undoToast, UNDO_MS, toLocalInput, fromLocalInput,
  STAGES, CATEGORIES, STAGE_LABELS, CATEGORY_LABELS, categoryLabel,
} from './ui.js';
// The same STORE-method writer the assets page zips exports with. Reused, not
// re-implemented: a second zip writer is a second set of edge cases (UTF-8
// names, the 4GB refusal) to keep in step.
import { zipStore } from './zip.js';

const VOTE_LABELS = { yes: 'בעד', no: 'נגד', maybe: 'מתלבטים' };

/* ── state ── */
let board = null;                 // {board_key, name, local} from initStore()
let me = { name: '', author_id: '' };
/* v2.13 — TWO POOLS, ONE FETCH.
   `allPosts` is every LIVE row the board has (the store always drops deleted).
   `posts` is the DEFAULT pool: allPosts minus the individually hidden ones.

   The split exists because a COUNT and a VIEW want different answers. Every
   number the toolbar shows — the chip counts, the stage tabs, the author shelf,
   the progress strip — reads `posts`, so a hidden post can never be silently
   counted in the gallery a reviewer is looking at. Only two things read
   `allPosts`: the «מוסתרים» grid (which exists to show them) and the
   manage-tabs popover (a category whose every post is hidden must still be
   listed, or it can never be unhidden).

   ONE request either way: listPosts({includeHidden:true}) is fetched once per
   refresh and split here, rather than re-fetching when the view flips. */
let allPosts = [];                // every row we know about, stamps and all
let posts = [];                   // DERIVED: allPosts minus deleted minus hidden
let agg = new Map();              // post_id -> {yes,no,maybe,mine,discuss,last}
let versions = new Map();         // post_id -> [sm_post_versions row] vnum desc
let approvalsByPost = new Map();  // post_id -> [sm_approvals row] (v2.3)
let waitingOnly = false;          // «ממתינים לאישור שיווק» toggle (v2.3, plan §7)
const viewing = new Map();        // post_id -> vnum | 'studio' (per-card VIEW state only)
// `author` (v2.5, spec 08) is a fourth filter, composed with the other three:
// 'all' or an exact sm_posts.author string. Posts with no author (everything
// the studio shipped) are only ever hidden by picking a name — they are never
// a bucket of their own, because "no author" is not a shelf.
const filters = { cat: 'all', stage: 'all', sort: 'manual', q: '', author: 'all' };
let refreshing = false;
let arranging = false;            // «🔓 סידור חופשי» unlocked (manual sort, no filters)
let dragging = false;             // a card is mid-drag right now
let lastDigest = '';              // gates refresh-driven re-renders (see stateDigest)

/* ── v2.13 selection + hidden posts + hidden tabs ────────────────────
   `selIds` holds post IDS, never rows: a re-render (the 10s poll builds fresh
   card elements) must not drop the selection, and ids are the one thing that
   survives it. card() reads this Set back, so re-applying the ticks costs
   nothing and cannot drift from the bar's count.

   It CLEARS on any filter/tab/search/view change. Not a nicety: a selection
   that silently spans views is how someone deletes a post they cannot see, and
   «בחירת הכול» would then mean two different things depending on history. */
let selMode = false;
const selIds = new Set();         // selected post ids
let lastListIds = [];             // ids the grid is showing right now, in order
// The «מוסתרים» VIEW. It is the ONLY caller that passes includeHidden — every
// other surface on this board inherits the store's filter and never sees a
// hidden post at all.
let showHidden = false;
// Board-wide hidden category tabs (sm_prefs key 'hidden_categories'). A LIST of
// category strings, and membership is computed at render time — no post row is
// ever stamped for a tab, which is what makes unhiding a tab free and keeps
// tab management from touching updated_at on 40 posts.
let hiddenTabs = new Set();
let prefsWritable = true;         // false once a setPref refused (unapplied 031)

const $ = (id) => document.getElementById(id);

/* ui.js's el() drops null/undefined/false children; Element.replaceChildren()
   does NOT — it stringifies them, so a `cond ? el(…) : null` member renders the
   literal text «null» between the buttons. Screenshot-proven on the selection
   bar in every state where one of the two hide buttons was absent. Every
   replaceChildren call that can receive a conditional member goes through this. */
const kids = (...list) => list.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);

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
  // §7 — declared-not-enforced: ON by default for the marketing hat at load,
  // available to everyone regardless (a therapist/no-role reviewer can still
  // click it). Never re-checked after boot — a role change mid-session does
  // not silently flip a toggle the reviewer may have set deliberately.
  waitingOnly = getRole() === 'marketing';
  // v2.8 (operator-final): nav pinned on top; the filter toolbar sits under
  // it behind a one-line toggle strip — the toggle is the only control, no
  // scroll behaviour. See wireToolbarFold().
  $('nav').replaceChildren(navBar('index'));
  wireToolbar();
  wireToolbarFold();
  // The hidden-tab list rides refresh()'s own Promise.all (see there), so the
  // first render already has it and every poll tick re-reads it.
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
    // listAllApprovals() rides alongside listAllVersions() — ONE extra
    // request for the whole board, never per-card (plan §7).
    // ONE fetch, both pools. includeHidden is passed unconditionally here and
    // the split happens below — flipping the «מוסתרים» view must not cost a
    // round trip, and two different fetch shapes would make the toolbar counts
    // depend on which view was last open. Every OTHER module on this board
    // calls listPosts() with no argument and never sees a hidden post at all,
    // so the queue's schedule pool and the translate/plan counts needed no edit.
    const fetchStartedAt = Date.now();
    const [p, voteRows, pinRows, verRows, apprRows, prefVal] = await Promise.all([
      listPosts({ includeHidden: true }),
      listVotes(), listAllPins(), listAllVersions().catch(() => []),
      listAllApprovals().catch(() => []),
      // One cheap extra request per tick, beside the five already here. It is
      // what turns tab-hiding from reload-only into ≤10s propagation.
      getPref(PREF_HIDDEN_TABS).catch(() => null),
    ]);
    // A stamp made while THIS fetch was already on the wire is re-applied on
    // top of the response: see pendingStamps.
    allPosts = replayPendingStamps(p || [], fetchStartedAt, allPosts);
    derivePools();
    // sm_prefs is not carried by realtime for a header-scoped anon subscriber
    // (measured: SUBSCRIBED, zero events), so the hidden-tab list rides this
    // poll like everything else. null means «unset OR unreadable» — an
    // unapplied 031 answers null, and silently un-hiding every tab because one
    // read failed would be worse than showing a slightly stale set.
    if (Array.isArray(prefVal)) {
      hiddenTabs = new Set(prefVal.map((k) => String(k)).filter(Boolean));
    }
    // A poll can take a post out from under a live selection (someone else
    // deleted it, or it left the filter). Keeping its id would let the bar
    // count and act on a row that is not on the board any more.
    pruneSelection();
    me = safeWho();
    // Tallies are built over the FULL pool: a hidden post still shows its votes
    // and its 💬 count inside the «מוסתרים» view, which is where someone decides
    // whether to bring it back.
    agg = aggregate(allPosts, voteRows || [], pinRows || []);
    versions = groupVersions(verRows || []);
    approvalsByPost = groupApprovals(apprRows || []);
    // A poll that changed nothing must NOT rebuild the grid: re-rendering
    // tears down every live-composed cover and re-mounts it. And an open
    // popup means the reviewer is mid-interaction — leave the DOM alone and
    // let the next refresh (digest still unrecorded) pick the change up.
    // Over the FULL pool, not the default one: in the «מוסתרים» view the rows on
    // screen are precisely the ones `posts` excludes, so a default-pool digest
    // would leave that view frozen while another profile edits what it shows.
    // hiddenTabs joins the digest: a tab hidden by another profile changes
    // sm_prefs and NOTHING in sm_posts, so a posts-only digest would re-read the
    // preference every tick and never repaint the chips.
    const d = stateDigest(allPosts, voteRows, pinRows, verRows, apprRows) +
      '#tabs:' + [...hiddenTabs].sort().join(',');
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

// post_id -> [sm_approvals row] (v2.3). Order doesn't matter here —
// approvalState() finds the latest by created_at itself.
function groupApprovals(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || !r.post_id) continue;
    if (!out.has(r.post_id)) out.set(r.post_id, []);
    out.get(r.post_id).push(r);
  }
  return out;
}

// Cheap fingerprint of everything the grid draws. sm_posts.updated_at is
// bumped by every PATCH in BOTH drivers, so it covers slide edits too.
//
// v2.13 adds hidden_at and deleted_at EXPLICITLY rather than leaning on
// updated_at to carry them. Today the touch trigger does bump on a stamp, so
// this is belt-and-braces — but the digest is the only thing standing between
// «another profile unhid a post» and a grid that never re-renders, and that
// promise must not rest on a trigger this file cannot see. Naming the two
// columns makes the dependency explicit instead of implicit.
function stateDigest(postRows, voteRows, pinRows, verRows, apprRows) {
  const tail = (rows) => {
    let n = 0; let last = '';
    for (const r of rows || []) { n++; const c = String(r.created_at || ''); if (c > last) last = c; }
    return `${n}:${last}`;
  };
  let replies = 0;
  for (const r of pinRows || []) replies += Number(r.reply_count ?? 0) || 0;
  const p = (postRows || []).map((x) =>
    `${x.id}|${x.sort}|${x.stage}|${x.category}|${x.version}|${x.updated_at}|${x.title}` +
    `|${x.hidden_at || ''}|${x.deleted_at || ''}`).join('~');
  return `${p}#${tail(voteRows)}#${tail(pinRows)}/${replies}#${tail(verRows)}#${tail(apprRows)}`;
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
    deb = setTimeout(() => {
      filters.q = e.target.value.trim();
      clearSelection();          // v2.13: the view changed under the selection
      renderAll();
    }, 150);
  });
  $('arrange').addEventListener('click', () => setArranging(!arranging));
  $('select').addEventListener('click', () => setSelecting(!selMode));
  $('hidview').addEventListener('click', () => setHiddenView(!showHidden));
  wireArrange();
}

/* ── v2.13 modes: selection, arranging, and the hidden view ──────────
   Three things the gallery can BE, and at most one at a time. Arranging drags
   cards; selecting swallows the same clicks to tick them; the hidden view is a
   different set of rows entirely. Any pair of them at once is a grid where a
   click means two things, so entering one always leaves the others. */

function setSelecting(on) {
  selMode = !!on;
  if (selMode && arranging) setArranging(false);
  if (!selMode) selIds.clear();
  const btn = $('select');
  btn.classList.toggle('is-on', selMode);
  btn.textContent = selMode ? '✕ יציאה מבחירה' : '☑︎ בחירה';
  $('grid').classList.toggle('is-selecting', selMode);
  document.body.classList.toggle('is-selecting', selMode);
  renderGrid();
  renderSelBar();
}

function setHiddenView(on) {
  showHidden = !!on;
  if (showHidden && arranging) setArranging(false);
  // The waiting-on-marketing view is its own stage filter and it composes with
  // everything (plan §7) — including this. It is ON by default for the
  // marketing hat, so leaving it would open «מוסתרים» on an empty grid that
  // reads as «nothing is hidden». The hidden view is about visibility, not
  // about signatures, so it takes precedence and turns the other one off.
  if (showHidden) waitingOnly = false;
  clearSelection();
  const btn = $('hidview');
  btn.classList.toggle('is-on', showHidden);
  btn.title = showHidden
    ? 'חזרה לגלריה הרגילה'
    : 'הצגת הפוסטים שהוסתרו, עם אפשרות להחזיר אותם';
  // A pure RE-RENDER, not a refetch: refresh() already pulled both pools in one
  // request, so flipping the lens costs nothing and cannot show a stale board.
  renderAll();
}

// Every filter/tab/search/view change funnels through here. One place, so a new
// filter added later cannot forget the rule.
function clearSelection() {
  if (!selIds.size) return;
  selIds.clear();
  renderSelBar();
}

// Ids that are no longer on the board (or no longer in this view) leave the
// selection. Called after every refresh.
function pruneSelection() {
  if (!selIds.size) return;
  // allPosts, not the default pool: a selection made inside «מוסתרים» is made
  // of rows `posts` deliberately excludes, and pruning against `posts` would
  // silently empty it on the next poll tick.
  const alive = new Set(allPosts.map((p) => String(p.id)));
  let changed = false;
  for (const id of [...selIds]) if (!alive.has(String(id))) { selIds.delete(id); changed = true; }
  if (changed) renderSelBar();
}

/* ── v2.13 in-memory stamps (fix B2) ─────────────────────────────────
   The four verbs used to DROP the acted-on rows from both pools. That made the
   client lie for up to one poll interval: hide three posts, open «מוסתרים»
   immediately, and the view said «אין פוסטים מוסתרים בלוח הזה» while three sat
   there server-side; unhide, and the gallery counts stayed reduced until the
   next tick. So the rows are STAMPED in place instead — exactly what assets.js
   does — and `derivePools()` re-seats their membership. One source of truth
   (allPosts), two derived views, no window in which they disagree.

   Deleted rows are excluded by the derivation rather than spliced out, so the
   undo restores them by nulling the stamp, with no refetch and no gap. A fresh
   fetch never returns them anyway (live() is unconditional in the store), so
   the two paths converge on the same answer. */
function derivePools() {
  posts = allPosts.filter((p) => p && !p.deleted_at && !p.hidden_at);
}

// Stamps that a request ALREADY ON THE WIRE cannot know about yet. Without
// this, a refresh whose fetch began before the PATCH landed returns the row
// un-stamped and resurrects a card the reviewer just deleted — for one tick,
// which is exactly long enough to click it again. Each entry is kept only until
// a fetch that STARTED AFTER the stamp lands; by then the server response is
// authoritative and the entry is dropped.
const pendingStamps = new Map();   // id -> { at, fields }

function recordStamp(ids, fields) {
  const at = Date.now();
  for (const id of ids) {
    const prev = pendingStamps.get(String(id));
    pendingStamps.set(String(id), { at, fields: { ...(prev && prev.fields), ...fields } });
  }
}

function replayPendingStamps(rows, fetchStartedAt, prev) {
  if (!pendingStamps.size) return rows;
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  for (const [id, e] of [...pendingStamps]) {
    // The fetch began after we stamped ⇒ the server saw it ⇒ the response is
    // the truth and the local override has done its job.
    if (e.at < fetchStartedAt) { pendingStamps.delete(id); continue; }
    const row = byId.get(id);
    if (row) { Object.assign(row, e.fields); continue; }
    // The row is ABSENT from a response that predates a RESTORE — the server
    // still had it deleted when this fetch was taken, and the store's
    // unconditional live() filter dropped it. Carry our own copy forward, or
    // the stale answer silently un-does the undo for a full poll interval.
    if (e.fields.deleted_at === null) {
      const kept = (prev || []).find((r) => String(r.id) === id);
      if (kept) { Object.assign(kept, e.fields); rows.push(kept); }
    }
  }
  return rows;
}

// One card's tick. It repaints IN PLACE rather than re-rendering the grid: a
// re-render tears down every live-composed cover and re-mounts it, which on a
// board of 150 posts turns ticking a box into a visible stall.
function toggleSelect(cardEl, force) {
  const id = cardEl.dataset && cardEl.dataset.id;
  if (!id) return;
  const on = force === undefined ? !selIds.has(String(id)) : !!force;
  if (on) selIds.add(String(id)); else selIds.delete(String(id));
  cardEl.classList.toggle('is-picked', on);
  const box = cardEl.querySelector('.g-pick input');
  if (box) box.checked = on;
  renderSelBar();
}

// The rows behind the ticked ids, in the order the grid is showing them — so
// the confirm modal, the zip and the failure report all read in the order the
// reviewer sees, not in Set insertion order.
function selectedPosts() {
  const want = new Set([...selIds].map(String));
  const byId = new Map(allPosts.map((p) => [String(p.id), p]));
  const out = [];
  for (const id of lastListIds) if (want.has(id) && byId.has(id)) out.push(byId.get(id));
  // Anything selected that has since left the visible list still belongs to the
  // selection until a filter change clears it — append it rather than silently
  // acting on fewer rows than the bar counted.
  for (const id of want) if (!lastListIds.includes(id) && byId.has(id)) out.push(byId.get(id));
  return out;
}

/* ── the selection bar (v2.13) ───────────────────────────────────────
   Fixed to the bottom of the window (index.html §v2.13): the filter toolbar
   folds, and an action bar that can be folded away mid-selection is a trap.

   «בחירת הכול» means the CURRENT FILTERED VIEW and nothing wider — the category
   chip, the stage tab, the author shelf, the search box and the «מוסתרים»
   toggle all still apply. A select-all that quietly reaches rows nobody looked
   at is how a bulk delete takes something it should not have. */
function renderSelBar() {
  const bar = $('selbar');
  if (!bar) return;
  if (!selMode) { bar.hidden = true; bar.replaceChildren(); return; }
  bar.hidden = false;

  const selectAll = h('button', {
    class: 'btn btn--ghost', type: 'button',
    title: 'בחירת כל הפוסטים שמוצגים כרגע, לפי הסינון הנוכחי',
    onclick: () => {
      for (const id of lastListIds) selIds.add(id);
      for (const el2 of $('grid').querySelectorAll('.g-card')) {
        el2.classList.add('is-picked');
        const box = el2.querySelector('.g-pick input');
        if (box) box.checked = true;
      }
      renderSelBar();
    },
  }, `בחירת הכול (${lastListIds.length})`);

  const rows = selectedPosts();
  if (!rows.length) {
    bar.replaceChildren(...kids(
      h('span', { class: 'g-selbar__n' }, 'לא נבחר עדיין אף פוסט'),
      selectAll));
    return;
  }

  // The two hide buttons are offered by what the selection ACTUALLY holds, so
  // neither ever appears as a no-op. In the default gallery nothing selected can
  // be hidden (the store filtered those rows out), so only «הסתרה» shows; inside
  // «מוסתרים» it is the other way round.
  const anyVisible = rows.some((p) => !p.hidden_at);
  const anyHidden = rows.some((p) => !!p.hidden_at);

  bar.replaceChildren(...kids(
    h('span', { class: 'g-selbar__n' }, `נבחרו ${rows.length}`),
    h('button', {
      class: 'btn btn--primary', type: 'button',
      onclick: () => downloadDialog(rows),
    }, '⬇︎ הורדה'),
    h('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: () => reviewDialog(rows),
    }, '👀 שליחה לבדיקה'),
    anyVisible
      ? h('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: () => setPostsHidden(rows.filter((p) => !p.hidden_at), true),
        }, '🙈 הסתרה')
      : null,
    anyHidden
      ? h('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: () => setPostsHidden(rows.filter((p) => !!p.hidden_at), false),
        }, '👁 ביטול הסתרה')
      : null,
    h('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: () => deleteDialog(rows),
    }, '🗑 מחיקה'),
    selectAll,
    h('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: () => {
        selIds.clear();
        for (const el2 of $('grid').querySelectorAll('.g-card.is-picked')) {
          el2.classList.remove('is-picked');
          const box = el2.querySelector('.g-pick input');
          if (box) box.checked = false;
        }
        renderSelBar();
      },
    }, 'ניקוי הבחירה'),
  ));
}

/* ── the four actions (v2.13, spec 13) ───────────────────────────────
   Each one takes a ROW ARRAY, so the per-card ⋯ menu and the selection bar call
   exactly the same code with one row or with thirty. That is the only way the
   single and bulk paths cannot drift — the v2.9 deleteDialog/moveDialog rule on
   the assets page, restated here. */

// Rows leave the current view immediately rather than after a refetch: an
// action that takes a round-trip to become visible reads as a failure, and the
// reviewer clicks it again.
// Stamp the acted-on rows in place, re-derive the pools, drop them from the
// selection (they have left the view they were acted on FROM), and converge
// with the server on the next tick. The `lastDigest` reset is what makes that
// tick actually re-render instead of comparing against a digest built before
// the stamp.
function applyStamp(ids, fields) {
  const want = new Set(ids.map(String));
  for (const p of allPosts) if (want.has(String(p.id))) Object.assign(p, fields);
  recordStamp(ids, fields);
  derivePools();
  for (const id of ids) selIds.delete(String(id));
  lastDigest = '';
  renderAll();
  // Converge with server truth. Cheap: the digest almost always matches, and
  // when it does not the grid was wrong and needed the repaint.
  refresh(false);
}

function deleteDialog(rows) {
  if (!rows.length) return;
  const ids = rows.map((p) => String(p.id));
  const secs = Math.round(UNDO_MS / 1000);
  const status = h('div', { class: 'g-bulk' });

  const run = async (close) => {
    status.textContent = 'מוחקים…';
    try {
      await deletePosts(ids);
    } catch (err) {
      status.textContent = '';
      // One sentence, and the SAME sentence whichever unapplied-031 failure the
      // server chose — store.js already collapsed them.
      toast((err && err.message) || 'המחיקה נכשלה', 'err');
      return;
    }
    if (close) close();
    applyStamp(ids, { deleted_at: new Date().toISOString(), deleted_by: me.name || '' });
    undoToast(
      rows.length === 1 ? 'הפוסט נמחק' : `${rows.length} פוסטים נמחקו`,
      async () => {
        try {
          await restorePosts(ids);
        } catch (err) {
          toast('השחזור נכשל: ' + ((err && err.message) || err), 'err');
          return;
        }
        // Nulling the stamp restores the rows AND everything derived from them
        // — the vote tallies, the progress strip, the chip counts — with no
        // refetch and no gap, because the rows never left allPosts. applyStamp
        // fires its own converging refresh behind the toast.
        applyStamp(ids, { deleted_at: null, deleted_by: null });
        toast(rows.length === 1 ? 'הפוסט שוחזר' : `${rows.length} פוסטים שוחזרו`, 'ok');
      });
  };

  modal(rows.length === 1 ? 'מחיקת פוסט' : `מחיקת ${rows.length} פוסטים`, h('div', null,
    h('p', {}, rows.length === 1
      ? 'הפוסט יֵצא מהגלריה, מהחיפוש, מהתזמון ומהספירות.'
      : `${rows.length} פוסטים יֵצאו מהגלריה, מהחיפוש, מהתזמון ומהספירות.`),
    // Said plainly, because it is what makes this safe to offer at all.
    h('p', { class: 'g-bulk' },
      `ההצבעות, ההערות והחתימות נשמרות ולא נמחקות. יהיה אפשר לבטל תוך ${secs} שניות.`),
    rows.length > 1
      ? h('ul', { class: 'g-bulklist' }, rows.slice(0, 12).map((p) =>
          h('li', {}, p.title || p.id)))
      : null,
    rows.length > 12 ? h('div', { class: 'g-bulk' }, `ועוד ${rows.length - 12}`) : null,
    status,
  ), { actions: [
    { label: 'ביטול' },
    { label: '🗑 מחיקה', primary: true, onClick: (c) => { run(c); return false; } },
  ] });
}

/* Hide has no confirm modal, deliberately. A confirm is the price of something
   you cannot take back; this is a toggle, and «מוסתרים» in the tools strip is
   the way home. Delete keeps its modal for exactly the opposite reason. */
async function setPostsHidden(rows, hide) {
  if (!rows.length) return;
  const ids = rows.map((p) => String(p.id));
  try {
    if (hide) await hidePosts(ids); else await unhidePosts(ids);
  } catch (err) {
    toast((err && err.message) || (hide ? 'ההסתרה נכשלה' : 'ביטול ההסתרה נכשל'), 'err');
    return;
  }
  // The stamp is what moves them: hiding takes them out of the gallery and INTO
  // «מוסתרים» in the same breath, unhiding does the reverse, and both are
  // visible the instant the PATCH resolves rather than at the next poll.
  applyStamp(ids, hide
    ? { hidden_at: new Date().toISOString(), hidden_by: me.name || '' }
    : { hidden_at: null, hidden_by: null });
  const n = rows.length;
  toast(hide
    ? (n === 1 ? 'הפוסט הוסתר · אפשר להחזיר אותו דרך «מוסתרים»' : `${n} פוסטים הוסתרו · אפשר להחזיר אותם דרך «מוסתרים»`)
    : (n === 1 ? 'הפוסט חזר לגלריה' : `${n} פוסטים חזרו לגלריה`), 'ok');
}

/* ── bulk download (v2.13) ───────────────────────────────────────────
   What comes down is the FACTORY RENDER of each slide — the PNGs the studio
   produced — because that is the only thing on this board that exists as
   finished pixels. A post edited on the board therefore downloads its PRE-EDIT
   frames. The single-post download modal on the post page says so; this says it
   ONCE PER BATCH rather than once per post, which at thirty posts would be a
   warning nobody reads.

   A builder post (no asset_prefix) was never rendered at all. It is skipped and
   NAMED in the report — an absent file the reviewer cannot account for is worse
   than a line of text. */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A post id is a filename here. Ids on this board are ASCII slugs, but a folder
// name is not the place to find out that one of them was not.
function safeSeg(s) {
  return String(s || 'post').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80) || 'post';
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadDialog(rows) {
  if (!rows.length) return;
  const withRenders = rows.filter((p) => p.asset_prefix);
  const skipped = rows.filter((p) => !p.asset_prefix);
  const status = h('div', { class: 'g-bulk' });
  let running = false;

  const run = async (close) => {
    if (running) return;
    if (!withRenders.length) {
      toast('לאף אחד מהפוסטים שנבחרו אין שקפים מוכנים להורדה', 'err');
      return;
    }
    running = true;
    const entries = [];
    const failed = [];
    let done = 0;
    for (const p of withRenders) {
      const total = slideTotalOf(p);
      for (let i = 0; i < total; i++) {
        try {
          const res = await fetch(slideUrl(p, i));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          entries.push({
            name: `${safeSeg(p.id)}/slide-${String(i + 1).padStart(2, '0')}.png`,
            data: await res.blob(),
          });
        } catch (err) {
          failed.push(`${p.title || p.id} · שקף ${i + 1}`);
        }
      }
      done++;
      status.textContent = `${done}/${withRenders.length} פוסטים הוכנו`;
    }
    if (!entries.length) {
      running = false;
      status.textContent = '';
      toast('לא הצלחנו להוריד אף שקף', 'err');
      return;
    }
    status.textContent = 'אורזים…';
    try {
      saveBlob(await zipStore(entries), `posts-${stamp()}.zip`);
    } catch (err) {
      running = false;
      status.textContent = '';
      toast('האריזה נכשלה: ' + ((err && err.message) || err), 'err');
      return;
    }
    if (close) close();
    // The report names what did NOT come down, in both of its flavours, and it
    // is the same toast whether one post or thirty were asked for.
    const notes = [];
    if (skipped.length) {
      notes.push(`${skipped.length} בלי שקפים מוכנים: ` +
        skipped.slice(0, 4).map((p) => p.title || p.id).join(', ') +
        (skipped.length > 4 ? ` ועוד ${skipped.length - 4}` : ''));
    }
    if (failed.length) notes.push(`${failed.length} שקפים לא ירדו`);
    toast(`הורדו ${entries.length} שקפים` + (notes.length ? ' · ' + notes.join(' · ') : ''),
      notes.length ? '' : 'ok');
    running = false;
  };

  modal(rows.length === 1 ? 'הורדת השקפים' : `הורדת השקפים של ${rows.length} פוסטים`, h('div', null,
    h('p', {}, 'תרד קובץ ZIP אחד, ובתוכו תיקייה לכל פוסט עם השקפים שלו כקובצי PNG.'),
    // ONCE per batch — the whole point of saying it here and not per post.
    h('p', { class: 'g-bulk' },
      'השקפים הם הרינדור המקורי של הסטודיו. אם ערכתם פוסט כאן בלוח, ההורדה תכיל את הפיקסלים שלפני העריכה.'),
    skipped.length
      ? h('div', null,
          h('div', { class: 'g-bulk' }, skipped.length === 1
            ? 'פוסט אחד לא ירד, כי אין לו שקפים מרונדרים:'
            : `${skipped.length} פוסטים לא ירדו, כי אין להם שקפים מרונדרים:`),
          h('ul', { class: 'g-bulklist' }, skipped.map((p) => h('li', {}, p.title || p.id))))
      : null,
    status,
  ), { actions: [
    { label: 'ביטול' },
    { label: '⬇︎ הורדה', primary: true, onClick: (c) => { run(c); return false; } },
  ] });
}

/* ── bulk send-for-review (v2.13) ────────────────────────────────────
   The bulk twin of the post page's «🗓️ תזמון → לבדיקה»: one date and one note
   for the whole selection, written to sm_posts.review_at / review_note through
   the existing setReviewAt(). Sequential rather than Promise.all, because a
   fan-out of thirty PATCHes at a therapist's hotel wifi is how a partial write
   happens quietly — this way the progress line is honest and a failure names
   the posts it did not reach. */
function reviewDialog(rows) {
  if (!rows.length) return;
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  tomorrow.setMinutes(0, 0, 0);
  const when = h('input', {
    class: 'field__input', type: 'datetime-local',
    value: toLocalInput(tomorrow.toISOString()),
  });
  const note = h('input', {
    class: 'field__input', type: 'text', maxlength: '140',
    placeholder: 'על מה לשים לב בבדיקה (לא חובה)',
  });
  const status = h('div', { class: 'g-bulk' });
  const problems = h('ul', { class: 'g-bulklist', hidden: true });
  let running = false;

  const run = async (close) => {
    if (running) return;
    const iso = fromLocalInput(when.value);
    if (!iso) { status.textContent = 'צריך לבחור תאריך ושעה'; when.focus(); return; }
    running = true;
    const text = note.value.trim();
    const failed = [];
    let ok = 0;
    problems.hidden = true;
    problems.replaceChildren();
    for (const p of rows) {
      try {
        await setReviewAt(p.id, iso, text);
        // Keep the in-memory row honest so the 👀 tag appears without waiting
        // for the next poll.
        p.review_at = iso;
        p.review_note = text;
        ok++;
      } catch (err) {
        failed.push(`${p.title || p.id}: ${(err && err.message) || err}`);
      }
      status.textContent = `${ok + failed.length}/${rows.length} עודכנו`;
    }
    running = false;
    if (failed.length) {
      // The dialog STAYS OPEN on a partial failure, listing exactly which posts
      // did not get the date. Closing it and toasting «חלק נכשלו» would leave
      // the reviewer with no way to find out which.
      problems.hidden = false;
      problems.replaceChildren(...kids(failed.slice(0, 12).map((t) => h('li', {}, t))));
      status.textContent = `${ok} מתוך ${rows.length} עודכנו. אלה לא:`;
      renderAll();
      return;
    }
    if (close) close();
    lastDigest = '';
    renderAll();
    toast(rows.length === 1
      ? 'הפוסט נשלח לבדיקה'
      : `${rows.length} פוסטים נשלחו לבדיקה`, 'ok');
  };

  modal(rows.length === 1 ? 'שליחה לבדיקה' : `שליחת ${rows.length} פוסטים לבדיקה`, h('div', null,
    h('p', {}, 'התאריך והפתק נכתבים על כל הפוסטים שנבחרו, ומופיעים על הכרטיסים בגלריה.'),
    h('div', { class: 'field' },
      h('label', { class: 'field__label' }, 'מתי לבדוק'), when),
    h('div', { class: 'field' },
      h('label', { class: 'field__label' }, 'פתק לבודקים'), note),
    status,
    problems,
  ), { actions: [
    { label: 'סגירה' },
    { label: '👀 שליחה', primary: true, onClick: (c) => { run(c); return false; } },
  ] });
}

/* ── toolbar toggle (v2.8, operator-final) ────────────────────────────
   No scroll behaviour at all — the toggle strip is the ONLY control, which
   also retires the clamp-echo cooldown machinery (nothing here changes
   state on scroll, so there is nothing to oscillate). Layout: the main nav
   is pinned on top (its inert #nav wrapper is made sticky in index.html);
   the filter block sits underneath it behind a one-line strip that opens
   and closes it. Starts collapsed on phones, open on desktop. */
// Folded, the strip carries the visible-post count so an active filter is
// never invisible. Called from setFolded AND from renderGrid — the first fold
// happens at boot, BEFORE the grid has rendered, and a count frozen at that
// moment reads «8 פוסטים» on a board of 146 (caught by screenshot).
function updateTbCount() {
  const el = document.getElementById('tbfold-count');
  if (!el) return;
  const n = document.querySelectorAll('#grid .g-card').length;
  el.textContent = n ? `· ${n} פוסטים` : '';
}

function wireToolbarFold() {
  const bar = $('toolbar');
  const strip = h('button', {
    class: 'g-tbfold', type: 'button',
  },
    h('span', { class: 'g-tbfold__ico' }, '⌄'),
    h('span', {}, 'סינון ומיון'),
    h('span', { class: 'g-tbfold__n', id: 'tbfold-count' }, ''),
  );
  bar.insertBefore(strip, bar.firstChild);

  let folded = null;   // null so the first setFolded always applies
  function setFolded(next) {
    if (folded === next) return;
    folded = next;
    bar.classList.toggle('is-folded', folded);
    strip.setAttribute('aria-expanded', folded ? 'false' : 'true');
    strip.title = folded ? 'הצגת הסינון והמיון' : 'הסתרת הסינון והמיון';
    updateTbCount();
  }
  strip.addEventListener('click', () => setFolded(!folded));

  // phones start collapsed (the whole point); desktops have the room
  setFolded(window.matchMedia('(max-width: 700px)').matches);

  // the toolbar sticks BELOW the pinned nav — measure its real height (it
  // wraps at narrow widths) and hand it to the CSS
  const navEl = document.querySelector('.nav');
  const setNavH = () => {
    if (navEl) bar.style.setProperty('--g-navh', navEl.offsetHeight + 'px');
  };
  setNavH();
  window.addEventListener('resize', setNavH);
}

function matches(p, { skipCat = false, skipStage = false, skipAuthor = false } = {}) {
  // v2.13, and it runs BEFORE every other clause on purpose — a hidden TAB is
  // not a filter the reviewer composes, it is what the gallery IS right now.
  // (Individually hidden POSTS are decided one level up, by viewPool(), so that
  // the pool a count reads and the pool the grid draws are chosen in exactly
  // one place each.)
  //
  // A hidden tab takes its posts out of «הכל», the stage tabs, the author shelf
  // and search — otherwise hiding a tab is cosmetic, and the posts turn up in
  // every view except the one that names them. It is deliberately NOT applied
  // inside «מוסתרים»: a post that is both individually hidden and sitting in a
  // hidden tab must still be reachable, or its only door is closed from both
  // sides.
  if (!showHidden && hiddenTabs.size && hiddenTabs.has(String(p.category || ''))) {
    return false;
  }
  if (!skipCat && filters.cat !== 'all' && p.category !== filters.cat) return false;
  if (!skipAuthor && filters.author !== 'all'
      && String(p.author || '') !== filters.author) return false;
  if (!skipStage) {
    // The waiting-on-marketing view IS the stage filter while it's on (its
    // own stage∉{parked,complete} clause, plan §7) — it composes with
    // category/search below, not with the stage tabs (picking a tab exits it).
    if (waitingOnly) { if (!isWaiting(p)) return false; }
    else if (filters.stage !== 'all' && p.stage !== filters.stage) return false;
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    const hay = `${p.title || ''} ${p.caption || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

// THE ONE CHOKE POINT for "which rows does the grid draw". Default view = the
// default pool; «מוסתרים» = the hidden ones and only them (listing them mixed in
// with everything else would make unhide a hunt). Nothing else in this file
// decides hidden-ness, and every COUNT keeps reading `posts` regardless.
function viewPool() {
  return showHidden
    ? allPosts.filter((p) => p && !p.deleted_at && !!p.hidden_at)
    : posts;
}

function renderAll() {
  renderChips(); renderTabs(); renderAuthors(); renderProgress(); renderGrid();
  syncToolbarState(); renderSelBar();
}

// The sort dropdown has no effect while the waiting view forces its own
// order — disable it rather than leave a control that silently does nothing.
function syncToolbarState() {
  $('sort').disabled = waitingOnly;
  $('sort').title = waitingOnly
    ? 'מוצג לפי עדכון אחרון בזמן שהתצוגה «ממתינים לאישור שיווק» פעילה' : '';
}

function renderChips() {
  const pool = posts.filter((p) => matches(p, { skipCat: true }));
  const count = (cat) => (cat === 'all' ? pool.length : pool.filter((p) => p.category === cat).length);
  const chip = (cat, label) => h('button', {
    class: `chip${filters.cat === cat ? ' chip--on' : ''}`,
    type: 'button',
    onclick: () => {
      filters.cat = filters.cat === cat ? 'all' : cat;
      clearSelection();          // v2.13: the view changed under the selection
      renderAll();
    },
  }, label, h('span', { class: 'g-chip-n' }, count(cat)));
  // The tab row is data-driven: known categories appear when a post carries
  // them, and any OTHER category string found on a post (custom tabs created
  // in the forms, 'general' from the AI queue) gets its own tab automatically,
  // labeled via categoryLabel's raw-string fallback. A tab with no posts does
  // not render — there is nothing behind it to show.
  //
  // v2.13: a HIDDEN tab renders no chip at all, for anyone. That is the whole
  // feature — the popover below is the operator's way back, and it is the only
  // place a hidden category is named.
  const present = new Set(posts.map((p) => p.category || ''));
  const shownCat = (k) => !hiddenTabs.has(String(k));
  const known = CATEGORIES.filter((c) => present.has(c.key) && shownCat(c.key));
  const extra = [...present]
    .filter((k) => k && !CATEGORIES.some((c) => c.key === k) && shownCat(k))
    .sort((a, b) => categoryLabel(a).localeCompare(categoryLabel(b), 'he'))
    .map((k) => ({ key: k, label: categoryLabel(k) }));
  $('cat-chips').replaceChildren(
    chip('all', 'הכל'),
    ...known.map((c) => chip(c.key, c.label)),
    ...extra.map((c) => chip(c.key, c.label)),
    tabManagerBtn());
  // A filter pointing at a tab that was just hidden would strand the gallery on
  // an empty grid with no chip to click back — the same rule the author shelf
  // already applies to a name that disappears.
  if (filters.cat !== 'all' && hiddenTabs.has(String(filters.cat))) {
    filters.cat = 'all';
  }
}

/* ── tab management (v2.13, spec 13) ─────────────────────────────────
   «ניהול לשוניות» lists EVERY category present on the board with a hide/unhide
   toggle, hidden ones struck through. It is board-wide by design: this tool has
   no identity model, so there is no per-user preference to hang this on, and a
   tab that is hidden for one reviewer and not another would make «הכל» mean two
   different things on the same board.

   Nothing here stamps a post. Membership is `category ∈ hiddenTabs`, computed
   at render time, which is what makes unhiding restore the posts untouched —
   and what keeps hiding a 40-post tab from bumping updated_at on 40 rows and
   knocking every open editor into its rebase path. */

const PREF_HIDDEN_TABS = 'hidden_categories';

function tabManagerBtn() {
  return h('button', {
    class: 'g-tabmgr', type: 'button', 'aria-haspopup': 'true',
    title: 'הסתרה והחזרה של לשוניות בגלריה',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleTabManager(); },
  }, '⚙︎ ניהול לשוניות');
}

function toggleTabManager() {
  const wasOpen = openMenu && openMenu.dataset.kind === 'tabs';
  closeMenu();
  if (wasOpen) return;
  // Counted against the CURRENT pool, so the number beside each name is what
  // that tab would show. A hidden tab's posts are filtered out of `posts`'
  // render pool but not out of the array, so this count stays honest for both.
  const livePosts = allPosts.filter((p) => p && !p.deleted_at);
  const countOf = (key) => livePosts.filter((p) => String(p.category || '') === key).length;
  const present = new Set(livePosts.map((p) => String(p.category || '')));
  // A tab hidden while it was empty must still be listed, or it can never be
  // unhidden again.
  for (const k of hiddenTabs) present.add(k);
  present.delete('');
  const keys = [...present].sort((a, b) => {
    const ia = CATEGORIES.findIndex((c) => c.key === a);
    const ib = CATEGORIES.findIndex((c) => c.key === b);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return categoryLabel(a).localeCompare(categoryLabel(b), 'he');
  });

  const row = (key) => {
    const off = hiddenTabs.has(key);
    return h('button', {
      class: `g-tabpop__row${off ? ' is-off' : ''}`, type: 'button',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); setTabHidden(key, !off); },
    },
      h('span', { class: 'g-tabpop__name' }, categoryLabel(key)),
      h('span', { class: 'g-tabpop__n' }, `${countOf(key)} · ${off ? 'מוסתרת' : 'מוצגת'}`));
  };

  openMenu = h('div', {
    class: 'g-pop g-tabpop', dataset: { kind: 'tabs' },
    onclick: (e) => e.stopPropagation(),
  },
    h('div', { class: 'g-tabpop__head' }, 'אילו לשוניות מוצגות בגלריה'),
    ...(keys.length ? keys.map(row) : [h('div', { class: 'g-tabpop__note' }, 'אין עדיין לשוניות בלוח הזה.')]),
    h('div', { class: 'g-tabpop__note' },
      'ההגדרה משותפת לכל מי שנכנס ללוח. לשונית מוסתרת מוציאה את הפוסטים שלה גם מ«הכל» ומהחיפוש, והחזרתה מחזירה אותם כמו שהיו.'),
    // Shown only after a write has actually been refused, never as a guess: the
    // popover must not warn about a server it has not talked to.
    prefsWritable ? null : h('div', { class: 'g-tabpop__note' },
      'השרת לא קיבל את ההגדרה האחרונה. ניהול הלשוניות דורש את מיגרציה 031.'));
  $('cat-chips').appendChild(openMenu);
  setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

async function setTabHidden(key, hide) {
  const next = new Set(hiddenTabs);
  if (hide) next.add(String(key)); else next.delete(String(key));
  const list = [...next];
  try {
    await setPref(PREF_HIDDEN_TABS, list);
  } catch (e) {
    prefsWritable = false;
    toast((e && e.message) || 'ההגדרה לא נשמרה', 'err');
    // Repaint the popover that is still open, so the «דורש את מיגרציה 031» note
    // appears now rather than on the next time someone opens it.
    if (openMenu && openMenu.dataset.kind === 'tabs') { closeMenu(); toggleTabManager(); }
    return;
  }
  prefsWritable = true;
  hiddenTabs = next;
  // The set of visible posts just changed, so a live selection may now hold
  // rows nobody can see.
  clearSelection();
  closeMenu();
  renderAll();
  toast(hide
    ? `הלשונית «${categoryLabel(key)}» הוסתרה מכולם`
    : `הלשונית «${categoryLabel(key)}» חזרה לגלריה`, 'ok');
}

/* ── author shelf (v2.5, spec 08) ─────────────────────────────────────
   «each therapist has "their" shelf». Built from the posts already on screen,
   never from a separate request. It is a plain filter chip row — the same
   composable shape as the category chips — and it hides itself entirely on a
   board where nothing carries an author, so a factory-only board is unchanged. */
function renderAuthors() {
  const shelfEl = $('author-shelf');
  if (!shelfEl) return;
  // Counted against every OTHER filter (skipAuthor), so each name's number is
  // what picking it will actually show — the same rule the category chips use.
  const pool = posts.filter((p) => matches(p, { skipAuthor: true }));
  const shelf = authorShelf(pool);
  if (!shelf.length) {
    shelfEl.hidden = true;
    shelfEl.replaceChildren();
    // A filter that survives its own chip disappearing would strand the
    // gallery on an empty grid with no way back.
    if (filters.author !== 'all') { filters.author = 'all'; renderGrid(); }
    return;
  }
  shelfEl.hidden = false;
  const chip = (key, label, n) => h('button', {
    class: `chip${filters.author === key ? ' chip--on' : ''}`,
    type: 'button',
    onclick: () => {
      filters.author = filters.author === key ? 'all' : key;
      clearSelection();          // v2.13: the view changed under the selection
      renderAll();
    },
  }, label, n == null ? null : h('span', { class: 'g-chip-n' }, n));
  shelfEl.replaceChildren(
    h('span', { class: 'g-authors__label' }, 'מדף לפי מי שיצר:'),
    chip('all', 'כולם', pool.length),
    ...shelf.map((a) => chip(a.author, a.author, a.n)));
}

function renderTabs() {
  // Counted against category+search only (skipStage) — same base pool the
  // ordinary stage tabs count against, so the waiting chip's <n> is directly
  // comparable to them and matches exactly what toggling it on will show.
  const pool = posts.filter((p) => matches(p, { skipStage: true }));
  const count = (st) => (st === 'all' ? pool.length : pool.filter((p) => p.stage === st).length);
  const tab = (st, label) => h('button', {
    class: `g-tab${!waitingOnly && filters.stage === st ? ' is-on' : ''}`,
    type: 'button', role: 'tab', 'aria-selected': String(!waitingOnly && filters.stage === st),
    onclick: () => {
      waitingOnly = false; filters.stage = st;
      clearSelection();          // v2.13: the view changed under the selection
      renderAll();
    },
  }, `${label} `, h('span', { class: 'g-chip-n' }, count(st)));
  const waitBtn = h('button', {
    class: `g-tab g-tab--wait${waitingOnly ? ' is-on' : ''}`,
    type: 'button', role: 'tab', 'aria-selected': String(waitingOnly),
    title: 'פוסטים בלי חתימת שיווק תקפה, שעדיין לא בהמתנה ולא הושלמו',
    onclick: () => {
      waitingOnly = !waitingOnly;
      if (waitingOnly) filters.stage = 'all';
      clearSelection();          // v2.13: the view changed under the selection
      renderAll();
    },
  }, 'ממתינים לאישור שיווק ', h('span', { class: 'g-chip-n' }, pool.filter(isWaiting).length));
  $('stage-tabs').replaceChildren(
    tab('all', 'הכל'),
    ...STAGES.map((s) => tab(s.key, s.label)),
    waitBtn);
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
  // §7: the waiting view has its own fixed order (updated_at desc) — it
  // overrides the sort dropdown rather than fighting it (the dropdown is
  // disabled while this view is on; see syncToolbarState).
  if (waitingOnly) {
    const upd = (p) => ts(p.updated_at || p.created_at);
    return [...list].sort((a, b) => upd(b) - upd(a) || byNew(a, b));
  }
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
  return filters.sort === 'manual' && !waitingOnly
      && filters.stage === 'all' && filters.author === 'all'
      // v2.13: never inside the «מוסתרים» view. Dragging there would renumber
      // `sort` from a list that is a few hidden rows out of the whole board,
      // and the shared arrangement everyone else sees would move underneath
      // them for reasons nobody could see.
      && !showHidden
      && !filters.q && posts.length > 1;
}

function setArranging(on) {
  arranging = !!on;
  // v2.13: mutually exclusive with selection mode. Both claim the same click on
  // the same card in the same capture-phase handler, so the grid must only ever
  // be in one of them.
  if (arranging && selMode) setSelecting(false);
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
  //
  // v2.13: selection mode borrows the same trick, and for the same reason. The
  // title anchor is a STRETCHED link covering the whole card (.g-title::after),
  // so without a capture-phase preventDefault a tap meant to tick a checkbox
  // navigates to post.html instead — on a phone, where the whole card is the
  // target, that is every tap. Capture phase also beats the ⋯ button's and the
  // version badge's own handlers, which is deliberate: in selection mode a card
  // click means exactly one thing.
  grid.addEventListener('click', (e) => {
    if (arranging) {
      if (e.target.closest('.g-emptyact')) return;   // same exemption as below
      e.preventDefault(); e.stopPropagation(); return;
    }
    if (!selMode) return;
    // The empty-state action is the ONE control inside the grid that must keep
    // working here: it is the way OUT of a filter that shows nothing, and with
    // no cards on screen there is nothing to select anyway. Without this
    // exemption the capture-phase stopPropagation eats its click and the button
    // is dead (reproduced by the inspector).
    if (e.target.closest('.g-emptyact')) return;
    e.preventDefault(); e.stopPropagation();
    const cardEl = e.target.closest('.g-card');
    if (!cardEl || cardEl.classList.contains('g-skel')) return;
    toggleSelect(cardEl);
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

/* ── marketing sign-off (v2.3, plan §7) ──────────────────────────────
   I1/I2 (PLAN.md): sm_approvals is the ONLY answer to "is this
   marketing-approved, and for which version" — never inferred from
   sm_posts.stage. approvalState() is the pure store.js derivation; this file
   only feeds it this post's rows and reads .status back. */

function postApprovalStatus(p) {
  return approvalState(p, approvalsByPost.get(p.id) || [], versions.get(p.id) || []).status;
}

// The «ממתינים לאישור שיווק» predicate: no fresh signature AND still in a
// lane marketing would act on — a parked or already-complete post is done
// either way, signed or not.
function isWaiting(p) {
  if (p.stage === 'parked' || p.stage === 'complete') return false;
  const st = postApprovalStatus(p);
  return st === 'none' || st === 'stale' || st === 'revoked';
}

const WAIT_BADGE = { none: 'ללא חתימה', stale: 'נערך אחרי חתימה', revoked: 'החתימה בוטלה' };

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
  const pool = viewPool();
  // v2.13: while «מוסתרים» is on, the toolbar above keeps describing the REGULAR
  // gallery (every count reads the default pool, by design — a count that
  // quietly included hidden posts is the bug this split exists to prevent). Say
  // so, once, above the grid, rather than leave two numbers disagreeing.
  const lens = showHidden
    ? h('div', { class: 'g-lens' },
        'התצוגה הזאת מציגה את הפוסטים המוסתרים בלבד. המונים בסרגל שלמעלה ממשיכים לתאר את הגלריה הרגילה.')
    : null;
  if (!pool.length) {
    lastListIds = [];
    grid.replaceChildren(...kids(
      lens,
      h('div', { class: 'g-empty' },
        // v2.13: the «מוסתרים» view on an empty board is not an empty BOARD, and
        // saying «the posts are on their way» there would be a lie.
        h('p', {}, showHidden
          ? 'אין פוסטים מוסתרים בלוח הזה.'
          : 'הלוח עדיין ריק — הפוסטים בדרך.'))));
    return;
  }
  const list = sortPosts(pool.filter((p) => matches(p)));
  // What «בחירת הכול» means: exactly these, in this order.
  lastListIds = list.map((p) => String(p.id));
  if (!list.length) {
    grid.replaceChildren(...kids(
      lens,
      h('div', { class: 'g-empty' },
        h('p', {}, showHidden
          ? 'אין פוסט מוסתר שעונה לסינון הזה.'
          : 'שום פוסט לא עונה לסינון הזה. אולי לנקות את המסננים ולנסות שוב?'),
        emptyClearBtn())));
    updateTbCount();
    return;
  }
  grid.replaceChildren(...kids(lens, ...list.map(card)));
  updateTbCount();
}

// The empty-state «ניקוי מסננים». Carries .g-emptyact so the grid's
// capture-phase handler lets its click through in selection/arrange mode.
function emptyClearBtn() {
  return h('button', {
    class: 'btn btn--ghost g-emptyact', type: 'button',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); clearFilters(); },
  }, 'ניקוי מסננים');
}

function clearFilters() {
  filters.cat = 'all'; filters.stage = 'all'; filters.q = ''; filters.author = 'all';
  $('search').value = '';
  clearSelection();              // v2.13: the view changed under the selection
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

  // §7: the reason badge only appears inside the waiting view itself — every
  // card shown there is, by construction, none/stale/revoked, so exactly one
  // of the three labels always applies.
  const waitStatus = waitingOnly ? postApprovalStatus(p) : null;
  const waitBadge = waitStatus && WAIT_BADGE[waitStatus]
    ? h('span', { class: `tag tag--wait tag--wait-${waitStatus}` }, WAIT_BADGE[waitStatus])
    : null;

  const tags = [
    waitBadge,
    // v2.13: only ever visible inside the «מוסתרים» view (a hidden post is
    // filtered out everywhere else), and it has to be there — otherwise that
    // view looks like an ordinary gallery that is missing most of the board.
    p.hidden_at ? h('span', { class: 'tag g-hidtag' }, '🙈 מוסתר') : null,
    CATEGORY_LABELS[p.category] ? h('span', { class: 'tag' }, CATEGORY_LABELS[p.category]) : null,
    STAGE_LABELS[p.stage] ? h('span', { class: 'tag' }, STAGE_LABELS[p.stage]) : null,
    edited ? versionBadge(p) : (version ? h('span', { class: 'tag' }, version) : null),
    p.origin === 'builder' && p.category !== 'builder'
      ? h('span', { class: 'tag' }, 'נבנה בכלי') : null,
    // v2.5 (spec 08): a generated post says so on the card, with the name it
    // was made for — otherwise the author shelf lists names the gallery never
    // explains. The full story is «איך זה נוצר» on the post page.
    p.origin === 'ai'
      ? h('span', { class: 'tag' }, '✨ נוצר עם AI' + (p.author ? ' · ' + p.author : ''))
      : null,
    // v2.1: a review date set from the post's «תזמון» button surfaces on the
    // board too — a due date nobody sees is a due date nobody meets. Overdue
    // reads differently. (The PUBLISH side of scheduling has its own page.)
    p.review_at
      ? h('span', {
          class: 'tag tag--review' + (Date.parse(p.review_at) < Date.now() ? ' is-late' : ''),
          title: p.review_note || 'מתוזמן לבדיקה',
        }, `👀 ${fmtWhen(p.review_at, { relative: false })}`)
      : null,
  ];

  const menuBtn = h('button', {
    class: 'g-menu-btn', type: 'button', 'aria-label': 'פעולות על הפוסט',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(e.currentTarget.closest('.g-card'), p); },
  }, '⋯');

  // v2.13: the tick is rendered from `selIds`, so a re-render (the poll, a
  // filter repaint) restores the selection instead of losing it. The input is
  // pointer-events:none in CSS — the CARD owns the click, capture-phase, and a
  // live checkbox would fight it into a half-toggled state.
  const picked = selMode && selIds.has(String(p.id));
  const pick = selMode
    ? h('label', { class: 'g-pick' }, h('input', {
        type: 'checkbox', checked: picked, tabindex: '-1',
        'aria-label': 'בחירה: ' + (p.title || p.id),
      }))
    : null;

  return h('article', {
    class: `card g-card${mineCls}${picked ? ' is-picked' : ''}`,
    dataset: { id: p.id },
  },
    cover,
    pick,
    h('a', { class: 'g-title', href: postLink(p.id) }, p.title || 'ללא כותרת'),
    h('div', { class: 'g-tags' }, tags),
    h('div', { class: 'g-meta' },
      tally,
      h('span', { title: 'הערות ותגובות' }, `💬 ${a.discuss}`),
      h('span', {}, slideCountLabel(slideTotalOf(p))),
      filters.sort === 'activity' && a.last
        ? h('span', { class: 'g-when', title: 'פעילות אחרונה' }, fmtDate(a.last))
        : null),
    menuBtn);
}

// v2.3 — `slide_count` is the STUDIO's number and nothing on the board ever
// updates it (anon holds no update grant on that column). The previous
// `p.slide_count ?? p.slides.length` never once reached its fallback, because
// `??` only fires on null/undefined and ingest always sets slide_count — so a
// post whose board slides had grown or shrunk (an uploaded re-render) still
// advertised the studio's count on its card while the viewer showed a
// different number of slides. Same rule as post.js slideTotal(): board slide
// DATA is the render source and wins; slide_count is the fallback for
// render-only posts (studio PNGs, no slides array) and nothing else.
function slideTotalOf(p) {
  const slides = p && p.slides;
  if (Array.isArray(slides) && slides.length) return slides.length;
  return Number(p && p.slide_count) || 0;
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
  const stageSel = h('select', {
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
  // v2.13: the four actions, for THIS post alone. The spec asked for them
  // «individually and in bulk», and they call the same functions the selection
  // bar does with a one-row array — one implementation, so the single and bulk
  // paths cannot drift.
  const act = (label, fn) => h('button', {
    class: 'g-tabpop__row', type: 'button',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); closeMenu(); fn(); },
  }, h('span', { class: 'g-tabpop__name' }, label));
  openMenu = h('div', { class: 'g-pop', onclick: (e) => e.stopPropagation() },
    h('label', {}, 'שנה שלב'), stageSel,
    h('label', {}, 'פעולות'),
    act('⬇︎ הורדת השקפים', () => downloadDialog([p])),
    act('👀 שליחה לבדיקה', () => reviewDialog([p])),
    p.hidden_at
      ? act('👁 ביטול הסתרה', () => setPostsHidden([p], false))
      : act('🙈 הסתרה', () => setPostsHidden([p], true)),
    act('🗑 מחיקה', () => deleteDialog([p])));
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
