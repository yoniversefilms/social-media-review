// tplswap.js — swapping one slide's template while keeping everything the
// reviewer wrote. Contract: PLAN.md «Template switcher (spec 16)».
//
// PURE. No DOM, no network, no imports. The host fetches the target's raw
// template and its composed SHAPE and hands both in; this file only decides
// where the words, the photos and the design go. That is what makes it
// unit-testable under `node -e` against the real manifest, which is the only
// way the mapping rules below get proven at all.
//
//   templateRequires(rawTemplateHtml) -> {vars:[key], ills:Set, attrs:Set}
//   templateShape(composedHtml) -> {slots, els:Set, vars:Set} | null
//   swapSlide(slide, targetName, {manifest, shape, requires, fromRequires})
//     -> {slide, placeholderFilled:[key], blank:[key], dropped:{…}}
//
// LOSSLESSNESS lives in `slide.tplmem`: swapping away stashes the FULL
// pre-swap {vars, design} under the old template's name, swapping back
// restores it verbatim and deletes the stash entry. So A→B→A is byte-identical
// in {template, vars, design}; only tplmem differs (it now remembers B).
// The stash rides the slide object into sm_posts.slides — savePostSlides
// PATCHes the array verbatim (store.js:1526), so nothing strips it — and it is
// stripped on the way into the factory (apply-edits.mjs). Losing it (a factory
// re-ingest rewrites the slide) degrades to the fresh-target mapping below;
// it is never an error.
//
// ---------------------------------------------------------------------------
// ORPHAN DESIGN KEYS — MEASURED, NOT ASSUMED (2026-08-11)
//
// An orphan design key is one that names something the TARGET template does
// not have: design.slots["3"] on a template with two photo slots,
// design.els["mark:0"] on a template that draws no mark, design.hidden naming
// a var that is not in the target, design.blocks keyed on a var the target
// never declares. Swapping templates manufactures all four, so what the two
// engines do with them decides filter-vs-carry.
//
// PROBE — real render.mjs runs, five throwaway content fixtures against
// templates/hook.html (0 photo slots; els {lockup:1, rule:1, ill:1}), each
// `node render.mjs --content --only probe16<x>` from
// New_Workflow/studio/, fixtures deleted afterwards:
//
//   a  design.slots {"0":{url:<1px png data URI>}}
//      → FAIL  job "probe16a-orphan-slot" design.slots["0"]: template "hook"
//              has 0 photo slot(s)                                   [exit 1]
//   b  design.els {"mark:0":{color:"gold-70"}}
//      → FAIL  job "probe16b-orphan-el" design.els "mark:0": template "hook"
//              has {"lockup":1,"rule":1,"ill":1}                      [exit 1]
//   c  design.blocks {"nosuchvar":{…}, "display":{…}}
//      → ok    probe16c-orphan-block  (981 kB)                        [exit 0]
//   d  design.hidden ["nosuchvar"]
//      → FAIL  job "probe16d-orphan-hidden" design.hidden "nosuchvar"
//              matches no text block in template "hook"               [exit 1]
//   e  design.bg + a photo extra (neither is template-scoped)
//      → ok    probe16e-extras-only  (370 kB)                         [exit 0]
//
// compose.js, same cases, by static trace of composeInner (unambiguous — the
// three call sites are compose.js:1186-1202 slots, 1215-1235 els/hidden,
// 1237-1241 hidden vars, and 1148 blocks): orphan slots/els/hidden push a
// Hebrew problem and paint the red «התצוגה חלקית» banner OVER the slide;
// orphan blocks are never read at all (blocks[key] is only consulted while
// substituting a placeholder the template actually contains) and produce no
// problem and no banner. Nothing throws — that is the deliberate divergence
// documented in compose.js's header.
//
// VERDICT — filtering is MANDATORY, exactly as the plan's default:
//   slots · els · hidden · locked   filtered against the target's shape.
//     render.mjs dies on every one of them, and a swap that hands the factory
//     a slide which kills a render run is the one outcome this feature may
//     never produce. compose.js would have survived, but with a red banner
//     across the artwork on every swapped slide, which is its own failure.
//   blocks                          filtered to the target's field keys.
//     Neither engine cares, so this is housekeeping rather than safety — but
//     an unfiltered blocks bag grows by one dead entry per swap and would
//     re-attach itself the moment a later template happened to reuse the key
//     name, which is a surprise nobody asked for.
//   bg · extras                     carried VERBATIM.
//     Proven template-independent by probe (e): a background and a photo extra
//     are slide-level furniture, positioned in % of the 1080×1350 box, and
//     neither engine resolves them against the template at all.
// Nothing filtered is LOST: the full pre-swap design is in the stash, so
// swapping back restores every dropped key.
// ---------------------------------------------------------------------------

