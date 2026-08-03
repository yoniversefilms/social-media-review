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
// v2.5.2 adds VERSION STACKS to the «AI Generated» tab. fal makes several
// tries at the same input line; every sliced tile files as its own row and
// they share a `stack:<sheet8>-l<line>` tag. Inside each style group those
// rows collapse into ONE card carrying a «2/3» badge — clicking the thumb
// rotates through the versions (operator directive), so the detail view moves
// to its own «גרסאות · N» button, where the same stack lists every version as
// a thumb. The current index is per-session module state in stacks.js, shared
// with the editor's picker: no persistence, no schema change, no new store
// call. Scoped to this tab deliberately — «כל הנכסים» stays a literal
// one-card-per-row inventory of what the board actually holds.
//
//   EXPORT — «⬇︎ ייצוא» per card, or a multi-selection zipped. Entirely
//     client-side (canvas resample → toBlob); nothing leaves the browser and
//     no request row is created. Slide export is a different object with a
//     different answer (spec 10 §D-2, factory-side) and is NOT here.
//
// v2.6 turns the `folder:` tag v2.5.1 already wrote into a FOLDER SYSTEM, and
// makes the dock survive a phone.
//   FOLDERS — no schema change, no new store call. A folder IS the tag; the
//     rail, the counts, the dock's select and the move dialog are all
//     derivations over the rows already in memory (folderIndex()). That is
//     what makes a folder free to create, free to rename by moving, and gone
//     the moment its last file leaves. The rail composes with the kind chips
//     and the search box because it is one more AND inside visible(), not a
//     mode of its own.
//   PHONE UPLOADS — every picker/drop handler snapshots the picked Files'
//     bytes (imgprep.js) BEFORE anything else, and store.js re-encodes what
//     the bucket would refuse. See the note on the change handlers below for
//     the bug that cost a reviewer eight of nine photos with no error.

// v2.9 (spec 12) turns the two-row chip rail into a BROWSER you walk into, and
// gives the page its first destructive action.
//   FOLDERS ARE NAVIGATED, not filtered. Current path lives in location.hash,
//     which is what buys reload, the back button and a shareable link for one
//     folder — for free, with no router. Folders also became a real table
//     (sm_folders, migration 029) for one reason a tag can never cover: an
//     EMPTY folder. «צילומי ספטמבר», created today to fill tomorrow, has to
//     still be there tomorrow and has to be visible to a teammate. Membership
//     is STILL the `folder:` tag exactly as v2.6 wrote it; the table persists
//     existence only, and the two sources are merged (folderUniverse) so an
//     unapplied 029 degrades to v2.6 behaviour instead of to no folders.
//   DELETE IS SOFT and always undoable for 10s. Slides place photos by public
//     URL, so removing rows or bytes would break carousels already designed
//     against them; a `deleted_at` stamp hides the row from every listing while
//     the pixels stay where the slide expects them. Nothing here calls DELETE.
import {
  initStore, assetUrl, listAssets, uploadAsset, updateAsset,
  reconcileStudioAssets, assetRowUrl, listPosts, subscribe, GEN_DIMS, dimByKey,
  deleteAssets, restoreAssets, listFolders, createFolder,
} from './store.js';
import { el, modal, toast, fmtDate, navBar, uploadProgress, undoToast, UNDO_MS } from './ui.js';
import { zipStore } from './zip.js';
// v2.5.2 version stacks — shared verbatim with editor.js's «ספריית נכסים»
// picker. It lives in its own dependency-free module rather than here because
// editor.js must not be able to reach store.js; see stacks.js §WHY.
import {
  groupStacks, isStacked, currentOf, cycleStack, setStackIndex, stackBadge,
} from './stacks.js';
// v2.6 phone-proofing. The dock's job is to get the BYTES out of the picker
// before anything else happens; imgprep.js owns that, and store.js owns the
// re-encode. Dependency-free, same reasoning as stacks.js above.
import { snapshotItems, normalizeWillDecode, isAcceptedImageType } from './imgprep.js';

const $ = (id) => document.getElementById(id);

