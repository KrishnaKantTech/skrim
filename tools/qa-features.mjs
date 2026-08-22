// Real-Chrome QA for the three additions: the decoy setting, tuck/untuck, and
// the backup page (copy / download / import). Drives the SHIPPED UI -- clicks
// the real toggle and buttons, sets a real file on the import input, captures a
// real download -- so the browser-only paths the Node suite cannot reach are
// proven end to end. Modelled on tools/store-install-test.mjs.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXT = join(ROOT, "extension");
const SCRATCH = join(tmpdir(), "skrim-qa-features");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CDP_PORT = 9341;
const BAR_ID = "1";
const KEEP = process.argv.includes("--keep");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (id, what, detail = "") => console.log(`  ✓ ${id} ${what}${detail ? " — " + detail : ""}`);
const bad = (id, what, detail = "") => { failures++; console.log(`  ✗ ${id} ${what}${detail ? " — " + detail : ""}`); };
const check = (id, cond, what, detail = "") => ((cond ? ok : bad)(id, what, detail), !!cond);

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

const attach = async (cdp, targetId) => (await cdp.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;

async function evaluate(cdp, sessionId, expression, opts = {}) {
  const r = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: opts.awaitPromise !== false, returnByValue: true, userGesture: !!opts.userGesture,
  }, sessionId);
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result.value;
}
const aeval = (cdp, sid, body, opts) => evaluate(cdp, sid, `(async () => { ${body} })()`, opts);

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
async function watchConsole(cdp, sessionId, sink) {
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  return () => {
    for (const e of cdp.events.splice(0)) {
      if (e.sessionId !== sessionId) { cdp.events.push(e); continue; }
      if (e.method === "Runtime.exceptionThrown") sink.push(e.params.exceptionDetails?.exception?.description ?? e.params.exceptionDetails?.text);
      else if (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) sink.push(e.params.entry.text);
      else if (e.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(e.params.type)) sink.push((e.params.args ?? []).map((a) => a.value ?? a.description).join(" "));
    }
  };
}