// The engine tags EVERY photo placeholder data-slot="N" and every decorative
// element data-el="<kind>:N" at compose time, always, design or no design
// (compose.js applySlots/applyEls) — and wraps every text-position {{var}} in
// <span data-var="…">. So the target's own composed document is the exact
// answer to "what does this template have", with no second copy of
// DESIGN_EL_KINDS to drift out of step with the PARITY BLOCK. The host composes
// the target once (vars: every manifest field present, so every text block is
// wrapped) and passes the string here.
//
// Returns null when the composition is the engine's missing-template fallback —
// otherwise a template that failed to load would read as "has nothing", and the
// swap would silently strip a design the reviewer never touched.
const RE_SHAPE_SLOT = /data-slot="(\d+)"/g;
const RE_SHAPE_EL = /data-el="([^"]+)"/g;
const RE_SHAPE_VAR = /data-var="([^"]+)"/g;
const EMPTY_SLIDE = '<div class="slide slide--paper"></div>';

export function templateShape(composedHtml) {
  const html = String(composedHtml || '');
  if (!html || html.includes(EMPTY_SLIDE)) return null;
  let slots = 0;
  for (const m of html.matchAll(RE_SHAPE_SLOT)) slots = Math.max(slots, Number(m[1]) + 1);
  const els = new Set();
  for (const m of html.matchAll(RE_SHAPE_EL)) els.add(m[1]);
  const vars = new Set();
  for (const m of html.matchAll(RE_SHAPE_VAR)) vars.add(m[1]);
  return { slots, els, vars };
}

// What a template ACTUALLY needs, read off its own source with the engines'
// own substitution grammar (compose.js RE_ILL_VAR / RE_VAR, restated here
// because this module imports nothing — two regexes, not a copy of the engine).
//
// WHY, precisely — the claim this file made first time round («the manifest is
// short of the template») was WRONG and the unit suite caught it. All 55
// templates were then walked and compared against studio/manifest.json:
//   · manifest SHORT of the template ............... 0 templates
//   · manifest carrying a field the template lost .. 0 templates
//   · manifest field ORDER ≠ template order ........ 13 of 55
//   · …of those, differing in PROSE order .......... 6 of 55
//   · vars in ATTRIBUTE position ................... 8 (the v3-* family, `face`)
// So the manifest is not stale; it is UNORDERED. And the kind-positional half
// of the mapping is order-sensitive by construction — it hands the reviewer's
// first sentence to the first same-kind field it finds. Against manifest order
// that is an arbitrary permutation of the layout; against TEMPLATE order it is
// the order the words are read on the artwork. spin-katz-underline.v2 reads
// [photoLabel, line1, line2emph, line2rest] and declares
// [line1, line2emph, line2rest, photoLabel]: same fields, different answer, and
// the wrong answer puts the reviewer's headline in the photo caption. Swept
// over all 2970 ordered template pairs with the attribute/ill classification
// held identical on both sides so ORDER is the only variable, template order
// lands a DIFFERENT value in a different field for 74 of them — e.g.
// closer-cta → spin-razbahar-portrait,
// where manifest order drops the lede into `kicker` and leaves `photoLabel` a
// placeholder, and template order does the reverse. That is exactly the «the
// text is changing» the operator reported. Reading the template also covers
// attribute-position vars for free and makes this independent of manifest
// freshness, neither of which is load-bearing today.
//
// `vars` is first-appearance order across BOTH patterns, which is why the two
// matches are merged by offset rather than scanned one grammar at a time: doing
// ills first floated {{ill:$x}} to the head of every template that has one,
// which is the same permutation bug one level down. The two patterns are
// disjoint (RE_REQ_VAR cannot match a key containing `:` or `$`), so no match
// is counted twice. `ills` are the keys used as {{ill:$key}} — they hold an
// illustration file stem, never prose.
//
// `attrs` are the keys whose EVERY occurrence sits in ATTRIBUTE position. See
// the ATTRIBUTE VARS block above mapVars for why they are a third pool and not
// a kind of prose. The test is compose.js's insideTag() verbatim — an offset
// whose nearest unclosed '<' comes after its nearest '>' is inside a tag — and
// it is applied per OCCURRENCE, because a var used once in a class and once in
// a heading is prose that also happens to style the slide, not a hidden token.
//
// Comments are stripped BEFORE any of this. A commented-out `{{ghost}}` is not
// a field: the engines never substitute it (it is inside <!-- -->, which they
// emit verbatim), but a scanner that counts it invents a required var, hands it
// a placeholder, and writes a key no template will ever read. Stripping first
// also keeps the offsets self-consistent for the attribute test.
const RE_REQ_ILL = /\{\{ill:\$([a-zA-Z0-9_]+)\}\}/g;
const RE_REQ_VAR = /\{\{([a-zA-Z0-9_]+)\}\}/g;
const RE_COMMENT = /<!--[\s\S]*?-->/g;

