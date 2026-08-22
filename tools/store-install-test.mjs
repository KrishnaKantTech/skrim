// The clean-profile walk: what a WEB STORE user gets, not what a developer does.
//
//   node tools/store-install-test.mjs [--keep]
//
// live-test.mjs proves the mechanism against a real Chrome. This proves the
// SHIPPED shape of it. `extension/` is copied and `update_url` -- the key Chrome
// injects for a store install, and the only thing the developer disclosure is
// gated on -- is written into the manifest, so every gate that reads it takes
// the branch a real user takes. A fresh profile is built from nothing each run,
// because the questions here are all first-run questions.
//
// It asks the things a packaged copy can get wrong and an unpacked one cannot:
// is the developer panel really unreachable, does the popup fit the window
// Chrome will actually give it, does a receipt bookmark open when clicked, does
// anything of ours reach a page's console, and -- the case this file was written
// for -- does an uninstall-while-hidden followed by a reinstall give the user
// their bar back, exactly, without asking them anything.
//

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  readFileSync, writeFileSync, mkdirSync, rmSync, cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SCRATCH = join(tmpdir(), "skrim-store-install-test");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8791;
const CDP_PORT = 9337;
const BAR_ID = "1";
const OTHER_ID = "2";
const KEEP = process.argv.includes("--keep");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const rows = [];
const ok = (id, what, detail = "") => {
  rows.push({ id, pass: true });
  console.log(`  ✓ ${id} ${what}${detail ? " — " + detail : ""}`);
};
const bad = (id, what, detail = "") => {
  failures++;
  rows.push({ id, pass: false });
  console.log(`  ✗ ${id} ${what}${detail ? " — " + detail : ""}`);
};
const check = (id, cond, what, detail = "") => ((cond ? ok : bad)(id, what, detail), !!cond);

// --- the store-install copy ------------------------------------------------

function makeStoreCopy() {
  const dir = join(SCRATCH, "ext-store");
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(ROOT, "extension"), dir, { recursive: true });
  const mf = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  // Exactly what Chrome writes into the manifest it hands back for an item
  // installed from the Web Store.
  mf.update_url = "https://clients2.google.com/service/update2/crx";
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(mf, null, 2));
  return dir;
}

// --- a page that behaves badly, to prove the hook is not fragile -----------

const HOSTILE = `<!doctype html><meta charset="utf-8"><title>hostile</title><body>
<script>
window.__probe = {};
// 1. Does the patched method survive a page that inspects it?
const gdm = navigator.mediaDevices.getDisplayMedia;
window.__probe.str  = Function.prototype.toString.call(gdm);
window.__probe.name = gdm.name;
window.__probe.len  = gdm.length;
window.__probe.own  = Object.prototype.hasOwnProperty.call(navigator.mediaDevices, "getDisplayMedia");
window.__probe.desc = JSON.stringify(Object.getOwnPropertyDescriptor(MediaDevices.prototype, "getDisplayMedia") ? "present" : "absent");
// 2. Enumerable keys of the prototype must not have gained a visible symbol/string.
window.__probe.keys = Object.keys(MediaDevices.prototype).length;
window.__probe.protoOwn = Object.getOwnPropertyNames(MediaDevices.prototype).sort().join(",");
// 3. A page that replaces postMessage must not break, and must not break us.
window.__probe.pmReplaced = false;
</script>
</body>`;

// A page that freezes the prototype BEFORE our hook could run is impossible
// (document_start beats inline script), but one that freezes it after must not
// make the hook throw on the next page.
const FROZEN = `<!doctype html><meta charset="utf-8"><title>frozen</title><body>
<script>try { Object.freeze(MediaDevices.prototype); window.__froze = true; } catch(e) { window.__froze = String(e); }</script>
</body>`;

