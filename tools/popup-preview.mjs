// Popup preview harness.
//
// Serves the REAL extension/popup.{html,css,js} with a stubbed chrome.runtime,
// so every state the popup can be in is reachable without a browser profile, a
// live share, or a failed restore to reproduce by hand:
//
//   node tools/popup-preview.mjs
//   open http://localhost:8731/?state=shielded
//
//   ?state=  armed | exposed | shielded | manual | peer | busy | alerts
//            (default armed)
//   &dev=1   open the Developer disclosure
//   &theme=light  force light mode (see the note on the CSS route below)
//
// Fixtures are shaped exactly like the worker's `status`, `shares` and
// `lastFailure` replies; if one drifts from the engine, the popup will render
// something the real extension never produces, so keep them honest.
//
// `FIXTURES` and `previewRequest` are exported because tools/make-store-assets.mjs
// mounts this same handler behind its own routes: a store screenshot has to show
// the shipped popup, and the composition page has to be same-origin with it to
// size the iframe to the popup's real height.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const PORT = Number(process.env.PORT ?? 8731);

const now = Date.now();
const bar = (children, syncing = false) => ({ barId: "1", syncing, children });

export const FIXTURES = {
  // At rest: nothing sharing, bar intact.
  armed: {
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      // 12 to match `shielded`'s itemsDisplaced: the store screenshots run these
      // two states as a before/after pair, and a bar of 9 that hides 12 is the
      // kind of arithmetic a reader does for you. make-store-assets.mjs throws
      // if the two ever disagree.
      ownedVaults: 0, pendingAdoption: [], skippedBars: 0, bars: [bar(12)],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: null,
  },
  // The one state that is a problem: a share is live and the bar is still up,
  // which is what the user sees if they restored by hand mid-meeting.
  exposed: {
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      ownedVaults: 0, pendingAdoption: [], skippedBars: 0, bars: [bar(9)],
    },
    shares: { sharing: 1, frames: [{ frame: "42:0", sessions: 1, quietMs: 900 }] },
    lastFailure: null,
  },
  // Hidden for a live share, on a profile that SYNCS -- which is what makes the
  // sync note appear. `manual` below is the same state on a bar that does not
  // sync, and previews the note correctly staying away.
  // Two frames in ONE tab, which the popup must collapse to "1 tab" -- the case
  // that catches a naive frames.length.
  shielded: {
    status: {
      hidden: true, state: "hidden", since: now - 4 * 60000, dirty: false,
      itemsDisplaced: 12, ownedVaults: 1, pendingAdoption: [], skippedBars: 0,
      // 6 == engine.js DECOYS.length, which is what a clean hide leaves on the
      // bar. This is the state the store screenshot renders, and the mock bar
      // beside it is drawn from this number -- see make-store-assets.mjs.
      bars: [bar(6, true)],
    },
    shares: {
      sharing: 2,
      frames: [
        { frame: "42:0", sessions: 1, quietMs: 400 },
        { frame: "42:3", sessions: 1, quietMs: 400 },
      ],
    },
    lastFailure: null,
  },
  // Hidden from the popup rather than by a share, long enough ago to exercise
  // the hours branch, and dirty so the reorder warning shows.
  manual: {
    status: {
      hidden: true, state: "hidden", since: now - 96 * 60000, dirty: true,
      itemsDisplaced: 12, ownedVaults: 1, pendingAdoption: [], skippedBars: 0,
      bars: [bar(0)],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: null,
  },
  // The other end of a hide: this machine is NOT sharing, its bar was emptied by
  // sync because another computer on the profile is. `local: false` is the whole
  // signal -- the vault's receipt names an id that means nothing here. Nothing
  // is wrong, so this must not read as an alarm, and the Restore button must not
  // read as the obvious thing to do.
  peer: {
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      ownedVaults: 0, skippedBars: 0,
      // `receipt: true` is load-bearing: a vault with no receipt is not
      // provably a peer's, and the popup correctly falls back to the vaguer
      // "not created by this installation" wording. Dropping it here would
      // preview a card the peer case never actually produces.
      pendingAdoption: [
        { id: "88", count: 12, hidAt: now - 6 * 60000, local: false, receipt: true },
      ],
      bars: [bar(6, true)],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: null,
  },
  busy: {
    status: {
      hidden: true, state: "hiding", since: now, dirty: false, itemsDisplaced: 12,
      ownedVaults: 1, pendingAdoption: [], skippedBars: 0, bars: [bar(9)],
    },
    shares: { sharing: 1, frames: [{ frame: "42:0", sessions: 1, quietMs: 200 }] },
    lastFailure: null,
  },
  // Both notices at once, plus a second (account) bar. `local: true` is our OWN
  // vault from a reinstall -- the fault case, which keeps the amber treatment
  // and the confident button. Contrast with `peer` above.
  alerts: {
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      ownedVaults: 0, skippedBars: 0,
      pendingAdoption: [
        { id: "77", count: 12, dateAdded: now - 86400000, local: true, receipt: true },
      ],
      bars: [bar(9), bar(4, true)],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: {
      at: now - 3600000, attempts: 5, restored: 7,
      stuck: ["a", "b"], missing: ["c"], decoysStuck: [],
    },
  },
};