// compose.js insideTag(), verbatim: a {{var}} whose match offset sits between
// an unclosed '<' and its '>' is in attribute position.
const insideTag = (src, off) => src.lastIndexOf('<', off) > src.lastIndexOf('>', off);

export function templateRequires(rawTemplateHtml) {
  const raw = String(rawTemplateHtml || '');
  if (!raw) return null;
  const src = raw.replace(RE_COMMENT, '');
  const hits = [], ills = new Set();
  for (const m of src.matchAll(RE_REQ_ILL)) {
    ills.add(m[1]);
    hits.push([m.index, m[1], false]);   // {{ill:$x}} is never in attribute position
  }
  for (const m of src.matchAll(RE_REQ_VAR)) hits.push([m.index, m[1], insideTag(src, m.index)]);
  hits.sort((a, b) => a[0] - b[0]);
  const vars = [], seen = new Set(), textPos = new Set(), anyPos = new Set();
  for (const [, key, inTag] of hits) {
    if (!seen.has(key)) { seen.add(key); vars.push(key); }
    anyPos.add(key);
    if (!inTag) textPos.add(key);
  }
  const attrs = new Set([...anyPos].filter((k) => !textPos.has(k) && !ills.has(k)));
  return { vars, ills, attrs };
}

// The var keys a shape probe should be composed with: every key the target
// needs, present but empty. A key that is ABSENT is not substituted at all (the
// engine reports it missing and emits nothing), so its span would never be
// tagged data-var and design.hidden entries naming it would be filtered away by
// mistake. Empty is fine here — this composition is measured, never shown.
export function probeVars(manifest, name, requires) {
  const out = {};
  for (const f of targetFields(manifest, name, requires)) out[f.key] = '';
  return out;
}

// ---------------------------------------------------------------- manifest

function tplOf(manifest, name) {
  const list = (manifest && manifest.templates) || [];
  return list.find((t) => t && t.name === name) || null;
}

function fieldsOf(t) {
  return (t && Array.isArray(t.fields) ? t.fields : [])
    .filter((f) => f && typeof f.key === 'string' && f.key);
}

// The target's fields, in TEMPLATE order, with the manifest's kinds where it
// has them. The template is the authority on WHICH vars exist (see
// templateRequires); the manifest is the authority on what KIND each one is,
// because `text` vs `multiline` is a judgement the source cannot express and it
// is the distinction the whole mapping turns on. A var the manifest has never
// heard of is an `ill` when the template used it to pick a drawing and prose
// otherwise. Without `requires` this degrades to exactly the manifest list,
// which is what every board with a current manifest already had.
function targetFields(manifest, name, requires) {
  const declared = new Map(fieldsOf(tplOf(manifest, name)).map((f) => [f.key, f.kind]));
  if (!requires || !Array.isArray(requires.vars) || !requires.vars.length) {
    return [...declared].map(([key, kind]) => ({ key, kind }));
  }
  const out = [], seen = new Set();
  for (const key of requires.vars) {
    seen.add(key);
    // Position BEATS the manifest kind. The manifest calls `face` a text field
    // and it is not one — see the ATTRIBUTE VARS block below.
    const kind = requires.attrs && requires.attrs.has(key) ? 'attr'
      : declared.get(key) || (requires.ills.has(key) ? 'ill' : 'text');
    out.push({ key, kind });
  }
  // A manifest field the template no longer mentions is dead, but writing it is
  // free and a stale manifest must never silently drop the reviewer's text.
  for (const [key, kind] of declared) if (!seen.has(key)) out.push({ key, kind });
  return out;
}

