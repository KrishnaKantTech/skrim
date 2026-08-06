// M3 stage 1 — the automated half of the live test.
//
// Drives a REAL Chrome (its own profile, the extension loaded unpacked) over
// the DevTools protocol and exercises the real getDisplayMedia against the real
// chrome.bookmarks API. Everything the in-memory suite cannot answer:
//
//   * do the content scripts actually inject, at document_start, in MAIN world,
//     in sub-frames, on the installed Chrome?
//   * how long does a real hide take — the whole M2 timing bet?
//   * does a real round trip through hook -> bridge -> worker -> bookmarks
//     restore the bar EXACTLY?
//
// Screen capture is done with preferCurrentTab + --auto-accept-this-tab-capture
// rather than a desktop source. Two reasons: no macOS screen-recording TCC
// prompt, and no native picker dialog that would wedge an unattended run. The
// hook patches MediaDevices.prototype, so the constraints it is called with
// change nothing about the path under test. What this deliberately does NOT
// cover is the human question — whether the picker's preview thumbnails render
// after the bar is already down — which is why stage 2 is still by hand.
//
//   node tools/live-test.mjs            # run, then close Chrome
//   node tools/live-test.mjs --keep     # leave Chrome open for stage 2
//   node tools/live-test.mjs --headful-only=A,B

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8787;
const CDP_PORT = 9333;
const BAR_ID = "1";
const OTHER_ID = "2";
// The title the engine writes today, and every title it has ever written. The
// sweep has to know both or a run started against a profile left over from
// before the rename silently inherits its vault; the assertion only cares about
// the current one, because that is what this build creates.
const VAULT_TITLE =
  "Skrim — hidden while screen sharing (drag these back to your bookmarks bar)";
const VAULT_TITLES = [
  VAULT_TITLE,
  "SecureShare — hidden while screen sharing (drag these back to your bookmarks bar)",
];

const KEEP = process.argv.includes("--keep");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- scoreboard -----------------------------------------------------------

const results = [];
let failures = 0;

function ok(id, what, detail = "") {
  results.push({ id, what, pass: true, detail });
  console.log(`  ✓ ${id} ${what}${detail ? " — " + detail : ""}`);
}
function bad(id, what, detail = "") {
  failures++;
  results.push({ id, what, pass: false, detail });
  console.log(`  ✗ ${id} ${what}${detail ? " — " + detail : ""}`);
}
function check(id, cond, what, detail = "") {
  (cond ? ok : bad)(id, what, detail);
  return !!cond;
}

// --- static server --------------------------------------------------------

const FRAME_HTML = `<!doctype html><meta charset="utf-8"><title>child frame</title>
<body style="font:12px system-ui;margin:8px">child frame
<script>window.__ssFrame = { hooked: MediaDevices.prototype[Symbol.for("secureshare.hooked")] === true };<\/script>`;

function startServer() {
  const page = readFileSync(join(HERE, "live-page.html"));
  const server = createServer((req, res) => {
    if (req.url.startsWith("/frame.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(FRAME_HTML);
    } else if (req.url.startsWith("/favicon.ico")) {
      res.writeHead(204).end();
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    }
  });
  return new Promise((res) => server.listen(PORT, "127.0.0.1", () => res(server)));
}

// --- minimal CDP client ---------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return; // an event; this harness polls instead of subscribing
      this.pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
      else p.res(msg.result);
    };
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("cdp websocket failed"));
    });
    return new CDP(ws);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      // A target that dies mid-call never answers; fail loudly instead of hanging.
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${method}: timed out`));
      }, 40_000);
    });
  }

  close() {
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, opts = {}) {
  const r = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: opts.awaitPromise !== false,
      returnByValue: true,
      userGesture: !!opts.userGesture,
    },
    sessionId,
  );
  if (r.exceptionDetails) {
    const e = r.exceptionDetails;
    throw new Error("eval: " + (e.exception?.description ?? e.text));
  }
  return r.result.value;
}

async function findTarget(cdp, pred, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find(pred);
    if (t) return t;
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

async function waitUntil(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

async function openTab(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const sessionId = await attach(cdp, targetId);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = await evaluate(cdp, sessionId, "document.readyState").catch(() => null);
    if (state === "complete") break;
    if (Date.now() > deadline) throw new Error(`tab ${url} never finished loading`);
    await sleep(100);
  }
  return { targetId, sessionId };
}

// --- bookmark helpers, evaluated inside the service worker ----------------

// Compared by shape, never by id: a restore that had to fall back to recreating
// a node produces new ids, and that is still a correct restore.
const SHAPE_FN = `
  const shape = (n) => ({
    title: n.title, url: n.url ?? null,
    children: (n.children ?? []).map(shape),
  });
  const barShape = async () => shape((await chrome.bookmarks.getSubTree("${BAR_ID}"))[0]).children;
