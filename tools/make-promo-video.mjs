// The Chrome Web Store promo video.
//
//   node tools/make-promo-video.mjs           build brand/video/
//   node tools/make-promo-video.mjs --serve   scrub the film in a real browser
//   node tools/make-promo-video.mjs --at 7000 write one frame at t=7000ms
//
// 36 seconds, 1920x1080, 30fps, silent. The store's "promo video" field takes a
// YouTube URL rather than a file, so what this writes is the master to upload;
// brand/video/README.md carries the rest of that errand.
//
// WHY A GENERATOR AND NOT A SCREEN RECORDING
//
// A recording of the real extension would be the honest thing if it were
// legible, and it is not: the whole event is one bookmarks bar emptying in
// about 200ms, in a 24px strip, at whatever size the recording happened to be.
// So the film is drawn -- from the SAME components the store screenshots are
// drawn from, imported out of make-store-assets.mjs rather than copied, and
// with the real popup in an iframe exactly as the screenshots have it. Change
// the popup and this film follows; change the mock and the screenshots and the
// film move together. There is no second drawing of a bookmarks bar anywhere.
//
// WHAT IT MAY NOT SAY
//
// Two claims are easy to make by accident in motion and both would be false:
//
//   1. It depicts a WHOLE-SCREEN share, not a tab share. src/hook.js releases
//      the hide the moment Chrome reports `displaySurface === "browser"`,
//      because a captured tab provably cannot contain the bookmarks bar -- so a
//      film showing the bar held down for the length of a tab share would be
//      showing behaviour the extension deliberately does not have. Hence the
//      "Sharing your screen" pill rather than the screenshots' "Sharing this
//      tab".
//   2. Nothing on screen is invented extension UI. There is no toast, no
//      progress bar and no badge, because the extension raises none of those.
//      What the popup shows is the popup; everything else is either the generic
//      browser drawing or plainly-typeset promotional copy.
//
// HOW IT IS RENDERED
//
// Every animation in the page is a paused Web Animation with an explicit delay,
// so `seek(t)` is the whole clock: there is no wall time anywhere, no rAF, and
// no `setTimeout`. One headless Chrome is held open over CDP and driven frame
// by frame -- seek, screenshot, seek, screenshot -- at dsf=2, so 1920x1080 is
// rasterised at 3840x2160 and downsampled by ffmpeg. That is what keeps 20px
// type and a 3px lit edge clean after H.264 has had them.
//
// Deterministic in the strong sense: frame 480 is byte-identical whether it is
// rendered first or last, which is the only reason a 1080-frame render can be
// trusted without watching all 36 seconds of it.

import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { previewRequest } from "./popup-preview.mjs";
import {
  T,
  EXPOSED,
  DECOYS,
  POPUP_W,
  bar,
  browser,
  mark,
  markLine,
  STYLE as SHARED_STYLE,
} from "./make-store-assets.mjs";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "brand", "video");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT ?? 8751);
const CDP_PORT = Number(process.env.CDP_PORT ?? 9339);

// Read, not remembered. The film states a minimum Chrome version out loud, and
// docs/store-listing.md is already checked against this same field -- so if the
// manifest moves, both move with it.
const MANIFEST = JSON.parse(await readFile(join(ROOT, "extension/manifest.json"), "utf8"));

// ------------------------------------------------------------------ format

const W = 1920;
const H = 1080;
const FPS = 30;
const DSF = 2; // render at 3840x2160 and let ffmpeg supersample down
const DURATION = 36_000;

// ------------------------------------------------------------------ layout

const PAD = 112;
const BAND_H = 116; // the brand band. Same object as the screenshots' scrim.
const STAGE_TOP = 356;
const STAGE_H = 648;
const STAGE_W = W - PAD * 2;

// The browser mock is drawn at its native 736 and scaled: vector all the way,
// and at dsf=2 the bookmark titles are rasterised at effectively 3.6x.
const WIN_SCALE = 1.5;
const WIN_NAT_H = Math.round(STAGE_H / WIN_SCALE);
const WIN_W = Math.round(736 * WIN_SCALE);
const BAR_TOP = (42 + 48) * WIN_SCALE; // tab strip + omnibox, in stage pixels
const BAR_H = 40 * WIN_SCALE;
const POP_SCALE = 1.3; // ceiling; the fit script lowers it if the popup is tall