const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// ---------------------------------------------------------------- var mapping

// `ill` is its OWN pool and never cross-fills. An ill field's value is an
// illustration file stem (RE_ILL_NAME in the engines) — putting a sentence
// there does not produce a bad drawing, it produces a red «אינו שם איור חוקי»
// banner, and putting a drawing name into a paragraph prints the word
// "chair-empty" on the artwork. text and multiline DO cross-fill: they hold
// the same substance (Hebrew prose the reviewer wrote) and differ only in how
// much of it the template expects, so a headline landing in a paragraph slot
// is a cosmetic mismatch the reviewer can see and fix — losing the sentence
// entirely is not.
const TEXTY = new Set(['text', 'multiline']);

// PLACEHOLDERS, not sample copy. A target field with no home in the source used
// to be filled from the template's own sample.json, which reads as finished
// Hebrew prose — the operator could not tell their own sentence from the
// template's demo sentence, and «the text is changing» is exactly what that
// looks like from the outside. A placeholder has to be unmistakable at a
// glance, on the artwork, at thumbnail size.
const PLACEHOLDER = {
  text: 'טקסט ממלא מקום',
  multiline: 'כאן יבוא טקסט נוסף',
};
// An `ill` field cannot take prose and it cannot take nothing either. MEASURED
// (render.mjs, 2026-08-11, fixture probe16f against templates/hook.html):
//   vars.ill = ""  ->  FAIL  job "probe16f-empty-ill" sets ill="", which is not
//                      a file in illustrations/                       [exit 1]
// compose.js is the same story one notch softer: RE_ILL_NAME is /^[a-z0-9-]+$/,
// the empty string fails it, and the slide wears «”“ אינו שם איור חוקי» in the
// red banner. So an unmapped ill field gets a real drawing or the swap is
// broken. `leaf-single` is the library's one genuinely neutral mark — it says
// nothing about couples, parenting, relocation or therapy, which every other
// drawing in the 436 does. Validated against the manifest before use, with the
// first available drawing as the fallback, because a placeholder that is itself
// missing would reintroduce the exact failure it exists to prevent.
const PLACEHOLDER_ILL = 'leaf-single';
function placeholderIll(manifest) {
  const lib = (manifest && Array.isArray(manifest.illustrations)) ? manifest.illustrations : [];
  if (lib.includes(PLACEHOLDER_ILL)) return PLACEHOLDER_ILL;
  return lib.find((n) => typeof n === 'string' && /^[a-z0-9-]+$/.test(n)) || PLACEHOLDER_ILL;
}

// ---- ATTRIBUTE VARS — the third pool, and why -------------------------------
// The whole v3-* family renders its slide root as
//   <div class="slide slide--paper t-v3-teach {{face}}">
// so `face` is a CSS CLASS TOKEN, not copy. compose.js detects that at compose
// time (insideTag) and substitutes it raw instead of wrapping it in a
// <span data-var>, which means it never appears on the artwork at all.
//
// The manifest calls it a `text` field, and taking the manifest at its word was
// a shipped BUG: swapping into any v3 template handed the reviewer's first
// prose line to `face`, where it vanished into a class attribute, and promoted
// their SECOND line to the heading.
//
// MEASURED, two fixtures against templates/v3-teach.html, `node render.mjs
// --content --only …`, both deleted afterwards. The damning part is that
// NEITHER engine complains — this is why it shipped:
//
//   spec16h  face = "הכותרת של המבקרת"   (the bug)
//     ok    spec16h-attr-prose  (309 kB)   1 rendered, 0 failed   [exit 0]
//     class="slide slide--paper t-v3-teach הכותרת של המבקרת"
//     visible text: «גוף הטקסט. שורה שלישית. בית בוואלי · …»
//                    ^ the headline is GONE and line two is now the heading
//
//   spec16g  face = ""                     (the fix)
//     ok    spec16g-attr-empty  (312 kB)   1 rendered, 0 failed   [exit 0]
//     class="slide slide--paper t-v3-teach "
//     visible text: «הכותרת של המבקרת גוף הטקסט. בית בוואלי · …»
//                    ^ the headline is the heading
//
// So attribute vars are their own pool, exactly like `ill`, and the exclusion
// is SYMMETRIC — the mirror bug is just as bad. On the way IN, prose may never
// land in an attribute var. On the way OUT of a v3 template, `face` may never
// be poured into a prose field: its value is either '' or something like
// 'face-frank', and «face-frank» appearing as somebody's headline is the same
// failure wearing the other shoe. An attribute var therefore fills by EXACT KEY
// only (so v3→v3 keeps the reviewer's serif choice) and is otherwise ''.
//
// '' is the safe value in both engines: they die/banner on an ABSENT key, never
// an empty one, so the substitution emits nothing and the class list simply
// ends in a space. It is also what all eight v3 sample.json files already ship,
// which is to say it is the value the factory renders today.
const ATTR_EMPTY = '';

