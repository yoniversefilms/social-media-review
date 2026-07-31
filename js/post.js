// post.js — the review screen: one carousel, everything a therapist does to it.
// Owned by the review module. Talks to the backend ONLY through store.js;
// live preview ONLY through compose.js; shared UI through ui.js.

import {
  initStore, ensureName, assetUrl, slideUrl,
  listPosts, getPost,
  listVotes, latestVotes, castVote,
  listPins, addPin, deletePin, resolvePin,
  listReplies, addReply,
  listEdits,
  setStage, setCaption,
  listPhotos, uploadPhoto, photoUrl,
  queuePublish, subscribe,
  savePostSlides, logEdit,
  saveTemplate,
  saveVersion, listVersions,
} from './store.js';
import {
  el, modal, toast, fmtDate, voteGlyph,
  stageLabel, categoryLabel, STAGES, navBar,
} from './ui.js';
import { initCompose, mountSlide, manifest } from './compose.js';
import { initEditor, canonicalJSON, designSummary, PHOTO_DRAG_MIME } from './editor.js';

const $ = (id) => document.getElementById(id);

const VOTE_LABELS = { yes: 'כן', no: 'לא', maybe: 'אולי' };
const EDIT_STATUS_LABELS = { proposed: 'ממתין', accepted: 'התקבל', rejected: 'נדחה', applied: 'יושם' };
const CHANNEL_LABELS = { instagram: 'אינסטגרם', facebook: 'פייסבוק', both: 'שניהם' };

// ---------------------------------------------------------------- state

const S = {
  board: null,          // {board_key, name, local} from initStore
  me: null,             // {name, author_id}
  post: null,           // last row adopted from the backend (saved truth)
  posts: [],            // for prev/next (fetched once)
  cur: 0,               // current slide (0-based)
  pinMode: false,
  live: false,
  composeReady: false,
  votes: [],
  pins: [],
  repliesByPin: new Map(),
  edits: [],
  photos: [],
  tab: 'caption',
  voteSel: null,        // locally selected vote before שמור
  editAccEl: null,      // cached accordion element (survives re-renders)
  pendingTabRender: false,
  popover: null,
  // design tab (direct-manipulation editor over the live compose)
  designCtrl: null,           // initEditor controller for the current slide
  designCtrlIdx: -1,          // which slide the controller is armed on
  designMountEl: null,        // persistent compose container for the editor
  designEngineMissing: false, // compose handle doesn't expose update/doc yet
  // v1.5 direct collaborative editing: every committed change lands in the
  // working slides copy and PATCHes sm_posts.slides for everyone.
  slides: [],           // deep working copy of S.post.slides (render source)
  updatedAt: null,      // sm_posts.updated_at our saved state reflects (optimistic guard)
  pending: new Map(),   // field ('slides.<i>.<key>') -> {old_text, new_text} since last save
  saveInFlight: false,
  saveQueued: false,
  // v1.6 undo/redo: per-user, SESSION-LOCAL stacks of {slides, caption}
  // snapshots. Undo reverts YOUR steps in this tab only; both stacks clear
  // whenever another device's change is adopted (undoing across someone
  // else's work is a trap, not a feature).
  undoStack: [],
  redoStack: [],
  histBatchOpen: false, // an undo snapshot already covers the pending batch
  histBatchField: null, // batching key: same-field commits fold into one step
  applyingHistory: false, // restoring a snapshot — don't re-mark boundaries
};

const params = new URLSearchParams(location.search);

function pageUrl(page, extra = {}) {
  const p = new URLSearchParams();
  p.set('board', S.board.board_key);
  if (S.board.local) p.set('local', '1');
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return page + '?' + p.toString();
}

function slideTotal() {
  return S.post.slide_count || S.slides.length || 1;
}
function hasSlidesData() {
  return Array.isArray(S.slides) && S.slides.length > 0;
}

function deepCopy(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// adopt a fresh backend row as the saved truth + reset the working copy
function adoptPost(post) {
  S.post = post;
  if (typeof S.post.slides === 'string') {
    try { S.post.slides = JSON.parse(S.post.slides); } catch { S.post.slides = []; }
  }
  if (!Array.isArray(S.post.slides)) S.post.slides = [];
  S.slides = deepCopy(S.post.slides);
  S.updatedAt = S.post.updated_at || null;
  loadVersionBase();   // background: what the gallery's version dropdown will list
}

// ---------------------------------------------------------------- boot

init().catch((e) => {
  console.error(e);
  showError('משהו השתבש בטעינת הפוסט: ' + (e && e.message ? e.message : e));
});

async function init() {
  S.board = await initStore();
  document.getElementById('nav-slot').replaceWith(navBar(null));
  S.me = await ensureName();

  const id = params.get('id');
  if (!id) return showError('חסר מזהה פוסט בכתובת.');
  try {
    adoptPost(await getPost(id));
  } catch (e) {
    return showError('הפוסט לא נמצא. ' + (e && e.message ? e.message : ''));
  }
  if (!S.post) return showError('הפוסט לא נמצא.');

  document.title = (S.post.title || S.post.id) + ' · בדיקת פוסט';

  // v1.5: no draft restore — every edit already lives in the post itself.

  $('pvHead').hidden = false;
  $('pvMain').hidden = false;
  renderHeader();
  wireViewer();
  wireFrameDrop();
  wireDesignBtn();
  wireSaveChip();
  buildTabs();
  renderViewer();
  renderVoteBox();

  await refreshAll();
  showTab('caption');

  // siblings for the header's prev/next — the header renders without them and
  // fills them in when they land
  listPosts().then((rows) => {
    S.posts = Array.isArray(rows) ? rows : [];
    renderPostNav();
  }).catch(() => {});

  subscribe(onRemoteChange);
  document.addEventListener('keydown', onKeydown);

  // builder posts may have no PNG renders at all — fall into live preview
  if (!S.post.asset_prefix && hasSlidesData()) setLive(true, { silent: true });
}

function showError(msg) {
  $('pvHead').hidden = true;
  $('pvMain').hidden = true;
  const box = $('pvError');
  box.hidden = false;
  box.replaceChildren(
    el('div', null, msg),
    S.board ? el('a', { class: 'btn btn--primary', href: pageUrl('index.html') }, 'חזרה לגלריה') : null,
  );
}

// ---------------------------------------------------------------- data refresh

let refreshTimer = null;
function onRemoteChange() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshAll().catch(() => {}); }, 300);
}

async function refreshAll() {
  const pid = S.post.id;
  const [post, votes, pins, edits, photos] = await Promise.all([
    getPost(pid).catch(() => null),
    listVotes().catch(() => []),
    listPins(pid).catch(() => []),
    listEdits(pid).catch(() => []),
    listPhotos(pid).catch(() => []),
  ]);
  if (post) {
    const capEd = $('capEditor');
    const capOpen = !!capEd && !capEd.hidden;
    applyRemotePost(post);
    renderHeader();
    if (!capOpen) renderCaption();
  }
  S.votes = votes;
  if (typeof renderVoteBox === 'function') setTimeout(renderVoteBox, 0);
  S.pins = pins.slice().sort((a, b) =>
    (a.slide - b.slide) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  S.edits = edits;
  S.photos = photos;
  if (S.designCtrl) S.designCtrl.setPhotos(designPhotos());

  const reps = await Promise.all(S.pins.map((p) => listReplies(p.id).catch(() => [])));
  S.repliesByPin = new Map(S.pins.map((p, i) => [p.id, reps[i]]));

  renderPinLayer();
  renderTabBadges();
  renderActiveTab();
}

// v1.5: a subscribe() tick re-fetched the post row. If slides changed
// remotely and the reviewer isn't mid-edit, adopt them and re-mount the
// preview so the other device's edits appear live. If the reviewer has
// unsaved local work, leave the working copy alone — the optimistic guard
// on the next save re-fetches and merges.
function applyRemotePost(post) {
  let remoteSlides = post.slides;
  if (typeof remoteSlides === 'string') {
    try { remoteSlides = JSON.parse(remoteSlides); } catch { remoteSlides = []; }
  }
  if (!Array.isArray(remoteSlides)) remoteSlides = [];
  const slidesChanged = canonicalJSON(remoteSlides) !== canonicalJSON(S.post.slides || []);

  if (!slidesChanged) {
    // metadata-only change (stage/caption/…): adopt wholesale, keep working copy
    const remoteCaption = (post.caption ?? '') !== (S.post.caption ?? '');
    post.slides = S.post.slides;
    S.post = post;
    if (!S.saveInFlight) S.updatedAt = post.updated_at || S.updatedAt;
    // caption is part of undo snapshots — a caption from another device is a
    // remote adoption too, so the session-local stacks go
    if (remoteCaption) clearHistory();
    return;
  }
  if (S.saveInFlight || S.pending.size || midGesture()) {
    // remote slides changed while we're editing — adopt only non-slide fields;
    // the conflict path merges slides on the next save
    post.slides = S.post.slides;
    post.updated_at = S.post.updated_at;
    S.post = post;
    return;
  }
  // clean adoption: the other device's edits become our render source.
  // Undo/redo stacks clear — undoing across someone else's work is a trap.
  clearHistory();
  post.slides = remoteSlides;
  adoptPost(post);
  S.cur = Math.min(S.cur, slideTotal() - 1);
  S.editAccEl = null;
  destroyDesignEditor();
  S.designMountEl = null;
  renderViewer();
}

// focus guard: never yank slides out from under a reviewer mid-gesture/typing
function midGesture() {
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT|IFRAME)$/.test(ae.tagName)) return true;
  return false;
}

