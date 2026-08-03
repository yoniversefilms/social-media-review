// tour.js — the guided-tour ENGINE, nothing else. Step definitions live in
// tours.js; this module knows how to show them: a spotlight cutout over the
// target, an RTL tooltip beside it, back/next/exit, keyboard, and cross-page
// continuation through sessionStorage. No network, no store.js — the engine
// may run before (or instead of) a board ever loading.
//
// A step: {
//   at:    CSS selector for the target, or null for a centered card
//          (welcome / finale). MISSING TARGETS ARE SKIPPED, not fatal —
//          that is the runtime half of the "UI moved, tour survives" rule;
//          the build-time half is scripts/tours-check.mjs.
//   title: short Hebrew heading
//   text:  1-3 plain sentences (\n allowed)
//   page:  which page this step lives on ('index' | 'post' | …). When it is
//          not the current page the engine saves progress and navigates.
//   href:  optional () => url for the navigation to that page (the post page
//          needs a real post id; everything else derives <page>.html + query)
//   before: optional fn run before locating the target (e.g. open a tab so
//          the reviewer SEES what the step talks about)
// }
//
// DESKTOP ONLY for now (2026-08-03): the mobile layout is mid-build, so the
// fab is hidden and tours refuse to start under 920px. Revisit when it lands.

import { el } from './ui.js';

const STATE_KEY = 'smr:tour';            // sessionStorage: {name, i} mid-flight
const WAIT_MS = 9000;                    // async pages (post) load data first
const PAD = 6;                           // spotlight breathing room, px

export const currentPage = () => {
  const f = location.pathname.split('/').pop();
  return (f && f.replace(/\.html$/, '')) || 'index';
};

// board/local ride every internal link, same rule as ui.js navBar
export const pageQuery = () => {
  const params = new URLSearchParams(location.search);
  const keep = new URLSearchParams();
  if (params.get('board')) keep.set('board', params.get('board'));
  if (params.get('local')) keep.set('local', params.get('local'));
  return keep.toString() ? '?' + keep.toString() : '';
};

export function pendingTour() {
  try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); }
  catch { return null; }
}

export function clearPendingTour() {
  try { sessionStorage.removeItem(STATE_KEY); } catch { /* private mode */ }
}

let active = null;   // one tour at a time

export function tourRunning() { return !!active; }

