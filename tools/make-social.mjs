// Social cover build.
//
//   node tools/make-social.mjs
//
// The card IS the mark. A Skrim cover is not a logo dropped onto a gradient --
// it is brand/logo/mark-primary.svg redrawn at poster scale, using the same
// geometry make-icons.mjs uses: a scrim parked at 41% of the height, a hard
// leading edge, and content lines underneath it. Blow that up to 1200x630 and
// the "content lines" become a real bookmark bar, so the metaphor survives the
// change in size instead of becoming decoration.
//
// Three cuts come out of it:
//
//   skrim-og-{1200x630}.png       link previews. OG / Twitter card / LinkedIn.
//   skrim-x-header-{1500x500}.png X profile header. Avatar overlaps bottom-left.
//   skrim-square-{1080x1080}.png  IG, LinkedIn feed, Mastodon.
//
// Each is composed by hand rather than scaled from one master -- a 1200x630
// layout squeezed into 1500x500 puts the headline where X paints the avatar.
// What they share is the geometry and the tokens, not the arrangement.
//
// Two rules from the brand guideline drive every colour decision here:
//
//   1. Green means covered. The scrim is the only green thing on the card. The
//      bookmarks it is about to swallow are neutral, because content that is
//      still exposed must never wear the colour that means "safe".
//   2. Type on a green fill is ink. White on green-400 measures 1.78:1.
//
// Rasterised by the Chrome already on the machine, same as make-icons.mjs --
// this repo has no package.json and is not about to grow one. Rendered at
// dsf=2 and kept at both sizes: timelines serve the 2x, OG scrapers want the
// nominal one.

import { mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "brand", "social");
const FONTS = join(ROOT, "extension", "fonts");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// ------------------------------------------------------------------ tokens

// Lifted from brand/tokens.css. Only the steps this composition actually uses,
// named the same, so a retune there is a find-and-replace here.
const T = {
  green400: "#17DE82", // core fill -- the scrim
  green200: "#8DF7C2", // the lit leading edge. two steps up from the fill is
  //                      the least it can be and still separate from it.
  ink950: "#0A100E", // ground, and type on green
  ink900: "#161D1A",
  ink800: "#28312D", // the bookmark chips
  ink700: "#3C4642",
  ink600: "#515C57",
  ink500: "#6C7873",
  ink400: "#94A09A",
  ink300: "#BFC7C2",
  ink100: "#EAEDEB",
};

// The scrim at rest, straight out of make-icons.mjs: 11.5 of the mark's 28px
// box. Every cut below parks its scrim here, which is why they look related
// across three different aspect ratios.
const REST = 11.5 / 28; // 0.4107

// ---------------------------------------------------------------- the mark

// brand/logo/mark-primary.svg, inlined so the card has no external refs.
const markPrimary = (size) =>
  `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">` +
  `<defs><clipPath id="mk"><rect x="2" y="2" width="28" height="28" rx="6"/></clipPath></defs>` +
  `<rect x="2" y="2" width="28" height="28" rx="6" fill="${T.ink950}"/>` +
  `<rect x="7.5" y="14.5" width="15" height="3" rx="1.5" fill="${T.green400}" opacity=".5"/>` +
  `<rect x="7.5" y="20.5" width="10" height="3" rx="1.5" fill="${T.green400}" opacity=".5"/>` +
  `<g clip-path="url(#mk)"><rect x="2" y="2" width="28" height="11.5" fill="${T.green400}"/></g>` +
  `</svg>`;

// ------------------------------------------------------------------- copy

// The positioning splits in two and the layout splits with it: market on the
// fear, position on the polish. So the polish line goes in the green -- the
// one thing a reader takes from a thumbnail -- and the fear is carried
// wordlessly by the bookmarks caught under the scrim's edge.
const HEADLINE = "Presenter Mode for your whole Mac.";
const SUB = "One keystroke covers all of it — and puts it back exactly where it was.";
const DOMAIN = "skrim.app";