// --------------------------------------------------------------------- cues
//
// The whole film, in milliseconds, in one place. Every number in the page's
// timeline reads out of this object, so a beat can be retimed here without
// hunting through the script below.
//
// Six scenes, and the argument is the store listing's: the bar is a liability,
// a share starts, it clears itself, it comes back exactly, here is what leaves
// your computer, here is what it does not cover. The last two are the questions
// a cautious installer asks, and answering them out loud in the film is worth
// more than a sixth feature would be.
const C = {
  filmIn: 0,

  // S1 -- before the share
  s1: { kick: 900, head: 1150, sub: 1400, out: 4700 },
  bmStagger: { at: 520, step: 55, dur: 340 },

  // S2 -- the share starts, the bar clears.
  //
  // The lid falls 850ms after the sharing pill appears and the popup turns over
  // WITH it. The real gap is nearer 200ms; what matters is that the browser and
  // the extension are never seen disagreeing -- a pill that says a share is
  // live above a popup that says "Screen sharing: None" is a bug on screen, and
  // it is the reason these four numbers are as tight as they are.
  s2: { kick: 5300, pill: 5450, head: 5650, sub: 5900, sub2: 7900, out: 12950 },
  hide: { fall: 6300, swap: 6900, lift: 7050 },
  popHide: 6400,

  // S3 -- the share ends, the bar comes back. The popup turns over under the
  // lid, so it has caught up by the time the bar is uncovered.
  s3: { kick: 13450, head: 13700, sub: 13950, pillOut: 14100, out: 18800 },
  show: { fall: 14550, swap: 15150, lift: 15300 },
  popShow: 14650,

  // S4 -- what leaves your computer
  //
  // `cards` and `items` follow their caption by about a third of a second. Any
  // later and the stage sits empty under a finished headline, which at 30fps is
  // long enough to read as the film having stalled.
  s4: { in: 19200, kick: 19250, head: 19400, sub: 19620, cards: 19750, out: 24600 },
  // S5 -- what it covers, and what it does not
  s5: { in: 25000, kick: 25050, head: 25200, sub: 25420, items: 25550, out: 30500 },
  // S6 -- the end card
  s6: { grow: 30800, lock: 31350, line: 31600, url: 31900 },
};

const STAGE_SWAP = [
  { sel: "#scBrowser", in: null, out: C.s4.in - 400 },
  { sel: "#scPrivacy", in: C.s4.in, out: C.s5.in - 400 },
  { sel: "#scCover", in: C.s5.in, out: C.s6.grow - 300 },
];

// -------------------------------------------------------------------- copy
//
// Five headlines and a card. Written to be read at 30fps by someone who is not
// leaning in: one clause, one claim, and never a number the film does not also
// show happening.
const SAY = [
  {
    id: "say1",
    kick: "Before the share",
    head: "Your bookmarks bar is on the call too.",
    sub: "The other client's name. The job board. The doc nobody was supposed to see.",
    at: C.s1,
  },
  {
    id: "say2",
    kick: "The share starts",
    head: "Then it clears itself.",
    sub: "No click, no shortcut to remember at the one moment you would forget it.",
    at: C.s2,
  },
  {
    id: "say3",
    kick: "The share ends",
    head: "And every bookmark goes back.",
    sub: "Same folder, same position, same order. Nothing renamed and nothing dropped.",
    at: C.s3,
  },
  {
    id: "say4",
    kick: "What leaves your computer",
    head: "Nothing at all.",
    sub: "Every data-collection category Chrome asks about is declared not collected.",
    at: C.s4,
  },
  {
    id: "say5",
    kick: "What it covers",
    head: "It watches Chrome, not a list of apps.",
    sub: "Which is also the one line it cannot cross. Both halves, before you install.",
    at: C.s5,
  },
];

// The second caption of scene 2, which lands after the bar has actually
// cleared. Its two numbers are the film's own: twelve went on the bar in scene
// 1, six stand-ins replaced them on screen a second ago.
const SUB2 = `${EXPOSED.length} bookmarks moved into a folder. ${DECOYS.length} forgettable stand-ins took their place.`;

// Four, and the fourth is the one nobody else would put in a promo film. It is
// in the listing, in the privacy screenshot and on the site; leaving it out of
// the film would make the film the softest thing Skrim publishes.
const CARDS = [
  [
    "Nothing to send with",
    "No fetch, no XHR, no beacon and no WebSocket anywhere in the code, and no remote resource of any kind.",
  ],
  [
    "Nothing to sign in to",
    "No account, no analytics, no telemetry, no crash reporting. Your bookmarks are rearranged inside your own browser.",
  ],
  [
    "Four permissions, one job each",
    "Bookmarks moves the bar. Storage and alarms finish a restore a crash interrupted. Tabs spots the Loom recorder.",
  ],
  [
    "One thing said out loud",
    "Bookmarks are synced data, so while the bar is hidden here it is empty on your other signed-in devices too. That is Chrome's sync, not ours.",
  ],
];

// Verbatim from the coverage screenshot and the listing's own two lists. If
// they ever disagree the film is the one that is wrong, because it is the one
// nobody re-reads.
const COVERED = [
  "Google Meet and Zoom on the web",
  "Any site that uses Chrome's screen-share picker",
  "Tab shares, window shares and whole-screen shares",
  "Loom's Chrome extension recorder",
];
const REQUIRES =
  `Chrome ${MANIFEST.minimum_chrome_version} or later. Free, with no account, ` +
  "no sign-in and no upsell.";

const TRADEMARKS =
  "Google Meet, Zoom, Loom, OBS and QuickTime are trademarks of their respective " +
  "owners. Skrim is not affiliated with, endorsed by, or sponsored by any of them.";

const NOT_COVERED = [
  "Desktop apps. The Zoom client, the Loom app, OBS and QuickTime capture outside Chrome, where no extension can see them.",
  "Chrome's own picker preview can still show the bar for a moment on a page that asks the instant it loads.",
];

// ------------------------------------------------------------------- page

