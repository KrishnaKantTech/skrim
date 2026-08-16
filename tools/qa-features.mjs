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
