// Checks docs/store-listing.md against the things that can silently make it
// wrong -- Chrome's field caps, and the code the copy makes claims about.
//
//   node tools/check-listing.mjs    exit 0 == the listing is safe to paste
//
// A store listing is prose, so nothing about it goes red on its own. The three
// ways it rots are all mechanical, and all three are checked here:
//
//   1. A field grows past Chrome's cap. The dashboard truncates or rejects at
//      paste time, which is the worst moment to find out.
//   2. The Summary drifts from manifest.json's `description`. Chrome pre-fills
//      the field from the manifest, so the next package upload quietly reverts
//      an edit made only in the dashboard. They have to be byte-identical.
//   3. The code stops matching the copy. The description says "no network
//      requests at all" and every data category is declared Not collected --
//      one fetch() added anywhere in extension/ makes both statements false,
//      and a false data disclosure is a takedown, not a rejection.
//
// Adding a permission to the manifest also fails here until it has a written
// justification, because the dashboard will demand one and a hurried answer at
// submission time is how vague permission asks get written.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IMAGES, DECOYS, EXPOSED } from "./make-store-assets.mjs";
import { FIXTURES } from "./popup-preview.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LISTING = path.join(ROOT, "docs/store-listing.md");
const EXT = path.join(ROOT, "extension");
const STORE = path.join(ROOT, "brand/store");

