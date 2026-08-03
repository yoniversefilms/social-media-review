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
//
// v2.5.1 (spec 10 §A + §D-1) adds two things to this page:
//   FOLDER UPLOAD — a whole shoot, dropped or picked. It is deliberately SUGAR
//     over N single-file uploads: the same uploadAsset() per file, the same
//     type sniff, the same sm_assets row. The only new information is each
//     file's RELATIVE PATH, kept as `folder:` tags so the shoot stays findable
//     as one group.
//   EXPORT — «⬇︎ ייצוא» per card, or a multi-selection zipped. Entirely
//     client-side (canvas resample → toBlob); nothing leaves the browser and
//     no request row is created. Slide export is a different object with a
//     different answer (spec 10 §D-2, factory-side) and is NOT here.

import {
  initStore, assetUrl, listAssets, uploadAsset, updateAsset,
  reconcileStudioAssets, assetRowUrl, listPosts, subscribe, GEN_DIMS,
} from './store.js';
import { el, modal, toast, fmtDate, navBar } from './ui.js';
import { zipStore } from './zip.js';

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

// A folder drop is capped because the SERVING layer is a Supabase free tier,
// not because the browser can't take it. Bulk beyond this belongs on the
// archive path (scripts/archive-sync.mjs, spec 10 §B).
const MAX_DROP_FILES = 200;
const MAX_DROP_BYTES = 400 * 1024 * 1024;

const S = {
  board: null,
  assets: [],
  posts: [],
  usage: new Map(),     // asset id -> [{id, title}]
  kind: 'all',
  q: '',
  onlyUploads: false,
  // v2.5.1
  busy: false,          // an upload is running — background refreshes must not
                        // rebuild the dock out from under its progress line
  selMode: false,       // multi-select (for zip export)
  sel: new Set(),       // selected asset ids
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
  // A poll landing mid-upload would re-render the toolbar and take the folder
  // progress line («12/68 הועלו») with it. The upload's own refresh runs when
  // it finishes, so nothing is lost by skipping here.
  subscribe(() => { if (!S.busy) refresh().catch(() => {}); });
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
  chips.appendChild(el('button', {
    class: 'chip' + (S.selMode ? ' chip--on' : ''), type: 'button',
    title: 'לסמן כמה נכסים ולייצא אותם יחד כקובץ ZIP',
    onclick: () => {
      S.selMode = !S.selMode;
      if (!S.selMode) S.sel.clear();
      renderToolbar(); renderGrid();
    },
  }, 'בחירה מרובה'));

  $('toolbar').replaceChildren(
    uploadDock(),
    el('div', { class: 'a-row' }, search, el('span', { class: 'a-count', id: 'count' })),
    chips,
    el('div', { class: 'a-row', id: 'selbar' }),
  );
  updateCount();
  updateSelBar();
}

// The multi-select bar. Rebuilt in place (not through renderToolbar) so
// ticking a box never rebuilds the upload dock.
function updateSelBar() {
  const bar = $('selbar');
  if (!bar) return;
  if (!S.selMode || !S.sel.size) { bar.replaceChildren(); return; }
  const rows = S.assets.filter((a) => S.sel.has(a.id));
  bar.replaceChildren(
    el('span', { class: 'a-count' }, `נבחרו ${rows.length} נכסים`),
    el('button', {
      class: 'btn btn--primary', type: 'button',
      onclick: () => exportDialog(rows),
    }, '⬇︎ ייצוא'),
    el('button', {
      class: 'btn btn--ghost', type: 'button',
      onclick: () => { S.sel.clear(); renderGrid(); updateSelBar(); },
    }, 'ניקוי הבחירה'),
  );
}

function updateCount() {
  const c = $('count');
  if (!c) return;
  const n = visible().length;
  const total = S.assets.length;
  c.textContent = n === total ? `${total} נכסים` : `${n} מתוך ${total} נכסים`;
}