// ---------------------------------------------------------------- header

function renderHeader() {
  $('pvTitle').textContent = S.post.title || S.post.id;
  $('pvTags').replaceChildren(
    el('span', { class: 'tag' }, categoryLabel(S.post.category)),
    el('span', { class: 'tag' }, stageLabel(S.post.stage)),
    S.post.version ? el('span', { class: 'tag', style: { direction: 'ltr' } }, S.post.version) : null,
    el('span', { class: 'tag' }, `${slideTotal()} שקפים`),
  );
  renderPostNav();
}

// ------------------------------------------------ post-to-post navigation

// The ONE ordering: alphabetical by id within the post's own category. (The
// פרטים tab used to render a second copy of these links off the same rule;
// v1.7 removed it so there is a single navigation.)
function siblingPosts() {
  const sibs = S.posts
    .filter((p) => p.category === S.post.category)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sibs.findIndex((p) => p.id === S.post.id);
  return {
    prev: idx > 0 ? sibs[idx - 1] : null,
    next: idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null,
  };
}

// «→ הקודם» / «הבא ←»: in an RTL line the leading arrow lands on the RIGHT
// (backwards) and the trailing one on the LEFT (forwards), which matches the
// slide arrows and the carousel's own direction. Ends disable, never wrap.
// Leaving the post: flush any debounced save first, so navigating away can
// never lose the last couple of seconds of edits. Only intercept plain
// left-clicks — modified clicks (new tab/window) must behave natively.
function onPostNavClick(e) {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget && e.currentTarget.getAttribute('href');
  if (!href) { e.preventDefault(); return; }   // disabled end-of-list button
  if (!saveTimer && !S.saveInFlight && !S.sessionDirty) return;  // nothing to settle
  e.preventDefault();
  Promise.resolve(saveTimer || S.saveInFlight ? flushSave() : null)
    .catch(() => {})
    .then(() => stampVersion())
    .catch(() => {})
    .then(() => { location.href = href; });
}


// ---------------------------------------------------------------- versions
// A version is a snapshot of the shared post, stamped when an editing session
// ENDS (tab hidden / closed, or navigating to another post). Numbering
// continues the studio's: studio v4 + as many board snapshots as exist.
// The unique (board, post, vnum) constraint makes concurrent stamps safe —
// store.saveVersion resolves a collision to the existing row instead of
// throwing, so a second device stamping the same number is a no-op.
async function loadVersionBase() {
  try {
    const rows = await listVersions(S.post.id);
    S.versionRows = Array.isArray(rows) ? rows : [];
  } catch { S.versionRows = []; }
}

function nextVnum() {
  const studio = parseInt(String(S.post.version || 'v1').replace(/[^0-9]/g, ''), 10) || 1;
  const highest = (S.versionRows || []).reduce((m, r) => Math.max(m, Number(r.vnum) || 0), 0);
  return Math.max(studio, highest) + 1;
}

async function stampVersion() {
  if (!S.sessionDirty || S.stamping) return;
  S.stamping = true;
  const vnum = nextVnum();
  try {
    const row = await saveVersion({
      post_id: S.post.id, vnum,
      slides: S.slides, caption: S.post.caption || '',
    });
    if (row) S.versionRows = [row, ...(S.versionRows || [])];
    S.sessionDirty = false;      // one stamp per burst of edits
  } catch { /* best effort: a lost snapshot must never block navigation */ }
  finally { S.stamping = false; }
}

function renderPostNav() {
  const slot = $('pvNav');
  if (!slot) return;
  const gallery = el('a', {
    class: 'btn btn--ghost pv-navbtn', href: pageUrl('index.html'),
  }, 'לגלריה');
  gallery.addEventListener('click', onPostNavClick);

  // before listPosts() resolves there are no siblings to reason about — show
  // only the gallery link rather than two buttons that flicker enabled
  if (!S.posts.length) { slot.replaceChildren(gallery); return; }

  const { prev, next } = siblingPosts();
  const link = (post, label, offTitle) => {
    const a = el('a', {
      class: 'btn btn--ghost pv-navbtn' + (post ? '' : ' is-off'),
      href: post ? pageUrl('post.html', { id: post.id }) : null,
      title: post ? (post.title || post.id) : offTitle,
      'aria-disabled': post ? null : 'true',
      tabindex: post ? null : '-1',
    }, label);
    if (post) a.addEventListener('click', onPostNavClick);
    return a;
  };

  slot.replaceChildren(
    link(prev, '→ הפוסט הקודם', 'זה הפוסט הראשון בקטגוריה'),
    link(next, 'הפוסט הבא ←', 'זה הפוסט האחרון בקטגוריה'),
    gallery,
  );
}

// ---------------------------------------------------------------- viewer

// The artwork's box, in viewport coords. Pin dots and the compose iframe both
// live inside the frame's PADDING box (position:absolute; inset:0), i.e. inside
// its 1px boundary — measuring #frame itself would be that 1px off in x and y.
// #pinLayer is that padding box, so it is the one true reference for any
// fraction-of-the-slide coordinate.
function slideRect() {
  return $('pinLayer').getBoundingClientRect();
}

function wireViewer() {
  $('nextBtn').addEventListener('click', () => goTo(S.cur + 1));
  $('prevBtn').addEventListener('click', () => goTo(S.cur - 1));
  $('pinBtn').addEventListener('click', () => setPinMode(!S.pinMode));

  const frame = $('frame');

  // swipe/drag: leftward = next (RTL carousel).
  // v1.7: the arrows are siblings of the frame now, so they can no longer
  // deliver a pointerdown here at all — only the popover and pins need a guard.
  let down = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pv-pop') || e.target.closest('.pin-dot')) return;
    down = { x: e.clientX, y: e.clientY };
  });
  frame.addEventListener('pointerup', (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    down = null;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) goTo(S.cur + 1); else goTo(S.cur - 1);
      return;
    }
    // a genuine click while armed → drop a pin
    if (S.pinMode && Math.abs(dx) < 8 && Math.abs(dy) < 8 && !e.target.closest('.pv-pop')) {
      const rect = slideRect();
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      openPinPopover(x, y);
    }
  });
  frame.addEventListener('pointercancel', () => { down = null; });

  // a missing PNG is only user-visible when the PNG is the layer on top —
  // otherwise the live compose is already covering it (v1.7)
  $('slideImg').addEventListener('error', () => frame.classList.add('noimg'));
  $('slideImg').addEventListener('load', () => frame.classList.remove('noimg'));
}

function goTo(i) {
  const n = slideTotal();
  const next = Math.min(n - 1, Math.max(0, i));
  if (next === S.cur) return;
  S.cur = next;
  closePopover();
  renderViewer();
  if (designMode()) renderDesignState();  // «שמור כתבנית» visibility follows the slide
}

function renderViewer() {
  const n = slideTotal();
  const img = $('slideImg');
  const url = slideUrl(S.post, S.cur);
  if (img.getAttribute('src') !== url) { $('frame').classList.remove('noimg'); img.src = url; }
  img.alt = `שקף ${S.cur + 1}`;

  $('nextBtn').disabled = S.cur >= n - 1;
  $('prevBtn').disabled = S.cur <= 0;

  $('dots').replaceChildren(...Array.from({ length: n }, (_, i) => {
    const d = el('button', { class: 'pv-dot' + (i === S.cur ? ' on' : ''), type: 'button' }, String(i + 1));
    d.addEventListener('click', () => goTo(i));
    return d;
  }));
  $('slideCount').textContent = `שקף ${S.cur + 1} מתוך ${n}`;

  // v1.7: live compose is not a mode the reviewer picks any more. Under v1.5
  // every edit lands in the shared slides immediately, so for an edited post
  // the studio PNG is stale by definition — the browser-composed render IS
  // the post. The PNG survives only as (a) the fallback when there is no
  // slides data or compose failed to load, and (b) the compare button.
  S.live = hasSlidesData() && !S.composeFailed && S.composeReady;
  $('composeHost').hidden = !S.live;
  if (S.live) {
    if (designMode()) mountDesignSoon(0);
    else mountPreviewSoon(0);
  } else {
    destroyDesignEditor();
  }

  applyCompare();
  renderPinLayer();

  // lazy, once per page: bring compose up, then re-render into it
  if (hasSlidesData() && !S.composeReady && !S.composeFailed) bootCompose();
}

// ------------------------------------------------ live preview (compose)

let previewTimer = null;
let previewSeq = 0;
let composeBoot = null;

function bootCompose() {
  if (composeBoot) return composeBoot;
  composeBoot = (async () => {
    try {
      await initCompose(assetUrl);
      S.composeReady = true;
    } catch (e) {
      console.error('initCompose failed', e);
      S.composeFailed = true;
      toast('התצוגה החיה לא נטענה — מוצג הרינדור מהסטודיו', 'err');
    }
    renderViewer(); // now S.composeReady/S.composeFailed is settled — no recursion
  })();
  return composeBoot;
}

// ------------------------------------------------ which layer is on top
// No mode, no control: the slide simply IS its live compose. The studio PNG
// surfaces only when there is nothing to compose (no slides data) or when a
// compose failed — a fallback, never a user-facing choice.
function applyCompare() {
  $('frame').classList.toggle('pngtop', !S.live);
}

function mountPreviewSoon(delay = 300) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { mountPreview().catch(() => {}); }, delay);
}

