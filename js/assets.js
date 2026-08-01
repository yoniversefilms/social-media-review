// assets.js — «נכסים»: the board's whole asset library on one page.
// Owner: asset-library module (v2.0). Contract: PLAN.md «The cloud asset
// library». Talks to the backend ONLY through store.js; shared UI via ui.js.
//
// One list, two populations (see schema.sql §18):
//   source 'upload' — reviewer uploads, bytes in sm-photos. post_id set when
//     the file was uploaded ON a post (it also shows in that post's תמונות tab).
//   source 'studio' — the studio's own SVGs, bytes already in the sm-assets
//     mirror; rows exist so ONE library lists everything. ingest emits
//     manifest.library, go-live seeds the rows, and this page reconciles
//     whatever is still missing (idempotent, keyed by kind+name).

import {
  initStore, assetUrl, listAssets, uploadAsset, updateAsset,
  reconcileStudioAssets, assetRowUrl, listPosts, subscribe,
} from './store.js';
import { el, modal, toast, fmtDate, navBar } from './ui.js';

const $ = (id) => document.getElementById(id);

const KINDS = [
  { key: 'all', label: 'כל הנכסים' },
  { key: 'photo', label: 'תמונות' },
  { key: 'illustration', label: 'איורים' },
  { key: 'brand', label: 'נכסי מותג' },
  { key: 'logo', label: 'לוגו' },
];
const KIND_LABEL = {
  photo: 'תמונה', logo: 'לוגו', illustration: 'איור',
  brand: 'נכס מותג', other: 'אחר',
};
// What a NEW upload is filed as. The reviewer picks; the default follows the
// file type, because that is right far more often than not.
const UPLOAD_KINDS = ['photo', 'logo', 'illustration', 'brand', 'other'];

const S = {
  board: null,
  assets: [],
  posts: [],
  usage: new Map(),     // asset id -> [{id, title}]
  kind: 'all',
  q: '',
  onlyUploads: false,
};

/* ── boot ── */

(async function boot() {
  try {
    S.board = await initStore();
  } catch (err) {
    $('grid').replaceChildren(el('p', { class: 'empty' },
      el('b', null, 'לא הצלחנו להתחבר ללוח. '),
      'בדקו שהקישור שקיבלתם שלם, ונסו לרענן.'));
    return;
  }
  $('nav').replaceChildren(navBar('assets'));
  renderToolbar();
  await refresh({ reconcile: true });
  subscribe(() => { refresh().catch(() => {}); });
})();

/* ── data ── */

// The studio's own assets, from the manifest ingest writes beside them. A
// miss here is not fatal: the library still lists everything that has rows.
async function studioLibrary() {
  try {
    const res = await fetch(assetUrl('studio/manifest.json') + '?v=' + Date.now());
    if (!res.ok) return [];
    const man = await res.json();
    return Array.isArray(man.library) ? man.library : [];
  } catch {
    return [];
  }
}

async function refresh({ reconcile = false } = {}) {
  if (reconcile) {
    const lib = await studioLibrary();
    if (lib.length) {
      try { await reconcileStudioAssets(lib); }
      catch (e) { console.warn('studio reconcile skipped:', e && e.message); }
    }
  }
  const [assets, posts] = await Promise.all([
    listAssets().catch(() => []),
    listPosts().catch(() => []),
  ]);
  S.assets = assets;
  S.posts = posts;
  S.usage = buildUsage(assets, posts);
  renderToolbar();
  renderGrid();
}