// steps: the FULL array (all pages); startAt: resume index after navigation.
// name is what pendingTour()/resume matches on ('full' | 'page').
export function startTour(steps, { name = 'page', startAt = 0, onDone } = {}) {
  if (active) active.exit(false);
  if (window.innerWidth < 920) return null;   // mobile layout mid-build

  const page = currentPage();
  const q = pageQuery();

  // ---- chrome (built once, moved per step) --------------------------------
  const spot = el('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const nEl = el('span', { class: 'tour-tip__n' });
  const titleEl = el('h4', { class: 'tour-tip__title' });
  const textEl = el('p', { class: 'tour-tip__text' });
  const backBtn = el('button', { class: 'btn btn--ghost tour-tip__back', type: 'button' }, 'הקודם');
  const nextBtn = el('button', { class: 'btn btn--primary tour-tip__next', type: 'button' }, 'הבא');
  const exitBtn = el('button', { class: 'tour-tip__exit', type: 'button', 'aria-label': 'יציאה מהסיור' }, '✕');
  const tip = el('div', { class: 'tour-tip', role: 'dialog', 'aria-label': 'סיור מודרך' },
    el('div', { class: 'tour-tip__head' }, nEl, exitBtn),
    titleEl, textEl,
    el('div', { class: 'tour-tip__actions' }, backBtn, nextBtn),
  );
  // the block layer swallows clicks under the tour; wheel still scrolls the page
  const block = el('div', { class: 'tour-block' }, spot, tip);
  // Hidden until the FIRST step actually resolves. It used to mount visible,
  // which meant an empty card with a live «הבא» sat on screen for as long as
  // the first anchor took to appear (up to WAIT_MS). Clicking it there ran
  // show(i + 1) with i still -1 — i.e. step 0 — and on any page but the
  // gallery step 0 belongs elsewhere, so the tour navigated away and started
  // over from the welcome card. visibility (not display) keeps the tip
  // measurable for positionTip().
  block.style.visibility = 'hidden';
  document.body.appendChild(block);

  let i = startAt;
  let target = null;
  let raf = 0;
  let waiting = 0;    // token guarding stale waitFor results after prev/exit
  // show() awaits (step.before, then waitFor). Anything that supersedes the
  // step in flight — a second click on «הבא», Escape, a cross-page hop —
  // bumps this, and the stale show() returns instead of marching on. Without
  // it an exit mid-wait left a detached tour still stepping and still writing
  // sessionStorage, which resurrected the tour on the next page load.
  let runId = 0;

  // visible = steps that can run: page known, and on THIS page the target
  // exists (checked live in show()). Counter is computed over all steps so
  // numbering stays stable across pages.
  const total = steps.length;

  function save(nextIndex) {
    try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ name, i: nextIndex })); }
    catch { /* private mode */ }
  }

  function exit(done) {
    cancelAnimationFrame(raf);
    waiting++;
    runId++;
    document.removeEventListener('keydown', onKey, true);
    block.remove();
    clearPendingTour();
    active = null;
    if (onDone) onDone(!!done);
  }

  function navigateTo(step, index) {
    save(index);
    let href = '';
    try { href = step.href ? step.href() : ''; } catch { /* fall through */ }
    if (!href) href = step.page + '.html' + q;
    // exit chrome WITHOUT clearing the saved state — the next page resumes
    cancelAnimationFrame(raf);
    waiting++;
    runId++;
    document.removeEventListener('keydown', onKey, true);
    block.remove();
    active = null;
    location.href = href;
  }

  // find the target; dynamic pages render after data lands, so poll briefly
  function waitFor(sel, timeout) {
    const token = ++waiting;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let seenAt = 0;   // when the node first turned up in the DOM at all
      (function look() {
        if (token !== waiting) return resolve(null);         // superseded
        const n = sel ? document.querySelector(sel) : null;
        if (n && visible(n)) return resolve(n);
        // A node that EXISTS but stays invisible is a deliberate empty state,
        // not a page still loading: create-ai's #shelf-wrap carries `hidden`
        // on a board with no AI posts yet. Burning the full timeout on it
        // stalled the tour for nine silent seconds. Absent nodes still get
        // the whole budget — that is the async-page case the timeout is for.
        if (n && !seenAt) seenAt = performance.now();
        if (seenAt && performance.now() - seenAt > 1200) return resolve(null);
        if (performance.now() - t0 > timeout) return resolve(null);
        setTimeout(look, 120);
      })();
    });
  }

  const visible = (n) => {
    const r = n.getBoundingClientRect();
    return (r.width > 1 || r.height > 1) && getComputedStyle(n).visibility !== 'hidden';
  };

  async function show(index, dir) {
    // Walking BACKWARDS off the front of the array is reachable and used to
    // be fatal: on post.html mid-full-tour, «הקודם» descends through every
    // index-page step (they belong to another page), hits 0, and the old
    // `index = 0` line handed step 0 straight back to the same "not my page,
    // go back one" branch — infinite recursion, blown stack. There is nothing
    // before the first step, so backwards simply stops.
    if (index < 0) { if (dir < 0) return; index = 0; }
    if (index >= total) return exit(true);
    const step = steps[index];

    if (step.page && step.page !== page) {
      if (dir < 0) return show(index - 1, dir);   // never navigate backwards
      return navigateTo(step, index);
    }

    const my = ++runId;
    let node = null;
    if (step.at) {
      if (step.before) { try { await step.before(); } catch { /* keep going */ } }
      node = await waitFor(step.at, index === startAt ? WAIT_MS : 2500);
      if (my !== runId) return;   // superseded while awaiting: exit, hop, or a newer step
      if (!node) {
        console.warn('[tour] anchor missing, skipping step:', step.at);
        return show(index + (dir < 0 ? -1 : 1), dir);
      }
    }

    i = index;
    target = node;
    save(index);

    nEl.textContent = `${index + 1} / ${total}`;
    titleEl.textContent = step.title || '';
    textEl.textContent = step.text || '';
    backBtn.disabled = index === 0;
    nextBtn.textContent = index === total - 1 ? 'סיום' : 'הבא';

    // ONE dimming mechanism for every step. The spotlight's giant 200vmax
    // box-shadow is what darkens the page, so a centered card (welcome /
    // finale) keeps the spot in the DOM rather than hiding it: 0×0 at dead
    // centre, cutting out nothing, dimming everything. .tour-spot--center
    // drops the accent ring so no dot shows in the middle of the screen.
    const centered = !node;
    tip.classList.toggle('tour-tip--center', centered);
    spot.classList.toggle('tour-spot--center', centered);
    spot.style.display = '';
    if (centered) {
      spot.style.left = '50%';
      spot.style.top = '50%';
      spot.style.width = '0px';
      spot.style.height = '0px';
      // place() only runs positionTip() when there IS a target, so a centered
      // step that FOLLOWS an anchored one never got its inline left/top
      // cleared and sat wherever the previous tooltip was, ignoring the
      // .tour-tip--center rule. The finale landed 124px off-centre because of
      // exactly this. Clear them here; CSS owns the centred case.
      tip.style.left = '';
      tip.style.top = '';
    }

    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    block.style.visibility = '';    // first step resolved: the tour is now real
    place();
  }

  // follow the target every frame: sticky bars, late layout, slow scroll —
  // the spotlight must never detach from what it points at
  function place() {
    cancelAnimationFrame(raf);
    (function tick() {
      if (!active) return;
      if (target && !document.contains(target)) { spot.style.display = 'none'; }
      else if (target) {
        const r = target.getBoundingClientRect();
        spot.style.left = (r.left - PAD) + 'px';
        spot.style.top = (r.top - PAD) + 'px';
        spot.style.width = (r.width + PAD * 2) + 'px';
        spot.style.height = (r.height + PAD * 2) + 'px';
        positionTip(r);
      }
      raf = requestAnimationFrame(tick);
    })();
  }

  // physical px only — Chromium resolves inline-start against the element's
  // own direction, a trap this project has already paid for once
  function positionTip(r) {
    if (tip.classList.contains('tour-tip--center')) { tip.style.left = tip.style.top = ''; return; }
    const tw = tip.offsetWidth, th = tip.offsetHeight, m = 14;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + m;
    if (top + th > vh - 10) top = r.top - th - m;            // flip above
    if (top < 10) {                                          // beside instead
      top = Math.min(Math.max(10, r.top), vh - th - 10);
      let left = r.left - tw - m;                            // RTL: try start side
      if (left < 10) left = r.right + m;
      tip.style.left = Math.min(Math.max(10, left), vw - tw - 10) + 'px';
      tip.style.top = top + 'px';
      return;
    }
    // align to the target's right edge (RTL reading edge), clamped
    let left = r.right - tw;
    tip.style.left = Math.min(Math.max(10, left), vw - tw - 10) + 'px';
    tip.style.top = top + 'px';
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); return exit(false); }
    if (e.key === 'Enter' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); return show(i + 1, +1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); return show(i - 1, -1); }
  }

  nextBtn.addEventListener('click', () => show(i + 1, +1));
  backBtn.addEventListener('click', () => show(i - 1, -1));
  exitBtn.addEventListener('click', () => exit(false));
  // keydown in CAPTURE phase: post.js's arrow-key slide flip must not fire
  // underneath the tour
  document.addEventListener('keydown', onKey, true);

  active = { exit };
  show(startAt, +1);
  return active;
}
