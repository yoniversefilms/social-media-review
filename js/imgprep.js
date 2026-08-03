// imgprep.js — phone-proofing for every file that enters the tool (v2.6).
// Owner: upload path. Contract: PLAN.md «Phone-proof uploads».
//
// WHY THIS IS ITS OWN DEPENDENCY-FREE MODULE
// ------------------------------------------
// Same reason as stacks.js: it imports NOTHING (not store.js, not ui.js) and
// touches no page DOM beyond a throwaway <canvas>. store.js calls it, and so
// do three page modules; if it lived in store.js the page modules could not
// snapshot files without pulling the whole backend client into scope, and if
// it lived in a page module store.js would import a page. It is pure input →
// File, so it is also the one piece of the upload path that can be reasoned
// about (and later tested) without a board.
//
// THE TWO PROBLEMS IT SOLVES
// --------------------------
// 1. STALE PICKER FILES. A `File` from the iOS photo picker is not bytes on
//    disk — it is a promise of a HEIC→JPEG transcode that WebKit materializes
//    lazily. The old pipeline read each picked File several times (a decode
//    probe, then a measure, then the upload body), sequentially, and cleared
//    `input.value` the instant the change handler returned. On cellular that
//    is minutes between the pick and the second read, and the later reads come
//    back empty or throw: of a multi-select exactly the FIRST file survived.
//    The only reliable window is immediately at selection, so snapshotFiles()
//    copies every picked File's bytes into a real in-memory File once, up
//    front, before anything else touches them.
// 2. FILES THE BUCKET REFUSES. sm-photos caps an object at 8MB (schema §17)
//    and nothing downscaled client-side, so a 48MP phone photo failed no
//    matter how healthy its bytes were. normalizeImage() re-encodes those —
//    and only those — to something the bucket takes.
//
// NEITHER STEP EVER DROPS A FILE SILENTLY. snapshotFiles reports what it could
// not read, by name; normalizeImage throws in Hebrew. A reviewer who picked
// nine photos and got eight must be told which one, or the tool has lied.

// Headroom under the bucket's 8MB: the base64 the local driver posts and the
// multipart framing Supabase adds are both bigger than the file itself, and a
// re-encode that lands at 7.99MB would fail for reasons nobody could see.
export const MAX_UPLOAD_BYTES = 7.5 * 1024 * 1024;

// Slides are 1080×1350. 2560 on the long edge keeps better than 2× density for
// a crop or a zoom and still divides a 48MP photo down to a few hundred KB.
export const MAX_EDGE = 2560;

const JPEG_Q = 0.85;
const JPEG_Q_FALLBACK = 0.7;

// The FIRST canvas a decode is drawn into never exceeds this on its long edge.
// 4096² = 16.7M px, which is the area cap iOS Safari enforces on a canvas
// backing store. Past it the allocation SUCCEEDS and the canvas is silently
// blank — and because the small output canvas downstream still encodes fine,
// the toBlob-null guard never fires and a solid-white JPEG uploads with no
// error anywhere. A 24MP phone photo is 24.5M px, so this was reachable with
// an ordinary photo, not just a hostile one.
const FIRST_DRAW_MAX_EDGE = 4096;

// What normalizeImage is willing to re-encode. Anything else is handed back
// untouched so the CALLER's own gate is the thing that speaks — uploadAsset
// refusing a PDF with «אפשר להעלות רק SVG, PNG, JPG או WEBP» is a better
// error than a decode failure from here.
const RASTER_MIME = /^image\/(png|jpe?g|webp|avif|bmp|tiff?)$/i;

// The types every target browser can actually DECODE. Deliberately narrower
// than RASTER_MIME: TIFF/BMP/AVIF are worth ATTEMPTING (a browser that decodes
// them turns them into a JPEG the bucket takes), but when one of them fails it
// failed because the format is not supported, not because the file is broken —
// and the reviewer needs to be told which. Mirrors store.js's IMAGE_MIME minus
// svg+xml, which never reaches the decoder.
const CORE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

// The types this tool ACCEPTS at all — CORE_MIME plus svg+xml, i.e. store.js's
// IMAGE_MIME exactly. Callers that run their own decode/parse probe use it to
// pick the right refusal: a probe saying no about a PNG means the bytes are
// broken, and a probe saying no about a TIFF means the format was never on the
// list. Same question, asked in one place, so the dock and store.js cannot
// give a reviewer two different explanations for one file.
const ACCEPTED_MIME = /^image\/(png|jpe?g|webp|gif|svg\+xml)$/i;

export function isAcceptedImageType(file) {
  return ACCEPTED_MIME.test(typeOf(file));
}
const HEIC_MIME = /^image\/hei[cf]/i;
const SVG_MIME = /svg/i;
const GIF_MIME = /^image\/gif$/i;