// "Where used" — scan every post's slides for the asset. Uploads are found by
// their public URL (extras, filled slots, background photos all store it
// verbatim); studio drawings by NAME, which appears both as an extra's `name`
// and as a var value when a template resolves {{ill:$var}}. One stringify per
// post, then substring tests — 120 posts × ~300 assets stays instant.
function buildUsage(assets, posts) {
  const docs = posts.map((p) => ({
    id: p.id,
    title: p.title || p.id,
    json: JSON.stringify(p.slides || []),
  }));
  const usage = new Map();
  for (const a of assets) {
    const needle = a.source === 'studio'
      ? JSON.stringify(a.name)                       // "door-ajar" incl. quotes
      : (a.storage_path ? JSON.stringify(a.storage_path).slice(1, -1) : '');
    if (!needle) continue;
    const hits = [];
    for (const d of docs) if (d.json.includes(needle)) hits.push({ id: d.id, title: d.title });
    if (hits.length) usage.set(a.id, hits);
  }
  return usage;
}

function visible() {
  const q = S.q;
  const list = S.assets.filter((a) => {
    if (S.kind !== 'all' && (a.kind || 'other') !== S.kind) return false;
    if (S.onlyUploads && a.source === 'studio') return false;
    if (!q) return true;
    const hay = [a.name, a.label, ...(Array.isArray(a.tags) ? a.tags : [])]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
  // Studio drawings sort by filename; reviewer uploads keep their existing order
  // and stay first. Filename order matters because the library now ships graded
  // SETS — em-water-1..5, cn-chairs-1..5 — that only teach anything in sequence.
  // Unsorted, the grid rendered them in DB insertion order (1,2,5,4,3) and the
  // scale read as five unrelated drawings.
  return list.sort((x, y) => {
    const sx = x.source === 'studio', sy = y.source === 'studio';
    if (sx !== sy) return sx ? 1 : -1;
    if (!sx) return 0;
    return String(x.name || '').localeCompare(String(y.name || ''), 'en', { numeric: true });
  });
}

/* ── toolbar ── */

function renderToolbar() {
  const search = el('input', {
    class: 'field__input', type: 'search', value: S.q,
    placeholder: 'חיפוש לפי שם, תווית או תגית',
    oninput: () => { S.q = search.value.trim().toLowerCase(); renderGrid(); },
  });

  const chips = el('div', { class: 'a-row' }, KINDS.map((k) => el('button', {
    class: 'chip' + (S.kind === k.key ? ' chip--on' : ''), type: 'button',
    onclick: () => { S.kind = k.key; renderToolbar(); renderGrid(); },
  }, k.label)));
  chips.appendChild(el('button', {
    class: 'chip' + (S.onlyUploads ? ' chip--on' : ''), type: 'button',
    title: 'רק קבצים שהועלו כאן — בלי האיורים וחותמות המותג של הסטודיו',
    onclick: () => { S.onlyUploads = !S.onlyUploads; renderToolbar(); renderGrid(); },
  }, 'רק העלאות'));

  $('toolbar').replaceChildren(
    uploadDock(),
    el('div', { class: 'a-row' }, search, el('span', { class: 'a-count', id: 'count' })),
    chips,
  );
  updateCount();
}

function updateCount() {
  const c = $('count');
  if (!c) return;
  const n = visible().length;
  const total = S.assets.length;
  c.textContent = n === total ? `${total} נכסים` : `${n} מתוך ${total} נכסים`;
}

function uploadDock() {
  const kindSel = el('select', { title: 'איך לתייק את הקבצים החדשים' },
    el('option', { value: '' }, 'סיווג אוטומטי (לפי סוג הקובץ)'),
    UPLOAD_KINDS.map((k) => el('option', { value: k }, KIND_LABEL[k])));
  const file = el('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });
  const dock = el('div', { class: 'a-drop' },
    el('div', { style: { fontSize: '1.5rem' } }, '🗂️'),
    el('div', null, el('b', null, 'גוררים לכאן קבצים'), ', או לוחצים לבחירה — SVG · PNG · JPG · WEBP'),
    el('div', { style: { marginTop: '8px' } }, kindSel),
  );
  // the select is inside the click target: don't let choosing a kind open the
  // file dialog underneath it
  kindSel.addEventListener('click', (e) => e.stopPropagation());
  dock.addEventListener('click', () => file.click());
  dock.addEventListener('dragover', (e) => { e.preventDefault(); dock.classList.add('over'); });
  dock.addEventListener('dragleave', () => dock.classList.remove('over'));
  dock.addEventListener('drop', (e) => {
    e.preventDefault();
    dock.classList.remove('over');
    send([...(e.dataTransfer.files || [])]);
  });
  file.addEventListener('change', () => { send([...file.files]); file.value = ''; });

  async function send(files) {
    const imgs = files.filter((f) => /^image\//.test(f.type || ''));
    if (!imgs.length) { toast('אפשר להעלות רק קובצי תמונה', 'err'); return; }
    if (imgs.length < files.length) toast('קבצים שאינם תמונה דולגו');
    dock.classList.add('over');
    let ok = 0;
    for (const f of imgs) {
      try {
        // no post_id: an upload made HERE belongs to the board, not to a post
        await uploadAsset({ file: f, kind: kindSel.value || undefined });
        ok++;
      } catch (err) {
        toast(`ההעלאה של ${f.name} נכשלה: ${err && err.message || err}`, 'err');
      }
    }
    dock.classList.remove('over');
    if (ok) {
      toast(ok === 1 ? 'הנכס נוסף לספרייה' : `${ok} נכסים נוספו לספרייה`, 'ok');
      await refresh();
    }
  }

  return el('div', null, dock, file);
}

/* ── grid ── */

function renderGrid() {
  updateCount();
  const list = visible();
  if (!list.length) {
    $('grid').replaceChildren(el('p', { class: 'empty' },
      S.assets.length
        ? 'אין נכס שמתאים לסינון הזה.'
        : el('span', null, el('b', null, 'הספרייה עדיין ריקה. '),
            'מעלים כאן תמונות, לוגו או איורים — והם יהיו זמינים בכל הפוסטים.')));
    return;
  }
  $('grid').replaceChildren(el('div', { class: 'a-grid' }, list.map(card)));
}

function card(a) {
  const url = assetRowUrl(a);
  const isVec = /svg/i.test(a.mime || '') || a.source === 'studio';
  const thumb = el('div', {
    class: 'a-thumb' + (isVec ? ' a-thumb--vec' : ' a-thumb--cover'),
    title: 'הגדלה',
    onclick: () => openAsset(a, url),
  }, isVec
    // Monochrome vectors paint as a mask so they take the brand colour (see the
    // .a-thumb--vec note in assets.html). role/aria-label keep it announced, since
    // a masked div is not an <img>.
    ? el('div', {
        class: 'a-vec', role: 'img',
        'aria-label': a.label || a.name || 'נכס',
        style: `--vec:url("${url}")`,
      })
    : el('img', { src: url, alt: a.label || a.name || 'נכס', loading: 'lazy' }));
  if (a.post_id) thumb.appendChild(el('span', { class: 'a-badge' }, 'מפוסט'));

  const used = S.usage.get(a.id) || [];
  // Latin runs get their own isolated span — the separators between them are
  // bidi-neutral, so an unisolated "איור · 240×240 · 12KB" reorders on screen.
  const ltr = (t) => el('span', { class: 'ltr' }, t);
  const meta = [el('span', null, KIND_LABEL[a.kind] || a.kind)];
  if (a.width && a.height) meta.push(' · ', ltr(`${a.width}×${a.height}`));
  if (a.bytes) meta.push(' · ', ltr(`${Math.max(1, Math.round(a.bytes / 1024))}KB`));

  return el('div', { class: 'a-card' },
    thumb,
    el('div', { class: 'a-meta' },
      el('div', { class: 'a-name' }, a.label || a.name || '(ללא שם)'),
      el('div', { class: 'a-sub' }, meta),
      (Array.isArray(a.tags) && a.tags.length)
        ? el('div', { class: 'a-tags' }, a.tags.map((t) => el('span', { class: 'tag' }, t)))
        : null,
      el('div', { class: 'a-used' }, used.length
        ? el('span', null, 'בשימוש ב־', el('b', null, String(used.length)),
            used.length === 1 ? ' פוסט' : ' פוסטים')
        : 'לא בשימוש עדיין'),
      el('div', { class: 'a-acts' },
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => editAsset(a) }, 'שם ותגיות'),
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => copyLink(url) }, 'העתקת קישור'),
        used.length
          ? el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showUsage(a, used) }, 'איפה בשימוש')
          : null,
      ),
    ),
  );
}

