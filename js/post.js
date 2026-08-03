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
  setStage, setCaption, setReviewAt,
  listPhotos, uploadPhoto, photoUrl,
  listAssets, uploadAsset, assetRowUrl,
  queuePublish, listQueue, rescheduleQueue, setQueueStatus, subscribe,
  savePostSlides, logEdit,
  saveTemplate,
  saveVersion, listVersions,
  // v2.3 marketing sign-off + review rounds + uploaded re-renders
  getRole, currentVnum, approvalState, contentHash,
  approvePost, revokeApproval, listApprovals, uploadRenderVersion,
  // v2.5 «איך זה נוצר» (spec 08) — the request rows behind a generated post
  listGenRequests,
  // v2.5.1 slide export (spec 10 §D-2) — the download modal's «גודל» beyond
  // 1080 is a REQUEST on the same queue, fulfilled by scripts/fulfill.mjs.
  createGenRequest, getGenRequest, GEN_DIMS, GEN_STATUS_LABELS,
  // v2.9 photo editing (spec 12) — «הסרת רקע» in the design editor. The editor
  // never talks to store.js, so the host passes this in as opts.removeBackground.
  removeBackground,
  // v2.10 (delete + folders): a reviewer may remove a photo from this post's
  // תמונות tab. SOFT — a `deleted_at` stamp, never a row drop and never a
  // storage delete. The bytes are what an already-designed slide points at by
  // public URL, and an approved carousel must not break because someone tidied
  // up afterwards.
  deletePhoto, restorePhoto,
} from './store.js';
// v2.5: the ONE renderer for the transparency block, shared with
// create-ai.html. Importing that module here is safe by construction — its
// page boot is guarded on an element only create-ai.html has.
import { mountHowMade } from './create-ai.js';
import {
  el, modal, toast, fmtDate, fmtWhen, toLocalInput, fromLocalInput, voteGlyph,
  stageLabel, categoryLabel, STAGES, navBar, zoomControl, uploadProgress,
  undoToast, UNDO_MS,
} from './ui.js';
import { initCompose, mountSlide, manifest, composeSlideHTML } from './compose.js';
// v2.3 «English translation panel» — the ONE hash implementation, shared
// verbatim with scripts/ingest.mjs and the factory's studio/translate.mjs.
// Never re-implement it here: two implementations is precisely the
// "silently stale" failure this module exists to prevent.
import { fieldHash } from './thash.js';
import { initEditor, canonicalJSON, designSummary, PHOTO_DRAG_MIME } from './editor.js';
// v2.5 «יצירת תמונות» (spec 07). MOUNT ONLY — every line of that tab's logic,
// state, canvas work and DOM lives in generate.js, which owns its own
// persistent root so an in-flight generation survives a tab switch. This file
// must not learn what a fal model is.
import { generateTab } from './generate.js';

// v2.9 (spec 12): «הסרת רקע» runs in the generate Edge Function, which is the
// only thing holding FAL_KEY — there is no local equivalent. Read straight off
// the URL, the same signal initStore() itself reads and the same way
// generate.js decides (IS_LOCAL there); this file only needs it to withhold a
// button that could not work rather than let someone press it.
const IS_LOCAL_BOARD = new URLSearchParams(location.search).get('local') === '1';
// v2.6 phone-proofing: the תמונות tab is the single most likely place a
// therapist uploads straight off a phone, so it snapshots picked Files before
// anything reads them. Re-encoding for the bucket happens in store.js.
import { snapshotFiles, batchTooBig, summarizeFailures } from './imgprep.js';

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
  // compose booted (tokens+manifest) is NOT compose painted — the first
  // slide's template/SVG fetches are still in flight at composeReady. The PNG
  // layer stays on top until this flips (first successful mountSlide into
  // composeHost), or the reviewer sees a white frame for the whole fetch.
  composeMounted: false,
  votes: [],
  pins: [],
  repliesByPin: new Map(),
  edits: [],
  photos: [],
  assets: [],           // v2.0 board-wide asset library (sm_assets rows)
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
  // v2.1 scheduling: this post's sm_publish rows (all statuses, newest first).
  // Only 'queued' rows are a live schedule; the rest are history the modal
  // shows so a reviewer can see a post already went out.
  queue: [],
  // v2.3 marketing sign-off: this post's sm_approvals rows (newest first) and
  // its sm_post_versions rows. Together with S.post they are the three inputs
  // approvalState() derives from — never a stored «is approved» flag (I1/I2).
  approvals: [],
  versionRows: [],
  // v2.3 «English»: the READ-ONLY translation view is a TAB (operator change,
  // 08-01), so its open/closed state is just `S.tab === 'trans'` — there is no
  // second flag and no mode to keep mutually exclusive with design mode.
  // Deliberately NOT a key in S.pending and NOT part of histSnapshot(): the
  // panel has nothing to save and nothing to undo.
};

const params = new URLSearchParams(location.search);

function pageUrl(page, extra = {}) {
  const p = new URLSearchParams();
  p.set('board', S.board.board_key);
  if (S.board.local) p.set('local', '1');
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return page + '?' + p.toString();
}

// v2.3: `slide_count` is the STUDIO's count and NOTHING on the board updates
// it (anon holds no update grant on that column — see schema.sql:252/387), so
// on any post carrying board slides it is stale in BOTH directions. The
// earlier `Math.max` fixed only the GROW case and invented a shrink bug: two
// uploaded slides on a `slide_count:5` post produced three ghost slides with
// dots, arrows and a pin layer over pre-upload studio artwork.
//
// The rule that is correct in both directions: when the board carries slide
// DATA, that array IS the render source and its length is the only honest
// total. `slide_count` is the fallback for render-only posts (studio PNGs via
// asset_prefix, no slides array) and for nothing else. For every ordinary
// studio post the two agree and this is a no-op.
function hasSlidesData() {
  return Array.isArray(S.slides) && S.slides.length > 0;
}
function slideTotal() {
  if (hasSlidesData()) return S.slides.length;
  return Number(S.post.slide_count) || 1;
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
  // v2.3: the role chip lives in navBar (ui.js) and dispatches this — the
  // header's sign-off shortcut appears/disappears with the declared hat
  // WITHOUT a reload. Nothing else about the page changes: the same action
  // stays reachable from the פרטים tab for every role and for none.
  window.addEventListener('smr:role', () => renderApprovalBar());

  wireZoom();

  // Builder posts — and v2.5 generated posts — may have no PNG renders at all.
  // There is nothing to do here any more: since v1.7 live compose is not a mode
  // anyone turns on. renderViewer() DERIVES S.live from hasSlidesData() +
  // composeReady, and bootCompose() starts itself.
  //
  // FIX (v2.5 — outside spec 08's lane, but spec 08 is dead without it): this
  // line used to call `setLive(true, { silent: true })`, a function v1.7
  // deleted. It threw «setLive is not defined» inside boot()'s try, so EVERY
  // post with slides and no asset_prefix — every builder post, and every
  // AI-generated post — rendered «משהו השתבש בטעינת הפוסט» instead of the post.
  // Reproduced on the committed v2.3 tree (git show HEAD:js/post.js:201), so it
  // predates both the spec-07 and spec-08 builds. Its twin, the dead
  // `setLive(false)` in mountPreviewSoon()'s catch, is fixed the same way.
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
  const [post, votes, pins, edits, photos, assets, queue, approvals, versions] = await Promise.all([
    getPost(pid).catch(() => null),
    listVotes().catch(() => []),
    listPins(pid).catch(() => []),
    listEdits(pid).catch(() => []),
    listPhotos(pid).catch(() => []),
    // the library is board-wide, so a miss here (e.g. sm_assets not applied
    // yet on an older board) must degrade to "no library", never to a broken
    // post page — the picker falls back to manifest + photos on its own.
    listAssets().catch(() => []),
    // the queue is board-wide and filtered here; a miss (older board without
    // sm_publish reachable) degrades to "no schedule", never to a broken page
    listQueue().catch(() => []),
    // v2.3: sm_approvals inserts never reach anon Realtime subscribers, so the
    // ONLY thing that flips another open client's chip to stale is this poll —
    // approvals AND versions have to ride every refresh, not just adoptPost().
    listApprovals(pid).catch(() => []),
    listVersions(pid).catch(() => []),
  ]);
  S.approvals = Array.isArray(approvals) ? approvals : [];
  S.versionRows = Array.isArray(versions) ? versions : [];
  S.queue = (Array.isArray(queue) ? queue : [])
    .filter((q) => q.post_id === pid)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (post) {
    const capEd = $('capEditor');
    const capOpen = !!capEd && !capEd.hidden;
    applyRemotePost(post);
    renderHeader();                 // renderHeader() re-renders the schedule bar
    if (!capOpen) renderCaption();
  } else {
    renderScheduleBar();            // post row unreadable this tick — queue still refreshed
    renderApprovalBar();
  }
  S.votes = votes;
  if (typeof renderVoteBox === 'function') setTimeout(renderVoteBox, 0);
  S.pins = pins.slice().sort((a, b) =>
    (a.slide - b.slide) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  S.edits = edits;
  S.photos = photos;
  S.assets = assets;
  if (S.designCtrl) {
    S.designCtrl.setPhotos(designPhotos());
    if (S.designCtrl.setAssets) S.designCtrl.setAssets(designAssets());
  }

  const reps = await Promise.all(S.pins.map((p) => listReplies(p.id).catch(() => [])));
  S.repliesByPin = new Map(S.pins.map((p, i) => [p.id, reps[i]]));

  renderPinLayer();
  renderTabBadges();
  renderActiveTab();
  // v2.3 — the panel's staleness is derived from the CURRENT working copy, so
  // it has to be recomputed whenever that copy or the stored translation could
  // have moved. A no-op while the panel is closed.
  renderTransPanel();
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
  renderTransPanel();   // v2.3 — another device's Hebrew is under us now
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
    el('span', { class: 'tag' }, stageTagText()),
    S.post.version ? el('span', { class: 'tag', style: { direction: 'ltr' } }, S.post.version) : null,
    el('span', { class: 'tag' }, `${slideTotal()} שקפים`),
  );
  renderScheduleBar();
  renderApprovalBar();
  renderHowMade();
  renderPostNav();
}

// ------------------------------------------------- «איך זה נוצר» (v2.5, 08)
// Deliberately tiny here: post.js MOUNTS, create-ai.js RENDERS. The whole
// footprint on this page is this function, the import, and one div in
// post.html — a second copy of the transparency block would be a second thing
// to keep true.
//
// The request rows are fetched at most once per page load, and only for a post
// that says it was generated (origin 'ai'); an ordinary post never pays for
// this at all. A failure degrades to "no block", never to a broken header.
let howMadePromise = null;
function renderHowMade() {
  const slot = $('pvHowMade');
  if (!slot) return;
  if (!S.post || S.post.origin !== 'ai') { slot.replaceChildren(); return; }
  if (!howMadePromise) howMadePromise = listGenRequests().catch(() => []);
  howMadePromise.then((rows) => {
    if (S.post && S.post.origin === 'ai') mountHowMade(slot, S.post, rows);
  });
}

// I4 — the stage is a LANE, never a signature. Wherever «מאושר» shows without a
// fresh sm_approvals row, it has to say so in the same breath, or a manual
// stage flip reads as marketing having signed something.
function stageTagText() {
  const base = stageLabel(S.post.stage);
  if (S.post.stage !== 'approved') return base;
  return approvalNow().status === 'fresh' ? base : 'מאושר · ללא חתימת שיווק';
}

// ------------------------------------------------------------- scheduling
// v2.1. «תזמון» is a first-class action, not a tab: one button in the header,
// always visible, plus chips that state the post's current schedule at a
// glance. The פרטים tab no longer owns a second copy of the publish form —
// same single-source rule that retired the duplicate nav in v1.7.

function liveQueueRow() {
  return (S.queue || []).find((q) => q.status === 'queued') || null;
}

function renderScheduleBar() {
  const slot = $('pvSched');
  if (!slot) return;

  const btn = el('button', {
    class: 'btn btn--primary pv-schedbtn', type: 'button',
    title: 'תזמון הפוסט — לפרסום או לבדיקה',
  }, '🗓️ תזמון');
  btn.addEventListener('click', () => openScheduleModal());

  const chips = [];
  const q = liveQueueRow();
  if (q) {
    chips.push(el('button', {
      class: 'sched-chip sched-chip--pub', type: 'button',
      title: 'תזמון לפרסום — לחצו לעריכה',
      onclick: () => openScheduleModal('publish'),
    }, q.scheduled_for
      ? `📣 פרסום: ${fmtWhen(q.scheduled_for)}`
      : '📣 בתור לפרסום (בהרצה הקרובה)'));
  }
  if (S.post.review_at) {
    chips.push(el('button', {
      class: 'sched-chip sched-chip--rev' + (Date.parse(S.post.review_at) < Date.now() ? ' is-late' : ''),
      type: 'button',
      title: S.post.review_note || 'תזמון לבדיקה — לחצו לעריכה',
      onclick: () => openScheduleModal('review'),
    }, `👀 בדיקה: ${fmtWhen(S.post.review_at)}`));
  }

  slot.replaceChildren(btn, ...chips);
}

