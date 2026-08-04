// ui.js — shared UI primitives for the Social Media Review tool.
// Owned by the shell module. Hebrew UI, RTL. No network calls here —
// store.js is the only module that talks to a backend.
//
// Exports (per PLAN + shell contract):
//   el(tag, attrs, ...children)      DOM builder
//   modal(title, bodyEl, {actions, dismissable}) -> {close, root}
//   toast(msg, kind)                 kind: '' | 'ok' | 'err'
//   fmtDate(iso)                     Hebrew relative time (PAST only)
//   fmtWhen(iso, {relative})         absolute date+time for SCHEDULED moments
//   toLocalInput(iso) / fromLocalInput(v)   <input type=datetime-local> bridge
//   voteGlyph(v)                     'yes' | 'no' | 'maybe' -> glyph
//   stageLabel(s) / categoryLabel(c)
//   STAGES / CATEGORIES              ordered [{key, label}] arrays
//   STAGE_LABELS / CATEGORY_LABELS   plain {key: label} maps
//   navBar(active)                   shared top bar ('index'|'build'|'create-ai'|
//                                    'discuss'|'assets'|'queue'|'backend') —
//                                    carries the name chip AND the v2.3 role chip
//   ROLE_LABELS                      {marketing, therapist} Hebrew chip labels
//   injectFonts(assetUrlFn)          runtime @font-face for Assistant
//   uploadProgress()                 v2.8 shared upload bar ->
//                                    {root, start, tick, phase, hide}
//   undoToast(msg, onUndo, opts)     v2.9 10s toast with a «ביטול» button ->
//                                    {root, close}; UNDO_MS is its window

// ---------------------------------------------------------------- el

export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') {
        node.className = v;
      } else if (k === 'dataset' && typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(node.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value') {
        node.value = v;
      } else if (v === true) {
        node.setAttribute(k, '');
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, kids) {
  for (const kid of kids) {
    if (kid === null || kid === undefined || kid === false) continue;
    if (Array.isArray(kid)) { appendChildren(node, kid); continue; }
    node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

// ---------------------------------------------------------------- modal

export function modal(title, bodyEl, opts = {}) {
  const actions = opts.actions || [];
  const dismissable = opts.dismissable !== false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    overlay.classList.remove('modal-overlay--in');
    setTimeout(() => overlay.remove(), 160);
  };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };

  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'modal__head' },
      el('h3', { class: 'modal__title' }, title || ''),
      dismissable
        ? el('button', { class: 'modal__x', type: 'button', 'aria-label': 'סגירה', onclick: close }, '✕')
        : null,
    ),
    el('div', { class: 'modal__body' }, bodyEl),
    actions.length
      ? el('div', { class: 'modal__actions' },
          actions.map((a) => el('button', {
            class: 'btn ' + ((a.primary || a.kind === 'primary') ? 'btn--primary' : 'btn--ghost'),
            type: 'button',
            onclick: () => {
              // an action returning exactly false keeps the modal open
              const r = a.onClick ? a.onClick(close) : undefined;
              if (r !== false) close();
            },
          }, a.label)))
      : null,
  );

  const overlay = el('div', {
    class: 'modal-overlay',
    onclick: (e) => { if (dismissable && e.target === overlay) close(); },
  }, box);

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('modal-overlay--in'));
  return { close, root: overlay };
}

// ---------------------------------------------------------------- toast

let toastWrap = null;

function ensureToastWrap() {
  if (!toastWrap || !document.body.contains(toastWrap)) {
    toastWrap = el('div', { class: 'toast-wrap' });
    document.body.appendChild(toastWrap);
  }
  return toastWrap;
}

export function toast(msg, kind = '') {
  const wrap = ensureToastWrap();
  const t = el('div', { class: 'toast' + (kind ? ' toast--' + kind : '') }, msg);
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  setTimeout(() => {
    t.classList.remove('toast--in');
    setTimeout(() => t.remove(), 300);
  }, 3500);
  return t;
}

