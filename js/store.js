// store.js — the ONLY module that talks to a backend (PLAN contract).
// Two drivers behind one API:
//   SupabaseDriver — PostgREST + storage + realtime, x-board-key capability header
//   LocalDriver    — REST to scripts/serve.mjs on http://localhost:8907 (?local=1)
// All functions are async and throw Error(message) on failure.

import { el, modal, toast, injectFonts } from './ui.js';
// v2.6 phone-proofing. normalizeImage runs at the two exported upload entry
// points below, so EVERY caller — the assets dock, the post page's תמונות tab,
// the editor's picker, the generate page — gets a bucket-safe file without
// having to remember to ask. imgprep.js imports nothing, so this adds no edge
// to the module graph.
import { normalizeImage } from './imgprep.js';

const LS = {
  board: 'smr:board', name: 'smr:name', aid: 'smr:aid', bname: 'smr:bname',
  role: 'smr:role',
};
const LOCAL_ORIGIN = 'http://localhost:8907';

let driver = null;
let boardKey = '';
let isLocal = false;

// ---------------------------------------------------------------- helpers

function cfg() {
  return (typeof window !== 'undefined' && window.SMR_CONFIG) || {};
}

function enc(v) {
  return encodeURIComponent(String(v));
}

function randHex(n) {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, n);
}

async function errText(res) {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    msg = body.message || body.error || body.msg || msg;
    if (body.details) msg += ` — ${body.details}`;
  } catch { /* not json */ }
  return msg;
}

// Same message as errText, but the HTTP status and PostgREST's SQLSTATE ride
// ALONG on the Error. A caller that wants to recover from ONE specific failure
// (see listPosts' 42703 fallback) can then branch on that failure alone instead
// of on `catch (e)`, which is every failure — offline, RLS, expired key —
// looking identical. Same idea as savePostSlides' `e.conflict`.
async function restError(res) {
  let msg = `${res.status} ${res.statusText}`;
  let code = '';
  try {
    const body = await res.json();
    msg = body.message || body.error || body.msg || msg;
    if (body.details) msg += ` — ${body.details}`;
    code = String(body.code || '');
  } catch { /* not json */ }
  const e = new Error(msg);
  e.status = res.status;
  e.code = code;          // PostgreSQL SQLSTATE, e.g. '42703' undefined_column
  return e;
}

function need() {
  if (!driver) throw new Error('initStore() לא הופעל עדיין');
  return driver;
}

// File extension for a storage path: the real one when the name carries a
// sane one, otherwise derived from the MIME type. Never trusts the name for
// anything but the suffix.
function extOf(file) {
  const raw = (file && file.name && file.name.includes('.')) ? file.name.split('.').pop() : '';
  const clean = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5);
  return clean || ({
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/svg+xml': 'svg', 'image/gif': 'gif',
  }[(file && file.type) || ''] || 'jpg');
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('קריאת הקובץ נכשלה'));
    r.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- identity

export function whoAmI() {
  let author_id = localStorage.getItem(LS.aid);
  if (!author_id) {
    author_id = randHex(8);
    localStorage.setItem(LS.aid, author_id);
  }
  return { name: localStorage.getItem(LS.name) || '', author_id };
}

let namePromise = null;

export function ensureName() {
  const me = whoAmI();
  if (me.name) return Promise.resolve(me);
  if (namePromise) return namePromise;
  namePromise = new Promise((resolve) => {
    const input = el('input', {
      class: 'field__input', type: 'text', maxlength: '40',
      placeholder: 'השם שלך',
    });
    const save = (close) => {
      const name = input.value.trim();
      if (!name) { input.focus(); return false; }
      localStorage.setItem(LS.name, name);
      window.dispatchEvent(new CustomEvent('smr:name', { detail: { name } }));
      // FIRST naming only — never ui.js's nav-chip rename. tours.js listens
      // for this to offer the guided tour once per browser.
      window.dispatchEvent(new CustomEvent('smr:first-name', { detail: { name } }));
      namePromise = null;
      if (close) close();
      resolve(whoAmI());
      return true;
    };
    const m = modal('איך קוראים לך?',
      el('div', { class: 'field' },
        el('label', { class: 'field__label' }, 'השם מופיע ליד ההצבעות וההערות שלך — פעם אחת וזהו'),
        input,
      ),
      { dismissable: false, actions: [{ label: 'נכנסים', primary: true, onClick: () => save() }] },
    );
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(m.close); });
    setTimeout(() => input.focus(), 60);
  });
  return namePromise;
}

// ---------------------------------------------------------------- role (v2.3)
// DECLARED, never enforced: the role decides what is PROMINENT, never what is
// possible. Everything a marketing hat can do, a therapist hat can do too —
// it is just less in the way. Set once via ?role=marketing|therapist on any
// page URL (the operator hands out two links); persisted in localStorage so it
// survives navigation without riding internal links.
//
// ui.js's navBar owns the chip + picker and reads/writes the SAME key
// directly (it must never import store.js — that would be a cycle), so both
// sides dispatch the same 'smr:role' event.

const ROLES = ['marketing', 'therapist'];

// 'marketing' | 'therapist' | ''  ('' = no declared role)
export function getRole() {
  const v = localStorage.getItem(LS.role) || '';
  return ROLES.includes(v) ? v : '';
}

export function setRole(role) {
  const v = ROLES.includes(role) ? role : '';
  if (v) localStorage.setItem(LS.role, v);
  else localStorage.removeItem(LS.role);
  window.dispatchEvent(new CustomEvent('smr:role', { detail: { role: v } }));
  return v;
}

// ---------------------------------------------------------------- init

export async function initStore() {
  const params = new URLSearchParams(location.search);
  isLocal = params.get('local') === '1';
  let board = params.get('board') || '';

  // ?role= is a one-time declaration: seen once, it persists. An unknown value
  // is ignored rather than clearing an existing role (a typo must not silently
  // strip the hat someone already declared); ?role= empty CLEARS deliberately.
  if (params.has('role')) {
    const want = String(params.get('role') || '').toLowerCase();
    if (ROLES.includes(want) || want === '') setRole(want);
  }

  if (isLocal) {
    boardKey = board || 'local';
    driver = new LocalDriver(boardKey);
    if (!board) {
      // no ?board in local mode — resolve the real key from serve.mjs state
      try {
        const s = await driver.state();
        if (s.board && s.board.board_key) driver.setBoard(s.board.board_key);
        boardKey = driver.board;
      } catch { /* serve.mjs not up yet; stay on 'local' */ }
    }
  } else {
    if (board) localStorage.setItem(LS.board, board);
    else board = localStorage.getItem(LS.board) || '';
    if (!board) throw new Error('חסר מפתח לוח — פתחו את הקישור המלא שקיבלתם');
    boardKey = board;
    driver = new SupabaseDriver(boardKey, cfg());
  }

  injectFonts(assetUrl);

  // resolve the board display name in the background (navBar listens)
  driver.fetchBoardName()
    .then((n) => {
      if (!n) return;
      localStorage.setItem(LS.bname, n);
      window.dispatchEvent(new CustomEvent('smr:board', { detail: { name: n } }));
    })
    .catch(() => {});

  const me = whoAmI();
  return { board_key: boardKey, name: me.name, local: isLocal };
}

// ---------------------------------------------------------------- assets

export function assetUrl(path) {
  return need().assetBase + String(path || '').replace(/^\/+/, '');
}

export function slideUrl(post, i) {
  const prefix = (post && post.asset_prefix) || '';
  return assetUrl(prefix + 'slide-' + String(i + 1).padStart(2, '0') + '.png');
}

// URL for a reviewer-uploaded photo row (works for both drivers).
export function photoUrl(row) {
  if (!row || !row.storage_path) return '';
  if (isLocal) return need().assetBase + row.storage_path.replace(/^\/+/, '');
  return `${need().url}/storage/v1/object/public/sm-photos/${row.storage_path}`;
}

// URL for an sm_assets row (v2.0 library). Two populations, two homes:
// source='studio' AND source='generated' rows point INTO the sm-assets board
// mirror (the same base assetUrl() serves) — fal-made drawings are written by
// fulfill.mjs to the board's studio/illustrations/ exactly like mirrored ones,
// they only carry a different source so the library can tell them apart (spec
// 07 constraint 4). Reviewer uploads live in sm-photos exactly like sm_photos
// rows. Both drivers, one function — nothing else resolves assets.
export function assetRowUrl(row) {
  if (!row || !row.storage_path) return '';
  if (row.source === 'studio' || row.source === 'generated') {
    return assetUrl(row.storage_path);
  }
  return photoUrl(row);
}

// ---------------------------------------------------------------- SupabaseDriver

class SupabaseDriver {
  constructor(board, conf) {
    if (!conf.supabaseUrl || !conf.supabaseAnon) {
      throw new Error('config.js חסר או לא נטען — אין חיבור לשרת');
    }
    this.board = board;
    this.url = conf.supabaseUrl.replace(/\/+$/, '');
    this.anon = conf.supabaseAnon;
    this.rest = this.url + '/rest/v1/';
    this.assetBase = `${this.url}/storage/v1/object/public/sm-assets/boards/${enc(board)}/`;
    this.realtimeClient = null;
    this.pollTimer = null;
  }

  headers(extra) {
    return {
      apikey: this.anon,
      Authorization: 'Bearer ' + this.anon,
      'x-board-key': this.board,
      ...extra,
    };
  }