/* ── folder walk (spec 10 §A) ──
   Three ways files arrive, one internal shape: {file, path}. `path` is the
   file's position inside the DROP (`shoot/day1/a.jpg`), or just its name for a
   loose file. Everything downstream reads `path` and nothing else. */

// OS bookkeeping that lives inside every real folder. Skipped in SILENCE and
// on purpose — listing `.DS_Store` as a failure would bury the one real
// failure the reviewer needs to see under noise they did not create.
function isJunk(path) {
  return path.split('/').some((seg) => !seg || seg.startsWith('.') ||
    seg === '__MACOSX' || seg === 'Thumbs.db' || seg === 'desktop.ini');
}

// A directory entry can hold more than 100 children, and readEntries() answers
// with at most 100 per call: it must be re-called until it returns an empty
// array. Reading it once — the obvious implementation — silently drops file
// 101 onward, which looks exactly like a successful upload of a smaller shoot.
function readDir(reader) {
  return new Promise((resolve) => {
    const all = [];
    const step = () => reader.readEntries((batch) => {
      if (!batch.length) { resolve(all); return; }
      all.push(...batch);
      step();
    }, () => resolve(all));
    step();
  });
}

async function walkEntry(entry, prefix, out) {
  if (!entry) return;
  if (entry.isFile) {
    const path = prefix + entry.name;
    const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null)));
    out.push(file ? { file, path } : { file: null, path, error: 'לא ניתן לקרוא את הקובץ מהתיקייה' });
    return;
  }
  if (!entry.isDirectory) return;
  const dir = prefix + entry.name + '/';
  for (const child of await readDir(entry.createReader())) await walkEntry(child, dir, out);
}

// 'shoot/day1/a.jpg' → tags ['folder:shoot', 'folder:shoot/day1'], top 'shoot'.
// BOTH levels are tagged, not just the deepest: a shoot dropped with mixed
// depths would otherwise scatter across as many tags as it has subfolders and
// stop being one findable group, which is the whole point of the tag.
function folderTags(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  parts.pop();                                   // the filename itself
  const tags = [];
  for (let i = 1; i <= parts.length; i++) tags.push('folder:' + parts.slice(0, i).join('/'));
  return { tags, top: parts[0] || '' };
}

// The MIME test store.js applies is by extension, so a JPEG whose bytes are
// garbage passes it — and measure() answers {null,null} rather than throwing.
// Without this probe a corrupt file uploads "successfully" and lands in the
// library as a permanently broken thumbnail nobody can explain. Decoding it
// here is the only place the truth is available.
async function decodable(file) {
  if (/svg/i.test(file.type || '')) return true;   // parsed + sanitized in store.js
  try {
    const bmp = await createImageBitmap(file);
    if (bmp && bmp.close) bmp.close();
    return true;
  } catch {
    return false;
  }
}