function startServer() {
  const server = createServer((req, res) => {
    const send = (body) =>
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    if (req.url.startsWith("/hostile")) return send(HOSTILE);
    if (req.url.startsWith("/frozen")) return send(FROZEN);
    if (req.url.startsWith("/favicon")) return res.writeHead(204).end();
    send(`<!doctype html><meta charset="utf-8"><title>plain page</title><body>plain`);
  });
  return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

// --- CDP -------------------------------------------------------------------

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (!m.id) { this.events.push(m); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.rej(new Error(`${p.method}: ${m.error.message}`)) : p.res(m.result);
    };
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("cdp ws failed")); });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${method}: timed out`)); }, 40_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const attach = async (cdp, targetId) =>
  (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

async function evaluate(cdp, sessionId, expression, opts = {}) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: opts.awaitPromise !== false,
    returnByValue: true, userGesture: !!opts.userGesture,
  }, sessionId);
  if (r.exceptionDetails) {
    throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  }
  return r.result.value;
}


/** Runtime.evaluate has no top-level await; every body here is wrapped. */
const aeval = (cdp, sid, body, opts) =>
  evaluate(cdp, sid, `(async () => { ${body} })()`, opts);

async function findTarget(cdp, pred, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const t = targetInfos.find(pred);
    if (t) return t;
    if (Date.now() > deadline) return null;
    await sleep(150);
  }
}

async function openTab(cdp, url, settle = 900) {
  const { targetId } = await cdp.send("Target.createTarget", { url });
  const sessionId = await attach(cdp, targetId);
  const deadline = Date.now() + 20_000;
  // A target exists a moment before it navigates, so a readyState of "complete"
  // can belong to the initial about:blank. Match the URL too, or every eval
  // below is a coin flip on which document answered.
  for (;;) {
    const here = await evaluate(cdp, sessionId, "location.href").catch(() => "");
    const rs = await evaluate(cdp, sessionId, "document.readyState").catch(() => "");
    if (here.startsWith(url.split("#")[0]) && rs === "complete") break;
    if (Date.now() > deadline) throw new Error(`${url} never loaded`);
    await sleep(120);
  }
  await sleep(settle);
  return { targetId, sessionId };
}

/** Collects everything the page logged at error/warning level. */
async function watchConsole(cdp, sessionId, sink) {
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  const drain = () => {
    for (const e of cdp.events.splice(0)) {
      if (e.sessionId !== sessionId) { cdp.events.push(e); continue; }
      if (e.method === "Runtime.exceptionThrown") {
        sink.push({ level: "exception", text: e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text });
      } else if (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) {
        sink.push({ level: e.params.entry.level, text: e.params.entry.text });
      } else if (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) {
        sink.push({ level: e.params.type, text: (e.params.args ?? []).map((a) => a.value ?? a.description).join(" ") });
      }
    }
  };
  return drain;
}

// --- Chrome ----------------------------------------------------------------

async function makeProfile(profile) {
  try {
    execFileSync("/usr/bin/pkill", ["-f", `user-data-dir=${profile}`]);
    await sleep(1500);
  } catch {}
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
    extensions: { ui: { developer_mode: true } },
    bookmark_bar: { show_on_all_tabs: true },
  }));
}

const launch = (profile) => spawn(CHROME, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP_PORT}`,
  "--enable-unsafe-extension-debugging",
  "--auto-accept-this-tab-capture",
  "--no-first-run", "--no-default-browser-check", "--disable-sync",
  "--disable-features=Translate,MediaRouter",
  "--window-size=1200,900",
  "about:blank",
], { stdio: "ignore" });

async function browserWs() {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch {}
    if (Date.now() > deadline) throw new Error("no debugging port");
    await sleep(200);
  }
}

const SEED = [
  { title: "Acme Corp — renewal", url: "https://example.com/acme" },
  { title: "Job board", url: "https://example.com/jobs" },
  { title: "Payroll", url: "https://example.com/payroll" },
  { title: "Clients", children: [
    { title: "Globex", url: "https://example.com/globex" },
    { title: "Initech", url: "https://example.com/initech" },
  ] },
  { title: "Q3 forecast", url: "https://example.com/q3" },
];