  async req(method, pathAndQuery, body) {
    const opts = { method, headers: this.headers() };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.headers.Prefer = 'return=representation';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(this.rest + pathAndQuery, opts);
    // restError, not errText: same message, plus .status/.code so one caller can
    // recognise ONE failure. Everything that used to `throw new Error(msg)` here
    // still throws an Error with that same msg — nothing downstream changes.
    if (!res.ok) throw await restError(res);
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  select(table, query) {
    return this.req('GET', `${table}?${query}`);
  }

  // CRITICAL: every insert carries board_key explicitly — the x-board-key
  // header only scopes RLS, it never fills columns.
  async insert(table, row) {
    const rows = await this.req('POST', table, { ...row, board_key: this.board });
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async update(table, filter, fields) {
    const rows = await this.req('PATCH', `${table}?${filter}`, fields);
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async remove(table, filter) {
    const res = await fetch(this.rest + `${table}?${filter}`, {
      method: 'DELETE', headers: this.headers(),
    });
    if (!res.ok) throw new Error(await errText(res));
  }

  updatePost(post_id, fields) {
    return this.update('sm_posts', `board_key=eq.${enc(this.board)}&id=eq.${enc(post_id)}`, fields);
  }

  // Direct collaborative editing (v1.5): PATCH the shared slides JSON.
  // expected_updated_at is the optimistic guard — it rides as an eq filter,
  // so a concurrent write (different updated_at) matches zero rows and we
  // throw a distinguishable conflict error the caller can rebase on.
  //
  // slide_count rides the SAME PATCH (migration 023). It is a denormalization
  // of slides.length and nothing on the board used to maintain it, so an
  // uploaded re-render that changed the number of slides (uploadRenderVersion
  // is the only writer that can) left the column permanently lying — a 5 on a
  // 2-slide post. Readers inside this repo were patched to prefer the array
  // (post.js slideTotal(), sync.mjs), but the STORED number is what leaves the
  // repo: both publishers and anything not yet patched read it. Every writer of
  // `slides` therefore writes `slide_count` in the same statement — a derived
  // column maintained anywhere but beside its source drifts by construction.
  // This PATCH REQUIRES migration 023, which adds slide_count to the anon
  // column grant (and does the §14 revoke that makes that list binding at all).
  // Without it the whole statement is rejected — probed live: HTTP 401
  // `42501 permission denied for table sm_posts`, with `slides` unwritten too.
  // PostgREST does not apply the columns it may and drop the rest, so this
  // fails loudly rather than half-saving; do not "harden" it by dropping
  // slide_count on error, which is the drift this exists to end.
  async savePostSlides(post_id, slides, expected_updated_at, me) {
    let filter = `board_key=eq.${enc(this.board)}&id=eq.${enc(post_id)}`;
    if (expected_updated_at) filter += `&updated_at=eq.${enc(expected_updated_at)}`;
    const row = await this.update('sm_posts', filter, {
      slides, slide_count: slides.length, updated_by: me.name,
    });
    if (!row) {
      const e = new Error('הפוסט עודכן בינתיים על ידי מישהו נוסף');
      e.conflict = true;
      throw e;
    }
    return row; // fresh row incl. the new updated_at (touch trigger)
  }

  async fetchBoardName() {
    const rows = await this.select('sm_boards', `select=name&board_key=eq.${enc(this.board)}`);
    return rows && rows[0] ? rows[0].name : '';
  }

  async uploadPhoto({ post_id, pin_id, file, note }, me) {
    const path = `boards/${this.board}/${post_id}/${crypto.randomUUID()}.${extOf(file)}`;
    const res = await fetch(`${this.url}/storage/v1/object/sm-photos/${path}`, {
      method: 'POST',
      headers: {
        apikey: this.anon,
        Authorization: 'Bearer ' + this.anon,
        'Content-Type': file.type || 'application/octet-stream',
        // uuid path = immutable object; without this storage serves `no-cache`
        // and every board viewer re-downloads the photo on every visit
        'cache-control': 'max-age=31536000',
      },
      body: file,
    });
    if (!res.ok) throw new Error(await errText(res));
    const url = `${this.url}/storage/v1/object/public/sm-photos/${path}`;
    const row = await this.insert('sm_photos', {
      post_id,
      pin_id: pin_id || null,
      storage_path: path,
      note: note || '',
      author: me.name,          // sm_photos has no author_id column
    });
    return { url, row };
  }

  // ---- asset library (sm_assets, v2.0) ----
  // Bytes go to sm-photos (same bucket, same policy as post photos); the row
  // goes to sm_assets. `dir` is the folder under boards/<key>/ — 'library'
  // for library uploads, the post id for post-scoped ones, so a post upload
  // keeps its existing storage path and simply also earns a library row.
  async uploadAssetBytes(file, dir) {
    const path = `boards/${this.board}/${dir}/${crypto.randomUUID()}.${extOf(file)}`;
    const res = await fetch(`${this.url}/storage/v1/object/sm-photos/${path}`, {
      method: 'POST',
      headers: {
        apikey: this.anon,
        Authorization: 'Bearer ' + this.anon,
        'Content-Type': file.type || 'application/octet-stream',
        // uuid path = immutable object (see uploadPhoto)
        'cache-control': 'max-age=31536000',
      },
      body: file,
    });
    if (!res.ok) throw new Error(await errText(res));
    return path;
  }

  listAssets() {
    return this.select('sm_assets',
      `select=*&board_key=eq.${enc(this.board)}&order=created_at.desc`);
  }

  insertAsset(row) {
    return this.insert('sm_assets', row);
  }

  // Only label + tags are updatable (the anon grant is column-scoped to match).
  updateAsset(id, fields) {
    return this.update('sm_assets',
      `board_key=eq.${enc(this.board)}&id=eq.${enc(id)}`, fields);
  }

  // Studio reconcile: a plain bulk INSERT of the rows the board is missing.
  // The partial unique index (board_key, kind, name) where source='studio'
  // makes a racing second reconcile fail loudly instead of duplicating — 409
  // means someone else won, which is success from here.
  async insertStudioAssets(rows) {
    if (!rows.length) return [];
    const res = await fetch(this.rest + 'sm_assets', {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      }),
      body: JSON.stringify(rows.map((r) => ({ ...r, board_key: this.board }))),
    });
    if (res.ok) return (await res.json().catch(() => [])) || [];
    if (res.status === 409) return [];  // another tab reconciled first
    throw new Error(await errText(res));
  }

  // ---- drafts (sm_drafts, v1.3) ----
  // Upsert via PostgREST merge-duplicates on the composite pk
  // (board_key, post_id, author_id) — ALL pk columns ride in the row.
  // keepalive:true so the pagehide flush survives the page going away.
  async saveDraft(post_id, payload, me) {
    const res = await fetch(this.rest + 'sm_drafts', {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=representation',
      }),
      keepalive: true,
      body: JSON.stringify({
        board_key: this.board,
        post_id,
        author_id: me.author_id,
        author: me.name || null,
        payload, // updated_at: column default on insert, touch trigger on merge
      }),
    });
    if (!res.ok) throw new Error(await errText(res));
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async loadDraft(post_id, me) {
    const rows = await this.select('sm_drafts',
      `select=payload,updated_at,author&board_key=eq.${enc(this.board)}` +
      `&post_id=eq.${enc(post_id)}&author_id=eq.${enc(me.author_id)}`);
    return rows && rows[0] ? rows[0] : null;
  }

  async deleteDraft(post_id, me) {
    return this.remove('sm_drafts',
      `board_key=eq.${enc(this.board)}&post_id=eq.${enc(post_id)}&author_id=eq.${enc(me.author_id)}`);
  }

  async listDrafts(me) {
    return this.select('sm_drafts',
      `select=post_id,payload,updated_at,author&board_key=eq.${enc(this.board)}` +
      `&author_id=eq.${enc(me.author_id)}&order=updated_at.desc`) || [];
  }

  // ---- post versions (sm_post_versions, v1.7) ----
  // Insert-only snapshots. (board_key, post_id, vnum) is unique, so a second
  // stamp of the same vnum (two tabs ending an editing session at once) must
  // NOT throw — it resolves to the row that is already there.
  async saveVersion(row) {
    const res = await fetch(this.rest + 'sm_post_versions', {
      method: 'POST',
      headers: this.headers({
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      }),
      body: JSON.stringify({ ...row, board_key: this.board }),
    });
    if (res.ok) {
      const rows = await res.json().catch(() => null);
      return Array.isArray(rows) ? rows[0] : rows;
    }
    if (res.status === 409) { // unique violation — hand back the winner
      const rows = await this.select('sm_post_versions',
        `select=*&board_key=eq.${enc(this.board)}&post_id=eq.${enc(row.post_id)}` +
        `&vnum=eq.${enc(row.vnum)}`);
      if (rows && rows[0]) return rows[0];
    }
    throw new Error(await errText(res));
  }

  listVersions(post_id) {
    return this.select('sm_post_versions',
      `select=*&board_key=eq.${enc(this.board)}&post_id=eq.${enc(post_id)}&order=vnum.desc`);
  }

  listAllVersions() {
    return this.select('sm_post_versions',
      `select=*&board_key=eq.${enc(this.board)}&order=post_id.asc,vnum.desc`);
  }

  // ---- marketing sign-off (sm_approvals, v2.3) ----
  // Append-only and grant-enforced: anon holds select+insert and NOTHING else
  // (relacl anon=ar — ENGINEERING-NOTES §14). A revocation is a new row with
  // action='revoked'; nothing ever rewrites a signature.
  insertApproval(row) {
    return this.insert('sm_approvals', row);
  }

  listApprovals(post_id) {
    return this.select('sm_approvals',
      `select=*&board_key=eq.${enc(this.board)}&post_id=eq.${enc(post_id)}` +
      `&order=created_at.desc`);
  }

  listAllApprovals() {
    return this.select('sm_approvals',
      `select=*&board_key=eq.${enc(this.board)}&order=created_at.desc`);
  }

  // Bytes for an uploaded re-render (v2.3). sm-photos is the ONLY anon-writable
  // bucket, and its policy is PATH-shaped ([1]='boards', [2]=a real board key)
  // because storage-api never sees the x-board-key header — so this path is
  // already permitted and no storage policy change is needed or possible.
  async uploadVersionBytes(file, post_id, vnum, i) {
    const n = String(i + 1).padStart(2, '0');
    const path = `boards/${this.board}/${post_id}/v${vnum}/slide-${n}-${crypto.randomUUID()}.${extOf(file)}`;
    const res = await fetch(`${this.url}/storage/v1/object/sm-photos/${path}`, {
      method: 'POST',
      headers: {
        apikey: this.anon,
        Authorization: 'Bearer ' + this.anon,
        'Content-Type': file.type || 'application/octet-stream',
        // uuid path = immutable object (see uploadPhoto)
        'cache-control': 'max-age=31536000',
      },
      body: file,
    });
    if (!res.ok) throw new Error(await errText(res));
    return `${this.url}/storage/v1/object/public/sm-photos/${path}`;
  }

  // Realtime via supabase-js from jsDelivr; ANY failure -> 10s polling.
  // Even with realtime up, a slow 60s safety poll runs (realtime + RLS with
  // header-based board_key can silently deliver nothing in some setups).
  async startNotifications(fire) {
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
      const client = mod.createClient(this.url, this.anon, {
        global: { headers: { 'x-board-key': this.board } },
      });
      const ch = client.channel('smr-' + this.board);
      // sm_approvals is in the publication, but header-scoped RLS means anon
      // subscribers receive ZERO events from it (references/supabase.md) — the
      // 10s/60s polling below is what actually carries approval freshness.
      // Listed anyway so the day that changes needs no edit here.
      const tables = ['sm_posts', 'sm_votes', 'sm_pins', 'sm_replies', 'sm_edits',
                      'sm_publish', 'sm_post_versions', 'sm_assets', 'sm_approvals',
                      // v2.5 (spec 08): same caveat as sm_approvals — anon
                      // subscribers get nothing, the status of a generation
                      // request rides the 10s/60s poll below.
                      'sm_gen_requests'];
      for (const table of tables) {
        ch.on('postgres_changes',
          { event: '*', schema: 'public', table, filter: `board_key=eq.${this.board}` },
          () => fire());
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('realtime timeout')), 8000);
        ch.subscribe((status) => {
          if (status === 'SUBSCRIBED') { clearTimeout(timer); resolve(); }
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timer);
            reject(new Error('realtime ' + status));
          }
        });
      });
      this.realtimeClient = client;
      this.pollTimer = setInterval(fire, 60000); // safety net
    } catch {
      this.pollTimer = setInterval(fire, 10000); // polling fallback
    }
  }
}

// ---------------------------------------------------------------- LocalDriver

class LocalDriver {
  constructor(board) {
    this.api = LOCAL_ORIGIN + '/api';
    this.cache = null;
    this.pollTimer = null;
    this.setBoard(board);
  }

  setBoard(board) {
    this.board = board;
    this.assetBase = `${LOCAL_ORIGIN}/assets/${enc(board)}/`;
  }

  invalidate() {
    this.cache = null;
  }

  async state() {
    if (this.cache) return this.cache;
    let res;
    try {
      res = await fetch(this.api + '/state');
    } catch {
      throw new Error('השרת המקומי לא רץ — node scripts/serve.mjs');
    }
    if (!res.ok) throw new Error(await errText(res));
    this.cache = await res.json();
    return this.cache;
  }

  async req(method, path, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(this.api + path, opts);
    } catch {
      throw new Error('השרת המקומי לא רץ — node scripts/serve.mjs');
    }
    if (!res.ok) throw new Error(await errText(res));
    this.invalidate(); // every write invalidates the cached state
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  insert(table, row) {
    return this.req('POST', `/${table}`, row);
  }

  patch(table, id, fields) {
    return this.req('PATCH', `/${table}/${enc(id)}`, fields);
  }

