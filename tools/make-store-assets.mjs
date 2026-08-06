// Chrome Web Store images.
//
//   node tools/make-store-assets.mjs
//
// Five screenshots at 1280x800 and the small promo tile at 440x220 -- the exact
// sizes the Developer Dashboard accepts, written out to brand/store/.
//
// The store has no caption field: whatever a screenshot says, it says inside
// the PNG. So each one carries its own headline, and the five are ordered as an
// argument rather than a gallery -- bar up, bar down, bar back, then the two
// questions a cautious installer asks before clicking (what do you send, and
// what do you not cover).
//
// THE POPUP IN THESE IMAGES IS THE REAL POPUP. tools/popup-preview.mjs serves
// extension/popup.{html,css,js} against stubbed fixtures; this file mounts that
// same handler behind its own routes and drops the result into an iframe, so a
// screenshot cannot drift from the shipped UI the way a redrawn mock would. It
// is same-origin for exactly one reason: the composition needs to read the
// popup's real rendered height to size the frame around it.
//
// The browser around it IS a drawing, deliberately generic -- no Chrome logo,
// no Chrome UI copied pixel for pixel. It is a frame for the bookmarks bar,
// which is the only part of it the product touches.
//
// Two rules from the brand guideline drive every colour decision, same as
// make-social.mjs:
//
//   1. Green means covered. The scrim band is green; so is the "Covered" column
//      on the coverage card. The bookmarks about to be swallowed are neutral,
//      and so are the decoys that replace them -- neither is protected, and
//      neither may wear the colour that says so.
//   2. Type on a green fill is ink, never white. White on green-400 is 1.78:1.
//
// Rasterised by the Chrome already on the machine, same as make-icons.mjs and
// make-social.mjs -- this repo has no package.json and is not about to grow
// one. Rendered at dsf=2 and downsampled to the nominal size, because the store
// wants 1280x800 exactly and refuses anything else; the @2x is kept for the
// landing page, which will want it.
//
// Verified by `node tools/check-listing.mjs`, which reads the PNG headers back
// and fails if a file is missing, the wrong size, or suspiciously small.