// The nightmare, roughly in order of how much you would hate explaining it.
// One flat pool rather than fixed rows, because a row has to be long enough to
// run off the right edge of whichever card it lands on -- a bookmark bar that
// stops short of the edge looks like a diagram of a bookmark bar. Each format
// slices the pool into rows of its own length and lets overflow do the rest.
//
// The first nine matter most: they are the row the scrim catches mid-swallow,
// legible for exactly as long as it takes to read them and no longer.
const TONES = [T.ink600, T.ink500, T.ink400];
const LABELS = [
  "Salary negotiation · scripts", "Indeed · Senior roles",
  "Am I underpaid? (calc)", "resume-FINAL-v7.pdf",
  "glassdoor.com/reviews", "How to quit gracefully",
  "competitor-pricing.xlsx", "LinkedIn · Open to work",
  "Zillow · Austin, TX",

  "r/overemployed", "Two weeks notice — draft", "severance, how much?",
  "payslip-2026-Q2.pdf", "Notion · Exit plan", "Burnout quiz — results",
  "equity-vesting-schedule", "Flight deals · Lisbon", "Watch later (47)",

  "HR handbook · §4 Leave", "Cover letter (reuse)", "Mortgage calculator",
  "is my manager gaslighting", "Visa · digital nomad", "Tax return 2025",
  "Standing desk, 40% off", "Bali flights · Nov", "dentist · overdue",

  "Duolingo · 3 day streak", "New tab, but honest", "sleep score: 41",
  "Aeropress vs Chemex", "how to read a cap table", "Recruiter · unread (12)",
  "1099-NEC · where?", "Couch to 5K week 1 (again)", "vet — Biscuit, Thurs",

  "offer-letter-compare.numbers", "Remote jobs · Europe", "grocery list",
  "does he like me quiz", "PTO balance · 3.5 days", "Costco · membership",
  "hbo max", "Wordle", "cheap flights anywhere",

  "team-restructure-draft.docx", "Rent vs buy calculator", "Nap pods, seriously",
  "Kayak · one way", "manager 1:1 notes (real)", "learn Rust in 30 days",
  "IKEA · Billy shelf", "how much is my car worth",
];

const CHIP_POOL = LABELS.map((label, i) => [
  (label.match(/[a-zA-Z]/)?.[0] ?? "•").toUpperCase(),
  label,
  TONES[i % TONES.length],
]);

const chipRow = (row) =>
  `<div class="row">` +
  row
    .map(
      ([letter, label, tone]) =>
        `<div class="chip"><span class="fav" style="background:${tone}">${letter}</span>${label}</div>`,
    )
    .join("") +
  `</div>`;

// Slice the pool into `rows` rows of `perRow`. perRow is chosen per format to
// overrun the card's width, never to fit inside it.
const chipField = (rows, perRow) => {
  // Running out silently would render short rows that stop mid-card, which is
  // the one thing the bleed exists to prevent. Fail loudly instead.
  if (rows * perRow > CHIP_POOL.length) {
    throw new Error(
      `chip pool exhausted: ${rows}x${perRow} needs ${rows * perRow}, ` +
        `pool has ${CHIP_POOL.length}. Add labels.`,
    );
  }
  return Array.from({ length: rows }, (_, r) =>
    chipRow(CHIP_POOL.slice(r * perRow, (r + 1) * perRow)),
  );
};

const keycaps = (keys) =>
  `<div class="keys">` +
  keys.map((k) => `<kbd>${k}</kbd>`).join("") +
  `</div>`;

// ------------------------------------------------------------------ layout

/**
 * One card.
 *
 * Everything is absolutely positioned off the card's own box. The scrim is
 * painted last over the chip field, so the row that straddles its edge gets
 * clipped mid-letterform -- that clip is the whole idea, and it is the only
 * part of the composition that must not be nudged for looks.
 *
 * @param w,h        pixel size, nominal (rendered at 2x)
 * @param padX       left/right margin. Everything on the card aligns to it,
 *                   above and below the scrim.
 * @param padY       top/bottom margin. Independent of padX because the scrim
 *                   is the tight axis -- 41% of the height is not much room.
 * @param scrimH     where the leading edge lands. REST * h unless the format
 *                   forces otherwise.
 * @param chipTop    top of the first chip row. Set so it straddles scrimH.
 * @param bottomAt   the sub-copy + keycap bar, or null to omit
 */