  remove(table, id) {
    return this.req('DELETE', `/${table}/${enc(id)}`);
  }

  updatePost(post_id, fields) {
    return this.patch('posts', post_id, fields);
  }

  // v1.5 direct collaborative editing — serve.mjs has no conditional PATCH,
  // so the optimistic guard is a fresh-state compare just before the write.
  async savePostSlides(post_id, slides, expected_updated_at, me) {
    if (expected_updated_at) {
      this.invalidate();
      const s = await this.state();
      const cur = (s.posts || []).find((p) => p.id === post_id);
      if (cur && cur.updated_at && cur.updated_at !== expected_updated_at) {
        const e = new Error('הפוסט עודכן בינתיים על ידי מישהו נוסף');
        e.conflict = true;
        throw e;
      }
    }
    // slide_count in the SAME PATCH — see the SupabaseDriver twin for why.
    return this.patch('posts', post_id, {
      slides, slide_count: slides.length, updated_by: me.name,
    });
  }

  async fetchBoardName() {
    const s = await this.state();
    return (s.board && s.board.name) || '';
  }

  async uploadPhoto({ post_id, pin_id, file, note }, me) {
    const dataUrl = await readAsDataUrl(file);
    return this.req('POST', '/upload', {
      post_id,
      pin_id: pin_id || null,
      name: file.name || 'photo.jpg',
      note: note || '',
      author: me.name,
      dataUrl,
    });
  }

  // ---- asset library (serve.mjs /api/assets, v2.0) ----
  // serve.mjs takes bytes + row in ONE call (it writes the file and inserts
  // the row together), so the local upload is a single request rather than
  // the Supabase bytes-then-row pair; uploadAsset() below hides the seam.
  async uploadAssetFull(file, dir, row) {
    const dataUrl = await readAsDataUrl(file);
    return this.req('POST', '/assets/upload', {
      ...row, dir, name: row.name || file.name || 'asset', dataUrl,
    });
  }

  async listAssets() {
    return (await this.state()).assets || [];
  }

  insertAsset(row) {
    return this.insert('assets', row);
  }

  updateAsset(id, fields) {
    return this.patch('assets', id, fields);
  }

  async insertStudioAssets(rows) {
    if (!rows.length) return [];
    return (await this.req('POST', '/assets/studio', { rows })) || [];
  }

  // ---- drafts (serve.mjs /api/drafts, v1.3) ----
  async saveDraft(post_id, payload, me) {
    // not this.req(): keepalive lets the pagehide flush complete
    let res;
    try {
      res = await fetch(this.api + '/drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          post_id, author_id: me.author_id, author: me.name || null, payload,
        }),
      });
    } catch {
      throw new Error('השרת המקומי לא רץ — node scripts/serve.mjs');
    }
    if (!res.ok) throw new Error(await errText(res));
    return res.json().catch(() => null);
  }

  async loadDraft(post_id, me) {
    const row = await this.req('GET',
      `/drafts?post_id=${enc(post_id)}&author_id=${enc(me.author_id)}`);
    return row || null;
  }

  deleteDraft(post_id, me) {
    return this.req('DELETE',
      `/drafts?post_id=${enc(post_id)}&author_id=${enc(me.author_id)}`);
  }

  async listDrafts(me) {
    return (await this.req('GET', `/drafts?author_id=${enc(me.author_id)}`)) || [];
  }

  // ---- post versions (v1.7) — serve.mjs /api/versions ----
  // Writes go through the route (so the unique (post_id, vnum) guard lives in
  // one place); reads come off the cached /api/state payload, which already
  // carries `versions` — the gallery asks for every version row on every
  // refresh and must not pay a round-trip for it.
  saveVersion(row) {
    return this.req('POST', '/versions', row);
  }

  async listVersions(post_id) {
    const s = await this.state();
    return (s.versions || [])
      .filter((v) => v.post_id === post_id)
      .sort((a, b) => Number(b.vnum) - Number(a.vnum));
  }

  async listAllVersions() {
    return [...((await this.state()).versions || [])].sort((a, b) =>
      String(a.post_id).localeCompare(String(b.post_id)) || Number(b.vnum) - Number(a.vnum));
  }

  // ---- marketing sign-off (v2.3) — serve.mjs /api/approvals ----
  // Same split as versions: the write goes through the route (one place owns
  // the row shape), the reads come off the cached /api/state payload, which
  // carries `approvals` — the gallery and the queue want every approval row on
  // every refresh and must not pay a round-trip for it.
  insertApproval(row) {
    return this.req('POST', '/approvals', row);
  }

  async listApprovals(post_id) {
    const s = await this.state();
    return (s.approvals || []).filter((a) => a.post_id === post_id).sort(byCreatedDesc);
  }

  async listAllApprovals() {
    return [...((await this.state()).approvals || [])].sort(byCreatedDesc);
  }

  // Local byte sink for an uploaded re-render. serve.mjs's /api/assets/upload
  // is the one local route that takes arbitrary image bytes and hands back a
  // servable URL, so the uploaded slides land in assets-local/<board>/library/
  // and ALSO earn a local sm_assets row. Cloud-side there is no assets row —
  // a documented, deliberate local-only extra (bookkeeping, never behaviour).
  async uploadVersionBytes(file, post_id, vnum, i) {
    const dataUrl = await readAsDataUrl(file);
    const n = String(i + 1).padStart(2, '0');
    const res = await this.req('POST', '/assets/upload', {
      kind: 'photo',
      source: 'upload',
      name: file.name || `slide-${n}.png`,
      label: `v${vnum} · שקף ${i + 1}`,
      mime: file.type || '',
      bytes: file.size || null,
      post_id,
      dir: post_id,
      dataUrl,
    });
    return res && res.url;
  }

  startNotifications(fire) {
    this.pollTimer = setInterval(() => { this.invalidate(); fire(); }, 10000);
  }
}

// ---------------------------------------------------------------- reads

function byCreatedAsc(a, b) {
  return new Date(a.created_at) - new Date(b.created_at);
}

function byCreatedDesc(a, b) {
  return new Date(b.created_at) - new Date(a.created_at);
}

// v2.3 «English translation panel» — every sm_posts column EXCEPT `translation`.
// EXTEND THIS LIST DELIBERATELY WHEN COLUMNS ARE ADDED (a missing name here is
// a silently absent feature in the gallery — ENGINEERING-NOTES §13).
//
// Why a list and not `select=*`: `translation` is a stored English rendering of
// a whole carousel (~0.5–1 MB across 149 posts). `select=*` would drag it into
// every gallery refresh — including the 10s `subscribe()` polling fallback —
// for a payload no list surface reads. `getPost()` below keeps `select=*`, and
// is how post.html receives the translation. LocalDriver returns whole state
// rows either way (no network, so no cost); the asymmetry is deliberate.
//
// NOT LISTED, deliberately: `review_at` / `review_note`. They are in
// schema.sql §2 but migration 019 is still PENDING, so they do not exist on the
// live table — naming them here returns HTTP 400 (SQLSTATE 42703) for the whole
// query. **When 019 is applied, add them to this list**, or index.js's
// «👀 מתוזמן לבדיקה» tag silently disappears. Naming them EARLY no longer empties
// the gallery: listPosts drops the offending name and says so out loud (below).
// That safety net is for a mistake, not a plan — a dropped column is a feature
// missing from every list surface until someone fixes it.
const POST_LIST_COLS = [
  'board_key', 'id', 'category', 'title', 'caption', 'version',
  'slides', 'slide_count', 'asset_prefix', 'stage', 'origin', 'author', 'sort',
  'created_at', 'updated_at', 'updated_by',
];