// OPERATOR CHANGE 2026-08-03: the one «איורים» tab split in two — «Simple» is
// the hand-curated set (source 'studio' + reviewer uploads), «AI Generated» is
// everything fal made (source 'generated'), grouped by style. The Latin labels
// are the operator's own naming (precedent: the post page's «English» tab).
const KINDS = [
  { key: 'all', label: 'כל הנכסים' },
  { key: 'photo', label: 'תמונות' },
  { key: 'ill-simple', label: 'Simple' },
  { key: 'ill-ai', label: 'AI Generated' },
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

// v2.6 folders. A folder is not a table — it is the `folder:<path>` tag this
// page has written since spec 10 §A. Names are validated at the ONE door that
// creates them (the dock's «+ תיקייה חדשה…» and the move dialog) rather than
// filtered at read time, because a tag that already exists on a row will show
// up in the rail no matter what any reader thinks of it.
const MAX_FOLDER_NAME = 40;
// Sentinel for the «+ תיקייה חדשה…» option. A validated name can never contain a
// slash, so this can never collide with a real folder.
const NEW_FOLDER = '//new//';
// A path deeper than this is a bookmark someone hand-edited or a drop gone
// wrong, not navigation: the breadcrumb stops being readable long before it.
const MAX_DEPTH = 8;

const S = {
  board: null,
  assets: [],
  posts: [],
  folders: [],          // v2.9: sm_folders rows ([] when 029 is unapplied)
  // Folders created in THIS tab that the server did not keep (029 unapplied).
  // They behave like real folders for the session so the reviewer can finish
  // the job they started; the toast at creation time says they will not
  // survive a reload. Never merged into anything persisted.
  sessionFolders: new Set(),
  usage: new Map(),     // asset id -> [{id, title}]
  kind: 'all',
  q: '',
  onlyUploads: false,
  // v2.9: WHERE WE ARE, not what is filtered. '' = the library root;
  // 'קמפיין/shoot' = two levels in. Mirrored to location.hash.
  path: '',
  // The «ללא תיקייה» pseudo-folder: everything filed nowhere. It is a separate
  // flag rather than a reserved path string because any reserved string is a
  // folder name someone can type, and a collision here would silently swallow
  // a real folder's contents.
  none: false,
  // the dock's chosen upload folder ('' = the library root). Module state, not
  // dock state: refresh() rebuilds the whole toolbar after every batch, and a
  // reviewer filing a shoot in three drags must not re-pick the folder twice.
  // v2.9: navigating RESETS it to the folder now on screen (the dock says so in
  // words); a mid-folder override survives every other toolbar rebuild.
  uploadFolder: '',
  // v2.5.1
  busy: false,          // an upload is running — background refreshes must not
                        // rebuild the dock out from under its progress line
  selMode: false,       // multi-select (for zip export)
  sel: new Set(),       // selected asset ids
  // v2.9: has the first fetch landed? Before it has, folderUniverse() is empty
  // and every path looks invented — so the "does this folder exist" check has
  // to know the difference between "no" and "not yet".
  loaded: false,
};

/* ── boot ── */

// ?embed=1 — the page is hosted inside another page's tab (the post page's
// «ספרייה»). Same library, same behaviour; only the page chrome (nav, title)
// is hidden, via the .a-embed class assets.html styles.
const EMBED = new URLSearchParams(location.search).get('embed') === '1';

(async function boot() {
  if (EMBED) document.body.classList.add('a-embed');
  try {
    S.board = await initStore();
  } catch (err) {
    $('grid').replaceChildren(el('p', { class: 'empty' },
      el('b', null, 'לא הצלחנו להתחבר ללוח. '),
      'בדקו שהקישור שקיבלתם שלם, ונסו לרענן.'));
    return;
  }
  if (!EMBED) $('nav').replaceChildren(navBar('assets'));
  // The hash is read BEFORE the first paint so a bookmarked folder never shows
  // the root for a frame first. It cannot be validated yet — nothing is loaded
  // — so validation happens once in refresh(), below.
  readHash();
  // The back button. hashchange is the ONLY navigation signal this page has,
  // and every internal move writes the hash rather than calling render
  // directly, so «go into a folder» and «press back» land in exactly the same
  // code. Without that symmetry back would repaint the URL and not the page.
  window.addEventListener('hashchange', () => {
    readHash();
    // A hash that names no folder is corrected HERE too, not only at load.
    // Changing only the fragment is a SAME-DOCUMENT navigation: boot does not
    // re-run, so the load-time check in refresh() never sees it — which is
    // exactly the path a pasted or hand-edited link takes when the tab is
    // already open, and it left the page showing a breadcrumb for a folder
    // that does not exist. Guarded on `loaded` because before the first fetch
    // the universe is empty and EVERY path would look invented.
    if (S.loaded && S.path && !folderUniverse().has(S.path)) {
      navigate({}, { replace: true });
      return;
    }
    // …and a hash that survived sanitization but no longer MATCHES it gets
    // rewritten to what is actually on screen. `#folder=%2e%2e%2f` cleans to
    // the root and renders the root; without this the fragment stayed in the
    // address bar claiming a folder, ready to be copied and shared.
    if (!hashIsCanonical()) {
      navigate(S.none ? { none: true } : { path: S.path }, { replace: true });
      return;
    }
    renderToolbar();
    renderGrid();
  });
  renderToolbar();
  await refresh({ reconcile: true, validatePath: true });
  // A poll landing mid-upload would re-render the toolbar and take the folder
  // progress line («12/68 הועלו») with it. The upload's own refresh runs when
  // it finishes, so nothing is lost by skipping here.
  subscribe(() => { if (!S.busy) refresh().catch(() => {}); });
})();

/* ── the hash IS the location (v2.9) ──
   `#folder=קמפיין/shoot` and `#nofolder=1`. Two keys, not one reserved path
   value, because «ללא תיקייה» must never be spellable as a real folder name.
   Root is NO hash at all, so a plain assets.html link still means the library. */

function readHash() {
  const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  if (h.get('nofolder') === '1') { S.path = ''; S.none = true; }
  else { S.none = false; S.path = sanitizePath(h.get('folder') || ''); }
  // The dock's default target follows the place, and this is the ONE choke
  // point every arrival goes through — boot, a tile, the back button, a
  // corrected bookmark. Setting it at each call site instead was how the back
  // button used to leave the dock pointed at the folder just left.
  S.uploadFolder = S.path;
}

// Is the address bar telling the truth about where we are?
//
// Sanitizing the path is not enough on its own: `#folder=%2e%2e%2f` cleans away
// to the ROOT and the page correctly shows the root, but the fragment stays on
// screen claiming otherwise — a URL that lies is a URL someone will copy, share
// and bookmark. This compares the DECODED hash value against the sanitized
// state (URLSearchParams decodes for us, so percent-encoding differences are
// not spurious mismatches), and the caller replaces the hash when they differ.
// Root's canonical form is no `folder` key at all.
function hashIsCanonical() {
  const h = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  if (h.get('nofolder') === '1') return S.none && !h.has('folder');
  const raw = h.get('folder');
  if (raw === null) return !S.path;
  return raw === S.path;
}

// A hash is user input. It arrives from a shared link, a hand-edit, or a
// bookmark made before someone moved a shoot — so every segment goes through
// the SAME normalizer a typed name does (which already strips `folder:`
// prefixes, invisibles and over-length names), plus the two rules a path has
// that a single segment does not: no dot-only segments (`..` walking out of
// anything is meaningless here, but it must not become a folder named «..»),
// and a depth ceiling. Everything left is a legal path; whether it EXISTS is a
// separate question, answered in refresh().
function sanitizePath(raw) {
  return String(raw || '')
    .split('/')
    .map(normalizeFolderSegment)
    .filter((s) => s && !/^\.+$/.test(s))
    .slice(0, MAX_DEPTH)
    .join('/');
}

// Every move through the tree goes through here — tiles, breadcrumb, the folder
// chip on a card, «+ תיקייה חדשה». It writes the hash and lets the hashchange
// handler do the rendering, so navigation and the back button are one path.
// `replace` is for corrections (a stale bookmark falling back to root), which
// must not leave a dead entry in the history the back button would return to.
function navigate({ path = '', none = false } = {}, { replace = false } = {}) {
  // Root is '#', not ''. Assigning location.hash = '' is the one case that does
  // not reliably fire hashchange (and leaves a bare '#' anyway), which would
  // make «back to the library» the single move that repaints nothing.
  const next = none ? '#nofolder=1' : (path ? '#folder=' + encodeURIComponent(path) : '#');
  if (replace) {
    // A correction, not a move: it must not leave a history entry the back
    // button can return to. replaceState fires no hashchange, so repaint here.
    history.replaceState(null, '', location.pathname + location.search + next);
    readHash();
    renderToolbar();
    renderGrid();
    return;
  }
  if ((location.hash || '#') === next) {
    // Already here. Assigning the same hash fires nothing, so repaint by hand
    // rather than leave a clicked tile looking dead.
    renderToolbar(); renderGrid(); return;
  }
  location.hash = next;             // hashchange does the rest
}

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

async function refresh({ reconcile = false, validatePath = false } = {}) {
  if (reconcile) {
    const lib = await studioLibrary();
    if (lib.length) {
      try { await reconcileStudioAssets(lib); }
      catch (e) { console.warn('studio reconcile skipped:', e && e.message); }
    }
  }
  // listFolders() answers [] rather than throwing when migration 029 is
  // unapplied (store.js warns once and degrades) — so the .catch here is for a
  // genuine network failure, and it degrades the same way: folders derived from
  // tags alone, which is exactly v2.6.
  const [assets, posts, folders] = await Promise.all([
    listAssets().catch(() => []),
    listPosts().catch(() => []),
    listFolders().catch(() => []),
  ]);
  S.assets = assets;
  S.posts = posts;
  S.folders = folders;
  S.usage = buildUsage(assets, posts);
  S.loaded = true;
  // A bookmark to a folder somebody has since emptied and moved away from is a
  // path that no longer exists. Silently landing on the root is the sane answer
  // — it is not an error the reviewer caused, and there is nothing to fix — but
  // it must REPLACE the history entry, or «back» returns to the dead link.
  // Only on first load: doing this on every 10s poll would yank a reviewer out
  // of a folder they just created in another tab.
  if (validatePath && S.path && !folderUniverse().has(S.path)) {
    navigate({}, { replace: true });
    return;
  }
  // Same canonicalization as the hashchange handler, for the FIRST load: a
  // bookmark of `#folder=folder:evil` must not sit in the address bar next to a
  // page showing «evil», and `#folder=%2e%2e%2f` must not claim a folder while
  // the root is on screen.
  if (validatePath && !hashIsCanonical()) {
    navigate(S.none ? { none: true } : { path: S.path }, { replace: true });
    return;
  }
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

// The two illustration pseudo-kinds resolve on kind + source, not on a stored
// column: 'ill-simple' = illustrations that are NOT fal-made (studio + reviewer
// uploads), 'ill-ai' = source 'generated'. Everything else is a literal kind.
function kindMatch(a) {
  const k = a.kind || 'other';
  if (S.kind === 'all') return true;
  if (S.kind === 'ill-simple') return k === 'illustration' && a.source !== 'generated';
  if (S.kind === 'ill-ai') return k === 'illustration' && a.source === 'generated';
  return k === S.kind;
}

// The style a generated asset belongs to, for the «AI Generated» grouping.
// Producers stamp a `style:<name>` tag (fulfill.mjs runSheet, the generate
// Edge Function); anything older or unstamped groups under «ללא סגנון».
function styleOf(a) {
  const t = (Array.isArray(a.tags) ? a.tags : []).find((x) => String(x).startsWith('style:'));
  return t ? String(t).slice(6) || 'ללא סגנון' : 'ללא סגנון';
}

// SEARCHING IS GLOBAL. A non-empty query leaves the current folder and asks the
// whole library, and every hit carries its folder chip (folderRow, on the card)
// so the answer includes WHERE. This is the one deliberate break from "the
// folder is just one more AND": finding a photo must never require already
// knowing which folder it is in — that is the failure mode a folder system
// introduces, and searching your way out of it is the fix. Empty query = the
// current folder only, which is what makes the browser a browser.
const searching = () => !!S.q;

function visible() {
  const q = S.q;
  const list = S.assets.filter((a) => {
    if (!kindMatch(a)) return false;
    // Kind chips and «רק העלאות» still compose with everything, search included.
    if (!q && !atCurrent(a)) return false;
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
    breadcrumb(),
    el('div', { class: 'a-row', id: 'selbar' }),
  );
  updateCount();
  updateSelBar();
}

// The breadcrumb: «🗂 הספרייה ‹ קמפיין ‹ shoot». Every crumb is a button, and
// each one navigates (writes the hash) rather than setting state, so a crumb
// and the back button are the same operation. The LAST crumb is where we are
// and is rendered as text, not a button that appears to do nothing.
//
// The separator is a plain '‹' inside an RTL row, which points the way the eye
// travels in Hebrew: the root sits on the right and depth grows leftward. This
// is verified in a browser, not reasoned about — the whole component is written
// with logical properties for that reason.
function breadcrumb() {
  const crumb = (label, target, cur) => (cur
    ? el('span', { class: 'a-crumb a-crumb--cur' }, el('bdi', null, label))
    : el('button', {
        class: 'a-crumb', type: 'button', onclick: () => navigate(target),
      }, el('bdi', null, label)));

  const row = el('div', { class: 'a-row a-crumbs' });
  const segs = S.path ? S.path.split('/') : [];
  const atRoot = !S.path && !S.none;
  row.appendChild(crumb('🗂 הספרייה', {}, atRoot));
  if (S.none) {
    row.appendChild(el('span', { class: 'a-crumb__sep', 'aria-hidden': 'true' }, '‹'));
    row.appendChild(crumb('ללא תיקייה', { none: true }, true));
  }
  segs.forEach((seg, i) => {
    row.appendChild(el('span', { class: 'a-crumb__sep', 'aria-hidden': 'true' }, '‹'));
    row.appendChild(crumb(seg, { path: segs.slice(0, i + 1).join('/') }, i === segs.length - 1));
  });

  // «+ תיקייה חדשה» belongs on the breadcrumb, not on the tile strip: what it
  // creates is a child of WHERE WE ARE, and putting it beside the path is the
  // only place that says so without a sentence. Nesting therefore happens by
  // navigating in and creating again — the v2.6 "no slashes in a name" rule
  // stands untouched, and a reviewer never has to know a path is a string.
  //
  // Not offered inside «ללא תיקייה»: that is not a folder, it is the absence of
  // one, and a child of it could not be addressed.
  if (!S.none) {
    row.appendChild(el('button', {
      class: 'btn btn--ghost a-newfolder', type: 'button',
      title: S.path ? `תיקייה חדשה בתוך ${S.path}` : 'תיקייה חדשה בספרייה',
      onclick: () => newFolderDialog((name) => makeFolder(S.path, name)),
    }, '+ תיקייה חדשה'));
  }
  return row;
}

// The tile strip: the DIRECT children of where we stand, each with the count of
// everything in its subtree. Tiles come before cards because a folder is the
// bigger object — a reviewer looking for «צילומי ספטמבר» should not scroll past
// forty loose photos to find it.
function folderTiles() {
  // Searching is global (see `searching`), and a tile strip belongs to a place.
  // Showing tiles over global results would offer to "enter" a folder while
  // displaying hits from six others.
  if (searching()) return null;
  // Inside «ללא תיקייה» there is nothing below: it is a leaf by definition.
  if (S.none) return null;

  const idx = folderIndex();
  const kids = childrenOf([...folderUniverse()], S.path);
  // At the root, loose files get a tile of their own — a door to the one view
  // that shows them WITHOUT a wall of folder tiles above them. The same files
  // are also listed as cards right below this strip, which is deliberate
  // redundancy: nothing about the root hides anything.
  const looseCount = idx.none;
  const showNone = !S.path && looseCount > 0;
  if (!kids.length && !showNone) return null;

  const tile = (label, count, target, sessionOnly) => el('button', {
    class: 'a-tile' + (sessionOnly ? ' a-tile--ghost' : ''), type: 'button',
    title: sessionOnly ? 'נוצרה כאן בלבד. לא תישרד רענון עד שמיגרציה 029 תופעל' : label,
    onclick: () => navigate(target),
  },
    el('span', { class: 'a-tile__ico', 'aria-hidden': 'true' }, '📁'),
    el('span', { class: 'a-tile__name' }, el('bdi', null, label)),
    el('span', { class: 'a-tile__n ltr' }, String(count)));

  const strip = el('div', { class: 'a-tiles' },
    showNone
      ? el('button', {
          class: 'a-tile a-tile--none', type: 'button',
          onclick: () => navigate({ none: true }),
        },
        el('span', { class: 'a-tile__ico', 'aria-hidden': 'true' }, '🗒'),
        el('span', { class: 'a-tile__name' }, 'ללא תיקייה'),
        el('span', { class: 'a-tile__n ltr' }, String(looseCount)))
      : null,
    kids.map((p) => tile(
      p.slice(S.path ? S.path.length + 1 : 0),
      // The count is the SUBTREE's, and it is free: v2.6 tags every level of a
      // path, so a row two levels down already carries `folder:<this>`.
      idx.counts.get(p) || 0,
      { path: p },
      S.sessionFolders.has(p) && !idx.counts.get(p))),
  );
  return strip;
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
      onclick: () => moveDialog(rows),
    }, '📁 העברה לתיקייה'),
    el('button', {
      class: 'btn btn--ghost a-danger', type: 'button',
      onclick: () => deleteDialog(rows),
    }, '🗑 מחיקה'),
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
  // v2.9: the count has to say WHAT it counted, because the number changed
  // meaning. Standing in a folder it is that folder's own files (not its
  // subtree — the tiles carry those); searching, it is the whole library.
  if (searching()) { c.textContent = `${n} תוצאות בכל הספרייה`; return; }
  c.textContent = n === total ? `${total} נכסים` : `${n} כאן · ${total} בספרייה`;
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

// 'shoot/day1' → ['folder:shoot', 'folder:shoot/day1'].
// BOTH levels are tagged, not just the deepest: a shoot dropped with mixed
// depths would otherwise scatter across as many tags as it has subfolders and
// stop being one findable group, which is the whole point of the tag. It is
// also what makes the rail's «shoot» chip find files that live two levels
// down, with no tree walk and no query.
function pathTags(dir) {
  // Every segment goes through the shared normalizer, and one that cleans away
  // to nothing is SKIPPED rather than tagged — the file simply files under its
  // parent. A dropped directory is a name nobody vetted: it can be
  // «folder:evil», «ארכיון » with a trailing space, or pure RTL marks.
  const parts = String(dir || '').split('/')
    .map(normalizeFolderSegment)
    .filter(Boolean);
  const tags = [];
  for (let i = 1; i <= parts.length; i++) tags.push(FOLDER_PREFIX + parts.slice(0, i).join('/'));
  return tags;
}

// 'shoot/day1/a.jpg' → tags ['folder:shoot', 'folder:shoot/day1'], top 'shoot'.
function folderTags(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  parts.pop();                                   // the filename itself
  const tags = pathTags(parts.join('/'));
  // `top` labels the card, so it must be the CLEANED first segment — the one
  // that is actually in the tags — not the raw directory name.
  const top = tags.length ? tags[0].slice(FOLDER_PREFIX.length) : '';
  return { tags, top };
}

/* ── the folder model (v2.6) ──
   No schema change and no new store call: a folder IS the `folder:` tag above.
   Everything below is derivation over the rows already in memory. */

const FOLDER_PREFIX = 'folder:';

function tagsOf(a) {
  return Array.isArray(a && a.tags) ? a.tags : [];
}

// The DEEPEST folder a row is filed under, '' when it is filed nowhere.
// Deepest, because both levels are tagged and 'shoot/day1' is the answer a
// reviewer looking at the card expects to see.
function folderOf(a) {
  let best = '';
  for (const t of tagsOf(a)) {
    const s = String(t);
    if (!s.startsWith(FOLDER_PREFIX)) continue;
    const p = s.slice(FOLDER_PREFIX.length);
    if (p.length > best.length) best = p;
  }
  return best;
}

// Is this row AT the place we are standing? Direct membership, not subtree:
// a row in 'shoot/day1' is not shown while browsing 'shoot', because its
// tile already accounts for it and listing it in both places makes the count
// on the tile look like a lie.
function atCurrent(a) {
  if (S.none) return !folderOf(a);
  if (!S.path) return !folderOf(a);   // the root lists the loose files
  return folderOf(a) === S.path;
}

/* ── the folder UNIVERSE (v2.9) ──
   Two sources, merged, neither authoritative alone:
     TAGS   — every `folder:<path>` on a live asset. This is MEMBERSHIP and it
              is what v2.6 built; it still works with 029 unapplied, and it is
              why an unapplied board keeps its folders.
     ROWS   — sm_folders. This is EXISTENCE, and it is the only thing that can
              hold an EMPTY folder, which is the entire reason the table exists.
   Plus this session's unpersisted creations, so a reviewer working on an
   unapplied board can still finish filing a shoot.

   ANCESTORS ARE IMPLIED. A tag path always tags every level (v2.6 pathTags),
   but an sm_folders row for 'a/b/c' is one row: without expanding its prefixes
   the tile for «a» would not exist and «a/b/c» would be unreachable by
   navigation — visible in nothing, addressable only by a hand-typed hash. */
function folderUniverse() {
  const out = new Set();
  const add = (p) => {
    const parts = String(p || '').split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  };
  for (const p of folderIndex().all) add(p);
  for (const f of S.folders) if (f && f.path) add(f.path);
  for (const p of S.sessionFolders) add(p);
  return out;
}

// The degraded-create sentence, in ONE place. It names migration 029 the same
// way the delete toast does: «המיגרציה» alone tells a reviewer nothing they can
// take to the operator, and the two toasts are about the same unapplied file.
const FOLDER_SESSION_ONLY =
  'התיקייה נוצרה לשימוש עכשיו בלבד ולא תישרד רענון, עד שמיגרציה 029 תופעל בשרת. ' +
  'קובץ שיועלה אליה כן יישמר';

// Persist a folder and answer ONE question: is this folder usable now?
//
// Three callers want it — the breadcrumb button, the dock's select and the move
// picker — and they used to carry three copies of these rules, which is how the
// «029» went missing from one toast and not the others. The two failure modes
// are genuinely different and must stay so:
//   029 UNAPPLIED  → the folder IS usable, it just will not outlive the tab.
//     Keep the ghost, say so, let the reviewer finish filing the shoot they
//     started. (Uploading into it writes a `folder:` tag, which persists on its
//     own — worth saying, because it is the way out.)
//   ANYTHING ELSE (offline, RLS, an expired key) → there is NO folder, now or
//     later. Drop the ghost. Parking a reviewer inside a directory that does
//     not exist means their next upload files itself under a tag nobody can
//     navigate to, which is worse than the error they just saw.
async function persistFolder(full) {
  // Optimistic: the tile has to be there the moment the dialog closes. The
  // ghost is what holds it if the write failed, and it is removed again below
  // when the failure means the folder is not coming.
  S.sessionFolders.add(full);
  try {
    const row = await createFolder(full);
    if (row) S.folders = [...S.folders, row];
    S.sessionFolders.delete(full);
    return true;
  } catch (e) {
    if (e && e.needsMigration) {
      toast(FOLDER_SESSION_ONLY, 'err');
      return true;
    }
    S.sessionFolders.delete(full);
    toast('יצירת התיקייה נכשלה: ' + ((e && e.message) || e), 'err');
    return false;
  }
}

// Create a folder under `parent` and walk into it. The row is what makes it
// survive a reload and appear for a teammate; the walk is what makes «nesting
// by navigation» actually feel like nesting.
async function makeFolder(parent, name) {
  const seg = normalizeFolderSegment(name);
  if (!seg) return;
  const full = parent ? parent + '/' + seg : seg;
  if (full.split('/').length > MAX_DEPTH) {
    toast(`אפשר לרדת עד ${MAX_DEPTH} רמות של תיקיות`, 'err');
    return;
  }
  if (!await persistFolder(full)) {
    // No folder, so no navigation: walking in would leave the reviewer standing
    // in a place that does not exist, with the failure toast already faded.
    // The repaint is what takes the optimistic tile back off the screen.
    renderToolbar();
    renderGrid();
    return;
  }
  navigate({ path: full });
}

// Every folder path that exists on the board, sorted, plus how many rows each
// holds. Derived from the LIVE rows on every render — a folder that loses its
// last file stops existing, which is the honest behaviour for a tag.
function folderIndex() {
  const counts = new Map();
  let none = 0;
  for (const a of S.assets) {
    let any = false;
    for (const t of tagsOf(a)) {
      const s = String(t);
      if (!s.startsWith(FOLDER_PREFIX)) continue;
      const p = s.slice(FOLDER_PREFIX.length);
      if (!p) continue;
      any = true;
      counts.set(p, (counts.get(p) || 0) + 1);
    }
    if (!any) none++;
  }
  const all = [...counts.keys()].sort((x, y) => x.localeCompare(y, 'he', { numeric: true }));
  return { counts, none, all };
}

/* ── stacks and the move (v2.6) ──
   A stacked card SHOWS one version and STANDS FOR all of them. Every action
   that writes to the row behind it has to decide which meaning it wants, and
   «move to folder» wants the stack: three tries at the same drawing are one
   thing to a reviewer, so filing one of them elsewhere splits a group that the
   «2/3» badge still claims is whole — and the versions the card is not
   currently showing end up in a folder nobody chose. (Contrast «שם ותגיות»,
   which edits the ONE version on screen and is right to.) */

const STACK_PREFIX = 'stack:';

function stackTagOf(a) {
  return tagsOf(a).map(String).find((t) => t.startsWith(STACK_PREFIX)) || '';
}

// Rows → the same rows with every stack completed. Order and identity are
// preserved (first occurrence wins), so the caller's selection order survives
// and a row can never appear twice.
function expandStacks(rows) {
  const out = [];
  const seen = new Set();
  const push = (a) => { if (a && !seen.has(a.id)) { seen.add(a.id); out.push(a); } };
  for (const r of rows || []) {
    const tag = stackTagOf(r);
    if (!tag) { push(r); continue; }
    for (const a of S.assets) if (stackTagOf(a) === tag) push(a);
  }
  return out;
}

// The DIRECT children of `parent` ('' = the library root), sorted the way a
// Hebrew reader expects and with numbers ordered numerically (day2 before
// day10). One function for both levels — the root is not a special case, it is
// just the empty prefix, and writing it as one is what keeps the tile strip and
// the move dialog from ever disagreeing about what is inside what.
function childrenOf(paths, parent) {
  const pre = parent ? parent + '/' : '';
  return [...paths]
    .filter((p) => p.startsWith(pre) && p.length > pre.length &&
      !p.slice(pre.length).includes('/'))
    .sort((x, y) => x.localeCompare(y, 'he', { numeric: true }));
}

/* ── folder names: TWO doors, ONE normalizer ──
   A folder name reaches the data two ways, and only one of them has a human
   at it. The new-folder dialog is typed and can be argued with. A DROPPED
   directory name is whatever the filesystem held — it never passed a
   validator, and it produced `folder:folder:evil` from a directory called
   `folder:evil`, a second pixel-identical chip from «ארכיון » with a trailing
   space, and an invisible chip from a name made only of RTL marks.
   normalizeFolderSegment is what both doors share; the dialog additionally
   REFUSES with a reason, because someone typing deserves one, while the drop
   path silently cleans and files under the parent when nothing is left. */

// U+200B..U+200F zero-width + LRM/RLM, U+202A..U+202E embedding/override,
// U+2066..U+2069 isolates, U+FEFF BOM. All invisible, all able to make two
// different strings paint identically.
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

function normalizeFolderSegment(raw) {
  let s = String(raw == null ? '' : raw);
  // NFC first: «ארכיון» typed on macOS is decomposed and would otherwise be a
  // different string from the same word pasted from anywhere else.
  if (s.normalize) s = s.normalize('NFC');
  s = s.replace(INVISIBLES, '');
  s = s.replace(/\s+/g, ' ').trim();
  // Repeated, not once: stripping a single prefix turns `folder:folder:evil`
  // into `folder:evil`, which re-creates the exact tag this is here to stop.
  while (/^folder:/i.test(s)) s = s.slice(7).replace(/\s+/g, ' ').trim();
  if (s.length > MAX_FOLDER_NAME) s = s.slice(0, MAX_FOLDER_NAME).trim();
  return s;
}

// The TYPED door. Returns '' when the name is good, otherwise the Hebrew
// reason. Checks run against the invisible-stripped string so a name padded
// with RTL marks cannot smuggle a slash or a `folder:` prefix past them, but
// the length and prefix rules still REFUSE rather than silently truncate —
// the reviewer is standing right there.
function folderNameError(raw) {
  const seen = String(raw == null ? '' : raw).replace(INVISIBLES, '').trim();
  if (!seen) return 'צריך שם לתיקייה';
  // v2.9: the refusal names BOTH ways to nest now. Until this build a dropped
  // OS folder was the only one, and the sentence said so; a reviewer who typed
  // a slash was being told to go and find a folder on their disk.
  if (seen.includes('/')) return 'שם תיקייה בלי לוכסן. תת־תיקייה נוצרת מתוך התיקייה עצמה, או בגרירת תיקייה מהמחשב';
  if (/^folder:/i.test(seen)) return 'שם תיקייה לא יכול להתחיל ב־folder:';
  if (/^\.+$/.test(seen)) return 'צריך שם אמיתי לתיקייה';
  if (seen.length > MAX_FOLDER_NAME) return `שם תיקייה עד ${MAX_FOLDER_NAME} תווים`;
  // Nothing left once the invisibles are gone (a name of pure bidi marks).
  if (!normalizeFolderSegment(raw)) return 'צריך שם אמיתי לתיקייה';
  return '';
}

// The MIME test store.js applies is by extension, so a JPEG whose bytes are
// garbage passes it — and measure() answers {null,null} rather than throwing.
// Without this probe a corrupt file uploads "successfully" and lands in the
// library as a permanently broken thumbnail nobody can explain. Decoding it
// here is the only place the truth is available.
async function decodable(file) {
  // SVG is markup, so "decodable" means PARSEABLE. Waving it through meant an
  // SVG that no parser accepts still earned a library row: it landed with
  // width/height null, drew nothing, and appeared in no failures list, so the
  // reviewer had a permanently blank card and no idea why. store.js sanitizes
  // (and drops the DOCTYPE); this decides whether the thing is an SVG at all.
  if (/svg/i.test(file.type || '')) {
    try {
      const text = await file.text();
      // The DOCTYPE goes before the parser sees it, exactly as store.js does
      // to the bytes it stores. An internal <!ENTITY> subset is a
      // billion-laughs bomb, and handing one to DOMParser would expand it in
      // THIS tab. Stripping first means the parse runs on what will actually
      // be stored, which is also the honest thing to validate.
      const safe = text.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '');
      const doc = new DOMParser().parseFromString(safe, 'image/svg+xml');
      if (doc.getElementsByTagName('parsererror').length) return false;
      const root = doc.documentElement;
      return !!root && String(root.localName || '').toLowerCase() === 'svg';
    } catch {
      return false;
    }
  }
  try {
    const bmp = await createImageBitmap(file);
    if (bmp && bmp.close) bmp.close();
    return true;
  } catch {
    return false;
  }
}

// A path laid out for a flat <select>: the depth as indentation, the leaf as
// the label. «קמפיין/shoot/day1» reads as «⌐ ⌐ day1» under its parents rather
// than as one long string that an RTL select renders segment-reversed. The
// figure space (U+2007) is used rather than a normal space because browsers
// collapse runs of normal spaces inside <option> on some platforms, which
// silently flattens the whole tree back into a list.
function optionLabel(p) {
  const parts = p.split('/');
  return '  '.repeat(parts.length - 1) + (parts.length > 1 ? '↳ ' : '') + parts[parts.length - 1];
}

// The folder picker used by the upload dock: every folder that exists, ordered
// as a tree, plus the root and a door to a new one. Built from the same
// folderUniverse() the tiles are, so the two can never disagree about what
// exists.
function folderSelect({ value = '', onNew, noneLabel }) {
  // Sorting by path string is what puts a child directly under its parent —
  // 'a' < 'a/b' < 'a/c' < 'b' — which is what makes the indentation readable
  // instead of decorative.
  const paths = [...folderUniverse()].sort((x, y) => x.localeCompare(y, 'he', { numeric: true }));
  // A folder just created but not yet uploaded into may not be in the universe
  // on a board without 029. Without this line the toolbar's next rebuild (a
  // kind chip, a search keystroke) silently resets the reviewer's choice and
  // the batch files itself nowhere.
  if (value && !paths.includes(value)) paths.unshift(value);
  const sel = el('select', { title: 'התיקייה שהקבצים ייכנסו אליה' },
    el('option', { value: '' }, noneLabel || '(שורש הספרייה)'),
    paths.map((p) => el('option', { value: p, title: p }, optionLabel(p))),
    el('option', { value: NEW_FOLDER }, '+ תיקייה חדשה…'));
  sel.value = paths.includes(value) ? value : '';
  let cur = sel.value;   // the last REAL choice, so a cancelled dialog restores it
  sel.addEventListener('change', () => {
    if (sel.value !== NEW_FOLDER) { cur = sel.value; if (onNew) onNew(cur); return; }
    // Back to the previous choice FIRST: if the reviewer cancels the dialog,
    // the select must not be left showing «+ תיקייה חדשה…» as though that
    // were a folder.
    sel.value = cur;
    // A new folder made from HERE nests under whatever the select is currently
    // pointing at, which is the same «child of where you are» rule the
    // breadcrumb button follows.
    newFolderDialog(async (name) => {
      const seg = normalizeFolderSegment(name);
      const full = cur ? cur + '/' + seg : seg;
      // Same rules as every other create door (persistFolder). On a hard
      // failure the select must stay on its previous choice — adding an option
      // for a folder that does not exist would point the whole next batch at a
      // tag nobody can navigate to.
      if (!await persistFolder(full)) return;
      // The option does not exist in this select yet, so it is added by hand
      // rather than by rebuilding the toolbar — which would destroy this very
      // element mid-interaction.
      if (![...sel.options].some((o) => o.value === full)) {
        sel.insertBefore(el('option', { value: full, title: full }, optionLabel(full)),
          sel.options[sel.options.length - 1]);
      }
      cur = full;
      sel.value = full;
      if (onNew) onNew(full);
    });
  });
  return sel;
}

/* ── the drill-in folder picker (v2.9) ──
   The move dialog walks the SAME tree the page does, one level at a time, with
   a «+ תיקייה חדשה» at every level. A flat <select> was what v2.6 had, and it
   is fine for choosing among six folders and unreadable at forty — and it
   cannot express "put it in a new folder inside this one" at all.
   Returns {root, get()} — the caller owns the confirm button, because only the
   caller knows what it is moving. */
function folderPicker({ start = '', noneLabel = 'שורש הספרייה (מחוץ לכל תיקייה)' } = {}) {
  let here = start;
  const root = el('div', { class: 'a-picker' });

  const paint = () => {
    const kids = childrenOf([...folderUniverse()], here);
    const segs = here ? here.split('/') : [];
    const crumbs = el('div', { class: 'a-row a-crumbs a-crumbs--pick' },
      el('button', {
        class: 'a-crumb', type: 'button', onclick: () => { here = ''; paint(); },
      }, '🗂 הספרייה'),
      segs.map((seg, i) => [
        el('span', { class: 'a-crumb__sep', 'aria-hidden': 'true' }, '‹'),
        el('button', {
          class: 'a-crumb', type: 'button',
          onclick: () => { here = segs.slice(0, i + 1).join('/'); paint(); },
        }, el('bdi', null, seg)),
      ]));

    const list = el('div', { class: 'a-picker__list' },
      kids.length
        ? kids.map((p) => el('button', {
            class: 'a-picker__row', type: 'button',
            onclick: () => { here = p; paint(); },
          },
          el('span', null, '📁 ', el('bdi', null, p.slice(here ? here.length + 1 : 0))),
          el('span', { class: 'a-picker__go', 'aria-hidden': 'true' }, '‹')))
        : el('div', { class: 'pv-note' }, 'אין כאן תת־תיקיות.'));

    root.replaceChildren(
      crumbs,
      list,
      el('div', { class: 'a-picker__foot' },
        el('button', {
          class: 'btn btn--ghost', type: 'button',
          onclick: () => newFolderDialog(async (name) => {
            const seg = normalizeFolderSegment(name);
            const full = here ? here + '/' + seg : seg;
            // Same rules as every other create door (persistFolder). On a hard
            // failure the picker stays where it was: moving the destination
            // into a folder that does not exist would file the whole selection
            // under a tag nobody can navigate to.
            if (!await persistFolder(full)) return;
            here = full;
            paint();
          }),
        }, '+ תיקייה חדשה'),
        el('div', { class: 'a-picker__dest' },
          'היעד: ', el('b', null, el('bdi', null, here || noneLabel))),
      ),
    );
  };
  paint();
  return { root, get: () => here };
}

// Inline name prompt. A modal rather than window.prompt(): prompt() is
// unstyled, untranslatable, blocked outright in some embedded contexts, and
// gives nowhere to put the reason a name was refused.
function newFolderDialog(done) {
  const input = el('input', {
    class: 'field__input', type: 'text', maxlength: String(MAX_FOLDER_NAME + 1),
    placeholder: 'למשל: צילומים מהמרכז',
  });
  const err = el('div', { class: 'a-ferr', hidden: true });
  const submit = (close) => {
    const bad = folderNameError(input.value);
    if (bad) {
      err.textContent = bad;
      err.hidden = false;
      input.focus();
      return false;
    }
    // The name that leaves this dialog is the NORMALIZED one, so a typed name
    // and a dropped directory that look the same really are the same folder.
    done(normalizeFolderSegment(input.value));
    if (close) close();
    return true;
  };
  const m = modal('תיקייה חדשה', el('div', null,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'שם התיקייה'), input),
    err,
    // v2.9 changed what this sentence is telling the truth about: a folder is
    // now a row, so it exists the moment it is named — empty, and visible to
    // everyone on the board. The no-slash rule stands, and the reason it can
    // stand is that nesting happens by walking in and creating again.
    el('div', { class: 'pv-note' },
      `עד ${MAX_FOLDER_NAME} תווים, בלי לוכסן. התיקייה נוצרת מיד, גם לפני שהעליתם אליה משהו. ` +
      'תת־תיקייה נוצרת מתוך התיקייה עצמה.'),
  ), { actions: [{ label: 'ביטול' }, { label: 'יצירה', primary: true, onClick: (c) => submit(c) }] });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(m.close); });
  setTimeout(() => input.focus(), 60);
}