/* ── actions ── */

function openAsset(a, url) {
  modal(a.label || a.name || 'נכס', el('div', null,
    el('img', {
      src: url, alt: a.label || a.name || '',
      style: { maxWidth: '100%', maxHeight: '68vh', display: 'block', margin: '0 auto' },
    }),
    el('div', { class: 'pv-note', style: { marginTop: '10px' } },
      [a.author ? `העלה: ${a.author}` : '', a.created_at ? fmtDate(a.created_at) : '',
       a.source === 'studio' ? 'נכס סטודיו' : ''].filter(Boolean).join(' · ')),
    el('div', { class: 'a-sub', style: { marginTop: '4px' } },
      el('span', { class: 'ltr' }, url)),
  ));
}

// label + tags are the only editable fields — matching the column-scoped
// UPDATE grant. Deleting an asset is deliberately not a browser action.
function editAsset(a) {
  const label = el('input', {
    class: 'field__input', type: 'text', maxlength: '80',
    value: a.label || '', placeholder: a.name || 'שם לתצוגה',
  });
  const tags = el('input', {
    class: 'field__input', type: 'text',
    value: (Array.isArray(a.tags) ? a.tags : []).join(', '),
    placeholder: 'תגיות, מופרדות בפסיק',
  });
  const submit = async (close) => {
    const next = {
      label: label.value.trim(),
      tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
    };
    try {
      await updateAsset(a.id, next);
      Object.assign(a, next);
      renderGrid();
      toast('נשמר', 'ok');
      if (close) close();
    } catch (e) {
      toast('השמירה נכשלה: ' + (e && e.message || e), 'err');
    }
    return true;
  };
  const m = modal('שם ותגיות', el('div', null,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'שם לתצוגה'), label),
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'תגיות'), tags),
    el('div', { class: 'pv-note' }, 'התגיות הן מה שמחפשים לפיו בבורר הנכסים בתוך העורך.'),
  ), { actions: [{ label: 'ביטול' }, { label: 'שמירה', primary: true, onClick: () => submit() }] });
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
  setTimeout(() => label.focus(), 60);
}

function copyLink(url) {
  const done = () => toast('הקישור הועתק', 'ok');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, () => fallback());
  } else fallback();
  function fallback() {
    // clipboard API needs a secure context; a select-and-copy field always works
    const box = el('input', { class: 'field__input', type: 'text', value: url });
    modal('קישור לנכס', el('div', null, box,
      el('div', { class: 'pv-note', style: { marginTop: '8px' } }, 'סמנו והעתיקו.')));
    setTimeout(() => box.select(), 60);
  }
}

function showUsage(a, used) {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get('board')) keep.set('board', params.get('board'));
  if (params.get('local')) keep.set('local', params.get('local'));
  modal('איפה הנכס בשימוש', el('div', null,
    el('p', { class: 'pv-note' }, (a.label || a.name) + ' מופיע ב־' + used.length +
      (used.length === 1 ? ' פוסט:' : ' פוסטים:')),
    el('ul', { style: { margin: '8px 0 0', paddingInlineStart: '18px' } },
      used.map((u) => {
        const q = new URLSearchParams(keep);
        q.set('id', u.id);
        return el('li', { style: { margin: '4px 0' } },
          el('a', { href: 'post.html?' + q.toString() }, u.title));
      })),
  ));
}