async function main() {
  const profile = join(SCRATCH, ".qa-chrome");
  const extDir = makeStoreCopy();
  const server = await startServer();
  await makeProfile(profile);
  const proc = launch(profile);
  const cdp = await CDP.connect(await browserWs());
  const shots = join(SCRATCH, "shots");
  mkdirSync(SCRATCH, { recursive: true });
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });

  try {
    // ---------------------------------------------------------------- install
    const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: extDir });
    check("S1", !!extId, "store-shaped copy installed", extId);

    const swTarget = await findTarget(cdp, (t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) throw new Error("service worker never appeared");
    const sw = await attach(cdp, swTarget.targetId);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(cdp, sw, "!!(globalThis.chrome && chrome.bookmarks && chrome.storage?.session)").catch(() => false)) break;
      await sleep(100);
    }
    const swErrors = [];
    const drainSw = await watchConsole(cdp, sw, swErrors);

    const mf = await evaluate(cdp, sw, "JSON.stringify(chrome.runtime.getManifest())");
    check("S2", JSON.parse(mf).update_url !== undefined,
      "Chrome reports update_url, so this copy is indistinguishable from a store install");

    // ------------------------------------------------------------ seed the bar
    await evaluate(cdp, sw, `(async () => {
      const seed = ${JSON.stringify(SEED)};
      const mk = async (node, parentId) => {
        const n = await chrome.bookmarks.create({ parentId, title: node.title, url: node.url });
        for (const c of node.children ?? []) await mk(c, n.id);
      };
      for (const n of seed) await mk(n, "${BAR_ID}");
    })()`);
    const barCount = await aeval(cdp, sw, `return (await chrome.bookmarks.getChildren("${BAR_ID}")).length;`);
    check("S3", barCount === SEED.length, "bar seeded", `${barCount} items`);

    // -------------------------------------------------- the popup, as shipped
    const popup = await openTab(cdp, `chrome-extension://${extId}/popup.html`);
    const popupErrors = [];
    const drainPopup = await watchConsole(cdp, popup.sessionId, popupErrors);
    await sleep(1200);

    const dev = await evaluate(cdp, popup.sessionId, `JSON.stringify({
      hidden: document.getElementById("dev").hidden,
      wired: ["hide","hideNoDecoy","restore","forceRestore","copyOut"]
        .filter((id) => typeof document.getElementById(id).onclick === "function"),
      // Everything a user could reach with a keyboard or a devtools click.
      reachable: [...document.querySelectorAll("button")]
        .filter((b) => b.offsetParent !== null).map((b) => b.id || b.textContent.trim()),
    })`);
    const d = JSON.parse(dev);
    check("S4", d.hidden === true, "developer disclosure is hidden on a store copy");
    check("S5", d.wired.length === 0, "and its handlers are not even bound", `wired=[${d.wired}]`);
    check("S6", !d.reachable.some((r) => /force|no decoys/i.test(r)),
      "no reachable control can call recover() or a no-decoy hide", d.reachable.join(" | "));

    // ------------------------------------------------------- popup, rendered
    const shot = async (name, w = 360, h = 620) => {
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: 2, mobile: false }, popup.sessionId);
      await sleep(350);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, popup.sessionId);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, popup.sessionId);
    };

    // Chrome sizes a popup to its content, capped at 800x600. Anything wider
    // than 800 or taller than 600 gets a scrollbar in the real popup.
    // The popup window is sized to the BODY box and capped at 800x600 -- the tab
    // viewport this runs in says nothing about it. Worst case is every optional
    // notice showing at once, which an unowned vault during a live hide reaches.
    const box = await evaluate(cdp, popup.sessionId, `(() => {
      const ids = ["failure", "adopt", "sinceRow", "syncNote", "dirtyNote"];
      const set = (on) => ids.forEach((i) => (document.getElementById(i).hidden = !on.includes(i)));
      const h = () => Math.ceil(document.body.getBoundingClientRect().height);
      set([]); const armed = h();
      set(ids); const worst = h();
      const body = document.querySelector(".body");
      body.scrollTop = body.scrollHeight;
      const last = document.getElementById("dirtyNote").getBoundingClientRect();
      const reachable = last.top >= 0 && last.bottom <= window.innerHeight + 1;
      const headTop = document.querySelector(".head").getBoundingClientRect().top;
      body.scrollTop = 0; set([]);
      return JSON.stringify({ armed, worst, reachable, headTop,
        w: Math.ceil(document.body.getBoundingClientRect().width) });
    })()`);
    const b = JSON.parse(box);
    check("S7", b.w <= 800, "popup width within Chrome's 800px cap", `${b.w}px`);
    check("S8", b.worst <= 600 && b.armed < b.worst && b.reachable && b.headTop === 0,
      "popup fits the 600px cap with every notice showing, and still scrolls to the last of them",
      `armed ${b.armed}px, worst ${b.worst}px, header pinned at ${b.headTop}`);
    await shot("popup-armed");

    // -------------------------------------------------------- the hide, live
    const page = await openTab(cdp, `http://127.0.0.1:${PORT}/`);
    const pageErrors = [];
    const drainPage = await watchConsole(cdp, page.sessionId, pageErrors);

    const hooked = await evaluate(cdp, page.sessionId,
      `MediaDevices.prototype[Symbol.for("secureshare.hooked")] === true`);
    check("S9", hooked === true, "hook installed on an ordinary page");

    const before = await aeval(cdp, sw, `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`);

    await cdp.send("Target.activateTarget", { targetId: page.targetId });
    await sleep(200);
    const shared = await evaluate(cdp, page.sessionId, `(async () => {
      // Claim a surface the bar CAN appear on, so the hide is held for the
      // whole scenario rather than released as a tab capture.
      const S = MediaStreamTrack.prototype.getSettings;
      MediaStreamTrack.prototype.getSettings = function () {
        const s = S.apply(this, arguments); s.displaySurface = "monitor"; return s;
      };
      const t0 = performance.now();
      window.__stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
      return JSON.stringify({ ms: Math.round(performance.now() - t0), live: window.__stream.getVideoTracks()[0].readyState });
    })()`, { userGesture: true });
    const sh = JSON.parse(shared);
    check("S10", sh.live === "live", "a real share started", `${sh.ms}ms to the stream`);

    await sleep(700);
    const during = await aeval(cdp, sw,
      `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`);
    const seededTitles = SEED.map((s) => s.title);
    const leaked = JSON.parse(during).filter((t) => seededTitles.includes(t));
    check("S11", leaked.length === 0, "not one real bookmark left on the bar", `bar now: ${JSON.parse(during).join(", ")}`);
    check("S12", JSON.parse(during).length === 6, "six placeholders in their place");

    await cdp.send("Target.activateTarget", { targetId: popup.targetId });
    await evaluate(cdp, popup.sessionId, "document.dispatchEvent(new Event('visibilitychange'))").catch(() => {});
    await sleep(900);
    const heroHidden = await evaluate(cdp, popup.sessionId,
      `JSON.stringify({ tone: hero.dataset.tone, title: heroTitle.textContent, pill: pillText.textContent, btn: primaryLabel.textContent, sync: !syncNote.hidden })`);
    const hh = JSON.parse(heroHidden);
    check("S13", hh.tone === "shielded", "popup reports the covered state", JSON.stringify(hh));
    await shot("popup-hidden");

    // ------------------------------------------------ the receipt, as written
    const receipt = await evaluate(cdp, sw, `(async () => {
      const vaults = await chrome.bookmarks.search({ title: ${JSON.stringify("Skrim — hidden while screen sharing (drag these back to your bookmarks bar)")} });
      const v = vaults.find(n => !n.url);
      if (!v) return "null";
      const kids = await chrome.bookmarks.getChildren(v.id);
      const r = kids.find(k => (k.url ?? "").includes("ssr1."));
      return JSON.stringify({ vault: v.id, parent: v.parentId, kids: kids.length, receiptTitle: r?.title ?? null, receiptUrl: r?.url ?? null });
    })()`);
    const rc = JSON.parse(receipt);
    check("S14", rc && rc.parent === OTHER_ID, "vault sits under Other Bookmarks", `${rc?.kids} children`);
    check("S15", typeof rc?.receiptTitle === "string" && rc.receiptTitle.includes("IN THIS FOLDER"),
      "receipt title spells out the manual recovery", rc?.receiptTitle?.slice(0, 90) + "…");
    check("S16", (rc?.receiptUrl ?? "").startsWith(`chrome-extension://${extId}/recovery.html#ssr1.`),
      "receipt URL points at the bundled recovery page");

    // Does clicking that bookmark actually open? An extension page is not
    // web-accessible, so this is the one thing that could silently be a dead
    // link in a user's tree.
    let receiptTab = null;
    try {
      receiptTab = await openTab(cdp, rc.receiptUrl, 1500);
      const note = await evaluate(cdp, receiptTab.sessionId, `document.getElementById("receiptNote").textContent`);
      check("S17", /covers \d+ bookmark/.test(note), "the receipt bookmark opens and decodes itself", note.slice(0, 80) + "…");
    } catch (e) {
      bad("S17", "the receipt bookmark opens and decodes itself", String(e.message));
    }

    // ------------------------------------------------------- end of the share
    await cdp.send("Target.activateTarget", { targetId: page.targetId });
    await evaluate(cdp, page.sessionId, `window.__stream.getVideoTracks().forEach(t => t.stop())`);
    await sleep(1500);
    const after = await aeval(cdp, sw,
      `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`);
    check("S18", after === before, "bar restored byte-identically", JSON.parse(after).join(", "));

    const leftovers = await evaluate(cdp, sw, `(async () => {
      const v = (await chrome.bookmarks.search({ title: ${JSON.stringify("Skrim — hidden while screen sharing (drag these back to your bookmarks bar)")} })).filter(n => !n.url);
      const other = await chrome.bookmarks.getChildren("${OTHER_ID}");
      const st = await chrome.storage.local.get(null);
      return JSON.stringify({ vaults: v.length, other: other.length, storageKeys: Object.keys(st) });
    })()`);
    const lo = JSON.parse(leftovers);
    check("S19", lo.vaults === 0 && lo.other === 0, "no folder, no receipt, no placeholder left behind", JSON.stringify(lo));
    // The journal is the key that must be gone. Backups deliberately outlive a
    // restore -- that is the entire point of them -- so they are named here
    // rather than swept up by a blanket "nothing left in storage" assertion.
    const KEPT_KEYS = (k) =>
      k === "secureshare.ownedVaults" || k.startsWith("skrim.backup");
    check("S20", lo.storageKeys.filter((k) => !KEPT_KEYS(k)).length === 0,
      "journal cleared from storage after a verified restore", `keys=[${lo.storageKeys}]`);
    // And the other half, in a real browser rather than against the mock: the
    // automatic snapshot taken before the hide is actually on disk afterwards.
    check("S20b", lo.storageKeys.some((k) => /^skrim\.backup\.\d{8}-\d{6}-prehide$/.test(k)),
      "the automatic backup taken before the hide survived the whole round trip",
      `keys=[${lo.storageKeys}]`);

    // ------------------------------------------------ the hostile-page checks
    const hostile = await openTab(cdp, `http://127.0.0.1:${PORT}/hostile`);
    const hostileErrors = [];
    const drainHostile = await watchConsole(cdp, hostile.sessionId, hostileErrors);
    const probe = JSON.parse(await evaluate(cdp, hostile.sessionId, "JSON.stringify(window.__probe)"));
    check("S21", /\[native code\]/.test(probe.str),
      "a page sniffing for a patched API sees native code", probe.str.replace(/\s+/g, " "));
    check("S22", probe.name === "getDisplayMedia" && probe.len === 0,
      "name and length forward untouched", `name=${probe.name} length=${probe.len}`);
    check("S23", probe.own === false, "the instance is untouched; only the prototype is patched");
    // WebIDL interface members are enumerable by spec, so the count is never 0.
    // What matters is that hooking added nothing a page can see by enumeration:
    // the marker is a symbol, and symbols appear in neither of these.
    // `constructor` is an own, non-enumerable member of every interface prototype.
    const NATIVE_KEYS = "constructor,enumerateDevices,getDisplayMedia,getSupportedConstraints,getUserMedia,ondevicechange,setCaptureHandleConfig";
    check("S24", probe.protoOwn === NATIVE_KEYS,
      "the prototype's own property names are exactly Chrome's, hooked or not", probe.protoOwn);

    const frozen = await openTab(cdp, `http://127.0.0.1:${PORT}/frozen`);
    const frozenErrors = [];
    const drainFrozen = await watchConsole(cdp, frozen.sessionId, frozenErrors);
    const froze = await evaluate(cdp, frozen.sessionId, "String(window.__froze)");
    check("S25", froze === "true", "a page can still freeze the prototype after us", froze);

    await sleep(500);
    drainPage(); drainHostile(); drainFrozen(); drainPopup(); drainSw();
    const pageNoise = [...pageErrors, ...hostileErrors, ...frozenErrors]
      .filter((e) => !/favicon/i.test(e.text ?? ""));
    check("S26", pageNoise.length === 0, "the extension logs nothing into an ordinary page's console",
      pageNoise.map((e) => `${e.level}: ${e.text}`).join(" | ").slice(0, 200));
    check("S27", popupErrors.length === 0, "popup console is clean",
      popupErrors.map((e) => `${e.level}: ${e.text}`).join(" | ").slice(0, 200));
    const swNoise = swErrors.filter((e) => e.level === "exception" || /could not register/i.test(e.text ?? ""));
    check("S28", swNoise.length === 0, "service worker registered every listener without throwing",
      swNoise.map((e) => e.text).join(" | ").slice(0, 200));

    // ------------------------------------------- uninstall while still hidden
    // The case the receipt exists for. Hide, tear the extension out, put it
    // back, and see whether a real user gets their bookmarks.
    await cdp.send("Target.activateTarget", { targetId: page.targetId });
    await evaluate(cdp, page.sessionId, `(async () => {
      window.__s2 = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true });
    })()`, { userGesture: true });
    await sleep(900);
    const hiddenAgain = await aeval(cdp, sw,
      `return (await chrome.bookmarks.getChildren("${BAR_ID}")).filter(n => ${JSON.stringify(seededTitles)}.includes(n.title)).length;`);
    check("S29", hiddenAgain === 0, "hidden again, ready to be uninstalled mid-hide");

    await cdp.send("Extensions.uninstall", { id: extId }).catch(async () => {
      // Older builds expose no uninstall; drop it from the profile instead.
      await evaluate(cdp, sw, "chrome.management.uninstallSelf()").catch(() => {});
    });
    await sleep(2000);

    // A brand-new tab proves the profile really has no extension left.
    const orphan = await openTab(cdp, "about:blank");
    const stillThere = await findTarget(cdp, (t) => t.type === "service_worker" && t.url.includes(extId), 2000);
    check("S30", !stillThere, "extension is gone from the profile");

    const { id: extId2 } = await cdp.send("Extensions.loadUnpacked", { path: extDir });
    const sw2t = await findTarget(cdp, (t) => t.type === "service_worker" && t.url.includes(extId2));
    const sw2 = await attach(cdp, sw2t.targetId);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(cdp, sw2, "!!(globalThis.chrome && chrome.bookmarks)").catch(() => false)) break;
      await sleep(100);
    }
    await sleep(2500);

    const reopened = await findTarget(cdp, (t) => t.type === "page" && t.url.includes("recovery.html"), 6000);
    const backOnBar = await aeval(cdp, sw2,
      `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`);
    const selfHealed = JSON.parse(before).every((t) => JSON.parse(backOnBar).includes(t));
    check("S31", selfHealed || !!reopened,
      "a reinstall that finds parked bookmarks gets them back, page or no page",
      selfHealed ? "restored itself from the receipt" : "recovery page: " + reopened?.url);
    check("S31b", !selfHealed || backOnBar === before,
      "and when it restores itself it is exact -- original order, no placeholders left",
      JSON.parse(backOnBar).join(", "));

    if (reopened) {
      const rec = await attach(cdp, reopened.targetId);
      const recErrors = [];
      const drainRec = await watchConsole(cdp, rec, recErrors);
      await sleep(1200);
      const cards = await evaluate(cdp, rec, `JSON.stringify({
        n: document.querySelectorAll("#vaults .card").length,
        origin: document.querySelector("#vaults .card")?.dataset.origin ?? null,
        head: document.querySelector("#vaults .card h3")?.textContent ?? null,
        btn: document.querySelector("#vaults .card button")?.textContent ?? null,
        decoys: document.getElementById("decoyList").textContent,
      })`);
      const cd = JSON.parse(cards);
      check("S32", cd.n === 1 && cd.origin === "mine",
        "and identifies the folder as this machine's own, not a peer's", JSON.stringify(cd).slice(0, 160));
      check("S33", /Google|Gmail|Calendar/.test(cd.decoys),
        "and names the placeholder links the user has to delete", cd.decoys.slice(0, 110) + "…");

      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 900, deviceScaleFactor: 2, mobile: false }, rec);
      await sleep(300);
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" }, rec);
      writeFileSync(join(shots, "recovery.png"), Buffer.from(data, "base64"));
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, rec);

      await evaluate(cdp, rec, `document.querySelector("#vaults .card button").click()`);
      await sleep(2500);
      const outcome = await evaluate(cdp, rec, `JSON.stringify({
        tone: document.querySelector("#vaults .card .result")?.dataset.tone ?? null,
        text: document.querySelector("#vaults .card .result")?.textContent ?? null,
      })`);
      const oc = JSON.parse(outcome);
      check("S34", oc.tone === "ok", "one click puts them back", oc.text);

      const finalBar = await aeval(cdp, sw2,
        `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`);
      check("S35", finalBar === before, "and the bar is exactly what it was before any of this",
        JSON.parse(finalBar).join(", "));
      drainRec();
      check("S36", recErrors.length === 0, "recovery page console is clean",
        recErrors.map((e) => e.text).join(" | ").slice(0, 160));
    }
  } finally {
    console.log("\n==================================================================");
    console.log(`  store-install QA passed : ${rows.filter((r) => r.pass).length}`);
    console.log(`  store-install QA failed : ${failures}`);
    console.log(`  screenshots             : ${shots}`);
    console.log("==================================================================");
    cdp.close();
    server.close();
    if (!KEEP) {
      // Waited out, not just signalled. Chrome holds its profile's singleton
      // lock for a moment after SIGTERM, and live-test.mjs launching into that
      // window hands its arguments to the dying process and exits with no
      // debugging port -- which looks exactly like a test failure and is not.
      try { proc.kill(); } catch { /* already gone */ }
      await new Promise((r) => (proc.exitCode === null ? proc.once("exit", r) : r()));
      await sleep(1500);
    }
  }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("HARNESS FAILED:", e); process.exit(2); });
