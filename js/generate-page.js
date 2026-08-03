// generate-page.js — standalone host for the «יצירת תמונות» module. (owner:
// image-generation module)
// The exact same tab that lives inside a post, mounted from the main menu with
// no post attached: generateTab({postId: null}) — drawings, photos and styles
// land in the asset library instead of on a slide. generate.js was written to
// be mountable from any host page (its .gen-* styles live at the end of
// css/app.css for that reason); this page is simply that host.

import { initStore } from './store.js';
import { navBar } from './ui.js';
import { generateTab } from './generate.js';

const $ = (id) => document.getElementById(id);

(async () => {
  try {
    await initStore();
  } catch (e) {
    document.body.textContent = String((e && e.message) || e);
    return;
  }
  $('nav').replaceChildren(navBar('generate'));
  $('mount').replaceChildren(generateTab({}));
})();
