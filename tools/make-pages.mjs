// The intent pages on skrim.app.
//
//   node tools/make-pages.mjs
//
// One page per question a person actually types into Google, plus the guide
// they all point back to. Written into ./site, which is what wrangler deploys,
// alongside index/privacy/restore rather than in a subdirectory -- a URL like
// skrim.app/hide-bookmarks-bar-zoom is the whole point and a /guides/ prefix
// buys nothing.
//
// WHY A GENERATOR AND NOT FOUR HTML FILES
//
// Same reason make-social.mjs exists: the chrome around the content -- tokens,
// header, waitlist form, footer, meta tags -- is identical on every page and a
// hand-copied one drifts. The prose is not shared. It sits in PAGES below, one
// entry per page, and each entry is genuinely different writing because the
// answers genuinely differ. That distinction is load-bearing:
//
//   MARKETING-PLAN.md § 5d: "Do not spin up dozens of thin doorway pages.
//   Google demotes them and it reads as spam. Few pages, each actually
//   answering the question."
//
// So the rule for adding a page here is not "is there a keyword" but "is there
// an answer that is different from the answers already on the site". If the
// only thing that changes is the product name in the H1, do not add the page.
//
// EVERY PAGE MUST SURVIVE CLAIMS.md
//
// These are public copy. The Zoom page in particular exists mostly to say the
// thing the product cannot do -- the Zoom desktop client captures outside
// Chrome and no extension can see it -- because the person searching that term
// is more likely than not using the desktop app, and a page that let them
// install first and find out second would cost more than the traffic is worth.

import { writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const ORIGIN = "https://skrim.app";

// ---------------------------------------------------------------- the switch
//
// null until the listing is public. Every page renders the waitlist form while
// it is null and an "Add to Chrome" button once it holds a URL, so launch day
// is one edit here and one re-run rather than four files hand-edited under
// time pressure. Same discipline as {{STORE_URL}} in skrim-gtm/content.
//
// Do not set it until you have opened the public URL in a signed-out browser
// and seen the listing yourself. (CLAIMS.md: "It's live" is a claim.)
const STORE_URL = null;

// --------------------------------------------------------------------- copy

// Shared closing section. Identical on every page on purpose: it is the
// product description, and rewriting it four ways to look different is exactly
// the doorway-page tell we are avoiding. Google is fine with a repeated block;
// it is not fine with a page that is only a repeated block.
const WHAT_SKRIM_IS = `
<h2>Where Skrim comes in</h2>
<p>
  Skrim is a free Chrome extension that does one thing: it watches for a screen
  share starting and takes your bookmarks bar down before the first frame goes
  out, then puts every bookmark back at the exact position it came from when
  the share ends. There is nothing to remember and nothing to press.
</p>
<p>
  It makes no network requests of any kind — no server, no account, no
  analytics — and that is a claim you can check rather than one you have to
  take: the extension is source-available, and one <code>grep</code> for
  <code>fetch</code> across the code comes back empty.
</p>`;

// The limits block. Also identical everywhere, also on purpose -- it is the
// same set of facts, and it is the part CLAIMS.md says to say out loud rather
// than bury. Each page adds its own most-relevant limit above this.
const LIMITS = `
<h2>What it does not cover</h2>
<ul>
  <li>
    <b>Desktop apps.</b> The Zoom desktop client, the Loom desktop app, OBS and
    QuickTime capture outside Chrome entirely, where no extension can see them.
  </li>
  <li>
    <b>Chrome's own share picker preview.</b> On a site that asks for your
    screen the instant it loads, the thumbnail Chrome draws inside the picker
    can still show the bar for a moment. Google Meet and Zoom on the web both
    preview clean, but it is a limit of the picker, not something an extension
    can reach.
  </li>
  <li>
    <b>Anything other than the bookmarks bar.</b> Not your tabs, not your
    notifications, not your desktop. One bar is the whole job.
  </li>
</ul>`;

const SYNC_NOTE = `
<aside class="note">
  <b>If you use Chrome Sync:</b> bookmarks are synced data, so while the bar is
  hidden here it is also empty on your other signed-in devices until the share
  ends. That is Chrome's sync doing what you turned it on to do — Skrim sends
  nothing anywhere. Sharing a single tab releases within seconds, and there is a
  setting that tucks the bar into one folder instead of clearing it, if you
  would rather your other computers kept theirs.
</aside>`;

const PAGES = [
  // ------------------------------------------------------------------ pillar
  {
    slug: "hide-bookmarks-bar",
    title: "How to hide your bookmarks bar in Chrome (4 ways, honestly compared)",
    description:
      "Four ways to hide the Chrome bookmarks bar: the shortcut, the setting, a second profile, and doing it automatically. What each protects you from, and how each fails",
    h1: "How to hide your bookmarks bar in Chrome",
    // The direct answer, first thing on the page. Written to be liftable as a
    // featured snippet: the question, answered, in the first forty words.
    answer: `
      <p>
        Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on Windows and Linux,
        or <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on a Mac. The bar toggles
        off immediately. The same shortcut brings it back.
      </p>
      <p>
        That is the answer to the literal question. If you are here because
        something on that bar was nearly seen by someone else, the shortcut is
        not really the answer, and the rest of this page is about why.
      </p>`,
    body: `
      <h2>The four ways, and what each is actually for</h2>

      <h3>1. The keyboard shortcut</h3>
      <p>
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>, or
        <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on a Mac. Instant, free,
        nothing to install, and it is the right tool if what you want is a
        cleaner window while you work.
      </p>
      <p>
        It is the wrong tool for a screen share, for one reason: it depends on
        you. It has to be pressed before the share picker opens, on every call,
        forever — and the one call where it matters is the one where you were
        already late, already talking, and already sharing.
      </p>
      <p class="check">
        Worth checking on your own machine: Chrome has long kept showing the
        bookmarks bar on the New Tab page even when the bar is toggled off. Open
        a new tab after you hide it and see what yours does before you rely on it.
      </p>

      <h3>2. The setting</h3>
      <p>
        <b>Settings → Appearance → Show bookmarks bar.</b> The same toggle, in a
        place you can find without remembering a shortcut. It persists, which
        makes it the honest choice if you have decided you simply do not want the
        bar — but it also means living without your bookmarks the rest of the
        time, which is why most people turn it back on within a week.
      </p>

      <h3>3. A separate Chrome profile for calls</h3>
      <p>
        Make a second profile with an empty bookmarks bar and present from it.
        This genuinely works, and it is the only option here that also hides your
        tabs, your history and your extensions. The cost is that you have to
        switch to it before the call, sign in to whatever you are demoing, and
        keep two profiles in step. It is a real answer for anyone who demos for a
        living. It is a lot of ceremony for a Tuesday stand-up.
      </p>

      <h3>4. Have it happen on its own</h3>
      <p>
        The last option is to stop relying on remembering. An extension can watch
        for the moment a screen share starts and clear the bar before the first
        frame leaves your machine, then put it back when the share stops. Nothing
        to press, nothing to switch to, and no way to forget it.
      </p>

      <h2>Side by side</h2>
      <div class="scroller">
      <table>
        <thead>
          <tr><th>Way</th><th>Effort per call</th><th>How it fails</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Keyboard shortcut</td>
            <td>Remember it, every time</td>
            <td>You forget once</td>
          </tr>
          <tr>
            <td>The setting</td>
            <td>None, but it stays off</td>
            <td>You turn it back on and forget you did</td>
          </tr>
          <tr>
            <td>Second profile</td>
            <td>Switch profiles, sign in</td>
            <td>You present from the wrong one</td>
          </tr>
          <tr>
            <td>Automatic</td>
            <td>None</td>
            <td>Only covers Chrome — see the limits below</td>
          </tr>
        </tbody>
      </table>
      </div>

      <h2>One thing that helps whatever you choose</h2>
      <p>
        <b>Share a tab, not your whole screen.</b> When you share a single tab,
        the bookmarks bar is not part of what is captured — the browser chrome
        around the tab simply is not in the picture. Google Meet and Zoom both
        offer it and both suggest it by default. It is the cheapest protection
        available and it costs nothing to make a habit.
      </p>
      ${WHAT_SKRIM_IS}
      ${LIMITS}
      ${SYNC_NOTE}`,
    related: ["hide-bookmarks-bar-google-meet", "hide-bookmarks-bar-zoom", "hide-bookmarks-bar-screen-recording"],
  },

  // -------------------------------------------------------------------- meet
  {
    slug: "hide-bookmarks-bar-google-meet",
    title: "How to hide your bookmarks bar in Google Meet",
    description:
      "Google Meet runs in the browser, so your bookmarks bar is fully solvable there. The manual fix, the sharing habit that helps more, and how to make it automatic.",
    h1: "How to hide your bookmarks bar in Google Meet",
    answer: `
      <p>
        Before you share, press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
        (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on a Mac) to toggle the bar
        off, or share a <b>single tab</b> instead of your whole screen — a shared
        tab cannot contain the bookmarks bar at all.
      </p>
      <p>
        Meet runs entirely in the browser, which means this is one of the cases
        that is completely solvable. Everything below is about making it
        reliable rather than remembered.
      </p>`,
    body: `
      <h2>Why Meet is the easy case</h2>
      <p>
        Google Meet asks Chrome for your screen using the browser's own
        screen-share API. Everything happens inside Chrome, which means Chrome
        knows a share has started — and so can anything running inside Chrome.
        Compare that with a desktop conferencing app, which captures your screen
        at the operating-system level where the browser has no idea it is
        happening.
      </p>

      <h2>The three-second version</h2>
      <ol>
        <li>
          <b>Pick "Chrome Tab" in the share dialog</b> when what you are showing
          is a web page. It is the first option Meet offers. The bookmarks bar is
          not part of a captured tab, so there is nothing to hide.
        </li>
        <li>
          <b>If you must share a window or your whole screen</b>, toggle the bar
          off with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> before you open
          the picker — not after, because the picker's own preview thumbnail is
          drawn the moment it opens.
        </li>
        <li>
          <b>Turn it back on afterwards</b>, which is the step everyone forgets,
          and which is why the bar is up again by the next call.
        </li>
      </ol>

      <h2>The failure this actually has</h2>
      <p>
        None of that is difficult. It is just conditional on you doing it while
        someone is talking to you, on a call you joined forty seconds late, on
        the day you happened to have the other client's renewal doc pinned to the
        bar. The problem was never that hiding the bar is hard. It is that
        remembering to is a coin flip, and the downside is not symmetrical.
      </p>
      ${WHAT_SKRIM_IS}
      <p>
        Meet is one of the two surfaces tested end to end in a real browser, and
        Meet's own picker previews clean.
      </p>
      ${LIMITS}
      ${SYNC_NOTE}`,
    related: ["hide-bookmarks-bar", "hide-bookmarks-bar-zoom", "hide-bookmarks-bar-screen-recording"],
  },

  // -------------------------------------------------------------------- zoom
  {
    slug: "hide-bookmarks-bar-zoom",
    title: "How to hide your bookmarks bar in Zoom (desktop app and web)",
    description:
      "Whether your bookmarks bar can be hidden automatically in Zoom depends on which Zoom you use — the desktop app or a browser tab. The honest answer for both.",
    h1: "How to hide your bookmarks bar in Zoom",
    // This page leads with the bad news deliberately. Someone searching this
    // term is more likely on the desktop client, and letting them install
    // first and discover second is the one mistake that would cost more than
    // the traffic earns.
    answer: `
      <p>
        It depends on which Zoom you use, and the difference matters more than
        anything else on this page.
      </p>
      <ul class="split">
        <li>
          <b>Zoom desktop app</b> — no browser extension can help you, including
          this one. The app captures your screen outside Chrome, where nothing
          running inside Chrome can see it. Your options are manual, and they are
          below.
        </li>
        <li>
          <b>Zoom in a browser tab</b> — fully solvable, automatically.
        </li>
      </ul>`,
    body: `
      <h2>If you use the Zoom desktop app</h2>
      <p>
        This is most people, and it is worth being blunt about: an extension runs
        inside Chrome and can only know about things Chrome knows about. When the
        Zoom desktop client captures your screen, it asks the operating system,
        not the browser. Chrome is never told. Any extension claiming to cover
        that case is claiming something it cannot do.
      </p>
      <p>What actually works there:</p>
      <ol>
        <li>
          <b>Share a specific window rather than your whole screen.</b> Zoom's
          picker lets you choose one application window. If you pick a window
          that is not Chrome, your bookmarks bar was never in frame to begin with.
        </li>
        <li>
          <b>If you are sharing Chrome itself</b>, press
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
          (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on a Mac) before you click
          Share, and put it back after.
        </li>
        <li>
          <b>Keep a second Chrome profile for presenting</b>, with a deliberately
          empty bar. More setup, but it is the only one of these that cannot be
          undone by forgetting.
        </li>
      </ol>

      <h2>If you use Zoom in a browser tab</h2>
      <p>
        Zoom on the web goes through Chrome's own screen-share API, exactly like
        Google Meet. Chrome knows the share started, so an extension can act on
        it — and Zoom on the web is one of the two surfaces Skrim is tested
        against end to end in a real browser.
      </p>
      <p>
        Note that "Zoom on the web" means the meeting genuinely running in a
        browser tab. If clicking a Zoom link hands off to the installed
        application, you are in the first section, not this one.
      </p>
      ${WHAT_SKRIM_IS}
      ${LIMITS}
      ${SYNC_NOTE}`,
    related: ["hide-bookmarks-bar", "hide-bookmarks-bar-google-meet", "hide-bookmarks-bar-screen-recording"],
  },

  // --------------------------------------------------------------- recording
  {
    slug: "hide-bookmarks-bar-screen-recording",
    title: "How to hide your bookmarks bar when recording your screen",
    description:
      "A recording keeps whatever was on your bookmarks bar for as long as the file exists. What to check before you record, and which recorders an extension reaches.",
    h1: "How to hide your bookmarks bar when you record your screen",
    answer: `
      <p>
        Toggle the bar off with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>
        (<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on a Mac) <em>before</em> you
        start recording, and record a single tab or a single window rather than
        your whole screen wherever the tool allows it.
      </p>
      <p>
        Recording deserves more care than a live call, for one reason: a call is
        over in an hour and a recording is a file. Whatever was on your bar is in
        that file for as long as it exists, in every copy of it, on every drive
        it is ever synced to.
      </p>`,
    body: `
      <h2>The pre-flight, in order</h2>
      <ol>
        <li>
          <b>Bookmarks bar off.</b> The shortcut above. Do it before the recorder
          opens its picker, because some pickers draw a live preview thumbnail
          the moment they appear.
        </li>
        <li>
          <b>Record the narrowest thing that shows the point.</b> A tab beats a
          window; a window beats the whole screen. A captured tab cannot contain
          the browser chrome around it, bookmarks bar included.
        </li>
        <li>
          <b>Check the first ten seconds before you publish.</b> Most leaks are
          in the frames before the recorder settled and you started talking.
        </li>
        <li>
          <b>Then check your notifications settings</b>, which is the other thing
          that ruins a take, and which nothing on this page can help you with.
        </li>
      </ol>

      <h2>Which recorders an extension can reach</h2>
      <p>
        The dividing line is the same one that decides everything else here:
        whether the capture goes through Chrome.
      </p>
      <div class="scroller">
      <table>
        <thead><tr><th>Recorder</th><th>Reachable from inside Chrome?</th></tr></thead>
        <tbody>
          <tr><td>Loom's Chrome extension recorder</td><td>Yes</td></tr>
          <tr><td>Any site using Chrome's screen-share API</td><td>Yes</td></tr>
          <tr><td>Loom desktop app</td><td>No</td></tr>
          <tr><td>OBS</td><td>No</td></tr>
          <tr><td>QuickTime, and macOS screen recording</td><td>No</td></tr>
        </tbody>
      </table>
      </div>
      <p>
        The "no" rows are not a gap waiting to be filled in a later version.
        They capture at the operating-system level, and no browser extension —
        this one or any other — can see that happening.
      </p>
      ${WHAT_SKRIM_IS}
      ${LIMITS}
      ${SYNC_NOTE}`,
    related: ["hide-bookmarks-bar", "hide-bookmarks-bar-google-meet", "hide-bookmarks-bar-zoom"],
  },
];

// -------------------------------------------------------------- wall of love

// Reactions from real people, collected from Day 08 onward.
//
// THE RULES, WHICH ARE NOT NEGOTIABLE:
//
//   1. Ask before you use one. Every entry needs the person's explicit yes to
//      being quoted by name on skrim.app. A public post is not consent.
//   2. Quote them exactly. Trim with an ellipsis if it is long; never reword,
//      never fix their grammar, never merge two sentences that were apart.
//   3. Nothing invented, nothing composited, nothing from a friend who was
//      asked to say something nice. The page is worthless the moment one entry
//      is not real, and its whole job is to be believed.
//   4. `where` is the platform, not a link -- a link out of a page whose job is
//      to convert is a leak, and a dead link a year from now looks worse than
//      no link at all.
//
// The page is NOT written while this array is empty. An empty wall of love
// says "nobody has said anything nice yet", which is the opposite of the
// intended effect. Add the first real quote, re-run, and it appears -- in the
// sitemap and in the site footer at the same time.
//
//   { quote: "...", who: "Name", role: "what they do", where: "LinkedIn" }
const QUOTES = [];

const wallPage = () => ({
  slug: "wall",
  title: "What people say about Skrim",
  description:
    "Unedited reactions from people using Skrim, quoted with their permission.",
  h1: "What people say",
  answer: `
      <p>
        Every quote below is someone else's words, unedited, used with their
        permission. Nothing here was solicited in exchange for anything.
      </p>`,
  body: `
      <div class="wall">
        ${QUOTES.map(
          (q) => `<figure>
          <blockquote>${q.quote}</blockquote>
          <figcaption><b>${q.who}</b> — ${q.role} <span>· ${q.where}</span></figcaption>
        </figure>`,
        ).join("\n        ")}
      </div>
      <p class="check">
        Used Skrim and it saved you something? Tell me at
        <a href="mailto:support@skrim.app">support@skrim.app</a>. I will ask
        before quoting you anywhere.
      </p>`,
  related: ["hide-bookmarks-bar", "hide-bookmarks-bar-google-meet", "hide-bookmarks-bar-zoom"],
});

// ------------------------------------------------------------------ template

// The wall joins the build only once it has something on it. Everything
// downstream -- sitemap, footer link, related-rail validation -- reads this
// list, so one condition governs the whole thing.
const ALL = QUOTES.length ? [...PAGES, wallPage()] : [...PAGES];

const bySlug = Object.fromEntries(ALL.map((p) => [p.slug, p]));

/** Short link text for the "related" rail -- the H1 without the how-to prefix. */
const SHORT = {
  "hide-bookmarks-bar": "The full guide: four ways to hide it in Chrome",
  "hide-bookmarks-bar-google-meet": "Hiding it in Google Meet",
  "hide-bookmarks-bar-zoom": "Hiding it in Zoom (desktop and web)",
  "hide-bookmarks-bar-screen-recording": "Hiding it while recording your screen",
  wall: "What people say about Skrim",
};

// The CTA. Waitlist until STORE_URL is set, "Add to Chrome" after. The form
// carries the page slug in a hidden field so the weekly read can tell which
// question actually converts -- which is the whole reason these pages are
// separate URLs rather than one long article.
const cta = (slug) =>
  STORE_URL
    ? `
      <section class="cta" id="get">
        <h2>Have it happen on its own</h2>
        <p>
          Free, no account, and it makes no network requests of any kind.
          Chrome 116 or later.
        </p>
        <p><a class="button" href="${STORE_URL}">Add to Chrome</a></p>
      </section>`
    : `
      <section class="cta" id="get">
        <h2>Have it happen on its own</h2>
        <p>
          Skrim is in review for the Chrome Web Store. One email when it ships,
          and nothing else.
        </p>
        <form id="form" method="POST" action="/api/waitlist">
          <label class="hp" aria-hidden="true">
            Company
            <input type="text" name="company" tabindex="-1" autocomplete="off" />
          </label>
          <input type="hidden" name="source" value="${slug}" />
          <input type="hidden" name="page" value="/${slug}" />
          <label class="sr" for="email">Email address</label>
          <input id="email" type="email" name="email" required autocomplete="email"
                 placeholder="you@example.com" />
          <button type="submit" id="submit">Notify me</button>
        </form>
        <p class="note" id="note" hidden></p>
        <p class="fineprint">
          We store your address and the date, and use it once — to tell you Skrim
          is out. See the <a href="/privacy#website">privacy policy</a>.
        </p>
      </section>`;

// Only shipped with the waitlist form. Identical behaviour to index.html's
// script; the no-JS path posts natively and the worker sends the reader back
// to this page rather than to the homepage.
const FORM_SCRIPT = `
    <script>
      (function () {
        var form = document.getElementById("form");
        if (!form) return;
        var note = document.getElementById("note");
        var submit = document.getElementById("submit");
        var THANKS = "Thanks — we will email you when Skrim is live.";

        function say(text, tone) {
          note.textContent = text;
          note.setAttribute("data-tone", tone);
          note.hidden = false;
        }

        form.addEventListener("submit", function (event) {
          event.preventDefault();
          if (!form.email.checkValidity()) {
            say("That does not look like an email address.", "bad");
            form.email.focus();
            return;
          }
          submit.disabled = true;
          submit.textContent = "Sending…";
          fetch("/api/waitlist", {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(Object.fromEntries(new FormData(form))),
          })
            .then(function (r) { return r.json().catch(function () { return { ok: r.ok }; }); })
            .then(function (body) {
              if (body && body.ok) { form.hidden = true; say(THANKS, "ok"); }
              else {
                say("That does not look like an email address.", "bad");
                submit.disabled = false; submit.textContent = "Notify me";
              }
            })
            .catch(function () {
              say("Could not reach the server. Try again in a moment.", "bad");
              submit.disabled = false; submit.textContent = "Notify me";
            });
        });

        var params = new URLSearchParams(location.search);
        if (params.has("joined")) { form.hidden = true; say(THANKS, "ok"); }
        else if (params.has("invalid")) { say("That does not look like an email address.", "bad"); }
      })();
    </script>`;

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true">
          <defs><clipPath id="c"><rect x="2" y="2" width="28" height="28" rx="6" /></clipPath></defs>
          <rect x="2" y="2" width="28" height="28" rx="6" fill="#0A100E" />
          <rect x="7.5" y="14.5" width="15" height="3" rx="1.5" fill="#17DE82" opacity=".5" />
          <rect x="7.5" y="20.5" width="10" height="3" rx="1.5" fill="#17DE82" opacity=".5" />
          <g clip-path="url(#c)"><rect x="2" y="2" width="28" height="11.5" fill="#17DE82" /></g>
        </svg>`;

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3CclipPath id='c'%3E%3Crect x='2' y='2' width='28' height='28' rx='6'/%3E%3C/clipPath%3E%3C/defs%3E%3Crect x='2' y='2' width='28' height='28' rx='6' fill='%230A100E'/%3E%3Crect x='7.5' y='14.5' width='15' height='3' rx='1.5' fill='%2317DE82' opacity='.5'/%3E%3Crect x='7.5' y='20.5' width='10' height='3' rx='1.5' fill='%2317DE82' opacity='.5'/%3E%3Cg clip-path='url(%23c)'%3E%3Crect x='2' y='2' width='28' height='11.5' fill='%2317DE82'/%3E%3C/g%3E%3C/svg%3E";

// Tokens copied from brand/tokens.css rather than imported, exactly as
// index.html does it and for the same reason: these pages must render from a
// cache, years from now, with nothing external resolving.
const STYLE = `
      :root {
        color-scheme: light dark;
        --green-400: #17de82; --green-500: #00c36d; --green-700: #00854b;
        --bg: #fff; --surface: #f4f6f5; --surface-2: #eaedeb;
        --line: rgba(10,16,14,.09); --line-strong: rgba(10,16,14,.16);
        --text: #0a100e; --muted: #4d5854;
        --accent: var(--green-400); --accent-hover: var(--green-500);
        --accent-text: var(--green-700); --on-accent: #0a100e;
        --radius-sm: 7px; --radius-md: 9px; --radius-lg: 14px;
        --ease: cubic-bezier(.2,0,0,1);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0a100e; --surface: #161d1a; --surface-2: #28312d;
          --line: rgba(255,255,255,.09); --line-strong: rgba(255,255,255,.18);
          --text: #eaedeb; --muted: #a3aea8; --accent-text: var(--green-400);
        }
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; background: var(--bg); color: var(--text);
        font: 16px/1.65 system-ui, -apple-system, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .wrap { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }

      header { display: flex; align-items: center; gap: .6rem; margin-bottom: 3rem; }
      header svg { display: block; width: 28px; height: 28px; }
      header a { color: inherit; text-decoration: none; font-weight: 700; letter-spacing: -.01em; }

      h1 { font-size: clamp(1.75rem, 5vw, 2.5rem); line-height: 1.12;
           letter-spacing: -.03em; margin: 0 0 1.25rem; text-wrap: balance; }
      h2 { font-size: 1.3rem; letter-spacing: -.02em; margin: 3rem 0 .75rem; }
      h3 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
      p, li { color: var(--muted); }
      b, strong { color: var(--text); font-weight: 600; }
      /* The direct answer, first thing under the H1. Sits in the page's own
         voice rather than a callout box -- a box reads as an ad. */
      .answer p { color: var(--text); font-size: 1.1rem; }
      .answer p:first-child { font-weight: 500; }
      ul, ol { padding-left: 1.35rem; }
      li { margin-bottom: .5rem; }
      ul.split { list-style: none; padding: 0; }
      ul.split li {
        border-left: 3px solid var(--line-strong); padding-left: .9rem;
        margin-bottom: .9rem;
      }
      code { font-family: ui-monospace, Menlo, monospace; font-size: .9em;
             background: var(--surface-2); padding: .1em .35em; border-radius: 4px; }
      kbd {
        font-family: ui-monospace, Menlo, monospace; font-size: .82em;
        background: var(--surface); border: 1px solid var(--line-strong);
        border-bottom-width: 2px; border-radius: 5px; padding: .12em .4em;
        color: var(--text); white-space: nowrap;
      }
      /* Wide content scrolls inside itself; the page never scrolls sideways. */
      .scroller { overflow-x: auto; margin: 1rem 0 0; }
      table { border-collapse: collapse; width: 100%; min-width: 30rem; font-size: .95rem; }
      th, td { text-align: left; padding: .6rem .8rem; border-bottom: 1px solid var(--line); }
      th { color: var(--text); font-weight: 600; }
      td { color: var(--muted); }
      .note {
        margin: 2rem 0 0; padding: 1rem 1.1rem; background: var(--surface);
        border: 1px solid var(--line); border-radius: var(--radius-lg);
        font-size: .95rem; color: var(--muted);
      }
      p.check { font-size: .95rem; border-left: 3px solid var(--line-strong); padding-left: .9rem; }

      .cta {
        margin: 3.5rem 0 0; padding: 1.75rem 1.5rem; background: var(--surface);
        border: 1px solid var(--line-strong); border-radius: var(--radius-lg);
      }
      .cta h2 { margin: 0 0 .4rem; font-size: 1.25rem; }
      .cta p { margin: 0 0 1.25rem; font-size: .95rem; }
      form { display: flex; gap: .5rem; flex-wrap: wrap; }
      input[type="email"] {
        flex: 1 1 16rem; min-width: 0; font: inherit; font-size: .95rem;
        color: var(--text); background: var(--bg);
        border: 1px solid var(--line-strong); border-radius: var(--radius-md);
        padding: .6rem .75rem;
      }
      input[type="email"]:focus-visible {
        outline: none; border-color: transparent;
        box-shadow: 0 0 0 1px var(--bg), 0 0 0 3px var(--accent-hover);
      }
      button, .button {
        flex: none; font: inherit; font-size: .95rem; font-weight: 600;
        color: var(--on-accent); background: var(--accent);
        border: 1px solid transparent; border-radius: var(--radius-md);
        padding: .6rem 1.1rem; cursor: pointer; text-decoration: none;
        display: inline-block;
      }
      button:hover, .button:hover { background: var(--accent-hover); }
      button:focus-visible, .button:focus-visible {
        outline: none; box-shadow: 0 0 0 1px var(--bg), 0 0 0 3px var(--accent-hover);
      }
      button[disabled] { opacity: .6; cursor: default; }
      .sr, .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
      .cta .note { margin: .9rem 0 0; padding: 0; background: none; border: 0; font-size: .85rem; }
      .cta .note[data-tone="ok"] { color: var(--accent-text); font-weight: 600; }
      .cta .note[data-tone="bad"] { color: var(--text); }
      .fineprint { margin: .9rem 0 0 !important; font-size: .8rem; color: var(--muted); }

      /* Wall of love. Deliberately plain -- no avatars, no five-star rows, no
         card shadows. A testimonial that looks like an ad gets read as one. */
      .wall { display: grid; gap: 1.25rem; margin-top: 1.5rem; }
      .wall figure {
        margin: 0; padding: 1.1rem 1.25rem; background: var(--surface);
        border: 1px solid var(--line); border-radius: var(--radius-lg);
      }
      .wall blockquote { margin: 0 0 .6rem; color: var(--text); font-size: 1.05rem; }
      .wall figcaption { font-size: .875rem; color: var(--muted); }
      .wall figcaption span { opacity: .75; }

      .related { margin-top: 3.5rem; }
      .related h2 { font-size: 1rem; margin-bottom: .6rem; }
      .related ul { list-style: none; padding: 0; margin: 0; }
      .related li { margin-bottom: .4rem; }

      footer {
        margin-top: 3.5rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
        display: flex; gap: 1.25rem; flex-wrap: wrap;
        font-size: .875rem; color: var(--muted);
      }
      a { color: var(--accent-text); text-decoration-thickness: 1px; text-underline-offset: 2px; }
      footer a { color: var(--muted); }
      footer a:hover { color: var(--text); }
      [hidden] { display: none !important; }`;

function render(page) {
  const url = `${ORIGIN}/${page.slug}`;
  const related = page.related
    .map((slug) => `<li><a href="/${slug}">${SHORT[slug]}</a></li>`)
    .join("\n          ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${page.title} — Skrim</title>
    <meta name="description" content="${page.description}" />
    <link rel="canonical" href="${url}" />
    <meta property="og:title" content="${page.h1}" />
    <meta property="og:description" content="${page.description}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:type" content="article" />
    <meta property="og:image" content="${ORIGIN}/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${ORIGIN}/og.png" />
    <link rel="icon" href="${FAVICON}" />
    <style>${STYLE}
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        ${MARK}
        <a href="/">Skrim</a>
      </header>

      <main>
        <h1>${page.h1}</h1>
        <div class="answer">${page.answer.trim()}
        </div>
${page.body.trimEnd()}
${cta(page.slug)}

        <nav class="related">
          <h2>Related</h2>
          <ul>
          ${related}
          </ul>
        </nav>
      </main>

      <footer>
        <a href="/">Skrim</a>
        <a href="/privacy">Privacy</a>
        <a href="/restore">Lost your bookmarks?</a>
        <span>© 2026 Skrim</span>
      </footer>
    </div>${STORE_URL ? "" : FORM_SCRIPT}
  </body>
</html>
`;
}

