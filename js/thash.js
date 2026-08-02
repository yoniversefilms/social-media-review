// thash.js — the ONE translation-hash implementation, ever.
//
// Pure ESM, zero dependencies, no DOM, no Node built-ins: this file is loaded
// verbatim by THREE consumers and must behave identically in all of them.
//
//   1. the browser        — app/js/post.js  (`import { fieldHash } from './thash.js'`)
//   2. the ingest script  — scripts/ingest.mjs (`import … from '../app/js/thash.js'`)
//   3. the factory runner — ~/Documents/Claude_JFCS/New_Workflow/studio/translate.mjs
//                           (imports this file by ABSOLUTE path — a read across
//                            repos, which the custody rule permits; the studio
//                            is never written to from here and this repo is
//                            never written to from there)
//
// THIS IS A CONTRACT, NOT AN IMPLEMENTATION DETAIL.
// `src_hash` values computed by this function are STORED — in
// studio/content/translations/*.json and in sm_posts.translation. Changing the
// algorithm (or the normalization, or the output format) invalidates EVERY
// stored src_hash at once: every field on every post would read «stale» even
// though nobody touched the Hebrew. If this ever has to change, it is a data
// migration, not an edit — regenerate all translations in the same pass.
//
// The algorithm: FNV-1a 32-bit over the UTF-8 bytes of
// `String(v).normalize('NFC')`, rendered as 8 lowercase hex chars.
//
//   · NFC, because decomposed Hebrew (niqqud typed in a different editor) is
//     the same text and must not read as an edit.
//   · NO trim and no other normalization, because a whitespace edit IS an
//     edit — and trim rules are precisely the kind of divergence that splits
//     two producers apart.
//   · Not SHA-256: `crypto.subtle` is async and secure-context-gated in the
//     browser and has a different API in Node, i.e. two implementations —
//     exactly the "silently stale" failure this module exists to prevent.
//     `Math.imul(...) >>> 0` is bit-identical uint32 arithmetic in Node and in
//     every browser. Staleness is a hint, not security; collision resistance
//     is irrelevant here.

export function fieldHash(v) {
  const bytes = new TextEncoder().encode(String(v ?? '').normalize('NFC'));
  let h = 0x811c9dc5;
  for (const b of bytes) { h ^= b; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