// ---------------------------------------------------------------- undoToast
/* v2.9 — the toast that can be ARGUED WITH. Deletion on this board is soft (a
   `deleted_at` stamp, schema §23), which only pays for itself if the way back
   is one click and is visible at the moment of regret. Both delete surfaces —
   the assets grid and the post page's תמונות tab — need the identical thing, so
   it lives here rather than twice.

   Three things it does that plain toast() cannot:
   1. It STAYS. 3.5s is a notification; 10s is a decision window. The default
      matches the sentence the confirm modal promises («10 שניות»), and both
      read UNDO_MS so the copy and the timer can never drift apart.
   2. It is CLICKABLE. .toast-wrap carries `pointer-events: none` (so a toast
      never eats a click on the page under it) and that is INHERITED — a button
      inside a normal toast is inert and looks like a bug in the restore. The
      re-enable is inline because css/app.css is not this build's to edit.
   3. It is SINGULAR. A second delete retires the first toast rather than
      stacking: two «ביטול» buttons on screen, one of them for rows you can no
      longer see, is a way to restore the wrong thing.

   The caller does the restoring. This returns {close} so a page that navigates
   away, or re-renders the thing being undone, can retire the offer honestly. */
export const UNDO_MS = 10000;

let openUndo = null;

export function undoToast(msg, onUndo, { ms = UNDO_MS, label = 'ביטול' } = {}) {
  if (openUndo) openUndo();
  const wrap = ensureToastWrap();

  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (openUndo === close) openUndo = null;
    t.classList.remove('toast--in');
    setTimeout(() => t.remove(), 300);
  };

  const btn = el('button', {
    type: 'button',
    // Inline, for the same reason as pointer-events: the shared button classes
    // live in css/app.css. currentColor keeps it legible on the dark toast
    // plate in BOTH themes without knowing which one is on.
    style: {
      font: 'inherit', fontWeight: '700', cursor: 'pointer',
      background: 'transparent', color: 'inherit',
      border: '1px solid currentColor', borderRadius: '999px',
      padding: '2px 12px', marginInlineStart: '10px',
    },
    onclick: () => {
      close();
      try { onUndo(); } catch (e) { console.error('undoToast handler failed:', e); }
    },
  }, label);

  const t = el('div', {
    class: 'toast',
    role: 'status',
    style: { pointerEvents: 'auto', display: 'flex', alignItems: 'center' },
  }, el('span', null, msg), btn);

  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  const timer = setTimeout(close, ms);
  openUndo = close;
  return { close, root: t };
}

// ---------------------------------------------------------------- fmtDate

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const sec = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (sec < 50) return 'ממש עכשיו';
  const min = Math.round(sec / 60);
  if (min < 2) return 'לפני דקה';
  if (min < 60) return `לפני ${min} דקות`;
  const hr = Math.floor(min / 60);
  if (hr === 1) return 'לפני שעה';
  if (hr === 2) return 'לפני שעתיים';
  if (hr < 24) return `לפני ${hr} שעות`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'אתמול';
  if (days === 2) return 'שלשום';
  if (days < 7) return `לפני ${days} ימים`;
  const opts = { day: 'numeric', month: 'long' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('he-IL', opts);
}