// PostgREST answers an unknown column name with HTTP 400 + SQLSTATE 42703 and
// the message «column sm_posts.<name> does not exist». That — and ONLY that —
// is what listPosts' fallback may recover from. Returns the offending column
// name, or '' for every other failure: offline, DNS, RLS, an expired anon key,
// a malformed filter. Those must propagate exactly as they did before a
// fallback existed; swallowing them is how a board goes quietly wrong.
function undefinedColumnName(e) {
  if (!e || e.status !== 400) return '';
  const m = /column\s+(?:[\w"]+\.)?"?([a-z0-9_]+)"?\s+does not exist/i.exec(String(e.message || ''));
  if (String(e.code || '') !== '42703' && !m) return '';
  return m ? m[1] : '';
}

// Loud, and exactly once per page load — NOT once per 10s poll tick. A silent
// degrade is the whole failure mode being fixed here: the old fallback's only
// signal was a console.warn nobody reads, on a path that repeats every tick.
let listFallbackReported = false;
function reportListFallback(dropped) {
  if (listFallbackReported) return;
  listFallbackReported = true;
  console.error(
    `listPosts(): sm_posts has no column ${dropped.map((c) => `"${c}"`).join(', ')} — ` +
    'the gallery loaded WITHOUT it, so anything that column feeds is missing from ' +
    'the list surfaces. Either a migration that adds it is unapplied, or ' +
    'POST_LIST_COLS names a column that does not exist. Fix one of those. Do NOT ' +
    '"fix" it by going back to select=*: that drags sm_posts.translation into ' +
    'every gallery read, including the 10s polling fallback, for every reviewer.');
  toast('חלק מנתוני הפוסטים לא נטענו — עמודה חסרה בשרת. ייתכן שתגיות מסוימות לא יופיעו', 'err');
}

export async function listPosts() {
  const d = need();
  if (isLocal) {
    const s = await d.state();
    return [...(s.posts || [])].sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(b.id));
  }
  const q = `board_key=eq.${enc(boardKey)}&order=sort.asc,id.asc`;
  // The fallback is NARROW (only «that column does not exist») and it never
  // widens the select: it can only DROP names from POST_LIST_COLS, which never
  // contained `translation`. So a fired fallback cannot re-introduce the ~0.5–1
  // MB payload the explicit list exists to keep out of every poll tick — the
  // gallery loses one column's worth of decoration, never the board, and never
  // silently. Bounded by the list length: each pass removes exactly one name.
  let cols = POST_LIST_COLS.slice();
  const dropped = [];
  for (;;) {
    try {
      const rows = await d.select('sm_posts', `select=${cols.join(',')}&${q}`);
      if (dropped.length) reportListFallback(dropped);
      return rows;
    } catch (e) {
      const missing = undefinedColumnName(e);
      if (!missing || !cols.includes(missing) || cols.length === 1) throw e;
      cols = cols.filter((c) => c !== missing);
      dropped.push(missing);
    }
  }
}

export async function getPost(id) {
  const d = need();
  let row;
  if (isLocal) {
    const s = await d.state();
    row = (s.posts || []).find((p) => p.id === id);
  } else {
    const rows = await d.select('sm_posts', `select=*&board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`);
    row = rows && rows[0];
  }
  if (!row) throw new Error('הפוסט לא נמצא בלוח הזה');
  return row;
}

export async function listVotes() {
  const d = need();
  if (isLocal) return (await d.state()).votes || [];
  return d.select('sm_votes', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`);
}

// Map post_id -> Map author -> {vote, reason, created_at}; newest row per
// (post_id, author) wins.
export function latestVotes(rows) {
  const sorted = [...(rows || [])].sort(byCreatedAsc);
  const byPost = new Map();
  for (const r of sorted) {
    const author = r.author || r.author_id || '';
    if (!byPost.has(r.post_id)) byPost.set(r.post_id, new Map());
    byPost.get(r.post_id).set(author, {
      vote: r.vote,
      reason: r.reason || '',
      created_at: r.created_at,
    });
  }
  return byPost;
}

export async function listPins(post_id) {
  const d = need();
  if (isLocal) return ((await d.state()).pins || []).filter((p) => p.post_id === post_id).sort(byCreatedAsc);
  return d.select('sm_pins', `select=*&board_key=eq.${enc(boardKey)}&post_id=eq.${enc(post_id)}&order=created_at.asc`);
}

export async function listAllPins() {
  const d = need();
  if (isLocal) return [...((await d.state()).pins || [])].sort(byCreatedAsc);
  return d.select('sm_pins', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`);
}

export async function listReplies(pin_id) {
  const d = need();
  if (isLocal) return ((await d.state()).replies || []).filter((r) => r.pin_id === pin_id).sort(byCreatedAsc);
  return d.select('sm_replies', `select=*&board_key=eq.${enc(boardKey)}&pin_id=eq.${enc(pin_id)}&order=created_at.asc`);
}

// ALL reply rows for the board in one request (discussions hub) — mirrors
// listAllPins; fetching per pin would be O(pins) round-trips per refresh.
export async function listAllReplies() {
  const d = need();
  if (isLocal) return [...((await d.state()).replies || [])].sort(byCreatedAsc);
  return d.select('sm_replies', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`);
}

export async function listEdits(post_id) {
  const d = need();
  if (isLocal) return ((await d.state()).edits || []).filter((e) => e.post_id === post_id).sort(byCreatedAsc);
  return d.select('sm_edits', `select=*&board_key=eq.${enc(boardKey)}&post_id=eq.${enc(post_id)}&order=created_at.asc`);
}

export async function listAllEdits() {
  const d = need();
  if (isLocal) return [...((await d.state()).edits || [])].sort(byCreatedAsc);
  return d.select('sm_edits', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`);
}

export async function listPhotos(post_id) {
  const d = need();
  if (isLocal) return ((await d.state()).photos || []).filter((p) => p.post_id === post_id).sort(byCreatedAsc);
  return d.select('sm_photos', `select=*&board_key=eq.${enc(boardKey)}&post_id=eq.${enc(post_id)}&order=created_at.asc`);
}

// ALL photo rows for the board in one request (discussions hub shows photos
// attached to any pin) — same shape as listAllPins/listAllReplies.
export async function listAllPhotos() {
  const d = need();
  if (isLocal) return [...((await d.state()).photos || [])].sort(byCreatedAsc);
  return d.select('sm_photos', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`);
}

export async function listQueue() {
  const d = need();
  if (isLocal) return [...((await d.state()).publish || [])].sort(byCreatedAsc).reverse();
  return d.select('sm_publish', `select=*&board_key=eq.${enc(boardKey)}&order=created_at.desc`);
}

// ---------------------------------------------------------------- writes
// Every write stamps author + author_id (updated_by on updates); ensureName()
// resolves instantly once a name exists, otherwise asks first.

// v2.3 review rounds: every reviewer write may stamp the version it was made
// against. The field is OPTIONAL and the column is nullable on purpose — an
// old cached client that never sends vnum stays valid, and the 119 pre-v2.3
// rows keep their honest NULL (no backfill; a pin made on v4 must not claim
// v6). Only a finite number is ever sent, so `vnum: undefined` never reaches
// PostgREST as a null that would overwrite anything.
function withVnum(row, vnum) {
  const n = Number(vnum);
  return Number.isFinite(n) ? { ...row, vnum: n } : row;
}

export async function castVote({ post_id, vote, reason, vnum }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'votes' : 'sm_votes', withVnum({
    post_id, vote,
    reason: reason || '',
    author: me.name,
    author_id: me.author_id,
  }, vnum));
}

export async function addPin({ post_id, slide, x, y, body, vnum }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'pins' : 'sm_pins', withVnum({
    post_id,
    slide: slide || 0,
    x, y,
    body: body || '',
    author: me.name,
    author_id: me.author_id,
    status: 'open',
  }, vnum));
}

export async function deletePin(id) {
  const d = need();
  if (isLocal) return d.remove('pins', id);
  return d.remove('sm_pins', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`);
}

export async function resolvePin(id, status) {
  const d = need();
  if (isLocal) return d.patch('pins', id, { status });
  return d.update('sm_pins', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, { status });
}

export async function addReply({ pin_id, body }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'replies' : 'sm_replies', {
    pin_id,
    body: body || '',
    author: me.name,
    author_id: me.author_id,
  });
}

// v1.5 direct collaborative editing — the post page's primary write path.
// PATCHes sm_posts.slides (shared truth, everyone sees it) and returns the
// fresh row so the caller can track the new updated_at. Pass the updated_at
// the caller last saw as expected_updated_at; on a concurrent write the
// promise rejects with err.conflict === true (re-fetch, re-apply, retry).
export async function savePostSlides(post_id, slides, { expected_updated_at } = {}) {
  const me = await ensureName();
  return need().savePostSlides(post_id, slides || [], expected_updated_at || null, me);
}

// The audit/learning row for a direct write: same field/old/new format as
// proposals, but status 'applied' — it IS the record, not a request.
export async function logEdit({ post_id, field, old_text, new_text, vnum }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'edits' : 'sm_edits', withVnum({
    post_id, field,
    old_text: old_text || '',
    new_text: new_text || '',
    author: me.name,
    author_id: me.author_id,
    status: 'applied',
  }, vnum));
}

// Kept for backward compatibility (older flows / external tools). The post
// page no longer proposes — it writes directly via savePostSlides + logEdit.
export async function proposeEdit({ post_id, field, old_text, new_text, vnum }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'edits' : 'sm_edits', withVnum({
    post_id, field,
    old_text: old_text || '',
    new_text: new_text || '',
    author: me.name,
    author_id: me.author_id,
    status: 'proposed',
  }, vnum));
}

export async function setEditStatus(id, status) {
  const d = need();
  if (isLocal) return d.patch('edits', id, { status });
  return d.update('sm_edits', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, { status });
}

export async function setStage(post_id, stage) {
  const me = await ensureName();
  return need().updatePost(post_id, { stage, updated_by: me.name });
}

// v2.1 «תזמון לבדיקה» — when the team is due to look at this post.
// review_at null clears the date; note is kept separate so clearing the date
// never silently drops what the date was for. Returns the fresh post row.
export async function setReviewAt(post_id, review_at, note) {
  const me = await ensureName();
  const fields = { review_at: review_at || null, updated_by: me.name };
  if (note !== undefined) fields.review_note = note || '';
  return need().updatePost(post_id, fields);
}

// Shared manual arrangement (gallery «סידור ידני»): batch-write sm_posts.sort
// for the rows whose position changed. entries: [{id, sort}] — the caller
// diffs and passes ONLY changed rows. Both drivers route through updatePost.
export async function savePostOrder(entries) {
  const me = await ensureName();
  const d = need();
  return Promise.all((entries || []).map(({ id, sort }) =>
    d.updatePost(id, { sort, updated_by: me.name })));
}

// Updates sm_posts.caption AND inserts an sm_edits audit row
// (field 'caption', status 'applied').
export async function setCaption(post_id, caption) {
  const me = await ensureName();
  let old_text = '';
  try { old_text = (await getPost(post_id)).caption || ''; } catch { /* audit still written */ }
  const row = await need().updatePost(post_id, { caption, updated_by: me.name });
  await need().insert(isLocal ? 'edits' : 'sm_edits', {
    post_id,
    field: 'caption',
    old_text,
    new_text: caption,
    author: me.name,
    author_id: me.author_id,
    status: 'applied',
  });
  return row;
}

// v2.0: EVERY upload path also earns a library row. uploadPhoto stays the
// post-scoped entry point (post page תמונות tab, editor drop-on-slide,
// drop-on-slot, the builder) — it keeps writing sm_photos exactly as before
// AND mirrors an sm_assets row with post_id set, so the same file appears in
// that post's תמונות tab and in the board-wide library. The mirror is
// deliberately non-fatal: a library row is bookkeeping, and losing it must
// never cost a reviewer the upload they just made.
export async function uploadPhoto({ post_id, pin_id, file, note }) {
  // v2.6: a phone photo is 3024×4032 and often past the bucket's 8MB, so it
  // failed here before it ever reached the board. Normalizing at the ENTRY
  // point (not inside a driver) means both drivers, and the sm_assets mirror
  // below, see the SAME bytes — the width/height/bytes columns describe the
  // file that was actually stored rather than the one that was picked.
  file = await normalizeImage(file);
  const me = await ensureName();
  const res = await need().uploadPhoto({ post_id, pin_id, file, note }, me);
  try {
    const dim = await measure(file);
    await need().insertAsset({
      kind: defaultKind(file),
      source: 'upload',
      name: file.name || 'photo',
      storage_path: (res.row && res.row.storage_path) || '',
      mime: file.type || '',
      width: dim.width, height: dim.height, bytes: file.size || null,
      label: note || '',
      tags: [],
      post_id: post_id || null,
      author: me.name,
      author_id: me.author_id,
    });
  } catch (e) {
    console.warn('sm_assets mirror failed (upload itself succeeded):', e && e.message);
  }
  return res;
}

export async function createBuilderPost({ id, title, caption, slides, slide_count, category }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'posts' : 'sm_posts', {
    id,
    title: title || '',
    caption: caption || '',
    slides: slides || [],
    slide_count: slide_count || (slides ? slides.length : 0),
    category: category || 'builder',
    origin: 'builder',
    asset_prefix: '',
    stage: 'in_review',
    version: 'v1',
    sort: 0,
    author: me.name,
    updated_by: me.name,
  });
}

export async function queuePublish({ post_id, channel, note, scheduled_for }) {
  const me = await ensureName();
  const row = {
    post_id,
    channel: channel || 'instagram',
    note: note || '',
    status: 'queued',
    requested_by: me.name,
  };
  if (scheduled_for) row.scheduled_for = scheduled_for;
  return need().insert(isLocal ? 'publish' : 'sm_publish', row);
}

// v2.1 «תזמון לפרסום» — move an existing queue row's time / note in place, so
// re-scheduling doesn't litter the queue with duplicate rows. The CHANNEL is
// deliberately not updatable (schema grant): switching channel is a cancel +
// re-queue, which the caller does explicitly.
export async function rescheduleQueue(id, { scheduled_for, note } = {}) {
  const me = await ensureName();
  const d = need();
  const fields = { scheduled_for: scheduled_for || null, updated_by: me.name };
  if (note !== undefined) fields.note = note || '';
  if (isLocal) return d.patch('publish', id, fields);
  return d.update('sm_publish', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, fields);
}

