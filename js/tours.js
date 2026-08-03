// tours.js — WHAT the guided tour says, and the three ways it starts.
// The engine that draws it is tour.js; this file is the script. Self-mounting:
// every page that wants a tour just loads this module after its own.
//
// ══════════════════════════════════════════════════════════════════════════
// THE MAINTENANCE RULE — read this before you move any UI.
//
// Every step below points at a live element through its `at` selector. Those
// selectors are a CONTRACT with the pages: if you rename `#voteBox`, move the
// stage tabs, or change a TABS key in post.js, the anchor stops resolving and
// that step silently vanishes from the tour (the engine skips missing anchors
// rather than crashing — a reviewer would never know the tour got shorter).
//
// So: any session that moves, renames, or deletes a UI element a tour points
// at must keep the anchor working — either leave the id/class in place or
// update the step here — and must run
//
//     node scripts/tours-check.mjs
//
// before landing. That checker is the build-time half of this rule; it reads
// this file, resolves every anchor against the page's own HTML and JS, and
// exits 1 with the broken ones named. Green checker, honest tour.
//
// ALL step definitions live in this one file on purpose. One place to update
// when the UI moves; one place to read when someone asks "what does the tour
// actually claim we do here?".
// ══════════════════════════════════════════════════════════════════════════
//
// No store.js import, deliberately: tours must work before a board loads (and
// store.js imports ui.js, so importing it here would build a cycle). The only
// data this file reads is the DOM in front of it.
//
// DESKTOP ONLY for now (2026-08-03): the mobile layout is mid-build elsewhere,
// so the fab is hidden under 920px (CSS) and the engine refuses to start under
// 920px (tour.js). Revisit both when mobile lands.

import { el, modal } from './ui.js';
import {
  startTour, pendingTour, clearPendingTour, currentPage, pageQuery,
} from './tour.js';

const OFFERED_KEY = 'smr:tour-offered';   // localStorage: the one-time offer fired

// ---------------------------------------------------------------- helpers

// Open a post-page tab before the step that talks about it, so the reviewer
// sees the thing being described instead of a name for it.
const openTab = (key) => () => { document.getElementById('tab-' + key)?.click(); };

// ---------------------------------------------------------------- the steps