const say = ({ id, head, sub }) => `
<div class="cap" id="${id}">
  <h1>${head}</h1>
  <p class="sub s-a">${sub}</p>
  ${id === "say2" ? `<p class="sub s-b">${SUB2}</p>` : ""}
</div>`;

const film = () => `
<div class="film" id="film">

  <div class="band" id="band">
    <div class="lock" id="bandLock">${markLine(38)}<span class="word">Skrim</span></div>
    <div class="kicks">
      ${SAY.map((s, i) => `<span class="kick" id="kick${i + 1}">${s.kick}</span>`).join("")}
    </div>
  </div>
  <div class="bedge" id="bedge"></div>
  <div class="bfall" id="bfall"></div>

  <div class="caps" id="caps">${SAY.map(say).join("")}</div>

  <div class="filmstage" id="filmstage">

    <div class="sc" id="scBrowser">
      <div class="winwrap">
        <div class="winscale">
          ${browser({
            labels: EXPOSED,
            sharing: true,
            tab: "Google Meet",
            pill: "Sharing your screen",
          })}
        </div>
        <div class="wipe" id="wipe">
          <div class="wipefill"></div>
          <div class="wipeedge"></div>
          <div class="wipeglow"></div>
        </div>
      </div>
      <div class="popstack">
        <div class="pop" id="popArmed"><iframe src="/popup.html?state=armed" scrolling="no"></iframe></div>
        <div class="pop" id="popHidden"><iframe src="/popup.html?state=justHidden" scrolling="no"></iframe></div>
      </div>
    </div>

    <div class="sc" id="scPrivacy">
      <div class="pcards">
        ${CARDS.map(
          ([h, b]) => `<div class="pcard"><h3>${h}</h3><p>${b}</p></div>`,
        ).join("")}
      </div>
      <p class="tmark">${REQUIRES}</p>
    </div>

    <div class="sc" id="scCover">
      <div class="cols">
        <div class="col covered">
          <h3>Covered</h3>
          <ul>${COVERED.map((l) => `<li>${l}</li>`).join("")}</ul>
        </div>
        <div class="col">
          <h3>Not covered — worth knowing before you install</h3>
          <ul>${NOT_COVERED.map((l) => `<li>${l}</li>`).join("")}</ul>
        </div>
      </div>
      <p class="tmark">${TRADEMARKS}</p>
    </div>

  </div>

  <div class="endcard" id="endcard">
    <div class="lock">${markLine(96)}<span class="word">Skrim</span></div>
    <p class="endline">Bookmarks bar off while you share.</p>
    <p class="endurl">skrim.app</p>
  </div>

  <!-- The decoy bar, built by the same bar() the exposed one is built by, and
       slid in behind the exposed one at load. -->
  <template id="decoyBar">${bar(DECOYS, { decoy: true })}</template>
</div>`;

// ------------------------------------------------------------------ style