// ---------------------------------------------------------------- fmtWhen
// fmtDate() is a PAST-tense relative formatter ("לפני שעתיים") and clamps at
// zero, so a future timestamp renders as «ממש עכשיו» — wrong for anything
// scheduled. fmtWhen() is the scheduling formatter: an absolute date + time
// (the thing a reviewer actually needs), with a short relative tail in both
// directions. Times are shown in the reader's own timezone.
export function fmtWhen(iso, { relative = true } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const opts = { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  const abs = d.toLocaleString('he-IL', opts);
  if (!relative) return abs;
  const rel = relWhen(d);
  return rel ? `${abs} · ${rel}` : abs;
}

function relWhen(d) {
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
  const ahead = diffMin >= 0;
  const m = Math.abs(diffMin);
  let unit;
  if (m < 1) return 'עכשיו';
  else if (m < 60) unit = m === 1 ? 'דקה' : `${m} דקות`;
  else if (m < 60 * 24) {
    const h = Math.round(m / 60);
    unit = h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
  } else {
    const days = Math.round(m / (60 * 24));
    unit = days === 1 ? 'יום' : days === 2 ? 'יומיים' : `${days} ימים`;
  }
  return ahead ? `בעוד ${unit}` : `לפני ${unit}`;
}

// A <input type="datetime-local"> wants local wall-clock, never an ISO Z
// string — feeding it .toISOString() silently shifts the value by the UTC
// offset. These two convert in both directions, once, for every caller.
export function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  if (!value) return null;
  const d = new Date(value);          // parsed as LOCAL time — what the field means
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------- vote glyphs

const VOTE_GLYPHS = { yes: '👍', no: '👎', maybe: '🤔' };

export function voteGlyph(v) {
  return VOTE_GLYPHS[v] || '';
}

// ---------------------------------------------------------------- stages & categories

export const STAGES = [
  { key: 'in_review', label: 'בבדיקה' },
  { key: 'editing',   label: 'בעריכה' },
  { key: 'approved',  label: 'מאושר' },
  { key: 'complete',  label: 'הושלם' },
  { key: 'parked',    label: 'בהמתנה' },
];

export const CATEGORIES = [
  { key: 'meet',    label: 'הכירות' },
  { key: 'par',     label: 'הורות' },
  { key: 'cpl',     label: 'זוגיות' },
  { key: 'rel',     label: 'רילוקיישן' },
  { key: 'fam',     label: 'משפחה' },
  { key: 'ind',     label: 'טיפול פרטני' },
  { key: 'ser',     label: 'סדרות' },
  { key: 'orig',    label: 'ליבה' },
  { key: 'builder', label: 'נבנה בכלי' },
  // Posts written end-to-end with illustrations generated in the same pass
  // (studio/art/). Membership is an explicit id list in ingest.mjs, not a
  // prefix rule — these posts keep their own series prefix.
  { key: 'pcv1',    label: 'יצירת פוסט v1' },
];

export const STAGE_LABELS = Object.fromEntries(STAGES.map((s) => [s.key, s.label]));
export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

export function stageLabel(s) {
  return STAGE_LABELS[s] || s || '';
}

export function categoryLabel(c) {
  if (CATEGORY_LABELS[c]) return CATEGORY_LABELS[c];
  if (c === 'general') return 'כללי';
  return c || '';
}

// ---------------------------------------------------------------- fonts

let fontsInjected = false;

// CSS cannot know the asset base at author time, so the @font-face rule is
// injected at runtime. store.initStore() calls this automatically; pages may
// also call it directly with store's assetUrl.
export function injectFonts(assetUrlFn) {
  if (fontsInjected) return;
  fontsInjected = true;
  const url = assetUrlFn('studio/fonts/assistant.ttf');
  const style = document.createElement('style');
  style.textContent =
    `@font-face{font-family:'Assistant';src:url('${url}') format('truetype');` +
    `font-weight:200 800;font-style:normal;font-display:swap;}`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------- navBar

// The declared role (v2.3). ui.js reads and writes localStorage['smr:role']
// directly and dispatches the same 'smr:role' event store.setRole() does — it
// must never import store.js (that would be a cycle, store.js imports this).
// The two labels below are the chip's; the picker's own copy is in rolePicker.
export const ROLE_LABELS = {
  marketing: 'תפקיד: שיווק',
  therapist: 'תפקיד: צוות טיפולי',
};

const ROLE_OPTIONS = [
  { key: 'therapist', label: 'צוות טיפולי — בדיקת דיוק קליני' },
  { key: 'marketing', label: 'שיווק — אישור מותג ופרסום' },
  { key: '',          label: 'בלי תפקיד מוגדר' },
];

// Identity + board name are read from localStorage (written by store.js) and
// refreshed via window events, so ui.js never imports store.js (no cycle):
//   'smr:board' {detail:{name}}  — board display name resolved
//   'smr:name'  {detail:{name}}  — reviewer renamed / named themselves
//   'smr:role'  {detail:{role}}  — declared hat changed (v2.3)
export function navBar(active, opts = {}) {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get('board')) keep.set('board', params.get('board'));
  if (params.get('local')) keep.set('local', params.get('local'));
  const q = keep.toString() ? '?' + keep.toString() : '';

  const links = [
    { key: 'index', href: 'index.html' + q, label: 'הגלריה' },
    { key: 'build', href: 'build.html' + q, label: 'בונים פוסט' },
    // v2.5 (spec 08) — beside the from-scratch builder on purpose: same job,
    // the other way round. The builder is "I'll assemble it"; this one is
    // "describe it and the factory writes it".
    { key: 'create-ai', href: 'create-ai.html' + q, label: 'יצירה עם AI' },
    // The same image-generation module that lives inside a post (generate.js),
    // hosted standalone: create drawings/photos for the library without
    // opening a post. generateTab({postId: null}) is a supported mount.
    { key: 'generate', href: 'generate.html' + q, label: 'יצירת תמונות' },
    { key: 'discuss', href: 'discuss.html' + q, label: 'שיחות' },
    { key: 'assets', href: 'assets.html' + q, label: 'נכסים' },
    { key: 'queue', href: 'queue.html' + q, label: 'תור פרסום' },
    { key: 'backend', href: 'backend.html' + q, label: 'Backend' },
  ];

  const boardName = () => localStorage.getItem('smr:bname') || 'לוח ביקורת';
  const meName = () => localStorage.getItem('smr:name') || 'אורח';

  const myRole = () => {
    const v = localStorage.getItem('smr:role') || '';
    return (v === 'marketing' || v === 'therapist') ? v : '';
  };

  const boardEl = el('a', { class: 'nav__board', href: 'index.html' + q }, boardName());
  const chip = el('button', {
    class: 'nav__me chip', type: 'button', title: 'שינוי שם', onclick: rename,
  }, meName());

  // The role chip sits beside the name chip and is open to everyone, exactly
  // like it — a declared role changes what is prominent, never what is
  // possible, so nobody is ever stranded behind a hat they did not pick.
  const roleChip = el('button', {
    class: 'nav__role chip', type: 'button', title: 'בחירת תפקיד', onclick: rolePicker,
  });
  const paintRole = () => {
    const r = myRole();
    roleChip.textContent = r ? ROLE_LABELS[r] : 'בחירת תפקיד';
    roleChip.classList.toggle('chip--on', !!r);
    roleChip.classList.toggle('nav__role--unset', !r);
    roleChip.dataset.role = r;
  };
  paintRole();

  window.addEventListener('smr:board', () => { boardEl.textContent = boardName(); });
  window.addEventListener('smr:name', () => { chip.textContent = meName(); });
  window.addEventListener('smr:role', paintRole);

  function rolePicker() {
    const current = myRole();
    const pick = (key, close) => {
      if (key) localStorage.setItem('smr:role', key);
      else localStorage.removeItem('smr:role');
      window.dispatchEvent(new CustomEvent('smr:role', { detail: { role: key } }));
      if (close) close();
    };
    const list = el('div', { class: 'rolepick' },
      ROLE_OPTIONS.map((o) => {
        const b = el('button', {
          class: 'rolepick__opt' + (o.key === current ? ' rolepick__opt--on' : ''),
          type: 'button',
          'aria-pressed': o.key === current ? 'true' : 'false',
          onclick: () => pick(o.key, m.close),
        }, o.label);
        return b;
      }),
    );
    const m = modal('באיזה כובע אתם כאן?', list);
    return m;
  }

  // Theme toggle (dark mode 2026-08-02). The head boot snippet stamped
  // <html data-theme> before first paint; this button only flips it and
  // persists the choice as localStorage['smr:theme'] — read directly, same
  // no-cycle rule as the role chip above.
  const themeBtn = el('button', {
    class: 'nav__theme', type: 'button', onclick: flipTheme,
  });
  const paintTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeBtn.textContent = dark ? '☀️' : '🌙';
    themeBtn.title = dark ? 'מצב בהיר' : 'מצב כהה';
    themeBtn.setAttribute('aria-label', themeBtn.title);
  };
  function flipTheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('smr:theme', next); } catch { /* private mode */ }
    paintTheme();
  }
  paintTheme();

  function rename() {
    const input = el('input', {
      class: 'field__input', type: 'text', maxlength: '40',
      value: localStorage.getItem('smr:name') || '',
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(m.close); });
    const save = (close) => {
      const v = input.value.trim();
      if (!v) { input.focus(); return false; }
      localStorage.setItem('smr:name', v);
      window.dispatchEvent(new CustomEvent('smr:name', { detail: { name: v } }));
      if (close) close();
      return true;
    };
    const m = modal('איך קוראים לך?',
      el('div', { class: 'field' },
        el('label', { class: 'field__label' }, 'השם מופיע ליד ההצבעות וההערות שלך'),
        input,
      ),
      { actions: [{ label: 'שמירה', primary: true, onClick: () => save() }] },
    );
    setTimeout(() => input.focus(), 60);
  }

  const linksEl = el('nav', { class: 'nav__links', id: 'nav-links' },
    links.map((l) => el('a', {
      class: 'nav__link' + (l.key === active ? ' nav__link--on' : ''),
      href: l.href,
    }, l.label)),
  );

  // ── phone menu (v2.8-final): hamburger dropdown ────────────────────
  // On a phone the nav row keeps THREE things: ☰, the board name (which takes
  // the freed space), and the theme toggle. Everything else — the page links,
  // the role chip, the name chip — lives in a dropdown the ☰ opens. Before
  // this, the links row scrolled horizontally, which HID most of the menu
  // with no visual hint that more existed (operator: «otherwise everything
  // is hidden»). On desktop .nav__drop is display:contents, so the row is
  // pixel-identical to what it has always been.
  // (The v2.8 scroll-fold experiment that lived here is gone: nothing in the
  // nav reacts to scroll any more, on any page.)
  const drop = el('div', { class: 'nav__drop', id: 'nav-drop' },
    linksEl, roleChip, chip,
  );
  const burger = el('button', {
    class: 'nav__burger', type: 'button',
    'aria-expanded': 'false', 'aria-controls': 'nav-drop', 'aria-label': 'תפריט',
    title: 'תפריט',
  }, '☰');

  const header = el('header', { class: 'nav' },
    burger, boardEl, drop, themeBtn,
  );

  let menuOpen = false;
  const setMenu = (open) => {
    if (menuOpen === open) return;
    menuOpen = open;
    header.classList.toggle('nav--open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  burger.addEventListener('click', () => setMenu(!menuOpen));
  // tapping anywhere outside closes it; so does Escape. Link taps navigate
  // to a new page, which closes it by construction.
  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !header.contains(e.target)) setMenu(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen) setMenu(false);
  });

  return header;
}