function mapVars(srcSlide, srcTpl, manifest, dstFields, srcRequires) {
  const srcVars = (srcSlide && srcSlide.vars && typeof srcSlide.vars === 'object')
    ? srcSlide.vars : {};
  // Source fields in the OLD template's declared order, kinds from its manifest
  // row. A source key the manifest never listed is prose by default — EXCEPT
  // when its value is a legal illustration stem that the library actually
  // carries, which is the only shape an ill value ever has. Without that arm a
  // stale manifest row (spin-katz-underline.v2 declares four fields; its
  // template uses five) would let "cpl-cv-sink-full" be cross-filled into a
  // paragraph and printed on the slide as those literal words.
  const lib = new Set((manifest && Array.isArray(manifest.illustrations))
    ? manifest.illustrations : []);
  const srcFields = fieldsOf(srcTpl);
  const declared = new Map(srcFields.map((f) => [f.key, f.kind]));
  const srcAttrs = (srcRequires && srcRequires.attrs) ? srcRequires.attrs : new Set();
  const looksIll = (v) => typeof v === 'string' && /^[a-z0-9-]+$/.test(v) && lib.has(v);
  const pool = [];
  const push = (key) => {
    if (!Object.prototype.hasOwnProperty.call(srcVars, key)) return;
    const value = srcVars[key];
    // same precedence as the target side: POSITION first, manifest kind second
    const kind = srcAttrs.has(key) ? 'attr'
      : declared.get(key) || (looksIll(value) ? 'ill' : 'text');
    pool.push({ key, kind, value });
  };
  for (const f of srcFields) push(f.key);
  for (const k of Object.keys(srcVars)) if (!declared.has(k)) push(k);

  const used = new Set();
  const vars = {};
  const placeholderFilled = [], blank = [];
  const take = (want) => {
    const p = pool.find((x) => !used.has(x.key) && want(x.kind));
    if (!p) return null;
    used.add(p.key);
    return p.value;
  };
  // The three pools that may never mix. Exact-key matching honours them too:
  // a `face` that is an attribute here and prose there is still two different
  // things, and copying across the boundary is the bug either direction.
  const classOf = (k) => (k === 'attr' ? 'attr' : k === 'ill' ? 'ill' : 'prose');

  // (1) exact key match, same pool on both sides
  let rest = [];
  for (const f of dstFields) {
    const hit = pool.find((p) => p.key === f.key && !used.has(p.key) &&
      classOf(p.kind) === classOf(f.kind));
    if (hit) { vars[f.key] = hit.value; used.add(hit.key); } else rest.push(f);
  }

  // (2a) attribute vars are done: exact key or nothing. There is no positional
  // fallback and there must not be one — a class token has no neighbours.
  const afterAttr = [];
  for (const f of rest) {
    if (f.kind === 'attr') vars[f.key] = ATTR_EMPTY; else afterAttr.push(f);
  }
  rest = afterAttr;

  // (2) same-kind positional, for EVERY remaining field, before anything
  // cross-fills. The order of these two passes is load-bearing and it was wrong
  // in the first cut: filling one target field at a time and cross-filling the
  // moment its own kind ran out let an early multiline field swallow the one
  // `text` value a later text field was the natural home for. The reviewer's
  // sentence still survived, but it surfaced in the wrong shaped box while the
  // right box got a placeholder — which is «the text is changing» seen from the
  // reviewer's side. Globally satisfying same-kind first cannot do that.
  const next = [];
  for (const f of rest) {
    const v = take((k) => k === f.kind);
    if (v !== null) vars[f.key] = v; else next.push(f);
  }
  rest = next;

  // (3) cross-fill, prose only. `ill` is its own pool and never cross-fills in
  // either direction: an illustration stem in a paragraph prints the words
  // "chair-empty" on the artwork, and a sentence in an ill var is a red
  // «אינו שם איור חוקי» banner. text and multiline hold the same substance and
  // differ only in how much of it the template expects, so a headline landing
  // in a paragraph is a mismatch the reviewer can see and fix, while losing the
  // sentence is not.
  const last = [];
  for (const f of rest) {
    if (!TEXTY.has(f.kind)) { last.push(f); continue; }
    const v = take((k) => TEXTY.has(k));
    if (v !== null) vars[f.key] = v; else last.push(f);
  }

  // (4) everything still unspoken for gets an OBVIOUS placeholder. Never the
  // template's sample copy: see PLACEHOLDER above.
  for (const f of last) {
    if (f.kind === 'ill') {
      vars[f.key] = placeholderIll(manifest);
      placeholderFilled.push(f.key);
    } else if (PLACEHOLDER[f.kind]) {
      vars[f.key] = PLACEHOLDER[f.kind];
      placeholderFilled.push(f.key);
    } else {
      // an unknown kind from a manifest newer than this file: write it empty
      // and SAY so, rather than guessing at copy for a field we cannot describe
      vars[f.key] = '';
      blank.push(f.key);
    }
  }
  return { vars, placeholderFilled, blank };
}