function uploadDock() {
  const kindSel = el('select', { title: 'איך לתייק את הקבצים החדשים' },
    el('option', { value: '' }, 'סיווג אוטומטי (לפי סוג הקובץ)'),
    UPLOAD_KINDS.map((k) => el('option', { value: k }, KIND_LABEL[k])));
  // v2.9: the default target is WHERE WE ARE. The select stays as the override
  // (spec 12) — filing a stray logo at the root while standing three levels
  // deep is a real thing to want, and the tree-indented option list is what
  // makes it a two-second job instead of a navigation errand.
  const folderSel = folderSelect({
    value: S.uploadFolder,
    onNew: (v) => { S.uploadFolder = v; paintDest(); },
  });
  const file = el('input', {
    type: 'file', multiple: true, style: { display: 'none' },
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
  });
  // `webkitdirectory` is the ONLY way to pick a folder from a file dialog, and
  // it cannot coexist with a plain picker on one input — hence two.
  const dir = el('input', {
    type: 'file', multiple: true, webkitdirectory: true, style: { display: 'none' },
  });
  // v2.8: the text-only «12/68 הועלו» line is now the shared bar from ui.js —
  // same copy, same paint-honesty rules, plus a track that says how far in a
  // 68-file folder actually is. Still batch-level: one tick per file.
  const prog = uploadProgress();
  const pickDir = el('button', { class: 'btn btn--ghost', type: 'button' }, '📁 תיקייה שלמה');

  // v2.9: the dock SAYS where the batch is going. A default that follows the
  // current folder is only safe if it is stated — the same drag, done twice
  // from two different folders, now lands in two different places, and a
  // reviewer who cannot see that has no way to tell an upload from a mistake.
  // The line updates from the select, not from S, so an override is visible
  // immediately rather than at the next toolbar rebuild.
  const dest = el('div', { class: 'a-dest' });
  const paintDest = () => dest.replaceChildren(
    'ההעלאה אל: ',
    el('b', null, el('bdi', null, S.uploadFolder || '🗂 שורש הספרייה')),
  );
  paintDest();

  const dock = el('div', { class: 'a-drop' },
    el('div', { style: { fontSize: '1.5rem' } }, '🗂️'),
    el('div', null, el('b', null, 'גוררים לכאן קבצים או תיקייה'),
      ', או לוחצים לבחירה — SVG · PNG · JPG · WEBP'),
    dest,
    el('div', { class: 'a-sub', style: { marginTop: '2px' } },
      'תיקייה נסרקת על תת־התיקיות שלה, וכל קובץ מתויג לפי מיקומו. ',
      el('span', { class: 'ltr' }, `עד ${MAX_DROP_FILES}`), ' קבצים · ',
      el('span', { class: 'ltr' }, '400MB'), ' לגרירה'),
    el('div', { class: 'a-dockctl' }, kindSel, folderSel, pickDir),
    prog.root,
  );
  // both controls sit inside the click target: don't let using them open the
  // plain file dialog underneath
  kindSel.addEventListener('click', (e) => e.stopPropagation());
  folderSel.addEventListener('click', (e) => e.stopPropagation());
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
    collect(entries, loose).then(intake);
  });
  // v2.6 — THE PHONE BUG, and why these three handlers look the way they do.
  // A File from the iOS picker is a promise of a transcode, not bytes; the old
  // code handed the raw list to send() and cleared `input.value` in the SAME
  // synchronous block, then read each File three more times over the following
  // minutes. Every read after the first came back empty, so a multi-select
  // uploaded exactly one photo and said nothing about the rest. intake() takes
  // a byte-for-byte snapshot FIRST and only then lets go of the input.
  file.addEventListener('change', async () => {
    if (S.busy) { toast('העלאה כבר רצה, רגע', 'err'); return; }
    const picked = [...file.files].map((f) => ({ file: f, path: f.name }));
    await intake(picked);
    file.value = '';   // AFTER the snapshot, never before
  });
  dir.addEventListener('change', async () => {
    if (S.busy) { toast('העלאה כבר רצה, רגע', 'err'); return; }
    // webkitRelativePath is the picker's version of the drop path.
    const picked = [...dir.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    await intake(picked);
    dir.value = '';
  });

  // Snapshot, then upload. A file whose bytes could not be read is NOT
  // dropped: it rides into send() as a pre-failure and shows up by name in the
  // same modal as every other failure, because "eight of nine uploaded" is
  // only useful if the ninth has a name.
  async function intake(items) {
    const live = items.filter((it) => !isJunk(it.path));
    if (!live.length) { toast('לא נמצאו קבצים להעלאה', 'err'); return; }
    // The cap is checked BEFORE the snapshot, not only inside send(): the
    // snapshot pulls every byte into memory, and copying 500MB just to refuse
    // it on the next line would hang the tab on the one drop that was always
    // going to be rejected.
    if (overCap(live)) return;
    // The bar appears only AFTER the cap has been cleared, so the refusal
    // modal never opens over a progress bar for an upload that will not
    // happen. Snapshotting a phone folder is seconds of copying with nothing
    // on screen otherwise — that is what phase() is for.
    // …unless a batch is already running: its bar belongs to IT, and a second
    // drop that send() is about to refuse must not repaint someone else's
    // progress.
    if (!S.busy) prog.phase('מכינים את הקבצים…');
    const snap = await snapshotItems(live);
    await send(snap.ok, snap.failed);
  }

  // The cap, refused LOUDLY (a toast alone is missable on a big drop).
  function overCap(live) {
    const bytes = live.reduce((n, it) => n + ((it.file && it.file.size) || 0), 0);
    if (live.length <= MAX_DROP_FILES && bytes <= MAX_DROP_BYTES) return false;
    const mb = Math.round(bytes / (1024 * 1024));
    modal('הגרירה גדולה מדי', el('div', null,
      el('p', null, 'בגרירה אחת אפשר להעלות עד ',
        el('b', null, el('span', { class: 'ltr' }, String(MAX_DROP_FILES))), ' קבצים ועד ',
        el('b', null, el('span', { class: 'ltr' }, '400MB')), '.'),
      el('p', null, 'כאן היו ', el('b', null, el('span', { class: 'ltr' }, String(live.length))),
        ' קבצים בנפח ', el('b', null, el('span', { class: 'ltr' }, mb + 'MB')),
        ', ולא הועלה כלום.'),
      el('p', { class: 'pv-note' },
        'מפצלים לתיקיות קטנות יותר, או שולחים את הארכיון המלא דרך גיבוי הענן ' +
        '(scripts/archive-sync.mjs). הספרייה כאן היא שכבת ההגשה, לא הארכיון.'),
    ));
    toast('הגרירה חורגת מהמגבלה, לא הועלה כלום', 'err');
    return true;
  }

  async function collect(entries, loose) {
    if (!entries.length) return loose.map((f) => ({ file: f, path: f.name }));
    const out = [];
    for (const entry of entries) await walkEntry(entry, '', out);
    return out;
  }

  // `preFailed` carries whatever snapshotItems() could not read, so those
  // names reach the SAME end-of-batch modal as an upload that failed later.
  async function send(items, preFailed) {
    // NOT prog.hide() here: the bar on screen belongs to the batch that is
    // still running, and this call is the one being turned away.
    if (S.busy) { toast('העלאה כבר רצה, רגע', 'err'); return; }
    const live = items.filter((it) => !isJunk(it.path));
    if (!live.length) {
      prog.hide();
      if (preFailed && preFailed.length) reportFailures(0, preFailed.length, preFailed);
      else toast('לא נמצאו קבצים להעלאה', 'err');
      return;
    }

    // Second line of defence: intake() already refused an over-cap batch
    // before snapshotting it, but send() is also reachable directly. The bar
    // comes down BEFORE overCap() can open its modal — a refusal uploads
    // nothing and must never be framed by a progress bar. The reset is free
    // for the passing case: start() runs further down the SAME synchronous
    // block, so the browser never paints the gap.
    prog.hide();
    if (overCap(live)) return;

    S.busy = true;
    dock.classList.add('over');
    const failed = [...(preFailed || [])];   // {name, reason} — shown in full at the end
    let ok = 0;
    const total = live.length + failed.length;
    prog.start(total);

    // The dock's chosen folder prefixes the WHOLE batch. A loose file lands
    // directly in it; an OS folder keeps its own structure UNDER it, so
    // dropping `day1/` into «צילומים» gives folder:צילומים and
    // folder:צילומים/day1 — the shoot stays one group and the chosen folder
    // stays the thing the rail lists. No choice = exactly the old behaviour,
    // byte for byte.
    const chosen = S.uploadFolder || '';
    for (const it of live) {
      const name = it.path;
      try {
        if (!it.file) throw new Error(it.error || 'לא ניתן לקרוא את הקובץ');
        if (!/^image\//.test(it.file.type || '')) throw new Error('סוג קובץ לא נתמך');
        // Skip the probe when normalizeImage is about to decode this file
        // anyway (over the upload cap, or HEIC): the probe is a SECOND full
        // decode, and on a 54MB phone JPEG that is a visible freeze for a
        // verdict arriving moments later either way. The threshold is
        // imgprep's own, asked rather than copied.
        if (!normalizeWillDecode(it.file) && !await decodable(it.file)) {
          // WHICH refusal, by the same rule imgprep uses. The probe runs
          // BEFORE normalizeImage, so without this a .tiff that Chrome cannot
          // decode was called corrupt here and never reached the message that
          // would have told its owner the format was simply never accepted.
          throw new Error(isAcceptedImageType(it.file)
            ? 'הקובץ פגום או אינו תמונה תקינה'
            : 'אפשר להעלות רק SVG, PNG, JPG או WEBP');
        }
        const { tags, top } = folderTags(it.path);
        const base = it.file.name.replace(/\.[^.]+$/, '');
        const finalTags = chosen
          ? pathTags(chosen).concat(tags.map((t) => FOLDER_PREFIX + chosen + '/' + t.slice(FOLDER_PREFIX.length)))
          : tags;
        const labelTop = top || chosen;
        await uploadAsset({
          // no post_id: an upload made HERE belongs to the board, not to a post
          file: it.file,
          kind: kindSel.value || undefined,
          // the first path segment pre-fills the label, so a shoot reads as a
          // shoot in the grid instead of forty filenames
          label: labelTop ? `${labelTop} · ${base}` : '',
          tags: finalTags,
        });
        ok++;
      } catch (err) {
        failed.push({ name, reason: (err && err.message) || String(err) });
      }
      prog.tick(ok + failed.length, name);
    }

    S.busy = false;
    dock.classList.remove('over');
    // The final tick is deliberately NOT cleared here. Clearing it in the same
    // synchronous block that set it means the browser never paints it: the
    // reviewer's last sight of the counter is «19/20» on a folder of 20, which
    // reads as an upload that stopped one short. refresh() rebuilds the whole
    // toolbar — and awaits, so the paint happens — which retires the line
    // honestly. Only the nothing-uploaded path has to clear it by hand.
    // v2.8 keeps that contract exactly: the full bar is what stays on screen,
    // pulse already stopped (tick's last call sets done === total).
    if (ok) {
      toast(ok === 1 ? 'הנכס נוסף לספרייה' : `${ok} נכסים נוספו לספרייה`, 'ok');
      await refresh();
    } else {
      prog.hide();
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
  // v2.9: tiles first, then cards. Built before the early return so an EMPTY
  // folder that only contains sub-folders still shows them — the case a
  // tag-derived folder system could never produce, and the first thing anyone
  // will try after creating three levels.
  const tiles = folderTiles();
  if (!list.length) {
    const why = searching()
      ? 'לא נמצא נכס שמתאים לחיפוש. החיפוש סורק את כל הספרייה, לא רק את התיקייה הזאת.'
      : (S.assets.length
          ? (tiles ? 'אין כאן קבצים, רק תת־תיקיות.' : 'אין נכס שמתאים לסינון הזה.')
          : null);
    $('grid').replaceChildren(
      ...(tiles ? [tiles] : []),
      el('p', { class: 'empty' }, why
        ? why
        : el('span', null, el('b', null, 'הספרייה עדיין ריקה. '),
            'מעלים כאן תמונות, לוגו או איורים — והם יהיו זמינים בכל הפוסטים.')));
    return;
  }
  // «AI Generated» groups by style, newest style-batch first; every other
  // view stays one flat grid.
  if (S.kind === 'ill-ai') {
    const groups = new Map();
    for (const a of list) {
      const s = styleOf(a);
      if (!groups.has(s)) groups.set(s, []);
      groups.get(s).push(a);
    }
    // v2.5.2: inside each style group, fal's several tries at the same input
    // line collapse into ONE stacked card. Scoped to this tab on purpose — it
    // is the only view where a `stack:` tag is ever present in quantity, and
    // «כל הנכסים» stays a literal, one-card-per-row inventory of the board.
    $('grid').replaceChildren(...(tiles ? [tiles] : []), ...[...groups.entries()].map(([name, items]) => {
      const stacks = groupStacks(items);
      return el('section', { class: 'a-group' },
        el('h3', { class: 'a-group__head' },
          el('bdi', null, name),
          el('span', { class: 'a-group__n' }, stacks.length === items.length
            ? String(items.length)
            : `${stacks.length} · ${items.length} גרסאות`)),
        el('div', { class: 'a-grid' },
          stacks.map((it) => card(currentOf(it), it))));
    }));
    return;
  }
  $('grid').replaceChildren(...(tiles ? [tiles] : []), el('div', { class: 'a-grid' }, list.map(card)));
}

// A grid cell. `item` is the stack item this card stands for (v2.5.2); it is
// optional so every non-«AI Generated» caller keeps passing a bare row.
//
// A stacked card is a card that REPAINTS: the outer <div> is stable (the grid
// holds it) and paint() rebuilds its children from whichever version the stack
// is currently showing. That is what makes the cycle cheap and, more to the
// point, what lets the detail modal switch a version and have the card behind
// it agree — both go through the same stacks.js item.
function card(a, item) {
  const stacked = isStacked(item);
  if (!stacked) return cardBody(a, null, () => {});
  const root = el('div', { class: 'a-card a-card--stack' });
  const paint = () => {
    const inner = cardBody(currentOf(item), item, paint);
    root.className = inner.className + ' a-card--stack';
    root.replaceChildren(...inner.childNodes);
  };
  paint();
  return root;
}

function cardBody(a, item, repaint) {
  const url = assetRowUrl(a);
  const stacked = isStacked(item);
  const isVec = /svg/i.test(a.mime || '') || a.source === 'studio';
  const thumb = el('div', {
    class: 'a-thumb' + (isVec ? ' a-thumb--vec' : ' a-thumb--cover'),
    // Operator directive: «clicking the illustration rotates through its
    // versions». On this page there is no slide to drag onto, so the click is
    // the whole interaction and the detail view moves to its own button below
    // — a thumb that both cycles AND zooms would do neither predictably.
    title: stacked ? 'לחיצה מחליפה גרסה' : 'הגדלה',
    onclick: () => {
      if (stacked) { cycleStack(item); repaint(); return; }
      openAsset(a, url);
    },
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
  if (stacked) {
    thumb.appendChild(el('span', { class: 'a-vbadge' }, stackBadge(item)));
    thumb.appendChild(el('span', { class: 'a-vrot', 'aria-hidden': 'true' }, '↻'));
  }
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
      // v2.6: the folder gets its own clickable chip, and the `folder:` tags
      // it stands for drop out of the tag row. Showing both would list
      // «folder:shoot», «folder:shoot/day1» AND the chip for one fact, and on
      // a nested shoot the tag row was already longer than the card.
      folderRow(a),
      (() => {
        const rest = tagsOf(a).filter((t) => !String(t).startsWith(FOLDER_PREFIX));
        return rest.length ? el('div', { class: 'a-tags' }, rest.map((t) => el('span', { class: 'tag' }, t))) : null;
      })(),
      el('div', { class: 'a-used' }, used.length
        ? el('span', null, 'בשימוש ב־', el('b', null, String(used.length)),
            used.length === 1 ? ' פוסט' : ' פוסטים')
        : 'לא בשימוש עדיין'),
      el('div', { class: 'a-acts' },
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => editAsset(a) }, 'שם ותגיות'),
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => moveDialog([a]) }, '📁 העברה'),
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => exportDialog([a]) }, '⬇︎ ייצוא'),
        el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => copyLink(url) }, 'העתקת קישור'),
        // v2.9. Last in the row on purpose: it is the only action here that
        // takes something away, and it should not sit under a thumb where an
        // «open it bigger» reflex lands. A stacked card deletes every version,
        // exactly like «העברה» does (deleteDialog expands the stack) — the
        // «2/3» badge would otherwise keep promising versions that are gone.
        el('button', {
          class: 'btn btn--ghost a-danger', type: 'button',
          onclick: () => deleteDialog([a]),
        }, '🗑 מחיקה'),
        // The thumb now cycles, so «הגדלה» needs a door of its own — without
        // it the detail view (and with it the version strip) is unreachable on
        // a stacked card. It doubles as the honest count: «גרסאות · 3».
        stacked
          ? el('button', {
              class: 'btn btn--ghost', type: 'button',
              onclick: () => openAsset(currentOf(item), assetRowUrl(currentOf(item)), item, repaint),
            }, 'גרסאות · ' + item.versions.length)
          : null,
        used.length
          ? el('button', { class: 'btn btn--ghost', type: 'button', onclick: () => showUsage(a, used) }, 'איפה בשימוש')
          : null,
      ),
    ),
  );
}