/* ── canvas zoom control (operator quick-edit 2026-08-03) ──────────────
   One implementation for every page with a slide canvas (post.html viewer +
   design, build.html stage). Returns the ready control; `getEl()` names the
   STATIC element that carries --pv-zoom (the page's own CSS reads the var
   through inheritance — post.html #frame, build.html #stage). The zoom is
   one shared preference (smr:pvzoom): a reviewer who likes 70% likes it on
   both pages. Range 40%–200%; >100% is bounded by the column width — panning
   was deliberately not built. */
export function zoomControl({ getEl, key = 'smr:pvzoom' } = {}) {
  const MIN = 0.4, MAX = 2, STEP = 0.15;
  let z = 1;
  const pct = el('span', {
    class: 'pv-zoom__pct', title: 'איפוס ל-100%', role: 'button', tabindex: '0',
    onclick: () => set(1),
  });
  function set(v) {
    z = Math.min(MAX, Math.max(MIN, v));
    const t = getEl && getEl();
    if (t) t.style.setProperty('--pv-zoom', String(z));
    pct.textContent = Math.round(z * 100) + '%';
    try { localStorage.setItem(key, String(z)); } catch { /* private mode */ }
  }
  const btn = (glyph, title, dir) => el('button', {
    type: 'button', title,
    onclick: () => set(z + dir * STEP),
  }, glyph);
  const root = el('div', { class: 'pv-zoom', role: 'group', 'aria-label': 'זום על השקף' },
    btn('−', 'להקטין את השקף', -1), pct, btn('+', 'להגדיל את השקף', +1));
  let saved = 1;
  try { saved = parseFloat(localStorage.getItem(key)) || 1; } catch { /* ok */ }
  set(saved);
  return root;
}