// ------------------------------------------------------------------- sitemap

// Hand-written rather than crawled: the generated pages plus the two that
// already exist. /restore is deliberately absent -- it is a destination for a
// receipt bookmark, not a page anyone should arrive at from a search result.
const SITEMAP_EXTRA = ["", "privacy"];

function sitemap(stamp) {
  const urls = [...SITEMAP_EXTRA, ...ALL.map((p) => p.slug)]
    .map(
      (slug) =>
        `  <url>\n    <loc>${ORIGIN}/${slug}</loc>\n    <lastmod>${stamp}</lastmod>\n  </url>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

const ROBOTS = `User-agent: *
Allow: /

# A receipt bookmark points here with the payload in the fragment. It is a
# recovery destination, not a search result, and it should never be indexed.
Disallow: /restore

Sitemap: ${ORIGIN}/sitemap.xml
`;

// --------------------------------------------------------------------- build

async function main() {
  // A page whose "related" rail points at a page that does not exist ships a
  // 404 into the navigation of every other page. Cheap to check, so check.
  for (const page of ALL) {
    for (const slug of page.related) {
      if (!bySlug[slug]) throw new Error(`${page.slug}: related "${slug}" does not exist`);
      if (!SHORT[slug]) throw new Error(`${page.slug}: no SHORT text for "${slug}"`);
    }
  }

  for (const page of ALL) {
    const html = render(page);
    await writeFile(join(SITE, `${page.slug}.html`), html, "utf8");
    // The description is the only field with a hard practical cap that matters:
    // Google truncates around 160 and a cut sentence looks careless.
    const warn = page.description.length > 160 ? `  <- ${page.description.length} chars, will truncate` : "";
    console.log(`ok   /${page.slug}  ${(html.length / 1024).toFixed(1)}kB${warn}`);
  }

  const stamp = new Date().toISOString().slice(0, 10);
  await writeFile(join(SITE, "sitemap.xml"), sitemap(stamp), "utf8");
  await writeFile(join(SITE, "robots.txt"), ROBOTS, "utf8");
  console.log(`ok   /sitemap.xml  (${ALL.length + SITEMAP_EXTRA.length} urls, lastmod ${stamp})`);
  console.log(`ok   /robots.txt`);
  if (!QUOTES.length) {
    console.log(
      `--   /wall  not written: QUOTES is empty. An empty wall of love reads\n` +
        `     as "nobody said anything nice". Add the first real quote and re-run.`,
    );
  }

  // The OG image these pages reference is published by make-social.mjs. If it
  // is missing every unfurl of every page is blank, which is silent and easy
  // to miss, so say so here rather than let it ship.
  await readFile(join(SITE, "og.png")).catch(() => {
    console.log(`\nWARN site/og.png is missing — run: node tools/make-social.mjs`);
    process.exitCode = 1;
  });

  console.log(
    `\n-> ${SITE}` +
      `\n   CTA: ${STORE_URL ? `Add to Chrome (${STORE_URL})` : "waitlist form (STORE_URL is null)"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