const doc = fs.readFileSync(LISTING, "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

let pass = 0;
const failures = [];
const ok = (name) => { pass++; console.log(`  ok    ${name}`); };
const bad = (name, detail) => {
  failures.push(`${name} -- ${detail}`);
  console.log(`  FAIL  ${name}\n          ${detail}`);
};
const check = (name, cond, detail) => (cond ? ok(name) : bad(name, detail));

/**
 * Every fenced block under the heading whose text matches, in document order.
 * The copy lives in fences precisely so it can be extracted and measured
 * rather than eyeballed.
 */
function blocksUnder(headingRe) {
  const lines = doc.split("\n");
  const out = [];
  let live = false;
  let fence = false;
  let buf = [];
  for (const line of lines) {
    if (/^#{2,4} /.test(line) && !fence) {
      live = headingRe.test(line);
      continue;
    }
    if (line.startsWith("```")) {
      // Only a fence that closed under a matching heading is copy. Pushing on
      // every close is how this collected an empty block per fence in the file.
      if (fence && live) out.push(buf.join("\n"));
      if (fence) buf = [];
      fence = !fence;
      continue;
    }
    if (fence && live) buf.push(line);
  }
  return out;
}

/** The one block under a heading. Two would mean the doc grew an alternative. */
function blockUnder(headingRe, { index = 0 } = {}) {
  const found = blocksUnder(headingRe);
  if (!found.length) throw new Error(`no fenced block under ${headingRe}`);
  return found[index];
}

console.log("\nField limits\n");

// Chrome's caps, from the Developer Dashboard. Title and Summary are hard
// rejects; Description truncates. The justification fields cap at 1000, which
// is the one people trip over -- a thorough answer runs long.
const LIMITS = { title: 75, summary: 132, description: 16000, justification: 1000 };

const title = blockUnder(/### Title/);
check(
  `title <= ${LIMITS.title}`,
  title.length <= LIMITS.title,
  `${title.length} chars`,
);

const summaries = blocksUnder(/### Summary/);
summaries.forEach((s, i) => {
  check(
    `summary${i ? ` (alternative ${i})` : ""} <= ${LIMITS.summary}`,
    s.length <= LIMITS.summary,
    `${s.length} chars`,
  );
});

const description = blockUnder(/### Description/);
check(
  `description <= ${LIMITS.description}`,
  description.length <= LIMITS.description,
  `${description.length} chars`,
);

const purpose = blockUnder(/### Single purpose/);
check(
  `single purpose <= ${LIMITS.justification}`,
  purpose.length <= LIMITS.justification,
  `${purpose.length} chars`,
);

console.log("\nPermission justifications\n");

// Host permissions are declared as content_scripts matches here, not as a
// `host_permissions` key, but the dashboard asks for them the same way.
const hostMatches = (manifest.content_scripts ?? []).flatMap((c) => c.matches ?? []);
const declared = [...(manifest.permissions ?? []), ...new Set(hostMatches)];

for (const perm of declared) {
  const isHost = perm.includes("://") || perm.includes("<all_urls>");
  const heading = isHost
    ? /### Permission justification — host permissions/
    : new RegExp(`### Permission justification — \`${perm}\``);
  let text;
  try {
    text = blockUnder(heading);
  } catch {
    bad(`${perm} justified`, "no justification section in docs/store-listing.md");
    continue;
  }
  check(`${perm} justified`, text.trim().length > 0, "empty block");
  check(
    `${perm} <= ${LIMITS.justification}`,
    text.length <= LIMITS.justification,
    `${text.length} chars`,
  );
}

// The reverse direction: a justification for a permission that is no longer
// requested reads as sloppy at best and as a stale, wrong claim at worst.
const justified = [...doc.matchAll(/### Permission justification — `([^`]+)`/g)].map((m) => m[1]);
for (const perm of justified) {
  check(
    `${perm} still in manifest`,
    (manifest.permissions ?? []).includes(perm),
    "justified in the listing but not requested in manifest.json",
  );
}

console.log("\nClaims the copy makes about the code\n");

check(
  "summary matches manifest description",
  summaries[0] === manifest.description,
  `listing ${JSON.stringify(summaries[0])} vs manifest ${JSON.stringify(manifest.description)}`,
);

/** Every shipped source file. Fonts and icons are binary and cannot make a request. */
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "fonts" || e.name === "icons" ? [] : sources(p);
    return /\.(js|html|css)$/.test(e.name) ? [p] : [];
  });
}

// The load-bearing claim. "No network requests at all" and nine categories of
// "Not collected" both rest on this being empty.
const EGRESS = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|EventSource|importScripts/;
const REMOTE = /https?:\/\//;
const egress = [];
const remote = [];
for (const file of sources(EXT)) {
  const src = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file);
  src.split("\n").forEach((line, i) => {
    // A comment mentioning fetch is not a fetch. Strip the obvious ones so the
    // check stays quiet enough that a real hit is visible.
    const code = line.replace(/^\s*(\/\/|\*|<!--).*$/, "");
    if (EGRESS.test(code)) egress.push(`${rel}:${i + 1}`);
    if (/\.(html|css)$/.test(file) && REMOTE.test(code)) remote.push(`${rel}:${i + 1}`);
  });
}
check("no network egress in extension/", egress.length === 0, egress.join(", "));
check("no remote resources in extension/", remote.length === 0, remote.join(", "));

// setUninstallURL is the one line that would turn an uninstall into a real
// request. It is guarded on UNINSTALL_PING, which is false, so today it never
// fires -- and the description says so.
//
// RECOVERY_BASE is deliberately NOT what this checks. A receipt pointing at a
// hosted page puts its payload in the fragment, which no browser transmits, so
// that is a link the user may click and not a request Skrim makes. Only the
// ping carries `n` and `at` in a query string, and only the ping is a claim.
const receipt = fs.readFileSync(path.join(EXT, "src/receipt.js"), "utf8");
check(
  "UNINSTALL_PING still false",
  /export const UNINSTALL_PING = false;/.test(receipt),
  "an uninstall URL is a real request carrying a count and a timestamp -- the description and site/privacy.html both have to change with it",
);
check(
  "the uninstall URL is gated on the ping, not on the recovery page",
  /!receipt\.UNINSTALL_PING\) return;/.test(
    fs.readFileSync(path.join(EXT, "src/sw.js"), "utf8"),
  ),
  "sw.js must gate setUninstallURL on UNINSTALL_PING, or a hosted receipt silently turns the ping on",
);

check(
  "min chrome version matches the copy",
  new RegExp(`Chrome ${manifest.minimum_chrome_version} or later`).test(description),
  `manifest says ${manifest.minimum_chrome_version}`,
);

console.log("\nStore images\n");

/**
 * Width and height straight out of the PNG header: 8-byte signature, then the
 * IHDR length and type, then the two dimensions. No decoding and no dependency
 * -- and it is the same bytes the dashboard reads, which is the point. A
 * screenshot that is 1281 wide is rejected at upload with a message that does
 * not say which file.
 */
function png(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(sig)) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

// Chrome takes at most five screenshots. Producing a sixth means one silently
// never reaches the listing.
const shots = IMAGES.filter((i) => i.field === "Screenshot");
check("1-5 screenshots", shots.length >= 1 && shots.length <= 5, `${shots.length} defined`);

for (const img of IMAGES) {
  const file = path.join(STORE, img.file);
  if (!fs.existsSync(file)) {
    bad(`${img.file}`, "missing -- run `node tools/make-store-assets.mjs`");
    continue;
  }
  const meta = png(file);
  if (!meta) {
    bad(`${img.file}`, "not a PNG");
    continue;
  }
  check(
    `${img.file} is ${img.w}x${img.h}`,
    meta.w === img.w && meta.h === img.h,
    `${meta.w}x${meta.h} -- ${img.field} must be exactly ${img.w}x${img.h}`,
  );
  // A headless render that failed to load the page still writes a valid PNG:
  // one flat colour, a few KB. That is the failure this catches.
  check(
    `${img.file} is not blank`,
    meta.bytes > 20_000,
    `${(meta.bytes / 1024).toFixed(0)} KB -- suspiciously small for a rendered composition`,
  );
}

console.log("\nPromo video\n");

// Not a dashboard image -- the store's video field takes a YouTube URL -- but
// the two files behind that URL rot the same way the PNGs do, and they rot
// silently because nobody re-watches 36 seconds before a resubmit. So: the
// master exists and is not a stub, and the thumbnail is exactly the size
// YouTube's custom-thumbnail upload demands.
const VIDEO = path.join(ROOT, "brand/video");
const mp4 = path.join(VIDEO, "skrim-promo.mp4");
if (!fs.existsSync(mp4)) {
  bad("skrim-promo.mp4", "missing -- run `node tools/make-promo-video.mjs`");
} else {
  const bytes = fs.statSync(mp4).size;
  // The ftyp box, at offset 4. A truncated or half-written render is the
  // failure this catches, and it is the same four bytes a player reads.
  const head = fs.readFileSync(mp4).subarray(4, 8).toString("latin1");
  check("skrim-promo.mp4 is an mp4", head === "ftyp", `starts ${JSON.stringify(head)}`);
  check(
    "skrim-promo.mp4 is not a stub",
    bytes > 400_000,
    `${(bytes / 1048576).toFixed(1)} MB -- too small for 36s of 1080p`,
  );
}

const posterFile = path.join(VIDEO, "skrim-promo-poster-1280x720.png");
if (!fs.existsSync(posterFile)) {
  bad("skrim-promo-poster-1280x720.png", "missing -- run `node tools/make-promo-video.mjs`");
} else {
  const meta = png(posterFile);
  check(
    "poster is 1280x720",
    meta && meta.w === 1280 && meta.h === 720,
    meta ? `${meta.w}x${meta.h}` : "not a PNG",
  );
  check(
    "poster is not blank",
    meta && meta.bytes > 20_000,
    meta ? `${(meta.bytes / 1024).toFixed(0)} KB` : "not a PNG",
  );
}

// The film says the numbers out loud -- "12 bookmarks moved into a folder, 6
// forgettable stand-ins took their place" -- with the real popup on screen
// beside the caption reading `12 bookmarks` and `6 items`. The caption is built
// from these two arrays and the popup from this fixture, so this is the check
// that the two still agree. make-store-assets.mjs makes the same check for
// `shielded`, which is the screenshots' state; this is the film's.
const film = FIXTURES.justHidden?.status;
check(
  "film's popup fixture matches the film's captions",
  film?.itemsDisplaced === EXPOSED.length && film?.bars?.[0]?.children === DECOYS.length,
  film
    ? `caption says ${EXPOSED.length} tucked and ${DECOYS.length} standing in, ` +
      `popup says ${film.itemsDisplaced} and ${film.bars?.[0]?.children}`
    : "FIXTURES.justHidden is gone -- tools/make-promo-video.mjs renders it",
);

// Screenshot 2 draws the stand-in bookmarks the extension leaves on the bar. If
// engine.js grows, drops or renames one, that image shows a bar the extension
// never produces -- which is a misleading screenshot, not a cosmetic drift.
const engine = fs.readFileSync(path.join(EXT, "src/engine.js"), "utf8");
const block = /const DECOYS = \[([\s\S]*?)\];/.exec(engine)?.[1] ?? "";
const real = [...block.matchAll(/title:\s*"([^"]+)"/g)].map((m) => m[1]);
check(
  "screenshot decoys match engine.js",
  real.length > 0 && real.join("|") === DECOYS.join("|"),
  `engine.js has [${real.join(", ")}], the screenshot draws [${DECOYS.join(", ")}]`,
);

console.log("\n" + "=".repeat(66));
console.log("Skrim store listing");
console.log("=".repeat(66));
console.log(`  checks passed : ${pass}`);
console.log(`  checks failed : ${failures.length}`);
console.log(`\n  Field sizes (cap):`);

// Over the cap is a failure; within 5% of it is a warning, because the next
// edit is what breaks it and the paste is where you would find out.
const size = (label, n, cap) => {
  const tight = n > cap * 0.95 && n <= cap ? "  <- tight" : "";
  console.log(`    ${label.padEnd(14)}: ${n} (${cap})${tight}`);
};

size("title", title.length, LIMITS.title);
summaries.forEach((s, i) => size(i ? `summary alt ${i}` : "summary", s.length, LIMITS.summary));
size("description", description.length, LIMITS.description);
size("purpose", purpose.length, LIMITS.justification);
for (const perm of justified) {
  const n = blockUnder(new RegExp(`### Permission justification — \`${perm}\``)).length;
  size(perm, n, LIMITS.justification);
}
size("host perms", blockUnder(/### Permission justification — host permissions/).length, LIMITS.justification);

if (failures.length) {
  console.log(`\n  FAILURES:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log("=".repeat(66));
process.exit(failures.length === 0 ? 0 : 1);
