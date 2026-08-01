// store.js — the ONLY module that talks to a backend (PLAN contract).
// Two drivers behind one API:
//   SupabaseDriver — PostgREST + storage + realtime, x-board-key capability header
//   LocalDriver    — REST to scripts/serve.mjs on http://localhost:8907 (?local=1)
// All functions are async and throw Error(message) on failure.

import { el, modal, injectFonts } from './ui.js';

const LS = { board: 'smr:board', name: 'smr:name', aid: 'smr:aid', bname: 'smr:bname' };
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

// ---------------------------------------------------------------- init

export async function initStore() {
  const params = new URLSearchParams(location.search);
  isLocal = params.get('local') === '1';
  let board = params.get('board') || '';

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
// source='studio' rows point INTO the sm-assets board mirror (the same base
// assetUrl() serves), reviewer uploads live in sm-photos exactly like
// sm_photos rows. Both drivers, one function — nothing else resolves assets.
export function assetRowUrl(row) {
  if (!row || !row.storage_path) return '';
  if (row.source === 'studio') return assetUrl(row.storage_path);
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
    if (!res.ok) throw new Error(await errText(res));
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
  async savePostSlides(post_id, slides, expected_updated_at, me) {
    let filter = `board_key=eq.${enc(this.board)}&id=eq.${enc(post_id)}`;
    if (expected_updated_at) filter += `&updated_at=eq.${enc(expected_updated_at)}`;
    const row = await this.update('sm_posts', filter, { slides, updated_by: me.name });
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
      const tables = ['sm_posts', 'sm_votes', 'sm_pins', 'sm_replies', 'sm_edits',
                      'sm_publish', 'sm_post_versions', 'sm_assets'];
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
    return this.patch('posts', post_id, { slides, updated_by: me.name });
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

  startNotifications(fire) {
    this.pollTimer = setInterval(() => { this.invalidate(); fire(); }, 10000);
  }
}

// ---------------------------------------------------------------- reads

function byCreatedAsc(a, b) {
  return new Date(a.created_at) - new Date(b.created_at);
}

export async function listPosts() {
  const d = need();
  if (isLocal) {
    const s = await d.state();
    return [...(s.posts || [])].sort((a, b) => (a.sort - b.sort) || String(a.id).localeCompare(b.id));
  }
  return d.select('sm_posts', `select=*&board_key=eq.${enc(boardKey)}&order=sort.asc,id.asc`);
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

export async function castVote({ post_id, vote, reason }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'votes' : 'sm_votes', {
    post_id, vote,
    reason: reason || '',
    author: me.name,
    author_id: me.author_id,
  });
}

export async function addPin({ post_id, slide, x, y, body }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'pins' : 'sm_pins', {
    post_id,
    slide: slide || 0,
    x, y,
    body: body || '',
    author: me.name,
    author_id: me.author_id,
    status: 'open',
  });
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
export async function logEdit({ post_id, field, old_text, new_text }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'edits' : 'sm_edits', {
    post_id, field,
    old_text: old_text || '',
    new_text: new_text || '',
    author: me.name,
    author_id: me.author_id,
    status: 'applied',
  });
}

// Kept for backward compatibility (older flows / external tools). The post
// page no longer proposes — it writes directly via savePostSlides + logEdit.
export async function proposeEdit({ post_id, field, old_text, new_text }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'edits' : 'sm_edits', {
    post_id, field,
    old_text: old_text || '',
    new_text: new_text || '',
    author: me.name,
    author_id: me.author_id,
    status: 'proposed',
  });
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

export async function createBuilderPost({ id, title, caption, slides, slide_count }) {
  const me = await ensureName();
  return need().insert(isLocal ? 'posts' : 'sm_posts', {
    id,
    title: title || '',
    caption: caption || '',
    slides: slides || [],
    slide_count: slide_count || (slides ? slides.length : 0),
    category: 'builder',
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
  out = out.replace(/<\s*(script|foreignObject)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  out = out.replace(/<\s*(script|foreignObject)\b[^>]*\/\s*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
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