async function mountPreview() {
  if (!S.live || designMode()) return;
  destroyDesignEditor();
  const slide = S.slides[S.cur];
  const host = $('composeHost');
  if (!slide) { host.replaceChildren(el('div', { class: 'pv-note', style: { padding: '20px' } }, 'אין נתוני מקור לשקף הזה')); return; }

  const seq = ++previewSeq;
  try {
    const tmp = el('div', { style: { position: 'absolute', inset: '0' } });
    // the working copy IS the shared truth (plus any not-yet-flushed local
    // commits) — vars and design come straight from it
    const composed = { template: slide.template, vars: { ...slide.vars } };
    if (slide.design) composed.design = slide.design;
    await mountSlide(tmp, composed);
    if (seq !== previewSeq) return; // a newer keystroke superseded this mount
    // mode may have flipped during the await — a stale preview must never
    // clobber the design editor's mount (it would silently detach the armed
    // overlay without destroying the controller)
    if (!S.live || designMode()) return;
    host.replaceChildren(tmp);
  } catch (e) {
    console.error('mountSlide failed', e);
    if (seq !== previewSeq) return;
    toast('שגיאה בתצוגה החיה — חוזרים לרינדור הרגיל', 'err');
    setLive(false);
  }
}

// ------------------------------------------------ design mode (editor.js)

function designMode() {
  return !!S.design && hasSlidesData();
}

function designPhotos() {
  return S.photos.map((ph) => ({ url: photoUrl(ph), note: ph.note || '' }));
}

// ---- v1.5 commit primitives: every committed change lands in the working
// copy, records its old→new pair (relative to the last-saved state), and
// schedules the shared save. audit rows use '' for an absent design so
// apply-edits' replay guard keeps working.

function savedDesignCanon(i) {
  const slide = (S.post.slides || [])[i];
  return slide && slide.design ? canonicalJSON(slide.design) : '';
}

// old_text is captured once per save-cycle (the saved value); typing back to
// the saved value cancels the pending entry.
function notePending(field, old_text, new_text) {
  const p = S.pending.get(field);
  if (p) {
    if (p.old_text === new_text) S.pending.delete(field);
    else p.new_text = new_text;
  } else if (old_text !== new_text) {
    S.pending.set(field, { old_text, new_text });
  }
}

function commitVar(i, key, value, opts = {}) {
  const s = S.slides[i];
  if (!s) return;
  s.vars = s.vars || {};
  const val = String(value);
  if (String(s.vars[key] ?? '') === val && !S.pending.has(`slides.${i}.${key}`)) return;
  markUndoBoundary(`slides.${i}.${key}`); // BEFORE the mutation — snapshot is pre-change
  s.vars[key] = val;
  const savedVars = ((S.post.slides || [])[i] || {}).vars || {};
  notePending(`slides.${i}.${key}`, String(savedVars[key] ?? ''), val);
  scheduleSave(opts.delay);
}

function commitDesign(i, design, opts = {}) {
  const s = S.slides[i];
  if (!s) return;
  const field = `slides.${i}.design`;
  const newCanon = design ? canonicalJSON(design) : '';
  const curCanon = s.design ? canonicalJSON(s.design) : '';
  if (newCanon === curCanon && !S.pending.has(field)) return;
  // structural changes (slot fill, extra add/remove, hide) are their own undo
  // step even inside an open design batch; drags/styling fold per save batch
  markUndoBoundary(field, { always: designSig(design) !== designSig(s.design) });
  if (design) s.design = design; else delete s.design;
  notePending(field, savedDesignCanon(i), newCanon);
  scheduleSave(opts.delay);
}

function destroyDesignEditor() {
  if (S.designCtrl) { S.designCtrl.destroy(); S.designCtrl = null; }
  S.designCtrlIdx = -1;
  // the editor's action-bar buttons live in our bar (opts.actionBar) —
  // destroy() removes its overlay but not the hosted row, so clear the slot
  if (editorBarSlot) editorBarSlot.replaceChildren();
}

let designTimer = null;
let designSeq = 0;
function mountDesignSoon(delay = 0) {
  clearTimeout(designTimer);
  designTimer = setTimeout(() => { mountDesign().catch(() => {}); }, delay);
}

async function mountDesign() {
  if (!S.live || !designMode()) return;
  const i = S.cur;
  const slide = S.slides[i];
  const host = $('composeHost');
  if (!slide) {
    destroyDesignEditor();
    host.replaceChildren(el('div', { class: 'pv-note', style: { padding: '20px' } }, 'אין נתוני מקור לשקף הזה'));
    return;
  }

  // the working copy is the single render source — vars + design together
  const composed = { template: slide.template, vars: { ...slide.vars } };
  if (slide.design) composed.design = slide.design;

  // persistent mount container — re-mounting into it reuses the iframe, so
  // the armed editor survives var-level refreshes on the same slide
  if (!S.designMountEl || !host.contains(S.designMountEl)) {
    destroyDesignEditor();
    S.designMountEl = el('div', { style: { position: 'absolute', inset: '0' } });
    host.replaceChildren(S.designMountEl);
  }

  const seq = ++designSeq;
  let handle;
  try {
    handle = await mountSlide(S.designMountEl, composed);
  } catch (e) {
    console.error('mountSlide (design) failed', e);
    return;
  }
  if (seq !== designSeq || !designMode()) return;

  // arm the editor (once per slide) — needs the {iframe, update, doc} handle
  if (S.designCtrl && S.designCtrlIdx === i) { S.designCtrl.refresh(); return; }
  destroyDesignEditor();
  const wasMissing = S.designEngineMissing;
  try {
    S.designCtrl = initEditor(handle, composed, {
      manifest: manifest(),
      photos: designPhotos(),
      assetUrl,
      uploadFile: uploadFromEditor,
      // v1.6: the editor's non-contextual buttons (הוסף איור / רקע / איפוס
      // עיצוב…) render in the action bar ABOVE the slide, not on the artwork
      actionBar: editorBarSlot,
      // v1.5: a design mutation is a committed change — it writes into the
      // working slides and saves (debounced ~2s) straight to everyone.
      onChange: (design) => {
        commitDesign(i, design, { delay: 2000 });
        if (designMode()) renderDesignState();
      },
      // «איפוס עיצוב» dialog: clearing a design is itself a direct edit —
      // it saves (and audit-logs) like any other change. Text stays: it is
      // content, already committed to the shared post.
      onReset: (scope) => {
        // one undo step for the whole reset (deck resets touch many slides)
        withOneUndoStep('reset', () => {
          if (scope === 'deck') {
            for (let j = 0; j < S.slides.length; j++) {
              if (S.slides[j] && S.slides[j].design) commitDesign(j, null, { delay: 400 });
            }
          } else {
            commitDesign(i, null, { delay: 400 });
          }
        });
        destroyDesignEditor();
        mountDesignSoon(0);
        renderDesignState();
        toast(scope === 'deck' ? 'עיצוב הקרוסלה אופס' : 'עיצוב השקף אופס');
      },
      // in-place text commit on the slide — same direct-write pathway as the
      // עריכת טקסט side panel (they share the working slides copy)
      onTextChange: (key, value) => {
        commitVar(i, key, value, { delay: 800 });
        S.editAccEl = null; // the side panel rebuilds in sync next render
        if (designMode()) renderDesignState();
      },
    });
    S.designCtrlIdx = i;
    S.designEngineMissing = false;
  } catch (e) {
    S.designEngineMissing = true;
    console.warn('initEditor unavailable:', e && e.message);
  }
  if (wasMissing !== S.designEngineMissing && designMode()) renderViewer();
}

// -------------------------------------------- drag & drop photos onto the slide

// The editor's file-drop path delegates uploading here (editor.js stays
// network-free); the fresh photo also lands in the photos tab via refreshAll.
async function uploadFromEditor(file) {
  const res = await uploadPhoto({ post_id: S.post.id, pin_id: null, file, note: 'נוסף מהעורך' });
  refreshAll().catch(() => {});
  return res; // {url, row}
}

function dtHasPhotoPayload(dt) {
  if (!dt) return false;
  const types = Array.from(dt.types || []);
  return types.includes(PHOTO_DRAG_MIME) || types.includes('Files');
}

function waitForDesignCtrl(ms = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (S.designCtrl && S.designCtrlIdx === S.cur) return resolve(S.designCtrl);
      if (Date.now() - t0 > ms) return resolve(null);
      setTimeout(poll, 120);
    })();
  });
}