`;

const swEval = (cdp, sw, body, opts) => evaluate(cdp, sw, `(async () => { ${SHAPE_FN}\n${body} })()`, opts);

// Deliberately the size of a bar someone actually has. Hide latency is the one
// number this whole milestone exists to produce, and it is a per-item
// chrome.bookmarks.move round trip -- measuring it against four bookmarks would
// answer an easier question than the one being asked.
const link = (n) => ({ title: `SS-Test ${n}`, url: `https://example.com/${n}` });
const SEED = [
  ...Array.from({ length: 8 }, (_, i) => link(`link-${i}`)),
  {
    title: "SS-Test work",
    children: [
      ...Array.from({ length: 6 }, (_, i) => link(`work-${i}`)),
      { title: "SS-Test work/nested", children: Array.from({ length: 4 }, (_, i) => link(`deep-${i}`)) },
    ],
  },
  ...Array.from({ length: 7 }, (_, i) => link(`link-${i + 8}`)),
  { title: "SS-Test reading", children: Array.from({ length: 5 }, (_, i) => link(`read-${i}`)) },
  ...Array.from({ length: 5 }, (_, i) => link(`link-${i + 15}`)),
  { title: "SS-Test empty folder", children: [] },
];
const SEED_NODES = 8 + 1 + 6 + 1 + 4 + 7 + 1 + 5 + 5 + 1;

async function resetAndSeed(cdp, sw) {
  return swEval(
    cdp,
    sw,
    `
    // Anything the extension still believes is in flight, first.
    await chrome.storage.session.clear();
    await chrome.storage.local.clear();

    const bar = (await chrome.bookmarks.getChildren("${BAR_ID}"));
    for (const k of bar) await chrome.bookmarks.removeTree(k.id);

    // Vault folders stranded by an earlier run, plus their contents.
    for (const title of ${JSON.stringify(VAULT_TITLES)}) {
      const strays = await chrome.bookmarks.search({ title });
      for (const s of strays) await chrome.bookmarks.removeTree(s.id);
    }

    const make = async (parentId, spec) => {
      const node = await chrome.bookmarks.create({
        parentId, title: spec.title, ...(spec.url ? { url: spec.url } : {}),
      });
      for (const c of spec.children ?? []) await make(node.id, c);
      return node;
    };
    for (const spec of ${JSON.stringify(SEED)}) await make("${BAR_ID}", spec);

    const roots = (await chrome.bookmarks.getTree())[0].children;
    return { baseline: await barShape(), roots: roots.map(r => ({ id: r.id, title: r.title, folderType: r.folderType })) };
  `,
  );
}

/**
 * Armed BEFORE the share call and awaited after it, so the returned timestamp
 * is the real moment the bar stopped showing the user's bookmarks — not the
 * moment a poll from this process happened to notice.
 */
function armHideWatcher(cdp, sw, timeoutMs = 20_000) {
  return swEval(
    cdp,
    sw,
    `
    const deadline = Date.now() + ${timeoutMs};
    let firstEmpty = null;
    while (Date.now() < deadline) {
      const kids = await chrome.bookmarks.getChildren("${BAR_ID}");
      const mine = kids.filter(k => k.title.startsWith("SS-Test"));
      if (mine.length === 0) {
        if (firstEmpty === null) firstEmpty = Date.now();
        // Decoys land right after; report when the bar looks plausible again.
        if (kids.length > 0) return { cleared: firstEmpty, decoyed: Date.now(), decoys: kids.length };
      }
      await new Promise(r => setTimeout(r, 2));
    }
    return firstEmpty === null ? null : { cleared: firstEmpty, decoyed: null, decoys: 0 };
  `,
  );
}

function waitRestored(cdp, sw, baseline, timeoutMs = 30_000) {
  return swEval(
    cdp,
    sw,
    `
    const want = JSON.stringify(${JSON.stringify(baseline)});
    const deadline = Date.now() + ${timeoutMs};
    let last = null;
    while (Date.now() < deadline) {
      last = await barShape();
      if (JSON.stringify(last) === want) return { restored: true, at: Date.now(), shape: last };
      await new Promise(r => setTimeout(r, 20));
    }
    return { restored: false, shape: last };
  `,
  );
}

const barState = (cdp, sw) =>
  swEval(
    cdp,
    sw,
    `
    const bar = await barShape();
    const other = (await chrome.bookmarks.getSubTree("${OTHER_ID}"))[0].children ?? [];
    const vault = other.find(n => n.title === ${JSON.stringify(VAULT_TITLE)});
    const local = await chrome.storage.local.get(null);
    const j = local["secureshare.journal"] ?? null;
    const frames = (await chrome.storage.session.get("secureshare.shares"))["secureshare.shares"]?.frames ?? {};
    return {
      bar,
      mine: bar.filter(n => n.title.startsWith("SS-Test")).length,
      vaultCount: vault
        ? (await chrome.bookmarks.getChildren(vault.id)).filter(n => !(n.url ?? "").includes("ssr1.")).length
        : -1,
      // The recovery receipt: the record that outlives an uninstall. A mock
      // cannot settle whether real Chrome will even accept a bookmark with a
      // chrome-extension:// URL, and everything downstream of the receipt is
      // worthless if it silently refuses.
      receiptUrl: vault
        ? ((await chrome.bookmarks.getChildren(vault.id)).find(n => (n.url ?? "").includes("ssr1."))?.url ?? null)
        : null,
      state: j?.state ?? null,
      journalKeys: Object.keys(local),
      frames: Object.keys(frames).length,
      sids: Object.values(frames).reduce((n, f) => n + (f.sids?.length ?? 0), 0),
    };
  `,
  );