// ---------------------------------------------------------------- design map

const RE_SLOT_KEY = /^\d+$/;
const RE_HIDDEN_SLOT = /^slot:(\d+)$/;
const RE_HIDDEN_EL = /^el:(.+)$/;

// One entry of design.hidden / design.locked survives when the thing it names
// still exists in the target. See the ORPHAN DESIGN KEYS block: every one of
// these is fatal to render.mjs if it does not.
function keepsRef(entry, shape, fieldKeys) {
  if (typeof entry !== 'string' || !entry) return false;
  const sm = entry.match(RE_HIDDEN_SLOT);
  if (sm) return Number(sm[1]) < shape.slots;
  const em = entry.match(RE_HIDDEN_EL);
  if (em) return shape.els.has(em[1]);
  // a bare var name: it must be a field of the target AND actually reach the
  // document as a wrapped span, which is precisely what render.mjs checks
  return fieldKeys.has(entry) && shape.vars.has(entry);
}

function mapDesign(design, dstFields, shape) {
  if (!design || typeof design !== 'object') return { design: null, dropped: null };
  const fieldKeys = new Set(dstFields.map((f) => f.key));
  // No shape means the target never composed. Carrying template-scoped keys
  // blind is the one thing that can kill a factory run, so they all go; the
  // stash still holds every one of them.
  const sh = shape || { slots: 0, els: new Set(), vars: new Set() };
  const out = {};
  const dropped = { blocks: [], slots: [], els: [], hidden: [], locked: [] };

  if (design.blocks && typeof design.blocks === 'object') {
    const b = {};
    for (const k of Object.keys(design.blocks)) {
      if (fieldKeys.has(k)) b[k] = copy(design.blocks[k]);
      else dropped.blocks.push(k);
    }
    if (Object.keys(b).length) out.blocks = b;
  }
  if (Array.isArray(design.extras) && design.extras.length) out.extras = copy(design.extras);
  if (design.bg && typeof design.bg === 'object') out.bg = copy(design.bg);
  if (design.slots && typeof design.slots === 'object') {
    const s = {};
    for (const k of Object.keys(design.slots)) {
      if (RE_SLOT_KEY.test(k) && Number(k) < sh.slots) s[k] = copy(design.slots[k]);
      else dropped.slots.push(k);
    }
    if (Object.keys(s).length) out.slots = s;
  }
  if (design.els && typeof design.els === 'object') {
    const e = {};
    for (const k of Object.keys(design.els)) {
      if (sh.els.has(k)) e[k] = copy(design.els[k]);
      else dropped.els.push(k);
    }
    if (Object.keys(e).length) out.els = e;
  }
  for (const key of ['hidden', 'locked']) {
    if (!Array.isArray(design[key]) || !design[key].length) continue;
    const keep = [];
    for (const entry of design[key]) {
      if (keepsRef(entry, sh, fieldKeys)) keep.push(entry);
      else dropped[key].push(String(entry));
    }
    if (keep.length) out[key] = keep;
  }
  return {
    design: Object.keys(out).length ? out : null,
    dropped: Object.values(dropped).some((a) => a.length) ? dropped : null,
  };
}