const PAGE_TOURS = {

  index: [
    {
      at: '.nav__links',
      title: 'התפריט הראשי',
      text: 'מכאן מגיעים לכל חלקי הכלי: הגלריה, בניית פוסט, יצירה עם AI, השיחות ותור הפרסום.',
    },
    {
      at: '#cat-chips',
      title: 'מדפי הספרייה',
      text: 'כל צ׳יפ הוא נושא: הורות, זוגיות, רילוקיישן ועוד. לחיצה מסננת את הגלריה.',
    },
    {
      at: '#stage-tabs',
      title: 'שלבי הבדיקה',
      text: 'כל פוסט נמצא בשלב: בבדיקה, בעריכה, מאושר או הושלם. הלשוניות מסננות לפי שלב.',
    },
    {
      at: '.g-tools',
      title: 'חיפוש ומיון',
      text: 'חיפוש חופשי בכותרת ובכיתוב, ולידו מיון: לפי פעילות, דירוג, או מה שעוד לא הצבעתם עליו.',
    },
    {
      // renderProgress() in index.js is PERSONAL progress, not board-wide:
      // «הצבעת על N מתוך TOTAL» + a fill bar + a percentage, counting the
      // posts where THIS reviewer has a vote. The copy says «הצבעתם» for
      // that reason; «כמה פוסטים קיבלו הצבעה» would have been a lie.
      at: '#progress',
      title: 'ההתקדמות',
      text: 'על כמה מהפוסטים כבר הצבעתם, מתוך כל הלוח. המטרה: פס מלא.',
    },
    {
      at: '#grid .g-card',
      title: 'כרטיס פוסט',
      text: 'לחיצה על הכרטיס פותחת את עמוד הבדיקה. הפס הצבעוני בצד מסמן איך הצבעתם: ירוק כן, אדום לא, צהוב אולי.',
    },
    {
      at: '.nav__role',
      title: 'באיזה כובע אתם כאן?',
      text: 'צוות טיפולי או שיווק. הבחירה משנה מה מודגש בכלי, לא מה אפשרי.',
    },
    {
      at: '.nav__me',
      title: 'השם שלכם',
      text: 'מופיע ליד ההצבעות וההערות שלכם. לחיצה כאן מחליפה שם.',
    },
  ],

  post: [
    {
      at: '#frame',
      title: 'השקף',
      text: 'כאן רואים את הפוסט, שקף אחרי שקף, כמו שיופיע באינסטגרם.',
    },
    {
      at: '#dots',
      title: 'דפדוף',
      text: 'החצים והנקודות עוברים בין השקפים. גם חצי המקלדת עובדים.',
    },
    {
      at: '#voteBox',
      title: 'ההצבעה',
      text: 'הלב של הבדיקה: 👍 👎 או 🤔, ובכמה מילים למה. אפשר לשנות את ההצבעה בכל שלב.',
    },
    {
      at: '#pinBtn',
      title: 'הערה על השקף',
      text: 'לוחצים כאן ואז על נקודה בשקף. ההערה נשמרת בדיוק במקום שסימנתם.',
    },
    {
      at: '#designBtn',
      title: 'עיצוב',
      text: 'עריכה חיה של השקף עצמו: טקסט, תמונות, רקעים. כל שינוי נשמר ואפשר לבטל.',
    },
    {
      at: '#tabs',
      title: 'הלשוניות',
      text: 'כל השאר נמצא כאן: כיתוב, הערות, עריכת טקסט, תמונות, פרטים, English, יצירת תמונות וספרייה.',
    },
    // The four #tab-* anchors are built by post.js buildTabs() as
    // 'tab-' + t.key over the TABS array — see the DYNAMIC map in
    // scripts/tours-check.mjs, which is what catches a renamed key.
    {
      at: '#tab-caption',
      before: openTab('caption'),
      title: 'הכיתוב',
      text: 'הטקסט שילווה את הפוסט ברשת. אפשר לערוך ולשמור ישירות.',
    },
    {
      at: '#tab-pins',
      before: openTab('pins'),
      title: 'ההערות',
      text: 'כל מה שהוצמד לשקפים, לפי סבבי בדיקה. אפשר להגיב ולסמן שטופל.',
    },
    {
      at: '#tab-edit',
      before: openTab('edit'),
      title: 'עריכת טקסט',
      text: 'כל שדות הטקסט של השקפים בטופס אחד. שינוי מופיע מיד בתצוגה.',
    },
    {
      at: '#tab-trans',
      before: openTab('trans'),
      title: 'English',
      text: 'תרגום לקריאה בלבד, למי שנוח לו באנגלית. השקף בעברית נשאר על המסך.',
    },
    {
      // back to the default tab before we leave the panel alone
      at: '#pvSched',
      before: openTab('caption'),
      title: 'תזמון',
      text: 'קובעים מתי הפוסט מתפרסם, או מתי לחזור לבדוק אותו.',
    },
    {
      at: '#pvApprove',
      title: 'אישור שיווק',
      text: 'חתימה על הגרסה הנוכחית. אם הפוסט משתנה אחרי החתימה, הכלי מסמן שהאישור התיישן.',
    },
    {
      at: '#pvNav',
      title: 'הפוסט הבא',
      text: 'ממשיכים לפוסט הבא בלי לחזור לגלריה.',
    },
  ],

  build: [
    {
      at: '#b-title',
      title: 'שם הפוסט',
      text: 'כך הפוסט ייקרא בגלריה.',
    },
    {
      at: '#fields',
      title: 'הטקסטים',
      text: 'ממלאים את שדות התבנית, השקף מתעדכן תוך כדי הקלדה.',
    },
    {
      at: '#stage',
      title: 'התצוגה',
      text: 'כך השקף ייראה בפועל.',
    },
    {
      at: '#strip',
      title: 'השקפים',
      text: 'מוסיפים שקפים ועוברים ביניהם.',
    },
    {
      at: '#b-save',
      title: 'שמירה',
      text: 'הפוסט נשמר ללוח ומופיע בגלריה תחת «נבנה בכלי».',
    },
  ],

  'create-ai': [
    {
      // hidden on a board with no AI posts yet; the engine skips invisible
      // anchors, so an empty board just gets a two-step tour here
      at: '#shelf-wrap',
      title: 'מה שכבר נוצר',
      text: 'הפוסטים שנוצרו עם AI. החדשים מסומנים.',
    },
    {
      at: '#form',
      title: 'מספרים מה צריך',
      text: 'כותבים במילים שלכם איזה פוסט חסר, והמערכת כותבת ומאיירת אותו. בדרך כלל מוכן תוך יום.',
    },
    {
      at: '#requests',
      title: 'הבקשות שלכם',
      text: 'כאן רואים איפה כל בקשה עומדת: בתור, בעבודה, מוכנה.',
    },
  ],

  generate: [
    {
      at: '#mount',
      title: 'יצירת תמונות',
      text: 'יוצרים איורים ותמונות לספרייה בלי לפתוח פוסט. התוצאות נשמרות בספריית הנכסים.',
    },
  ],

  discuss: [
    {
      at: '#feed',
      title: 'השיחות',
      text: 'כל ההערות מכל הפוסטים בזרם אחד. לחיצה קופצת להערה על השקף שלה.',
    },
  ],

  assets: [
    {
      at: '#toolbar',
      title: 'סינון',
      text: 'מסננים לפי סוג: איורים, תמונות והעלאות.',
    },
    {
      at: '#grid',
      title: 'ספריית הנכסים',
      text: 'כל התמונות והאיורים של הלוח במקום אחד.',
    },
  ],

  queue: [
    {
      at: '#app',
      title: 'תור הפרסום',
      text: 'כל מה שאושר ותוזמן, בסדר שבו יתפרסם. אפשר לעבור בין רשימה ללוח ולגרור כדי לשנות סדר.',
    },
  ],
};