// Fallback drop target: the whole slide frame. When the editor is armed its
// own overlay handles drops (and stops propagation); this path catches drags
// that arrive while another tab is open — e.g. a thumbnail dragged straight
// from the תמונות tab — switches to עיצוב, waits for the editor, and places
// the extra at the drop point.
function wireFrameDrop() {
  const frame = $('frame');
  frame.addEventListener('dragover', (e) => {
    if (!hasSlidesData() || !dtHasPhotoPayload(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  frame.addEventListener('drop', (e) => {
    if (!hasSlidesData() || !dtHasPhotoPayload(e.dataTransfer)) return;
    e.preventDefault();
    const rect = slideRect();
    const xPct = (e.clientX - rect.left) / rect.width * 100;
    const yPct = (e.clientY - rect.top) / rect.height * 100;
    const url = e.dataTransfer.getData(PHOTO_DRAG_MIME) || '';
    const files = [...(e.dataTransfer.files || [])];
    handleSlideDrop({ url, files, xPct, yPct })
      .catch((err) => toast('ההוספה לשקף נכשלה: ' + (err && err.message || err), 'err'));
  });
}

async function handleSlideDrop({ url, files, xPct, yPct }) {
  if (S.tab !== 'design') showTab('design');
  const ctrl = await waitForDesignCtrl();
  if (!ctrl) {
    toast('עורך העיצוב לא נטען — נסו שוב מתוך לשונית «עיצוב»', 'err');
    return;
  }
  if (url) { ctrl.addPhotoExtra(url, xPct, yPct); return; }
  await ctrl.dropFiles(files, xPct, yPct); // upload + cascade + select, same path
}

// ---------------------------------------------------------------- pins on the image

function pinsOfSlide(i) { return S.pins.filter((p) => Number(p.slide) === i); }
function pinNumber(pin) {
  const sibs = pinsOfSlide(Number(pin.slide));
  return sibs.findIndex((p) => p.id === pin.id) + 1;
}

function setPinMode(on) {
  S.pinMode = on;
  $('pinBtn').classList.toggle('on', on);
  $('frame').classList.toggle('armed', on);
  if (!on) closePopover();
}

function renderPinLayer() {
  const layer = $('pinLayer');
  layer.replaceChildren(...pinsOfSlide(S.cur).map((pin) => {
    const dot = el('button', {
      class: 'pin-dot' + (pin.status === 'resolved' ? ' resolved' : ''),
      type: 'button',
      title: pin.body || '',
      style: { left: (pin.x * 100) + '%', top: (pin.y * 100) + '%' },
    }, String(pinNumber(pin)));
    dot.dataset.pin = pin.id;
    dot.addEventListener('click', (e) => { e.stopPropagation(); jumpToPinCard(pin); });
    return dot;
  }));
}

function flashDot(pinId) {
  const dot = $('pinLayer').querySelector(`[data-pin="${CSS.escape(pinId)}"]`);
  if (dot) { dot.classList.remove('flash'); void dot.offsetWidth; dot.classList.add('flash'); }
}

function jumpToPinCard(pin) {
  showTab('pins');
  requestAnimationFrame(() => {
    const card = document.getElementById('pin-card-' + pin.id);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
    }
  });
  flashDot(pin.id);
}

function jumpToDot(pin) {
  goTo(Number(pin.slide));
  requestAnimationFrame(() => flashDot(pin.id));
}

// pin-drop popover -------------------------------------------------

function closePopover() {
  if (S.popover) { S.popover.remove(); S.popover = null; }
}

function openPinPopover(x, y) {
  closePopover();
  const ta = el('textarea', { class: 'field__input', placeholder: 'מה חשוב לומר על הנקודה הזו?' });
  const file = el('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  const fname = el('span', { class: 'fname' });
  file.addEventListener('change', () => { fname.textContent = file.files[0] ? file.files[0].name : ''; });
  const attach = el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => file.click() }, '📎 צרף תמונה');
  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'הוסף');
  const cancel = el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => closePopover() }, 'בטל');

  save.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body) { ta.focus(); return; }
    save.disabled = true;
    try {
      const row = await addPin({ post_id: S.post.id, slide: S.cur, x, y, body });
      const f = file.files && file.files[0];
      if (f && row && row.id) {
        try { await uploadPhoto({ post_id: S.post.id, pin_id: row.id, file: f, note: '' }); }
        catch (e) { toast('ההערה נשמרה, אבל התמונה לא עלתה', 'err'); }
      }
      toast('ההערה נוספה לשקף', 'ok');
      closePopover();
      setPinMode(false);
      await refreshAll();
    } catch (e) {
      save.disabled = false;
      toast('ההערה לא נשמרה: ' + e.message, 'err');
    }
  });
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closePopover(); } });

  const pop = el('div', { class: 'pv-pop' }, ta, el('div', { class: 'row' }, attach, fname, el('span', { style: { flex: '1' } }), cancel, save), file);
  const tx = x < 0.22 ? '-12%' : x > 0.78 ? '-88%' : '-50%';
  const ty = y > 0.6 ? 'calc(-100% - 14px)' : '14px';
  Object.assign(pop.style, { left: (x * 100) + '%', top: (y * 100) + '%', transform: `translate(${tx}, 0) translateY(${ty === '14px' ? '14px' : '0'})` });
  if (ty !== '14px') pop.style.transform = `translate(${tx}, calc(-100% - 14px))`;
  pop.addEventListener('pointerdown', (e) => e.stopPropagation());
  $('frame').appendChild(pop);
  S.popover = pop;
  setTimeout(() => ta.focus(), 40);
}

// ---------------------------------------------------------------- caption

function closeCaptionEditor() {
  const t = $('capText'), e = $('capEditor'), b = $('capEditBtn');
  if (!t || !e || !b) return;   // caption tab not mounted — nothing to close
  t.hidden = false; e.hidden = true; b.hidden = false;
}

function renderCaption() {
  const t = $('capText');
  if (!t) return;               // caption lives in a tab now; may not be mounted
  if (S.post.caption) {
    t.classList.remove('pv-note');
    t.textContent = S.post.caption; // .cap-text preserves line breaks (pre-wrap)
  } else {
    t.classList.add('pv-note');
    t.textContent = 'אין עדיין כיתוב לפוסט הזה.';
  }
}

// -------------------------------------------- shared save engine (v1.5)
// Every committed change — in-place text, side-panel fields, design
// mutations — PATCHes sm_posts.slides for EVERYONE (debounced), with one
// sm_edits audit row (status 'applied') per changed field. The chip promises
// «נשמר לכולם ✓» only after the PATCH actually lands, never on the debounce.

let saveTimer = null;
let saveChipEl = null;

function setSaveChip(state) {
  if (!saveChipEl) return;
  saveChipEl.textContent =
    state === 'saving' ? 'שומר…'
    : state === 'saved' ? 'נשמר לכולם ✓'
    : state === 'err' ? 'השמירה לענן נכשלה' : '';
  saveChipEl.style.color = state === 'err' ? 'var(--no)' : 'var(--ink-soft)';
}

function scheduleSave(delay = 1500) {
  clearTimeout(saveTimer);
  setSaveChip('saving'); // pending, honestly — ✓ comes only from the PATCH
  saveTimer = setTimeout(() => { flushSave(); }, delay);
}

// conflict path (PLAN v1.5): the post moved under us → re-fetch, re-apply the
// local pending changes on top of the fresh slides, toast, save again.
function rebaseOnto(fresh) {
  let base = fresh.slides;
  if (typeof base === 'string') { try { base = JSON.parse(base); } catch { base = []; } }
  base = deepCopy(Array.isArray(base) ? base : []);
  for (const [f, ch] of [...S.pending]) {
    const m = /^slides\.(\d+)\.(.+)$/.exec(f);
    if (!m) { S.pending.delete(f); continue; }
    const s = base[+m[1]];
    if (!s) { S.pending.delete(f); continue; } // slide vanished remotely
    if (m[2] === 'design') {
      ch.old_text = s.design ? canonicalJSON(s.design) : '';
      if (ch.new_text) {
        try { s.design = JSON.parse(ch.new_text); } catch { S.pending.delete(f); continue; }
      } else {
        delete s.design;
      }
    } else {
      s.vars = s.vars || {};
      ch.old_text = String(s.vars[m[2]] ?? '');
      s.vars[m[2]] = ch.new_text;
    }
    if (ch.old_text === ch.new_text) S.pending.delete(f); // remote already has it
  }
  fresh.slides = base;
  S.post = fresh;
  S.slides = deepCopy(base);
  S.updatedAt = fresh.updated_at || null;
  // re-apply pending onto the working copy (deepCopy above took base WITH the
  // re-applied values, so S.slides already carries them)
  clearHistory(); // someone else's version is under us now — stacks are void
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (S.saveInFlight) { S.saveQueued = true; return; }
  if (!S.pending.size) { setSaveChip(''); return; }
  S.saveInFlight = true;
  setSaveChip('saving');
  try {
    let batch = new Map(S.pending); // value objects shared — rebase updates them
    let row = null;
    try {
      row = await savePostSlides(S.post.id, S.slides, { expected_updated_at: S.updatedAt });
    } catch (e) {
      if (!e || !e.conflict) throw e;
      const fresh = await getPost(S.post.id);
      rebaseOnto(fresh);
      toast('עודכן על ידי מישהו נוסף — המשכנו מעל הגרסה החדשה');
      remountAfterRemote();
      batch = new Map(S.pending);
      if (batch.size) {
        row = await savePostSlides(S.post.id, S.slides, { expected_updated_at: S.updatedAt });
      }
    }
    if (row) {
      S.updatedAt = row.updated_at || S.updatedAt;
      S.post.slides = deepCopy(S.slides);
      S.post.updated_at = S.updatedAt;
      S.sessionDirty = true;   // this session changed the post → stamp on exit
    }
    // audit log: one row per changed field, exact old→new
    const logs = [];
    for (const [f, ch] of batch) {
      const cur = S.pending.get(f);
      if (cur) {
        if (cur.new_text === ch.new_text) S.pending.delete(f);
        else cur.old_text = ch.new_text; // typed more mid-flight: next old = what we just saved
      }
      if (ch.old_text !== ch.new_text) {
        logs.push(logEdit({ post_id: S.post.id, field: f, old_text: ch.old_text, new_text: ch.new_text }));
      }
    }
    await Promise.allSettled(logs);
    if (!S.pending.size) closeUndoBatch(); // the batch landed — next commit is a new undo step
    setSaveChip(S.pending.size ? 'saving' : 'saved');
    refreshEditMarks();
    refreshAll().catch(() => {}); // history list + everything else catch up
  } catch (e) {
    console.warn('collab save failed', e);
    setSaveChip('err');
    setTimeout(() => {
      if (S.pending.size && !saveTimer && !S.saveInFlight) scheduleSave(400);
    }, 4000);
  } finally {
    S.saveInFlight = false;
    if (S.saveQueued) { S.saveQueued = false; flushSave(); }
  }
}