// ---------------------------------------------------------------- swapSlide

// The whole feature in one pure function. `slide` is the CURRENT slide object
// ({template, vars, design?, tplmem?}); it is never mutated — the caller gets a
// fresh object it can hand straight to the host as the new S.slides[i].
//
// opts.manifest      studio/manifest.json (field kinds + the illustration library)
// opts.requires      templateRequires() of the TARGET's raw html, or null
// opts.fromRequires  templateRequires() of the SOURCE's raw html, or null —
//                    without it the source's attribute vars cannot be told from
//                    its prose, and `face` can be poured into a heading
// opts.shape         templateShape() of the target, or null (see mapDesign)
export function swapSlide(slide, targetName, opts = {}) {
  const src = (slide && typeof slide === 'object') ? slide : {};
  const target = String(targetName || '');
  if (!target) throw new Error('חסר שם תבנית להחלפה');
  const from = String(src.template || '');
  if (!from) throw new Error('לשקף הנוכחי אין תבנית');

  const manifest = opts.manifest || {};
  // The stash the NEW slide carries: everything the old one remembered, plus
  // the state we are leaving behind. Written before the restore lookup so that
  // A→B→A→B finds B's stash from the previous round and A's from this one.
  const memo = {};
  if (src.tplmem && typeof src.tplmem === 'object') {
    for (const k of Object.keys(src.tplmem)) memo[k] = copy(src.tplmem[k]);
  }
  const leaving = { vars: copy(src.vars) || {} };
  if (src.design && typeof src.design === 'object') leaving.design = copy(src.design);
  memo[from] = leaving;

  const out = { ...src, template: target };
  delete out.tplmem;

  const stash = memo[target];
  let placeholderFilled = [], blank = [], dropped = null, restored = false;
  if (stash && typeof stash === 'object') {
    // verbatim restore — this is the lossless half of the round trip, and it
    // restores placeholders too: whatever B looked like when you left it is
    // what B looks like when you come back, injected copy included
    restored = true;
    delete memo[target];
    out.vars = copy(stash.vars) || {};
    if (stash.design && typeof stash.design === 'object') out.design = copy(stash.design);
    else delete out.design;
  } else {
    const dstFields = targetFields(manifest, target, opts.requires || null);
    const mv = mapVars(src, tplOf(manifest, from), manifest, dstFields,
      opts.fromRequires || null);
    out.vars = mv.vars;
    placeholderFilled = mv.placeholderFilled;
    blank = mv.blank;
    const md = mapDesign(src.design, dstFields, opts.shape || null);
    if (md.design) out.design = md.design; else delete out.design;
    dropped = md.dropped;
  }
  if (Object.keys(memo).length) out.tplmem = memo;

  return { slide: out, placeholderFilled, blank, dropped, restored };
}

// A one-line Hebrew account of what the swap could not carry, for the host's
// toast. Silence when nothing was dropped — a reviewer who lost nothing should
// not be told anything.
export function droppedSummary(dropped) {
  if (!dropped) return '';
  const bits = [];
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  if (n(dropped.slots)) bits.push(n(dropped.slots) === 1 ? 'תמונה במשבצת' : n(dropped.slots) + ' תמונות במשבצות');
  if (n(dropped.els)) bits.push(n(dropped.els) === 1 ? 'עיצוב של אלמנט' : n(dropped.els) + ' עיצובים של אלמנטים');
  if (n(dropped.blocks)) bits.push(n(dropped.blocks) === 1 ? 'עיצוב של טקסט' : n(dropped.blocks) + ' עיצובים של טקסט');
  const hid = n(dropped.hidden) + n(dropped.locked);
  if (hid) bits.push(hid === 1 ? 'פריט מוסתר או נעול' : hid + ' פריטים מוסתרים או נעולים');
  return bits.join(' · ');
}