const stub = (name) => `<script>
  const F = ${JSON.stringify(FIXTURES)}[${JSON.stringify(name)}] ?? {};
  window.chrome = {
    runtime: {
      sendMessage: (m) =>
        new Promise((r) => setTimeout(() => r(F[m.type] ?? { ok: true }), 30)),
      getURL: (p) => "chrome-extension://preview/" + p,
      // No update_url == not a Web Store install, which is what unlocks the
      // developer disclosure. This harness IS the developer case, and without
      // this the &dev=1 flag would open a section popup.js keeps hidden.
      // (No backticks in here: the whole stub is a template literal.)
      getManifest: () => ({}),
    },
    // The adoption card links out to the recovery page. Bound at load, so a
    // missing namespace would break the whole preview, not just that button.
    tabs: { create: async () => {} },
  };
</script>`;

/**
 * Headless Chrome renders prefers-color-scheme: dark and ignores the flags that
 * claim to change it, so light mode is previewed by deleting the dark override
 * block from the real stylesheet. The token values still come from the shipped
 * file -- this only decides which block wins.
 */
function stripDark(css) {
  for (;;) {
    const at = css.indexOf("@media (prefers-color-scheme: dark)");
    if (at === -1) return css;
    let i = css.indexOf("{", at);
    let depth = 0;
    do {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    } while (depth > 0 && i < css.length);
    css = css.slice(0, at) + css.slice(i);
  }
}

const TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/**
 * Serve one request out of the real extension/ directory, popup states included.
 * Exported so another tool can mount it as its fallback route.
 */
export async function previewRequest(req, res) {
  const url = new URL(req.url, "http://x");
  const light = url.searchParams.get("theme") === "light";
  try {
    if (url.pathname === "/" || url.pathname === "/popup.html") {
      let html = await readFile(join(DIR, "popup.html"), "utf8");
      html = html.replace("</head>", `${stub(url.searchParams.get("state") ?? "armed")}</head>`);
      if (url.searchParams.has("dev")) html = html.replace("<details class=", "<details open class=");
      if (light) html = html.replace('href="popup.css"', 'href="popup.css?theme=light"');
      res.writeHead(200, { "content-type": "text/html" }).end(html);
      return;
    }
    // The theme lives in tokens.css now, one @import below popup.css, so the
    // flag has to be carried across that hop or light mode silently renders
    // dark. Both files get stripped: popup.css still owns a couple of dark
    // overrides of its own.
    if (url.pathname === "/popup.css" && light) {
      const css = stripDark(await readFile(join(DIR, "popup.css"), "utf8"));
      res
        .writeHead(200, { "content-type": "text/css" })
        .end(css.replace('url("tokens.css")', 'url("tokens.css?theme=light")'));
      return;
    }
    if (url.pathname === "/tokens.css" && light) {
      res
        .writeHead(200, { "content-type": "text/css" })
        .end(stripDark(await readFile(join(DIR, "tokens.css"), "utf8")));
      return;
    }
    const body = await readFile(join(DIR, url.pathname.slice(1)));
    res.writeHead(200, { "content-type": TYPES[extname(url.pathname)] ?? "text/plain" }).end(body);
  } catch (err) {
    res.writeHead(404).end(String(err));
  }
}

// Only when run as `node tools/popup-preview.mjs`. Imported, this file must not
// grab the port -- make-store-assets.mjs runs its own server on its own port.
if (fileURLToPath(import.meta.url) === argv[1]) {
  createServer(previewRequest).listen(PORT, () => {
    console.log(`popup preview on http://localhost:${PORT}/?state=armed`);
    console.log(`states: ${Object.keys(FIXTURES).join(", ")}   flags: &dev=1 &theme=light`);
  });
}