// --- Chrome lifecycle -----------------------------------------------------

/**
 * A disposable profile, rebuilt every run.
 *
 * `--load-extension` no longer loads anything on current Chrome, and
 * `--disable-extensions-except` disables even the extension it names, so the
 * extension is installed over CDP (`Extensions.loadUnpacked`, which needs
 * --enable-unsafe-extension-debugging) into a profile that has no other
 * extensions to install it beside. That matters more than it sounds: a screen
 * recorder like Loom patches getDisplayMedia too, and would quietly invalidate
 * every assertion in section A.
 *
 * Unpacked extensions still require developer mode, and there is no switch for
 * it -- hence the pre-seeded Preferences file. Chrome fills in the rest.
 */
async function makeProfile(profile) {
  try {
    // A Chrome still holding the SingletonLock makes a second launch hand its
    // arguments to the FIRST process and exit -- silently, with no port open.
    // The leading dashes are stripped: pkill reads a "-" pattern as a flag.
    execFileSync("/usr/bin/pkill", ["-f", `user-data-dir=${profile}`]);
    await sleep(1500);
  } catch { /* nothing was running */ }
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "Preferences"),
    JSON.stringify({
      extensions: { ui: { developer_mode: true } },
      // Off by default on a new profile, and only ever shown on the New Tab
      // page. Without this the human half of the test has nothing to look at.
      bookmark_bar: { show_on_all_tabs: true },
    }),
  );
}