import { createServer } from "node:http";
import { mkdir, writeFile, copyFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { FIXTURES, previewRequest } from "./popup-preview.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "brand", "store");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT ?? 8749);

// ------------------------------------------------------------------ tokens

// Lifted from brand/tokens.css, same subset make-social.mjs uses and named the
// same, so a retune there is a find-and-replace here.
const T = {
  green400: "#17DE82", // core fill -- the scrim
  green200: "#8DF7C2", // the lit leading edge
  ink950: "#0A100E", // ground, and type on green
  ink900: "#161D1A",
  ink850: "#1E2623",
  ink800: "#28312D",
  ink700: "#3C4642",
  ink600: "#515C57",
  ink500: "#6C7873",
  ink400: "#94A09A",
  ink300: "#BFC7C2",
  ink100: "#EAEDEB",
  live: "#F2555A", // the recording dot. Depicted OS UI, not brand.
};

const W = 1280;
const H = 800;
const PAD = 72;
const SCRIM_H = 92; // the band. Shallower than the mark's 41% -- at 800px tall
//                     that much green would outweigh the product under it.
const POPUP_W = 336; // extension/popup.css: body { width: 336px }

// ------------------------------------------------------------------- copy

// The nine that hurt, in roughly the order you would hate explaining them.
// Short enough to read on a bookmarks bar, which is the whole point of the
// screenshot -- a bar of lorem ipsum proves nothing.
const EXPOSED = [
  "Salary negotiation",
  "Indeed · Senior roles",
  "Am I underpaid?",
  "resume-FINAL-v7.pdf",
  "glassdoor.com/reviews",
  "How to quit gracefully",
  "competitor-pricing.xlsx",
  "LinkedIn · Open to work",
  "Zillow · Austin, TX",
  "r/overemployed",
  "Two weeks notice — draft",
  "severance, how much?",
];

// extension/src/engine.js DECOYS, in order. If that list changes, this one is
// wrong and screenshot 2 draws a bar the extension never produces --
// check-listing.mjs reads the real list out of engine.js and compares.
export const DECOYS = ["Google", "Gmail", "Calendar", "Drive", "Maps", "News"];

// Screenshots 1, 2 and 3 are read as one sequence, so their numbers have to
// chain: what sits on the bar in the first is what the second says it tucked
// away and the third says it put back. Two of those numbers come from the popup
// fixtures and one from the list above, which is three places for them to drift
// apart quietly. Fail the build instead.
const ON_BAR = FIXTURES.armed.status.bars[0].children;
const TUCKED = FIXTURES.shielded.status.itemsDisplaced;
if (EXPOSED.length !== ON_BAR || TUCKED !== ON_BAR) {
  throw new Error(
    `bookmark counts disagree: ${EXPOSED.length} drawn on the bar, ` +
      `popup 'armed' says ${ON_BAR} on the bar, popup 'shielded' says ${TUCKED} tucked away`,
  );
}

// -------------------------------------------------------------- components

const initial = (s) => (s.match(/[a-zA-Z]/)?.[0] ?? "•").toUpperCase();

/**
 * One bookmarks-bar item. `tone` is the favicon square: neutral steps only.
 * Decoys get the flattest tone in the set because being unremarkable is their
 * entire job.
 */
const bookmark = (label, tone) =>
  `<div class="bm"><span class="favi" style="background:${tone}">${initial(label)}</span>${label}</div>`;

const TONES = [T.ink600, T.ink500, T.ink400];

/**
 * A bookmarks bar. Overflows its box on purpose when there are too many items:
 * a real bar clips and grows a chevron, and a bar that stops politely short of
 * the edge looks like a diagram of a bar rather than one.
 *
 * The chevron only appears when something is actually behind it. Six decoys fit
 * any bar here with room to spare, and a chevron over empty space would say
 * there is more hidden off-screen -- on the one image whose entire claim is
 * that there is not.
 */
const bar = (labels, { decoy = false, chev = labels.length > 6 } = {}) =>
  `<div class="bar">` +
  labels.map((l, i) => bookmark(l, decoy ? T.ink700 : TONES[i % TONES.length])).join("") +
  (chev ? `<div class="chev">»</div>` : "") +
  `</div>`;

/**
 * The generic browser. Tab strip, omnibox, bookmarks bar, page. Everything
 * above the bar exists only to make the bar read as a bookmarks bar.
 */
const browser = ({ labels, decoy = false, sharing = false, tab }) => `
<div class="win">
  <div class="tabs">
    <div class="tab on"><span class="tfav"></span>${tab}</div>
    <div class="tab"><span class="tfav"></span>Roadmap — Q3</div>
    <div class="tab"><span class="tfav"></span>Inbox</div>
    <div class="plus">+</div>
  </div>
  <div class="omni">
    <div class="navs"><i></i><i></i><i></i></div>
    <div class="url"><span class="pad"></span>${sharing ? "meet.example.com/abc-defg-hij" : "docs.example.com/quarterly-review"}</div>
    <div class="acts"><i></i><i class="pin"></i></div>
  </div>
  ${bar(labels, { decoy })}
  <div class="page">
    ${sharing ? `<div class="live"><span class="dot"></span>Sharing this tab</div>` : ""}
    <div class="ph"></div>
    ${[[92, 86, 74], [88, 94, 79, 58], [90, 72, 44]]
      .map(
        (group) =>
          `<div class="lines">${group
            .map((w) => `<div class="ln" style="width:${w}%"></div>`)
            .join("")}</div>`,
      )
      .join("")}
  </div>
</div>`;

/** The shipped popup, in an iframe, sized to its real height by the script below. */
const popup = (state) =>
  `<div class="pop"><iframe src="/popup.html?state=${state}" scrolling="no"></iframe></div>`;

/**
 * A labelled bar strip, for the before/during/after story. `covered` puts the
 * label in green, which on this card is the literal reading of the rule: that
 * one row is the only moment in the sequence when the bar is covered.
 */
const strip = (label, note, inner, { covered = false } = {}) => `
<div class="strip">
  <div class="slab"><span class="sl${covered ? " on" : ""}">${label}</span><span class="sn">${note}</span></div>
  <div class="sbar">${inner}</div>
</div>`;

/** A statement card. The green hairline on top is the mark's leading edge. */
const statCard = (head, body) =>
  `<div class="stat"><h3>${head}</h3><p>${body}</p></div>`;

// ------------------------------------------------------------------ layout

/**
 * One 1280x800 screenshot.
 *
 * The band across the top is the scrim, the same object as in the mark and on
 * the social cards: a green fill with a lit leading edge, and the product
 * underneath it. Repeating it on all five is what makes them read as one set in
 * a carousel that shows them 400px wide.
 */
const shot = ({ kicker, headline, sub, stage, foot = null }) => `
<div class="card">
  <div class="scrim">
    <div class="lock">${mark(34)}<span class="word">Skrim</span></div>
    <span class="kick">${kicker}</span>
  </div>
  <div class="edge"></div>
  <div class="glowfall"></div>

  <div class="say">
    <h1>${headline}</h1>
    <p>${sub}</p>
  </div>

  <div class="stage">${stage}</div>
  ${foot ? `<div class="foot">${foot}</div>` : ""}
</div>`;

// brand/logo/mark-primary.svg, inlined so the page has no external refs.
const mark = (size) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">` +
  `<defs><clipPath id="mk${size}"><rect x="2" y="2" width="28" height="28" rx="6"/></clipPath></defs>` +
  `<rect x="2" y="2" width="28" height="28" rx="6" fill="${T.ink950}"/>` +
  `<rect x="7.5" y="14.5" width="15" height="3" rx="1.5" fill="${T.green400}" opacity=".5"/>` +
  `<rect x="7.5" y="20.5" width="10" height="3" rx="1.5" fill="${T.green400}" opacity=".5"/>` +
  `<g clip-path="url(#mk${size})"><rect x="2" y="2" width="28" height="11.5" fill="${T.green400}"/></g>` +
  `</svg>`;

// ------------------------------------------------------------------- cuts

// How many decoys the popup says are on the bar, read from the fixture the
// screenshot actually renders. Hard-coding 6 here and rendering a fixture that
// says something else is the kind of mismatch a reviewer notices and a user
// screenshots back at you.
const decoyCount = FIXTURES.shielded.status.bars[0].children;

const SHOTS = [
  {
    name: "screenshot-1-armed",
    kicker: "Before the share",
    headline: "Your bookmarks bar knows too much about you.",
    sub: "Skrim sits armed and silent until something asks Chrome for your screen. Nothing to switch on, nothing to remember at the one moment you will forget.",
    stage:
      `<div class="split">` +
      browser({ labels: EXPOSED, tab: "Quarterly review" }) +
      popup("armed") +
      `</div>`,
  },
  {
    name: "screenshot-2-hidden",
    kicker: "During the share",
    headline: "The share starts. The bar clears itself.",
    sub: "Every bookmark moves into a folder under Other Bookmarks, and a few forgettable links stand in — because a conspicuously empty bar is its own tell.",
    stage:
      `<div class="split">` +
      browser({
        labels: DECOYS.slice(0, decoyCount),
        decoy: true,
        sharing: true,
        tab: "Google Meet",
      }) +
      popup("shielded") +
      `</div>`,
  },
  {
    name: "screenshot-3-restore",
    kicker: "After the share",
    headline: "Then every bookmark goes back where it came from.",
    sub: "Same folder, same position, nothing renamed and nothing dropped. If the share, Chrome, or the machine dies half-way through, the next start finishes the restore.",
    stage:
      `<div class="strips">
        ${strip("Before", `${ON_BAR} bookmarks on the bar`, bar(EXPOSED))}
        ${strip("Sharing", "moved to a folder, stand-ins in their place", bar(DECOYS.slice(0, decoyCount), { decoy: true }), { covered: true })}
        ${strip("Restored", `the same ${ON_BAR}, in the same order`, bar(EXPOSED))}
      </div>`,
    foot: "Nothing is ever deleted. Uninstall mid-share and the folder still holds a receipt bookmark that spells out how to put the bar back by hand.",
  },
  {
    name: "screenshot-4-privacy",
    kicker: "What leaves your computer",
    headline: "No account. No servers. No network requests at all.",
    sub: "Every one of Chrome's data-collection categories is declared “not collected”, and it is a checkable claim rather than a promise.",
    stage: `<div class="stats">
      ${statCard(
        "Nothing to send with",
        "There is no fetch, no XHR, no beacon and no WebSocket anywhere in the code, and no remote resource of any kind.",
      )}
      ${statCard(
        "Nothing to sign in to",
        "No account, no analytics, no telemetry, no crash reporting. Your bookmarks are read and rearranged inside your own browser.",
      )}
      ${statCard(
        "Four permissions, one job each",
        "Bookmarks moves the bar — Chrome exposes no other lever. Storage and alarms finish a restore that a crash interrupted. Tabs spots the Loom recorder.",
      )}
      ${statCard(
        "One thing said out loud",
        "Bookmarks are synced data, so while the bar is hidden here it is empty on your other signed-in devices too. That is Chrome's sync, not ours.",
      )}
    </div>`,
  },
  {
    name: "screenshot-5-coverage",
    kicker: "What it covers",
    headline: "It watches Chrome, not a list of apps.",
    sub: "Skrim waits for the moment a page asks Chrome for your screen, so it never needs to know which site did the asking. That is also the one line it cannot cross — both halves are below.",
    stage: `<div class="cols">
      <div class="col covered">
        <h3>Covered</h3>
        <ul>
          <li>Google Meet and Zoom on the web — tested end to end in a real browser</li>
          <li>Any other site that uses Chrome's own screen-share picker</li>
          <li>Tab shares, window shares and whole-screen shares</li>
          <li>Loom's Chrome extension recorder</li>
        </ul>
      </div>
      <div class="col">
        <h3>Not covered — worth knowing before you install</h3>
        <ul>
          <li>Desktop apps. The Zoom client, the Loom app, OBS and QuickTime capture outside Chrome entirely, where no extension can see them.</li>
          <li>Chrome's own picker preview. On a page that asks the instant it loads, the thumbnail inside the picker can still show the bar for a moment.</li>
        </ul>
      </div>
    </div>`,
    foot: "Google Meet, Zoom, Loom, OBS and QuickTime are trademarks of their respective owners. Skrim is not affiliated with, endorsed by, or sponsored by any of them.",
  },
];

// ------------------------------------------------------------- promo tile

// 440x220, and it is shown at that size or smaller in search results, so it
// gets the mark's own geometry and almost no words: the scrim parked at its
// resting 41%, the lit edge, and two rows of bookmarks caught mid-swallow.
const TILE = () => `
<div class="tile">
  <div class="tchips">
    ${[EXPOSED.slice(0, 4), EXPOSED.slice(4, 8), EXPOSED.slice(1, 5), EXPOSED.slice(5, 9)]
      .map(
        (row) =>
          `<div class="trow">${row.map((l, i) => bookmark(l, TONES[i % TONES.length])).join("")}</div>`,
      )
      .join("")}
  </div>
  <div class="tscrim">
    <div class="lock">${mark(28)}<span class="word">Skrim</span></div>
    <span class="tline">Bookmarks bar off while you share.</span>
  </div>
  <div class="tedge"></div>
</div>`;

// ---------------------------------------------------------------- document

const STYLE = `
@font-face { font-family:"Instrument Sans"; font-weight:400 700; font-display:block;
  src:url("/fonts/InstrumentSans-latin.woff2") format("woff2"); }
@font-face { font-family:"Geist Mono"; font-weight:100 900; font-display:block;
  src:url("/fonts/GeistMono.woff2") format("woff2"); }

:root { --mono:"Geist Mono", ui-monospace, Menlo, monospace; }
html,body { margin:0; padding:0; background:${T.ink950}; }
body { font-family:"Instrument Sans", -apple-system, sans-serif;
       -webkit-font-smoothing:antialiased; }

/* Flow, not fixed offsets. A headline that grows to two lines has to push the
   stage down rather than land on top of it, and the stage has to hand its real
   height to the fit script below. */
.card { position:relative; width:${W}px; height:${H}px; overflow:hidden;
  background:${T.ink950}; display:flex; flex-direction:column; }
/* A whisper of light under the scrim so the ground is not dead flat. Kept
   under 5%: any more and green reads as loose on the card. */
.card::before { content:""; position:absolute; inset:0;
  background:radial-gradient(70% 50% at 20% 90%, rgba(23,222,130,.04), transparent 70%); }

.scrim { flex:none; height:${SCRIM_H}px;
  background:${T.green400}; color:${T.ink950}; box-sizing:border-box;
  padding:0 ${PAD}px; display:flex; align-items:center; justify-content:space-between; }
.lock { display:flex; align-items:center; gap:12px; }
.lock svg { display:block; border-radius:2px; }
.word { font-size:27px; font-weight:700; letter-spacing:-.03em; line-height:1; }
.kick { font-family:var(--mono); font-size:15px; font-weight:500; letter-spacing:.02em;
  opacity:.66; }

/* The leading edge sits just BELOW the fill: on green it is invisible, on the
   dark ground it is a lit hairline. The scrim is a lit object travelling down,
   so the light falls onto what it is about to cover -- never a drop shadow,
   which would make the protective thing heavy. */
.edge { position:absolute; left:0; right:0; top:${SCRIM_H}px; height:3px;
  background:${T.green200}; box-shadow:0 5px 18px -4px rgba(141,247,194,.4); }
.glowfall { position:absolute; left:0; right:0; top:${SCRIM_H + 3}px; height:64px;
  background:linear-gradient(rgba(23,222,130,.07), rgba(23,222,130,0)); }

.say { flex:none; padding:26px ${PAD}px 0; }
.say h1 { margin:0; font-size:42px; line-height:1.08; font-weight:700;
  letter-spacing:-.035em; color:${T.ink100}; max-width:1010px; text-wrap:balance; }
.say p { margin:13px 0 0; font-size:19px; line-height:1.42; font-weight:450;
  letter-spacing:-.01em; color:${T.ink400}; max-width:900px; }

/* min-height:0 so a tall stage shrinks instead of pushing the card past 800. */
.stage { flex:1; min-height:0; position:relative; margin:24px ${PAD}px 0; }
.foot { flex:none; padding:18px ${PAD}px 26px; font-size:14px; line-height:1.45;
  color:${T.ink600}; max-width:1120px; }
.card > .stage:last-child { margin-bottom:34px; }

/* ---------------------------------------------------------- browser mock */

.split { position:relative; height:100%; }
/* Stretched to the stage, so the window and the popup end on the same line
   whatever the popup's state makes it. */
.win { position:absolute; left:0; top:0; bottom:0; width:736px;
  border:1px solid ${T.ink800}; border-radius:12px; overflow:hidden;
  background:${T.ink900}; display:flex; flex-direction:column; }

.tabs { display:flex; align-items:flex-end; gap:5px; height:42px; padding:0 10px;
  background:${T.ink950}; }
.tab { display:flex; align-items:center; gap:8px; height:31px; padding:0 13px; flex:none;
  max-width:186px; border-radius:8px 8px 0 0; background:transparent;
  color:${T.ink500}; font-size:12.5px; font-weight:500; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis; }
.tab.on { background:${T.ink900}; color:${T.ink300}; }
.tfav { width:11px; height:11px; border-radius:3px; background:${T.ink700}; flex:none; }
.plus { color:${T.ink600}; font-size:16px; padding:0 8px 6px; }

.omni { display:flex; align-items:center; gap:12px; height:48px; padding:0 14px;
  background:${T.ink900}; }
.navs { display:flex; gap:9px; flex:none; }
.navs i { width:13px; height:13px; border-radius:50%; background:${T.ink800}; }
.url { flex:1; display:flex; align-items:center; gap:9px; height:28px; padding:0 12px;
  border-radius:14px; background:${T.ink850}; color:${T.ink400}; font-size:12.5px; }
.url .pad { width:9px; height:11px; border-radius:2px; border:1.5px solid ${T.ink600};
  flex:none; }
.acts { display:flex; gap:9px; flex:none; }
.acts i { width:14px; height:14px; border-radius:4px; background:${T.ink800}; }
.acts i.pin { background:${T.green400}; }

/* The one row any of this is about. */
.bar { flex:none; display:flex; align-items:center; gap:4px; height:40px; padding:0 10px;
  background:${T.ink900}; border-top:1px solid ${T.ink850}; overflow:hidden;
  position:relative; }
.bm { display:flex; align-items:center; gap:7px; flex:none; height:26px; padding:0 9px;
  border-radius:6px; color:${T.ink300}; font-size:12.5px; font-weight:500;
  letter-spacing:-.005em; white-space:nowrap; }
.favi { display:flex; align-items:center; justify-content:center; flex:none;
  width:14px; height:14px; border-radius:4px; color:${T.ink950};
  font-family:var(--mono); font-size:8.5px; font-weight:600; }
.chev { position:absolute; right:0; top:0; bottom:0; display:flex; align-items:center;
  padding:0 12px 0 22px; color:${T.ink600}; font-size:15px;
  background:linear-gradient(90deg, rgba(22,29,26,0), ${T.ink900} 40%); }

.page { position:relative; flex:1; min-height:0; padding:22px 26px;
  background:${T.ink950}; border-top:1px solid ${T.ink850}; }
.live { display:inline-flex; align-items:center; gap:8px; height:28px; padding:0 13px;
  border-radius:14px; background:${T.ink900}; border:1px solid ${T.ink800};
  color:${T.ink300}; font-size:12.5px; font-weight:500; margin-bottom:20px; }
.live .dot { width:8px; height:8px; border-radius:50%; background:${T.live}; }
/* Enough of a document to stop the window reading as an empty box, and no more
   -- anything legible in here competes with the one row that matters. */
.ph { width:38%; height:17px; border-radius:6px; background:${T.ink850}; margin-bottom:26px; }
.lines { display:flex; flex-direction:column; gap:14px; margin-bottom:26px; }
.ln { height:11px; border-radius:6px; background:${T.ink900}; }

/* ------------------------------------------------------------- the popup */

.pop { position:absolute; right:0; top:0; width:${POPUP_W}px;
  border-radius:14px; overflow:hidden; border:1px solid ${T.ink800};
  box-shadow:0 26px 60px -18px rgba(0,0,0,.72); background:${T.ink950}; }
.pop iframe { display:block; width:${POPUP_W}px; height:520px; border:0; }

/* ------------------------------------------------- before / during / after */

.strips { height:100%; display:flex; flex-direction:column;
  justify-content:space-evenly; }
.slab { display:flex; align-items:baseline; gap:12px; margin-bottom:10px; }
.sl { font-family:var(--mono); font-size:13px; font-weight:600; letter-spacing:.06em;
  text-transform:uppercase; color:${T.ink300}; }
.sl.on { color:${T.green400}; }
.sn { font-size:14px; color:${T.ink600}; }
.sbar { border:1px solid ${T.ink800}; border-radius:10px; overflow:hidden; }
.sbar .bar { height:52px; border-top:0; }

/* ------------------------------------------------------- statement cards */

/* align-content:center is doing the work on both grids below. Rows stay auto,
   so a box hugs its own text instead of being stretched into a half-empty
   panel, and the block as a whole sits centred in whatever the headline left.
   Items still stretch within their row, so the headings across a row line up --
   which is what centring each box individually got wrong. */
.stats { height:100%; display:grid; grid-template-columns:1fr 1fr; gap:22px;
  align-content:center; }
.stat { position:relative; padding:26px 26px 24px; border-radius:12px;
  background:${T.ink900}; border:1px solid ${T.ink850}; overflow:hidden; }
/* The same leading edge as the band above, three pixels of it. */
.stat::before { content:""; position:absolute; left:0; right:0; top:0; height:3px;
  background:${T.green200}; }
.stat h3 { margin:0 0 10px; font-size:21px; font-weight:700; letter-spacing:-.02em;
  color:${T.ink100}; }
.stat p { margin:0; font-size:18px; line-height:1.5; color:${T.ink400}; }

/* -------------------------------------------------------------- coverage */

.cols { display:grid; grid-template-columns:1fr 1fr; gap:28px; height:100%;
  align-content:center; }
.col { padding:28px 28px 30px; border-radius:12px; background:${T.ink900};
  border:1px solid ${T.ink850}; }
.col h3 { margin:0 0 18px; font-size:20px; font-weight:700; letter-spacing:-.02em;
  color:${T.ink300}; }
/* Green is allowed here because here it is literal. */
.col.covered { border-color:rgba(23,222,130,.28); background:rgba(23,222,130,.05); }
.col.covered h3 { color:${T.green400}; }
.col ul { margin:0; padding:0; list-style:none; display:flex; flex-direction:column;
  gap:18px; }
.col li { position:relative; padding-left:24px; font-size:18px; line-height:1.45;
  color:${T.ink400}; }
.col li::before { content:""; position:absolute; left:0; top:8px; width:9px; height:3px;
  border-radius:2px; background:${T.ink700}; }
.col.covered li::before { background:${T.green400}; width:13px; }

/* ------------------------------------------------------------ promo tile */

.tile { position:relative; width:440px; height:220px; overflow:hidden;
  background:${T.ink950}; }
.tile::before { content:""; position:absolute; inset:0;
  background:radial-gradient(70% 55% at 18% 92%, rgba(23,222,130,.05), transparent 70%); }
.tchips { position:absolute; left:26px; right:0; top:78px; display:flex;
  flex-direction:column; gap:9px; }
.trow { display:flex; gap:7px; white-space:nowrap; }
.trow .bm { height:28px; font-size:12px; border-radius:7px; background:${T.ink900};
  border:1px solid ${T.ink800}; }
.tscrim { position:absolute; left:0; right:0; top:0; height:90px; background:${T.green400};
  color:${T.ink950}; box-sizing:border-box; padding:0 26px; display:flex;
  flex-direction:column; justify-content:center; gap:9px; }
.tscrim .word { font-size:25px; }
.tline { font-size:15px; font-weight:500; letter-spacing:-.012em; opacity:.78; }
.tedge { position:absolute; left:0; right:0; top:90px; height:3px; background:${T.green200};
  box-shadow:0 5px 16px -4px rgba(141,247,194,.45); }
`;

/**
 * Size every popup iframe to the popup's own rendered height, and scale it down
 * if that height ever outgrows the stage.
 *
 * Same-origin is what makes this possible, and it is why the composition is
 * served off the preview server rather than written to a file:// temp file. The
 * alternative is a hard-coded height per state, which is wrong the first time
 * anyone adds a row to the popup -- silently, in a shipped store image.
 */
const FIT = `<script>
(function () {
  var WIDE = ${POPUP_W};
  document.querySelectorAll(".pop").forEach(function (wrap) {
    var f = wrap.querySelector("iframe");
    function fit() {
      var b = f.contentDocument && f.contentDocument.body;
      if (!b) return;
      var h = Math.ceil(b.getBoundingClientRect().height);
      if (!h) return;
      // The stage's real height, measured after the headline has wrapped.
      var MAX = wrap.closest(".stage").clientHeight;
      var s = Math.min(1, MAX / h);
      f.style.height = h + "px";
      f.style.transform = "scale(" + s + ")";
      f.style.transformOrigin = "top left";
      wrap.style.width = Math.round(WIDE * s) + "px";
      wrap.style.height = Math.round(h * s) + "px";
      document.documentElement.dataset.fitted = h;
    }
    f.addEventListener("load", function () { fit(); setTimeout(fit, 80); setTimeout(fit, 500); });
  });
})();
</script>`;

const page = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head>` +
  `<body>${body}${FIT}</body></html>`;

// ------------------------------------------------------------------ build

/**
 * What this tool produces, at the size the dashboard demands. Exported so
 * check-listing.mjs validates the files against the generator's own manifest
 * rather than against a second list that can fall out of step with it.
 */
export const IMAGES = [
  ...SHOTS.map((s) => ({ file: `${s.name}.png`, w: W, h: H, field: "Screenshot" })),
  { file: "promo-tile-440x220.png", w: 440, h: 220, field: "Small promo tile" },
];

const ROUTES = new Map([
  ...SHOTS.map((s) => [`/shot/${s.name}`, () => page(shot(s))]),
  ["/shot/promo-tile", () => page(TILE())],
]);

/** dsf=2 render, then down to the nominal size the dashboard demands. */
async function capture(url, file, w, h) {
  const at2x = file.replace(/\.png$/, "@2x.png");
  await run(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=2",
    // Fonts and the iframe both load over HTTP here; virtual time makes Chrome
    // wait for the fit script's timers instead of screenshotting mid-layout.
    "--virtual-time-budget=8000",
    `--window-size=${w},${h}`,
    `--screenshot=${at2x}`,
    url,
  ]).catch((e) => {
    // Chrome writes benign task_policy_set noise to stderr on macOS and exits
    // non-zero often enough that the file is the only honest check.
    if (!e.stdout && !e.stderr) throw e;
  });

  await copyFile(at2x, file);
  await run("/usr/bin/sips", ["-Z", String(Math.max(w, h)), file]);

  const { stdout } = await run("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file]);
  const px = `${/pixelWidth: (\d+)/.exec(stdout)?.[1]}x${/pixelHeight: (\d+)/.exec(stdout)?.[1]}`;
  const bytes = (await stat(file)).size;
  const ok = px === `${w}x${h}` && bytes > 10_000;
  console.log(`${ok ? "ok  " : "BAD "} ${file.split("/").pop().padEnd(30)} ${px}  ${(bytes / 1024).toFixed(0)} KB`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const server = createServer((req, res) => {
    const route = ROUTES.get(new URL(req.url, "http://x").pathname);
    if (route) {
      res.writeHead(200, { "content-type": "text/html" }).end(route());
      return;
    }
    // Everything else -- popup.html, popup.css, popup.js, tokens.css, the
    // fonts -- comes straight out of extension/ via the preview harness.
    previewRequest(req, res);
  });
  await new Promise((r) => server.listen(PORT, r));

  const base = `http://localhost:${PORT}`;
  for (const s of SHOTS) await capture(`${base}/shot/${s.name}`, join(OUT, `${s.name}.png`), W, H);
  await capture(`${base}/shot/promo-tile`, join(OUT, "promo-tile-440x220.png"), 440, 220);

  // The composition HTML, kept for a look in a real browser.
  const work = join(tmpdir(), `skrim-store-${process.pid}`);
  await mkdir(work, { recursive: true });
  for (const [path, render] of ROUTES) {
    await writeFile(join(work, `${path.split("/").pop()}.html`), render(), "utf8");
  }

  server.close();
  console.log(`\n-> ${OUT}`);
  console.log(`   live preview: ${base}/shot/${SHOTS[0].name}  (node tools/make-store-assets.mjs --serve)`);
  console.log(`   html kept: ${work}`);
}

// Nothing below runs on import -- check-listing.mjs imports IMAGES and DECOYS
// from here, and an import that regenerated six PNGs would be a nasty surprise
// inside a checker.
const cli = fileURLToPath(import.meta.url) === process.argv[1];

// `--serve` holds the server open so the compositions can be poked at in a real
// browser, which is the only way to catch a font that fell back or a row that
// wrapped one word too far.
if (!cli) {
  // imported: export only
} else if (process.argv.includes("--serve")) {
  createServer((req, res) => {
    const route = ROUTES.get(new URL(req.url, "http://x").pathname);
    if (route) return void res.writeHead(200, { "content-type": "text/html" }).end(route());
    previewRequest(req, res);
  }).listen(PORT, () => {
    console.log(`store compositions on http://localhost:${PORT}/shot/${SHOTS[0].name}`);
    for (const p of ROUTES.keys()) console.log(`  http://localhost:${PORT}${p}`);
  });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