// ---------------------------------------------------------------- the full tour

const WELCOME = {
  page: 'index',
  title: 'ברוכים הבאים ללוח הביקורת',
  text: 'כאן בודקים את הפוסטים של בית בוואלי לפני פרסום: רואים, מצביעים, מעירים ומאשרים. כמה דקות ונכיר הכל.',
};

const FINALE = {
  page: 'queue',
  title: 'זהו, אתם מוכנים',
  text: 'אפשר להפעיל את הסיור שוב בכל עמוד, בכפתור הסיור בפינה למטה. נתראה בגלריה.',
};

// The full tour is COMPOSED from the per-page tours, never a second copy of
// them: fix a sentence once and both tours say the new thing.
// `href` rides only the FIRST step of a block, because that is the step the
// engine navigates for; the post page is the one page that needs a real id in
// the URL, so it gets a resolver instead of the engine's <page>.html default.
function stamp(steps, page, href) {
  return steps.map((s, idx) => ({ ...s, page, ...(idx === 0 && href ? { href } : {}) }));
}

// '' falls through to the engine's own `post.html<query>` default. A board
// with zero cards would land on an id-less post page; the degenerate case is
// accepted rather than special-cased, because a board with no posts has
// nothing to tour anyway.
const hrefFirstPost = () => document.querySelector('#grid .g-card a.g-title')?.href || '';

const FULL = [
  WELCOME,
  ...stamp(PAGE_TOURS.index, 'index'),
  ...stamp(PAGE_TOURS.post, 'post', hrefFirstPost),
  ...stamp(PAGE_TOURS['create-ai'], 'create-ai'),
  ...stamp(PAGE_TOURS.queue, 'queue'),
  FINALE,
];

// ---------------------------------------------------------------- wiring

const page = currentPage();
const steps = PAGE_TOURS[page];

// backend.html and anything else without a tour: this module does nothing at
// all, not even a fab.
if (steps) mount();

