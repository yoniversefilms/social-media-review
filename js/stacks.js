// stacks.js — version STACKS for generated illustrations (v2.5.2).
// Owner: shared by editor.js (the «ספריית נכסים» picker) and assets.js (the
// «AI Generated» tab). Contract: PLAN.md «fal inside the content pipeline».
//
// WHY A THIRD MODULE INSTEAD OF EXPORTING THIS FROM assets.js
// -----------------------------------------------------------
// There is no import CYCLE today (assets.js does not import editor.js), so a
// naive `import {groupStacks} from './assets.js'` inside editor.js would in
// fact load. It would also drag store.js and zip.js into every editor host as
// a transitive dependency, and editor.js's whole architectural promise — top
// of its header, restated in PLAN.md — is that it "NEVER talks to store.js;
// host pages wire saving". A module graph is a contract too: once editor.js
// can reach store.js the next change that wants a network call will simply
// make it, and the reason the editor is testable in isolation is gone. So the
// shared logic lives here, in a module that imports NOTHING and touches no
// DOM. Both consumers import it; neither learns anything about the other.
//
// THE DATA
// --------
// The fal pipeline slices one generated sheet into tiles and files every tile
// as its own sm_assets row. Tiles that are variants of the SAME input line
// carry the same `stack:<sheet8>-l<line>` tag, plus `derived.line_index` and
// `derived.variant` (1-based ordinal within the line). Nothing else about the
// row differs — same kind, same source, same label. Ungrouped, three tries at
// one drawing read as three unrelated drawings and the library grows by 3× per
// sheet; that is the bug this fixes.
//
// THE MODEL
// ---------
// groupStacks(list) folds a flat asset list into ITEMS, preserving the
// incoming order (a group sits where its FIRST member sat, so every sort the
// caller already applied — uploads-first, filename order, style batches —
// still reads correctly). Every item has the same shape:
//
//   { stack: string|null, versions: [row, ...], current: <index> }
//
// Singles are items too (`stack: null`, one version), so a caller renders ONE
// code path and asks `isStacked(item)` only for the extra chrome. A stack that
// ended up with a single surviving version is NOT stacked — a «1/1» badge and
// a cycle button that does nothing are worse than no badge at all.
//
// MEMORY
// ------
// Which version a stack is currently showing is per-session module state,
// keyed by the stack tag — deliberately NOT persisted and NOT a schema change.
// The operator directive is "clicking the illustration rotates through its
// versions"; that is a viewing gesture, not an edit to the board. Keying by
// the TAG (not by list position) is what makes the choice survive a re-filter,
// a re-search, a tab switch, and — since both consumers import this one module
// — a trip from the assets page's detail modal back to its grid card.

export const STACK_TAG = 'stack:';

// Per-session current index, keyed by stack tag. Module state on purpose: see
// the MEMORY note above.
const CURRENT = new Map();

/** The `stack:<key>` tag on a row, or null when it carries none. */
export function stackKey(a) {
  const tags = a && Array.isArray(a.tags) ? a.tags : [];
  for (const t of tags) {
    const s = String(t);
    if (s.startsWith(STACK_TAG)) {
      const k = s.slice(STACK_TAG.length).trim();
      if (k) return k;
    }
  }
  return null;
}

/** 1-based ordinal within the stack, or null when the row predates the stamp. */
export function variantOf(a) {
  const v = a && a.derived ? a.derived.variant : null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Sort inside a stack: by `derived.variant` when it is there (that is the
// producer's own ordering and the only thing that makes «2/3» mean anything
// stable), then by created_at, then by name. The fallbacks matter because
// `derived` is not guaranteed to survive every host's row-shaping shim, and a
// stack that silently re-orders between two renders would make the badge lie.
function byVariant(x, y) {
  const vx = variantOf(x), vy = variantOf(y);
  if (vx !== null && vy !== null && vx !== vy) return vx - vy;
  if (vx !== null && vy === null) return -1;
  if (vx === null && vy !== null) return 1;
  const cx = String(x.created_at || ''), cy = String(y.created_at || '');
  if (cx !== cy) return cx < cy ? -1 : 1;
  return String(x.name || '').localeCompare(String(y.name || ''), 'en', { numeric: true });
}

/**
 * Fold a flat sm_assets list into stack items, order-preserving.
 * @param {Array} list rows with `tags` (and ideally `derived`)
 * @returns {Array<{stack: string|null, versions: Array, current: number}>}
 */
export function groupStacks(list) {
  const out = [];
  const byKey = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a) continue;
    const key = stackKey(a);
    if (!key) { out.push({ stack: null, versions: [a], current: 0 }); continue; }
    let item = byKey.get(key);
    if (!item) {
      item = { stack: key, versions: [], current: 0 };
      byKey.set(key, item);
      out.push(item);           // the group holds the position of its first member
    }
    item.versions.push(a);
  }
  for (const item of byKey.values()) {
    item.versions.sort(byVariant);
    item.current = clamp(CURRENT.get(item.stack), item.versions.length);
  }
  return out;
}

function clamp(i, len) {
  const n = Number(i);
  if (!Number.isFinite(n) || !len) return 0;
  return Math.min(Math.max(0, Math.trunc(n)), len - 1);
}

/** True when the item is worth showing as a stack (2+ versions). */
export function isStacked(item) {
  return !!(item && item.stack && item.versions && item.versions.length > 1);
}

/** The row the item is currently showing — always a row, never undefined. */
export function currentOf(item) {
  if (!item || !item.versions || !item.versions.length) return null;
  return item.versions[clamp(item.current, item.versions.length)];
}

/** Jump to an absolute index (the detail view's version thumbs). Returns the row. */
export function setStackIndex(item, i) {
  if (!item || !item.versions || !item.versions.length) return null;
  item.current = clamp(i, item.versions.length);
  if (item.stack) CURRENT.set(item.stack, item.current);
  return currentOf(item);
}

/** Advance one version, wrapping. Returns the row now showing. */
export function cycleStack(item) {
  if (!item || !item.versions || !item.versions.length) return null;
  return setStackIndex(item, (item.current + 1) % item.versions.length);
}

/** «2/3» — the badge text. */
export function stackBadge(item) {
  return `${(item.current || 0) + 1}/${item.versions.length}`;
}

// Test seam only: forget every remembered index. No production caller.
export function _resetStackMemory() {
  CURRENT.clear();
}