// after a rebase/remote adoption the mounted preview shows stale slides
function remountAfterRemote() {
  S.cur = Math.min(S.cur, slideTotal() - 1);
  S.editAccEl = null;
  destroyDesignEditor();
  S.designMountEl = null;
  renderViewer();
  renderActiveTab();
}

// v1.6 action bar — one calm row ABOVE the slide: undo/redo + save chip +
// «שכפל פוסט», plus a slot that hosts the design editor's own buttons
// (initEditor's actionBar option) while design mode is armed. Nothing
// action-like overlays the slide artwork from this page's side.
let histUndoBtn = null;
let histRedoBtn = null;
let editorBarSlot = null;
let tplSaveBtn = null;

function wireSaveChip() {
  const bar = $('actionBar');
  saveChipEl = el('span', {
    id: 'autosaveChip',
    style: {
      fontSize: '.78rem', color: 'var(--ink-soft)', minWidth: '64px',
      textAlign: 'start', whiteSpace: 'nowrap',
    },
  });
  editorBarSlot = el('span', {
    id: 'editorBarSlot',
    style: { display: 'inline-flex', alignItems: 'center' },
  });
  histUndoBtn = el('button', {
    class: 'btn btn--ghost hist-btn', type: 'button', id: 'undoBtn',
    title: 'ביטול', 'aria-label': 'ביטול', disabled: true,
  }, '↩︎');
  histRedoBtn = el('button', {
    class: 'btn btn--ghost hist-btn', type: 'button', id: 'redoBtn',
    title: 'ביצוע חוזר', 'aria-label': 'ביצוע חוזר', disabled: true,
  }, '↪︎');
  histUndoBtn.addEventListener('click', () => { undoStep(); });
  histRedoBtn.addEventListener('click', () => { redoStep(); });
  const dupBtn = el('a', {
    class: 'btn btn--ghost', id: 'dupBtn', href: pageUrl('build.html', { from: S.post.id }),
    title: 'פתיחת הפוסט בבונה הפוסטים כעותק לעריכה',
  }, 'שכפל פוסט');
  tplSaveBtn = el('button', {
    class: 'btn btn--ghost', type: 'button', id: 'dzTplBtn', hidden: true,
    title: 'שמירת השקף הנוכחי, על העיצוב שלו, כתבנית לשימוש חוזר',
  }, 'שמור כתבנית');
  tplSaveBtn.addEventListener('click', openSaveTemplateModal);
  if (bar) bar.replaceChildren(editorBarSlot, histUndoBtn, histRedoBtn, saveChipEl, tplSaveBtn, dupBtn);
  const flushNow = () => { if (saveTimer) flushSave(); };
  window.addEventListener('pagehide', () => { flushNow(); stampVersion(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushNow(); stampVersion(); }
  });
}

// -------------------------------------------- undo/redo engine (v1.6)
// Per-user, session-local stacks of {slides, caption} snapshots. A snapshot is
// pushed at each commit boundary (BEFORE the mutation), same-field commits
// fold into one step until the save batch lands, and undo/redo restore
// through the SAME save pipeline — savePostSlides + exact old→new logEdit
// rows — so an undo IS an edit in history and in the learning loop.

const HIST_DEPTH = 60; // spec: ≥50; snapshots are a few KB of JSON each

function histSnapshot() {
  return { slides: deepCopy(S.slides), caption: S.post.caption ?? '' };
}

function renderHistButtons() {
  if (histUndoBtn) histUndoBtn.disabled = histBusy || !S.undoStack.length;
  if (histRedoBtn) histRedoBtn.disabled = histBusy || !S.redoStack.length;
}

function markUndoBoundary(field, opts = {}) {
  if (S.applyingHistory) return;
  if (!opts.always && S.histBatchOpen && S.histBatchField === field) return;
  S.undoStack.push(histSnapshot());
  if (S.undoStack.length > HIST_DEPTH) S.undoStack.shift();
  S.redoStack.length = 0; // a fresh edit forks history — redo is gone
  S.histBatchOpen = true;
  S.histBatchField = field;
  renderHistButtons();
}

function closeUndoBatch() {
  S.histBatchOpen = false;
  S.histBatchField = null;
}

function clearHistory() {
  S.undoStack.length = 0;
  S.redoStack.length = 0;
  closeUndoBatch();
  renderHistButtons();
}

// group several commits (deck reset) into ONE undo step; drops the step again
// if the group turned out to be a no-op
function withOneUndoStep(key, fn) {
  markUndoBoundary(key, { always: true });
  const prev = S.applyingHistory;
  S.applyingHistory = true;
  try { fn(); } finally { S.applyingHistory = prev; }
  const top = S.undoStack[S.undoStack.length - 1];
  if (top && canonicalJSON(top.slides) === canonicalJSON(S.slides) &&
      (top.caption ?? '') === (S.post.caption ?? '')) {
    S.undoStack.pop();
    closeUndoBatch();
    renderHistButtons();
  }
}

// design structure (filled slots, extras count, hidden set): a structural
// change is its own step even inside an open design batch — the drag that
// follows a slot fill must not fold into it
function designSig(d) {
  if (!d) return '';
  return Object.keys(d.slots || {}).sort().join(',') + '|' +
    (Array.isArray(d.extras) ? d.extras.length : 0) + '|' +
    (Array.isArray(d.hidden) ? [...d.hidden].sort().join(',') : '');
}

// working copy vs saved truth → exact old→new pending rows, the same shape
// flushSave already turns into one savePostSlides PATCH + logEdit rows
function rebuildPendingFromDiff() {
  S.pending.clear();
  const saved = Array.isArray(S.post.slides) ? S.post.slides : [];
  const n = Math.max(S.slides.length, saved.length);
  for (let i = 0; i < n; i++) {
    const cur = S.slides[i] || {};
    const was = saved[i] || {};
    const keys = new Set([...Object.keys(cur.vars || {}), ...Object.keys(was.vars || {})]);
    for (const k of keys) {
      const a = String((was.vars || {})[k] ?? '');
      const b = String((cur.vars || {})[k] ?? '');
      if (a !== b) S.pending.set(`slides.${i}.${k}`, { old_text: a, new_text: b });
    }
    const da = was.design ? canonicalJSON(was.design) : '';
    const db = cur.design ? canonicalJSON(cur.design) : '';
    if (da !== db) S.pending.set(`slides.${i}.design`, { old_text: da, new_text: db });
  }
}

let histBusy = false;

function undoStep() { return stepHistory(S.undoStack, S.redoStack); }
function redoStep() { return stepHistory(S.redoStack, S.undoStack); }

async function stepHistory(from, to) {
  if (histBusy || !from.length) return;
  histBusy = true;
  renderHistButtons();
  try {
    // let the pending/in-flight batch land first — its own snapshot is
    // already on the stack, and the diff below needs a settled saved truth
    if (saveTimer) await flushSave();
    for (let i = 0; i < 100 && S.saveInFlight; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!from.length) return; // a conflict rebase cleared the stacks meanwhile
    const snap = from.pop();
    to.push(histSnapshot());
    if (to.length > HIST_DEPTH) to.shift();
    S.applyingHistory = true;
    try {
      // caption first: its own direct write + audit row (setCaption logs it)
      if ((snap.caption ?? '') !== (S.post.caption ?? '')) {
        const row = await setCaption(S.post.id, snap.caption ?? '');
        S.post.caption = snap.caption ?? '';
        if (row && row.updated_at) {
          S.post.updated_at = row.updated_at;
          if (!S.saveInFlight) S.updatedAt = row.updated_at;
        }
        renderVoteBox();
      }
      // slides: restore the snapshot and push it through the shared pipeline
      S.slides = deepCopy(snap.slides);
      rebuildPendingFromDiff();
      closeUndoBatch();
      if (S.pending.size) scheduleSave(250);
      else if (!S.saveInFlight) setSaveChip('');
      remountAfterRemote(); // same full re-render an adoption uses
    } finally {
      S.applyingHistory = false;
    }
  } catch (e) {
    console.warn('undo/redo failed', e);
    toast('הפעולה לא הצליחה: ' + (e && e.message ? e.message : e), 'err');
  } finally {
    histBusy = false;
    renderHistButtons();
  }
}

// ---------------------------------------------------------------- tabs

// v1.8: voting is not a tab (it sits above these, always visible) and design
// is not a tab either (it is a mode armed from the viewer's control row).
const TABS = [
  { key: 'caption', label: 'כיתוב' },
  { key: 'pins', label: 'הערות' },
  { key: 'edit', label: 'עריכת טקסט' },
  { key: 'photos', label: 'תמונות' },
  { key: 'info', label: 'פרטים' },
];

function buildTabs() {
  $('tabs').replaceChildren(...TABS.map((t) => {
    const b = el('button', { class: 'pv-tab', type: 'button', id: 'tab-' + t.key }, t.label);
    b.addEventListener('click', () => showTab(t.key));
    return b;
  }));
}

function showTab(key) {
  S.tab = key;
  for (const t of TABS) $('tab-' + t.key).classList.toggle('on', t.key === key);
  renderActiveTab(true);
}

// ---- design mode: armed from the viewer's control row, not from a tab ----
function setDesign(on) {
  const want = !!on && hasSlidesData();
  if (S.design === want) return;
  S.design = want;
  const b = $('designBtn');
  if (b) {
    b.classList.toggle('on', want);
    b.setAttribute('aria-pressed', want ? 'true' : 'false');
  }
  if (!want) {
    destroyDesignEditor();
    S.designMountEl = null;
  }
  renderViewer();
  renderDesignState();  // «שמור כתבנית» only shows while design is armed
}