async function refreshQueue() {
  try {
    const rows = await listQueue();
    S.queue = (Array.isArray(rows) ? rows : [])
      .filter((q) => q.post_id === S.post.id)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  } catch {
    S.queue = [];                 // a queue read must never break the page
  }
  renderScheduleBar();
}

// One modal, two modes. «לפרסום» writes sm_publish (channel + when + note);
// «לבדיקה» writes sm_posts.review_at/review_note and can move the stage.
// mode defaults to whichever the post already has, else 'publish'.
function openScheduleModal(mode) {
  const q = liveQueueRow();
  const initial = mode || (S.post.review_at && !q ? 'review' : 'publish');
  let cur = initial;

  const tabPub = el('button', { class: 'sched-mode', type: 'button' }, '📣 לפרסום');
  const tabRev = el('button', { class: 'sched-mode', type: 'button' }, '👀 לבדיקה');
  const pane = el('div', { class: 'sched-pane' });
  const hint = el('div', { class: 'sched-hint' });
  const err = el('div', { class: 'sched-err', hidden: true });

  // ---- publish pane
  const chSel = el('select', { class: 'field__input' },
    Object.entries(CHANNEL_LABELS).map(([v, l]) => {
      const o = el('option', { value: v }, l);
      if (q && q.channel === v) o.selected = true;
      return o;
    }));
  const pubWhen = el('input', {
    class: 'field__input', type: 'datetime-local',
    value: q ? toLocalInput(q.scheduled_for) : '',
  });
  const pubNote = el('input', {
    class: 'field__input', type: 'text',
    placeholder: 'הערה למפרסם (לא חובה)…',
    value: q ? (q.note || '') : '',
  });

  // ---- review pane
  const revWhen = el('input', {
    class: 'field__input', type: 'datetime-local',
    value: toLocalInput(S.post.review_at),
  });
  const revNote = el('input', {
    class: 'field__input', type: 'text',
    placeholder: 'מה צריך להיבדק? (לא חובה)…',
    value: S.post.review_note || '',
  });
  const revStage = el('input', { type: 'checkbox' });
  revStage.checked = S.post.stage !== 'in_review';
  const revStageRow = el('label', { class: 'sched-check' },
    revStage, el('span', null, 'להעביר את הפוסט לשלב «בבדיקה»'));

  const field = (label, input, note) => el('label', { class: 'field' },
    el('div', { class: 'field__label' }, label),
    input,
    note ? el('div', { class: 'sched-sub' }, note) : null,
  );

  function fillPane() {
    tabPub.classList.toggle('on', cur === 'publish');
    tabRev.classList.toggle('on', cur === 'review');
    err.hidden = true;
    if (cur === 'publish') {
      pane.replaceChildren(
        field('ערוץ', chSel, q ? 'שינוי ערוץ יבטל את השורה בתור ויכניס אותה מחדש.' : null),
        field('מתי לפרסם', pubWhen, 'ריק = בהרצת הפרסום הקרובה.'),
        field('הערה למפרסם', pubNote),
      );
      hint.replaceChildren(
        q ? 'הפוסט כבר בתור הפרסום — שמירה תעדכן את התזמון הקיים.'
          : 'שמירה תכניס את הפוסט לתור הפרסום.',
        canQueueStage() ? null : el('div', { class: 'sched-warn' },
          `שימו לב: הפוסט בשלב «${stageLabel(S.post.stage)}» ולא «מאושר». אפשר לתזמן, אבל כדאי לאשר קודם.`),
      );
    } else {
      pane.replaceChildren(
        field('מתי לבדוק', revWhen, 'ריק = בלי תאריך יעד.'),
        field('הערה לבודקים', revNote),
        revStageRow,
      );
      hint.replaceChildren('התזמון לבדיקה מופיע על הפוסט ובגלריה — הוא לא מפרסם כלום.');
    }
  }

  tabPub.addEventListener('click', () => { cur = 'publish'; fillPane(); });
  tabRev.addEventListener('click', () => { cur = 'review'; fillPane(); });
  fillPane();

  const body = el('div', { class: 'sched-form' },
    el('div', { class: 'sched-modes' }, tabPub, tabRev),
    pane, hint, err,
  );

  // `q` above is the row as it was when the modal OPENED — good enough to
  // prefill, wrong to write against: one save inside this modal changes it.
  // Every handler below re-reads the live row instead.
  const hasSomethingToClear = () => (cur === 'publish' ? !!liveQueueRow() : !!S.post.review_at);

  const m = modal('תזמון — ' + (S.post.title || S.post.id), body, {
    actions: [
      {
        label: 'ביטול תזמון',
        onClick: (close) => {
          if (!hasSomethingToClear()) {
            showErr('אין תזמון לבטל.');
            return false;
          }
          clearSchedule(cur).then(close).catch((e) => showErr(e.message));
          return false;      // close only after the write lands
        },
      },
      {
        label: 'שמירה', primary: true,
        onClick: (close) => {
          saveSchedule(cur).then(close).catch((e) => showErr(e.message));
          return false;
        },
      },
    ],
  });

  function showErr(msg) {
    err.textContent = msg;
    err.hidden = false;
  }

  async function saveSchedule(which) {
    if (which === 'publish') {
      const live = liveQueueRow();
      const when = fromLocalInput(pubWhen.value);
      const note = pubNote.value.trim();
      if (live && live.channel === chSel.value) {
        await rescheduleQueue(live.id, { scheduled_for: when, note });
      } else {
        if (live) await setQueueStatus(live.id, 'canceled');   // channel changed
        await queuePublish({
          post_id: S.post.id, channel: chSel.value, note,
          scheduled_for: when || undefined,
        });
      }
      await refreshQueue();
      toast(when ? 'תוזמן לפרסום: ' + fmtWhen(when, { relative: false }) : 'נוסף לתור הפרסום', 'ok');
    } else {
      const when = fromLocalInput(revWhen.value);
      const row = await setReviewAt(S.post.id, when, revNote.value.trim());
      S.post.review_at = row && 'review_at' in row ? row.review_at : when;
      S.post.review_note = revNote.value.trim();
      if (revStage.checked && S.post.stage !== 'in_review') {
        try {
          await setStage(S.post.id, 'in_review');
          S.post.stage = 'in_review';
        } catch (e) {
          toast('התזמון נשמר, אבל השלב לא עודכן: ' + e.message, 'err');
        }
      }
      renderHeader();
      renderActiveTab(true);
      toast(when ? 'תוזמן לבדיקה: ' + fmtWhen(when, { relative: false }) : 'נשמר לבדיקה', 'ok');
    }
  }

  async function clearSchedule(which) {
    if (which === 'publish') {
      const live = liveQueueRow();
      if (!live) throw new Error('אין תזמון פעיל לפרסום.');
      await setQueueStatus(live.id, 'canceled');
      await refreshQueue();
      toast('הוסר מתור הפרסום', 'ok');
    } else {
      await setReviewAt(S.post.id, null, '');
      S.post.review_at = null;
      S.post.review_note = '';
      renderHeader();
      renderActiveTab(true);
      toast('התזמון לבדיקה בוטל', 'ok');
    }
  }

  return m;
}