// The card's folder chip. v2.9: clicking it now WALKS INTO that folder instead
// of filtering to it — the shortest path from «I can see this belongs to the
// shoot» to «show me the shoot», and the reason the folder is on the card at
// all. It matters most in a global search result, where the chip is the only
// thing on the card that says where the hit actually lives.
function folderRow(a) {
  const f = folderOf(a);
  if (!f) return null;
  return el('div', { class: 'a-fold' }, el('button', {
    class: 'a-fold__b', type: 'button', title: 'מעבר לתיקייה הזאת',
    onclick: () => {
      // The search box is what put a foreign folder's card on screen; leaving
      // it filled would land in the folder showing global results again.
      S.q = '';
      navigate({ path: f });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
  }, '📁 ', el('bdi', null, f)));
}

// Move one asset or a whole selection into a folder (or out of every folder).
// `tags` is a writable column, which is exactly why this works for ANY source:
// a studio SVG and a reviewer upload are filed the same way, even though only
// one of them has bytes this tool ever wrote.
function moveDialog(picked) {
  // ONE place, so the per-card button and the bulk bar cannot disagree: a
  // stacked card moves as a UNIT. S.sel holds only the id of the version a
  // stacked card happens to be displaying, so the bulk path had the same hole.
  const rows = expandStacks(picked);
  if (!rows.length) return;
  const hidden = rows.length - (picked || []).length;
  // v2.9: the same drill-in tree the page walks, instead of v2.6's flat select.
  // It starts where the reviewer already is, which is right almost always —
  // a move is usually into a sibling of the folder on screen. It also gains
  // «+ תיקייה חדשה» at every level, so "move these into a new folder inside
  // this one" stopped being a two-step errand.
  const pick = folderPicker({
    start: rows.length === 1 ? folderOf(rows[0]) : S.path,
    noneLabel: 'שורש הספרייה (הוצאה מכל תיקייה)',
  });
  const status = el('div', { class: 'pv-note', style: { marginTop: '8px' } });

  const run = async (close) => {
    const dest = pick.get();
    status.textContent = 'מעבירים…';
    const failed = [];
    let moved = 0;
    for (const a of rows) {
      // Only the folder: tags are replaced. Everything else a reviewer or a
      // producer wrote — style:, stack:, style-ref — is left exactly as it
      // was, because a move is a move and not a re-tag.
      const keep = tagsOf(a).filter((t) => !String(t).startsWith(FOLDER_PREFIX));
      const next = dest ? keep.concat(pathTags(dest)) : keep;
      try {
        await updateAsset(a.id, { tags: next });
        a.tags = next;   // keep the in-memory row honest without a full refetch
        moved++;
      } catch (e) {
        failed.push({ name: a.name || a.id, reason: (e && e.message) || String(e) });
      }
      status.textContent = `${moved + failed.length}/${rows.length} הועברו`;
    }
    if (close) close();
    renderToolbar();
    renderGrid();
    // The count is what ACTUALLY moved, which on a stacked card is every
    // version and not the one the card was showing.
    if (moved) {
      toast(dest
        ? (moved === 1 ? `הנכס הועבר אל ${dest}` : `${moved} נכסים הועברו אל ${dest}`)
        : (moved === 1 ? 'הנכס הוצא מהתיקייה' : `${moved} נכסים הוצאו מהתיקייה`), 'ok');
    }
    if (failed.length) reportFailures(moved, rows.length, failed);
    return true;
  };

  modal(rows.length === 1 ? 'העברה לתיקייה' : `העברת ${rows.length} נכסים לתיקייה`, el('div', null,
    el('div', { class: 'field' }, el('label', { class: 'field__label' }, 'לאן להעביר'), pick.root),
    el('div', { class: 'pv-note' },
      'התיקייה היא תגית, אז ההעברה משנה רק אותה. שאר התגיות של הנכס נשארות כמו שהן.'),
    // Said out loud, because the grid shows ONE card and this is about to
    // write to several rows.
    hidden > 0
      ? el('div', { class: 'pv-note' },
          `הבחירה כוללת גרסאות נוספות של אותו איור, וכולן עוברות יחד. סך הכול ${rows.length} נכסים.`)
      : null,
    status,
  ), { actions: [{ label: 'ביטול' }, { label: 'העברה', primary: true, onClick: (c) => { run(c); return false; } }] });
}

/* ── delete (v2.9, spec 12) ──
   SOFT and UNDOABLE, and the two are the same decision: a stamp is trivially
   reversible, which is what lets a tool for non-technical therapists offer
   deletion at all. The bytes are never touched — slides place photos by public
   URL, and an approved carousel must not break because someone tidied the
   library a month later.

   A STACK deletes as a UNIT, for the same reason a stack MOVES as a unit (v2.6
   F1): the card shows one version and stands for all of them, so deleting "the
   card" while leaving two orphans behind — which the «2/3» badge would still
   count — is not what anyone meant. expandStacks is the one place that decides,
   shared with moveDialog. */

function deleteDialog(picked) {
  const rows = expandStacks(picked);
  if (!rows.length) return;
  const ids = rows.map((a) => a.id);
  const hidden = rows.length - (picked || []).length;
  const secs = Math.round(UNDO_MS / 1000);

  const status = el('div', { class: 'pv-note', style: { marginTop: '8px' } });
  const run = async (close) => {
    status.textContent = 'מוחקים…';
    try {
      await deleteAssets(ids);
    } catch (e) {
      status.textContent = '';
      // One sentence, and it is the SAME sentence whichever of the three
      // unapplied-029 failures the server chose (42501 / 42703 / 42P01) —
      // store.js already collapsed them. Everything else propagates as itself.
      toast((e && e.message) || 'המחיקה נכשלה', 'err');
      return;
    }
    if (close) close();
    // The rows leave the page immediately rather than waiting for a refetch:
    // a delete that takes a round-trip to become visible reads as a failure,
    // and the reviewer clicks it again.
    const gone = new Set(ids);
    S.assets = S.assets.filter((a) => !gone.has(a.id));
    for (const id of ids) S.sel.delete(id);
    S.usage = buildUsage(S.assets, S.posts);
    renderToolbar();
    renderGrid();

    undoToast(
      rows.length === 1 ? 'הנכס נמחק' : `${rows.length} נכסים נמחקו`,
      async () => {
        try {
          await restoreAssets(ids);
        } catch (e) {
          toast('השחזור נכשל: ' + ((e && e.message) || e), 'err');
          return;
        }
        // A full refresh, not a splice-back: the undo must restore the rows
        // AND everything derived from them — folder counts, the stack the card
        // belonged to, «איפה בשימוש» — to exactly what they were. Re-reading is
        // the only version of that which cannot drift.
        await refresh();
        toast(rows.length === 1 ? 'הנכס שוחזר' : `${rows.length} נכסים שוחזרו`, 'ok');
      });
  };

  modal(rows.length === 1 ? 'מחיקת נכס' : `מחיקת ${rows.length} נכסים`, el('div', null,
    el('p', null, rows.length === 1
      ? 'הנכס יוסר מהספרייה, מהתיקיות ומבורר הנכסים בעורך.'
      : `${rows.length} נכסים יוסרו מהספרייה, מהתיקיות ומבורר הנכסים בעורך.`),
    // Said plainly, because it is the thing that makes this safe — and because
    // a reviewer who knows slides keep working is a reviewer who will actually
    // tidy the library.
    el('p', { class: 'pv-note' },
      `הקבצים עצמם נשמרים, ושקפים שכבר עוצבו איתם ימשיכו להיראות כרגיל. ` +
      `יהיה אפשר לבטל תוך ${secs} שניות.`),
    hidden > 0
      ? el('div', { class: 'pv-note' },
          `הבחירה כוללת גרסאות נוספות של אותו איור, וכולן נמחקות יחד. סך הכול ${rows.length} נכסים.`)
      : null,
    status,
  ), { actions: [
    { label: 'ביטול' },
    { label: '🗑 מחיקה', primary: true, onClick: (c) => { run(c); return false; } },
  ] });
}

/* ── actions ── */

// The detail view. `item`/`onSwitch` are the v2.5.2 stack extras: when the
// asset belongs to a stack the modal grows a strip of every version, and
// picking one switches BOTH the modal and — through the shared stacks.js item
// plus the card's own repaint — the grid card that opened it. One current
// index, two surfaces; anything else and closing the modal would silently undo
// the choice just made in it.
function openAsset(a, url, item, onSwitch) {
  const stacked = isStacked(item);
  const img = el('img', {
    src: url, alt: a.label || a.name || '',
    style: { maxWidth: '100%', maxHeight: stacked ? '56vh' : '68vh', display: 'block', margin: '0 auto' },
  });
  const note = el('div', { class: 'pv-note', style: { marginTop: '10px' } });
  const link = el('div', { class: 'a-sub', style: { marginTop: '4px' } });
  const strip = stacked ? el('div', { class: 'a-vstrip' }) : null;

  const show = (row) => {
    const u = assetRowUrl(row);
    img.src = u;
    img.alt = row.label || row.name || '';
    note.textContent = [
      stacked ? `גרסה ${stackBadge(item)}` : '',
      row.author ? `העלה: ${row.author}` : '',
      row.created_at ? fmtDate(row.created_at) : '',
      row.source === 'studio' ? 'נכס סטודיו' : '',
    ].filter(Boolean).join(' · ');
    link.replaceChildren(el('span', { class: 'ltr' }, u));
    if (strip) {
      strip.replaceChildren(...item.versions.map((v, i) => el('button', {
        type: 'button',
        class: 'a-vstrip__b' + (i === item.current ? ' is-on' : ''),
        title: 'גרסה ' + (i + 1),
        'aria-pressed': i === item.current ? 'true' : 'false',
        onclick: () => {
          show(setStackIndex(item, i));
          if (typeof onSwitch === 'function') onSwitch();
        },
      }, el('img', { src: assetRowUrl(v), alt: 'גרסה ' + (i + 1), loading: 'lazy' }))));
    }
  };
  show(a);

  modal(a.label || a.name || 'נכס', el('div', null, img, strip, note, link));
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

   The size list is GEN_DIMS, imported from store.js and NEVER extended here.
   Spec §C's full nine-preset matrix landed with the §D-2 build: GEN_DIMS and
   its Edge-Function twin moved together and scripts/dims-check.mjs now proves
   it. This dialog picked the extra sizes up for free the moment they existed,
   which is the whole point of importing the table instead of listing sizes
   twice — adding keys on only one side refuses generations. */

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

  const dim = size === ORIG ? null : dimByKey(size);
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