// The browser mock, the bookmarks bar, the popup frame and every colour come in
// from make-store-assets.mjs unchanged. Only what the film adds is below.
const STYLE = `
${SHARED_STYLE}

html, body { width:${W}px; height:${H}px; overflow:hidden; }
.film { position:relative; width:${W}px; height:${H}px; overflow:hidden;
  background:${T.ink950}; }
.film::before { content:""; position:absolute; inset:0;
  background:radial-gradient(64% 46% at 18% 88%, rgba(23,222,130,.045), transparent 72%); }

/* ------------------------------------------------------------- the band */

.band { position:absolute; left:0; right:0; top:0; height:${BAND_H}px;
  box-sizing:border-box; background:${T.green400}; color:${T.ink950};
  padding:0 ${PAD}px; display:flex; align-items:center;
  justify-content:space-between; overflow:hidden; }
.film .word { font-size:33px; }
.film .lock { gap:15px; }
.film .lock svg { border-radius:3px; }
.kicks { position:relative; height:22px; min-width:420px; }
.kick { position:absolute; right:0; top:0; font-family:var(--mono); font-size:17px;
  font-weight:500; letter-spacing:.02em; white-space:nowrap; opacity:0; }

.bedge { position:absolute; left:0; right:0; top:${BAND_H}px; height:3px;
  background:${T.green200}; box-shadow:0 6px 24px -4px rgba(141,247,194,.42); }
.bfall { position:absolute; left:0; right:0; top:${BAND_H + 3}px; height:82px;
  background:linear-gradient(rgba(23,222,130,.07), rgba(23,222,130,0)); }

/* -------------------------------------------------------------- the type */

.caps { position:absolute; left:${PAD}px; right:${PAD}px; top:${BAND_H + 46}px;
  height:${STAGE_TOP - BAND_H - 60}px; }
.cap { position:absolute; left:0; right:0; top:0; opacity:0; }
.cap h1 { margin:0; font-size:58px; line-height:1.04; font-weight:700;
  letter-spacing:-.038em; color:${T.ink100}; max-width:1400px; text-wrap:balance; }
/* Both captions of scene 2 sit on the same line, so the second can replace the
   first without the headline above it moving a pixel. */
.cap .sub { position:absolute; left:0; right:0; top:78px; margin:0; font-size:26px;
  line-height:1.36; font-weight:450; letter-spacing:-.012em; color:${T.ink400};
  max-width:1240px; }

/* ------------------------------------------------------------- the stage */

.filmstage { position:absolute; left:${PAD}px; top:${STAGE_TOP}px;
  width:${STAGE_W}px; height:${STAGE_H}px; }
.sc { position:absolute; left:0; top:0; width:100%; height:100%; opacity:0; }

.winwrap { position:absolute; left:0; top:0; width:${WIN_W}px; height:${STAGE_H}px; }
.winscale { width:736px; height:${WIN_NAT_H}px; transform:scale(${WIN_SCALE});
  transform-origin:top left; }
.winwrap .win { position:static; width:100%; height:100%; }
/* Two bars in one slot: the exposed twelve, and the six stand-ins stacked over
   them. The swap happens under the scrim, in one frame, which is also how long
   the real thing takes. */
.barslot { position:relative; flex:none; height:40px; }
.barslot .bar { position:absolute; left:0; right:0; top:0; bottom:0; height:40px; }
#decoyBar { display:none; }

/* The scrim, in STAGE pixels rather than the window's, so its lit edge stays a
   3px hairline instead of being scaled to 4.35. Height is animated, and the
   edge and the glow hang off the bottom of it, so both track the fall for
   free. */
.wipe { position:absolute; left:0; right:0; top:${BAR_TOP}px; height:0;
  overflow:visible; opacity:0; }
.wipefill { position:absolute; left:0; right:0; top:0; bottom:0;
  background:${T.green400}; }
.wipeedge { position:absolute; left:0; right:0; top:100%; height:3px;
  background:${T.green200}; box-shadow:0 6px 22px -3px rgba(141,247,194,.5); }
.wipeglow { position:absolute; left:0; right:0; top:100%; height:78px;
  background:linear-gradient(rgba(23,222,130,.14), rgba(23,222,130,0)); }

/* The popup hangs at the right of the stage, top-aligned, so the armed and
   hidden states cross-fade without the header sliding. */
.popstack { position:absolute; right:0; top:0; width:${Math.round(POPUP_W * POP_SCALE)}px;
  height:${STAGE_H}px; }
.pop { position:absolute; right:0; top:0; width:${POPUP_W}px;
  border-radius:16px; overflow:hidden; border:1px solid ${T.ink800};
  box-shadow:0 30px 70px -20px rgba(0,0,0,.75); background:${T.ink950};
  transform-origin:top right; }
.pop iframe { display:block; width:${POPUP_W}px; border:0; }
#popHidden { opacity:0; }

/* ------------------------------------------------------------ the cards */

.pcards { display:grid; grid-template-columns:repeat(2, 1fr); gap:26px;
  align-content:start; }
.film .pcard { position:relative; width:auto; height:auto; display:block;
  padding:40px 38px 38px; border-radius:14px; background:${T.ink900};
  border:1px solid ${T.ink850}; overflow:hidden; }
.film .pcard::before { content:""; position:absolute; left:0; right:0; top:0;
  height:3px; background:${T.green200}; }
.film .pcard h3 { margin:0 0 14px; font-size:30px; font-weight:700;
  letter-spacing:-.025em; color:${T.ink100}; }
.film .pcard p { margin:0; font-size:23px; line-height:1.46; color:${T.ink400}; }

.film .cols { gap:36px; height:auto; align-content:start; }
.film .col { padding:42px 44px 46px; border-radius:14px; }
.film .col h3 { margin:0 0 30px; font-size:28px; }
.film .col ul { gap:26px; }
.film .col li { padding-left:32px; font-size:23px; line-height:1.44; }
.film .col li::before { top:11px; width:12px; }
.film .col.covered li::before { width:17px; }
/* Follows the block above it rather than being pinned to the floor of the
   stage. Pinned, it left a hole between the panels and the frame edge; a
   paragraph that simply comes next reads as what it is. */
.tmark { margin:38px 0 0; font-size:17px; line-height:1.45; color:${T.ink600};
  max-width:1520px; }

/* ---------------------------------------------------------- the end card */

/* Green means covered, so the film ends covered. The band does not cut to the
   end card -- it grows into it, which is the same object doing the same thing
   it has done twice already. */
.endcard { position:absolute; left:0; right:0; top:0; bottom:0;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  color:${T.ink950}; opacity:0; }
.endcard .lock { gap:28px; }
.endcard .lock svg { border-radius:8px; }
.endcard .word { font-size:96px; letter-spacing:-.042em; }
.endline { margin:40px 0 0; font-size:42px; font-weight:600; letter-spacing:-.03em; }
/* Ink at .72 on green-400 measures 5.9:1. White would be 1.78:1. */
.endurl { margin:30px 0 0; font-family:var(--mono); font-size:23px; font-weight:500;
  letter-spacing:.04em; opacity:.72; }
`;

// ---------------------------------------------------------------- timeline

