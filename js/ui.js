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
//   navBar(active)                   shared top bar ('index'|'build'|'discuss'|
//                                    'assets'|'queue'|'backend')
//   injectFonts(assetUrlFn)          runtime @font-face for Assistant

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

export function toast(msg, kind = '') {
  if (!toastWrap || !document.body.contains(toastWrap)) {
    toastWrap = el('div', { class: 'toast-wrap' });
    document.body.appendChild(toastWrap);
  }
  const t = el('div', { class: 'toast' + (kind ? ' toast--' + kind : '') }, msg);
  toastWrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  setTimeout(() => {
    t.classList.remove('toast--in');
    setTimeout(() => t.remove(), 300);
  }, 3500);
  return t;
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

// Identity + board name are read from localStorage (written by store.js) and
// refreshed via window events, so ui.js never imports store.js (no cycle):
//   'smr:board' {detail:{name}}  — board display name resolved
//   'smr:name'  {detail:{name}}  — reviewer renamed / named themselves
export function navBar(active) {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get('board')) keep.set('board', params.get('board'));
  if (params.get('local')) keep.set('local', params.get('local'));
  const q = keep.toString() ? '?' + keep.toString() : '';

  const links = [
    { key: 'index', href: 'index.html' + q, label: 'הגלריה' },
    { key: 'build', href: 'build.html' + q, label: 'בונים פוסט' },
    { key: 'discuss', href: 'discuss.html' + q, label: 'שיחות' },
    { key: 'assets', href: 'assets.html' + q, label: 'נכסים' },
    { key: 'queue', href: 'queue.html' + q, label: 'תור פרסום' },
    { key: 'backend', href: 'backend.html' + q, label: 'Backend' },
  ];

  const boardName = () => localStorage.getItem('smr:bname') || 'לוח ביקורת';
  const meName = () => localStorage.getItem('smr:name') || 'אורח';

  const boardEl = el('a', { class: 'nav__board', href: 'index.html' + q }, boardName());
  const chip = el('button', {
    class: 'nav__me chip', type: 'button', title: 'שינוי שם', onclick: rename,
  }, meName());

  window.addEventListener('smr:board', () => { boardEl.textContent = boardName(); });
  window.addEventListener('smr:name', () => { chip.textContent = meName(); });

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

  return el('header', { class: 'nav' },
    boardEl,
    el('nav', { class: 'nav__links' },
      links.map((l) => el('a', {
        class: 'nav__link' + (l.key === active ? ' nav__link--on' : ''),
        href: l.href,
      }, l.label)),
    ),
    chip,
  );
}