function card({
  w,
  h,
  padX,
  padY,
  scrimH,
  markSize,
  wordSize,
  headSize,
  headWidth,
  chipTop,
  chipH,
  chipGap,
  chipRows,
  chipPerRow,
  chipSize,
  subSize,
  subWidth = null,
  bottomAt,
  bottomLeft = null,
  domainInScrim = true,
  headLead = 1.0,
}) {
  const glow = Math.round(h * 0.085);
  return `
<div class="card" style="width:${w}px;height:${h}px">

  <!-- the field: everything the scrim has not reached yet -->
  <div class="chips" style="left:${padX}px;right:0;top:${chipTop}px">
    ${chipField(chipRows, chipPerRow).join("\n    ")}
  </div>

  <!-- the scrim, parked at rest. painted over the field. -->
  <div class="scrim" style="height:${scrimH}px;padding:${padY}px ${padX}px">
    <div class="lock">
      ${markPrimary(markSize)}
      <span class="word" style="font-size:${wordSize}px">Skrim</span>
      ${domainInScrim ? `<span class="domain">${DOMAIN}</span>` : ""}
    </div>
    <h1 style="font-size:${headSize}px;max-width:${headWidth}px;line-height:${headLead}">${HEADLINE}</h1>
  </div>
  <div class="edge" style="top:${scrimH}px"></div>
  <div class="glowfall" style="top:${scrimH + 3}px;height:${glow}px"></div>

  ${
    bottomAt == null
      ? ""
      : `<div class="bottom" style="left:${bottomLeft ?? padX}px;right:${padX}px;top:${bottomAt}px">
    <p style="font-size:${subSize}px${subWidth ? `;max-width:${subWidth}px` : ""}">${SUB}</p>
    ${keycaps(["⌘", "⇧", "H"])}
  </div>`
  }
  ${domainInScrim ? "" : `<div class="domain loose" style="right:${padX}px;bottom:${padY}px">${DOMAIN}</div>`}

  <style>
    .card .chips { position:absolute; display:flex; flex-direction:column; gap:${chipGap}px; }
    .card .row { display:flex; gap:${Math.round(chipGap * 0.85)}px; white-space:nowrap; }
    .card .chip {
      display:flex; align-items:center; gap:${Math.round(chipH * 0.24)}px; flex:none;
      height:${chipH}px; padding:0 ${Math.round(chipH * 0.36)}px;
      border-radius:${Math.round(chipH * 0.26)}px;
      background:${T.ink900}; border:1px solid ${T.ink800};
      color:${T.ink300}; font-size:${chipSize}px; font-weight:500; letter-spacing:-.005em;
    }
    .card .fav {
      display:flex; align-items:center; justify-content:center; flex:none;
      width:${Math.round(chipH * 0.5)}px; height:${Math.round(chipH * 0.5)}px;
      border-radius:${Math.round(chipH * 0.15)}px;
      font-family:var(--mono); font-size:${Math.round(chipH * 0.28)}px; font-weight:600;
      color:${T.ink950};
    }
  </style>
</div>`;
}

// ---------------------------------------------------------------- document

async function page(body, w, h) {
  const sans = await readFile(join(FONTS, "InstrumentSans-latin.woff2"));
  const mono = await readFile(join(FONTS, "GeistMono.woff2"));
  const uri = (b) => `data:font/woff2;base64,${b.toString("base64")}`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family:"Instrument Sans"; font-weight:400 700; font-display:block;
  src:url("${uri(sans)}") format("woff2"); }
@font-face { font-family:"Geist Mono"; font-weight:100 900; font-display:block;
  src:url("${uri(mono)}") format("woff2"); }

:root {
  --mono:"Geist Mono", ui-monospace, Menlo, monospace;
}
html,body { margin:0; padding:0; background:${T.ink950}; }
body { font-family:"Instrument Sans", -apple-system, sans-serif;
       -webkit-font-smoothing:antialiased; }

.card { position:relative; overflow:hidden; background:${T.ink950}; }

/* A whisper of light in the field below the scrim, so the ground is not dead
   flat. Kept under 5% -- any more and it reads as a gradient, which the brand
   is not, and it starts to look like green is loose on the card. */
.card::before {
  content:""; position:absolute; inset:0;
  background:radial-gradient(75% 55% at 22% 88%, rgba(23,222,130,.042), transparent 70%);
}

.scrim {
  position:absolute; left:0; right:0; top:0; background:${T.green400};
  display:flex; flex-direction:column; justify-content:space-between;
  box-sizing:border-box; color:${T.ink950};
}
/* The leading edge. It sits just BELOW the scrim rather than inside it: on
   green it is invisible, on the dark field it is a lit hairline with the
   bookmarks it is mid-way through swallowing showing underneath. The scrim is
   a lit object travelling down, so the light falls onto what it is about to
   cover -- never a drop shadow, which would make the protective thing heavy. */
.edge {
  position:absolute; left:0; right:0; height:3px; background:${T.green200};
  box-shadow:0 5px 18px -4px rgba(141,247,194,.42);
}
/* Deliberately faint. Anything stronger casts green over bookmarks that are
   still exposed, and green on this card is only ever allowed to mean covered. */
.glowfall {
  position:absolute; left:0; right:0;
  background:linear-gradient(rgba(23,222,130,.07), rgba(23,222,130,0));
}

.lock { display:flex; align-items:center; gap:14px; }
.lock .mark { display:block; border-radius:2px; }
.word { font-weight:700; letter-spacing:-.03em; line-height:1; }
.domain {
  margin-left:auto; font-family:var(--mono); font-size:19px; font-weight:500;
  letter-spacing:.01em; color:${T.ink950}; opacity:.68;
}
.domain.loose { position:absolute; margin:0; color:${T.ink500}; opacity:1; }

h1 { margin:0; font-weight:700; letter-spacing:-.035em; color:${T.ink950};
     text-wrap:balance; }

.bottom { position:absolute; display:flex; align-items:center; justify-content:space-between; gap:32px; }
.bottom p { margin:0; color:${T.ink400}; font-weight:450; letter-spacing:-.01em; }

