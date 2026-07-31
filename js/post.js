// post.js — the review screen: one carousel, everything a therapist does to it.
// Owned by the review module. Talks to the backend ONLY through store.js;
// live preview ONLY through compose.js; shared UI through ui.js.

import {
  initStore, whoAmI, ensureName, assetUrl, slideUrl,
  listPosts, getPost,
  listVotes, latestVotes, castVote,
  listPins, addPin, deletePin, resolvePin,
  listReplies, addReply,
  listEdits, proposeEdit, setEditStatus,
  setStage, setCaption,
  listPhotos, uploadPhoto, photoUrl,
  queuePublish, subscribe,
} from './store.js';
import {
  el, modal, toast, fmtDate, voteGlyph,
  stageLabel, categoryLabel, STAGES, navBar,
} from './ui.js';
import { initCompose, mountSlide } from './compose.js';

const $ = (id) => document.getElementById(id);

const VOTE_LABELS = { yes: 'כן', no: 'לא', maybe: 'אולי' };
const EDIT_STATUS_LABELS = { proposed: 'ממתין', accepted: 'התקבל', rejected: 'נדחה', applied: 'יושם' };
const CHANNEL_LABELS = { instagram: 'אינסטגרם', facebook: 'פייסבוק', both: 'שניהם' };

// ---------------------------------------------------------------- state

const S = {
  board: null,          // {board_key, name, local} from initStore
  me: null,             // {name, author_id}
  post: null,
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
  tab: 'vote',
  voteSel: null,        // locally selected vote before שמור
  editBase: new Map(),  // "i\tkey" -> baseline text (updated after send)
  editVals: new Map(),  // "i\tkey" -> current textarea value
  editAccEl: null,      // cached accordion element (survives re-renders)
  pendingTabRender: false,
  popover: null,
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
  return S.post.slide_count || (S.post.slides || []).length || 1;
}
function hasSlidesData() {
  return Array.isArray(S.post.slides) && S.post.slides.length > 0;
}
function edKey(i, key) { return i + '\t' + key; }

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
    S.post = await getPost(id);
  } catch (e) {
    return showError('הפוסט לא נמצא. ' + (e && e.message ? e.message : ''));
  }
  if (!S.post) return showError('הפוסט לא נמצא.');

  document.title = (S.post.title || S.post.id) + ' · בדיקת פוסט';

  $('pvHead').hidden = false;
  $('pvMain').hidden = false;
  renderHeader();
  wireViewer();
  wireCaption();
  buildTabs();
  renderViewer();
  renderCaption();

  await refreshAll();
  showTab('vote');

  listPosts().then((rows) => {
    S.posts = Array.isArray(rows) ? rows : [];
    if (S.tab === 'info') renderActiveTab();
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
    const capOpen = !$('capEditor').hidden;
    S.post = post;
    renderHeader();
    if (!capOpen) renderCaption();
  }
  S.votes = votes;
  S.pins = pins.slice().sort((a, b) =>
    (a.slide - b.slide) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  S.edits = edits;
  S.photos = photos;

  const reps = await Promise.all(S.pins.map((p) => listReplies(p.id).catch(() => [])));
  S.repliesByPin = new Map(S.pins.map((p, i) => [p.id, reps[i]]));

  renderPinLayer();
  renderTabBadges();
  renderActiveTab();
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
}

// ---------------------------------------------------------------- viewer

function wireViewer() {
  $('nextBtn').addEventListener('click', () => goTo(S.cur + 1));
  $('prevBtn').addEventListener('click', () => goTo(S.cur - 1));
  $('pinBtn').addEventListener('click', () => setPinMode(!S.pinMode));
  $('liveToggle').addEventListener('change', (e) => setLive(e.target.checked));

  const frame = $('frame');

  // swipe/drag: leftward = next (RTL carousel)
  let down = null;
  frame.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.pv-pop') || e.target.closest('.pv-arrow') || e.target.closest('.pin-dot')) return;
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
      const rect = frame.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      openPinPopover(x, y);
    }
  });
  frame.addEventListener('pointercancel', () => { down = null; });

  $('slideImg').addEventListener('error', () => {
    frame.classList.add('noimg');
    if (hasSlidesData() && !S.live && !S.composeFailed) setLive(true, { silent: true });
  });
  $('slideImg').addEventListener('load', () => frame.classList.remove('noimg'));
}

