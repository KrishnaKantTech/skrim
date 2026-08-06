// Icon build.
//
//   node tools/make-icons.mjs
//
// Chrome will not take an SVG for `manifest.icons` or `action.default_icon`, so
// the brand marks have to be rasterised. Everything here is generated from the
// same geometry definition brand/logo/*.svg is generated from -- a 32px grid, a
// 6px corner, three content lines, and a scrim covering the top 41% at rest --
// so the toolbar, the popup and the web store listing cannot drift apart.
//
// Two families come out of it:
//
//   skrim-{16,32,48,128}.png     the product mark. ink ground, green scrim.
//   state-{armed,hidden,exposed}-{16,32}.png
//                                the toolbar. monochrome, transparent ground.
//
// The state set is why the toolbar icon needs no badge: the scrim's POSITION is
// the state, so the icon changes shape rather than gaining a dot. That is also
// what keeps it readable for the ~1 in 12 men who cannot separate our green
// from our flare -- armed, hidden and exposed are three different silhouettes
// before they are three different colours.
//
// Rasterised by the Chrome already on the machine rather than a native image
// library: this repo has no package.json and is not about to grow one for ten
// PNGs. Supersampled 4x and reduced, which is visibly cleaner at 16px than
// asking Chrome to antialias a 1.5px line directly.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "extension", "icons");
const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// Supersample factor. 4 is where the reduced 16px mark stops looking chewed.
const SS = 4;

// ---------------------------------------------------------------- geometry

// Ratios in the 32px grid, kept as numbers so the relationship between the
// scrim height and the mark is visible rather than a magic 11.5.
const G = {
  box: { x: 2, y: 2, w: 28, h: 28, r: 6 },
  edge: { x: 3.125, y: 3.125, w: 25.75, h: 25.75, r: 4.875, stroke: 2.25 },
  scrimAtRest: 11.5, // 41% of the 28px box
  lines: [
    { x: 7.5, y: 8.5, w: 12, h: 3, r: 1.5 },
    { x: 7.5, y: 14.5, w: 15, h: 3, r: 1.5 },
    { x: 7.5, y: 20.5, w: 10, h: 3, r: 1.5 },
  ],
};

const rect = (r, fill, extra = "") =>
  `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"` +
  (r.r != null ? ` rx="${r.r}"` : "") +
  ` fill="${fill}"${extra}/>`;

/**
 * One mark.
 *
 * @param scrim   how far down the scrim has travelled, 0..1. 0.41 is rest,
 *                1 is fully covered, 0 is retracted and the bar is showing.
 * @param lines   which content lines are drawn. The scrim covers the top one
 *                at rest, so armed only needs the lower two.
 * @param ground  a fill behind everything (the product mark), or null for the
 *                transparent monochrome cut the toolbar uses.
 * @param edge    draw the outline. The fully-covered mark is a solid block and
 *                does not need one.
 */