.keys { display:flex; gap:7px; flex:none; }
kbd {
  display:flex; align-items:center; justify-content:center;
  min-width:34px; height:34px; padding:0 9px; box-sizing:border-box;
  border-radius:8px; background:${T.ink900};
  border:1px solid ${T.ink700}; border-bottom-color:${T.ink600};
  color:${T.ink100}; font-family:var(--mono); font-size:15px; font-weight:500;
}
</style></head><body>${body}</body></html>`;
}

// ------------------------------------------------------------------- cuts

// 1200x630. The one that matters: OG, Twitter summary_large_image, LinkedIn,
// Slack unfurls. Scrim at exactly REST, chips straddling its edge.
const OG = () => {
  const h = 630;
  const scrimH = Math.round(h * REST); // 259
  return card({
    w: 1200, h, padX: 68, padY: 50, scrimH,
    markSize: 44, wordSize: 34, headSize: 58, headWidth: 1064, headLead: 1.0,
    // 42px chip cut 15 from the top: the bottom 64% shows, which is the half
    // of a letterform you can still read. Cut it in half and it turns to mush.
    chipTop: scrimH - 15,
    chipH: 42, chipGap: 14, chipRows: 4, chipPerRow: 7, chipSize: 17,
    subSize: 22, bottomAt: 528,
  });
};

// 1500x500. X paints the profile avatar over the bottom-left corner, so that
// corner is left deliberately empty -- the sub-copy starts well clear of it --
// and the scrim sits deeper than REST would put it, because 41% of 500px is
// not enough room for a lockup and a headline.
const XHEADER = () => {
  const h = 500;
  const scrimH = 236;
  return card({
    w: 1500, h, padX: 64, padY: 44, scrimH,
    markSize: 40, wordSize: 32, headSize: 54, headWidth: 1372, headLead: 1.0,
    chipTop: scrimH - 14,
    chipH: 40, chipGap: 13, chipRows: 3, chipPerRow: 9, chipSize: 16,
    subSize: 19, bottomAt: 414, bottomLeft: 470,
  });
};

// 1080x1080. Feed post. Tall enough for the headline to break to two lines,
// which is where it reads best, and for four chip rows under the edge.
const SQUARE = () => {
  const h = 1080;
  const scrimH = Math.round(h * REST); // 444
  return card({
    w: 1080, h, padX: 72, padY: 66, scrimH,
    markSize: 50, wordSize: 39, headSize: 78, headWidth: 830, headLead: 1.0,
    chipTop: scrimH - 17,
    chipH: 46, chipGap: 15, chipRows: 7, chipPerRow: 7, chipSize: 18,
    subSize: 24, subWidth: 620, bottomAt: 930,
  });
};

const CUTS = [
  { name: "skrim-og", w: 1200, h: 630, body: OG },
  { name: "skrim-x-header", w: 1500, h: 500, body: XHEADER },
  { name: "skrim-square", w: 1080, h: 1080, body: SQUARE },
];

// ------------------------------------------------------------------ build

async function main() {
  const work = join(tmpdir(), `skrim-social-${process.pid}`);
  await mkdir(work, { recursive: true });
  await mkdir(OUT, { recursive: true });

  for (const cut of CUTS) {
    const html = join(work, `${cut.name}.html`);
    const at2x = join(OUT, `${cut.name}@2x.png`);
    const at1x = join(OUT, `${cut.name}.png`);
    await writeFile(html, await page(cut.body(), cut.w, cut.h), "utf8");

    await run(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=2",
      // The fonts are data: URIs but Chrome still screenshots on its own
      // schedule; virtual time makes it wait for layout to settle.
      "--virtual-time-budget=4000",
      `--window-size=${cut.w},${cut.h}`,
      `--screenshot=${at2x}`,
      `file://${html}`,
    ]).catch((e) => {
      // Chrome writes benign task_policy_set noise to stderr on macOS and
      // exits non-zero often enough that the file is the only honest check.
      if (!e.stdout && !e.stderr) throw e;
    });

    await copyFile(at2x, at1x);
    await run("/usr/bin/sips", ["-Z", String(Math.max(cut.w, cut.h)), at1x]);

    const { stdout } = await run("/usr/bin/sips", [
      "-g", "pixelWidth", "-g", "pixelHeight", at2x,
    ]);
    const px = `${/pixelWidth: (\d+)/.exec(stdout)?.[1]}x${
      /pixelHeight: (\d+)/.exec(stdout)?.[1]
    }`;
    const ok = px === `${cut.w * 2}x${cut.h * 2}`;
    console.log(`${ok ? "ok  " : "BAD "} ${cut.name}  ${px}  (+ 1x)`);
    if (!ok) process.exitCode = 1;
  }

  console.log(`\n-> ${OUT}`);
  console.log(`   html kept for inspection: ${work}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