function goTo(i) {
  const n = slideTotal();
  const next = Math.min(n - 1, Math.max(0, i));
  if (next === S.cur) return;
  S.cur = next;
  closePopover();
  renderViewer();
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

  $('liveWrap').hidden = !hasSlidesData();
  $('composeHost').hidden = !S.live;
  img.style.visibility = S.live ? 'hidden' : '';
  if (S.live) mountPreviewSoon(0);

  renderPinLayer();
}

// ------------------------------------------------ live preview (compose)

let previewTimer = null;
let previewSeq = 0;

async function setLive(on, opts = {}) {
  const toggle = $('liveToggle');
  if (on && !S.composeReady) {
    try {
      await initCompose(assetUrl);
      S.composeReady = true;
    } catch (e) {
      console.error('initCompose failed', e);
      S.composeFailed = true;
      toggle.checked = false;
      if (!opts.silent) toast('התצוגה החיה לא נטענה — מוצג הרינדור הרגיל', 'err');
      return;
    }
  }
  S.live = on;
  toggle.checked = on;
  renderViewer();
}

function mountPreviewSoon(delay = 300) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => { mountPreview().catch(() => {}); }, delay);
}

async function mountPreview() {
  if (!S.live) return;
  const slide = (S.post.slides || [])[S.cur];
  const host = $('composeHost');
  if (!slide) { host.replaceChildren(el('div', { class: 'pv-note', style: { padding: '20px' } }, 'אין נתוני מקור לשקף הזה')); return; }

  const vars = { ...slide.vars };
  for (const [k, v] of S.editVals) {
    const [i, key] = k.split('\t');
    if (Number(i) === S.cur) vars[key] = v;
  }

  const seq = ++previewSeq;
  try {
    const tmp = el('div', { style: { position: 'absolute', inset: '0' } });
    await mountSlide(tmp, { template: slide.template, vars });
    if (seq !== previewSeq) return; // a newer keystroke superseded this mount
    host.replaceChildren(tmp);
  } catch (e) {
    console.error('mountSlide failed', e);
    if (seq !== previewSeq) return;
    toast('שגיאה בתצוגה החיה — חוזרים לרינדור הרגיל', 'err');
    setLive(false);
  }
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

function wireCaption() {
  $('capEditBtn').addEventListener('click', () => {
    $('capTa').value = S.post.caption || '';
    $('capText').hidden = true;
    $('capEditor').hidden = false;
    $('capEditBtn').hidden = true;
    $('capTa').focus();
  });
  $('capCancel').addEventListener('click', closeCaptionEditor);
  $('capSave').addEventListener('click', async () => {
    const val = $('capTa').value;
    $('capSave').disabled = true;
    try {
      await setCaption(S.post.id, val);
      S.post.caption = val;
      toast('הכיתוב נשמר', 'ok');
      closeCaptionEditor();
      renderCaption();
    } catch (e) {
      toast('הכיתוב לא נשמר: ' + e.message, 'err');
    } finally {
      $('capSave').disabled = false;
    }
  });
}

function closeCaptionEditor() {
  $('capText').hidden = false;
  $('capEditor').hidden = true;
  $('capEditBtn').hidden = false;
}

function renderCaption() {
  const t = $('capText');
  if (S.post.caption) {
    t.classList.remove('pv-note');
    t.textContent = S.post.caption; // .cap-text preserves line breaks (pre-wrap)
  } else {
    t.classList.add('pv-note');
    t.textContent = 'אין עדיין כיתוב לפוסט הזה.';
  }
}

// ---------------------------------------------------------------- tabs

const TABS = [
  { key: 'vote', label: 'הצבעה' },
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
  const render = { vote: renderVoteTab, pins: renderPinsTab, edit: renderEditTab, photos: renderPhotosTab, info: renderInfoTab }[S.tab];
  body.replaceChildren(...[render() || []].flat(Infinity).filter(Boolean));
}

// ---------------------------------------------------------------- tab: vote

function postVoteMap() {
  return latestVotes(S.votes).get(S.post.id) || new Map();
}

function renderVoteTab() {
  const mine = postVoteMap().get(S.me.name) || null;
  if (S.voteSel === null) S.voteSel = mine ? mine.vote : null;

  const btns = ['yes', 'no', 'maybe'].map((v) => {
    const b = el('button', {
      class: `vote-btn vote-btn--${v}` + (S.voteSel === v ? ' on' : ''),
      type: 'button', 'aria-pressed': S.voteSel === v ? 'true' : 'false',
    }, el('span', { class: 'g' }, voteGlyph(v)), VOTE_LABELS[v]);
    b.addEventListener('click', () => { S.voteSel = v; renderActiveTab(true); });
    return b;
  });

  const reason = el('textarea', { class: 'field__input vote-reason', placeholder: 'למה? כמה מילים…' });
  reason.value = mine ? (mine.reason || '') : '';

  const save = el('button', { class: 'btn btn--primary', type: 'button' }, 'שמור');
  save.addEventListener('click', async () => {
    if (!S.voteSel) { toast('קודם בוחרים: כן, לא או אולי'); return; }
    save.disabled = true;
    try {
      await castVote({ post_id: S.post.id, vote: S.voteSel, reason: reason.value.trim() });
      toast('ההצבעה נשמרה', 'ok');
      await refreshAll();
    } catch (e) {
      toast('ההצבעה לא נשמרה: ' + e.message, 'err');
    } finally {
      save.disabled = false;
    }
  });

  const byAuthor = postVoteMap();
  const tallies = { yes: 0, no: 0, maybe: 0 };
  const voters = [];
  for (const [author, v] of byAuthor) {
    if (tallies[v.vote] !== undefined) tallies[v.vote]++;
    voters.push({ author, ...v });
  }
  voters.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

  return [
    el('div', { class: 'vote-row' }, btns),
    el('div', { class: 'field' }, reason),
    el('div', { style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } },
      save,
      el('span', { class: 'pv-note' }, 'הצבעה חדשה מחליפה את ההצבעה הקודמת שלך.'),
    ),
    el('div', { class: 'vote-tally' },
      el('span', null, voteGlyph('yes'), ' ', el('b', null, String(tallies.yes))),
      el('span', null, voteGlyph('no'), ' ', el('b', null, String(tallies.no))),
      el('span', null, voteGlyph('maybe'), ' ', el('b', null, String(tallies.maybe))),
      el('span', { class: 'pv-note', style: { marginInlineStart: 'auto' } },
        byAuthor.size ? `${byAuthor.size} הצביעו` : 'עוד אין הצבעות'),
    ),
    voters.map((v) => el('div', { class: 'voter' },
      el('span', { class: 'who' }, v.author),
      el('span', { class: 'v-' + v.vote }, voteGlyph(v.vote) + ' ' + (VOTE_LABELS[v.vote] || v.vote)),
      el('time', null, fmtDate(v.created_at)),
      v.reason ? el('span', { class: 'why' }, v.reason) : null,
    )),
  ];
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
  (S.post.slides || []).forEach((slide, i) => {
    const fields = editableVars(slide.vars);
    if (!fields.length) return;
    const modCount = el('span', { class: 'tag mod-count', style: { display: 'none' } }, '');
    const fieldEls = fields.map(([key, val]) => {
      const k = edKey(i, key);
      if (!S.editBase.has(k)) S.editBase.set(k, val);
      const ta = el('textarea', { class: 'field__input', rows: String(Math.min(10, Math.max(2, Math.ceil(val.length / 42)))) });
      ta.value = S.editVals.has(k) ? S.editVals.get(k) : S.editBase.get(k);
      const wrap = el('div', { class: 'ed-field' },
        el('label', null, el('span', { class: 'mod-dot' }), el('span', { class: 'key' }, key)),
        ta,
      );
      const sync = () => {
        const changed = ta.value !== S.editBase.get(k);
        if (changed) S.editVals.set(k, ta.value); else S.editVals.delete(k);
        wrap.classList.toggle('modified', changed);
        updateEditCounts(acc);
        ta.style.height = 'auto';
        ta.style.height = ta.scrollHeight + 2 + 'px';
      };
      ta.addEventListener('input', () => {
        sync();
        if (S.live) {
          if (S.cur !== i) goTo(i); // preview follows the field being edited
          mountPreviewSoon(300);    // the wow moment: types → preview updates
        }
      });
      wrap.dataset.slide = String(i);
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
  let total = 0;
  acc.querySelectorAll('details').forEach((d) => {
    const n = d.querySelectorAll('.ed-field.modified').length;
    total += n;
    const tag = d.querySelector('.mod-count');
    if (tag) { tag.style.display = n ? '' : 'none'; tag.textContent = n ? `${n} שינויים` : ''; }
  });
  const send = document.getElementById('edSendBtn');
  if (send) {
    send.disabled = !total;
    send.textContent = total ? `שלח הצעות עריכה (${total})` : 'שלח הצעות עריכה';
  }
}

function renderEditTab() {
  if (!hasSlidesData()) {
    return [el('div', { class: 'pv-note' }, 'לפוסט הזה אין נתוני מקור לעריכה — אפשר להשאיר הערות בלשונית «הערות».')];
  }
  if (!S.editAccEl) S.editAccEl = buildEditAccordion();

  const send = el('button', { class: 'btn btn--primary', type: 'button', id: 'edSendBtn' }, 'שלח הצעות עריכה');
  send.addEventListener('click', sendEditProposals);

  const out = [
    el('div', { class: 'pv-note' },
      'עורכים את הטקסט של כל שקף; עם «תצוגה חיה» דולקת רואים כל שינוי על השקף תוך כדי הקלדה. השינויים נשלחים כהצעות — שום דבר לא משתנה בפוסט עד שהמפעל מיישם.'),
    S.editAccEl,
    el('div', { class: 'ed-send' }, send,
      el('span', { class: 'pv-note' }, hasSlidesData() && !S.live ? 'טיפ: מדליקים «תצוגה חיה» ורואים את העריכה על השקף.' : ''),
    ),
    renderEditProposals(),
  ];
  requestAnimationFrame(() => updateEditCounts(S.editAccEl));
  return out;
}

async function sendEditProposals() {
  const changes = [];
  for (const [k, val] of S.editVals) {
    const [i, key] = k.split('\t');
    changes.push({ i: Number(i), key, old_text: S.editBase.get(k), new_text: val, k });
  }
  if (!changes.length) return;
  const btn = document.getElementById('edSendBtn');
  if (btn) btn.disabled = true;
  let sent = 0;
  try {
    for (const c of changes) {
      await proposeEdit({ post_id: S.post.id, field: `slides.${c.i}.${c.key}`, old_text: c.old_text, new_text: c.new_text });
      sent++;
      S.editBase.set(c.k, c.new_text); // the sent text is the new baseline
      S.editVals.delete(c.k);
    }
    toast('ההצעות נשלחו למפעל התוכן', 'ok');
  } catch (e) {
    toast(sent ? `נשלחו ${sent} הצעות, אחת נכשלה: ${e.message}` : 'ההצעות לא נשלחו: ' + e.message, 'err');
  }
  S.editAccEl = null; // rebuild with fresh baselines + markers
  await refreshAll();
  if (S.tab === 'edit') renderActiveTab(true);
}

function fieldLabel(field) {
  if (field === 'caption') return 'כיתוב הפוסט';
  if (field === 'title') return 'כותרת';
  const m = /^slides\.(\d+)\.(.+)$/.exec(field || '');
  if (m) return `שקף ${Number(m[1]) + 1} · ${m[2]}`;
  return field || '';
}

function renderEditProposals() {
  const edits = S.edits.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  if (!edits.length) return el('div', { class: 'ed-props' });
  return el('div', { class: 'ed-props' },
    el('h4', null, `הצעות עריכה (${edits.length})`),
    edits.map((ed) => {
      const chips = el('span', { class: 'chips' });
      const chip = el('span', { class: 'st-chip st-chip--' + ed.status }, EDIT_STATUS_LABELS[ed.status] || ed.status);
      chips.appendChild(chip);
      if (ed.status === 'proposed') {
        const acc = el('button', { class: 'btn btn--ghost', type: 'button' }, 'לקבל');
        const rej = el('button', { class: 'btn btn--ghost', type: 'button' }, 'לדחות');
        acc.addEventListener('click', () => decideEdit(ed.id, 'accepted'));
        rej.addEventListener('click', () => decideEdit(ed.id, 'rejected'));
        chips.append(acc, rej);
      }
      const m = /^slides\.(\d+)\./.exec(ed.field || '');
      const nameEl = el('span', { class: 'field-name', title: m ? 'מעבר לשקף' : '' }, fieldLabel(ed.field));
      if (m) { nameEl.style.cursor = 'pointer'; nameEl.addEventListener('click', () => goTo(Number(m[1]))); }
      return el('div', { class: 'ed-prop' },
        el('div', { class: 'head' },
          nameEl,
          el('span', null, ed.author || 'אלמוני'),
          el('time', null, fmtDate(ed.created_at)),
          chips,
        ),
        el('span', { class: 'diff-old' }, ed.old_text || '—'),
        el('span', { class: 'diff-new' }, ed.new_text || '—'),
      );
    }),
  );
}

async function decideEdit(id, status) {
  try {
    await setEditStatus(id, status);
    toast(status === 'accepted' ? 'ההצעה התקבלה' : 'ההצעה נדחתה', 'ok');
    await refreshAll();
  } catch (e) { toast('לא הצליח: ' + e.message, 'err'); }
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
    const img = el('img', { src: photoUrl(ph), alt: ph.note || 'תמונה', loading: 'lazy' });
    img.addEventListener('click', () => openPhotoModal(ph));
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

  // prev/next: alphabetical within this post's category
  const sibs = S.posts
    .filter((p) => p.category === S.post.category)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const idx = sibs.findIndex((p) => p.id === S.post.id);
  const prev = idx > 0 ? sibs[idx - 1] : null;
  const next = idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
  const navRow = el('div', { class: 'dt-nav' },
    prev ? el('a', { class: 'btn btn--ghost', href: pageUrl('post.html', { id: prev.id }), title: prev.title || prev.id }, '→ הקודם') : null,
    next ? el('a', { class: 'btn btn--ghost', href: pageUrl('post.html', { id: next.id }), title: next.title || next.id }, 'הבא ←') : null,
    el('a', { class: 'btn btn--ghost', href: pageUrl('index.html') }, 'חזרה לגלריה'),
  );

  return [
    el('div', { class: 'dt-stage' }, el('span', { class: 'pv-note' }, 'שלב:'), stageSel),
    el('div', { class: 'dt-rows' }, rows),
    publishBlock,
    navRow,
  ];
}

// ---------------------------------------------------------------- keyboard

function onKeydown(e) {
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.cur + 1); }       // leftward = forward (RTL)
  else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(S.cur - 1); }
  else if (e.key === 'Escape') {
    if (S.popover) closePopover();
    else if (S.pinMode) setPinMode(false);
  }
}