function canQueueStage() {
  return S.post.stage === 'approved' || S.post.stage === 'complete';
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

// v2.3: ONE definition of «what number is on screen» — store.currentVnum —
// and nextVnum() is exactly that plus one. The local copy this used to carry
// drifted from store's the moment an uploaded version existed.
function thisVnum() {
  return currentVnum(S.post, S.versionRows || []);
}

function nextVnum() {
  return thisVnum() + 1;
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

// ------------------------------------------------ marketing sign-off (v2.3)
// I1/I2 — the ONLY answer to «is this signed, and for which version» is
// sm_approvals derived against the version trail. Nothing here reads stage.

function approvalNow() {
  return approvalState(S.post, S.approvals || [], S.versionRows || []);
}

// Everything the reviewer has typed but not yet pushed to everyone. I5 turns
// on this: a signature must never name a version that does not exist, so a
// dirty session is flushed and stamped BEFORE the row is written.
function sessionUnsettled() {
  return !!(saveTimer || S.saveInFlight || S.pending.size || S.sessionDirty);
}

// The number the signature WILL bind to if the reviewer signs right now.
function signingVnum() {
  return sessionUnsettled() ? nextVnum() : thisVnum();
}

// The fingerprint of what is ON SCREEN right now — the SEEN half of I5.
// Deliberately NOT a re-read of the server row: the reviewer is looking at the
// working copy, which includes their own edits that the 1.5s debounce has not
// pushed yet. They DID see those, so those belong inside the fingerprint;
// anything else that turns up on the server later is somebody else's writing
// and must block the signature.
//   slides  — S.slides, the render source (S.post.slides is the last SAVED
//             truth and lags a dirty session).
//   caption — S.post.caption, which IS the on-screen caption: the caption
//             editor writes straight through (setCaption, no debounce) and
//             assigns S.post.caption in the same breath.
// Exactly the pair stampVersion() snapshots, so a version stamped at signing
// time and the hash guarding it are built from one source.
//
// The JSON round-trip is not decoration. contentHash() hashes a canonical
// stringify in which a key holding `undefined` survives as `null`, while jsonb
// on the way back from the server has dropped that key entirely — a difference
// that is invisible on screen and would refuse a perfectly honest signature.
// Round-tripping first puts the local object in the shape the server will
// return, so the compare is content-vs-content and never encoding-vs-encoding.
/* ── canvas zoom (operator quick-edit 2026-08-03) ─────────────────────
   ONE implementation, shared with build.html: ui.js zoomControl(). It sets
   --pv-zoom on #frame; .pv-frame's max-width calc (post.html) does the rest,
   compose refits itself, and design mode rides the same frame. */
function wireZoom() {
  const group = document.querySelector('.pv-tools__group');
  if (!group || group.querySelector('.pv-zoom')) return;
  group.appendChild(zoomControl({ getEl: () => $('frame') }));
}

function onScreenHash() {
  return contentHash(JSON.parse(JSON.stringify({
    slides: Array.isArray(S.slides) ? S.slides : [],
    caption: S.post.caption ?? '',
  })));
}

// There is something to revoke exactly when a signature is standing — fresh or
// stale. A stale one is still a signature somebody's name is on, and «נערך מאז»
// is not the same statement as «אני מושכת את החתימה».
function canRevoke(st) {
  return st.status === 'fresh' || st.status === 'stale';
}

function approvalChip() {
  const st = approvalNow();
  const who = (st.latest && st.latest.author) || 'מישהו';
  // THE number this chip may show: the vnum somebody actually PUT THEIR NAME
  // ON. `st.vnum` is the CURRENT version (approvalState's documented shape:
  // {status, latest, vnum} where vnum = currentVnum and latest.vnum = signed).
  // Rendering the current number as if it were the signed one fabricates a
  // claim nobody made — an approval bound to v99 on a v4 post read «✓ · v4»
  // while the audit trail one tab away read «נחתם ע״י … · v99». A chip must
  // never contradict the audit trail: same row, same number, every surface.
  const signed = st.latest ? Number(st.latest.vnum) : null;
  const vSigned = Number.isFinite(signed) ? signed : '?';
  if (st.status === 'fresh') {
    return el('span', { class: 'ap-chip ap-chip--fresh', title: 'נחתם על הגרסה שמוצגת עכשיו' },
      el('span', { class: 'g', 'aria-hidden': 'true' }, '✓'), `חתימת שיווק ${who} · v${vSigned}`);
  }
  if (st.status === 'stale') {
    return el('span', { class: 'ap-chip ap-chip--stale', title: 'הפוסט נערך אחרי החתימה' },
      el('span', { class: 'g', 'aria-hidden': 'true' }, '⚠️'), `נחתם על v${vSigned} — נערך מאז (v${st.vnum})`);
  }
  if (st.status === 'revoked') {
    return el('span', { class: 'ap-chip ap-chip--revoked', title: `בוטלה על ידי ${who}` },
      el('span', { class: 'g', 'aria-hidden': 'true' }, '⚠️'), 'החתימה בוטלה');
  }
  return el('span', { class: 'ap-chip ap-chip--none', title: 'אף אחד עוד לא חתם על הפוסט הזה' },
    el('span', { class: 'g', 'aria-hidden': 'true' }, '⚠️'), 'ללא חתימת שיווק');
}

// The header row: the chip for everyone, the button for the marketing hat.
// «Declared, never enforced» — the same action is always reachable from the
// פרטים tab whatever role (or no role) the reader declared.
function renderApprovalBar() {
  const slot = $('pvApprove');
  if (!slot) return;
  const kids = [approvalChip()];
  if (getRole() === 'marketing') {
    const st = approvalNow();
    const btn = el('button', {
      class: 'btn btn--primary pv-approvebtn', type: 'button',
      title: 'רישום חתימת שיווק על הגרסה המוצגת',
    }, 'חתימת שיווק ✓');
    btn.addEventListener('click', () => openApproveModal());
    kids.push(btn);
    if (canRevoke(st)) {
      const rev = el('button', {
        class: 'btn btn--ghost pv-approvebtn', type: 'button',
      }, 'ביטול החתימה');
      rev.addEventListener('click', () => openRevokeModal());
      kids.push(rev);
    }
  }
  slot.replaceChildren(...kids);
}

// I5 — flush first, stamp second, sign third. Each step is awaited so the
// number in the row is the number of a version that is already in the trail.
async function settleBeforeSigning() {
  if (saveTimer || S.saveInFlight || S.pending.size) {
    try { await flushSave(); } catch { /* the stamp below still runs */ }
  }
  if (S.sessionDirty) await stampVersion();   // stampVersion swallows its own errors
  await loadVersionBase();                    // re-read: the stamp may have collided
  return thisVnum();
}

// A note typed into a sign attempt that got REFUSED, held for the next open.
// The refusal costs the reviewer a fresh look at the post; it must not also
// cost them the sentence they just wrote. Keyed by post id — a note written
// about one post must never turn up prefilled in another post's modal.
let carriedApproveNote = null;   // {post_id, note} | null

function openApproveModal() {
  const shown = signingVnum();
  // I5, SEEN half — the fingerprint of what is on screen AT THIS MOMENT, taken
  // before the reviewer can start typing a note. Everything below signs
  // against THIS, never against whatever is live when they finally click.
  const seenHash = onScreenHash();
  const note = el('input', { class: 'field__input', type: 'text', placeholder: '' });
  if (carriedApproveNote && carriedApproveNote.post_id === S.post.id) {
    note.value = carriedApproveNote.note;
  }
  carriedApproveNote = null;
  const err = el('div', { class: 'ap-err', hidden: true });
  const body = el('div', { class: 'ap-form' },
    el('div', { class: 'ap-lead' },
      `החתימה נרשמת על שמך, על גרסה v${shown}. עריכה מאוחרת יותר תסמן אותה כלא־עדכנית.`),
    el('label', { class: 'field' },
      el('div', { class: 'field__label' }, 'הערה (לא חובה)'),
      note),
    err,
  );

  let busy = false;
  // The action OBJECT, not a literal in the array: ui.modal reads `a.onClick`
  // at click time, so replacing it here re-arms the same button. On a refusal
  // «חותמים» becomes «סוגרים ובודקים» and there is no second click that could
  // sign — the reviewer has to reopen, which is what «a fresh look» means.
  const signAction = {
    label: 'חותמים', primary: true,
    onClick: (close) => {
      if (busy) return false;
      busy = true;
      (async () => {
        const vnum = await settleBeforeSigning();
        await approvePost({
          post_id: S.post.id, vnum, note: note.value.trim(), expected_hash: seenHash,
        });
        await refreshAll();
        toast(`נחתם ✓ גרסה v${vnum}`, 'ok');
        close();
      })().catch(async (e) => {
        if (e && e.stale) {
          // Somebody else wrote while this modal sat open. Nothing was signed.
          // Pull their version onto the screen behind the modal first, so the
          // reviewer's next look is at the NEW content and not at what they
          // walked in with; then disarm signing and keep the note.
          carriedApproveNote = { post_id: S.post.id, note: note.value };
          // blur FIRST: applyRemotePost's midGesture() guard refuses to swap
          // slides while an INPUT holds focus, and the note field is exactly
          // that input — without this the refresh would leave the old content
          // on screen behind the modal, which is the opposite of the point.
          note.blur();
          await refreshAll().catch(() => {});
          err.textContent = 'הפוסט השתנה בזמן שהחלון היה פתוח — לא חתמנו. '
            + 'סוגרים, בודקים את הגרסה החדשה, וחותמים מחדש. ההערה שכתבתם נשמרת.';
          err.hidden = false;
          signAction.label = 'סוגרים ובודקים';
          signAction.onClick = null;   // no handler ⇒ ui.modal just closes
          if (signBtn) signBtn.textContent = signAction.label;
          return;                      // busy stays true: this button never signs again
        }
        busy = false;
        err.textContent = 'החתימה לא נשמרה: ' + (e && e.message ? e.message : e);
        err.hidden = false;
      });
      return false;   // close only once the row has landed
    },
  };

  const m = modal('חתימת שיווק', body, { actions: [{ label: 'ביטול' }, signAction] });
  const signBtn = m.root.querySelector('.modal__actions .btn--primary');
}

function openRevokeModal() {
  const note = el('input', { class: 'field__input', type: 'text', placeholder: '' });
  const err = el('div', { class: 'ap-err', hidden: true });
  const body = el('div', { class: 'ap-form' },
    el('div', { class: 'ap-lead' }, 'לבטל את חתימת השיווק? הביטול נרשם במסלול הפוסט.'),
    el('label', { class: 'field' },
      el('div', { class: 'field__label' }, 'הערה (לא חובה)'),
      note),
    err,
  );

  let busy = false;
  modal('ביטול החתימה', body, {
    actions: [
      { label: 'ביטול' },
      {
        label: 'ביטול החתימה', primary: true,
        onClick: (close) => {
          if (busy) return false;
          busy = true;
          (async () => {
            // A revocation binds to the number on screen NOW — it is a
            // statement about what everyone is looking at, not about the
            // version that happened to be signed.
            await revokeApproval({
              post_id: S.post.id, vnum: thisVnum(), note: note.value.trim(),
            });
            await refreshAll();
            toast('החתימה בוטלה', 'ok');
            close();
          })().catch((e) => {
            busy = false;
            err.textContent = 'הביטול לא נשמר: ' + (e && e.message ? e.message : e);
            err.hidden = false;
          });
          return false;
        },
      },
    ],
  });
}

// ------------------------------------------------ uploaded re-renders (v2.3)
// «העלאת גרסה מעוצבת» — finished pixels made outside the studio become a
// numbered version AND the live post, so the uploaded slides are what
// everyone reviews. store.uploadRenderVersion owns all three writes.

function isImageSlide(s) {
  return !!(s && typeof s === 'object' && s.image);
}

// The post is «pixels» when its current slides are image slides. `some`, not
// `every`: a half-image deck has no template to edit either, and the honest
// answer to «can the in-app editor touch this» is no.
function hasImageSlides() {
  return (S.slides || []).some(isImageSlide);
}

function openUploadVersionModal() {
  const file = el('input', {
    class: 'field__input', type: 'file', multiple: true,
    accept: 'image/png,image/jpeg,image/webp',
  });
  const note = el('input', { class: 'field__input', type: 'text', placeholder: '' });
  const list = el('div', { class: 'up-files' });
  const err = el('div', { class: 'up-err', hidden: true });

  // Natural order, shown BEFORE the upload: slide-2 must read above slide-10,
  // and the reviewer gets to see that it does before any bytes move.
  const ordered = () => [...(file.files || [])].sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''), 'he', { numeric: true, sensitivity: 'base' }));

  file.addEventListener('change', () => {
    err.hidden = true;
    const fs = ordered();
    list.replaceChildren(...fs.map((f, i) => el('div', null, `${i + 1}. ${f.name}`)));
  });

  const body = el('div', { class: 'up-form' },
    el('div', { class: 'up-hint' }, 'מעלים את כל השקפים לפי הסדר · PNG/JPG עד 8MB לקובץ'),
    el('label', { class: 'field' },
      el('div', { class: 'field__label' }, 'קבצי השקפים'),
      file, list),
    el('label', { class: 'field' },
      el('div', { class: 'field__label' }, 'הערה (לא חובה)'),
      note),
    err,
  );

  let busy = false;
  modal('העלאת גרסה חדשה (קבצי שקפים)', body, {
    actions: [
      { label: 'ביטול' },
      {
        label: 'העלאה', primary: true,
        onClick: (close) => {
          if (busy) return false;
          const files = ordered();
          if (!files.length) {
            err.textContent = 'לא נבחרו קבצים';
            err.hidden = false;
            return false;
          }
          const have = slideTotal();
          if (files.length !== have &&
              !confirm(`מספר הקבצים (${files.length}) שונה ממספר השקפים בגרסה הנוכחית (${have}) — להמשיך בכל זאת?`)) {
            return false;
          }
          busy = true;
          err.textContent = 'מעלים…';
          err.hidden = false;
          (async () => {
            // Settle first for the same reason I5 does: an unflushed edit
            // would otherwise be silently overwritten by the uploaded slides.
            if (saveTimer || S.saveInFlight || S.pending.size) {
              try { await flushSave(); } catch { /* upload still proceeds */ }
            }
            if (S.sessionDirty) await stampVersion();
            const res = await uploadRenderVersion({
              post_id: S.post.id, files, note: note.value.trim(),
            });
            close();
            // the uploaded slides ARE the post now — re-adopt, don't patch
            S.pending.clear();
            S.sessionDirty = false;
            clearHistory();
            setDesign(false);
            adoptPost(await getPost(S.post.id));
            S.cur = Math.min(S.cur, slideTotal() - 1);
            S.editAccEl = null;
            destroyDesignEditor();
            S.designMountEl = null;
            await refreshAll();
            renderViewer();
            renderActiveTab(true);
            toast(`נשמרה גרסה v${res.vnum} מהקבצים שהועלו`, 'ok');
          })().catch((e) => {
            busy = false;
            const msg = (e && e.message) ? e.message : String(e);
            err.textContent = `ההעלאה נכשלה: ${msg}`;
            err.hidden = false;
            toast(`ההעלאה נכשלה: ${msg}`, 'err');
          });
          return false;
        },
      },
    ],
  });
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

  // v1.7: live compose is not a mode the reviewer picks any more. Under v1.5
  // every edit lands in the shared slides immediately, so for an edited post
  // the studio PNG is stale by definition — the browser-composed render IS
  // the post. The PNG survives only as the fallback when there is no slides
  // data or compose failed to load.
  S.live = hasSlidesData() && !S.composeFailed && S.composeReady;

  // v2.3: for an uploaded re-render the studio PNG does not exist (and would
  // show the pre-upload artwork if it did) — the fallback layer is the
  // uploaded file itself, so the two layers agree even when compose is down.
  //
  // The PNG is fetched ONLY while it is (or may become) the visible layer —
  // before the first compose mount, or when compose is down. Once the live
  // compose covers the frame, a slide flip must not restart a 0.5–1MB storage
  // download for an image nobody can see.
  if (!S.live || !S.composeMounted) {
    const cur = (S.slides || [])[S.cur];
    const url = isImageSlide(cur) ? String(cur.image) : slideUrl(S.post, S.cur);
    if (img.getAttribute('src') !== url) { $('frame').classList.remove('noimg'); img.src = url; }
  }
  img.alt = `שקף ${S.cur + 1}`;
  renderDesignBtn();

  $('nextBtn').disabled = S.cur >= n - 1;
  $('prevBtn').disabled = S.cur <= 0;

  $('dots').replaceChildren(...Array.from({ length: n }, (_, i) => {
    const d = el('button', { class: 'pv-dot' + (i === S.cur ? ' on' : ''), type: 'button' }, String(i + 1));
    d.addEventListener('click', () => goTo(i));
    return d;
  }));
  $('slideCount').textContent = `שקף ${S.cur + 1} מתוך ${n}`;

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

  // only when the PNGs ARE the content — never while compose is merely booting
  if (!hasSlidesData() || S.composeFailed) warmNeighborPngs();
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
  // Not !S.live alone: at composeReady only tokens+manifest have landed — the
  // first slide's template and SVG fetches are still in flight. Dropping the
  // PNG at that moment showed a white frame for the whole fetch (the on-load
  // white flash). The PNG stays on top until a compose mount actually painted.
  $('frame').classList.toggle('pngtop', !S.live || !S.composeMounted);
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
    // commits) — vars and design come straight from it. v2.3: an image slide
    // has neither; it goes to compose.js's early return whole.
    const composed = isImageSlide(slide)
      ? { image: slide.image }
      : { template: slide.template, vars: { ...slide.vars } };
    if (!isImageSlide(slide) && slide.design) composed.design = slide.design;
    await mountSlide(tmp, composed);
    if (seq !== previewSeq) return; // a newer keystroke superseded this mount
    // mode may have flipped during the await — a stale preview must never
    // clobber the design editor's mount (it would silently detach the armed
    // overlay without destroying the controller)
    if (!S.live || designMode()) return;
    host.replaceChildren(tmp);
    if (!S.composeMounted) { S.composeMounted = true; applyCompare(); }
    warmNeighbors();
  } catch (e) {
    console.error('mountSlide failed', e);
    if (seq !== previewSeq) return;
    toast('שגיאה בתצוגה החיה — חוזרים לרינדור הרגיל', 'err');
    // v1.7 removed setLive(); the fallback is a STATE flag renderViewer()
    // derives from, not a call. Marking the compose failed is what actually
    // puts the studio PNG back on top — the old dead call did nothing but
    // throw. (See the boot() note above.)
    S.composeFailed = true;
    renderViewer();
  }
}