function uploadDock() {
  const kindSel = el('select', { title: 'איך לתייק את הקבצים החדשים' },
    el('option', { value: '' }, 'סיווג אוטומטי (לפי סוג הקובץ)'),
    UPLOAD_KINDS.map((k) => el('option', { value: k }, KIND_LABEL[k])));
  const file = el('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });
  // `webkitdirectory` is the ONLY way to pick a folder from a file dialog, and
  // it cannot coexist with a plain picker on one input — hence two.
  const dir = el('input', {
    type: 'file', multiple: true, webkitdirectory: true, style: { display: 'none' },
  });
  const prog = el('div', { class: 'a-prog', hidden: true });
  const pickDir = el('button', { class: 'btn btn--ghost', type: 'button' }, '📁 תיקייה שלמה');

  const dock = el('div', { class: 'a-drop' },
    el('div', { style: { fontSize: '1.5rem' } }, '🗂️'),
    el('div', null, el('b', null, 'גוררים לכאן קבצים או תיקייה'),
      ', או לוחצים לבחירה — SVG · PNG · JPG · WEBP'),
    el('div', { class: 'a-sub', style: { marginTop: '2px' } },
      'תיקייה נסרקת על תת־התיקיות שלה, וכל קובץ מתויג לפי מיקומו. ',
      el('span', { class: 'ltr' }, `עד ${MAX_DROP_FILES}`), ' קבצים · ',
      el('span', { class: 'ltr' }, '400MB'), ' לגרירה'),
    el('div', { style: { marginTop: '8px' } }, kindSel, ' ', pickDir),
    prog,
  );
  // both controls sit inside the click target: don't let using them open the
  // plain file dialog underneath
  kindSel.addEventListener('click', (e) => e.stopPropagation());
  pickDir.addEventListener('click', (e) => { e.stopPropagation(); dir.click(); });
  dock.addEventListener('click', () => file.click());
  dock.addEventListener('dragover', (e) => { e.preventDefault(); dock.classList.add('over'); });
  dock.addEventListener('dragleave', () => dock.classList.remove('over'));
  dock.addEventListener('drop', (e) => {
    e.preventDefault();
    dock.classList.remove('over');
    // webkitGetAsEntry() must be called SYNCHRONOUSLY. DataTransferItemList is
    // emptied the instant this handler returns, so reading it after an await
    // yields nothing at all and a dropped folder uploads zero files with no
    // error anywhere.
    const entries = [...(e.dataTransfer.items || [])]
      .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
      .filter(Boolean);
    const loose = [...(e.dataTransfer.files || [])];
    collect(entries, loose).then(send);
  });
  file.addEventListener('change', () => {
    send([...file.files].map((f) => ({ file: f, path: f.name })));
    file.value = '';
  });
  dir.addEventListener('change', () => {
    // webkitRelativePath is the picker's version of the drop path.
    send([...dir.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    dir.value = '';
  });

  async function collect(entries, loose) {
    if (!entries.length) return loose.map((f) => ({ file: f, path: f.name }));
    const out = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    return out;
  }

  function setProgress(text) {
    prog.hidden = !text;
    prog.textContent = text || '';
  }

  async function send(items) {
    if (S.busy) { toast('העלאה כבר רצה — רגע', 'err'); return; }
    const live = items.filter((it) => !isJunk(it.path));
    if (!live.length) { toast('לא נמצאו קבצים להעלאה', 'err'); return; }

    // ---- the cap, refused LOUDLY (a toast alone is missable on a big drop)
    const bytes = live.reduce((n, it) => n + ((it.file && it.file.size) || 0), 0);
    if (live.length > MAX_DROP_FILES || bytes > MAX_DROP_BYTES) {
      const mb = Math.round(bytes / (1024 * 1024));
      modal('הגרירה גדולה מדי', el('div', null,
        el('p', null, 'בגרירה אחת אפשר להעלות עד ',
          el('b', null, el('span', { class: 'ltr' }, String(MAX_DROP_FILES))), ' קבצים ועד ',
          el('b', null, el('span', { class: 'ltr' }, '400MB')), '.'),
        el('p', null, 'כאן היו ', el('b', null, el('span', { class: 'ltr' }, String(live.length))),
          ' קבצים בנפח ', el('b', null, el('span', { class: 'ltr' }, mb + 'MB')),
          ' — לא הועלה כלום.'),
        el('p', { class: 'pv-note' },
          'מפצלים לתיקיות קטנות יותר, או שולחים את הארכיון המלא דרך גיבוי הענן ' +
          '(scripts/archive-sync.mjs) — הספרייה כאן היא שכבת ההגשה, לא הארכיון.'),
      ));
      toast('הגרירה חורגת מהמגבלה — לא הועלה כלום', 'err');
      return;
    }

    S.busy = true;
    dock.classList.add('over');
    const failed = [];   // {name, reason} — shown in full at the end
    let ok = 0;
    const total = live.length;
    setProgress(`0/${total} הועלו`);

    for (const it of live) {
      const name = it.path;
      try {
        if (!it.file) throw new Error(it.error || 'לא ניתן לקרוא את הקובץ');
        if (!/^image\//.test(it.file.type || '')) throw new Error('סוג קובץ לא נתמך');
        if (!await decodable(it.file)) throw new Error('הקובץ פגום או אינו תמונה תקינה');
        const { tags, top } = folderTags(it.path);
        const base = it.file.name.replace(/\.[^.]+$/, '');
        await uploadAsset({
          // no post_id: an upload made HERE belongs to the board, not to a post
          file: it.file,
          kind: kindSel.value || undefined,
          // the first path segment pre-fills the label, so a shoot reads as a
          // shoot in the grid instead of forty filenames
          label: top ? `${top} · ${base}` : '',
          tags,
        });
        ok++;
      } catch (err) {
        failed.push({ name, reason: (err && err.message) || String(err) });
      }
      setProgress(`${ok + failed.length}/${total} הועלו`);
    }

    S.busy = false;
    dock.classList.remove('over');
    // The final tick is deliberately NOT cleared here. Clearing it in the same
    // synchronous block that set it means the browser never paints it: the
    // reviewer's last sight of the counter is «19/20» on a folder of 20, which
    // reads as an upload that stopped one short. refresh() rebuilds the whole
    // toolbar — and awaits, so the paint happens — which retires the line
    // honestly. Only the nothing-uploaded path has to clear it by hand.
    if (ok) {
      toast(ok === 1 ? 'הנכס נוסף לספרייה' : `${ok} נכסים נוספו לספרייה`, 'ok');
      await refresh();
    } else {
      setProgress('');
    }
    // A failure is NEVER silent and never aborts the rest of the folder: the
    // whole list is shown by name at the end, so the reviewer can re-drop
    // exactly those files.
    if (failed.length) reportFailures(ok, total, failed);
  }

  return el('div', null, dock, file, dir);
}

function reportFailures(ok, total, failed) {
  modal(`${failed.length} קבצים לא עלו`, el('div', null,
    el('p', null, el('b', null, el('span', { class: 'ltr' }, `${ok}/${total}`)),
      ' הועלו בהצלחה. אלה נכשלו:'),
    el('ul', { class: 'xp-fails' }, failed.map((f) => el('li', null,
      el('span', { class: 'ltr' }, f.name), ' — ', f.reason))),
    el('p', { class: 'pv-note' }, 'אפשר לתקן ולגרור שוב רק את הקבצים האלה.'),
  ));
  toast(`${failed.length} קבצים לא עלו`, 'err');
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
  if (S.selMode) {
    const box = el('input', {
      type: 'checkbox', checked: S.sel.has(a.id),
      'aria-label': 'בחירה: ' + (a.label || a.name || 'נכס'),
      onchange: () => {
        if (box.checked) S.sel.add(a.id); else S.sel.delete(a.id);
        pick.classList.toggle('a-pick--on', box.checked);
        updateSelBar();
      },
    });
    const pick = el('label', {
      class: 'a-pick' + (S.sel.has(a.id) ? ' a-pick--on' : ''),
      onclick: (e) => e.stopPropagation(),   // the thumb itself opens the preview
    }, box);
    thumb.appendChild(pick);
  }

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
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => exportDialog([a]) }, '⬇︎ ייצוא'),
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

/* ── export (spec 10 §D-1) ─────────────────────────────────────────────────

   ENTIRELY CLIENT-SIDE, and that is a decision, not a shortcut. A library
   asset is already final pixels: there is nothing for the factory to render,
   so a round trip through a request row would only add latency and a queue to
   babysit. (Slide export is the opposite case — a slide is a template that
   must be RE-rendered at the new size, so spec §D-2 keeps it factory-side.)

   The size list is GEN_DIMS, imported from store.js and NOT extended here.
   The full §C dimension matrix is a later build that has to move GEN_DIMS and
   its Edge-Function twin together (there is a programmatic-diff test); adding
   keys on only this side would fail that test and refuse generations. */

const ORIG = '__orig__';

const FORMATS = [
  { key: 'png', mime: 'image/png', ext: 'png', label: 'PNG — ללא אובדן, תומך שקיפות' },
  { key: 'jpeg', mime: 'image/jpeg', ext: 'jpg', label: 'JPEG — קובץ קטן, ללא שקיפות' },
];

// Fetch the bytes and decode from a BLOB rather than pointing an <img> at the
// bucket URL. A cross-origin <img> taints the canvas and toBlob() then throws
// SecurityError — after the resample, so the failure looks like an export bug
// rather than a CORS one. Blob-sourced pixels are same-origin by definition.
async function loadSource(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`הקובץ לא נטען (${res.status})`);
  const blob = await res.blob();
  try {
    const bmp = await createImageBitmap(blob);
    return { src: bmp, w: bmp.width, h: bmp.height, blob };
  } catch {
    // An SVG with only a viewBox has no intrinsic raster size, which
    // createImageBitmap refuses; an <img> from the same object URL resolves it.
    const obj = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok;
        img.onerror = () => no(new Error('הקובץ פגום או אינו תמונה'));
        img.src = obj;
      });
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      // Last resort for a dimensionless vector: a square at post width. Better
      // an honest default than a 0×0 canvas that exports an empty file.
      return { src: img, w: w || 1080, h: h || 1080, blob };
    } finally {
      setTimeout(() => URL.revokeObjectURL(obj), 10000);
    }
  }
}