function wireDesignBtn() {
  const b = $('designBtn');
  if (!b) return;
  b.hidden = !hasSlidesData();
  b.addEventListener('click', () => setDesign(!S.design));
}

function renderTabBadges() {
  const open = S.pins.filter((p) => p.status !== 'resolved').length;
  const tab = $('tab-pins');
  if (open) tab.replaceChildren('הערות', el('span', { class: 'pv-badge' }, String(open)));
  else tab.replaceChildren('הערות');
}

function renderActiveTab(force = false) {
  const body = $('tabBody');
  // don't clobber a form the reviewer is typing into mid-refresh
  if (!force && body.contains(document.activeElement) &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
    if (!S.pendingTabRender) {
      S.pendingTabRender = true;
      body.addEventListener('focusout', () => {
        setTimeout(() => {
          if (!S.pendingTabRender) return;
          if (body.contains(document.activeElement) &&
              /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
          S.pendingTabRender = false;
          renderActiveTab(true);
        }, 80);
      }, { once: true });
    }
    return;
  }
  S.pendingTabRender = false;
  const render = { caption: renderCaptionTab, pins: renderPinsTab, edit: renderEditTab, photos: renderPhotosTab, info: renderInfoTab }[S.tab]
    || renderCaptionTab;   // unknown/stale tab key must never throw mid-refresh
  body.replaceChildren(...[render() || []].flat(Infinity).filter(Boolean));
}

// ---------------------------------------------------------------- tab: vote

function postVoteMap() {
  return latestVotes(S.votes).get(S.post.id) || new Map();
}

// v1.8 — voting is not a tab: it sits under the title, always visible.
// Flow the operator asked for: pick כן/לא/אולי → the «why» box appears →
// «שלח הצבעה» only becomes clickable once a reason is written.
function renderVoteBox() {
  const box = $('voteBox');
  if (!box) return;
  const byAuthor = postVoteMap();
  const mine = byAuthor.get(S.me.name) || null;
  if (S.voteSel === undefined || S.voteSel === null) S.voteSel = mine ? mine.vote : null;
  if (S.voteReason === undefined) S.voteReason = mine ? (mine.reason || '') : '';

  const btns = ['yes', 'no', 'maybe'].map((v) => {
    const b = el('button', {
      class: `vb-btn ${v}` + (S.voteSel === v ? ' on' : ''),
      type: 'button', 'aria-pressed': S.voteSel === v ? 'true' : 'false',
    }, el('span', { class: 'g' }, voteGlyph(v)), VOTE_LABELS[v]);
    b.addEventListener('click', () => { S.voteSel = v; renderVoteBox(); setTimeout(() => { const t = box.querySelector('textarea'); if (t) t.focus(); }, 0); });
    return b;
  });

  const kids = [el('div', { class: 'vb-row' }, btns)];

  if (S.voteSel) {
    const reason = el('textarea', {
      class: 'field__input', placeholder: 'למה? כמה מילים — זה החלק שעוזר לצוות',
    });
    reason.value = S.voteReason || '';
    const submit = el('button', { class: 'btn btn--primary', type: 'button', disabled: true }, 'שלח הצבעה');
    const hint = el('span', { class: 'vb-hint' }, 'כדי לשלוח, כתבו למה');
    const sync = () => {
      S.voteReason = reason.value;
      const ok = reason.value.trim().length > 0;
      submit.disabled = !ok;
      hint.textContent = ok
        ? (mine ? 'הצבעה חדשה מחליפה את הקודמת שלכם' : '')
        : 'כדי לשלוח, כתבו למה';
    };
    reason.addEventListener('input', sync);
    submit.addEventListener('click', async () => {
      const why = reason.value.trim();
      if (!why) return;
      submit.disabled = true;
      try {
        await castVote({ post_id: S.post.id, vote: S.voteSel, reason: why });
        toast('ההצבעה נשמרה', 'ok');
        await refreshAll();
      } catch (e) {
        toast('ההצבעה לא נשמרה: ' + e.message, 'err');
        submit.disabled = false;
      }
    });
    kids.push(el('div', { class: 'vb-why' }, reason));
    kids.push(el('div', { class: 'vb-actions' }, submit, hint));
    sync();
  } else {
    kids.push(el('div', { class: 'vb-hint', style: { marginTop: '10px' } },
      'בוחרים כן, לא או אולי — ואז מסבירים למה.'));
  }

  const tallies = { yes: 0, no: 0, maybe: 0 };
  const voters = [];
  for (const [author, v] of byAuthor) {
    if (tallies[v.vote] !== undefined) tallies[v.vote]++;
    voters.push({ author, ...v });
  }
  voters.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  kids.push(el('div', { class: 'vb-tally' },
    el('span', null, voteGlyph('yes'), ' ', el('b', null, String(tallies.yes))),
    el('span', null, voteGlyph('no'), ' ', el('b', null, String(tallies.no))),
    el('span', null, voteGlyph('maybe'), ' ', el('b', null, String(tallies.maybe))),
    el('span', { class: 'vb-hint', style: { marginInlineStart: 'auto' } },
      byAuthor.size ? `${byAuthor.size} הצביעו` : 'עוד אין הצבעות'),
  ));
  if (voters.length) {
    kids.push(el('div', { class: 'vb-mine' },
      voters.map((v) => el('div', { class: 'voter' },
        el('span', { class: 'who' }, v.author),
        el('span', { class: 'v-' + v.vote }, voteGlyph(v.vote) + ' ' + (VOTE_LABELS[v.vote] || v.vote)),
        el('time', null, fmtDate(v.created_at)),
        v.reason ? el('span', { class: 'why' }, v.reason) : null,
      ))));
  }
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- tab: pins

function renderPinsTab() {
  if (!S.pins.length) {
    return [el('div', { class: 'pv-note' },
      'אין עדיין הערות על השקפים. לוחצים על «📍 הוסף הערה על השקף», ואז על הנקודה המדויקת בשקף.')];
  }
  const bySlide = new Map();
  for (const p of S.pins) {
    const k = Number(p.slide);
    if (!bySlide.has(k)) bySlide.set(k, []);
    bySlide.get(k).push(p);
  }
  const groups = [];
  for (const [slideIdx, pins] of [...bySlide.entries()].sort((a, b) => a[0] - b[0])) {
    const h = el('h4', { title: 'מעבר לשקף' }, `שקף ${slideIdx + 1}`, el('span', { class: 'tag' }, String(pins.length)));
    h.addEventListener('click', () => goTo(slideIdx));
    groups.push(el('div', { class: 'pin-group' }, h, pins.map(renderPinCard)));
  }
  return groups;
}

function renderPinCard(pin) {
  const num = el('span', { class: 'num', title: 'הצגה על השקף' }, String(pinNumber(pin)));
  num.addEventListener('click', () => jumpToDot(pin));
  const jump = el('button', { class: 'btn btn--ghost jump', type: 'button', onclick: () => jumpToDot(pin) }, 'הצג על השקף');

  const photos = S.photos.filter((ph) => ph.pin_id === pin.id);
  const thumbs = photos.length
    ? el('div', { class: 'thumbs' }, photos.map((ph) => {
        const img = el('img', { src: photoUrl(ph), alt: ph.note || 'תמונה מצורפת', loading: 'lazy' });
        img.addEventListener('click', () => openPhotoModal(ph));
        return img;
      }))
    : null;

  const replies = S.repliesByPin.get(pin.id) || [];
  const repliesEl = replies.length
    ? el('div', { class: 'replies' }, replies.map((r) => el('div', { class: 'reply' },
        el('span', { class: 'who' }, r.author || 'אלמוני'), ' ',
        el('time', null, fmtDate(r.created_at)),
        el('div', { class: 'body' }, r.body),
      )))
    : null;

  const rInput = el('input', { class: 'field__input', type: 'text', placeholder: 'תגובה…' });
  const rSend = el('button', { class: 'btn btn--ghost', type: 'button' }, 'שלח');
  const sendReply = async () => {
    const body = rInput.value.trim();
    if (!body) return;
    rSend.disabled = true;
    try {
      await addReply({ pin_id: pin.id, body });
      rInput.value = '';
      await refreshAll();
      renderActiveTab(true); // own action: show the reply even if the input still has focus
    } catch (e) {
      toast('התגובה לא נשלחה: ' + e.message, 'err');
    } finally {
      rSend.disabled = false;
    }
  };
  rSend.addEventListener('click', sendReply);
  rInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendReply(); });

  const resolved = pin.status === 'resolved';
  const resolveBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, resolved ? 'פתיחה מחדש' : 'סמן כטופל');
  resolveBtn.addEventListener('click', async () => {
    try {
      await resolvePin(pin.id, resolved ? 'open' : 'resolved');
      toast(resolved ? 'ההערה נפתחה מחדש' : 'סומן כטופל', 'ok');
      await refreshAll();
    } catch (e) { toast('לא הצליח: ' + e.message, 'err'); }
  });

  const mine = pin.author_id && S.me.author_id && pin.author_id === S.me.author_id;
  const delBtn = el('button', { class: 'btn btn--ghost del', type: 'button' }, 'מחק');
  delBtn.addEventListener('click', async () => {
    if (mine) {
      if (!confirm('למחוק את ההערה?')) return;
    } else {
      if (!confirm(`ההערה הזו של ${pin.author || 'מישהו אחר'}. למחוק הערה של מישהו אחר?`)) return;
      if (!confirm('בטוח? מחיקה היא סופית — גם התגובות שתחתיה יימחקו.')) return;
    }
    try {
      await deletePin(pin.id);
      toast('ההערה נמחקה');
      await refreshAll();
    } catch (e) { toast('המחיקה נכשלה: ' + e.message, 'err'); }
  });

  return el('div', { class: 'pin-card' + (resolved ? ' resolved' : ''), id: 'pin-card-' + pin.id },
    el('div', { class: 'head' },
      num,
      el('span', { class: 'who' }, pin.author || 'אלמוני'),
      el('time', null, fmtDate(pin.created_at)),
      resolved ? el('span', { class: 'tag' }, 'סומן כטופל') : null,
      jump,
    ),
    el('div', { class: 'body' }, pin.body),
    thumbs,
    repliesEl,
    el('div', { class: 'replybox' }, rInput, rSend),
    el('div', { class: 'foot' }, resolveBtn, delBtn),
  );
}