// ------------------------------------------------------ uploadProgress (v2.8)

/* ONE upload bar for every surface that uploads files: the assets dock, the
   post page's תמונות tab, and both generate pickers. Deliberately BATCH-level
   — the fill moves once per FILE, never per byte. Byte-level XHR progress was
   considered and rejected: it means a second upload driver inside store.js
   (whose literal-NUL composite keys are not worth the risk) for a bar that is
   already honest at per-file granularity, because uploads here are sequential.

   API: start(total) shows it at 0; tick(done, label) advances it and names the
   file; phase(text) swaps the text line for a non-countable step (the byte
   snapshot before an upload even begins); hide() retires and resets it.

   RTL: the fill is the track's FIRST FLEX CHILD, so flex lays it out from the
   inline start — the RIGHT edge in this Hebrew UI — with no direction-aware
   CSS anywhere. An absolutely-positioned fill with `left: 0` would have grown
   from the wrong side and read as an upload running backwards. */
export function uploadProgress() {
  const line = el('div', { class: 'upbar__line' });
  const fill = el('div', { class: 'upbar__fill' });
  const track = el('div', { class: 'upbar__track', role: 'presentation' }, fill);
  const root = el('div', { class: 'upbar', hidden: true }, line, track);
  let total = 0;

  const clamp = (n, hi) => Math.max(0, Math.min(hi, Number(n) || 0));

  function paint(done) {
    const pct = total > 0 ? (done / total) * 100 : 0;
    fill.style.width = pct.toFixed(1) + '%';
    // the pulse only runs while there is work left; the last tick sits still
    root.classList.toggle('is-active', total > 0 && done < total);
  }

  function start(n) {
    total = clamp(n, Number.MAX_SAFE_INTEGER);
    root.hidden = false;
    line.textContent = `0/${total} הועלו`;
    paint(0);
  }

  function tick(done, label) {
    const d = clamp(done, total);
    line.replaceChildren(
      `${d}/${total} הועלו`,
      ...(label ? [' · ', el('span', { class: 'upbar__file' }, String(label))] : []),
    );
    root.hidden = false;
    paint(d);
  }

  // A named step with no count of its own — «מכינים את הקבצים…» while the
  // bytes are being snapshotted, which on a phone batch is the slow part.
  function phase(text) {
    root.hidden = false;
    line.textContent = String(text || '');
    root.classList.add('is-active');
  }

  function hide() {
    root.hidden = true;
    root.classList.remove('is-active');
    line.textContent = '';
    fill.style.width = '0%';
    total = 0;
  }

  return { root, start, tick, phase, hide };
}