// Resample to EXACTLY w×h. The source is centre-cropped to the target aspect
// first (cover, not letterbox) — a social export that quietly grew bars would
// be worse than one that crops, and the target sizes are all aspect presets.
//
// Two-step downscale: drawImage's filter is a box filter good to about 2:1, so
// a 4000px photo taken to 1080 in a single draw comes out visibly aliased.
// Halving until within 2× of the target, then the final draw, is the standard
// fix and costs a few milliseconds.
function resample(src, sw0, sh0, w, h, flatten) {
  const scale = Math.max(w / sw0, h / sh0);
  const sw = Math.min(sw0, Math.round(w / scale));
  const sh = Math.min(sh0, Math.round(h / scale));
  const sx = Math.round((sw0 - sw) / 2);
  const sy = Math.round((sh0 - sh) / 2);

  // one place that remembers to ask for the good filter
  const ctxOf = (canvas) => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    return ctx;
  };

  let cur = document.createElement('canvas');
  cur.width = sw; cur.height = sh;
  ctxOf(cur).drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);

  while (cur.width >= w * 2 && cur.height >= h * 2) {
    const next = document.createElement('canvas');
    next.width = Math.max(w, Math.round(cur.width / 2));
    next.height = Math.max(h, Math.round(cur.height / 2));
    ctxOf(next).drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const octx = ctxOf(out);
  // JPEG has no alpha: without this, every transparent pixel of a PNG or an
  // SVG encodes as BLACK, and a line drawing exports as a black rectangle.
  if (flatten) { octx.fillStyle = '#ffffff'; octx.fillRect(0, 0, w, h); }
  octx.drawImage(cur, 0, 0, w, h);
  return out;
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('הקידוד נכשל'))),
    mime, quality));
}