// ---------------------------------------------------------------- tab: edit text

function editableVars(vars) {
  return Object.entries(vars || {}).filter(([k, v]) =>
    typeof v === 'string' &&
    v.trim().length >= 3 &&
    k !== 'ill' &&
    !/^(ill|img|image|photo|icon|src)/i.test(k));
}

function buildEditAccordion() {
  const acc = el('div', { class: 'ed-acc' });
  S.slides.forEach((slide, i) => {
    const fields = editableVars(slide.vars);
    if (!fields.length) return;
    const modCount = el('span', { class: 'tag mod-count', style: { display: 'none' } }, '');
    const fieldEls = fields.map(([key, val]) => {
      const ta = el('textarea', { class: 'field__input', rows: String(Math.min(10, Math.max(2, Math.ceil(String(val).length / 42)))) });
      ta.value = String(val);
      const wrap = el('div', { class: 'ed-field' },
        el('label', null, el('span', { class: 'mod-dot' }), el('span', { class: 'key' }, key)),
        ta,
      );
      wrap.dataset.slide = String(i);
      wrap.dataset.key = key;
      const sync = () => {
        const savedVars = ((S.post.slides || [])[i] || {}).vars || {};
        // «modified» now means: committed locally, PATCH not landed yet
        wrap.classList.toggle('modified', ta.value !== String(savedVars[key] ?? ''));
        updateEditCounts(acc);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 2 + 'px';
      };
      ta.addEventListener('input', () => {
        commitVar(i, key, ta.value); // direct write, debounced save to everyone
        sync();
        if (S.live) {
          if (S.cur !== i) goTo(i); // preview follows the field being edited
          mountPreviewSoon(300);    // the wow moment: types → preview updates
        }
      });
      sync();
      return wrap;
    });
    acc.appendChild(el('details', { open: i === 0 ? true : null },
      el('summary', null,
        `שקף ${i + 1}`,
        el('span', { class: 'tpl' }, slide.template || ''),
        modCount,
      ),
      el('div', { class: 'fields' }, fieldEls),
    ));
  });
  return acc;
}

function updateEditCounts(acc) {
  acc.querySelectorAll('details').forEach((d) => {
    const n = d.querySelectorAll('.ed-field.modified').length;
    const tag = d.querySelector('.mod-count');
    if (tag) { tag.style.display = n ? '' : 'none'; tag.textContent = n ? `${n} נשמרים…` : ''; }
  });
}

// after a save lands (or a remote adoption), clear stale «modified» marks
// without rebuilding the accordion (the reviewer may still be typing)
function refreshEditMarks() {
  if (!S.editAccEl) return;
  S.editAccEl.querySelectorAll('.ed-field').forEach((wrap) => {
    const i = Number(wrap.dataset.slide);
    const key = wrap.dataset.key;
    const ta = wrap.querySelector('textarea');
    if (!ta || !key) return;
    const savedVars = ((S.post.slides || [])[i] || {}).vars || {};
    wrap.classList.toggle('modified', ta.value !== String(savedVars[key] ?? ''));
  });
  updateEditCounts(S.editAccEl);
}

function renderEditTab() {
  if (!hasSlidesData()) {
    return [el('div', { class: 'pv-note' }, 'לפוסט הזה אין נתוני מקור לעריכה — אפשר להשאיר הערות בלשונית «הערות».')];
  }
  if (!S.editAccEl) S.editAccEl = buildEditAccordion();

  const out = [
    el('div', { class: 'pv-note' },
      'עורכים את הטקסט של כל שקף ורואים כל שינוי על השקף תוך כדי הקלדה. ' +
      'כל שינוי נשמר אוטומטית לכל הצוות — אין צורך לשלוח.'),
    S.editAccEl,
    renderEditHistory(),
  ];
  requestAnimationFrame(() => updateEditCounts(S.editAccEl));
  return out;
}

function fieldLabel(field) {
  if (field === 'caption') return 'כיתוב הפוסט';
  if (field === 'title') return 'כותרת';
  const m = /^slides\.(\d+)\.(.+)$/.exec(field || '');
  if (m) return `שקף ${Number(m[1]) + 1} · ${m[2]}`;
  return field || '';
}

function isDesignEdit(ed) {
  return /^slides\.\d+\.design$/.test(ed.field || '');
}

// v1.5: the proposal/triage list is gone — edits apply immediately, and this
// is the read-only audit trail: «היסטוריית עריכות», newest first, everything
// (text, caption, design), author + field + exact old→new. No buttons.
function renderEditHistory() {
  const edits = [...S.edits]
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!edits.length) return el('div', { class: 'ed-props' });
  return el('div', { class: 'ed-props' },
    el('h4', null, `היסטוריית עריכות (${edits.length})`),
    edits.map((ed) => {
      const design = isDesignEdit(ed);
      const m = /^slides\.(\d+)\./.exec(ed.field || '');
      const nameEl = el('span', { class: 'field-name', title: m ? 'מעבר לשקף' : '' }, fieldLabel(ed.field));
      if (m) { nameEl.style.cursor = 'pointer'; nameEl.addEventListener('click', () => goTo(Number(m[1]))); }
      // legacy rows from the proposal era keep an honest status chip
      const legacy = ed.status && ed.status !== 'applied'
        ? el('span', { class: 'st-chip st-chip--' + ed.status }, EDIT_STATUS_LABELS[ed.status] || ed.status)
        : null;
      return el('div', { class: 'ed-prop' },
        el('div', { class: 'head' },
          nameEl,
          el('span', null, ed.author || 'אלמוני'),
          el('time', null, fmtDate(ed.created_at)),
          legacy,
        ),
        el('span', { class: 'diff-old' }, design ? designSummary(ed.old_text) : (ed.old_text || '—')),
        el('span', { class: 'diff-new' }, design ? designSummary(ed.new_text) : (ed.new_text || '—')),
        design ? el('details', { class: 'dz-raw' },
          el('summary', null, 'JSON מלא'),
          el('pre', null, ed.new_text || '(איפוס)'),
        ) : null,
      );
    }),
  );
}

// ---------------------------------------------------------------- tab: design

// The slide's current design — straight from the shared working copy.
function currentWorkingDesign(i) {
  const slide = S.slides[i];
  return (slide && slide.design) || null;
}

function designNonEmpty(d) {
  return !!d && typeof d === 'object' && !!(
    Object.keys(d.blocks || {}).length ||
    (Array.isArray(d.extras) && d.extras.length) ||
    d.bg ||
    (d.slots && Object.keys(d.slots).length) ||
    (Array.isArray(d.hidden) && d.hidden.length));
}

// v1.5: no send state — the design tab saves continuously. This only keeps
// the «שמור כתבנית» button in sync with the current slide's design.
function renderDesignState() {
  const tplBtn = document.getElementById('dzTplBtn');
  if (tplBtn) tplBtn.hidden = !(designMode() && designNonEmpty(currentWorkingDesign(S.cur)));
}

function renderCaptionTab() {
  const capText = el('div', { class: 'cap-text', id: 'capText' });
  const capTa = el('textarea', { class: 'field__input', id: 'capTa' });
  const capSaveBtn = el('button', { class: 'btn btn--primary', type: 'button', id: 'capSave' }, 'שמור');
  const capCancelBtn = el('button', { class: 'btn btn--ghost', type: 'button', id: 'capCancel' }, 'בטל');
  const capEditor = el('div', { id: 'capEditor', hidden: true },
    capTa, el('div', { class: 'cap-actions' }, capSaveBtn, capCancelBtn));
  const capEditBtn = el('button', { class: 'btn btn--ghost', type: 'button', id: 'capEditBtn' }, 'ערוך');

  capEditBtn.addEventListener('click', () => {
    capTa.value = S.post.caption || '';
    capText.hidden = true;
    capEditor.hidden = false;
    capEditBtn.hidden = true;
    capTa.focus();
  });
  capCancelBtn.addEventListener('click', () => closeCaptionEditor());
  capSaveBtn.addEventListener('click', async () => {
    const val = capTa.value;
    capSaveBtn.disabled = true;
    const marked = val !== (S.post.caption || '');
    if (marked) markUndoBoundary('caption', { always: true });
    try {
      const row = await setCaption(S.post.id, val); // direct write + audit row
      S.post.caption = val;
      if (row && row.updated_at) {
        S.post.updated_at = row.updated_at;
        if (!S.saveInFlight) S.updatedAt = row.updated_at;
      }
      S.sessionDirty = true;
      toast('הכיתוב נשמר לכולם', 'ok');
      closeCaptionEditor();
      renderVoteBox();
    } catch (e) {
      if (marked) { S.undoStack.pop(); closeUndoBatch(); renderHistButtons(); }
      toast('הכיתוב לא נשמר: ' + e.message, 'err');
    } finally {
      capSaveBtn.disabled = false;
    }
  });

  const card = el('div', { class: 'pv-caption', id: 'captionCard' },
    el('div', { class: 'cap-head' },
      el('span', { class: 'cap-label' }, 'הכיתוב שיפורסם עם הפוסט'),
      capEditBtn),
    capText, capEditor);
  requestAnimationFrame(renderCaption);
  return [card];
}