// ------------------------------------------------ adjacent-slide prefetch
// An arrow press used to pay a network round-trip on every first visit: the
// next slide's template + illustration SVGs only started downloading after
// the click. After each successful preview mount, both neighbors' fetches
// are warmed into compose.js's in-memory caches (the composed HTML is
// discarded); image slides warm the browser's image cache the same way.
const warmedSlides = new Set();
function warmNeighbors() {
  if (!S.live) return;
  for (const j of [S.cur + 1, S.cur - 1]) {
    const s = (S.slides || [])[j];
    if (!s || warmedSlides.has(j)) continue;
    warmedSlides.add(j);
    if (isImageSlide(s)) { new Image().src = String(s.image); continue; }
    const composed = { template: s.template, vars: { ...s.vars } };
    if (s.design) composed.design = s.design;
    composeSlideHTML(composed).catch(() => {});
  }
}

// PNG-fallback posts (no slides data, or compose down) flip between studio
// PNGs — warm those instead, same one-shot-per-index discipline.
const warmedPngs = new Set();
function warmNeighborPngs() {
  const n = slideTotal();
  for (const j of [S.cur + 1, S.cur - 1]) {
    if (j < 0 || j >= n || warmedPngs.has(j)) continue;
    warmedPngs.add(j);
    new Image().src = slideUrl(S.post, j);
  }
}

// ------------------------------------------------ design mode (editor.js)

function designMode() {
  return !!S.design && hasSlidesData();
}

function designPhotos() {
  return S.photos.map((ph) => ({ url: photoUrl(ph), note: ph.note || '' }));
}

// v2.0 — the whole board library, shaped for the editor's «ספריית נכסים»
// picker: URLs resolved here (the editor is network-free), studio drawings
// and reviewer uploads in one list. S.assets is refreshed by refreshAll().
function designAssets() {
  return (S.assets || []).map((a) => ({
    id: a.id,
    kind: a.kind || 'other',
    source: a.source || 'upload',
    name: a.name || '',
    label: a.label || '',
    tags: Array.isArray(a.tags) ? a.tags : [],
    post_id: a.post_id || null,
    url: assetRowUrl(a),
    // v2.5.2: the picker folds generated variants into version STACKS off the
    // `stack:` tag and orders them by derived.variant. This shim is the ONLY
    // thing between a store row and the editor, so a field it does not copy
    // does not exist over there — the stacks would still form (the tag
    // survives) but «1/3» would number them in DB insertion order.
    derived: a.derived || null,
    created_at: a.created_at || null,
  })).filter((a) => a.url);
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
  // v2.1: destroy() takes the whole sidebar with it — the host element it
  // mounted into is ours and stays. Clearing it guards the one case destroy()
  // can't cover: a controller that never armed (engine missing).
  const host = document.getElementById('editPanelHost');
  if (host) host.replaceChildren();
}

let designTimer = null;
let designSeq = 0;
function mountDesignSoon(delay = 0) {
  clearTimeout(designTimer);
  designTimer = setTimeout(() => { mountDesign().catch(() => {}); }, delay);
}

