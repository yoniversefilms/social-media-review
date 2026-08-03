// zip.js — a minimal STORE-method zip writer (spec 10 §D-1).
// Owner: asset-library module. No dependencies, no build step, no vendored
// library.
//
// WHY STORE AND NOT DEFLATE. Everything this tool zips is already-compressed
// pixels (PNG / JPEG / WEBP) plus the odd SVG. Deflating a JPEG buys ~0-2%
// and costs a compressor. STORE (method 0) means the entry bytes are written
// verbatim, so the whole writer is headers + CRC32 — ~70 lines instead of a
// vendored JSZip.
//
// WHAT IT IS NOT. No ZIP64: an archive is refused above 4 GB total or with an
// entry above 4 GB, loudly, rather than emitting a file that some readers open
// and others silently truncate. No encryption, no directory entries (folders
// are implied by `/` in names, which every extractor honours), no data
// descriptors (sizes are known before the header is written, because we hold
// the bytes).
//
// Verified against `unzip -t` and macOS Archive Utility.

const U8 = (b) => b instanceof Uint8Array ? b : new Uint8Array(b);

// CRC32 (IEEE 802.3, the polynomial every zip uses), table-driven.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// MS-DOS packed date/time — the only timestamp a base zip record carries.
// Seconds have 2-second resolution by format; the year floor is 1980.
function dosStamp(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const MAX = 0xFFFFFFFF;   // the 32-bit fields; above this you need ZIP64

/**
 * Build a zip Blob from `[{name, data}]`.
 * `data` may be a Blob, ArrayBuffer, or Uint8Array. `name` may contain `/`
 * for folders and non-ASCII characters (flag bit 11 marks the name UTF-8, so
 * Hebrew filenames survive the round trip).
 */
export async function zipStore(entries, { when = new Date() } = {}) {
  const { time, date } = dosStamp(when);
  const enc = new TextEncoder();
  const parts = [];        // the file body, in order
  const central = [];      // central-directory records, built as we go
  let offset = 0;

  for (const e of entries) {
    const bytes = e.data instanceof Blob ? U8(await e.data.arrayBuffer()) : U8(e.data);
    if (bytes.length > MAX) throw new Error(`הקובץ ${e.name} גדול מדי לארכיון (מעל 4GB)`);
    const name = enc.encode(String(e.name));
    const crc = crc32(bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header signature
    local.setUint16(4, 20, true);           // version needed: 2.0
    local.setUint16(6, 0x0800, true);       // flags: bit 11 = UTF-8 name
    local.setUint16(8, 0, true);            // method 0 = STORE
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);  // compressed size
    local.setUint32(22, bytes.length, true);  // uncompressed size
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);             // extra field length
    parts.push(new Uint8Array(local.buffer), name, bytes);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);     // central file header signature
    cen.setUint16(4, 20, true);             // version made by
    cen.setUint16(6, 20, true);             // version needed
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, time, true);
    cen.setUint16(14, date, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, name.length, true);
    // 30 extra len, 32 comment len, 34 disk number, 36 internal attrs — all 0
    cen.setUint32(38, 0, true);             // external attrs
    cen.setUint32(42, offset, true);        // offset of the local header
    central.push(new Uint8Array(cen.buffer), name);

    offset += 30 + name.length + bytes.length;
    if (offset > MAX) throw new Error('הארכיון חורג מ־4GB — ייצאו פחות נכסים בבת אחת');
  }

  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, entries.length, true);   // entries on this disk
  end.setUint16(10, entries.length, true);  // entries total
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);          // where the central directory starts
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)],
    { type: 'application/zip' });
}