// «שמור כתבנית» — capture the slide's base template + current working design
// + its vars (with any uncommitted in-place text) as a derived template the
// builder's picker lists under «תבניות שלכם».
function openSaveTemplateModal() {
  const i = S.cur;
  const slide = S.slides[i];
  const design = currentWorkingDesign(i); // the now-current shared design
  if (!slide || !designNonEmpty(design)) {
    toast('אין עיצוב לשמירה בשקף הזה — קודם מעצבים אותו', 'err');
    return;
  }
  // sample vars = the working slide's vars (they already carry every edit)
  const vars = { ...(slide.vars || {}) };

  const input = el('input', {
    class: 'field__input', type: 'text', maxlength: '80',
    value: (S.post.title || S.post.id) + ' — שקף ' + (i + 1),
  });
  const persist = async (name) => {
    try {
      await saveTemplate({
        name,
        base_template: slide.template,
        design,
        sample_vars: vars,
        source_post: S.post.id,
      });
      const t = toast('התבנית נשמרה — ', 'ok');
      t.style.pointerEvents = 'auto';
      t.appendChild(el('a', {
        href: pageUrl('build.html'),
        style: { color: '#fff', textDecoration: 'underline' },
      }, 'לבונה הפוסטים ←'));
    } catch (e) {
      toast('התבנית לא נשמרה: ' + e.message, 'err');
    }
  };
  const submit = (close) => {
    const name = input.value.trim();
    if (!name) { input.focus(); return false; }
    persist(name);
    if (close) close();
    return true;
  };
  const m = modal('שמירת השקף כתבנית',
    el('div', { class: 'field' },
      el('label', { class: 'field__label' },
        'איך נקרא לתבנית? היא תופיע בבונה הפוסטים תחת «תבניות שלכם»'),
      input,
    ),
    { actions: [
      { label: 'ביטול' },
      { label: 'שמירה', primary: true, onClick: () => submit() },
    ] },
  );
  // the design editor's floating toolbar is fixed at z-index 1200–1300 —
  // this modal opens while a block may still be selected, so lift it above
  m.root.style.zIndex = '1400';
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
  setTimeout(() => input.select(), 60);
}

// ---------------------------------------------------------------- tab: photos

function openPhotoModal(row) {
  const img = el('img', { src: photoUrl(row), alt: row.note || 'תמונה', style: { maxWidth: '100%', maxHeight: '70vh', borderRadius: '10px', display: 'block', margin: '0 auto' } });
  modal(row.note || 'תמונה', el('div', null,
    img,
    el('div', { class: 'pv-note', style: { marginTop: '10px' } },
      (row.author ? `העלה: ${row.author} · ` : '') + fmtDate(row.created_at)),
  ));
}

function renderPhotosTab() {
  const note = el('input', { class: 'field__input', type: 'text', placeholder: 'הערה לתמונה (לא חובה)…' });
  const file = el('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  const drop = el('div', { class: 'ph-drop' },
    el('div', { style: { fontSize: '1.5rem' } }, '🖼️'),
    el('div', null, 'גוררים לכאן תמונות, או לוחצים לבחירה'),
    el('div', { class: 'pv-note', style: { marginTop: '6px' } },
      'כאן מעלים תמונות אמיתיות שתרצו שישולבו בפוסט — צילומים מהשטח, רפרנסים והשראה.'),
  );
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    uploadFiles([...(e.dataTransfer.files || [])].filter((f) => /^image\//.test(f.type)), note.value.trim());
  });
  file.addEventListener('change', () => uploadFiles([...file.files], note.value.trim()));

  async function uploadFiles(files, noteText) {
    if (!files.length) return;
    for (const f of files) {
      try {
        await uploadPhoto({ post_id: S.post.id, pin_id: null, file: f, note: noteText });
        toast('התמונה עלתה', 'ok');
      } catch (e) {
        toast(`ההעלאה של ${f.name} נכשלה: ${e.message}`, 'err');
      }
    }
    note.value = '';
    await refreshAll();
    renderActiveTab(true); // own action: show the new photo even if an input still has focus
  }

  const cards = S.photos.map((ph) => {
    const img = el('img', { src: photoUrl(ph), alt: ph.note || 'תמונה', loading: 'lazy', draggable: 'true' });
    img.addEventListener('click', () => openPhotoModal(ph));
    // draggable onto the slide: carries the public URL; dropping on the frame
    // switches to עיצוב and places a photo extra at the drop point
    img.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(PHOTO_DRAG_MIME, photoUrl(ph));
      e.dataTransfer.effectAllowed = 'copy';
    });
    const pin = ph.pin_id ? S.pins.find((p) => p.id === ph.pin_id) : null;
    const pinRef = pin
      ? el('span', { class: 'pin-ref', title: 'מעבר להערה' }, `📍 מוצמדת להערה ${pinNumber(pin)} בשקף ${Number(pin.slide) + 1}`)
      : null;
    if (pinRef) pinRef.addEventListener('click', () => jumpToPinCard(pin));
    return el('div', { class: 'ph-card' },
      img,
      el('div', { class: 'meta' },
        ph.note ? el('span', { class: 'note' }, ph.note) : null,
        el('span', null, (ph.author ? ph.author + ' · ' : '') + fmtDate(ph.created_at)),
        pinRef,
      ),
    );
  });

  return [
    drop,
    el('div', { class: 'ph-note-row' }, note),
    file,
    cards.length
      ? el('div', { class: 'ph-grid' }, cards)
      : el('div', { class: 'pv-note' }, 'אין עדיין תמונות לפוסט הזה.'),
  ];
}

// ---------------------------------------------------------------- tab: info

function renderInfoTab() {
  const stageSel = el('select', { class: 'field__input' },
    STAGES.map((s) => {
      const o = el('option', { value: s.key }, s.label);
      if (s.key === S.post.stage) o.selected = true;
      return o;
    }));
  stageSel.addEventListener('change', async () => {
    const prev = S.post.stage;
    try {
      await setStage(S.post.id, stageSel.value);
      S.post.stage = stageSel.value;
      toast('השלב עודכן: ' + stageLabel(stageSel.value), 'ok');
      renderHeader();
      renderActiveTab(true); // publish block appears/disappears with the stage
    } catch (e) {
      stageSel.value = prev;
      toast('השלב לא עודכן: ' + e.message, 'err');
    }
  });

  const rows = [
    ['קטגוריה', categoryLabel(S.post.category)],
    ['מקור', S.post.origin === 'builder' ? 'נבנה בכלי' : 'מפעל התוכן'],
    ['גרסה', S.post.version || '—', true],
    ['מספר שקפים', String(slideTotal())],
    ['נוצר', fmtDate(S.post.created_at)],
    ['מזהה', S.post.id, true],
  ].map(([k, v, ltr]) => el('div', { class: 'dt-row' },
    el('span', { class: 'k' }, k),
    el('span', { class: 'v' + (ltr ? ' ltr' : '') }, v),
  ));

  const canQueue = S.post.stage === 'approved' || S.post.stage === 'complete';
  let publishBlock = null;
  if (canQueue) {
    const ch = el('select', { class: 'field__input' },
      Object.entries(CHANNEL_LABELS).map(([v, l]) => el('option', { value: v }, l)));
    const pNote = el('input', { class: 'field__input', type: 'text', placeholder: 'הערה למפרסם (לא חובה)…' });
    const qBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'הוסף לתור הפרסום');
    qBtn.addEventListener('click', async () => {
      qBtn.disabled = true;
      try {
        await queuePublish({ post_id: S.post.id, channel: ch.value, note: pNote.value.trim() });
        toast('נוסף לתור הפרסום', 'ok');
        pNote.value = '';
      } catch (e) {
        toast('לא נוסף לתור: ' + e.message, 'err');
      } finally {
        qBtn.disabled = false;
      }
    });
    publishBlock = el('div', { class: 'dt-publish' },
      el('b', null, 'פרסום'),
      el('span', { class: 'pv-note' }, 'הפוסט מאושר — אפשר להוסיף אותו לתור הפרסום.'),
      el('div', { class: 'dt-stage' }, ch, qBtn),
      pNote,
    );
  }

  // «שכפל פוסט» moved to the action bar above the slide (v1.6); prev/next +
  // «לגלריה» moved to the header's .pv-nav (v1.7) — no duplicate navigation here.
  return [
    el('div', { class: 'dt-stage' }, el('span', { class: 'pv-note' }, 'שלב:'), stageSel),
    el('div', { class: 'dt-rows' }, rows),
    publishBlock,
  ];
}

// ---------------------------------------------------------------- keyboard

function onKeydown(e) {
  const t = e.target;
  // native text undo owns inputs/textareas/contentEditable until commit
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redoStep(); else undoStep();
    return;
  }
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.cur + 1); }       // leftward = forward (RTL)
  else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(S.cur - 1); }
  else if (e.key === 'Escape') {
    if (S.popover) closePopover();
    else if (S.pinMode) setPinMode(false);
  }
}