// v2.1 cloud publishing — calls the `publish` Edge Function (the only backend
// that holds the Meta token; the browser must never see it).
//   mode 'plan' → dry run, returns the exact Graph API calls, posts nothing.
//   mode 'now'  → publish this row immediately, ignoring a future schedule.
// The operator key is a SECOND secret on top of the board key: the reviewer
// link is a capability URL handed to therapists, and holding it must never be
// enough to post to the client's real Instagram. It lives only in the
// operator's own browser and is verified inside the function.
export async function callPublisher({ mode = 'plan', row_id = null, operator_key = '' } = {}) {
  if (isLocal) {
    throw new Error('הפרסום בענן לא זמין במצב מקומי — הרצה מקומית: node scripts/publish-meta.mjs');
  }
  const base = String(cfg().supabaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('חסר supabaseUrl ב-config.js');
  const res = await fetch(base + '/functions/v1/publish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-operator-key': operator_key || '' },
    body: JSON.stringify(row_id ? { mode, row_id } : { mode }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return body;
}

export async function setQueueStatus(id, status) {
  const me = await ensureName();
  const d = need();
  if (isLocal) return d.patch('publish', id, { status, updated_by: me.name });
  return d.update('sm_publish', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, { status, updated_by: me.name });
}

// ---------------------------------------------------------------- drafts (v1.3)
// Continuous autosave of working state — one row per (post, author): the
// unsent designs / in-place text / builder deck, upserted on every editing
// step so a refresh or another device picks up exactly where the reviewer
// left off. Identity is whoAmI() (never ensureName — autosave must not pop
// the name modal). post_id is the post being edited, or the builder draft's
// pre-minted id.

export async function saveDraft(post_id, payload) {
  return need().saveDraft(post_id, payload || {}, whoAmI());
}

// -> {payload, updated_at, author} | null (own row only)
export async function loadDraft(post_id) {
  return need().loadDraft(post_id, whoAmI());
}

export async function deleteDraft(post_id) {
  return need().deleteDraft(post_id, whoAmI());
}

// own unfinished drafts, newest first (builder resume list)
export async function listDrafts() {
  return need().listDrafts(whoAmI());
}

// ------------------------------------------------ derived templates (v1.4)
// Hand-crafted slides saved as reusable templates: base studio template +
// design overrides + the slide's vars as the sample (PLAN «Derived templates»).
// Supabase table sm_templates; LocalDriver mirrors via serve.mjs /api/templates.

// the board's derived templates, newest first
export async function listTemplates() {
  const d = need();
  if (isLocal) return (await d.req('GET', '/templates')) || [];
  return d.select('sm_templates',
    `select=*&board_key=eq.${enc(boardKey)}&order=created_at.desc`);
}

export async function saveTemplate({ name, base_template, design, sample_vars, source_post }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'templates' : 'sm_templates', {
    name: name || '',
    base_template,
    design: design || null,
    sample_vars: sample_vars || {},
    source_post: source_post || null,
    author: me.name,
    author_id: me.author_id,
  });
}

export async function deleteTemplate(id) {
  const d = need();
  if (isLocal) return d.remove('templates', id);
  return d.remove('sm_templates', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`);
}

// ------------------------------------------------ post versions (v1.7)
// Snapshots of the shared slides + caption, stamped when an editing session
// that actually changed a post ends (post.js). Numbering CONTINUES the
// studio's: a post shipped as studio v4 gets board v5, v6, … The table is
// insert-only — nothing rewrites or deletes a snapshot — and a repeat stamp
// of an existing vnum resolves to the existing row instead of throwing.
// Supabase table sm_post_versions; LocalDriver mirrors via serve.mjs
// /api/versions (+ the `versions` array in /api/state).

export async function saveVersion({ post_id, vnum, slides, caption }) {
  const me = await ensureName();
  return need().saveVersion({
    post_id,
    vnum: Number(vnum),
    slides: slides || [],
    caption: caption || '',
    author: me.name,
    author_id: me.author_id,
  });
}

// one post's snapshots, newest first (vnum desc)
export async function listVersions(post_id) {
  return (await need().listVersions(post_id)) || [];
}

// EVERY version row on the board in one request — the gallery needs version
// badges for 100+ cards and must not fan out per post.
export async function listAllVersions() {
  return (await need().listAllVersions()) || [];
}

// ------------------------------------------------ marketing sign-off (v2.3)
// A named, content-bound approval: WHO signed, WHEN, WHICH version (display)
// and — since migration 022 — a fingerprint of EXACTLY WHAT they signed.
// sm_approvals is append-only and anon holds select+insert only (relacl
// anon=ar) — a signature nobody can PATCH is the whole point of the table.
// Revoking is a NEW row with action='revoked'; staleness is never stored,
// it is derived by approvalState() comparing the signed content_hash to the
// post's CURRENT content (the version trail supplies display numbers only).
//
// PLAN invariants I1–I5 govern this section. The derivations below are PURE
// (no network, no driver, no localStorage) so they are unit-testable and so
// every surface — post header, gallery card, queue row — computes the same
// answer from the same three inputs.
//
// ⚠️ LOCKSTEP: scripts/sync.mjs carries a DELIBERATE character-for-character
// duplicate of studioVnum / currentVnum / canon / fnv1a64 / contentHash /
// approvalState, inside a block marked «LOCKSTEP BLOCK — sync.mjs ⇄ store.js».
// It cannot import this file (browser ESM: localStorage/fetch/DOM at module
// scope). CHANGE ONE SIDE AND YOU MUST CHANGE THE OTHER, IN THE SAME COMMIT.
// The failure is SILENT and has already happened once: this file moved to the
// 022 content fingerprint while sync.mjs kept the vnum compare, so generated
// factory briefs printed «fresh ✓» for three posts every screen here correctly
// showed as stale. Nothing threw. Prove it instead of promising it:
//     node scripts/lockstep-check.mjs
// which imports THIS module and evaluates sync.mjs's block from the shipped
// file, then runs both over the fixture plus a synthetic matrix (matching /
// mismatched / NULL hash, revocation, jsonb key-reorder). Run it after
// touching either side.

// The studio's own version number for a post ('v4' -> 4). Free-text and
// occasionally absent, so it floors at 1 rather than throwing.
function studioVnum(post) {
  const n = parseInt(String((post && post.version) || 'v1').replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

// PURE. The number of what is on screen RIGHT NOW: the studio's version, or
// the highest board snapshot if reviewers have taken it further. post.js's
// nextVnum() is exactly currentVnum() + 1 — one definition, no drift.
// `versionRows` may be one post's rows or the whole board's; rows belonging to
// another post are ignored.
export function currentVnum(post, versionRows) {
  const id = post && post.id;
  const highest = (Array.isArray(versionRows) ? versionRows : []).reduce((m, r) => {
    if (!r) return m;
    if (id && r.post_id !== undefined && r.post_id !== id) return m;
    const n = Number(r.vnum);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return Math.max(studioVnum(post), highest);
}

// ---- the content fingerprint (migration 022) ----
// A signature must name the exact pixels it blessed, not a version NUMBER:
// numbers proved forgeable two ways (delete the newest sm_post_versions row
// and currentVnum drops back to the signed number; a studio re-render that
// reuses a board vnum swaps the pixels under an unchanged number). So every
// approval row stores contentHash(post) — a fingerprint of the exact
// slides+caption on screen at signing time — inside sm_approvals, which is
// append-only and anon=ar (verified live). Staleness is then a CONTENT
// compare; vnum stays in the row for display only.

// Canonical stringify: sorted object keys, so the hash is independent of key
// order. jsonb re-orders keys server-side; without this, hashing a locally
// built object and hashing the same object read back from PostgREST would
// disagree while the content is identical.
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  const s = JSON.stringify(v);
  return s === undefined ? 'null' : s;
}

// FNV-1a 64-bit over UTF-16 code units (both bytes of each unit, so Hebrew
// participates fully), hex output. NOT cryptographic, deliberately: the table
// it lands in is append-only, so the threat is silent DRIFT, not forgery —
// anyone holding the board key can already INSERT a visible, named row, and
// that boundary is the security model. Sync on purpose: approvalState() is
// PURE and synchronous, and SubtleCrypto would force async on every surface.
function fnv1a64(str) {
  const P = 0x100000001b3n;
  const M = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h ^= BigInt(c & 0xff); h = (h * P) & M;
    h ^= BigInt(c >> 8); h = (h * P) & M;
  }
  return h.toString(16).padStart(16, '0');
}

// PURE. The fingerprint of what is on screen NOW — hash of the canonical
// slides JSON + caption. Same inputs on every surface, same answer.
export function contentHash(post) {
  const slides = Array.isArray(post && post.slides) ? post.slides : [];
  const caption = String((post && post.caption) || '');
  return fnv1a64(canon(slides) + '\n' + canon(caption));
}

// PURE. I2 — the ONLY answer to "is this marketing-approved, and for which
// version". Never infer an approval from sm_posts.stage (I1).
//   no rows                                  -> 'none'
//   newest row action='revoked'              -> 'revoked'
//   signed fingerprint == current content    -> 'fresh'
//   anything else (mismatch OR no fingerprint) -> 'stale'
// A row with no content_hash (pre-022 signature, or an old cached client)
// reads STALE, never fresh: we cannot prove WHAT it signed, and "unprovable"
// must not display as "verified". Those signatures need one honest re-sign.
// Returns {status, latest, vnum} where `vnum` is the CURRENT number (what is
// on screen); the number the signature bound to is `latest.vnum`. That pair is
// exactly what the stale chip needs: «נחתם על v<latest.vnum> — נערך מאז (v<vnum>)».
// `approvalRows` may be one post's rows or the whole board's, in any order.
export function approvalState(post, approvalRows, versionRows) {
  const vnum = currentVnum(post, versionRows);
  const id = post && post.id;
  let latest = null;
  for (const r of (Array.isArray(approvalRows) ? approvalRows : [])) {
    if (!r) continue;
    if (id && r.post_id !== undefined && r.post_id !== id) continue;
    if (!latest || new Date(r.created_at) - new Date(latest.created_at) > 0) latest = r;
  }
  if (!latest) return { status: 'none', latest: null, vnum };
  if (latest.action === 'revoked') return { status: 'revoked', latest, vnum };
  const signed = (typeof latest.content_hash === 'string' && latest.content_hash)
    ? latest.content_hash : null;
  return { status: (signed && signed === contentHash(post)) ? 'fresh' : 'stale', latest, vnum };
}

function approvalRow(action, { post_id, vnum, note }, me) {
  const n = Number(vnum);
  if (!post_id) throw new Error('חסר מזהה פוסט לחתימה');
  if (!Number.isFinite(n)) throw new Error('חסר מספר גרסה לחתימה');
  return {
    post_id,
    action,
    // The DECLARED hat at signing time is part of the audit record — not a
    // permission. Everyone can sign; the role only says which chair they sat in.
    role: getRole() || 'marketing',
    vnum: n,
    note: note || '',
    author: me.name,
    author_id: me.author_id,
  };
}

// I4 — one-directional convenience coupling: signing also moves a post that is
// still in_review/editing into the «מאושר» lane, because a human who just
// signed means it. The reverse is NOT true: a manual stage flip writes no
// approval row, and a stage-approved post without a fresh signature must
// everywhere carry «ללא חתימת שיווק». The stage flip is best-effort — losing
// it must never cost the signature that already landed.
//
// I5 (second half, the SEEN guard) — `expected_hash` is contentHash of what
// was ON SCREEN when the signer opened the modal, captured there and carried
// here. It is REQUIRED, not optional: an optional guard is a guard that the
// next caller forgets, and the failure is silent (a signature that names
// content nobody read). A caller with nothing to declare has no business
// signing.
//
// The old comment here claimed "I5 guarantees the caller flushed before
// calling, so this IS what the signer saw". That was FALSE. Flushing only
// settles the SIGNER's own writes; it says nothing about ANOTHER device. The
// modal can sit open for minutes while the reviewer types a note, and the 10s
// poll adopts remote edits underneath it — so the post read here could be
// content the signer never saw, fingerprinted into a row that then renders as
// a specific, verified-looking claim that they approved exactly that. The
// fingerprint made the bug WORSE than a bare vnum would have, because the
// whole value of the row is that it names exactly what was signed.
//
// So: read the post AFTER the caller's flush, hash it, and compare. Equal ⇒
// the only writes since the modal opened were the signer's own (already inside
// expected_hash) ⇒ sign. Different ⇒ somebody else wrote ⇒ REFUSE with
// e.stale, the same distinguishable-error shape savePostSlides uses for
// e.conflict. Never "sign anyway, it is probably fine".
export async function approvePost({ post_id, vnum, note, expected_hash }) {
  const me = await ensureName();
  if (typeof expected_hash !== 'string' || !/^[0-9a-f]{16}$/.test(expected_hash)) {
    throw new Error('חסרה טביעת התוכן שנחתם — לא חתמנו');
  }
  // The read below has to be a FRESH read, or the guard is decorative.
  // LocalDriver.state() is a client-side cache that only this client's own
  // writes and the 10s poll clear, so without this line the guard compares the
  // signer's screen against a snapshot of the board that is exactly as old as
  // that screen — and passes. Not theory: the first two-profile run of the race
  // test signed through a warm cache and produced a row fingerprinting content
  // the other reviewer had already replaced. LocalDriver.savePostSlides's
  // optimistic guard invalidates first for precisely this reason. SupabaseDriver
  // holds no cache (getPost is a live GET), so this is a no-op there.
  if (isLocal && driver) driver.invalidate();
  // If the post cannot be read, refuse to sign — a signature whose content we
  // could not hash would be exactly the unverifiable row the content
  // fingerprint exists to eliminate.
  const post = await getPost(post_id);
  if (!post) throw new Error('הפוסט לא נמצא — אי אפשר לחתום');
  const live = contentHash(post);
  if (live !== expected_hash) {
    const e = new Error('הפוסט השתנה מאז שנפתח חלון החתימה — החתימה לא נרשמה');
    e.stale = true;              // distinguishable, like savePostSlides' e.conflict
    e.expected_hash = expected_hash;
    e.live_hash = live;
    throw e;
  }
  const row = await need().insertApproval({
    ...approvalRow('approved', { post_id, vnum, note }, me),
    content_hash: live,
  });
  try {
    if (post.stage === 'in_review' || post.stage === 'editing') {
      await setStage(post_id, 'approved');
    }
  } catch (e) {
    console.warn('stage convenience flip failed (the signature itself is saved):', e && e.message);
  }
  return row;
}

// Revocation is an INSERT, never an update — the signature stays in the trail
// and the revocation stands beside it. No stage change: un-approving the lane
// is a human decision, and I1 forbids inferring one from the other.
export async function revokeApproval({ post_id, vnum, note }) {
  const me = await ensureName();
  return need().insertApproval(approvalRow('revoked', { post_id, vnum, note }, me));
}

// one post's approval rows, newest first
export async function listApprovals(post_id) {
  return (await need().listApprovals(post_id)) || [];
}

// EVERY approval row on the board in ONE request — the gallery's
// «ממתינים לאישור שיווק» view and the queue's chips need state for 100+ posts
// and must not fan out per post.
export async function listAllApprovals() {
  return (await need().listAllApprovals()) || [];
}

// ------------------------------------------------ uploaded re-renders (v2.3)
// The SECOND producer of versions (the first is a studio re-render arriving
// through ingest --update && go-live, which needs nothing new). This is for
// finished pixels made outside the studio — an agency file, a designer export.
// Three writes, one trail:
//   1. bytes  -> sm-photos boards/<key>/<post_id>/v<N>/slide-NN-<uuid>.<ext>
//   2. row    -> sm_post_versions with image slides {"image": "<public URL>"}
//   3. live   -> sm_posts.slides = the same slides, so the uploaded version IS
//                what everyone reviews
// The version row is written BEFORE the live post so a failure at step 3 still
// leaves the upload in the trail. compose.js resolves {image} with an early
// return; render.mjs deliberately does NOT learn the shape (an image version is
// final pixels — the factory never re-renders it) and apply-edits --from-board
// skips such posts.

const VERSION_IMAGE_MIME = /^image\/(png|jpeg|jpg|webp)$/i;
const MAX_VERSION_BYTES = 8 * 1024 * 1024;   // the sm-photos bucket cap

// v2.6, STATED SO NOBODY "FIXES" IT LATER: uploadRenderVersion does NOT call
// normalizeImage, and must not. Every other upload path is a source file the
// tool will re-render; a render version is FINISHED PIXELS — the exact frames
// the studio produced and the reviewer signed off on. Resampling them to 2560
// or re-encoding a PNG as JPEG would quietly change the deliverable after
// approval. The 8MB refusal below therefore stays a REFUSAL, loud and by name,
// rather than becoming a silent downscale.

// Natural order, so slide-2.png comes before slide-10.png. A plain sort puts
// 10 first and silently reorders somebody's carousel.
function naturalByName(a, b) {
  return String((a && a.name) || '').localeCompare(
    String((b && b.name) || ''), 'he', { numeric: true, sensitivity: 'base' });
}

export async function uploadRenderVersion({ post_id, files, note }) {
  const list = Array.from(files || []);
  if (!list.length) throw new Error('לא נבחרו קבצים');
  for (const f of list) {
    const fname = (f && f.name) ? String(f.name) : '';
    if (!VERSION_IMAGE_MIME.test((f && f.type) || '')) {
      throw new Error(`אפשר להעלות רק PNG, JPG או WEBP — ${fname}`);
    }
    if (((f && f.size) || 0) > MAX_VERSION_BYTES) {
      throw new Error(`הקובץ חורג מ־8MB — ${fname}`);
    }
  }
  await ensureName();   // ask for the name BEFORE uploading megabytes, not after
  const ordered = [...list].sort(naturalByName);
  const post = await getPost(post_id);
  const vnum = currentVnum(post, await listVersions(post_id)) + 1;

  const d = need();
  const slides = [];
  for (let i = 0; i < ordered.length; i++) {
    slides.push({ image: await d.uploadVersionBytes(ordered[i], post_id, vnum, i) });
  }

  const row = await saveVersion({ post_id, vnum, slides, caption: post.caption || '' });

  // Double-submit guard. Two concurrent uploads both resolve the same target
  // vnum; the unique (board_key, post_id, vnum) index lets exactly one row in
  // and saveVersion's 409 path hands the LOSER the winner's existing row.
  // Every upload mints fresh UUID paths, so two calls can never produce the
  // same slides — if the returned row's slides are not ours, we lost. The
  // loser must NOT touch the live post: its savePostSlides would overwrite
  // the winner's pixels with slides that exist in no version row, and a
  // signature on that vnum would name slides never on screen. Fail loudly
  // instead; the winner's own call makes the live post match its row.
  if (canon(row && row.slides) !== canon(slides)) {
    throw new Error(`מישהו נוסף שמר גרסה v${vnum} באותו רגע — הפוסט מציג את הגרסה שנשמרה ראשונה`);
  }
  // The live post becomes the uploaded pixels. This is the ONE write path that
  // can change how MANY slides a post has, so it is the one that made
  // sm_posts.slide_count lie; savePostSlides now sends slide_count in the same
  // PATCH (migration 023 grants anon the column), so the stored number matches
  // the stored array for every consumer — including the two publishers, which
  // read the column and not the array.
  await savePostSlides(post_id, slides);

  // sm_post_versions has no note column and inventing one is not this
  // package's call, so the operator's note rides an audit sm_edits row —
  // deliberately OUTSIDE the `slides.<i>.<var>` shape learn.mjs categorizes as
  // language. Non-fatal: bookkeeping must never cost an upload that landed.
  if (note) {
    try {
      await logEdit({
        post_id, field: 'version.upload',
        old_text: '', new_text: String(note), vnum,
      });
    } catch (e) {
      console.warn('upload note audit row failed (the version itself is saved):', e && e.message);
    }
  }
  return { vnum: Number(row && row.vnum) || vnum, row };
}

// ------------------------------------------------ asset library (v2.0)
// ONE board-wide library of every photo, logo, illustration and brand mark,
// all of it on the cloud. Two populations behind one list (PLAN «The cloud
// asset library»): reviewer uploads (bytes in sm-photos, `source:'upload'`)
// and the studio's own SVGs (bytes already in sm-assets via ingest → go-live,
// `source:'studio'`, reconciled into rows so one list covers everything).
// A post-scoped upload carries post_id — it shows in that post's תמונות tab
// AND here; a library upload leaves it null.

const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/i;

// Uploaded SVG is markup, and markup we did not author never gets inlined
// into a composed slide (that document is also what render.mjs rasterizes).
// Belt AND braces: strip the executable surface here, and place uploaded
// vectors through <img> only — an <img>-embedded SVG cannot run script even
// if this missed something.
function sanitizeSvg(text) {
  let out = String(text);
  // The DOCTYPE and its internal subset go FIRST. An <!ENTITY> chain is a
  // billion-laughs bomb: ten nested ten-fold entities expand to gigabytes in
  // whatever parses the file next, and we were storing the subset verbatim.
  // Nothing this tool draws needs a DTD, so the whole declaration is dropped
  // rather than filtered — an SVG that only renders via entity expansion is
  // not an asset, it is a payload. (assets.js decodable() rejects the result
  // before it ever gets here, but bytes must not depend on that door.)
  out = out.replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?[^>]*>/gi, '');
  out = out.replace(/<\s*(script|foreignObject)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|foreignObject)\b[^>]*\/\s*>/gi, '');
  // Any attribute whose LOCAL name starts with `on`, whatever the prefix.
  // `\son[a-z]+=` missed `foo:onload=` — a namespaced handler that several
  // parsers still run — and missed hyphenated names outright.
  out = out.replace(/\s(?:[a-z0-9_.\-]+:)?on[a-z\-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
  return out;
}

async function svgFileSafe(file) {
  const clean = sanitizeSvg(await file.text());
  return new File([clean], file.name || 'asset.svg', { type: 'image/svg+xml' });
}

// Best-effort intrinsic size — the library grid and the placement maths both
// want it, but a failure to measure must never block an upload.
function measure(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => done({ width: img.naturalWidth || null, height: img.naturalHeight || null });
    img.onerror = () => done({ width: null, height: null });
    img.src = url;
    setTimeout(() => done({ width: null, height: null }), 4000);
  });
}

function defaultKind(file) {
  return /svg/i.test(file.type || '') ? 'illustration' : 'photo';
}

// every sm_assets row for the board, newest first
export async function listAssets() {
  return (await need().listAssets()) || [];
}

// Upload bytes + create the library row. `post_id` set = uploaded ON a post.
// Returns {url, row} like uploadPhoto, so callers are interchangeable.
export async function uploadAsset({ file, kind, label, tags, post_id }) {
  if (!file) throw new Error('לא נבחר קובץ');
  // v2.6: BEFORE the MIME gate, deliberately. iOS normally transcodes to JPEG
  // at the picker (which is why `accept` excludes HEIC), but a share sheet or
  // a file-manager drop can still hand over a raw HEIC — that used to be
  // refused here as "not an image". normalizeImage turns it into a JPEG the
  // gate accepts.
  //
  // A PDF or a video never reaches its decoder at all (it hands non-raster
  // types straight back) and fails on the next line with the gate message.
  // TIFF/BMP/AVIF are the in-between case: normalizeImage DOES try to decode
  // them, because a browser that can will turn them into a JPEG this bucket
  // takes — and when the decode fails it throws THIS same gate sentence
  // rather than calling the file corrupt. One wording, whichever door refuses.
  file = await normalizeImage(file);
  if (!IMAGE_MIME.test(file.type || '')) {
    throw new Error('אפשר להעלות רק SVG, PNG, JPG או WEBP');
  }
  const me = await ensureName();
  const clean = /svg/i.test(file.type || '') ? await svgFileSafe(file) : file;
  const dim = await measure(clean);
  const row = {
    kind: kind || defaultKind(clean),
    source: 'upload',
    name: clean.name || 'asset',
    mime: clean.type || '',
    width: dim.width, height: dim.height, bytes: clean.size || null,
    label: label || '',
    tags: Array.isArray(tags) ? tags : [],
    post_id: post_id || null,
    author: me.name,
    author_id: me.author_id,
  };
  const dir = post_id || 'library';
  const d = need();
  if (isLocal) {
    const res = await d.uploadAssetFull(clean, dir, row);
    return { url: res.url, row: res.row };
  }
  const storage_path = await d.uploadAssetBytes(clean, dir);
  const saved = await d.insertAsset({ ...row, storage_path });
  return { url: assetRowUrl(saved), row: saved };
}

// Only label + tags are editable from the browser (matching the grant).
export async function updateAsset(id, { label, tags }) {
  const fields = {};
  if (label !== undefined) fields.label = label;
  if (tags !== undefined) fields.tags = Array.isArray(tags) ? tags : [];
  return need().updateAsset(id, fields);
}

// Reconcile the studio's own assets into library rows, idempotent and keyed
// by kind+name (PLAN contract). `entries` is manifest.library — ingest emits
// it, go-live seeds these rows server-side, and this is the browser-side
// catch-up for boards that predate that (and for the local driver).
export async function reconcileStudioAssets(entries) {
  const want = (entries || []).filter((e) => e && e.name && e.storage_path);
  if (!want.length) return [];
  const have = new Set(
    (await listAssets())
      .filter((a) => a.source === 'studio')
      .map((a) => a.kind + ' ' + a.name));
  const missing = want
    .filter((e) => !have.has((e.kind || 'other') + ' ' + e.name))
    .map((e) => ({
      kind: e.kind || 'other',
      source: 'studio',
      name: e.name,
      storage_path: e.storage_path,
      mime: e.mime || 'image/svg+xml',
      label: e.label || '',
      tags: Array.isArray(e.tags) ? e.tags : [],
      post_id: null,
    }));
  if (!missing.length) return [];
  return need().insertStudioAssets(missing);
}

// ---------------------------------------------------------------- subscribe

const subscribers = [];
let notificationsStarted = false;

function notifyAll() {
  if (isLocal && driver) driver.invalidate();
  for (const fn of subscribers) {
    try { fn(); } catch { /* one bad subscriber never blocks the rest */ }
  }
}

export function subscribe(fn) {
  subscribers.push(fn);
  if (!notificationsStarted) {
    notificationsStarted = true;
    need().startNotifications(notifyAll);
  }
}

// ---- generation requests (v2.5, spec 08) ----------------------------------
// «יצירה עם AI»: the therapist writes what they want, this INSERTS a row, and
// that is the entire client half. Nothing here generates anything and nothing
// here can move a request forward — every status change and the whole `result`
// payload are written by scripts/fulfill.mjs under the SERVICE role, on the
// operator's machine, running their Claude subscription (spec 08 «the no-API
// architecture»). Migration 026 makes that a GRANT, not a convention: anon
// holds select + insert on sm_gen_requests and nothing else, so there is
// deliberately no setGenStatus() below to match — a client function that
// cannot exist server-side must not exist here either.
//
// Latency is therefore REAL and must be stated as such in the UI: minutes, and
// only while the factory session is running. create-ai.js says so in words.
// Progress rides the ordinary subscribe() cadence (10s/60s polling); realtime
// delivers nothing to anon subscribers on a header-scoped board.
//
// Supabase table sm_gen_requests; LocalDriver mirrors via serve.mjs /api/gen
// (+ the `gen` array in /api/state).

export const GEN_STATUS_LABELS = {
  queued: 'בתור',
  working: 'נוצר עכשיו',
  done: 'מוכן — בגלריה',
  failed: 'לא הצלחנו',
};

// kind: 'post' | 'campaign' | 'style' | 'export' (the migration's CHECK
// constraint — 'export' arrives with migration 027, spec 10 §D-2).
// The payload shape is the contract documented in scripts/fulfill.mjs.
//
// The whitelist is not decoration: an unknown kind falls back to 'post', and a
// 'post' row with an export payload would be picked up by the fulfiller's post
// pipeline and fail the voice gate on an empty draft. Adding a kind here
// WITHOUT applying 027 is the other half of the trap — the insert is refused by
// the CHECK, which surfaces as a 400 the reviewer cannot act on, so the modal
// that sends 'export' says the migration is a prerequisite out loud.
export async function createGenRequest({ kind, payload }) {
  const me = await ensureName();
  const k = ['post', 'campaign', 'style', 'export'].includes(kind) ? kind : 'post';
  const row = {
    kind: k,
    payload: payload || {},
    author: me.name,
    author_id: me.author_id,
  };
  // status/result are left to their column defaults on purpose: sending
  // status:'queued' from the browser would read as if the client owned the
  // column, and one day someone would send a different value.
  return need().insert(isLocal ? 'gen' : 'sm_gen_requests', row);
}

// The board's requests, newest first. Small table, one request — the status
// list on create-ai.html re-reads it on every subscribe() tick.
export async function listGenRequests() {
  const d = need();
  if (isLocal) return (await d.req('GET', '/gen')) || [];
  return d.select('sm_gen_requests',
    `select=*&board_key=eq.${enc(boardKey)}&order=created_at.desc`);
}

// One request by id (the status card polls this after submitting).
export async function getGenRequest(id) {
  const d = need();
  if (isLocal) {
    const rows = (await d.req('GET', `/gen?id=${enc(id)}`)) || [];
    return rows[0] || null;
  }
  const rows = await d.select('sm_gen_requests',
    `select=*&board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`);
  return (rows && rows[0]) || null;
}

// PURE. The request that produced a given post, if any — post.js's
// «איך זה נוצר» block asks this of the rows it already has, so a post page
// never fans out per-request.
//
// Which row, when several mention the post: the one that BUILT it. A campaign
// revision writes a later row about the same post, but its record carries only
// what CHANGED (a version number, a conflict note) — it never re-records which
// templates and drawings the post is made of, and «איך זה נוצר» is asking
// exactly that. So a row carrying `templates` beats a newer row without one;
// among equals, newest wins. The revision is not lost by this: it is a
// numbered row in the sm_post_versions trail, which is where a change belongs.
export function genRequestForPost(rows, postId) {
  let best = null;
  let bestRich = false;
  for (const r of rows || []) {
    const mine = ((r && r.result && r.result.posts) || [])
      .find((p) => p && p.post_id === postId);
    if (!mine) continue;
    const rich = Array.isArray(mine.templates) && mine.templates.length > 0;
    if (!best
        || (rich && !bestRich)
        || (rich === bestRich && String(r.created_at) > String(best.created_at))) {
      best = r;
      bestRich = rich;
    }
  }
  return best;
}

// PURE. Every campaign this board knows about, newest first —
// {campaign_id, title, posts:[…], created_at, author}. Derived from request
// results rather than stored anywhere: the campaign is not a table, it is what
// the fulfiller recorded, and deriving it means a revision can never disagree
// with the requests that built it.
export function campaignsFrom(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const res = r && r.result;
    const id = res && res.campaign_id;
    if (!id) continue;
    const prev = out.get(id) || { campaign_id: id, posts: [], created_at: r.created_at, author: r.author };
    for (const p of res.posts || []) {
      if (p && p.post_id && !prev.posts.some((q) => q.post_id === p.post_id)) prev.posts.push(p);
    }
    if (String(r.created_at) < String(prev.created_at)) prev.created_at = r.created_at;
    out.set(id, prev);
  }
  return [...out.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

// PURE. The gallery's author shelf (spec 08 §4): every name that authored a
// post on this board, with a count, most posts first. `author` is the only
// identity sm_posts carries — migration 026 deliberately did NOT add an
// author_id column — so this groups by the display name, which is also what
// the shelf shows.
export function authorShelf(posts) {
  const counts = new Map();
  for (const p of posts || []) {
    const a = String((p && p.author) || '').trim();
    if (!a) continue;
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([author, n]) => ({ author, n }))
    .sort((a, b) => b.n - a.n || a.author.localeCompare(b.author));
}

// ---- image generation (v2.5, spec 07) ----
// Everything the «יצירת תמונות» tab needs. app/js/generate.js owns the UI and
// never talks to a backend itself — this section is the whole surface.
//
// TWO BACKENDS, on purpose:
//   · fal.ai work (sheets, photos, tracing, restyle) goes through the
//     `generate` EDGE FUNCTION, because FAL_KEY must never reach the browser.
//     Same shape as callPublisher: cloud only, throws in local mode.
//   · styles and derived-asset rows are ordinary PostgREST writes with the
//     board key, because they carry no secret. sm_styles' anon grant is
//     column-scoped (migration 025) to exactly what updateStyle sends.
//
// MIGRATION 025 IS A FILE, NOT AN APPLIED MIGRATION, as of 2026-08-02. Every
// read here degrades honestly when it is missing rather than throwing an
// opaque error at a therapist: listStyles() returns [] and says so once,
// saveDerivedAsset() drops the lineage columns and saves the asset anyway.
// Losing the trail must never cost someone their picture.

// The dimension presets, twinned with DIMS in supabase/functions/generate/index.ts.
// Keep the KEYS identical — the browser sends the key and the function looks it
// up; a key only one side knows is a refusal the reviewer cannot act on. The
// twin is PROVEN, not promised: scripts/dims-check.mjs diffs this array against
// the shipped bytes of index.ts and exits non-zero on any drift. Run it after
// touching either side.
//
// v2.5.1 (spec 10 §C) grew the list from 4 to 9. Two fields carry the rest of
// §C's contract, and both are DATA, not behaviour:
//
//   legacy  the '<w>x<h>' key this preset shipped under before §C renamed the
//           first four. Nothing in the app writes those keys any more, but an
//           sm_assets row generated before today has one in `derived.crop.dim`
//           and the Edge Function still answers to it — dimByKey() resolves
//           both spellings so no stored value becomes unreadable. A rename that
//           orphans data is a rename that gets reverted at 2am.
//
//   res     the fal resolution enum member a GENERATION at this size should
//           request: the SMALLEST of 0.5K/1K/2K/4K whose long side covers the
//           preset, capped at 4K. "Nearest" in spec §C means nearest-that-does-
//           not-force-an-upscale — rounding DOWN would hand the baker a source
//           smaller than the target and make every large preset a silent
//           enlargement, which is the exact thing §C forbids.
//
//   native  present only where the preset is BIGGER than the model can draw
//           (`6k`: fal's 4K enum tops out near 4096px on the long side). It is
//           the honest ceiling, and generate.js's baker uses the MEASURED source
//           size — not this constant — to decide whether to stamp
//           «הוגדל תוכנתית מ-…» on the asset. The constant tells the operator
//           what to expect BEFORE they spend money; the measurement tells them
//           what actually happened after.
//
// Wiring `res` into the Edge Function's falQueue body is deliberately NOT done
// here: it changes what every generation costs (4K is double 1K per image) and
// belongs to the session that owns the deploy. Until then the function requests
// fal's default resolution and the baker's measured-source chip is what keeps
// the app honest about it.
export const FAL_LONG_SIDE_CAP = 4096;

export const GEN_DIMS = [
  { key: 'post',   legacy: '1080x1350', w: 1080, h: 1350, res: '2K', label: 'פוסט 4:5 · 1080×1350' },
  { key: 'square', legacy: '1080x1080', w: 1080, h: 1080, res: '2K', label: 'ריבוע · 1080×1080' },
  { key: 'story',  legacy: '1080x1920', w: 1080, h: 1920, res: '2K', label: 'סטורי 9:16 · 1080×1920' },
  { key: 'land',   legacy: '1920x1080', w: 1920, h: 1080, res: '2K', label: 'רוחב 16:9 · 1920×1080' },
  { key: 'pres',   w: 1280, h: 720,  res: '2K', label: 'מצגת קטנה · 1280×720' },
  { key: 'wide2k', w: 2560, h: 1440, res: '4K', label: 'מצגת גדולה / באנר · 2560×1440' },
  { key: '4k',     w: 3840, h: 2160, res: '4K', label: '4K · 3840×2160' },
  { key: '6k',     w: 6144, h: 3456, res: '4K', native: { w: 4096, h: 2304 }, label: '6K · 6144×3456 (מעל גבול המודל)' },
  { key: 'a4',     w: 2480, h: 3508, res: '4K', label: 'A4 להדפסה · 2480×3508' },
];

// The ONE lookup. Accepts the §C key or the pre-§C '<w>x<h>' spelling, so a
// value read back out of an old asset row still resolves. Returns null for an
// unknown key — callers decide whether that is «מקורי» or a refusal, and a
// silent fallback to GEN_DIMS[0] would resize someone's file to 1080×1350
// without telling them.
export function dimByKey(key) {
  const k = String(key || '');
  return GEN_DIMS.find((d) => d.key === k) ||
         GEN_DIMS.find((d) => d.legacy === k) ||
         null;
}

// PostgREST answers a missing TABLE with 404 + PGRST205 (and, on some
// versions, SQLSTATE 42P01). That — and only that — is what "the migration is
// not applied yet" looks like from here. Anything else propagates: offline,
// RLS, an expired key and a missing table must not read the same.
function missingTable(e) {
  if (!e) return false;
  const code = String(e.code || '');
  if (code === 'PGRST205' || code === '42P01') return true;
  return e.status === 404 && /does not exist|could not find the table/i.test(String(e.message || ''));
}

let genMigrationReported = false;
function reportGenMigration(what) {
  if (genMigrationReported) return;
  genMigrationReported = true;
  console.error(
    `migration 025 (sm_styles + sm_assets.parent_id/derived) is not applied — ${what}. ` +
    'The generation tab loads in a reduced state: no styles, no derivation trail. ' +
    'Apply migrations/025-sm-styles-and-generated-assets.sql.');
  toast('מיגרציה 025 עדיין לא הוחלה — הסגנונות ושרשרת הגזירה לא זמינות', 'err');
}

/**
 * The `generate` Edge Function. Mirrors callPublisher: the board key is the
 * capability, `operator_key` is a SECOND secret the operator's browser holds
 * (it lifts the function's per-board daily image budget). Cloud only.
 *
 * modes: 'plan' (capability report, touches nothing) | 'illustration' |
 *        'illustration-pick' | 'photo' | 'convert'
 * Pass `dry: true` on any mode to get the exact fal calls back without
 * spending anything, even when the function is live.
 */
export async function callGenerator({ mode = 'plan', operator_key = '', ...payload } = {}) {
  if (isLocal) {
    throw new Error('יצירת תמונות לא זמינה במצב מקומי — היא רצה בענן (Edge Function)');
  }
  const base = String(cfg().supabaseUrl || '').replace(/\/$/, '');
  if (!base) throw new Error('חסר supabaseUrl ב-config.js');
  const res = await fetch(base + '/functions/v1/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // The functions GATEWAY rejects any call without an Authorization
      // header before our code runs («Missing authorization header» — found
      // live on the first real submit after deploy; the builder's cloud path
      // was unexercisable). The publishable key is the right bearer — the
      // same one every REST call sends. The function's OWN auth stays the
      // board key + optional operator key below.
      'Authorization': 'Bearer ' + String(cfg().supabaseAnon || ''),
      'apikey': String(cfg().supabaseAnon || ''),
      'x-board-key': boardKey,
      ...(operator_key ? { 'x-operator-key': operator_key } : {}),
    },
    body: JSON.stringify({ ...payload, mode }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/* ---- styles (sm_styles, migration 025) ---- */

// Oldest FIRST: the seeded house style should sit at the top of the dropdown,
// and created_at.asc is what puts it there.
export async function listStyles() {
  if (isLocal) return [];
  try {
    return (await need().select('sm_styles',
      `select=*&board_key=eq.${enc(boardKey)}&order=created_at.asc`)) || [];
  } catch (e) {
    if (missingTable(e)) { reportGenMigration('listStyles() returned nothing'); return []; }
    throw e;
  }
}

export async function createStyle({ kind, name, prompt_en, notes, refs } = {}) {
  if (isLocal) throw new Error('סגנונות נשמרים בענן בלבד');
  if (!['illustration', 'photo'].includes(kind)) throw new Error('סוג סגנון לא חוקי');
  const clean = String(name || '').trim();
  if (!clean) throw new Error('לסגנון צריך שם');
  const me = await ensureName();
  return need().insert('sm_styles', {
    kind,
    name: clean,
    prompt_en: String(prompt_en || '').trim(),
    notes: String(notes || '').trim(),
    refs: Array.isArray(refs) ? refs : [],
    version: 1,
    archived: false,
    author: me.name,
    author_id: me.author_id,
  });
}

/**
 * Edit a style. `version` is bumped by the CALLER's intent, not silently here:
 * every generated asset records the (style_id, style_version) that produced it,
 * so a wording change that does not move the version makes old assets claim a
 * scaffold that no longer exists. generate.js bumps whenever prompt_en changes
 * and leaves it alone for a rename or a note.
 *
 * Only the columns in migration 025's `grant update (…)` list are sendable —
 * PostgREST rejects the WHOLE statement if one column falls outside the grant
 * (probed live on sm_posts: 401 `42501 permission denied for table`), so this
 * filters rather than trusting the caller and half-saving.
 */
const STYLE_EDITABLE = ['name', 'prompt_en', 'notes', 'refs', 'version', 'archived'];
export async function updateStyle(id, fields = {}) {
  if (isLocal) throw new Error('סגנונות נשמרים בענן בלבד');
  const patch = {};
  for (const k of STYLE_EDITABLE) if (fields[k] !== undefined) patch[k] = fields[k];
  if (!Object.keys(patch).length) throw new Error('אין מה לעדכן');
  return need().update('sm_styles',
    `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, patch);
}

// There is no DELETE grant and no DELETE policy on sm_styles, deliberately: a
// style id is stamped into the `derived` of every asset it produced, so
// deleting one would orphan history. Archiving takes it out of the dropdown.
export function archiveStyle(id, archived = true) {
  return updateStyle(id, { archived: !!archived });
}

/**
 * «יצירת סגנון מרפרנסים» — deriving a prompt scaffold from a Pinterest board or
 * screenshots is a VISION task, and spec 07 routes it through the generation
 * request queue rather than an Edge Function: the request queues, the
 * operator's local Claude session reads the references and writes the style row.
 * That keeps vision + prompt-craft inside the factory where the voice gate is.
 *
 * WIRED, PENDING 08. This delegates to createGenRequest() above — spec 08 owns
 * `sm_gen_requests` and migration 026, and two writers of one table with two
 * payload shapes is exactly the drift both specs exist to avoid. Migration 026
 * is also a file only right now, so a missing table is turned into a
 * distinguishable `err.pending08` the UI states in words instead of a stack
 * trace. Nothing here creates that table.
 */
export async function requestStyleFromRefs({ kind, name, notes, refs } = {}) {
  if (isLocal) throw new Error('בקשות סגנון נשמרות בענן בלבד');
  try {
    return await createGenRequest({
      kind: 'style',
      payload: {
        style_kind: kind,
        name: String(name || '').trim(),
        notes: String(notes || '').trim(),
        refs: Array.isArray(refs) ? refs : [],
      },
    });
  } catch (e) {
    if (missingTable(e)) {
      const err = new Error('תור הבקשות עדיין לא הותקן בשרת (מיגרציה 026) — הסגנון לא נשמר');
      err.pending08 = true;
      throw err;
    }
    throw e;
  }
}

/* ---- derived assets (client-baked crops, fades, and anything downstream) ---- */

/**
 * Save an asset the BROWSER produced from another asset — the exact-pixel crop
 * and the feathered edge fade that generate.js bakes on <canvas>.
 *
 * Why the browser and not the Edge Function: a fade is a deterministic alpha
 * mask, so asking fal for one would cost money for a result canvas gives away,
 * and it would not be re-derivable afterwards. The recipe rides in `derived`
 * so the fade can be changed or removed later by re-baking from `parent_id` —
 * which is also why the unfaded original stays in the library rather than
 * being replaced by its faded child.
 *
 * NOTHING HERE TOUCHES THE COMPOSE PATH. The fade is baked into the PNG's own
 * alpha channel, so the result is an ordinary photo as far as compose.js and
 * render.mjs are concerned. The twin PARITY BLOCK is not involved, gains no
 * new extra type, and must not.
 */
export async function saveDerivedAsset({ file, kind, label, tags, post_id, parent_id, derived } = {}) {
  if (!file) throw new Error('לא נוצר קובץ');
  const me = await ensureName();
  const dim = await measure(file);
  const base = {
    kind: kind || 'photo',
    source: 'generated',
    name: file.name || 'derived.png',
    mime: file.type || 'image/png',
    width: dim.width, height: dim.height, bytes: file.size || null,
    label: label || '',
    tags: Array.isArray(tags) ? tags : [],
    post_id: post_id || null,
    author: me.name,
    author_id: me.author_id,
  };
  const dir = post_id || 'library';
  const d = need();
  if (isLocal) {
    // The local mirror has no lineage columns; it still stores the bytes, so
    // the canvas bake is exercisable offline.
    const res = await d.uploadAssetFull(file, dir, base);
    return { url: res.url, row: res.row };
  }
  const storage_path = await d.uploadAssetBytes(file, dir);
  const full = { ...base, storage_path, parent_id: parent_id || null, derived: derived || null };
  try {
    const saved = await d.insertAsset(full);
    return { url: assetRowUrl(saved), row: saved };
  } catch (e) {
    // 42703 on parent_id/derived means migration 025 is unapplied. The bytes are
    // already uploaded and the reviewer's work is real — save the asset without
    // its lineage and SAY SO, rather than losing a picture over bookkeeping.
    const missing = undefinedColumnName(e);
    if (missing === 'parent_id' || missing === 'derived') {
      reportGenMigration('the asset was saved WITHOUT its derivation trail');
      const saved = await d.insertAsset({ ...base, storage_path });
      return { url: assetRowUrl(saved), row: saved, lineage_dropped: true };
    }
    throw e;
  }
}

/**
 * PURE. The derivation chain around one asset: everything it came from, and
 * everything that came from it.
 *
 *   assetChain(rows, id) -> { node, ancestors: [root … parent], descendants: [ … ] }
 *
 * `ancestors` is ordered root-first so the UI reads left-to-right as a history
 * (original photo → restyled raster → traced drawing). `descendants` is
 * breadth-first. Both walks are cycle-guarded: `parent_id` is a self-reference
 * and a hand-edited row could point at itself.
 */
export function assetChain(rows, id) {
  const byId = new Map((rows || []).map((a) => [a.id, a]));
  const node = byId.get(id) || null;
  const ancestors = [];
  const seen = new Set([id]);
  let cur = node;
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    const parent = byId.get(cur.parent_id);
    if (!parent) break;
    ancestors.unshift(parent);
    cur = parent;
  }
  const kids = new Map();
  for (const a of rows || []) {
    if (!a.parent_id) continue;
    if (!kids.has(a.parent_id)) kids.set(a.parent_id, []);
    kids.get(a.parent_id).push(a);
  }
  const descendants = [];
  const queue = [id];
  const walked = new Set([id]);
  while (queue.length) {
    for (const child of kids.get(queue.shift()) || []) {
      if (walked.has(child.id)) continue;
      walked.add(child.id);
      descendants.push(child);
      queue.push(child.id);
    }
  }
  return { node, ancestors, descendants };
}