// Everything below runs in the page. It builds one paused Web Animation per
// cue, and `seek(t)` sets `currentTime` on all of them -- that is the entire
// clock. No rAF, no wall time, nothing that can land differently on the second
// render of the same frame.
const SCRIPT = `<script>
(function () {
  var C = ${JSON.stringify(C)};
  var SWAP = ${JSON.stringify(STAGE_SWAP)};
  var SAY = ${JSON.stringify(SAY.map((s) => ({ id: s.id, at: s.at })))};
  var BAR_H = ${BAR_H};
  var BAND_H = ${BAND_H};
  var H = ${H};
  var POP_SCALE = ${POP_SCALE};
  var STAGE_H = ${STAGE_H};

  var A = [];
  var OUT = "cubic-bezier(.16,.84,.34,1)";   // arrives, settles, stops
  var IO  = "cubic-bezier(.65,0,.35,1)";     // leaves
  var SCRIM = "cubic-bezier(.33,0,.15,1)";   // the lid: weighty, then decisive

  var $ = function (s) { return document.querySelector(s); };

  /**
   * One cue. \`fill\` is the whole trick: an entrance fills BOTH ways so the
   * element is correctly invisible before its delay, and an exit fills FORWARDS
   * only so it does not reach back and override the entrance it follows.
   */
  function cue(el, frames, at, dur, easing, fill) {
    if (!el) throw new Error("cue with no element at " + at);
    var a = el.animate(frames, {
      duration: dur, delay: at, fill: fill || "both", easing: easing || OUT,
    });
    a.pause();
    A.push(a);
    return a;
  }
  var enter = function (el, at, rise, dur) {
    return cue(el, [
      { opacity: 0, transform: "translateY(" + (rise === undefined ? 16 : rise) + "px)" },
      { opacity: 1, transform: "none" },
    ], at, dur || 640);
  };
  var exit = function (el, at, rise, dur) {
    return cue(el, [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-" + (rise === undefined ? 11 : rise) + "px)" },
    ], at, dur || 420, IO, "forwards");
  };
  var fade = function (el, at, dur, from, to) {
    return cue(el, [{ opacity: from }, { opacity: to }], at, dur, "linear",
      from === 0 ? "both" : "forwards");
  };

  // ------------------------------------------------ the bar's second row

  // The decoy bar goes into the same slot as the exposed one, stacked over it.
  // Built by bar() upstream, so the two rows cannot drift apart.
  var win = $(".winscale .win");
  var barA = win.querySelector(".bar");
  var slot = document.createElement("div");
  slot.className = "barslot";
  win.insertBefore(slot, barA);
  slot.appendChild(barA);
  slot.appendChild(document.importNode($("#decoyBar").content, true));
  var barB = slot.children[1];
  barB.style.opacity = 0;

  // ------------------------------------------------------------ scene one

  cue($("#film"), [{ opacity: 0 }, { opacity: 1 }], C.filmIn, 620, "linear");

  // The twelve arrive one at a time, left to right, because a bar that is
  // simply there is scenery and a bar that assembles itself gets read.
  var bms = barA.querySelectorAll(".bm");
  for (var i = 0; i < bms.length; i++) {
    cue(bms[i], [
      { opacity: 0, transform: "translateY(7px)" },
      { opacity: 1, transform: "none" },
    ], C.bmStagger.at + i * C.bmStagger.step, C.bmStagger.dur);
  }
  cue(barA.querySelector(".chev"), [{ opacity: 0 }, { opacity: 1 }],
    C.bmStagger.at + bms.length * C.bmStagger.step, 300);

  // ------------------------------------------------------------- the type

  SAY.forEach(function (s, n) {
    var el = $("#" + s.id);
    var k = $("#kick" + (n + 1));
    enter(el.querySelector("h1"), s.at.head, 18);
    enter(el.querySelector(".s-a"), s.at.sub, 18);
    cue(el, [{ opacity: 1 }, { opacity: 1 }], 0, 1, "linear"); // the block never moves
    cue(k, [{ opacity: 0 }, { opacity: 1 }], s.at.kick, 460, OUT);
    exit(el.querySelector("h1"), s.at.out, 11);
    exit(el.querySelector(".s-a"), s.at.out + 60, 11);
    cue(k, [{ opacity: 1 }, { opacity: 0 }], s.at.out, 380, IO, "forwards");
  });

  // Scene two swaps its caption once the bar has actually cleared, so the two
  // numbers in it are describing something the viewer just watched happen.
  var s2b = $("#say2 .s-b");
  enter(s2b, C.s2.sub2, 14, 520);
  exit(s2b, C.s2.out + 60, 11);
  exit($("#say2 .s-a"), C.s2.sub2 - 240, 9, 340);

  // ----------------------------------------------------- share on, share off

  var pill = $(".winscale .live");
  cue(pill, [
    { opacity: 0, transform: "scale(.94)" },
    { opacity: 1, transform: "none" },
  ], C.s2.pill, 460);
  cue(pill, [{ opacity: 1 }, { opacity: 0 }], C.s3.pillOut, 400, IO, "forwards");

  // --------------------------------------------------------------- the lid

  var wipe = $("#wipe");
  // Down, swap, up. \`to\` is which bar is showing when the lid comes off: 1 is
  // the six stand-ins, 0 is the twelve that were there all along.
  function scrim(down, swapAt, to, upAt) {
    // Every one of these fills FORWARDS only. A backwards fill on the second
    // pass would reach back to t=0 and hold the lid shut through the first.
    cue(wipe, [{ opacity: 1 }, { opacity: 1 }], down, 1, "linear", "forwards");
    cue(wipe, [{ height: "0px" }, { height: BAR_H + "px" }], down, 540, SCRIM, "forwards");
    cue(barB, [{ opacity: 1 - to }, { opacity: to }], swapAt, 1, "linear", "forwards");
    cue(wipe, [{ height: BAR_H + "px" }, { height: "0px" }], upAt, 540, SCRIM, "forwards");
    cue(wipe, [{ opacity: 0 }, { opacity: 0 }], upAt + 540, 1, "linear", "forwards");
  }
  scrim(C.hide.fall, C.hide.swap, 1, C.hide.lift);
  scrim(C.show.fall, C.show.swap, 0, C.show.lift);

  // ------------------------------------------------------------- the popup

  // Short on purpose. Two text-dense panels cross-fading show each other's
  // type for the length of the fade, and 300ms under a green lid is about as
  // little of that as anyone will see.
  fade($("#popHidden"), C.popHide, 300, 0, 1);
  fade($("#popHidden"), C.popShow, 300, 1, 0);

  // -------------------------------------------------------------- scenes

  SWAP.forEach(function (s) {
    var el = $(s.sel);
    if (s.in === null) cue(el, [{ opacity: 0 }, { opacity: 1 }], C.filmIn, 620, "linear");
    else enter(el, s.in, 20, 660);
    if (s.out !== null) exit(el, s.out, 14, 460);
  });

  // Cards and list items arrive in order rather than as a block: three panels
  // appearing at once is a slide, three arriving in sequence is an argument.
  var cards = document.querySelectorAll("#scPrivacy .pcard");
  for (var c = 0; c < cards.length; c++) enter(cards[c], C.s4.cards + c * 120, 22, 620);
  // Staggered WITHIN each column, not across the pair. Across the pair, the
  // four covered lines fill while "Not covered" sits there as an empty box --
  // which for half a second is a panel that looks like it failed to load, on
  // the one scene whose whole job is that both halves get said.
  document.querySelectorAll("#scCover .col").forEach(function (col, c) {
    enter(col.querySelector("h3"), C.s5.items - 120 + c * 70, 14, 520);
    col.querySelectorAll("li").forEach(function (li, i) {
      enter(li, C.s5.items + i * 95 + c * 45, 14, 520);
    });
  });
  enter($("#scPrivacy .tmark"), C.s4.cards + 4 * 120, 14, 560);
  enter($("#scCover .tmark"), C.s5.items + 4 * 95 + 140, 14, 560);

  // ------------------------------------------------------------- end card

  // The band grows into the frame. Everything it is about to swallow leaves
  // first, so nothing is ever seen through the green.
  cue($("#band"), [{ height: BAND_H + "px" }, { height: H + "px" }],
    C.s6.grow, 900, SCRIM, "forwards");
  cue($("#bedge"), [{ transform: "none" }, { transform: "translateY(" + (H - BAND_H) + "px)" }],
    C.s6.grow, 900, SCRIM, "forwards");
  fade($("#bedge"), C.s6.grow + 300, 400, 1, 0);
  fade($("#bfall"), C.s6.grow, 300, 1, 0);
  fade($("#bandLock"), C.s6.grow, 260, 1, 0);
  fade($("#caps"), C.s6.grow - 260, 380, 1, 0);
  fade($("#filmstage"), C.s6.grow - 260, 380, 1, 0);

  enter($("#endcard .lock"), C.s6.lock, 22, 700);
  enter($("#endcard .endline"), C.s6.line, 22, 700);
  enter($("#endcard .endurl"), C.s6.url, 18, 700);
  cue($("#endcard"), [{ opacity: 1 }, { opacity: 1 }], 0, 1, "linear");

  // ---------------------------------------------------------------- clock

  // Same-origin, so the popup's own animations can be pinned too -- otherwise
  // anything the popup animates on load runs on wall time and the film stops
  // being reproducible.
  function frames() {
    var out = [];
    var ifr = document.querySelectorAll("iframe");
    for (var i = 0; i < ifr.length; i++) {
      try { if (ifr[i].contentDocument) out.push(ifr[i].contentDocument); } catch (e) {}
    }
    return out;
  }

  window.seek = function (t) {
    for (var i = 0; i < A.length; i++) A[i].currentTime = t;
    document.documentElement.dataset.t = t;
  };

  /**
   * Size both popups to their own rendered height and scale them by one shared
   * factor, so the cross-fade between armed and hidden is a cross-fade and not
   * a resize. The factor is capped, then lowered if the taller state would
   * overflow the stage -- which is what happens the first time anyone adds a
   * row to the popup.
   */
  function fitPopups() {
    var pops = document.querySelectorAll(".pop");
    var heights = [];
    for (var i = 0; i < pops.length; i++) {
      var f = pops[i].querySelector("iframe");
      var b = f.contentDocument && f.contentDocument.body;
      if (!b) return false;
      var h = Math.ceil(b.getBoundingClientRect().height);
      if (!h) return false;
      heights.push(h);
    }
    var tallest = Math.max.apply(null, heights);
    var s = Math.min(POP_SCALE, STAGE_H / tallest);
    for (var j = 0; j < pops.length; j++) {
      var fr = pops[j].querySelector("iframe");
      fr.style.height = heights[j] + "px";
      pops[j].style.height = heights[j] + "px";
      pops[j].style.transform = "scale(" + s + ")";
    }
    document.documentElement.dataset.popScale = s.toFixed(4);
    return true;
  }

  var settled = 0;
  function ready() {
    if (!fitPopups()) { settled = 0; return; }
    // The popup fills itself from a stubbed sendMessage, and filling it starts
    // CSS transitions. Give them a few ticks to exist, then FINISH them: their
    // end state is the shipped popup, and their start state is the empty shell
    // it renders for one frame before the data lands.
    if (++settled < 3) return;
    var docs = frames();
    for (var i = 0; i < docs.length; i++) {
      var anims = docs[i].getAnimations ? docs[i].getAnimations() : [];
      for (var j = 0; j < anims.length; j++) {
        try { anims[j].finish(); } catch (e) { /* infinite: leave it running */ }
        anims[j].pause();
      }
    }
    window.seek(0);
    window.__ready = true;
  }

  var pending = document.querySelectorAll("iframe").length;
  document.querySelectorAll("iframe").forEach(function (f) {
    f.addEventListener("load", function () {
      pending--;
      if (pending === 0) {
        // The popup fills itself from a stubbed sendMessage that resolves on a
        // 30ms timer, so its final height is not known at load. Poll for it
        // instead of guessing, and let the renderer wait on __ready.
        var tries = 0;
        var iv = setInterval(function () {
          if (window.__ready || ++tries > 120) return clearInterval(iv);
          ready();
        }, 50);
      }
    });
  });
})();
</script>`;

