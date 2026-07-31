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

  async fetchBoardName() {
    const rows = await this.select('sm_boards', `select=name&board_key=eq.${enc(this.board)}`);
    return rows && rows[0] ? rows[0].name : '';
  }

  async uploadPhoto({ post_id, pin_id, file, note }, me) {
    const rawExt = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : '';
    const ext = (rawExt.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)) ||
      ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[file.type] || 'jpg');
    const path = `boards/${this.board}/${post_id}/${crypto.randomUUID()}.${ext}`;
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
      const tables = ['sm_posts', 'sm_votes', 'sm_pins', 'sm_replies', 'sm_edits', 'sm_publish'];
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

export async function uploadPhoto({ post_id, pin_id, file, note }) {
  const me = await ensureName();
  return need().uploadPhoto({ post_id, pin_id, file, note }, me);
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

export async function setQueueStatus(id, status) {
  const me = await ensureName();
  const d = need();
  if (isLocal) return d.patch('publish', id, { status, updated_by: me.name });
  return d.update('sm_publish', `board_key=eq.${enc(boardKey)}&id=eq.${enc(id)}`, { status, updated_by: me.name });
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