// Some Android pickers and some drops hand over a File with an EMPTY type.
// Falling back to the extension keeps those on the normal path instead of
// quietly skipping them.
const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic', heif: 'image/heif',
  avif: 'image/avif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// The type we should REASON about, which is not always the type the File
// carries.
function typeOf(file) {
  const t = String((file && file.type) || '');
  if (t) return t;
  return EXT_MIME[extOf(file && file.name)] || '';
}

function renameExt(name, ext) {
  const base = String(name || 'image').replace(/\.[^.]+$/, '') || 'image';
  return `${base}.${ext}`;
}

/* ── 1. snapshot ─────────────────────────────────────────────────────────── */

// The ONE reason a read failure ever reports. `arrayBuffer()` rejects with a
// DOMException whose message is English prose from the platform — "The
// requested file could not be read, typically due to permission problems that
// have occurred after a reference to a file was acquired." Surfacing
// `e.message` put that sentence, 138 times, in front of a Hebrew-speaking
// therapist. The cause is always the same thing (the file went away between
// the pick and the read), so it gets one sentence that says what to do.
const READ_FAILED_HE = 'לא ניתן לקרוא את הקובץ מהמכשיר, כדאי לנסות שוב';

// A batch cap for the callers that had none. The assets dock has always had
// its own (200 files / 400MB, refused with a modal); the post page's תמונות
// tab and the generate pickers had nothing at all, so a 200-photo phone
// selection tried to hold 1.6GB of snapshots in the tab. Checked BEFORE the
// snapshot, because the whole point is not to copy the bytes.
export const MAX_BATCH_FILES = 60;
export const MAX_BATCH_BYTES = 400 * 1024 * 1024;

// '' when the batch is fine, otherwise the Hebrew refusal to show.
export function batchTooBig(files) {
  const list = Array.from(files || []);
  const bytes = list.reduce((n, f) => n + ((f && f.size) || 0), 0);
  if (list.length <= MAX_BATCH_FILES && bytes <= MAX_BATCH_BYTES) return '';
  const mb = Math.round(bytes / (1024 * 1024));
  return `אפשר להעלות עד ${MAX_BATCH_FILES} קבצים ועד 400MB בפעם אחת. כאן נבחרו ${list.length} קבצים בנפח ${mb}MB, ולא הועלה כלום`;
}

// One line for a whole batch of failures, instead of one toast per file.
// Names first (that is what lets someone re-pick exactly those), capped at
// five so the line stays readable, then an honest count of the rest.
export function summarizeFailures(failed, max = 5) {
  const list = Array.from(failed || []);
  if (!list.length) return '';
  const names = list.slice(0, max).map((f) => (f && f.name) || '(ללא שם)').join(', ');
  const rest = list.length - Math.min(max, list.length);
  const tail = rest > 0 ? ` ועוד ${rest}` : '';
  const why = list[0] && list[0].reason ? ` (${list[0].reason})` : '';
  return `${list.length} קבצים לא עלו: ${names}${tail}${why}`;
}

// Copy the bytes of every picked File, in order, RIGHT NOW.
// Returns {ok: File[], failed: [{name, reason}]}. Call it as the first
// statement of a change/drop handler — before any await that is not this one,
// and before clearing `input.value`.
export async function snapshotFiles(files) {
  const items = Array.from(files || []).map((f) => ({ file: f, path: (f && f.name) || '' }));
  const snap = await snapshotItems(items);
  return { ok: snap.ok.map((it) => it.file), failed: snap.failed };
}

// The {file, path} form the folder walk uses (assets.js keeps each file's
// position inside the drop, and losing that would lose the folder tags). Same
// contract, same order; snapshotFiles() is the plain-File wrapper over it.
export async function snapshotItems(items) {
  const list = Array.from(items || []);
  const ok = [];
  const failed = [];
  for (const it of list) {
    const name = (it && it.path) || (it && it.file && it.file.name) || '(ללא שם)';
    const f = it && it.file;
    if (!f) {
      failed.push({ name, reason: (it && it.error) || 'לא ניתן לקרוא את הקובץ' });
      continue;
    }
    try {
      const buf = await f.arrayBuffer();
      // A transcode temp that has already gone stale reads as ZERO bytes
      // rather than throwing. Uploaded, it becomes a permanently broken
      // thumbnail, so it has to fail here instead — same cause, same reason.
      if (!buf || !buf.byteLength) throw new Error('empty');
      ok.push({
        file: new File([buf], f.name || 'image', {
          type: f.type || typeOf(f) || 'application/octet-stream',
          lastModified: f.lastModified || Date.now(),
        }),
        path: (it && it.path) || f.name || 'image',
      });
    } catch {
      // Deliberately NOT `e.message`: see READ_FAILED_HE above.
      failed.push({ name, reason: READ_FAILED_HE });
    }
  }
  return { ok, failed };
}

