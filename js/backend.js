// backend.js — boot for the developer docs page (backend.html).
// Static documentation: no data reads beyond initStore (board name for the
// nav) — store.js stays the only network module, and this page only uses it
// to resolve the board so the shared navBar renders like everywhere else.

import { initStore } from './store.js';
import { navBar } from './ui.js';

(async function boot() {
  try {
    await initStore();
  } catch {
    // Docs must render even with no board reachable (e.g. opened raw).
  }
  const slot = document.getElementById('nav');
  if (slot) slot.replaceChildren(navBar('backend'));
})();