// One asset → the bytes to save. Returns {blob, name, w, h}.
async function exportOne(a, { format, quality, size }) {
  const fmt = FORMATS.find((f) => f.key === format) || FORMATS[0];
  const url = assetRowUrl(a);
  const { src, w: sw, h: sh, blob } = await loadSource(url);
  const base = String(a.name || a.label || 'asset').replace(/\.[^.]+$/, '') || 'asset';

  const dim = size === ORIG ? null : GEN_DIMS.find((d) => d.key === size);
  const w = dim ? dim.w : sw;
  const h = dim ? dim.h : sh;

  // Original size AND the format it is already in = a byte copy. Re-encoding
  // would lose PNG data or add a second generation of JPEG loss for nothing.
  const mime = String(a.mime || blob.type || '');
  const sameFmt = (fmt.key === 'png' && /png/i.test(mime)) ||
                  (fmt.key === 'jpeg' && /jpe?g/i.test(mime));
  if (!dim && sameFmt) return { blob, name: `${base}.${fmt.ext}`, w, h };

  const canvas = resample(src, sw, sh, w, h, fmt.key === 'jpeg');
  const out = await canvasBlob(canvas, fmt.mime, fmt.key === 'jpeg' ? quality / 100 : undefined);
  if (src && src.close) src.close();
  return { blob: out, name: `${base}.${fmt.ext}`, w, h };
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: name, style: { display: 'none' } });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Two assets can legitimately share a filename (uploads are not name-unique by
// design — see the partial unique index in schema §18). Inside one zip they
// cannot, or extractors silently keep whichever they read last.
function uniqueName(taken, name) {
  if (!taken.has(name)) { taken.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const next = `${base}-${i}${ext}`;
    if (!taken.has(next)) { taken.add(next); return next; }
  }
}

function exportDialog(rows) {
  if (!rows.length) return;
  const many = rows.length > 1;

  const format = el('select', { class: 'field__input' },
    FORMATS.map((f) => el('option', { value: f.key }, f.label)));
  const quality = el('input', {
    type: 'range', min: '60', max: '100', step: '1', value: '90',
    'aria-label': 'איכות JPEG',
  });
  const qNum = el('span', { class: 'ltr xp-qnum' }, '90');
  quality.addEventListener('input', () => { qNum.textContent = quality.value; });

  const size = el('select', { class: 'field__input' },
    el('option', { value: ORIG }, 'מקורי — בלי שינוי גודל'),
    GEN_DIMS.map((d) => el('option', { value: d.key }, d.label)));

  const qRow = el('div', { class: 'field' },
    el('label', { class: 'field__label' }, 'איכות JPEG'),
    el('div', { class: 'xp-range' }, quality, qNum));
  const syncFmt = () => { qRow.hidden = format.value !== 'jpeg'; };
  format.addEventListener('change', syncFmt);

  const status = el('div', { class: 'pv-note xp-status' },
    many ? `${rows.length} נכסים ייארזו לקובץ ZIP אחד.` : '');

  const body = el('div', null,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'פורמט'), format),
    qRow,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'גודל'), size),
    el('div', { class: 'pv-note' },
      'בגודל קבוע התמונה מוגדלת למילוי המסגרת ונחתכת מהמרכז — הפלט תמיד בדיוק במידות שנבחרו. ' +
      'הייצוא מתבצע כאן בדפדפן; שום דבר לא נשלח לשרת.'),
    status,
  );
  syncFmt();

  let running = false;
  const m = modal(many ? `ייצוא ${rows.length} נכסים` : 'ייצוא נכס', body, {
    actions: [
      { label: 'ביטול' },
      {
        label: '⬇︎ ייצוא', primary: true,
        onClick: () => { if (!running) run(); return false; },
      },
    ],
  });

  async function run() {
    running = true;
    const opts = { format: format.value, quality: Number(quality.value), size: size.value };
    const failed = [];
    const files = [];
    const taken = new Set();
    for (let i = 0; i < rows.length; i++) {
      status.textContent = `${i}/${rows.length} יוצאו…`;
      try {
        const r = await exportOne(rows[i], opts);
        files.push({ name: uniqueName(taken, r.name), data: r.blob, dims: `${r.w}×${r.h}` });
      } catch (err) {
        failed.push({ name: rows[i].name || rows[i].id, reason: (err && err.message) || String(err) });
      }
    }
    running = false;

    if (!files.length) {
      status.textContent = '';
      m.close();
      reportFailures(0, rows.length, failed);
      return;
    }
    if (files.length === 1 && rows.length === 1) {
      saveBlob(files[0].data, files[0].name);
      toast(`יוצא · ${files[0].dims}`, 'ok');
    } else {
      status.textContent = 'אורז ZIP…';
      const stamp = new Date().toISOString().slice(0, 10);
      saveBlob(await zipStore(files), `assets-${stamp}.zip`);
      toast(`${files.length} נכסים יוצאו לקובץ ZIP`, 'ok');
    }
    m.close();
    if (failed.length) reportFailures(files.length, rows.length, failed);
  }
}