/* ── 2. normalize ────────────────────────────────────────────────────────── */

// Decode to something drawable. createImageBitmap is the fast path AND the one
// that can be told to honour EXIF orientation — without `from-image` a photo
// shot in portrait re-encodes on its side, which is a silent corruption. The
// <img> fallback exists because Safari refused createImageBitmap on some
// blobs for years and an objectURL <img> has always worked.
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bmp && bmp.width) return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close && bmp.close() };
    } catch { /* fall through to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((ok, no) => {
      img.onload = ok;
      img.onerror = () => no(new Error('decode'));
      img.src = url;
    });
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (!w || !h) throw new Error('decode');
    return { src: img, w, h, close: () => {} };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}

function canvasBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(
    (b) => (b ? resolve(b) : reject(new Error('הקידוד של התמונה נכשל'))),
    mime, quality));
}

function ctxOf(c) {
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

// Multi-step downscale, ending at exactly w×h with alpha preserved.
//
// THE FIRST DRAW IS ALREADY DOWNSCALED, and that is the whole point. The
// obvious implementation allocates a canvas at SOURCE dimensions, draws 1:1,
// and only then starts halving — but a canvas over the device's area budget
// does not throw. It allocates, stays BLANK, and every downstream step keeps
// working on those blank pixels; the small output canvas encodes without
// complaint, so the toBlob-null guard never fires and a solid-white JPEG
// uploads with no error anywhere. A 24MP phone photo (24.5M px) is already
// past iOS Safari's ~16.7M px cap, so this was an everyday photo away, not a
// hostile file. The first canvas is therefore capped at FIRST_DRAW_MAX_EDGE
// and never exceeds half the source: the decoded bitmap is resampled straight
// into it in one go, which is what the decoder is good at.
//
// After that, halving until within 2× of the target still matters —
// drawImage's filter is a box filter good to about 2:1, and a 4096px canvas
// taken to 2560 in one step is fine while 8192→2560 would alias.
// (Same reasoning as the export resampler in assets.js, deliberately NOT
// shared: that one centre-crops to an aspect preset, and this one must never
// crop a reviewer's photo.)
function scaleToCanvas(src, sw, sh, w, h) {
  const srcLong = Math.max(sw, sh);
  const tgtLong = Math.max(w, h);
  // max(target, min(ceil(src/2), 4096)), then clamped so we can never UPSCALE
  // into the first canvas (when nothing needs shrinking, target === source).
  const firstLong = Math.min(srcLong,
    Math.max(tgtLong, Math.min(Math.ceil(srcLong / 2), FIRST_DRAW_MAX_EDGE)));
  const k = firstLong / srcLong;

  let cur = document.createElement('canvas');
  cur.width = Math.max(1, Math.round(sw * k));
  cur.height = Math.max(1, Math.round(sh * k));
  ctxOf(cur).drawImage(src, 0, 0, cur.width, cur.height);

  while (cur.width >= w * 2 && cur.height >= h * 2) {
    const next = document.createElement('canvas');
    next.width = Math.max(w, Math.round(cur.width / 2));
    next.height = Math.max(h, Math.round(cur.height / 2));
    ctxOf(next).drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
  }
  if (cur.width === w && cur.height === h) return cur;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  ctxOf(out).drawImage(cur, 0, 0, w, h);
  return out;
}

// JPEG has no alpha: without a white ground every transparent pixel encodes as
// BLACK and a PNG with a cut-out background comes back as a black rectangle.
// A separate small canvas at TARGET size, so the alpha-preserving version
// stays available for the PNG branch and neither is ever source-sized.
function flattened(canvas) {
  const out = document.createElement('canvas');
  out.width = canvas.width; out.height = canvas.height;
  const ctx = ctxOf(out);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

// Will normalizeImage() decode this file anyway?
//
// Callers that run their OWN decode probe (assets.js decodable(), which exists
// to catch bytes that are not the image their extension claims) can skip it
// when the answer is yes: normalizeImage's decode fails with the same Hebrew
// error a moment later, so the probe only costs a second full decode of the
// same file. On a 54MB JPEG that is a real freeze, not a micro-optimisation.
// The rule lives HERE, mirroring normalizeImage's own branching, so the
// threshold is never written down twice.
// Scoped to the two cases where the probe actually HURTS: a file past the
// upload cap (the 54MB phone JPEG, where a second full decode is a visible
// freeze) and HEIC, which the probe cannot decode in Chrome anyway and would
// wrongly call corrupt. An ordinary in-budget photo keeps its probe, and with
// it decodable()'s more specific «הקובץ פגום או אינו תמונה תקינה» — the probe
// knows the bytes are not an image, normalizeImage only knows its decoder
// said no.
export function normalizeWillDecode(file) {
  if (!file) return false;
  const type = typeOf(file);
  if (SVG_MIME.test(type)) return false;   // markup: never decoded, always probed
  if (GIF_MIME.test(type)) return false;   // returned as-is or refused, never decoded
  const isHeic = HEIC_MIME.test(type) || ['heic', 'heif'].includes(extOf(file.name));
  if (!isHeic && !RASTER_MIME.test(type)) return false;   // handed back untouched
  return isHeic || (file.size || 0) > MAX_UPLOAD_BYTES;
}

// Returns a browser-safe, bucket-safe File. The ORIGINAL bytes are returned
// unchanged whenever they are already fine — re-encoding a file that did not
// need it would cost a generation of JPEG loss for nothing.
export async function normalizeImage(file) {
  if (!file) return file;
  const type = typeOf(file);
  const bytes = file.size || 0;

  // SVG is markup, not pixels. Sanitization stays where it is (store.js) and
  // there is nothing here to resample.
  if (SVG_MIME.test(type)) return file;

  // A GIF is re-encodable only by throwing its animation away, and a silently
  // still "animation" is worse than a refusal the reviewer can act on.
  if (GIF_MIME.test(type)) {
    if (bytes <= MAX_UPLOAD_BYTES) return file;
    throw new Error('קובץ GIF גדול מדי להעלאה. אי אפשר להקטין אותו בלי לאבד את האנימציה, אז כדאי להעלות גרסה קלה יותר');
  }

  const isHeic = HEIC_MIME.test(type) || ['heic', 'heif'].includes(extOf(file.name));
  if (!isHeic && !RASTER_MIME.test(type)) return file;   // not ours: let the caller's gate speak

  let dec;
  try {
    dec = await decode(file);
  } catch {
    // WHICH failure this was matters. A PNG that will not decode is a broken
    // file; a TIFF that will not decode is a format this tool never took, and
    // telling its owner the file is corrupt sends them off to re-export
    // something that was fine. Same gate wording store.js uses, so the two
    // doors give one answer.
    throw new Error(CORE_MIME.test(type)
      ? 'לא ניתן לקרוא את התמונה (אולי פורמט לא נתמך)'
      : 'אפשר להעלות רק SVG, PNG, JPG או WEBP');
  }

  const { src, w, h } = dec;
  const long = Math.max(w, h);
  const needsScale = long > MAX_EDGE;
  const needsShrink = bytes > MAX_UPLOAD_BYTES;
  // The decode above happens even when nothing needs doing, and that is on
  // purpose: the LONG EDGE is not knowable without it, and a 3024×4032 iPhone
  // photo that happens to compress to 3MB still has to come down to 2560.
  if (!isHeic && !needsScale && !needsShrink) { dec.close(); return file; }

  const scale = needsScale ? MAX_EDGE / long : 1;
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));

  // ONE draw, then every encoding attempt reads that canvas. The old code
  // re-ran the whole scale chain per attempt (up to three times from the
  // source bitmap), which is also why the bitmap could not be released early.
  const scaled = scaleToCanvas(src, w, h, tw, th);
  dec.close();          // the decoded bitmap has been consumed; let it go now
  let flat = null;
  const asJpeg = (q) => canvasBlob(flat || (flat = flattened(scaled)), 'image/jpeg', q);

  // PNG stays PNG — it is the format someone chose for a logo or a cut-out, and
  // JPEG would eat the transparency. Only a PNG that is STILL over the cap
  // after the downscale gets converted, because at that point the choice is
  // between a JPEG and no upload at all.
  const keepPng = /png/i.test(type);
  let mime = keepPng ? 'image/png' : 'image/jpeg';
  let out = keepPng ? await canvasBlob(scaled, 'image/png') : await asJpeg(JPEG_Q);
  if (out.size > MAX_UPLOAD_BYTES && keepPng) {
    out = await asJpeg(JPEG_Q);
    mime = 'image/jpeg';
  }
  if (out.size > MAX_UPLOAD_BYTES) {
    out = await asJpeg(JPEG_Q_FALLBACK);
    mime = 'image/jpeg';
  }

  if (out.size > MAX_UPLOAD_BYTES) {
    throw new Error('התמונה גדולה מדי גם אחרי הקטנה. כדאי לייצא אותה קטנה יותר ולנסות שוב');
  }

  // The extension has to follow the bytes. A HEIC re-encoded to JPEG but still
  // called `IMG_1587.heic` fails every extension-based sniff downstream — the
  // storage path builder, the MIME gate, and whatever opens it later.
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  return new File([out], renameExt(file.name, ext), { type: mime, lastModified: Date.now() });
}