async function makeProfile(profile) {
  try { execFileSync("/usr/bin/pkill", ["-f", `user-data-dir=${profile}`]); await sleep(1200); } catch {}
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(join(profile, "Default"), { recursive: true });
  writeFileSync(join(profile, "Default", "Preferences"), JSON.stringify({
    extensions: { ui: { developer_mode: true } }, bookmark_bar: { show_on_all_tabs: true },
  }));
}
const launch = (profile) => spawn(CHROME, [
  `--user-data-dir=${profile}`, `--remote-debugging-port=${CDP_PORT}`,
  "--enable-unsafe-extension-debugging", "--auto-accept-this-tab-capture",
  "--no-first-run", "--no-default-browser-check", "--disable-sync",
  "--disable-features=Translate,MediaRouter", "--window-size=1200,900", "about:blank",
], { stdio: "ignore" });
async function browserWs() {
  const deadline = Date.now() + 25_000;
  for (;;) {
    try { const j = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json(); if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl; } catch {}
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
const barTitles = (cdp, sw) => aeval(cdp, sw, `return JSON.stringify((await chrome.bookmarks.getChildren("${BAR_ID}")).map(n => n.title));`).then(JSON.parse);
const barSnapshot = (cdp, sw) => aeval(cdp, sw, `
  const walk = async (id) => { const [n] = await chrome.bookmarks.getSubTree(id);
    const kids = n.children ? await Promise.all(n.children.map(c => walk(c.id))) : null;
    return { t: n.title, u: n.url ?? null, c: kids }; };
  const [bar] = await chrome.bookmarks.getSubTree("${BAR_ID}");
  return JSON.stringify(await Promise.all(bar.children.map(c => walk(c.id))));`).then(JSON.parse);

async function main() {
  const profile = join(SCRATCH, ".qa-chrome");
  const downloads = join(SCRATCH, "downloads");
  mkdirSync(SCRATCH, { recursive: true });
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  await makeProfile(profile);
  const proc = launch(profile);
  const cdp = await CDP.connect(await browserWs());

  try {
    const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
    check("Q0", !!extId, "extension installed unpacked", extId);
    const swTarget = await findTarget(cdp, (t) => t.type === "service_worker" && t.url.includes(extId));
    if (!swTarget) throw new Error("service worker never appeared");
    const sw = await attach(cdp, swTarget.targetId);
    for (let i = 0; i < 100; i++) { if (await evaluate(cdp, sw, "!!(globalThis.chrome && chrome.bookmarks)").catch(() => false)) break; await sleep(100); }

    await cdp.send("Browser.grantPermissions", {
      origin: `chrome-extension://${extId}`, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    }).catch(() => {});
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true }).catch(() => {});

    // seed the bar
    await aeval(cdp, sw, `
      const seed = ${JSON.stringify(SEED)};
      const mk = async (node, parentId) => { const n = await chrome.bookmarks.create({ parentId, title: node.title, url: node.url }); for (const c of node.children ?? []) await mk(c, n.id); };
      for (const n of seed) await mk(n, "${BAR_ID}");`);
    const seededSnap = JSON.stringify(await barSnapshot(cdp, sw));
    check("Q1", (await barTitles(cdp, sw)).length === SEED.length, "bar seeded", `${SEED.length} items`);

    // ---- open popup, open the settings panel -------------------------------
    const popup = await openTab(cdp, `chrome-extension://${extId}/popup.html`);
    const popupErr = []; const drainPopup = await watchConsole(cdp, popup.sessionId, popupErr);
    await cdp.send("Target.activateTarget", { targetId: popup.targetId });
    await sleep(800);
    const P = (body, opts) => aeval(cdp, popup.sessionId, body, opts);
    const msg = (obj) => P(`return await chrome.runtime.sendMessage(${JSON.stringify(obj)});`);

    // open <details> and let the panel load its state from the worker
    await P(`document.getElementById("settings").open = true;`);
    await sleep(700);
    const initToggle = await P(`return document.getElementById("decoyToggle").checked;`);
    check("Q2", initToggle === true, "settings panel: decoy toggle defaults to on", `checked=${initToggle}`);

    // ---- FEATURE 1: decoy toggle -------------------------------------------
    await P(`document.getElementById("decoyToggle").click();`, { userGesture: true });
    await sleep(400);
    const off = await msg({ type: "getSettings" });
    check("Q3", off.decoys === false, "toggling it stores decoys:false", JSON.stringify(off));
    await msg({ type: "hide" });
    await sleep(400);
    check("Q4", (await barTitles(cdp, sw)).length === 0, "an option-less hide now leaves the bar EMPTY (no decoys)");
    await msg({ type: "restore" });
    await sleep(400);
    check("Q5", JSON.stringify(await barSnapshot(cdp, sw)) === seededSnap, "restore is byte-identical with decoys off");

    await P(`document.getElementById("decoyToggle").click();`, { userGesture: true });
    await sleep(400);
    const on = await msg({ type: "getSettings" });
    check("Q6", on.decoys === true, "toggling back stores decoys:true", JSON.stringify(on));
    await msg({ type: "hide" });
    await sleep(400);
    const decoyed = await barTitles(cdp, sw);
    check("Q7", decoyed.length === 6 && decoyed.includes("Google"), "and a hide drops the six placeholders again", decoyed.join(","));
    await msg({ type: "restore" });
    await sleep(400);
    check("Q8", JSON.stringify(await barSnapshot(cdp, sw)) === seededSnap, "restore exact after the decoyed hide");

    // ---- FEATURE 2: tuck MODE (hide INTO a folder, not the vault) ----------
    // The toggle arms it; a hide then parks the bar into one folder that stays
    // ON the bar. Sync-safe -- nothing is moved off to Other Bookmarks.
    await P(`document.getElementById("settings").open = false; document.getElementById("settings").open = true;`);
    await sleep(700);
    const tuckInit = await P(`return document.getElementById("tuckToggle").checked;`);
    check("Q9", tuckInit === false, "settings panel: tuck toggle defaults to off", `checked=${tuckInit}`);

    // type a custom folder name (fires the debounced save), then flip it on.
    // Click the VISIBLE track, not the input: the track paints over the checkbox,
    // so clicking the input directly would pass even if the row were not a proper
    // <label for> and a real cursor click landed on the track and did nothing.
    await P(`const f = document.getElementById("tuckName"); f.value = "My Links"; f.dispatchEvent(new Event("input", { bubbles: true }));`);
    await sleep(600);
    await P(`document.querySelector('label[for="tuckToggle"] .switch__track').click();`, { userGesture: true });
    await sleep(400);
    const tcfg = await msg({ type: "getSettings" });
    check("Q10", tcfg.tuckMode === true && tcfg.tuckName === "My Links",
      "toggling on stores tuckMode:true and the typed folder name", JSON.stringify({ tuckMode: tcfg.tuckMode, tuckName: tcfg.tuckName }));

    // a hide now TUCKS: the bar holds one folder, everything inside it, no vault
    await msg({ type: "conceal" });
    await sleep(500);
    const afterTuck = await barSnapshot(cdp, sw);
    const vaultCount = await aeval(cdp, sw, `return (await chrome.bookmarks.search({})).filter(n => !n.url && /^Skrim —/.test(n.title)).length;`);
    const tuckStatus = await msg({ type: "status" });
    check("Q11", afterTuck.length === 1 && afterTuck[0].u === null && afterTuck[0].t === "My Links" && afterTuck[0].c.length === SEED.length,
      "hiding leaves the bar holding one folder with every item inside it", `${JSON.stringify(afterTuck.map(n => n.t))}; ${afterTuck[0]?.c?.length} inside`);
    check("Q12", vaultCount === 0 && tuckStatus.mode === "tuck",
      "and nothing was moved off to a vault (the sync-safe win)", JSON.stringify({ vaults: vaultCount, mode: tuckStatus.mode }));

    await msg({ type: "restore" });
    await sleep(500);
    check("Q13", JSON.stringify(await barSnapshot(cdp, sw)) === seededSnap, "restoring untucks the bar byte-identically");

    // ---- FEATURE 2b: the switches, flipped WHILE THE BAR IS HIDDEN ---------
    // The point of the whole feature: mid-call, the bar already down, a user
    // changes their mind. Every check below is on the REAL bar in a REAL
    // browser between clicks on the REAL toggles -- no re-hide anywhere.
    const liveNote = () => P(`const n = document.getElementById("liveNote"); return { hidden: n.hidden, text: n.textContent, tone: n.dataset.tone ?? null };`);
    const vaults = () => aeval(cdp, sw, `return (await chrome.bookmarks.search({})).filter(n => !n.url && /^Skrim —/.test(n.title)).length;`);

    await msg({ type: "conceal" }); // tuck mode is still on from Q10
    await sleep(600);
    const tucked = await barSnapshot(cdp, sw);
    check("QL1", tucked.length === 1 && tucked[0].t === "My Links" && tucked[0].c.length === SEED.length,
      "live: precondition — the bar is hidden, tucked into one folder", JSON.stringify(tucked.map((n) => n.t)));

    // tuck OFF, mid-hide: the folder should leave the bar and the bookmarks
    // should end up in a vault, without ever appearing on screen.
    await P(`document.querySelector('label[for="tuckToggle"] .switch__track').click();`, { userGesture: true });
    await sleep(1200);
    const afterUntuck = await barTitles(cdp, sw);
    const untuckStatus = await msg({ type: "status" });
    check("QL2", afterUntuck.length === 6 && afterUntuck.includes("Google") && !afterUntuck.includes("My Links"),
      "live: flipping tuck OFF mid-hide clears the folder off the bar", afterUntuck.join(","));
    check("QL3", (await vaults()) === 1 && untuckStatus.mode === "vault" && untuckStatus.hidden === true &&
      untuckStatus.itemsDisplaced === SEED.length,
      "live: and the same hide is now a vault hide, still holding everything",
      JSON.stringify({ mode: untuckStatus.mode, n: untuckStatus.itemsDisplaced }));
    const noteA = await liveNote();
    check("QL4", noteA.hidden === false && /parked away/.test(noteA.text),
      "live: the panel says what it just did", noteA.text.trim());

    // placeholders OFF, then ON, with the bar still down
    await P(`document.getElementById("decoyToggle").click();`, { userGesture: true });
    await sleep(900);
    check("QL5", (await barTitles(cdp, sw)).length === 0,
      "live: switching placeholders off empties the hidden bar immediately",
      (await barTitles(cdp, sw)).join(","));
    await P(`document.getElementById("decoyToggle").click();`, { userGesture: true });
    await sleep(900);
    const backOn = await barTitles(cdp, sw);
    check("QL6", backOn.length === 6 && backOn.includes("Calendar"),
      "live: and switching them back on puts them straight back", backOn.join(","));

    // tuck ON again, still mid-hide: back to one folder, no vault
    await P(`document.querySelector('label[for="tuckToggle"] .switch__track').click();`, { userGesture: true });
    await sleep(1200);
    const reTucked = await barSnapshot(cdp, sw);
    const reStatus = await msg({ type: "status" });
    check("QL7", reTucked.length === 1 && reTucked[0].t === "My Links" && reTucked[0].c.length === SEED.length &&
      (await vaults()) === 0 && reStatus.mode === "tuck",
      "live: flipping tuck back ON mid-hide re-folds it, vault and all",
      JSON.stringify({ bar: reTucked.map((n) => n.t), inside: reTucked[0]?.c?.length, mode: reStatus.mode }));

    await msg({ type: "restore" });
    await sleep(600);
    check("QL8", JSON.stringify(await barSnapshot(cdp, sw)) === seededSnap,
      "live: after four conversions mid-hide, restore is still byte-identical");

    // leave tuck mode off for the backup tests that follow
    await P(`document.querySelector('label[for="tuckToggle"] .switch__track').click();`, { userGesture: true });
    await sleep(300);

    // ---- FEATURE 3: backup page --------------------------------------------
    const backup = await openTab(cdp, `chrome-extension://${extId}/backup.html`);
    const backupErr = []; const drainBackup = await watchConsole(cdp, backup.sessionId, backupErr);
    await cdp.send("Target.activateTarget", { targetId: backup.targetId });
    await sleep(900);
    const B = (body, opts) => aeval(cdp, backup.sessionId, body, opts);

    const lede = await B(`return document.getElementById("exportLede").textContent;`);
    check("Q14", /6 bookmarks/.test(lede), "backup page counts the bar's links", lede.trim());
    const dlDisabled = await B(`return document.getElementById("download").disabled;`);
    check("Q15", dlDisabled === false, "download is enabled when the bar has bookmarks");

    // copy -> clipboard, then read it back
    await B(`document.getElementById("copy").click();`, { userGesture: true });
    await sleep(500);
    const copyResult = await B(`return document.getElementById("exportResult").textContent;`);
    const clip = await B(`try { return await navigator.clipboard.readText(); } catch (e) { return "ERR:" + e.message; }`, { userGesture: true });
    check("Q16", /Copied/i.test(copyResult), "copy reports success", copyResult.trim());
    check("Q17", clip.includes("Clients/") && clip.includes("Acme Corp") && clip.includes("Globex"),
      "and the clipboard holds the real outline, folders and all", clip.slice(0, 60).replace(/\n/g, " "));

    // The HTML flavour rides along, so a paste into a doc or a message arrives
    // as clickable links rather than raw text. Browser-only: the write goes
    // through ClipboardItem, which the Node suite has no way to exercise.
    const clipHtml = await B(`
      try {
        const items = await navigator.clipboard.read();
        const types = items.flatMap((i) => i.types);
        if (!types.includes("text/html")) return "NO-HTML:" + types.join(",");
        for (const i of items) {
          if (i.types.includes("text/html")) return await (await i.getType("text/html")).text();
        }
        return "NO-HTML";
      } catch (e) { return "ERR:" + e.message; }
    `, { userGesture: true });
    check("Q17b", /<a href="https:\/\/example\.com\/acme"/.test(clipHtml) && /<strong>Clients<\/strong>/.test(clipHtml),
      "and an HTML flavour too, so a paste into a doc lands as real links",
      clipHtml.replace(/\s+/g, " ").slice(0, 70));

    // download -> capture the file off disk and parse it back
    rmSync(downloads, { recursive: true, force: true }); mkdirSync(downloads, { recursive: true });
    await B(`document.getElementById("download").click();`, { userGesture: true });
    let file = null;
    for (let i = 0; i < 40 && !file; i++) { await sleep(150); const f = readdirSync(downloads).find((n) => n.endsWith(".html")); if (f) file = join(downloads, f); }
    check("Q18", !!file, "download writes a .html file", file ? file.split("/").pop() : "no file");
    if (file) {
      const html = readFileSync(file, "utf8");
      check("Q19", html.includes("<!DOCTYPE NETSCAPE-Bookmark-file-1>") && html.includes("Acme Corp") && html.includes("https://example.com/globex"),
        "the file is a real Netscape bookmark file with the bar's contents");
      // feed our own export back through import to prove the round trip
      const importFile = join(SCRATCH, "reimport.html");
      writeFileSync(importFile, html);
      const doc = await cdp.send("DOM.getDocument", { depth: -1 }, backup.sessionId);
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#importFile" }, backup.sessionId);
      // setFileInputFiles fires the change event itself -- do NOT dispatch a
      // second one, or the import runs twice.
      await cdp.send("DOM.setFileInputFiles", { files: [importFile], nodeId }, backup.sessionId);
      await sleep(1400);
      const importResult = await B(`return document.getElementById("importResult").textContent;`);
      check("Q20", /Imported\s+6\s+bookmark/i.test(importResult), "import reports six bookmarks added", importResult.trim());
      const barNow = await barSnapshot(cdp, sw);
      const imported = barNow[barNow.length - 1];
      check("Q21", barNow.length === SEED.length + 1 && /^Imported bookmarks/.test(imported.t) && imported.u === null,
        "import adds exactly one new folder to the bar", `${barNow.length} bar items; last = ${imported.t}`);
      check("Q22", JSON.stringify(barNow.slice(0, SEED.length)) === seededSnap,
        "and leaves every pre-existing bookmark untouched");
    }

    // import a foreign (Firefox-style) file too, to prove interop
    const foreign = [
      "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
      "<TITLE>Bookmarks</TITLE><H1>Bookmarks Menu</H1>",
      "<DL><p>",
      '  <DT><H3>Recipes</H3>',
      "  <DL><p>",
      '    <DT><A HREF="https://cooking.example/?a=1&amp;b=2">Pasta &amp; sauce</A>',
      "  </DL><p>",
      '  <DT><A HREF="https://news.example/">Daily news</A>',
      "</DL><p>",
    ].join("\n");
    const foreignFile = join(SCRATCH, "firefox.html");
    writeFileSync(foreignFile, foreign);
    const doc2 = await cdp.send("DOM.getDocument", { depth: -1 }, backup.sessionId);
    const q2 = await cdp.send("DOM.querySelector", { nodeId: doc2.root.nodeId, selector: "#importFile" }, backup.sessionId);
    await cdp.send("DOM.setFileInputFiles", { files: [foreignFile], nodeId: q2.nodeId }, backup.sessionId);
    await sleep(1400);
    const foreignResult = await B(`return document.getElementById("importResult").textContent;`);
    check("Q23", /Imported\s+2\s+bookmark/i.test(foreignResult), "a foreign browser export imports too", foreignResult.trim());
    const found = await aeval(cdp, sw, `
      const kids = await chrome.bookmarks.search({ query: "Pasta" });
      return JSON.stringify(kids.map(k => ({ t: k.title, u: k.url })));`);
    check("Q24", /Pasta & sauce/.test(found) && /cooking\.example\/\?a=1&b=2/.test(found),
      "with entities in the title AND the URL decoded correctly", found);

    // ---- consoles stay clean ------------------------------------------------
    drainPopup(); drainBackup();

    // ---- FEATURE 4: the backups Skrim keeps --------------------------------
    //
    // Driven through the shipped UI on purpose. The Node suite proves the diff
    // itself against a mock; what only a real browser can prove is that the
    // page's buttons reach the worker, that the <dialog> opens and reports the
    // numbers the engine actually computed, and that a restore triggered by a
    // click lands on the real bookmark tree.

    // The hide earlier in this run should already have left a snapshot behind.
    await B(`await new Promise(r => setTimeout(r, 400));`);
    const snapCount = await B(`return document.querySelectorAll("#snapList .snap").length;`);
    check("Q27", snapCount > 0, "the automatic pre-hide snapshot is listed on the page",
      `${snapCount} listed`);
    const firstTag = await B(`return document.querySelector("#snapList .tag")?.textContent ?? "";`);
    check("Q28", /before hide|manual|daily|original/.test(firstTag),
      "tagged in plain words, not a raw kind", firstTag);
    // The copy taken at install. Only a real browser can prove this one: the
    // profile is wiped at the top of every run, so Chrome fires a genuine
    // onInstalled("install") and the worker has to have answered it before the
    // user ever opened this page.
    const allTags = await B(`
      return [...document.querySelectorAll("#snapList .tag")].map((t) => t.textContent).join(",");
    `);
    check("Q28b", /original/.test(allTags),
      "the copy taken when Skrim was installed is listed too", allTags);
    const autoOn = await B(`return document.getElementById("autoToggle").checked;`);
    check("Q29", autoOn === true, "automatic backups read as on by default");

    // Take one by hand, with a name.
    await B(`
      const f = document.getElementById("backupLabel");
      f.value = "QA good state";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("backupNow").click();
    `, { userGesture: true });
    await sleep(900);
    const snapMsg = await B(`return document.getElementById("snapResult").textContent;`);
    check("Q30", /Saved/i.test(snapMsg), "Back up now saves a copy", snapMsg.trim());
    const named = await B(`return document.querySelector("#snapList .snap__name")?.textContent ?? "";`);
    check("Q31", named === "QA good state", "and the typed name is what the list shows", named);

    // Rename it in the row -- through the real pencil, the real field and a
    // real Enter, because the Node suite proves the storage and this is the
    // half only a browser can: that the pencil sits at the end of the title,
    // that clicking it turns THAT line into the field, and that Enter commits.
    const pencil = JSON.parse(await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const row = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA good state");
      row.scrollIntoView({ block: "center" });
      const title = row.querySelector(".snap__title");
      const btn = title.querySelector("button.iconbtn");
      const r = title.getBoundingClientRect();
      return JSON.stringify({
        inTitle: !!btn,
        last: title.lastElementChild === btn,
        label: btn?.getAttribute("aria-label") ?? null,
        hasSvg: !!btn?.querySelector("svg"),
        rest: btn ? getComputedStyle(btn).opacity : null,
        x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2),
      });
    `));
    // A real mouse move, not a reading of the stylesheet. "Hidden until hover"
    // is exactly the rule that can be present in the sheet and not applying --
    // wrong selector, wrong media query, a transition that never lands.
    await cdp.send("Input.dispatchMouseEvent",
      { type: "mouseMoved", x: pencil.x, y: pencil.y, buttons: 0 }, backup.sessionId);
    await sleep(500);
    const onHover = await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const row = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA good state");
      return getComputedStyle(row.querySelector(".snap__title button.iconbtn")).opacity;
    `);
    check("Q31a", pencil.inTitle === true && pencil.last === true && pencil.hasSvg === true &&
      /^Rename the backup from /.test(pencil.label ?? "") &&
      pencil.rest === "0" && onHover === "1",
      "a named pencil sits at the end of the title, hidden until the row is hovered",
      `rest=${pencil.rest} hover=${onHover} label=${pencil.label}`);
    await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const row = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA good state");
      row.querySelector(".snap__title button.iconbtn").click();
    `, { userGesture: true });
    const editing = await B(`
      const f = document.querySelector("#snapList .snap__rename .field");
      const row = f?.closest(".snap");
      return JSON.stringify({
        open: !!f,
        value: f?.value ?? null,
        focused: document.activeElement === f,
        // The field replaced the TITLE and nothing else: the date, the counts
        // and the three buttons all have to still be there, unmoved.
        titleGone: !row?.querySelector(".snap__title"),
        keptDate: !!row?.querySelector(".snap__when"),
        keptMeta: !!row?.querySelector(".snap__meta"),
        actions: row ? [...row.querySelectorAll(".snap__actions button")].map((b) => b.textContent).join(",") : null,
      });
    `);
    const ed = JSON.parse(editing);
    check("Q31b", ed.open === true && ed.value === "QA good state" && ed.focused === true &&
      ed.titleGone === true && ed.keptDate === true && ed.keptMeta === true &&
      ed.actions === "Put back,Download,Delete",
      "the pencil turns the title into a focused field and leaves the rest of the row alone",
      editing);
    await B(`
      const f = document.querySelector("#snapList .snap__rename .field");
      f.value = "QA renamed state";
      f.form.requestSubmit();
    `, { userGesture: true });
    await sleep(900);
    const renamedTo = await B(`
      return [...document.querySelectorAll("#snapList .snap__name")].map((n) => n.textContent).join(",");
    `);
    check("Q31c", /QA renamed state/.test(renamedTo) && !/QA good state/.test(renamedTo),
      "and Enter alone commits the new name", renamedTo);
    // Escape has to be the way out, or the only exit from the editor is a
    // rename nobody asked for.
    await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const row = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA renamed state");
      row.querySelector(".snap__title button.iconbtn").click();
      const f = document.querySelector("#snapList .snap__rename .field");
      f.value = "typed then abandoned";
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    `, { userGesture: true });
    await sleep(400);
    const afterEsc = await B(`
      return JSON.stringify({
        open: !!document.querySelector("#snapList .snap__rename"),
        names: [...document.querySelectorAll("#snapList .snap__name")].map((n) => n.textContent).join(","),
      });
    `);
    // Icon AND word on each action. The word is the half that matters: an
    // icon-only Delete is one mis-click with nothing on screen to warn you.
    const actionIcons = JSON.parse(await B(`
      const row = document.querySelector("#snapList .snap");
      return JSON.stringify([...row.querySelectorAll(".snap__actions button")].map((b) => ({
        word: b.textContent,
        svg: !!b.querySelector("svg"),
        inline: getComputedStyle(b).display,
      })));
    `));
    // "flex", not "inline-flex": .snap__actions is itself a flex container, and
    // a flex item's inline-flex is blockified to flex. Either answer means the
    // icon and the word are laid out on one line, which is the actual claim.
    check("Q31e", actionIcons.length === 3 &&
      actionIcons.every((b) => b.svg === true && /^(inline-)?flex$/.test(b.inline)) &&
      actionIcons.map((b) => b.word).join(",") === "Put back,Download,Delete",
      "each action carries an icon and still says its name", JSON.stringify(actionIcons));

    check("Q31d", JSON.parse(afterEsc).open === false &&
      /QA renamed state/.test(JSON.parse(afterEsc).names) &&
      !/abandoned/.test(JSON.parse(afterEsc).names),
      "Escape closes the editor and keeps the old name", afterEsc);
    // The yardstick for the restore below: the bar exactly as this backup saw
    // it. Not seededSnap -- the import tests above have legitimately added two
    // folders since then.
    const goodSnap = JSON.stringify(await barSnapshot(cdp, sw));

    // Now wreck the bar behind the page's back, exactly the way a bad restore
    // would: drag a nested bookmark out onto the top level, and add a stray.
    const wrecked = await evaluate(cdp, sw, `(async () => {
      const bar = (await chrome.bookmarks.getSubTree("${BAR_ID}"))[0];
      const folder = bar.children.find((c) => c.children && c.children.length);
      await chrome.bookmarks.move(folder.children[0].id, { parentId: "${BAR_ID}", index: 0 });
      await chrome.bookmarks.create({ parentId: "${BAR_ID}", title: "QA stray", url: "https://stray.qa/" });
      return (await chrome.bookmarks.getSubTree("${BAR_ID}"))[0].children.map((c) => c.title).join(",");
    })()`, { awaitPromise: true });
    check("Q32", /QA stray/.test(wrecked), "the bar is wrong now", wrecked);

    // Reload so the page sees the tree as it is, then ask to put it back.
    await cdp.send("Page.reload", {}, backup.sessionId);
    await sleep(1400);
    await B(`document.querySelector('#snapList .snap button.primary').click();`, { userGesture: true });
    await sleep(1200);
    const dialogOpen = await B(`return document.getElementById("confirmDialog").open === true;`);
    check("Q33", dialogOpen === true, "Put back opens a confirm before it touches anything");
    const planRows = await B(`
      return [...document.querySelectorAll("#confirmPlan li")]
        .map((li) => li.children[0].textContent + "=" + li.children[1].textContent).join(", ");
    `);
    check("Q34", /Moved back into place=[1-9]/.test(planRows) && /Deleted=1/.test(planRows),
      "the confirm shows real counts from a dry run", planRows);
    const stillWrecked = await evaluate(cdp, sw, `(async () => {
      const bar = (await chrome.bookmarks.getSubTree("${BAR_ID}"))[0];
      return bar.children.some((c) => c.title === "QA stray");
    })()`, { awaitPromise: true });
    check("Q35", stillWrecked === true, "and the dry run changed nothing at all");

    const beforeRestore = JSON.stringify(await barSnapshot(cdp, sw));
    await B(`document.getElementById("confirmGo").click();`, { userGesture: true });
    await sleep(1600);
    const restoreMsg = await B(`return document.getElementById("snapResult").textContent;`);
    check("Q36", /back/i.test(restoreMsg) && !/Could not/.test(restoreMsg),
      "the restore reports what it did", restoreMsg.trim().slice(0, 110));
    const afterRestore = JSON.stringify(await barSnapshot(cdp, sw));
    check("Q37", afterRestore !== beforeRestore && !/QA stray/.test(afterRestore),
      "the stray is gone and the bar changed", afterRestore.slice(0, 90));
    check("Q38", afterRestore === goodSnap,
      "and the bar is byte-identical to how it was when the backup was taken",
      afterRestore.slice(0, 120));

    // The safety copy is the promise that makes the destructive button safe.
    const safetyTag = await B(`
      return [...document.querySelectorAll("#snapList .tag")].map((t) => t.textContent).join(",");
    `);
    check("Q39", /safety/.test(safetyTag), "a safety copy was taken and is listed", safetyTag);

    // Download one straight out of storage.
    rmSync(downloads, { recursive: true, force: true }); mkdirSync(downloads, { recursive: true });
    await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const named = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA renamed state");
      [...named.querySelectorAll("button")].find((b) => b.textContent === "Download").click();
    `, { userGesture: true });
    let snapFile = null;
    for (let i = 0; i < 40 && !snapFile; i++) {
      await sleep(150);
      const f = readdirSync(downloads).find((n) => n.startsWith("skrim-backup-"));
      if (f) snapFile = join(downloads, f);
    }
    check("Q40", !!snapFile && /skrim-backup-\d{4}-\d{2}-\d{2}-\d{4}-qa-renamed-state\.html$/.test(snapFile ?? ""),
      "a backup downloads under its own name", snapFile ? snapFile.split("/").pop() : "no file");
    if (snapFile) {
      const snapHtml = readFileSync(snapFile, "utf8");
      check("Q41", snapHtml.includes("<!DOCTYPE NETSCAPE-Bookmark-file-1>") &&
        snapHtml.includes("Acme Corp"),
        "and it is a real bookmark file any browser can import");
    }

    // Delete, and the toggle.
    const beforeDelete = await B(`return document.querySelectorAll("#snapList .snap").length;`);
    await B(`
      const rows = [...document.querySelectorAll("#snapList .snap")];
      const named = rows.find((r) => r.querySelector(".snap__name")?.textContent === "QA renamed state");
      [...named.querySelectorAll("button")].find((b) => b.textContent === "Delete").click();
    `, { userGesture: true });
    await sleep(900);
    const afterDelete = await B(`return document.querySelectorAll("#snapList .snap").length;`);
    check("Q42", afterDelete === beforeDelete - 1, "deleting a backup removes exactly one row",
      `${beforeDelete} -> ${afterDelete}`);

    await B(`document.getElementById("autoToggle").click();`, { userGesture: true });
    await sleep(700);
    const offHint = await B(`return document.getElementById("autoHint").textContent;`);
    check("Q43", /off/i.test(offHint), "switching automatic backups off says so plainly",
      offHint.trim().slice(0, 70));
    const storedOff = await evaluate(cdp, sw, `(async () => {
      const g = await chrome.storage.local.get("secureshare.settings");
      return String(g["secureshare.settings"]?.autoBackup);
    })()`, { awaitPromise: true });
    check("Q44", storedOff === "false", "and it is actually stored", storedOff);

    // The popup's own switch is a second view over the same setting.
    await cdp.send("Target.activateTarget", { targetId: popup.targetId });
    await cdp.send("Page.reload", {}, popup.sessionId);
    await sleep(1200);
    await P(`document.getElementById("settings").open = true;
             document.getElementById("settings").dispatchEvent(new Event("toggle"));`);
    await sleep(900);
    const popupSwitch = await P(`return document.getElementById("autoBackupToggle").checked;`);
    check("Q45", popupSwitch === false,
      "the popup's switch reflects what the backup page just saved", String(popupSwitch));
    await P(`document.querySelector('label[for="autoBackupToggle"] .switch__track').click();`,
      { userGesture: true });
    await sleep(900);
    const storedOn = await evaluate(cdp, sw, `(async () => {
      const g = await chrome.storage.local.get("secureshare.settings");
      return String(g["secureshare.settings"]?.autoBackup);
    })()`, { awaitPromise: true });
    check("Q46", storedOn === "true", "and turning it back on from the popup saves too", storedOn);

    // Rendered, not just asserted. Two switches and a list of rows is exactly
    // the kind of thing that passes every behavioural check while sitting on
    // top of itself, so the run leaves a picture behind to look at.
    const shots = join(SCRATCH, "shots");
    mkdirSync(shots, { recursive: true });
    const shot = async (name, target, w, h, stage) => {
      await cdp.send("Emulation.setDeviceMetricsOverride",
        { width: w, height: h, deviceScaleFactor: 2, mobile: false }, target.sessionId);
      await sleep(400);
      // Anything the picture needs posed goes here, not before the call: the
      // override resizes the viewport, which drops :hover and invalidates every
      // coordinate measured against the old one.
      if (stage) await stage();
      const { data } = await cdp.send("Page.captureScreenshot",
        { format: "png", captureBeyondViewport: true }, target.sessionId);
      writeFileSync(join(shots, `${name}.png`), Buffer.from(data, "base64"));
      await cdp.send("Emulation.clearDeviceMetricsOverride", {}, target.sessionId);
    };
    await shot("popup-settings", popup, 360, 760);
    await cdp.send("Target.activateTarget", { targetId: backup.targetId });
    await B(`window.scrollTo(0, document.body.scrollHeight);`);
    // Posed with the pointer on the first row, so one picture carries both
    // states: the pencil on the row under the cursor, nothing on the others.
    await shot("backup-page", backup, 820, 1500, async () => {
      const row = JSON.parse(await B(`
        window.scrollTo(0, document.body.scrollHeight);
        const r = document.querySelector("#snapList .snap .snap__title").getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) });
      `));
      await cdp.send("Input.dispatchMouseEvent",
        { type: "mouseMoved", x: row.x, y: row.y, buttons: 0 }, backup.sessionId);
      await sleep(400);
    });
    // And the same list with one row mid-rename. A field that opens in place of
    // a title is precisely the layout that passes every behavioural check while
    // sitting on top of the date beneath it.
    await B(`document.querySelector("#snapList .snap .snap__title button.iconbtn").click();`,
      { userGesture: true });
    await shot("backup-page-renaming", backup, 820, 1500);
    await B(`
      const f = document.querySelector("#snapList .snap__rename .field");
      f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    `, { userGesture: true });
    console.log(`  screenshots             : ${shots}`);

    check("Q25", popupErr.length === 0, "popup logged no errors or warnings", popupErr.join(" | "));
    check("Q26", backupErr.length === 0, "backup page logged no errors or warnings", backupErr.join(" | "));

  } finally {
    console.log("\n" + "=".repeat(60));
    console.log(`  QA of new features: ${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
    console.log("=".repeat(60));
    cdp.close();
    if (!KEEP) { try { proc.kill("SIGTERM"); } catch {} try { execFileSync("/usr/bin/pkill", ["-f", `user-data-dir=${profile}`]); } catch {} }
    process.exit(failures === 0 ? 0 : 1);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