async function mountDesign() {
  if (!S.live || !designMode()) return;
  if (hasImageSlides()) { setDesign(false); return; }   // v2.3: nothing to edit
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
  // the editor's mount is a compose paint too — release the PNG layer
  if (!S.composeMounted) { S.composeMounted = true; applyCompare(); }
  if (seq !== designSeq || !designMode()) return;

  // arm the editor (once per slide) — needs the {iframe, update, doc} handle
  if (S.designCtrl && S.designCtrlIdx === i) { S.designCtrl.refresh(); return; }
  destroyDesignEditor();
  const wasMissing = S.designEngineMissing;
  try {
    S.designCtrl = initEditor(handle, composed, {
      manifest: manifest(),
      photos: designPhotos(),
      assets: designAssets(),
      postId: S.post.id,
      assetUrl,
      uploadFile: uploadFromEditor,
      // v2.0: the picker's upload tile. Uploading from inside a post is a
      // post-scoped upload — it lands in that post's תמונות tab AND in the
      // board-wide library, exactly like a drop on the slide.
      uploadAsset: uploadFromEditor,
      // v2.9 «הסרת רקע» (spec 12). Cloud only — the Edge Function is what holds
      // FAL_KEY — so in local mode we pass NOTHING and the editor renders the
      // button disabled with a reason, the same posture the generation tab
      // takes. Handing it a function that always throws would read as a bug.
      removeBackground: IS_LOCAL_BOARD
        ? null
        : (url) => removeBackground(url, { post_id: S.post.id }),
      // v2.1: every editing control lives in the editor's own sidebar, docked
      // into the panel column while edit mode is armed (see setDesign). Drop
      // this and the sidebar still works — it falls back to a fixed drawer —
      // but it would float over the review panel instead of replacing it.
      sidebar: $('editPanelHost'),
      // v2.2: ⌘Z / ⌘⇧Z inside the editor. The stack is THIS page's (it covers
      // caption and text edits too, not just design), so the editor only
      // forwards the intent.
      onUndo: () => undoStep(),
      onRedo: () => redoStep(),
      // v2.2: the deck strip in the sidebar — move between slides without
      // leaving edit mode. Thumbs are the studio's own renders.
      deck: {
        count: slideTotal(),
        index: i,
        thumb: (n) => slideUrl(S.post, n),
        label: (n) => 'שקף ' + (n + 1),
        go: (n) => goTo(n),
      },
      // v2.2: one change, every slide of the carousel. The editor holds ONE
      // slide, so it hands us the change and we walk the deck — as a single
      // undo step, because "apply to all" is one action to the person who
      // pressed it.
      onApplyAll: (p) => applyToAllSlides(p),
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

// -------------------------------------------- apply to every slide (v2.2)
//
// The editor describes the change; the deck is ours to walk. Two shapes so
// far — a background, and one text block's style — and both are written the
// same way: through commitDesign, so every slide gets its own audit row and
// its own «applied» edit in the learning loop, exactly as if the reviewer had
// made the change by hand on each one. withOneUndoStep wraps the lot, because
// «apply to all» is a single action to whoever pressed the button.
function applyToAllSlides(p) {
  if (!p || !p.type) return;
  const n = slideTotal();
  let touched = 0;
  withOneUndoStep('applyAll', () => {
    for (let j = 0; j < n; j++) {
      const s = S.slides[j];
      if (!s) continue;
      const d = s.design ? deepCopy(s.design) : {};
      if (p.type === 'bg') {
        d.bg = deepCopy(p.bg);
      } else if (p.type === 'blockStyle') {
        // only slides that HAVE this text block — a template without it would
        // otherwise collect a styling orphan that nothing ever renders
        const has = s.vars && Object.prototype.hasOwnProperty.call(s.vars, p.name);
        if (!has) continue;
        d.blocks = d.blocks || {};
        const keep = d.blocks[p.name] || {};
        // position is this slide's own nudge — the style travels, the place
        // it was nudged to does not
        const next = { ...deepCopy(p.style) };
        if (typeof keep.dx === 'number') next.dx = keep.dx;
        if (typeof keep.dy === 'number') next.dy = keep.dy;
        d.blocks[p.name] = next;
      } else {
        return;
      }
      commitDesign(j, d, { delay: 500 });
      touched++;
    }
  });
  if (!touched) { toast('אין שקף נוסף שהשינוי הזה חל עליו'); return; }
  destroyDesignEditor();
  mountDesignSoon(0);
  toast(p.type === 'bg'
    ? `הרקע הוחל על ${touched} שקפים`
    : `הסגנון הוחל על ${touched} שקפים`, 'ok');
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
      // v2.3: the pin remembers WHICH round it was written against
      const row = await addPin({ post_id: S.post.id, slide: S.cur, x, y, body, vnum: thisVnum() });
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
    // audit log: one row per changed field, exact old→new. v2.3: each row
    // stamps the ROUND it was made against, so a comment on v5 stays a comment
    // on v5 once v6 exists.
    const round = thisVnum();
    const logs = [];
    for (const [f, ch] of batch) {
      const cur = S.pending.get(f);
      if (cur) {
        if (cur.new_text === ch.new_text) S.pending.delete(f);
        else cur.old_text = ch.new_text; // typed more mid-flight: next old = what we just saved
      }
      if (ch.old_text !== ch.new_text) {
        logs.push(logEdit({
          post_id: S.post.id, field: f,
          old_text: ch.old_text, new_text: ch.new_text, vnum: round,
        }));
      }
    }
    await Promise.allSettled(logs);
    // I3 — a direct edit to a post that is signed on THIS version stamps a new
    // version immediately, instead of waiting for the session to end. Without
    // it the signature keeps reading «fresh» on every other open client until
    // whoever is typing closes the tab, which is exactly the window where a
    // stale approval does damage.
    if (row && approvalNow().status === 'fresh') {
      await stampVersion();
      renderHeader();
      if (S.tab === 'info') renderActiveTab(true);
    }
    if (!S.pending.size) closeUndoBatch(); // the batch landed — next commit is a new undo step
    setSaveChip(S.pending.size ? 'saving' : 'saved');
    refreshEditMarks();
    renderTransPanel();   // v2.3 — the Hebrew just moved; fields flip stale WITHOUT a reload
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
// download + «שכפל פוסט». Nothing action-like overlays the slide artwork from
// this page's side. v2.1: the editing controls (undo/redo, the save chip,
// «שמור כתבנית») move OUT of this row into the sidebar's head while edit mode
// is armed — see moveEditChrome. The row keeps only page-level actions.
let histUndoBtn = null;
let histRedoBtn = null;
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
  const dlBtn = el('button', {
    class: 'btn btn--ghost', type: 'button', id: 'dlBtn',
    title: 'הורדת השקף הזה או כל השקפים כקובצי PNG',
  }, '⬇︎ הורדה');
  dlBtn.addEventListener('click', openDownloadModal);
  if (bar) bar.replaceChildren(histUndoBtn, histRedoBtn, saveChipEl, tplSaveBtn, dlBtn, dupBtn);
  const flushNow = () => { if (saveTimer) flushSave(); };
  window.addEventListener('pagehide', () => { flushNow(); stampVersion(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { flushNow(); stampVersion(); }
  });
}

// ---------------------------------------------------------------- download
// v2.1. Downloads the STUDIO RENDERS (the PNGs in the sm-assets bucket) — the
// same files the publisher hands to Meta, so what you download is what would
// actually be posted.
//
// The load-bearing caveat: those PNGs are re-rendered by the factory, not by
// this app. A post edited on the board (text, design, photos) has a live
// preview that is AHEAD of its PNG, and the download would be the pre-edit
// image. That is exactly the case a reviewer most wants to share, so the
// modal says so out loud instead of quietly handing over stale pixels.
// Rasterising the live compose in-browser is a real build (font + photo
// inlining, foreignObject → canvas) and is deliberately NOT faked here.

function pngIsStale() {
  const designed = Array.isArray(S.slides)
    && S.slides.some((s) => s && s.design && Object.keys(s.design).length > 0);
  return designed || (S.versionRows || []).length > 0;
}

function slideFileName(i) {
  const base = String(S.post.id || 'post').replace(/[^\w.-]+/g, '-');
  return `${base}-slide-${String(i + 1).padStart(2, '0')}.png`;
}

// Fetch → object URL → click. Going through a blob (rather than putting the
// storage URL straight on the anchor) is what makes `download` actually rename
// the file: a cross-origin href makes the browser ignore the attribute and
// navigate to the image instead.
async function downloadSlide(i) {
  // v2.3: for an uploaded re-render the uploaded file IS the deliverable —
  // the studio PNG behind it is the pre-upload artwork, or nothing at all.
  const s = (S.slides || [])[i];
  const src = isImageSlide(s) ? String(s.image) : slideUrl(S.post, i);
  const res = await fetch(src, { cache: 'no-store' });
  if (!res.ok) throw new Error(`שקף ${i + 1}: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: slideFileName(i) });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ── size, format, quality (v2.5.1, spec 10 §D-2) ───────────────────────────
 *
 * TWO PATHS out of one modal, and the split is «גודל»:
 *
 *   «מקורי»  — exactly what this modal has always done: fetch the existing
 *              PNGs and save them. Instant, offline-ish, no row, no waiting.
 *              The format and quality controls are HIDDEN in this mode rather
 *              than disabled-and-ignored, because a JPEG picker that quietly
 *              hands back a PNG is worse than no picker. Re-encoding those
 *              bytes in the browser would also throw away the one property
 *              that makes them worth downloading: they are byte-for-byte the
 *              files the publisher sends to Meta.
 *
 *   any size — a factory EXPORT REQUEST (kind:'export', migration 027). The
 *              slide is re-rendered at that size by scripts/fulfill.mjs, which
 *              is minutes, not milliseconds, and the modal says so before the
 *              button is pressed. It applies to ALL slides: the payload
 *              contract is per-POST, deliberately — a size is a deliverable
 *              set, and «slide 3 only, at A4» is not a thing anyone asked for.
 *
 * The export is also the answer to this modal's oldest caveat. «ההורדה היא
 * הרינדור מהסטודיו» — your board edits are not in these PNGs — is true of the
 * instant path and FALSE of the export path, which renders the slides the board
 * holds right now. So the warning shows in «מקורי» mode and is replaced, in
 * export mode, by the sentence that is actually true there.
 */

const DL_ORIG = '__orig__';

// A dependency-free poll. Realtime delivers nothing to anon subscribers on a
// header-scoped board (see store.js), and the queue's own cadence is minutes,
// so a 5s poll that stops when the modal closes is the honest mechanism.
function pollGenRequest(id, alive, onTick) {
  let stop = false;
  const tick = async () => {
    if (stop || !alive()) return;
    let row = null;
    try { row = await getGenRequest(id); } catch { /* keep polling; a blip is not a failure */ }
    if (stop || !alive()) return;
    if (row) onTick(row);
    if (row && (row.status === 'done' || row.status === 'failed')) return;
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 2500);
  return () => { stop = true; };
}

function openDownloadModal() {
  const total = slideTotal();
  const cur = S.cur;

  // Builder posts that were never rendered by the factory have no PNGs at all.
  // (An uploaded re-render has its own files, so it is downloadable regardless.)
  // They CAN still be exported — an export re-renders from the board's slides
  // and does not need a prior studio run — so the refusal is scoped to the
  // instant path and says which door is still open.
  const noPngs = !S.post.asset_prefix && !hasImageSlides();

  const status = el('div', { class: 'sched-hint xp-status' });
  const links = el('div', { class: 'xp-links' });
  const one = el('button', { class: 'btn btn--primary', type: 'button' }, `השקף הנוכחי (${cur + 1})`);
  const all = el('button', { class: 'btn btn--ghost', type: 'button' }, `כל השקפים (${total})`);
  const go = el('button', { class: 'btn btn--primary', type: 'button' }, `בקשת ייצוא — ${total} שקפים`);

  const size = el('select', { class: 'field__input' },
    el('option', { value: DL_ORIG }, 'מקורי — הקבצים שנשלחים לפרסום (1080×1350)'),
    GEN_DIMS.map((d) => el('option', { value: d.key }, d.label)));
  const format = el('select', { class: 'field__input' },
    el('option', { value: 'png' }, 'PNG — ללא אובדן'),
    el('option', { value: 'jpeg' }, 'JPEG — קובץ קטן'));
  const quality = el('input', {
    type: 'range', min: '60', max: '100', step: '1', value: '90',
    'aria-label': 'איכות JPEG',
  });
  const qNum = el('span', { class: 'ltr xp-qnum' }, '90');
  quality.addEventListener('input', () => { qNum.textContent = quality.value; });

  // The saved versions, newest first, so «ייצוא של הגרסה שמרקטינג אישרה» is one
  // select away. «נוכחי» is the default and sends no vnum at all — an absent
  // vnum means "the board as it is", which is what a reviewer wants nine times
  // in ten and what makes the export fresher than the studio PNGs.
  const versions = (S.versionRows || []).slice()
    .sort((a, b) => Number(b.vnum) - Number(a.vnum));
  const vSel = el('select', { class: 'field__input' },
    el('option', { value: '' }, 'נוכחי — מה שיש בלוח עכשיו'),
    versions.map((v) => el('option', { value: String(v.vnum) },
      `v${v.vnum}${v.author ? ' · ' + v.author : ''}${v.created_at ? ' · ' + fmtDate(v.created_at) : ''}`)));

  // Every row that only exists in export mode is a .field, so the one CSS rule
  // spec 10 §D-1 had to add — `.field[hidden] { display: none }` — governs all
  // of them. (`.field { display: flex }` is an author rule and beats the UA's
  // [hidden], which is why `el.hidden = true` alone does nothing here.)
  const fRow = el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'פורמט'), format);
  const qRow = el('div', { class: 'field' },
    el('label', { class: 'field__label' }, 'איכות JPEG'),
    el('div', { class: 'xp-range' }, quality, qNum));
  const vRow = el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'גרסה'), vSel);

  const staleWarn = el('div', { class: 'dz-warn' },
    el('b', null, 'שימו לב: ההורדה היא הרינדור מהסטודיו.'),
    el('div', { class: 'sched-sub' },
      'לפוסט הזה יש עריכות שנעשו בלוח (טקסט או עיצוב) שעדיין לא עברו רינדור מחדש. ',
      'הקבצים שיירדו לא כוללים אותן — הם מה שיתפרסם היום. ',
      'אפשר לבקש ייצוא בגודל אחר (למטה): ייצוא מרנדר מחדש את מה שיש בלוח עכשיו, כולל העריכות.'));
  const noPngWarn = el('div', { class: 'dz-warn' },
    el('b', null, 'לפוסט הזה אין עדיין רינדור מהסטודיו.'),
    el('div', { class: 'sched-sub' },
      'אין קובצי PNG מוכנים להורדה מיידית. אפשר לבחור גודל ולבקש ייצוא — ',
      'המפעל ירנדר את השקפים מהלוח, וזה לוקח כמה דקות.'));
  const hint = el('div', { class: 'sched-hint' });

  // NOT `style: {display:'flex'}` — an inline display beats the UA's
  // `[hidden]{display:none}` even harder than an author rule does, and the row
  // stays on screen with `el.hidden = true` set and nothing in the DOM to
  // explain it. This is the SAME trap spec 10 §D-1 hit on `.field`, one layer
  // further in; `.xp-acts` carries the flex AND its own hidden rule.
  const instantRow = el('div', { class: 'toolbar xp-acts' }, one, all);
  const exportRow = el('div', { class: 'toolbar xp-acts' }, go);

  const body = el('div', { class: 'sched-form' },
    staleWarn, noPngWarn,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'גודל'), size),
    fRow, qRow, vRow,
    hint, instantRow, exportRow, status, links,
  );

  const sync = () => {
    const exporting = size.value !== DL_ORIG;
    fRow.hidden = !exporting;
    qRow.hidden = !exporting || format.value !== 'jpeg';
    vRow.hidden = !exporting || !versions.length;
    instantRow.hidden = exporting || noPngs;
    exportRow.hidden = !exporting;
    staleWarn.hidden = exporting || noPngs || !pngIsStale();
    noPngWarn.hidden = exporting || !noPngs;
    hint.textContent = exporting
      ? 'הייצוא נעשה במפעל: השקפים מרונדרים מחדש בגודל שנבחר, מהמצב שיש בלוח (או מגרסה שנבחרה). ' +
        'זה לוקח כמה דקות ורק כשמפעל היצירה פועל — החלון הזה יתעדכן, ואפשר גם לחזור אליו אחר כך. ' +
        'שקף שהיחס שלו שונה מ-4:5 משובץ במלואו במסגרת עם שוליים בצבע הרקע, בלי לחתוך טקסט.'
      : 'הקבצים יורדים כמו שהם — אותם קבצים שנשלחים לפרסום. בלי המרה ובלי המתנה.';
  };
  size.addEventListener('change', sync);
  format.addEventListener('change', sync);
  sync();

  const m = modal('הורדת שקפים — ' + (S.post.title || S.post.id), body);
  const alive = () => document.body.contains(m.root);

  const run = async (indices) => {
    one.disabled = true; all.disabled = true;
    let done = 0;
    const failed = [];
    for (const i of indices) {
      status.textContent = `מוריד ${done + 1} מתוך ${indices.length}…`;
      try {
        await downloadSlide(i);
        done++;
      } catch (e) {
        failed.push(i + 1);
      }
      // Chrome asks once about "multiple downloads" and then throttles; a beat
      // between saves keeps the browser from dropping the later files.
      if (indices.length > 1) await new Promise((r) => setTimeout(r, 350));
    }
    one.disabled = false; all.disabled = false;
    if (failed.length) {
      status.textContent = `ירדו ${done} קבצים. נכשלו שקפים: ${failed.join(', ')}.`;
      toast('חלק מהשקפים לא ירדו', 'err');
    } else {
      status.textContent = '';
      toast(done === 1 ? 'השקף ירד' : `${done} שקפים ירדו`, 'ok');
      m.close();
    }
  };

  const showResult = (row) => {
    const label = GEN_STATUS_LABELS[row.status] || row.status;
    const res = row.result || {};
    const files = Array.isArray(res.exports) ? res.exports : [];
    // GEN_STATUS_LABELS.done reads «מוכן — בגלריה», which is true of a
    // generated POST and not of an export: these files are in the download
    // list right here, not in the gallery. Borrow the label only while the
    // request is still moving.
    status.textContent = files.length
      ? `הייצוא מוכן · ${files.length} קבצים`
      : `הבקשה נשלחה — ${label}. אפשר לסגור את החלון; הקבצים יחכו כאן.`;
    links.replaceChildren(
      ...(files.length
        ? [el('ul', { class: 'xp-files' }, files.map((f) => el('li', null,
            // The slide NUMBER is isolated too: «שקף 3» ends a Hebrew run with
            // a Latin digit, and without isolation the space collapses against
            // the following Latin metadata and it renders as «שקף3».
            el('a', { href: f.url, download: f.name, target: '_blank', rel: 'noopener' },
              'שקף\u00a0', el('span', { class: 'ltr' }, String(f.slide))),
            el('span', { class: 'ltr' }, ` ${f.w}×${f.h} · ${Math.round((f.bytes || 0) / 1024)}kB · ${f.format === 'jpeg' ? 'JPEG' : 'PNG'}`))))]
        : []),
      ...((res.notes || []).length
        ? [el('ul', { class: 'xp-fails' }, res.notes.map((n) => el('li', null, n)))]
        : []),
    );
    if (row.status === 'done' && files.length) toast(`${files.length} קבצים מוכנים`, 'ok');
    if (row.status === 'failed') toast('הייצוא לא הצליח', 'err');
  };

  one.addEventListener('click', () => { run([cur]); });
  all.addEventListener('click', () => { run([...Array(total).keys()]); });
  go.addEventListener('click', async () => {
    go.disabled = true;
    status.textContent = 'שולחים בקשת ייצוא…';
    links.replaceChildren();
    const payload = {
      post_id: S.post.id,
      format: format.value,
      quality: Number(quality.value),
      size: size.value,
    };
    if (vSel.value) payload.vnum = Number(vSel.value);
    try {
      const row = await createGenRequest({ kind: 'export', payload });
      status.textContent = 'הבקשה בתור. הרינדור נעשה במפעל, וזה כמה דקות.';
      pollGenRequest(row.id, alive, showResult);
    } catch (e) {
      // The one failure a reviewer cannot debug from the message alone: the
      // CHECK constraint from migration 027 not being applied yet.
      const msg = (e && e.message) || String(e);
      status.textContent = /check|constraint|violates|400/i.test(msg)
        ? 'הבקשה נדחתה. ייתכן שמיגרציה 027 עדיין לא הוחלה על הלוח — בלעדיה התור לא מקבל בקשות ייצוא.'
        : 'לא הצלחנו לשלוח את הבקשה: ' + msg;
      toast('הבקשה לא נשלחה', 'err');
    } finally {
      go.disabled = false;
    }
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
  // v2.3, operator change 08-01: the English translation is a TAB, not a header
  // button that swapped a third aside in. Label is Latin «English» on purpose —
  // it is the one control in this RTL page whose whole point is the other
  // language, and it is what the operator asked for verbatim. The tab lives in
  // #reviewPanel beside the sticky viewer column, so the Hebrew slide stays on
  // screen while the English is read — the side-by-side reading the panel is
  // for. See renderTransTab().
  { key: 'trans', label: 'English' },
  // v2.5 (spec 07). Sits AFTER תמונות for a reason: the two are the same
  // shelf from the reviewer's side — «תמונות» is what you uploaded, «יצירת
  // תמונות» is what you made — and everything created here lands in that tab
  // as well as in the board-wide library.
  { key: 'gen', label: 'יצירת תמונות' },
  // operator 2026-08-03: the board-wide media library without leaving the
  // post. assets.html hosts itself inside an embedded frame (?embed=1 hides
  // its page chrome) — one library, one implementation, two doors.
  { key: 'library', label: 'ספרייה' },
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

// v2.7 — the mobile editing surface. Below 920px an armed editor takes the
// whole screen (body.pv-editfs, styled in this page's <style>): nav, post head
// and review tools go away, and the page becomes head / slide / editor.js's
// bottom dock. Above it, nothing changes — the two-column edit mode is
// untouched. THE breakpoint is 920px, the same one editor.js and every other
// collapse on this page already use.
const FS_MQ = window.matchMedia('(max-width: 920px)');

// The fullscreen stage puts BODY in `position: fixed` (post.html explains why:
// `overflow:hidden` alone left the document 80px taller than the viewport), and
// that zeroes the page's scroll offset. Nothing gives it back on its own, so a
// reviewer who scrolled the slide into view, armed, and pressed ✕ landed at the
// top of the page with the slide ~460px below the fold (measured 402×874:
// scrollY 299 → 0; 360×640: 390 → 0).
//
// One stash, one restore, and the guard below is what keeps it honest:
//   · null means «not stashed» — the value is cleared the instant it is spent,
//     so a second exit can never replay a stale offset;
//   · the class check makes this idempotent, so a repeat call cannot overwrite
//     the stash with the 0 that body{position:fixed} is currently reporting.
// Every path through the mode flips this class and nothing else does — the ✕,
// the 🎨 toggle and the breakpoint crossing all land here.
let PV_SCROLL_Y = null;

// `enterY` is the offset to stash when ENTERING, captured by the caller before
// it touched the DOM. It matters: setDesign() hides #reviewPanel before it gets
// here, which SHORTENS the document, and the browser clamps the live scroll
// offset to the new maximum on the spot. Reading window.scrollY at this point
// therefore stashes an already-clamped number — measured at 360×640, a page
// scrolled to 450 was clamped to 400 before the stash, so the ✕ handed back 400.
// The mq listener passes nothing, and is right to: nothing mutates the DOM
// ahead of it, so the live offset is the true one.
function syncEditFs(enterY) {
  const want = !!S.design && FS_MQ.matches;
  const have = document.body.classList.contains('pv-editfs');
  if (want === have) return;
  if (want) {
    // stash BEFORE the class lands: applying it is what zeroes the offset
    const live = window.scrollY || document.documentElement.scrollTop || 0;
    PV_SCROLL_Y = Number.isFinite(enterY) ? enterY : live;
    document.body.classList.add('pv-editfs');
    return;
  }
  document.body.classList.remove('pv-editfs');
  if (PV_SCROLL_Y == null) return;
  const y = PV_SCROLL_Y;
  PV_SCROLL_Y = null;               // spent — never replayable
  window.scrollTo(0, y);
  // ONE restore, asserted twice: setDesign() re-renders the viewer and unhides
  // the review panel AFTER this runs, so the document can still be shorter than
  // `y` at this instant and the browser would clamp the scroll. Re-asserting the
  // SAME captured value on the next frame is what makes it stick; it is not a
  // second restore — the stash is already spent and cannot produce a new one.
  requestAnimationFrame(() => window.scrollTo(0, y));
}

// arming on a desktop-width tablet and then rotating it into portrait has to
// ENTER fullscreen, not leave a half-collapsed sidebar behind
FS_MQ.addEventListener('change', syncEditFs);

// v2.7 — the way out of fullscreen. On desktop the 🎨 toggle is still on
// screen; in fullscreen it is one of the things the mode hides, so the edit
// head carries its own ✕. Built once and re-parented like every other mover.
let fsExitBtn = null;
function fsExit() {
  if (!fsExitBtn) {
    fsExitBtn = el('button', {
      class: 'btn btn--ghost pv-edit__x', type: 'button',
      title: 'סגירת מצב העיצוב', 'aria-label': 'סגירת מצב העיצוב',
    }, '✕');
    fsExitBtn.addEventListener('click', () => setDesign(false));
  }
  return fsExitBtn;
}

function setDesign(on) {
  // v2.3 — arming edit mode over image slides would hand editor.js a slide with
  // no template to introspect. Refuse and say why, rather than mounting an
  // editor that can only fail.
  if (on && hasImageSlides()) {
    toast(IMG_SLIDE_NOTE, 'err');
    return;
  }
  const want = !!on && hasSlidesData();
  if (S.design === want) return;
  // v2.7 — the page's scroll offset, read BEFORE this function shortens the
  // document by hiding #reviewPanel below. syncEditFs() stashes this on the way
  // into fullscreen; read any later and it is already clamped (see its note).
  const enterY = window.scrollY || document.documentElement.scrollTop || 0;
  // v2.3, operator change 08-01 — the English view is a TAB now, so there is no
  // mutual exclusion left to run here: arming design mode hides #reviewPanel and
  // the whole tab strip with it, which takes the English tab off screen for
  // free. No English can be beside an armed editor by construction.
  S.design = want;
  const b = $('designBtn');
  if (b) {
    b.classList.toggle('on', want);
    b.setAttribute('aria-pressed', want ? 'true' : 'false');
  }
  // v2.1 — edit mode is a MODE: the panel column stops being the review panel
  // and becomes the editing sidebar. One of the two asides is always hidden,
  // so .pv-main stays a two-column grid and the slide never moves.
  const rp = document.getElementById('reviewPanel');
  const ep = document.getElementById('editPanel');
  if (rp) rp.hidden = want;
  if (ep) ep.hidden = !want;
  moveEditChrome(want);
  // v2.7 — before renderViewer(): the fullscreen class changes the column the
  // slide is measured against, and compose.js scales the live preview to that
  // width. Flip the layout first, mount into it second. (This is also the one
  // place the page's scroll offset is stashed and given back — see syncEditFs.)
  syncEditFs(enterY);
  // pinning a comment is a REVIEW action — it has no place in edit mode, and
  // its armed overlay would fight the editor's for the same clicks
  const pin = $('pinBtn');
  if (pin) pin.hidden = want;
  if (want && S.pinMode) setPinMode(false);
  if (!want) {
    destroyDesignEditor();
    S.designMountEl = null;
  }
  renderViewer();
  renderDesignState();  // «שמור כתבנית» only shows while design is armed
}

// v2.1 — undo/redo, the save chip and «שמור כתבנית» are the EDITING session's
// controls, so they travel into the sidebar's head while it is armed and come
// back to the action bar when it closes. The SAME nodes are re-parented:
// nothing is duplicated, and renderHistButtons / renderDesignState keep
// working on them without knowing where they currently live.
function moveEditChrome(on) {
  const head = document.getElementById('editPanelHead');
  const bar = $('actionBar');
  if (!head || !bar) return;
  const movers = [histUndoBtn, histRedoBtn, saveChipEl, tplSaveBtn].filter(Boolean);
  // v2.7 — the ✕ leads the head (inline-start = RIGHT in RTL, where a thumb
  // reaches). It is CSS-hidden above 920px, so desktop chrome is unchanged;
  // it belongs to the head, not to the action bar, so it never travels back.
  if (on) { head.replaceChildren(fsExit(), ...movers); return; }
  const dup = document.getElementById('dupBtn');
  for (const n of movers) bar.insertBefore(n, dup || null);
}

function wireDesignBtn() {
  const b = $('designBtn');
  if (!b) return;
  b.addEventListener('click', () => setDesign(!S.design));
  renderDesignBtn();
}

// v2.3 — the in-app editor cannot edit pixels. An uploaded re-render is final
// artwork with no template and no vars behind it, so «עיצוב» is disabled (not
// hidden: the reason has to be readable, and a missing button explains nothing).
// Re-evaluated on every render because an upload can flip this mid-session.
const IMG_SLIDE_NOTE = 'גרסה שהועלתה כקבצים — עריכה בכלי זמינה רק על גרסת תבנית';

function renderDesignBtn() {
  const b = $('designBtn');
  if (!b) return;
  const img = hasImageSlides();
  b.hidden = !hasSlidesData();
  b.disabled = img;
  b.title = img ? IMG_SLIDE_NOTE : '';
}

// ---------------------------------------------------------------------------
// «English» — the READ-ONLY translation TAB (v2.3)
//
// Operator change 08-01: this used to be a «🌐 English» button in the viewer's
// control row that swapped a THIRD aside (#transPanel) into the panel column,
// mutually exclusive with design mode. It is now an ordinary tab, rendered by
// the same tab machinery as כיתוב / הערות / …, which keeps the sticky viewer
// column — the Hebrew slide — on screen beside it. Nothing about the read-only
// law below changed; only where the content is mounted.
//
// THE LAW THIS CODE EXISTS TO KEEP: English never reaches the Hebrew source of
// truth. Reviewer edits flow out through sync.mjs into
// studio/content/captions/*.json, so an editable English field would eventually
// land English in the factory's Hebrew files. Therefore this whole section is a
// PURE RENDER: it creates no input, no textarea, no contenteditable, registers
// no handler that calls a store write function, adds no key to S.pending, and
// changes nothing about histSnapshot(). `translation` is likewise never put in
// a client write payload — the guarantee is this audited client, not a grant
// (anon holds table-wide UPDATE on sm_posts, ENGINEERING-NOTES §14).
//
// And because the column IS anon-writable, its content is untrusted input on
// READ — treated exactly like reviewer text. Hence the whitelist renderer
// below and no `innerHTML` anywhere in this file's translation path.
// ---------------------------------------------------------------------------

// Hebrew block U+0590–U+05FF. Written in ESCAPE form on purpose: a literal
// Hebrew character class inside an LTR source file is a bidi hazard — it is
// invisible in a diff, reads as two mystery glyphs to anyone auditing the rule,
// and reorders on screen so the source shows something other than what is
// stored. The escapes are the same block, legible and copy-safe. (The comment
// said this while the code did the opposite until 08-01; studio/translate.mjs's
// RE_HEBREW has always been the escaped form — these two must stay identical,
// they are the same rule in two producers.)
const HEB_RE = /[\u0590-\u05FF]/;

// Never translated, whatever they contain: structural slide keys and the
// illustration name. (`template`/`design` are slide keys, not vars — listed so
// the rule reads completely in one place.)
const TRANS_DENY = new Set(['template', 'design', 'ill']);

const TR_EMPTY = 'אין עדיין תרגום לפוסט הזה — התרגום נוצר במפעל ויגיע בעדכון הבא';
const TR_STALE_CHIP = '⚠️ העברית עודכנה אחרי התרגום';
const TR_MISSING_CHIP = 'טרם תורגם';
const TR_STALE_NOTE = 'חלק מהטקסט בעברית השתנה אחרי שהתרגום נוצר — הקטעים המסומנים אינם מעודכנים';
// The two halves of the slide-moved note, split so the template name can be
// isolated with <bdi> between them (SHOULD-FIX 5, 08-01). Says the ONE true
// thing: the slide order moved, so nothing here can be matched — NOT the false
// «טרם תורגם» that positional indexing used to produce for every field.
const TR_MOVED_A = 'סדר השקפים השתנה מאז שהתרגום נוצר — התרגום ששמור במקום הזה שייך לתבנית ';
const TR_MOVED_B = ', ולכן אין לו התאמה לשקף הזה. הטקסט יופיע שוב אחרי תרגום מעודכן מהמפעל.';
// Operator resolution 2: hashtags are translated to natural English, so the
// panel has to say plainly that nothing here publishes — the Hebrew is what
// ships to Instagram.
const TR_SUB = 'תרגום לקריאה בלבד — מה שמתפרסם הוא תמיד העברית';

// Does this var get translated at all? Value must contain Hebrew, must not be
// a denylisted key, and must not be an illustration name (defence in depth for
// the `{{ill:$var}}` templates, which take a drawing name in an ordinary var).
function transTranslatable(key, val) {
  if (TRANS_DENY.has(key)) return false;
  const s = String(val ?? '');
  if (!HEB_RE.test(s)) return false;
  const m = manifest();
  if (m && Array.isArray(m.illustrations) && m.illustrations.includes(s)) return false;
  return true;
}

// The post's stored translation object, defensively parsed. jsonb comes back
// as an object from PostgREST and from serve.mjs alike; the string branch is
// belt-and-braces for an older cached client, not an expected shape.
function transDoc() {
  let t = S.post && S.post.translation;
  if (typeof t === 'string') { try { t = JSON.parse(t); } catch { return null; } }
  return t && typeof t === 'object' ? t : null;
}

// THE WHITELIST RENDERER — the stored-XSS gate on an anon-writable column.
// Exactly five tokens become elements: <b> </b> <bdi> </bdi> <br>. Everything
// else in the string — including any other tag, attribute or entity — is
// appended as a literal TEXT NODE and can never be parsed as markup. This is a
// security boundary, not a styling convenience: never swap it for innerHTML,
// insertAdjacentHTML, or a DOMParser.
const TR_TAG_RE = /(<b>|<\/b>|<bdi>|<\/bdi>|<br>)/g;

// Two passes, and the first one is the fix for a real defect (POLISH 2, 08-01):
// the single-pass version pushed an opening tag onto the stack and never
// unwound it at end-of-string, so ONE unclosed `<b>` in a corrupt or hostile
// payload silently bolded the entire remainder of that field. Unwinding the
// stack after the fact cannot undo that — the text was already appended INSIDE
// the open element — so matching is decided over the whole token list FIRST.
//
// The rule is now symmetric and states itself in one line: a tag is markup only
// if it has a partner. An unmatched OPEN tag is literal text for exactly the
// same reason an unmatched CLOSE tag always was. Well-formed translations are
// untouched — translate.mjs's --check asserts tag-sequence equality with the
// Hebrew source, so only corrupt/hostile input ever takes this path — and the
// stack is balanced by construction, i.e. fully unwound, before pass 2 ends.
function transRich(s) {
  const parts = String(s ?? '').split(TR_TAG_RE).filter((p) => p !== '' && p !== undefined);

  // pass 1 — which tokens are real markup?
  const isMarkup = new Array(parts.length).fill(false);
  const open = [];                        // indices of opens still seeking a close
  parts.forEach((p, i) => {
    if (p === '<b>' || p === '<bdi>') { open.push(i); return; }
    if (p !== '</b>' && p !== '</bdi>') return;
    const want = p === '</b>' ? '<b>' : '<bdi>';
    for (let j = open.length - 1; j >= 0; j--) {
      if (parts[open[j]] !== want) continue;
      isMarkup[open[j]] = true;
      isMarkup[i] = true;
      open.length = j;   // anything opened inside it and never closed stays literal
      return;
    }
  });

  // pass 2 — build. Every element created here is <b>, <bdi> or <br>, and it is
  // created with document.createElement: no string ever becomes markup.
  const frag = document.createDocumentFragment();
  const stack = [frag];
  const top = () => stack[stack.length - 1];
  parts.forEach((p, i) => {
    if (p === '<br>') { top().appendChild(document.createElement('br')); return; }
    if (!isMarkup[i]) { top().appendChild(document.createTextNode(p)); return; }
    if (p === '<b>' || p === '<bdi>') {
      const n = document.createElement(p === '<b>' ? 'b' : 'bdi');
      top().appendChild(n);
      stack.push(n);
      return;
    }
    stack.pop();   // isMarkup ⇒ this close has a partner ⇒ top() is its element
  });
  while (stack.length > 1) stack.pop();   // belt-and-braces: never leave one open
  return frag;
}

// Three honest states for one field, computed HERE in the browser against the
// CURRENT working copy — never shipped precomputed, because board slides are
// live-edited long after ingest and only this tab knows what is on screen.
function transFieldState(currentHebrew, entry) {
  if (!entry || typeof entry.en !== 'string') return { state: 'missing' };
  const fresh = fieldHash(currentHebrew) === String(entry.src_hash ?? '');
  return { state: fresh ? 'fresh' : 'stale', en: entry.en };
}

function transFieldRow(key, st) {
  const chip = st.state === 'stale'
    ? el('span', { class: 'st-chip st-chip--stale' }, TR_STALE_CHIP)
    : st.state === 'missing'
      ? el('span', { class: 'st-chip st-chip--untranslated' }, TR_MISSING_CHIP)
      : null;
  return el('div', { class: 'tr-field' },
    el('div', { class: 'tr-field__head' },
      // <bdi> isolates the ASCII key without setting a direction on anything
      el('bdi', { class: 'tr-key' }, key),
      chip),
    st.state === 'missing'
      ? null
      : el('div', { class: 'tr-en' + (st.state === 'stale' ? ' tr-en--stale' : '') },
        transRich(st.en)));
}

// ---- tab: English (v2.3) — a tab renderer like every other one on this page.
// Returns nodes; renderActiveTab() mounts them into #tabBody. It creates no
// input, no textarea, no contenteditable and no handler at all — that is the
// read-only law, enforced by there being nothing to type into.
function renderTransTab() {
  const head = el('div', { class: 'tr-head' },
    el('div', { class: 'tr-title' }, '🌐 English'),
    el('div', { class: 'tr-sub' }, TR_SUB));

  const doc = transDoc();
  if (!doc) return [head, el('div', { class: 'tr-empty' }, TR_EMPTY)];

  let anyStale = false;
  const cards = [];

  (Array.isArray(S.slides) ? S.slides : []).forEach((slide, i) => {
    const vars = (slide && slide.vars) || {};
    const tSlide = (Array.isArray(doc.slides) ? doc.slides : [])[i] || null;
    const tVars = (tSlide && tSlide.vars) || {};

    const cardHead = el('div', { class: 'tr-card__head' },
      el('span', { class: 'tr-card__n' }, `שקף ${i + 1}`),
      slide && slide.template ? el('bdi', { class: 'tr-tpl' }, String(slide.template)) : null);

    // the slide's OWN key order — the order the reviewer reads on the artwork
    const translatable = Object.entries(vars).filter(([k, v]) => transTranslatable(k, v));
    if (!translatable.length) return;   // image slides and text-free slides

    // SHOULD-FIX 5 (08-01). `doc.slides` is index-parallel to the SOURCE slides,
    // and the board reorders slides long after translation. A positional lookup
    // into a reordered board hands EVERY var of this slide the wrong entry,
    // every one of them misses, and a fully translated post reads «טרם תורגם»
    // from top to bottom — a lie that looks exactly like "nobody translated
    // this yet", which is the one thing this panel must never say falsely.
    // `template` is carried in the payload precisely so the mismatch is
    // detectable: when it disagrees, say THAT once, at card level, and show no
    // per-field verdict at all — there is no honest one to give.
    const movedTpl = (tSlide && slide && slide.template && tSlide.template &&
      String(tSlide.template) !== String(slide.template)) ? String(tSlide.template) : '';
    if (movedTpl) {
      cards.push(el('div', { class: 'tr-card' }, cardHead,
        el('div', { class: 'tr-note' },
          TR_MOVED_A,
          // «» per the project's Hebrew copy convention; the template name is an
          // ASCII run inside RTL text, so it is isolated with <bdi> — which sets
          // no direction on anything (RTL law, below)
          '«', el('bdi', { class: 'tr-tpl' }, movedTpl), '»',
          TR_MOVED_B)));
      return;
    }

    const rows = translatable.map(([k, v]) => {
      const st = transFieldState(v, tVars[k]);
      if (st.state === 'stale') anyStale = true;
      return transFieldRow(k, st);
    });
    cards.push(el('div', { class: 'tr-card' }, cardHead, ...rows));
  });

  const capCur = S.post.caption ?? '';
  if (String(capCur).trim()) {
    const st = transFieldState(capCur, doc.caption);
    if (st.state === 'stale') anyStale = true;
    cards.push(el('div', { class: 'tr-card' },
      el('div', { class: 'tr-card__head' }, el('span', { class: 'tr-card__n' }, 'כיתוב')),
      transFieldRow('caption', st)));
  }

  return [
    head,
    // per-field states are honest by construction, so the head note only ever
    // says "some of this is out of date" — the post never lies wholesale
    anyStale ? el('div', { class: 'tr-note' }, TR_STALE_NOTE) : null,
    ...cards,
  ];
}

// The re-render trigger the rest of this file calls (refreshAll, flushSave,
// applyRemotePost, the caption save path). Staleness is derived from the
// CURRENT working copy, so it must be recomputed whenever that copy or the
// stored translation could have moved — and it is a no-op unless the tab is
// the open one. Kept as its own name so every existing call site reads as what
// it means rather than as a generic tab refresh.
function renderTransPanel() {
  if (S.tab === 'trans') renderActiveTab(true);
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
  const render = { caption: renderCaptionTab, pins: renderPinsTab, edit: renderEditTab, photos: renderPhotosTab, info: renderInfoTab, trans: renderTransTab, gen: renderGenTab, library: renderLibraryTab }[S.tab]
    || renderCaptionTab;   // unknown/stale tab key must never throw mid-refresh
  body.replaceChildren(...[render() || []].flat(Infinity).filter(Boolean));
}

// «ספרייה» (operator 2026-08-03) — the whole assets page in an embedded frame,
// kept as ONE element across tab switches (same trick as the gen tab) so
// scroll position, filters and an in-flight upload survive a trip to another
// tab. ?embed=1 tells assets.js to hide its own nav and title.
let libFrame = null;
function renderLibraryTab() {
  if (!libFrame) {
    const params = new URLSearchParams(location.search);
    const keep = new URLSearchParams();
    if (params.get('board')) keep.set('board', params.get('board'));
    if (params.get('local')) keep.set('local', params.get('local'));
    keep.set('embed', '1');
    libFrame = el('iframe', {
      src: 'assets.html?' + keep.toString(),
      title: 'ספריית המדיה',
      style: 'width:100%;height:72vh;border:0;border-radius:12px;background:var(--paper)',
    });
  }
  return libFrame;
}

// v2.5 «יצירת תמונות» — a mount, not a renderer. generateTab() returns the
// SAME element every call (generate.js keeps it), so replaceChildren() moves
// that node back in rather than rebuilding it, and a sheet that is still
// generating survives a trip to «הערות» and back. onSaved only refreshes the
// page's data — it deliberately does NOT re-render this tab, because doing so
// mid-generation would be re-entrant for no gain; the new asset shows in
// «תמונות» the moment that tab is opened.
function renderGenTab() {
  return generateTab({
    postId: S.post.id,
    onSaved: () => { refreshAll().catch(() => {}); },
  });
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
        await castVote({ post_id: S.post.id, vote: S.voteSel, reason: why, vnum: thisVnum() });
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

// v2.3 — the round a row belongs to. NULL is not zero and not «the current
// round»: it is «written before this board tracked rounds», and it must stay
// visibly different from a real number. The 119 live posts are all NULL.
const LEGACY_ROUND = null;
function roundOf(row) {
  const n = Number(row && row.vnum);
  return Number.isFinite(n) && n > 0 ? n : LEGACY_ROUND;
}

function roundLabel(round) {
  return round === LEGACY_ROUND ? 'סבב מוקדם (לפני מעקב גרסאות)' : `סבב v${round}`;
}

// Rounds newest-first, legacy ALWAYS last (it predates every real number).
function sortRoundsDesc(rounds) {
  return [...rounds].sort((a, b) => {
    if (a === LEGACY_ROUND) return 1;
    if (b === LEGACY_ROUND) return -1;
    return b - a;
  });
}

// Round headers newest-first; inside each round the existing per-slide
// grouping is untouched, so «מעבר לשקף» keeps working exactly as before.
function renderPinsTab() {
  if (!S.pins.length) {
    return [el('div', { class: 'pv-note' },
      'אין עדיין הערות על השקפים. לוחצים על «📍 הוסף הערה על השקף», ואז על הנקודה המדויקת בשקף.')];
  }
  const byRound = new Map();
  for (const p of S.pins) {
    const r = roundOf(p);
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(p);
  }

  return sortRoundsDesc([...byRound.keys()]).map((round) => {
    const pins = byRound.get(round);
    const bySlide = new Map();
    for (const p of pins) {
      const k = Number(p.slide);
      if (!bySlide.has(k)) bySlide.set(k, []);
      bySlide.get(k).push(p);
    }
    const groups = [...bySlide.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([slideIdx, sPins]) => {
        const h = el('h4', { title: 'מעבר לשקף' },
          `שקף ${slideIdx + 1}`, el('span', { class: 'tag' }, String(sPins.length)));
        h.addEventListener('click', () => goTo(slideIdx));
        return el('div', { class: 'pin-group' }, h, sPins.map(renderPinCard));
      });
    return el('div', {
      class: 'pin-round' + (round === LEGACY_ROUND ? ' pin-round--legacy' : ''),
    },
      el('h3', null, roundLabel(round), el('span', { class: 'tag' }, String(pins.length))),
      groups,
    );
  });
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

  // v2.3 — an OPEN comment written against an older round may already have been
  // answered by a later version. We SURFACE that; we never guess it resolved.
  // A NULL round says nothing (no backfill), so it earns no badge.
  const round = roundOf(pin);
  const now = thisVnum();
  const oldRound = (!resolved && round !== LEGACY_ROUND && round < now)
    ? el('span', { class: 'ap-old' }, `נכתב על v${round} — ייתכן שטופל בגרסה v${now}`)
    : null;

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
      oldRound,
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
  // v2.3 — image slides carry no vars, so there is nothing to type into. Say
  // that in the copy §9 fixes, rather than showing an empty accordion.
  if (hasImageSlides()) {
    return [
      el('div', { class: 'pv-note' }, IMG_SLIDE_NOTE),
      el('div', { class: 'pv-note' },
        'אפשר להעיר על השקפים בלשונית «הערות», או להעלות גרסה מתוקנת מהלשונית «פרטים».'),
      renderEditHistory(),
    ];
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
  // v2.3: sm_post_versions has no note column, so an uploaded version's note
  // rides an sm_edits row under this field name (store.uploadRenderVersion).
  if (field === 'version.upload') return 'הערה על גרסה שהועלתה';
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
      renderTransPanel();   // v2.3 — caption changed: its translation may now be stale
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
  // v2.8: until now this tab said NOTHING between the picker closing and the
  // grid repainting — on a phone that is a minute of a dead-looking page. The
  // bar lives inside the tab's own DOM; renderActiveTab() only re-renders
  // AFTER the batch is finished, so nothing yanks it mid-upload.
  const prog = uploadProgress();
  drop.addEventListener('click', () => file.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('over');
    intake([...(e.dataTransfer.files || [])].filter((f) => /^image\//.test(f.type)), note.value.trim());
  });
  // v2.6: the snapshot happens FIRST and the input is released only after it.
  // These Files are lazily-materialized transcode temps on iOS; the old code
  // held the list and read each one minutes later, by which time every file
  // after the first was gone. Nothing is dropped silently — every failure is
  // named, but in ONE line: a per-file toast meant a phone selection that went
  // stale produced 138 stacked toasts and buried the page.
  file.addEventListener('change', async () => {
    const picked = [...file.files];
    const noteText = note.value.trim();
    await intake(picked, noteText);
    file.value = '';
  });

  async function intake(files, noteText) {
    if (!files.length) return;
    // Refused BEFORE the snapshot, or a 200-photo selection copies 1.6GB into
    // the tab on the way to being rejected. This path had no cap at all; the
    // numbers are imgprep's, shared with the generate pickers.
    const tooBig = batchTooBig(files);
    // The cap refusal shows a toast and uploads nothing — the bar stays down.
    if (tooBig) { toast(tooBig, 'err'); return; }
    prog.phase('מכינים את התמונות…');
    const snap = await snapshotFiles(files);
    if (snap.failed.length) toast(summarizeFailures(snap.failed), 'err');
    await uploadFiles(snap.ok, noteText);
  }

  async function uploadFiles(files, noteText) {
    // Every file went stale in the snapshot: the toast above already named
    // them, and there is no batch left to show progress for.
    if (!files.length) { prog.hide(); return; }
    const failed = [];
    let ok = 0;
    prog.start(files.length);
    for (const f of files) {
      try {
        await uploadPhoto({ post_id: S.post.id, pin_id: null, file: f, note: noteText });
        ok++;
      } catch (e) {
        failed.push({ name: f.name, reason: (e && e.message) || String(e) });
      }
      prog.tick(ok + failed.length, f.name);
    }
    if (ok) toast(ok === 1 ? 'התמונה עלתה' : `${ok} תמונות עלו`, 'ok');
    if (failed.length) toast(summarizeFailures(failed), 'err');
    note.value = '';
    // Same paint-honesty rule as the assets dock: the FULL bar stays on screen
    // across the awaited refresh, and the tab re-render is what retires it.
    // hide() after is the belt for the path where the re-render never happens.
    await refreshAll();
    renderActiveTab(true); // own action: show the new photo even if an input still has focus
    prog.hide();
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
        // v2.9. Styled inline rather than with a class because post.html is not
        // on this build's allowlist — the shared .btn look is borrowed, the two
        // card-scale numbers are set here.
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          style: {
            minHeight: '0', padding: '3px 9px', fontSize: '.72rem',
            justifySelf: 'start', borderColor: 'var(--line)', color: 'var(--ink-soft)',
          },
          onclick: () => deletePhotoDialog(ph),
        }, '🗑 מחיקה'),
      ),
    );
  });

  return [
    drop,
    prog.root,
    el('div', { class: 'ph-note-row' }, note),
    file,
    cards.length
      ? el('div', { class: 'ph-grid' }, cards)
      : el('div', { class: 'pv-note' }, 'אין עדיין תמונות לפוסט הזה.'),
  ];
}

/* v2.9 — removing a photo from the תמונות tab (spec 12).

   SOFT, and undoable for 10s, which is the same decision twice: the stamp is
   what makes the undo a null-out instead of a re-upload.

   A photo PINNED to an open note KEEPS its pin. sm_pins holds the reference,
   nothing about the pin row changes, and the pin's own card goes on rendering —
   the photo simply stops appearing in this tab. Saying so in the confirm is the
   difference between a reviewer tidying up and a reviewer afraid to touch
   anything. */
function deletePhotoDialog(ph) {
  const secs = Math.round(UNDO_MS / 1000);
  const pinned = !!ph.pin_id;

  const run = async (close) => {
    try {
      await deletePhoto(ph.id);
    } catch (e) {
      // store.js has already collapsed every unapplied-029 failure into one
      // Hebrew sentence; anything else arrives as itself.
      toast((e && e.message) || 'המחיקה נכשלה', 'err');
      return;
    }
    if (close) close();
    // Off the screen now, not after a round trip — a delete that waits to
    // become visible reads as a failure and gets clicked twice.
    S.photos = S.photos.filter((p) => p.id !== ph.id);
    renderActiveTab(true);

    undoToast('התמונה נמחקה', async () => {
      try {
        await restorePhoto(ph.id);
      } catch (e) {
        toast('השחזור נכשל: ' + ((e && e.message) || e), 'err');
        return;
      }
      // A full refresh rather than putting the row back by hand: the photo also
      // feeds the pin cards and the editor's picker (designPhotos), and only a
      // re-read restores all three to exactly what they were.
      await refreshAll();
      renderActiveTab(true);
      toast('התמונה שוחזרה', 'ok');
    });
  };

  modal('מחיקת תמונה', el('div', null,
    el('p', null, 'התמונה תרד מלשונית «תמונות» של הפוסט הזה.'),
    el('p', { class: 'pv-note' },
      `הקובץ עצמו נשמר, ושקפים שכבר עוצבו איתו ימשיכו להיראות כרגיל. ` +
      `יהיה אפשר לבטל תוך ${secs} שניות.`),
    pinned
      ? el('p', { class: 'pv-note' }, 'ההערה שאליה התמונה מוצמדת נשארת פתוחה כמו שהיא.')
      : null,
  ), { actions: [
    { label: 'ביטול' },
    { label: '🗑 מחיקה', primary: true, onClick: (c) => { run(c); return false; } },
  ] });
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

  // v2.1: the publish FORM that used to live here is gone. Scheduling (both
  // kinds) is the header's «🗓️ תזמון» button — one implementation, always
  // visible, never behind a tab. What stays here is a read-only statement of
  // where the post stands plus a shortcut to that same modal.
  const q = liveQueueRow();
  const done = (S.queue || []).filter((r) => r.status === 'published');
  const schedBtn = el('button', { class: 'btn btn--primary', type: 'button' }, '🗓️ פתיחת התזמון');
  schedBtn.addEventListener('click', () => openScheduleModal());

  const lines = [];
  if (q) {
    lines.push(el('span', { class: 'pv-note' }, q.scheduled_for
      ? `בתור לפרסום (${CHANNEL_LABELS[q.channel] || q.channel}) · ${fmtWhen(q.scheduled_for)}`
      : `בתור לפרסום (${CHANNEL_LABELS[q.channel] || q.channel}) · בהרצה הקרובה`));
  }
  if (S.post.review_at) {
    lines.push(el('span', { class: 'pv-note' }, `מתוזמן לבדיקה · ${fmtWhen(S.post.review_at)}`));
  }
  if (done.length) {
    lines.push(el('span', { class: 'pv-note' }, `פורסם ${done.length === 1 ? 'פעם אחת' : done.length + ' פעמים'} · אחרון: ${fmtWhen(done[0].updated_at || done[0].created_at)}`));
  }
  if (!lines.length) {
    lines.push(el('span', { class: 'pv-note' }, 'הפוסט לא מתוזמן — לא לפרסום ולא לבדיקה.'));
  }
  if (!canQueueStage()) {
    lines.push(el('span', { class: 'pv-note' },
      `לפני פרסום כדאי להעביר את הפוסט לשלב «${stageLabel('approved')}» (עכשיו: «${stageLabel(S.post.stage)}»).`));
  }

  const publishBlock = el('div', { class: 'dt-publish' },
    el('b', null, 'תזמון'),
    ...lines,
    el('div', { class: 'dt-stage' }, schedBtn),
  );

  // «שכפל פוסט» moved to the action bar above the slide (v1.6); prev/next +
  // «לגלריה» moved to the header's .pv-nav (v1.7) — no duplicate navigation here.
  return [
    el('div', { class: 'dt-stage' }, el('span', { class: 'pv-note' }, 'שלב:'), stageSel),
    el('div', { class: 'dt-rows' }, rows),
    renderAuditTrail(),
    renderVersionsBlock(),
    publishBlock,
  ];
}

// ------------------------------------------------ «מסלול הפוסט» (v2.3, §8)
// ONE merged, newest-first timeline of three honest facts: who signed what and
// when, which versions exist, and how much review each round drew. Sign-off and
// revoke live at the TOP of this section for EVERYONE — the header button is
// only the marketing hat's shortcut to the same two actions.
//
// Every timestamp here is past-tense, so every one of them is fmtDate. fmtWhen
// is the SCHEDULING formatter; fmtDate clamps the future to «ממש עכשיו», which
// is right for a trail and wrong for a plan.
function renderAuditTrail() {
  const st = approvalNow();

  const signBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'חתימת שיווק ✓');
  signBtn.addEventListener('click', () => openApproveModal());
  const revokeBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, 'ביטול החתימה');
  revokeBtn.addEventListener('click', () => openRevokeModal());

  const entries = [];

  for (const a of (S.approvals || [])) {
    const who = a.author || 'אלמוני';
    const revoked = a.action === 'revoked';
    entries.push({
      ts: a.created_at,
      node: el('div', { class: 'au-item au-item--' + (revoked ? 'revoked' : 'approved') },
        el('span', { class: 'au-dot' }),
        el('span', { class: 'au-what' }, revoked
          ? `החתימה בוטלה ע״י ${who}`
          : `נחתם ע״י ${who} · v${Number(a.vnum)}`),
        el('time', null, fmtDate(a.created_at)),
        a.note ? el('span', { class: 'au-note' }, a.note) : null,
      ),
    });
  }

  for (const v of (S.versionRows || [])) {
    let slides = v.slides;
    if (typeof slides === 'string') { try { slides = JSON.parse(slides); } catch { slides = []; } }
    const uploaded = Array.isArray(slides) && slides.some(isImageSlide);
    entries.push({
      ts: v.created_at,
      node: el('div', { class: 'au-item au-item--version' },
        el('span', { class: 'au-dot' }),
        el('span', { class: 'au-what' }, `נשמרה גרסה v${Number(v.vnum)} · ${v.author || 'אלמוני'}`),
        uploaded ? el('span', { class: 'tag' }, 'גרסה שהועלתה כקבצים') : null,
        el('time', null, fmtDate(v.created_at)),
      ),
    });
  }

  // per-round counts, placed in the trail at the round's LAST activity — an
  // aggregate still belongs somewhere in time, and «when it stopped» is the
  // only honest point to hang it on.
  const rounds = new Map();
  const bump = (row, key) => {
    const r = roundOf(row);
    if (!rounds.has(r)) rounds.set(r, { pins: 0, edits: 0, ts: '' });
    const b = rounds.get(r);
    b[key]++;
    const t = String(row.created_at || '');
    if (t > b.ts) b.ts = t;
  };
  for (const p of (S.pins || [])) bump(p, 'pins');
  for (const e of (S.edits || [])) bump(e, 'edits');

  for (const [round, b] of rounds) {
    const parts = [];
    if (b.pins) {
      const link = el('button', { class: 'au-link', type: 'button' },
        `${b.pins} ${b.pins === 1 ? 'הערה' : 'הערות'}`);
      link.addEventListener('click', () => showTab('pins'));
      parts.push(link);
    }
    if (b.edits) {
      const link = el('button', { class: 'au-link', type: 'button' },
        `${b.edits} ${b.edits === 1 ? 'עריכה' : 'עריכות'}`);
      link.addEventListener('click', () => showTab('edit'));
      parts.push(link);
    }
    if (!parts.length) continue;
    const line = [];
    parts.forEach((p, i) => { if (i) line.push(' · '); line.push(p); });
    entries.push({
      ts: b.ts,
      node: el('div', { class: 'au-item au-item--round' },
        el('span', { class: 'au-dot' }),
        el('span', { class: 'au-what' }, roundLabel(round), ' · '),
        ...line,
        el('time', null, fmtDate(b.ts)),
      ),
    });
  }

  entries.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));

  return el('div', { class: 'dt-audit' },
    el('b', null, 'מסלול הפוסט'),
    el('div', { class: 'ap-actions' },
      approvalChip(),
      signBtn,
      canRevoke(st) ? revokeBtn : null,
    ),
    entries.length
      ? el('div', { class: 'au-list' }, entries.map((e) => e.node))
      : el('div', { class: 'pv-note' }, 'עוד אין מסלול לפוסט הזה — אין חתימות ואין גרסאות שמורות.'),
  );
}

// «גרסאות» — the upload entry point (§4b). The trail itself is rendered above;
// this block is the one action that ADDS to it from the browser.
function renderVersionsBlock() {
  const upBtn = el('button', { class: 'btn btn--ghost', type: 'button' }, 'העלאת גרסה מעוצבת');
  upBtn.addEventListener('click', () => openUploadVersionModal());
  return el('div', { class: 'dt-versions' },
    el('b', null, 'גרסאות'),
    el('span', { class: 'pv-note' },
      `הגרסה שמוצגת עכשיו: v${thisVnum()} · ${(S.versionRows || []).length} גרסאות שמורות בלוח.`),
    hasImageSlides()
      ? el('span', { class: 'pv-note' },
          'גרסה שהועלתה כקבצים — עריכה בכלי זמינה רק על גרסת תבנית')
      : null,
    el('div', { class: 'ap-actions' }, upBtn),
  );
}

// ---------------------------------------------------------------- keyboard

function onKeydown(e) {
  const t = e.target;
  // native text undo owns inputs/textareas/contentEditable until commit
  if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
  // v2.2 — while the design editor is armed IT owns the keyboard. Both
  // handlers sit on document and both would run: without this, one ⌘Z undid
  // twice (the editor forwards ⌘Z straight back to undoStep below), and one
  // ArrowLeft both nudged the selected element AND paged to the next slide.
  // Arrows only defer when something is actually selected — with an empty
  // selection there is nothing to nudge, so they keep paging.
  const armed = designMode() && S.designCtrl;
  if (armed) {
    if (e.metaKey || e.ctrlKey) return;            // undo/redo, copy/paste/duplicate
    if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Escape') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') return;
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        typeof S.designCtrl.hasSelection === 'function' && S.designCtrl.hasSelection()) return;
  }
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