const page = () =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Skrim — promo film</title>` +
  `<style>${STYLE}</style></head><body>${film()}${SCRIPT}</body></html>`;

// A scrubber, for looking at the film in a real browser. It is the only way to
// catch a caption that wrapped one word too far or a beat that reads slow.
const SCRUB = `<script>
(function () {
  var s = document.createElement("input");
  s.type = "range"; s.min = 0; s.max = ${DURATION}; s.step = ${Math.round(1000 / FPS)}; s.value = 0;
  s.style.cssText = "position:fixed;left:24px;right:24px;bottom:18px;z-index:9;height:26px";
  var t = document.createElement("div");
  t.style.cssText = "position:fixed;right:24px;bottom:52px;z-index:9;color:#fff;font:600 14px ui-monospace,monospace";
  var playing = false, last = 0, at = 0;
  function show() { t.textContent = (at / 1000).toFixed(2) + "s"; s.value = at; window.seek(at); }
  s.addEventListener("input", function () { playing = false; at = +s.value; show(); });
  document.addEventListener("keydown", function (e) {
    if (e.code !== "Space") return;
    e.preventDefault();
    playing = !playing; last = performance.now();
    if (playing) requestAnimationFrame(tick);
  });
  function tick(now) {
    if (!playing) return;
    at = Math.min(${DURATION}, at + (now - last)); last = now;
    show();
    if (at < ${DURATION}) requestAnimationFrame(tick);
  }
  var wait = setInterval(function () {
    if (!window.__ready) return;
    clearInterval(wait);
    document.body.append(s, t); show();
  }, 60);
})();
</script>`;

// -------------------------------------------------------------------- CDP
//
// A hand-rolled client, because the alternative is a dependency and this repo
// does not have one. Four commands and one event is the whole surface used.

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("cdp: socket refused"));
  });
  let id = 0;
  const waiting = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      const { res, rej } = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? rej(new Error(`${m.method ?? "cdp"}: ${JSON.stringify(m.error)}`)) : res(m.result);
    } else if (m.method && listeners.has(m.method)) {
      const fns = listeners.get(m.method);
      listeners.set(m.method, []);
      fns.forEach((f) => f(m.params));
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((res, rej) => {
        const n = ++id;
        waiting.set(n, { res, rej });
        ws.send(JSON.stringify({ id: n, method, params }));
      }),
    once: (method) =>
      new Promise((r) => {
        if (!listeners.has(method)) listeners.set(method, []);
        listeners.get(method).push(r);
      }),
    close: () => ws.close(),
  };
}

async function launch(profile) {
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--force-color-profile=srgb",
      // Grayscale antialiasing everywhere. Subpixel AA puts colour fringes on
      // type, which H.264's chroma subsampling then smears.
      "--font-render-hinting=none",
      "--disable-lcd-text",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const target = list.find((t) => t.type === "page");
      if (target) return { proc, target };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  proc.kill();
  throw new Error("chrome never opened a debuggable page");
}

/** Poll the page for a flag rather than trusting a timer. */
async function waitFor(c, expr, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const { result } = await c.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    if (result.value) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ------------------------------------------------------------------ build

async function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/film") {
      const body = url.searchParams.has("scrub") ? page() + SCRUB : page();
      res.writeHead(200, { "content-type": "text/html" }).end(body);
      return;
    }
    previewRequest(req, res);
  });
  await new Promise((r) => server.listen(PORT, r));
  return server;
}

async function render({ frames, dir }) {
  const server = await serve();
  const profile = join(tmpdir(), `skrim-film-chrome-${process.pid}`);
  const { proc, target } = await launch(profile);
  const c = await cdp(target.webSocketDebuggerUrl);

  try {
    await c.send("Page.enable");
    await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", {
      width: W, height: H, deviceScaleFactor: DSF, mobile: false,
    });
    const loaded = c.once("Page.loadEventFired");
    await c.send("Page.navigate", { url: `http://localhost:${PORT}/film` });
    await loaded;
    await c.send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
    await waitFor(c, "window.__ready === true", "the popups to render and the timeline to build");

    const scale = await c.send("Runtime.evaluate", {
      expression: "document.documentElement.dataset.popScale", returnByValue: true,
    });
    console.log(`  popup scale ${scale.result.value}`);

    const started = Date.now();
    for (let i = 0; i < frames.length; i++) {
      const t = frames[i];
      await c.send("Runtime.evaluate", { expression: `window.seek(${t})` });
      const { data } = await c.send("Page.captureScreenshot", { format: "png" });
      await writeFile(join(dir, `f${String(i).padStart(5, "0")}.png`), Buffer.from(data, "base64"));
      if (i % 90 === 0 || i === frames.length - 1) {
        const done = i + 1;
        const rate = done / ((Date.now() - started) / 1000);
        process.stdout.write(
          `\r  frame ${done}/${frames.length}  ${(t / 1000).toFixed(1)}s  ` +
            `${rate.toFixed(1)} fps  eta ${Math.round((frames.length - done) / rate)}s   `,
        );
      }
    }
    process.stdout.write("\n");
  } finally {
    c.close();
    // Chrome is still flushing its profile when the kill lands, so wait for the
    // process to actually go before removing the directory under it.
    const gone = new Promise((r) => proc.once("exit", r));
    proc.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 120 });
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const work = join(tmpdir(), `skrim-film-${process.pid}`);
  await mkdir(work, { recursive: true });

  const count = Math.round((DURATION / 1000) * FPS);
  const frames = Array.from({ length: count }, (_, i) => Math.round((i * 1000) / FPS));
  console.log(`\nSkrim promo film — ${count} frames, ${DURATION / 1000}s at ${FPS}fps`);
  console.log(`  rendering ${W * DSF}x${H * DSF}, delivering ${W}x${H}`);

  await render({ frames, dir: work });

  const mp4 = join(OUT, "skrim-promo.mp4");
  console.log("  encoding …");
  await run("ffmpeg", [
    "-y", "-loglevel", "error",
    "-framerate", String(FPS),
    "-i", join(work, "f%05d.png"),
    // Supersample down from the dsf=2 render. Lanczos is what keeps the lit
    // edge a hairline instead of a smear.
    "-vf", `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "16",
    "-profile:v", "high", "-level", "4.2",
    "-x264-params", `keyint=${FPS * 2}:min-keyint=${FPS}:scenecut=0`,
    "-movflags", "+faststart",
    "-r", String(FPS),
    mp4,
  ]);

  // The YouTube thumbnail. Taken from the film rather than drawn separately, so
  // the still a viewer clicks is a frame of the thing they are about to watch.
  const poster = join(OUT, "skrim-promo-poster-1280x720.png");
  const posterFrame = join(work, `f${String(Math.round((C.hide.lift / 1000) * FPS)).padStart(5, "0")}.png`);
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-i", posterFrame,
    "-vf", "scale=1280:720:flags=lanczos", poster,
  ]);

  await rm(work, { recursive: true, force: true });

  for (const f of [mp4, poster]) {
    const { size } = await stat(f);
    console.log(`  ok   ${f.split("/").pop().padEnd(34)} ${(size / 1048576).toFixed(1)} MB`);
  }
  console.log(`\n-> ${OUT}`);
  console.log(`   scrub it:  node tools/make-promo-video.mjs --serve`);
}

// -------------------------------------------------------------------- cli

const cli = fileURLToPath(import.meta.url) === process.argv[1];
const argAt = process.argv.indexOf("--at");

if (!cli) {
  // imported: nothing runs
} else if (process.argv.includes("--serve")) {
  await serve();
  console.log(`film on http://localhost:${PORT}/film?scrub=1`);
  console.log("  drag the slider, or hit space to play it at wall speed");
} else if (argAt > -1) {
  // A beat, or a comma-separated list of them, for arguing about one moment
  // without re-rendering 1080 frames.
  const times = String(process.argv[argAt + 1]).split(",").map(Number);
  const work = join(tmpdir(), `skrim-film-at-${process.pid}`);
  await mkdir(work, { recursive: true });
  await render({ frames: times, dir: work });
  await mkdir(OUT, { recursive: true });
  for (const [i, t] of times.entries()) {
    const out = join(OUT, `frame-${t}.png`);
    await run("ffmpeg", ["-y", "-loglevel", "error",
      "-i", join(work, `f${String(i).padStart(5, "0")}.png`),
      "-vf", `scale=${W}:${H}:flags=lanczos`, out]);
    console.log(`-> ${out}`);
  }
  await rm(work, { recursive: true, force: true });
} else {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