function mount() {
  const fab = buildFab();
  document.body.append(fab.menu, fab.btn);

  // 1. resume — a cross-page hop mid-full-tour left its place in sessionStorage
  const pending = pendingTour();
  if (pending && pending.name === 'full') {
    clearPendingTour();
    run(FULL, { name: 'full', startAt: pending.i || 0 });
  } else {
    if (pending) clearPendingTour();       // stale 'page' state, never resumes
    // 2. the operator's screen-recording hook
    const want = new URLSearchParams(location.search).get('tour');
    if (want === 'full') startFull();
    else if (want === 'page') run(steps, { name: 'page' });
  }

  // 3. the one-time offer, the first time someone tells the tool their name
  window.addEventListener('smr:first-name', onFirstName);

  // --------------------------------------------------------------- runner

  // The fab must not sit lit under the dim while a tour runs. `hidden` alone
  // would NOT hide it: .tour-fab declares `display: inline-flex` and
  // .tour-fab-menu `display: grid`, and an author display beats the UA
  // `[hidden] {display:none}` rule — the trap post.html documents at length.
  // app.css carries explicit `[hidden]` rules for both; these lines only work
  // because of them.
  function run(list, opts = {}) {
    fab.close();
    fab.btn.hidden = true;
    const t = startTour(list, {
      ...opts,
      onDone: () => { fab.btn.hidden = false; },
    });
    if (!t) fab.btn.hidden = false;        // refused: viewport under 920px
    return t;
  }

  // The full tour always opens on the gallery. From anywhere else: save the
  // starting place and hop there, exactly the way the engine hops between
  // pages mid-tour. pageQuery() keeps board/local and drops ?tour, so the
  // landing page resumes instead of restarting.
  function startFull() {
    if (page === 'index') return run(FULL, { name: 'full', startAt: 0 });
    try { sessionStorage.setItem('smr:tour', JSON.stringify({ name: 'full', i: 0 })); }
    catch { /* private mode: the tour just starts fresh on arrival */ }
    location.href = 'index.html' + pageQuery();
    return null;
  }

  // --------------------------------------------------------------- the fab

  function buildFab() {
    const pageBtn = el('button', {
      class: 'tour-fab-menu__opt', type: 'button',
      onclick: () => run(steps, { name: 'page' }),
    }, 'סיור בעמוד הזה');

    const fullBtn = el('button', {
      class: 'tour-fab-menu__opt', type: 'button',
      onclick: () => { close(); startFull(); },
    }, 'הסיור המלא');

    const menu = el('div', {
      class: 'tour-fab-menu', role: 'menu', hidden: true,
    }, pageBtn, fullBtn);

    const btn = el('button', {
      class: 'tour-fab', type: 'button',
      'aria-haspopup': 'true', 'aria-expanded': 'false',
      title: 'סיור מודרך בכלי',
      onclick: (e) => { e.stopPropagation(); if (menu.hidden) open(); else close(); },
    }, '? סיור');

    function open() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onOutside, true);
      document.addEventListener('keydown', onEsc, true);
    }
    function close() {
      if (menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onOutside, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    const onOutside = (e) => { if (!menu.contains(e.target) && e.target !== btn) close(); };
    const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

    // Two siblings, not a wrapper: both are `position: fixed` anyway, and a
    // wrapper would need `display: contents` — which re-opens the very
    // `[hidden]` trap run() works around above.
    return { btn, menu, close };
  }

  // ------------------------------------------------------- first-name offer

  // store.js's ensureName() fires this the FIRST time a reviewer names
  // themselves (never on a later rename from the nav chip). One offer per
  // browser, ever — localStorage, set before the modal opens so a reload
  // mid-decision does not ask twice.
  function onFirstName() {
    let offered = null;
    try { offered = localStorage.getItem(OFFERED_KEY); } catch { /* private mode */ }
    if (offered) return;
    if (window.innerWidth < 920) return;            // mobile layout mid-build
    try { localStorage.setItem(OFFERED_KEY, '1'); } catch { /* private mode */ }

    // let the naming modal finish closing (ui.js removes it on a 160ms fade)
    setTimeout(() => {
      modal('רוצים סיור קצר?',
        el('p', { class: 'tour-offer__text' },
          'נראה לכם איפה כל דבר נמצא: ההצבעה, ההערות, העריכה והתזמון. אפשר לצאת בכל שלב.'),
        {
          dismissable: false,
          actions: [
            { label: 'התחלת סיור', primary: true, onClick: () => { startFull(); } },
            { label: 'דילוג על הסיור', onClick: () => {} },
          ],
        });
    }, 240);
  }
}