function launchChrome(profile) {
  return spawn(
    CHROME,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${CDP_PORT}`,
      "--enable-unsafe-extension-debugging",
      "--auto-accept-this-tab-capture",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1100,850",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );
}

async function browserWs() {
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("Chrome never opened its debugging port");
    await sleep(200);
  }
}

// --- the run --------------------------------------------------------------

async function main() {
  // Deliberately NOT .test-chrome: that one is the human's, for stage 2, and
  // this function deletes whatever profile it is given.
  const profile = join(ROOT, ".test-chrome-auto");
  const server = await startServer();
  await makeProfile(profile);
  const chrome = launchChrome(profile);
  const cdp = await CDP.connect(await browserWs());

  let popup = null;
  let extId = null; // read again in the finally block, for --keep

  /**
   * A target exists a moment before its `chrome` namespace is fully populated,
   * and evaluating into that gap fails with an undefined `chrome.storage`.
   * Intermittent by nature, so it is waited out rather than retried at the
   * call site.
   */
  const attachToWorker = async (targetId) => {
    const sessionId = await attach(cdp, targetId);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const ready = await evaluate(
        cdp,
        sessionId,
        "!!(globalThis.chrome && chrome.storage && chrome.storage.session && chrome.bookmarks)",
      ).catch(() => false);
      if (ready) return sessionId;
      if (Date.now() > deadline) throw new Error("worker never exposed the chrome.* APIs");
      await sleep(100);
    }
  };

  /**
   * Self-capture is refused on a tab that is not the active one
   * ("InvalidStateError: Invalid state"), so every share is preceded by
   * raising its tab -- an ordering artefact of the harness, not of the hook.
   */
  /**
   * `surface` defaults to "monitor" because this harness can only produce TAB
   * captures -- --auto-accept-this-tab-capture bypasses the picker -- and the
   * hook releases those the moment they resolve. Every scenario that exists to
   * watch the bar STAY down therefore has to claim a surface that can show it.
   * Pass null to use whatever Chrome really reports; G1 does exactly that.
   */
  const startShare = async (tab, opts = {}, surface = "monitor") => {
    await cdp.send("Target.activateTarget", { targetId: tab.targetId });
    await sleep(150);
    await evaluate(cdp, tab.sessionId, `window.__ss.surface(${JSON.stringify(surface)})`);
    return evaluate(
      cdp,
      tab.sessionId,
      `window.__ss.share(${JSON.stringify({ preferCurrentTab: true, ...opts })})`,
      { userGesture: true },
    );
  };

  const msg = (m) =>
    evaluate(
      cdp,
      popup.sessionId,
      `chrome.runtime.sendMessage(${JSON.stringify(m)})`,
    );

  try {
    const loaded = await cdp.send("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
    extId = loaded.id;
    if (!check("L1", !!extId, "extension installed unpacked", String(extId))) throw new Error("not loaded");

    // The worker is dormant until something needs it; the popup's own status
    // call is the wake-up, and doubles as the harness's control channel.
    popup = await openTab(cdp, `chrome-extension://${extId}/popup.html`);
    ok("L2", "popup page reachable as the control channel");

    // The developer disclosure is gated on "this copy did not come from the Web
    // Store", read as the absence of `update_url` from the manifest Chrome hands
    // back. The mock cannot settle whether Chrome really omits it for an
    // unpacked load, and getting that wrong costs the manual stage-2 walk its
    // Hide / Force restore buttons. The STORE half of the same premise -- that
    // Chrome injects `update_url` for an installed copy -- is not reachable from
    // here at all, and stays reasoned about rather than proven.
    //
    // `readyState` is not enough of a wait here: a freshly created target
    // reports "complete" for the empty document it starts on, so the elements
    // can exist with their markup defaults before popup.js has run a line.
    // `#primary`'s handler is bound unconditionally in the module body, ahead of
    // the gate, so it says "the script ran" without saying anything about the
    // answer this is checking.
    for (let i = 0; i < 100; i++) {
      const ran = await evaluate(cdp, popup.sessionId,
        `typeof document.getElementById("primary")?.onclick === "function"`).catch(() => false);
      if (ran) break;
      await sleep(100);
    }
    const dev = await evaluate(cdp, popup.sessionId, `JSON.stringify({
      updateUrl: "update_url" in chrome.runtime.getManifest(),
      shown: document.getElementById("dev").hidden === false,
      wired: typeof document.getElementById("forceRestore").onclick === "function",
    })`);
    const d = JSON.parse(dev);
    check("L2b", d.updateUrl === false && d.shown && d.wired,
      "an unpacked copy reports no update_url and keeps its developer controls",
      dev);

    const isSw = (t) => t.type === "service_worker" && t.url.includes(extId);
    let swTarget = await findTarget(cdp, isSw, 20_000);
    if (!check("L3", swTarget, "extension service worker is running")) throw new Error("no worker");
    let sw = await attachToWorker(swTarget.targetId);

    // --- setup ---
    const { baseline, roots } = await resetAndSeed(cdp, sw);
    check(
      "L4",
      roots.some((r) => r.folderType === "bookmarks-bar" || r.id === BAR_ID),
      "bookmarks bar root detected",
      roots.map((r) => r.folderType ?? r.id).join(", "),
    );
    check("L5", baseline.length === SEED.length, "bar seeded",
      `${baseline.length} top-level, ${SEED_NODES} nodes`);

    // --- A: injection ---
    const page = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const probe = await evaluate(cdp, page.sessionId, "window.__ss.hookProbe()");
    check("A1", probe.secureContext, "127.0.0.1 is a secure context");
    check("A2", probe.hooked === true, "MAIN-world hook installed on MediaDevices.prototype");
    check("A3", probe.typeofFn === "function", "getDisplayMedia is still callable");
    check(
      "A4",
      probe.toString.includes("[native code]"),
      "patched method still stringifies as native",
      probe.toString.replace(/\s+/g, " ").slice(0, 60),
    );
    check("A5", probe.name === "getDisplayMedia" && probe.length === 0, "name/length forwarded");
    check("A6", probe.onInstance === false, "prototype patched, not the instance");
    check("A7", probe.hookedInFrame === true, "hook reaches sub-frames (all_frames)", String(probe.hookedInFrame));

    // --- B: the timing bet ---
    const hidePromise = armHideWatcher(cdp, sw);
    const shared = await startShare(page);
    if (shared.timedOut) throw new Error("getDisplayMedia never settled — a picker is probably open");
    check("B1", shared.ok === true, "real getDisplayMedia resolved", shared.error ?? shared.readyState?.join());

    const hide = await hidePromise;
    if (!check("B2", hide && hide.cleared, "bar emptied on a real share")) {
      throw new Error("the bar never cleared; nothing downstream is meaningful");
    }
    const latency = hide.cleared - shared.t0;
    check("B3", latency < 500, "hide latency under 500ms", `${latency}ms from the call`);
    check(
      "B4",
      hide.decoyed !== null,
      "a decoy appears immediately, so the bar is never conspicuously empty",
      hide.decoyed ? `first at +${hide.decoyed - hide.cleared}ms` : "none",
    );

    // The hook now holds the call until the bar is down, so this is the price
    // of the guarantee, in a real browser: what the user waits through between
    // clicking Share and Chrome getting on with it. It also proves the deferral
    // does not consume the transient user activation getDisplayMedia requires --
    // if it did, every share in this file would have failed instead.
    check("B3b", shared.t1 - shared.t0 < 600, "deferring the picker costs the user little",
      `${shared.t1 - shared.t0}ms from click to stream`);

    const hidden = await waitUntil(async () => (await barState(cdp, sw)).state === "hidden", 10_000)
      .then(() => barState(cdp, sw));
    check("B4b", hidden.bar.length === 6, "all six decoys planted", `${hidden.bar.length} on the bar`);
    check("B5", hidden.mine === 0, "no seeded bookmark left on the bar", `${hidden.mine} remaining`);
    check("B6", hidden.vaultCount === SEED.length, "everything is in the vault", `${hidden.vaultCount} items`);
    check("B6b", typeof hidden.receiptUrl === "string" && hidden.receiptUrl.includes("ssr1."),
      "real Chrome accepted the recovery receipt bookmark", String(hidden.receiptUrl).slice(0, 60));
    check("B7", hidden.state === "hidden", "journal reached HIDDEN", String(hidden.state));

    const shares = await msg({ type: "shares" });
    check("B8", shares?.sharing >= 1, "worker is counting the live share",
      `sharing=${shares?.sharing} frames=${shares?.frames?.length}`);

    // --- C: the page ends its own share (track.stop(), fires no `ended`) ---
    await evaluate(cdp, page.sessionId, "window.__ss.stop()");
    const restored = await waitRestored(cdp, sw, baseline);
    check("C1", restored.restored, "bar restored exactly — order, folders, urls");
    if (!restored.restored) {
      console.log("    got:  " + JSON.stringify(restored.shape));
      console.log("    want: " + JSON.stringify(baseline));
    }
    const after = await barState(cdp, sw);
    check("C2", after.vaultCount === -1 || after.vaultCount === 0, "vault folder cleaned up", `${after.vaultCount}`);
    check("C2b", after.receiptUrl === null, "and took its receipt with it", String(after.receiptUrl));
    check("C3", after.state !== "hidden", "journal left HIDDEN", String(after.state));

    // --- D: a share that never happens must release the session ---
    //
    // Stands in for the cancelled picker, which cannot be automated: with
    // --auto-accept-this-tab-capture Chrome accepts every request, so the
    // rejection has to come from the request itself. `video: false` is rejected
    // by the spec before any picker would be shown, on exactly the promise path
    // a cancelled picker rejects on -- the hook cannot tell the two apart.
    const rejectTab = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const hide2 = armHideWatcher(cdp, sw, 8_000);
    const rejected = await evaluate(cdp, rejectTab.sessionId, "window.__ss.share({ video: false }, 6000)", {
      userGesture: true,
    });
    check("D1", rejected.ok === false && !rejected.timedOut, "getDisplayMedia rejected", rejected.error ?? "timed out");
    const h2 = await hide2;
    check("D2", !!(h2 && h2.cleared), "bar still hid on the CALL, before the rejection");
    const back = await waitRestored(cdp, sw, baseline, 20_000);
    check("D3", back.restored, "reject path restored the bar by itself");

    // Invoking off the prototype is the documented reason the hook patches
    // MediaDevices.prototype instead of navigator.mediaDevices. It still goes
    // through the Proxy, and Web IDL turns the bad receiver into a REJECTION,
    // never a synchronous throw -- so the hook's sync-throw branch is dead code
    // against a spec-compliant Chrome, and only earns its place against an
    // `original` some other extension has already replaced.
    const proto = await evaluate(cdp, rejectTab.sessionId, "window.__ss.callViaPrototype()", {
      userGesture: true,
    });
    check("D4", proto.threw === false && proto.rejected === true,
      "prototype-level call rejects rather than throwing", proto.error ?? "(it resolved)");
    const back2 = await waitRestored(cdp, sw, baseline, 20_000);
    check("D5", back2.restored, "that path released the session too");
    await cdp.send("Target.closeTarget", { targetId: rejectTab.targetId });

    // --- H: two shares at once. The bar comes back for the LAST one, not the
    // first -- a second meeting in another tab is the normal case, and getting
    // this wrong exposes the bar while one of them is still live. ---
    const hTab1 = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const hideH = armHideWatcher(cdp, sw);
    const h1 = await startShare(hTab1);
    check("H1", h1.ok === true, "first share started", h1.error ?? "");
    check("H2", !!(await hideH)?.cleared, "bar hidden");
    const hTab2 = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const h2s = await startShare(hTab2);
    check("H3", h2s.ok === true, "second, overlapping share started", h2s.error ?? "");
    check("H4", (await msg({ type: "shares" }))?.sharing === 2, "worker counts both");

    await evaluate(cdp, hTab1.sessionId, "window.__ss.stop()");
    await sleep(2500);
    const midway = await barState(cdp, sw);
    check("H5", midway.mine === 0, "bar stays hidden while the second share is live",
      `${midway.mine} seeded items visible`);

    await evaluate(cdp, hTab2.sessionId, "window.__ss.stop()");
    const bothDone = await waitRestored(cdp, sw, baseline, 20_000);
    check("H6", bothDone.restored, "bar restored once the last share ended");
    await cdp.send("Target.closeTarget", { targetId: hTab1.targetId });
    await cdp.send("Target.closeTarget", { targetId: hTab2.targetId });

    // --- E: closing the sharing tab ---
    const tabB = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const hide3 = armHideWatcher(cdp, sw);
    const sharedB = await startShare(tabB);
    check("E1", sharedB.ok === true, "second share started", sharedB.error ?? "");
    check("E2", !!(await hide3)?.cleared, "bar hidden again for the new share");
    await cdp.send("Target.closeTarget", { targetId: tabB.targetId });
    const afterClose = await waitRestored(cdp, sw, baseline, 20_000);
    check("E3", afterClose.restored, "closing the sharing tab restored the bar (tabs.onRemoved)");

    // --- F: worker terminated mid-share; the beat has to re-teach it ---
    const tabC = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const hide4 = armHideWatcher(cdp, sw);
    const sharedC = await startShare(tabC);
    check("F1", sharedC.ok === true, "third share started", sharedC.error ?? "");
    check("F2", !!(await hide4)?.cleared, "bar hidden");

    await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
    ok("F3", "service worker terminated mid-share");
    await sleep(1000);
    swTarget = await findTarget(cdp, isSw, 25_000); // the 10s beat wakes it
    if (check("F4", swTarget, "worker came back (woken by the beat)")) {
      sw = await attachToWorker(swTarget.targetId);
      // Give the beat one more interval to re-register the forgotten session.
      await sleep(12_000);
      const live = await barState(cdp, sw);
      check("F5", live.mine === 0, "bar stayed hidden across the worker's death");
      check("F6", live.frames >= 1 && live.sids >= 1, "session re-registered from the beat",
        `${live.frames} frame(s), ${live.sids} sid(s)`);

      await evaluate(cdp, tabC.sessionId, "window.__ss.stop()");
      const finalRestore = await waitRestored(cdp, sw, baseline, 30_000);
      check("F7", finalRestore.restored, "restore still works after the worker was replaced");
    }
    await cdp.send("Target.closeTarget", { targetId: tabC.targetId }).catch(() => {});

    // --- TS: the surface-aware release, against real Chrome ---
    //
    // The premise the whole thing rests on is a fact about Chrome, not about
    // our code: a captured tab reports displaySurface "browser", and a tab
    // capture cannot contain the bookmarks bar. TS3 reads that off a REAL track
    // with nothing patched -- if Chrome ever stops saying it, or says something
    // new, this is the check that notices rather than the feature silently
    // reverting to hiding for the whole meeting.
    //
    // It matters beyond this machine: the hide is a bookmark mutation and those
    // sync, so a bar held down for an hour here is a bar held down for an hour
    // on every other signed-in device (M0-FINDINGS §6).
    const tabG = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const hide5 = armHideWatcher(cdp, sw);
    const sharedG = await startShare(tabG, {}, null); // null: no lie, real Chrome
    check("TS1", sharedG.ok === true, "tab share started", sharedG.error ?? "");
    check("TS2", !!(await hide5)?.cleared,
      "the bar STILL goes down first — nothing knows what was picked yet");

    const real = await evaluate(cdp, tabG.sessionId, "window.__ss.settings()");
    check("TS3", Array.isArray(real) && real.every((s) => s === "browser"),
      "real Chrome reports a captured tab as displaySurface 'browser'",
      JSON.stringify(real));

    const backG = await waitRestored(cdp, sw, baseline, 20_000);
    check("TS4", backG.restored,
      "and the bar comes back on its own, mid-share, exactly as it was");

    const stillLive = await evaluate(cdp, tabG.sessionId, "window.__ss.readyState()");
    check("TS5", Array.isArray(stillLive) && stillLive.includes("live"),
      "while the share is genuinely still running", JSON.stringify(stillLive));

    const released = await barState(cdp, sw);
    check("TS6", released.sids === 0,
      "and the worker has stopped counting it, so nothing re-hides",
      `${released.frames} frame(s), ${released.sids} sid(s)`);

    await evaluate(cdp, tabG.sessionId, "window.__ss.stop()").catch(() => {});
    await cdp.send("Target.closeTarget", { targetId: tabG.targetId }).catch(() => {});

    // --- CS: the FIRST share of a browser session, with a cold worker ---
    //
    // Every number above was measured against a worker this harness had already
    // woken and was holding open with a debugger. That is the easy case and not
    // the common one: MV3 shuts the worker down after ~30s idle, so the first
    // share of a meeting almost always pays a cold start. Nothing here may
    // touch the worker, so the timings are reconstructed afterwards from
    // timestamps Chrome itself recorded -- the journal's, and the decoys'
    // dateAdded, which is stamped when the hide is finishing.
    // The worker is stopped outright rather than waited out. Left alone it does
    // not reliably go away inside a minute -- the 1-minute watchdog alarm keeps
    // reviving it -- and from the extension's side the two are the same event:
    // no worker, so the incoming message has to start one.
    const coldPage = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
    const workerGone = await waitUntil(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return !targetInfos.some(isSw);
    }, 15_000);
    check("CS1", workerGone, "worker is stopped, so the next share pays a cold start");

    const coldShare = await startShare(coldPage);
    check("CS2", coldShare.ok === true, "first share of the session started", coldShare.error ?? "");
    swTarget = await findTarget(cdp, isSw, 20_000);
    sw = await attachToWorker(swTarget.targetId);
    const cold = await swEval(
      cdp,
      sw,
      `
      const j = (await chrome.storage.local.get("secureshare.journal"))["secureshare.journal"];
      const kids = await chrome.bookmarks.getChildren("${BAR_ID}");
      const decoys = kids.filter(k => !k.title.startsWith("SS-Test"));
      return {
        startedAt: j?.startedAt ?? null,
        state: j?.state ?? null,
        mine: kids.length - decoys.length,
        firstDecoy: decoys.length ? Math.min(...decoys.map(d => d.dateAdded)) : null,
      };
    `,
    );
    check("CS3", cold.mine === 0, "cold worker still hid the bar", `${cold.mine} seeded items left`);
    if (cold.startedAt && cold.firstDecoy) {
      const wake = cold.startedAt - coldShare.t0;
      const total = cold.firstDecoy - coldShare.t0;
      ok("CS4", "cold-start timings", `worker reached hide() at +${wake}ms, decoys at +${total}ms`);
      // This is the number the picker races. Warm it is ~35ms.
      check("CS5", total < 150, "cold hide still beats a picker", `+${total}ms from the call`);
    } else {
      bad("CS4", "cold-start timings unreadable", JSON.stringify(cold));
    }
    await evaluate(cdp, coldPage.sessionId, "window.__ss.stop()");
    await waitRestored(cdp, sw, baseline, 20_000);
    await cdp.send("Target.closeTarget", { targetId: coldPage.targetId }).catch(() => {});

    // --- X: recorders living in ANOTHER extension (Loom) ------------------
    //
    // The mock suite covers what happens once a recorder tab is seen. It cannot
    // settle whether we can see one at all, and that premise is the entire
    // feature: Chrome must report a DIFFERENT extension's chrome-extension://
    // tab URL to us on the strength of the "tabs" permission alone. There is no
    // host permission for that scheme, so if Chrome gated it on host
    // permissions we would get nothing back and the feature would be dead.
    //
    // Proven against a real second extension, not against our own pages —
    // "Chrome tells you about your own tabs" would be a different, useless
    // fact. A throwaway unpacked extension stands in for Loom; only its URL
    // matters, and the shipped matcher is checked separately against a real
    // Loom-shaped one.
    const standIn = join(tmpdir(), "secureshare-standin-recorder");
    mkdirSync(standIn, { recursive: true });
    writeFileSync(
      join(standIn, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "SecureShare stand-in recorder",
        version: "1.0",
        // No permissions at all: this exists only to own a tab URL.
      }),
    );
    writeFileSync(
      join(standIn, "html.html"),
      "<!doctype html><meta charset=utf-8><title>stand-in</title>capture page",
    );

    const other = await cdp.send("Extensions.loadUnpacked", { path: standIn });
    const otherId = other?.id;
    if (check("X-L1", !!otherId && otherId !== extId, "a second, unrelated extension is installed",
      String(otherId))) {
      // Record what onCreated actually delivers. tabs.create navigates after the
      // event fires, so the destination arrives in pendingUrl and `url` is empty
      // — the reason recorderForTab reads both. If Chrome ever changes which
      // field carries it, this is what says so.
      await swEval(cdp, sw, `
        globalThis.__seen = [];
        chrome.tabs.onCreated.addListener((t) => globalThis.__seen.push({
          url: t.url ?? null, pendingUrl: t.pendingUrl ?? null,
        }));
        return true;
      `);

      const otherUrl = `chrome-extension://${otherId}/html.html`;
      const otherTab = await openTab(cdp, otherUrl);

      // Both fields, deliberately. A query can catch a tab mid-commit, where
      // `url` is the empty STRING and the destination is still in pendingUrl --
      // and an empty string is not nullish, so `t.url ?? t.pendingUrl` silently
      // yields "". This run is where that surfaced, as a flake. recorderForTab
      // is immune because recorderFor("") answers null and the ?? falls
      // through; the harness has to be written to the same standard or it
      // reports a failure the product does not have.
      const seenByQuery = await swEval(cdp, sw, `
        const tabs = await chrome.tabs.query({});
        return tabs.flatMap((t) => [t.url, t.pendingUrl]).filter(
          (u) => typeof u === "string" && u.includes("${otherId}"),
        );
      `);
      check("X-L2", seenByQuery.length >= 1 && seenByQuery.every((u) => u === otherUrl),
        "chrome.tabs.query reports ANOTHER extension's page url",
        JSON.stringify(seenByQuery));

      const onCreated = await swEval(cdp, sw, `
        return (globalThis.__seen ?? []).filter(
          (t) => (t.url ?? "").includes("${otherId}") || (t.pendingUrl ?? "").includes("${otherId}"),
        );
      `);
      check("X-L3", onCreated.length === 1,
        "chrome.tabs.onCreated fires for it, so a recording is caught as it starts",
        JSON.stringify(onCreated));
      check("X-L4", onCreated[0]?.pendingUrl === otherUrl && !onCreated[0]?.url,
        "and carries the destination in pendingUrl, not url — which is why both are read",
        JSON.stringify(onCreated[0] ?? null));

      // The shipped matcher, against the URL Loom's own extension actually
      // uses. Asserted here rather than only in the mock so a bad regex or a
      // broken import surfaces in the BUILT extension.
      //
      // Run in the popup, not the worker: dynamic import() is disallowed in a
      // ServiceWorkerGlobalScope by spec. The popup is an ordinary extension
      // document loading the same file the worker's static import resolves to.
      const matched = await evaluate(cdp, popup.sessionId, `(async () => {
        const r = await import(chrome.runtime.getURL("src/recorders.js"));
        return {
          loom: r.recorderFor("chrome-extension://liecbddmkiiihnedobmlmillhodjkdmb/html/pinnedTab.html")?.name ?? null,
          standIn: r.recorderFor("${otherUrl}")?.name ?? null,
          fromTab: r.recorderForTab({ pendingUrl: "chrome-extension://liecbddmkiiihnedobmlmillhodjkdmb/html/pinnedTab.html" })?.name ?? null,
        };
      })()`);
      check("X-L5", matched.loom === "Loom" && matched.fromTab === "Loom",
        "the shipped matcher recognises Loom's real capture page",
        JSON.stringify(matched));
      check("X-L6", matched.standIn === null,
        "and an unrelated extension's page is not a capture page",
        JSON.stringify(matched.standIn));

      await cdp.send("Target.closeTarget", { targetId: otherTab.targetId }).catch(() => {});
    }
    rmSync(standIn, { recursive: true, force: true });

    // --- G: leave the profile clean ---
    const end = await barState(cdp, sw);
    check("G1", end.mine === SEED.length, "profile left with the bar intact", `${end.mine} items`);
  } catch (err) {
    bad("XX", "run aborted", String(err.message ?? err));
  } finally {
    console.log("\n==================================================================");
    console.log(`  live checks passed : ${results.filter((r) => r.pass).length}`);
    console.log(`  live checks failed : ${failures}`);
    console.log("==================================================================");
    if (KEEP) {
      // The automated run needs --auto-accept-this-tab-capture, and that flag
      // accepts EVERY request, picker included -- so a browser left over from
      // stage 1 can never show the one dialog stage 2 exists to look at.
      // Restart on the same profile without it. The extension is registered in
      // the profile, so it survives; re-installed only if it somehow did not.
      cdp.close();
      chrome.kill();
      await sleep(1500);
      const kept = spawn(
        CHROME,
        [
          `--user-data-dir=${profile}`,
          `--remote-debugging-port=${CDP_PORT}`,
          "--enable-unsafe-extension-debugging",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-sync",
          "--window-size=1100,850",
          `http://127.0.0.1:${PORT}/`,
        ],
        { stdio: "ignore" },
      );
      kept.unref();
      const cdp2 = await CDP.connect(await browserWs());
      if (!(await findTarget(cdp2, (t) => t.url.includes("chrome-extension://"), 8_000))) {
        await cdp2.send("Extensions.loadUnpacked", { path: join(ROOT, "extension") });
      }
      const state = await evaluate(
        cdp2,
        await attach(cdp2, (await openTab(cdp2, `chrome-extension://${extId}/popup.html`)).targetId),
        "1",
      ).catch(() => null);
      cdp2.close();

      console.log("\n--- STAGE 2: over to you ------------------------------------------");
      console.log("Chrome is open on the throwaway profile, bookmarks bar seeded,");
      console.log(`extension ${state === null ? "NOT confirmed - check chrome://extensions" : "loaded"}.`);
      console.log("Do NOT sign this profile in.\n");
      console.log("1. On the page that opened, click 'Share screen'.");
      console.log("   Chrome's real picker appears. BEFORE choosing anything, look at");
      console.log("   the preview thumbnails: is the bookmarks bar already gone in them?");
      console.log("2. Press Escape to cancel. The bar must come back, exactly as it was.");
      console.log("3. Click 'Share screen' again, pick a window, click Share.");
      console.log("4. End it with Chrome's own 'Stop sharing' button (not the page's).");
      console.log("   The bar must come back within a second or two.");
      console.log("5. Optional: the same four steps on Meet / Zoom Web / Slack.\n");
      console.log("Leave this terminal running -- it serves the page. Ctrl-C when done.");
      return; // the listening server keeps node alive
    }
    cdp.close();
    chrome.kill();
    server.close();
    await sleep(300);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