function mark({ fg, ground = null, scrim, lines, edge = true, lineAlpha = 0.5 }) {
  const parts = [];
  if (ground) parts.push(rect(G.box, ground));
  for (const i of lines) {
    parts.push(rect(G.lines[i], fg, ` opacity="${lineAlpha}"`));
  }
  const h = G.box.h * scrim;
  if (h > 0) {
    parts.push(
      `<g clip-path="url(#c)">` +
        rect({ x: G.box.x, y: G.box.y, w: G.box.w, h }, fg) +
        `</g>`,
    );
  }
  if (edge) {
    parts.push(
      `<rect x="${G.edge.x}" y="${G.edge.y}" width="${G.edge.w}"` +
        ` height="${G.edge.h}" rx="${G.edge.r}" fill="none"` +
        ` stroke="${fg}" stroke-width="${G.edge.stroke}"/>`,
    );
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<defs><clipPath id="c">` +
    `<rect x="${G.box.x}" y="${G.box.y}" width="${G.box.w}" height="${G.box.h}" rx="${G.box.r}"/>` +
    `</clipPath></defs>` +
    parts.join("") +
    `</svg>`
  );
}

// ------------------------------------------------------------------ tokens

// Lifted from brand/tokens.css. The toolbar sits on browser chrome that may be
// light or dark and chrome.action cannot react to that, so the state icons take
// the tokens that clear 3:1 against a light toolbar and still read against a
// dark one -- accent-dot and exposed-dot, not the brighter core fills.
const INK = "#0A100E"; // ink-950
const GREEN = "#17DE82"; // green-400, the core fill
const ACCENT_DOT = "#00A65C"; // green-600
const EXPOSED_DOT = "#F0472C"; // flare-500

const REST = G.scrimAtRest / G.box.h;

const ICONS = [
  // The product mark: ink ground, green scrim, at rest. Web store + install.
  ...[16, 32, 48, 128].map((size) => ({
    name: `skrim-${size}`,
    size,
    svg: mark({ fg: GREEN, ground: INK, scrim: REST, lines: [1, 2], edge: false }),
  })),

  // Nothing sharing, auto-hide watching. Scrim parked at rest.
  ...[16, 32].map((size) => ({
    name: `state-armed-${size}`,
    size,
    svg: mark({ fg: ACCENT_DOT, scrim: REST, lines: [1, 2] }),
  })),

  // Covered. The scrim is all the way down and the mark is a solid block.
  ...[16, 32].map((size) => ({
    name: `state-hidden-${size}`,
    size,
    svg: mark({ fg: ACCENT_DOT, scrim: 1, lines: [], edge: false }),
  })),

  // A share is live and the bar is still up: scrim retracted, every line at
  // full strength. The only flare-coloured state in the product.
  ...[16, 32].map((size) => ({
    name: `state-exposed-${size}`,
    size,
    svg: mark({
      fg: EXPOSED_DOT,
      scrim: 0,
      lines: [0, 1, 2],
      lineAlpha: 1,
    }),
  })),
];

// ------------------------------------------------------------------- build

const page = (svg, size) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `html,body{margin:0;padding:0;background:transparent}` +
  `svg{display:block;width:${size}px;height:${size}px}` +
  `</style></head><body>${svg}</body></html>`;

async function main() {
  const work = join(tmpdir(), `skrim-icons-${process.pid}`);
  await mkdir(work, { recursive: true });
  await mkdir(OUT, { recursive: true });

  for (const icon of ICONS) {
    const big = icon.size * SS;
    const html = join(work, `${icon.name}.html`);
    const png = join(OUT, `${icon.name}.png`);
    await writeFile(html, page(icon.svg, big), "utf8");

    await run(CHROME, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--default-background-color=00000000",
      `--window-size=${big},${big}`,
      `--screenshot=${png}`,
      `file://${html}`,
    ]).catch((e) => {
      // Chrome writes benign task_policy_set noise to stderr on macOS and
      // exits non-zero often enough that the file is the only honest check.
      if (!e.stdout && !e.stderr) throw e;
    });

    // sips reduces in place and keeps the alpha channel.
    await run("/usr/bin/sips", ["-Z", String(icon.size), png], {}).catch(
      () => {},
    );

    const { stdout } = await run("/usr/bin/sips", [
      "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", png,
    ]);
    const w = /pixelWidth: (\d+)/.exec(stdout)?.[1];
    const h = /pixelHeight: (\d+)/.exec(stdout)?.[1];
    const a = /hasAlpha: (\w+)/.exec(stdout)?.[1];
    if (Number(w) !== icon.size || Number(h) !== icon.size) {
      throw new Error(`${icon.name}: got ${w}x${h}, wanted ${icon.size}`);
    }
    console.log(`  ${icon.name}.png  ${w}x${h}  alpha=${a}`);
  }

  await rm(work, { recursive: true, force: true });
  console.log(`\n${ICONS.length} icons -> extension/icons/`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
