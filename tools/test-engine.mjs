// Engine test suite.
//
// Copies extension/src into a temp ESM package so the real engine runs
// unmodified against the mock. The headline test is the fault-injection sweep:
// for every N, fail the Nth chrome API call during a hide, then run recover()
// and assert the tree is byte-identical to where it started. That is the only
// way to actually prove "the service worker can die at any await" is survivable.

import { MockChrome } from "./mock-chrome.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "extension", "src");

// --- build a temp ESM copy so extension/ stays untouched -------------------
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "secureshare-test-"));
fs.writeFileSync(path.join(BUILD, "package.json"), JSON.stringify({ type: "module" }));
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(SRC, f), path.join(BUILD, f));
}
// The popup lives a directory up and is not a module the worker imports, but it
// makes two decisions that are not cosmetic -- see the P-* layer.
fs.copyFileSync(path.join(SRC, "..", "popup.js"), path.join(BUILD, "popup.js"));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) { pass++; }
  else { fail++; failures.push(`${name}${detail ? " — " + detail : ""}`); }
}

// The receipt encoder is pure and version-stable, so the tests exercise the
// real one rather than restating its format -- a copy would agree with itself
// while disagreeing with what is actually in a user's bookmarks.
const receiptMod = await import(`file://${path.join(BUILD, "receipt.js")}`);

// portable.js is pure -- no chrome, no DOM -- so the serialise/parse round trip
// is exercised against the real module the page ships, the same way the receipt
// codec is, rather than against a restatement of the format that would agree
// with itself while disagreeing with what lands in a user's file.
const portableMod = await import(`file://${path.join(BUILD, "portable.js")}`);

async function loadEngine(mock) {
  globalThis.chrome = mock.api;
  // Cache-bust so each test gets a fresh module instance (the engine holds a
  // module-scope promise chain).
  const url = `file://${path.join(BUILD, "engine.js")}?v=${Math.random()}`;
  return import(url);
}

/**
 * Loads the REAL service worker against the mock, sharing one engine instance
 * with the caller. sw.js imports "./engine.js" unversioned, so without
 * rewriting the specifier it would wire its listeners to a second engine module
 * with its own promise chain and its own self-mutation table -- and every
 * assertion about event handling would be measuring nothing.
 */
async function loadSw(mock) {
  globalThis.chrome = mock.api;
  const v = String(Math.random()).slice(2);
  // sessions.js imports the engine too, and holds a promise chain of its own,
  // so it gets the same treatment: a per-load copy pointed at the same
  // versioned engine. Without this the share messages would drive a second
  // engine module with its own chain and its own self-mutation table, and every
  // assertion about what a share does to the bar would be measuring nothing.
  const sessionsFile = `sessions-${v}.js`;
  fs.writeFileSync(
    path.join(BUILD, sessionsFile),
    fs
      .readFileSync(path.join(BUILD, "sessions.js"), "utf8")
      .replaceAll('"./engine.js"', `"./engine.js?v=${v}"`),
  );
  const src = fs
    .readFileSync(path.join(BUILD, "sw.js"), "utf8")
    .replaceAll('"./engine.js"', `"./engine.js?v=${v}"`)
    .replaceAll('"./sessions.js"', `"./${sessionsFile}"`);
  const file = path.join(BUILD, `sw-${v}.js`);
  fs.writeFileSync(file, src);
  const sw = await import(`file://${file}`);
  const engine = await import(`file://${path.join(BUILD, "engine.js")}?v=${v}`);
  const sessions = await import(`file://${path.join(BUILD, sessionsFile)}`);
  return { sw, engine, sessions };
}

/** Let queued event listeners run, then drain the engine's promise chain. */
async function flush(engine) {
  await new Promise((r) => setTimeout(r, 0));
  if (engine) await engine.status();
}

// The PRE-RENAME vault title, and it stays that way on purpose. Every seed
// below plants a vault this installation did not create, which is exactly the
// case the compat entry in `VAULT_TITLES` exists for -- so these tests are what
// proves the SecureShare -> Skrim rename did not strand folders already sitting
// in people's trees. Vaults the engine writes itself carry the current title,
// and `findVault` looks for that, so both ends of the list stay covered.
const VAULT_TITLE_LEGACY =
  "SecureShare — hidden while screen sharing (drag these back to your bookmarks bar)";

// Every vault also holds our recovery receipt -- the record that survives the
// extension being uninstalled. It is ours, not the user's, so a test that means
// "the bookmarks in the vault" has to say so; indexing children positionally
// would otherwise pick the receipt and quietly test nothing.
//
// Both marks, for the same reason `TITLE_MARKS` carries both: a receipt written
// before the rename is still a receipt, and a test that stopped seeing it would
// start counting it as one of the user's bookmarks.
const RECEIPT_MARKS_TEST = ["Skrim recovery", "SecureShare recovery"];

const isReceiptNode = (n) =>
  !!n &&
  typeof n.url === "string" &&
  RECEIPT_MARKS_TEST.some((m) => String(n.title).includes(m));

const vaultItems = (mock, vault) =>
  vault.children.filter((id) => !isReceiptNode(mock.nodes.get(id)));

const findVault = (mock) =>
  [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —") && !n.url);

const FIXTURE = [
  { title: "Work", children: [
    { title: "Docs", url: "https://d.example/1" },
    { title: "Deep", children: [
      { title: "Deeper", children: [{ title: "Leaf", url: "https://d.example/2" }] },
    ] },
  ] },
  { title: "Headlines", url: "https://n.example/" },
  { title: "Personal", children: [
    { title: "Project X", url: "https://x.example/" },
    { title: "Plans 2027", url: "https://p.example/" },
  ] },
  { title: "Reading", url: "https://r.example/" },
];

function build(opts = {}) {
  const mock = new MockChrome(opts);
  for (const spec of FIXTURE) mock.seed("1", spec);
  mock.seed("2", { title: "Existing other", url: "https://o.example/" });
  return mock;
}

// --------------------------------------------------------------------------

async function testRoundTrip(mode) {
  const mock = build({ sameParentIndexMode: mode });
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);

  const h = await engine.hide({ decoys: true });
  check(`[${mode}] hide ok`, h.ok === true, JSON.stringify(h));
  check(`[${mode}] bar has only decoys while hidden`,
    mock.nodes.get("1").children.length === 6,
    `got ${mock.nodes.get("1").children.length}`);

  const barTitles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check(`[${mode}] no real titles leak`,
    !barTitles.some((t) => ["Work", "Headlines", "Personal", "Reading"].includes(t)),
    barTitles.join(","));

  const r = await engine.restore();
  check(`[${mode}] restore ok`, r.ok === true, JSON.stringify(r));
  check(`[${mode}] tree byte-identical after round trip`,
    JSON.stringify(mock.snapshot("1")) === before);
  check(`[${mode}] no vault left behind`,
    ![...mock.nodes.values()].some((n) => n.title.startsWith("Skrim —")));
  check(`[${mode}] other-bookmarks untouched`,
    mock.nodes.get("2").children.length === 1);
}

async function testIdempotency() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);

  await engine.hide();
  const h2 = await engine.hide();
  check("double hide is a no-op", h2.alreadyHidden === true, JSON.stringify(h2));

  await engine.restore();
  const r2 = await engine.restore();
  check("double restore is safe", r2.ok === true, JSON.stringify(r2));
  check("tree intact after double hide/restore",
    JSON.stringify(mock.snapshot("1")) === before);
}

async function testNoDecoys() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  check("bar empty with decoys off", mock.nodes.get("1").children.length === 0);
  await engine.restore();
  check("tree intact (no decoys)", JSON.stringify(mock.snapshot("1")) === before);
}

async function testEmptyBar() {
  const mock = new MockChrome();
  const engine = await loadEngine(mock);
  const h = await engine.hide();
  check("empty bar hide is a no-op", h.ok === true && h.moved === 0, JSON.stringify(h));
  check("empty bar creates no vault",
    ![...mock.nodes.values()].some((n) => n.title.startsWith("Skrim —")));
}

async function testManaged() {
  const mock = build();
  const managed = mock.seed("1", { title: "Corp policy", url: "https://c.example/", unmodifiable: "managed" });
  const engine = await loadEngine(mock);
  const h = await engine.hide({ decoys: false });
  check("hide succeeds with managed bookmark present", h.ok === true, JSON.stringify(h));
  const left = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).id);
  check("managed bookmark stays on the bar", left.includes(managed.id), left.join(","));
  await engine.restore();
}

async function testLargeBar() {
  const mock = new MockChrome();
  for (let i = 0; i < 1000; i++) mock.seed("1", { title: `B${i}`, url: `https://e.example/${i}` });
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);
  const t0 = Date.now();
  await engine.hide({ decoys: false });
  const hideMs = Date.now() - t0;
  await engine.restore();
  check("1000-item bar round trips exactly",
    JSON.stringify(mock.snapshot("1")) === before);
  return hideMs;
}

async function testUserAddsWhileHidden() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  mock.seed("1", { title: "Added mid-share", url: "https://a.example/" });
  const r = await engine.restore();
  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("user-added bookmark survives restore", titles.includes("Added mid-share"), titles.join(","));
  check("original items all still present",
    ["Work", "Headlines", "Personal", "Reading"].every((t) => titles.includes(t)), titles.join(","));
  check("original relative order preserved",
    ["Work", "Headlines", "Personal", "Reading"]
      .map((t) => titles.indexOf(t))
      .every((v, i, a) => i === 0 || a[i - 1] < v),
    titles.join(","));
  check("restore reports honestly when tree changed under it",
    typeof r.ok === "boolean");
  void before;
}

async function testUserDeletesWhileHidden() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  const victim = vaultItems(mock, vault)[1];
  await mock.api.bookmarks.removeTree(victim);
  const r = await engine.restore();
  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("deleted item reported as missing", (r.missing ?? []).length === 1, JSON.stringify(r.missing));
  check("surviving items restored", titles.length === 3, titles.join(","));
}

async function testVaultDeletedWhileHidden() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  await mock.api.bookmarks.removeTree(vault.id);
  const r = await engine.restore();
  check("vault deletion does not throw", typeof r === "object");
  check("journal PRESERVED as evidence after a failed restore",
    (await mock.api.storage.local.get("secureshare.journal"))["secureshare.journal"] !== undefined,
    "journal was discarded — the only record of where those bookmarks belong");
}


// --- regressions for the review findings ----------------------------------

// #1 journal says HIDDEN but the user dragged everything back from the vault.
async function testDraggedBackThenHide() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  for (const kid of vaultItems(mock, vault)) {
    await mock.api.bookmarks.move(kid, { parentId: "1" });
  }
  check("#1 precondition: bar repopulated by user", mock.nodes.get("1").children.length === 4);

  const h = await engine.hide({ decoys: false });
  const barTitles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("#1 second hide actually hides after user drag-back",
    !barTitles.some((t) => ["Work", "Headlines", "Personal", "Reading"].includes(t)),
    `ok=${h.ok} alreadyHidden=${h.alreadyHidden} bar=[${barTitles}]`);
  await engine.restore();
}

// #3 one deleted item must not cascade into every later move.
async function testNoIndexCascade() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  await mock.api.bookmarks.removeTree(vaultItems(mock, vault)[0]);
  const r = await engine.restore();
  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("#3 survivors all restored despite a deletion", titles.length === 3, titles.join(","));
  check("#3 exactly one reported missing", (r.missing ?? []).length === 1, JSON.stringify(r.missing));
  check("#3 no bogus out-of-bounds failures", (r.stuck ?? []).length === 0, JSON.stringify(r.stuck));
  check("#3 order preserved among survivors",
    titles.join(",") === "Headlines,Personal,Reading", titles.join(","));
}

// #3b vault destroyed mid-hide must NOT report ok:true.
async function testVaultNukedReportsFailure() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  await mock.api.bookmarks.removeTree(vault.id);
  const r = await engine.restore();
  check("#3b total loss is NOT reported as success", r.ok === false,
    JSON.stringify({ ok: r.ok, missing: r.missing?.length, restored: r.restored }));
}

// #7 an extension auto-update must not un-hide a live share.
async function testRecoverKeepsHealthyHide() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const r = await engine.recover({ maxHiddenMs: 4 * 60 * 60 * 1000 });
  check("#7 recover() leaves a healthy hide alone",
    r.recovered === false && mock.nodes.get("1").children.length === 0,
    JSON.stringify(r));
  const forced = await engine.recover({ maxHiddenMs: 0 });
  check("#7 forced recover still restores", forced.recovered === true &&
    mock.nodes.get("1").children.length === 4, JSON.stringify(forced));
}

// #8 a policy-managed bookmark must keep its position.
async function testManagedPositionPreserved() {
  const mock = new MockChrome();
  mock.seed("1", { title: "Corp", url: "https://c.example/", unmodifiable: "managed" });
  for (const s of FIXTURE) mock.seed("1", s);
  const before = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(",");
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  await engine.restore();
  const after = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(",");
  check("#8 managed bookmark keeps its original position", before === after,
    `before=[${before}] after=[${after}]`);
}

// S1 a synced peer's vault must never be swept.
async function testForeignVaultUntouched() {
  const mock = build();
  const engine = await loadEngine(mock);
  const foreign = mock.seed("2", { title: VAULT_TITLE_LEGACY, children: [
    { title: "Peer bookmark", url: "https://peer.example/" },
  ] }, Date.now()); // live hide on a synced peer, seconds old
  await engine.restore(); // no journal -> pure sweep path
  check("S1 peer's vault is not adopted", mock.nodes.has(foreign.id), "vault deleted");
  check("S1 peer's bookmarks stay in their vault",
    mock.nodes.get(foreign.id)?.children.length === 1);
  check("S1 our bar was not polluted", mock.nodes.get("1").children.length === 4);
}

// #2 an unreadable vault must never be recursively deleted.
async function testUnreadableVaultNotDeleted() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  const realGetSubTree = mock.api.bookmarks.getSubTree;
  mock.api.bookmarks.getSubTree = async (id) => {
    if (id === vault.id) throw new Error("simulated read failure");
    return realGetSubTree.call(mock.api.bookmarks, id);
  };
  await engine.restore().catch(() => {});
  mock.api.bookmarks.getSubTree = realGetSubTree;
  check("#2 unreadable vault survives instead of being recursively deleted",
    mock.nodes.has(vault.id),
    mock.nodes.has(vault.id) ? "survived" : "DELETED — data loss path open");
}


// R2-1 a bar that cannot be paired must fail the hide, not silently leak.
async function testUnpairableBarFailsHide() {
  const mock = build();
  mock._mk("9", "0", "Account bookmarks bar", { folderType: "bookmarks-bar", syncing: false });
  mock.seed("9", { title: "CONFIDENTIAL M&A", url: "https://ma.example/" });
  const engine = await loadEngine(mock);
  const h = await engine.hide({ decoys: false });
  check("R2-1 unpairable bar fails the hide", h.ok === false && h.skippedBars === 1,
    JSON.stringify(h));
  check("R2-1 nothing was moved on the refused hide",
    mock.nodes.get("1").children.length === 4, "bar was mutated anyway");
}

// R2-2 a user's own bookmark that looks like a decoy must survive.
async function testRealGoogleBookmarkSurvives() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const real = mock.seed("1", { title: "Google", url: "https://www.google.com/" }, Date.now());
  await engine.restore();
  check("R2-2 user's real google.com bookmark is not deleted",
    mock.nodes.has(real.id), "SILENTLY DELETED by the shape sweep");
}

// R2-3 shape matching must not excuse a real bookmark from verification.
async function testDecoyShapeDoesNotBlindVerification() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  await engine.restore();
  // User's own bookmark, identical in shape to a decoy.
  for (const kid of [...mock.nodes.get("1").children]) await mock.api.bookmarks.removeTree(kid);
  mock.seed("1", { title: "Maps", url: "https://maps.google.com/" }, Date.now());
  await mock.api.storage.local.set({ "secureshare.journal": {
    v: 1, state: "hidden", startedAt: Date.now() - 1000, updatedAt: Date.now() - 1000,
    groups: [{ barId: "1", otherId: "2", vaultId: "999", syncing: true, items: [], decoyIds: [], decoyPhase: false }],
  } });
  const h = await engine.hide({ decoys: false });
  check("R2-3 real 'Maps' bookmark is not mistaken for a decoy",
    h.alreadyHidden !== true, JSON.stringify(h));
}

// R2-4 a hopeless restore must give up rather than loop forever.
async function testRestoreGivesUp() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  await mock.api.bookmarks.removeTree(vault.id);
  let last;
  for (let i = 0; i < 6; i++) {
    last = await engine.restore();
    if (last.gaveUp) break;
  }
  check("R2-4 hopeless restore eventually gives up", last.gaveUp === true, JSON.stringify(last));
  const j = (await mock.api.storage.local.get("secureshare.journal"))["secureshare.journal"];
  check("R2-4 journal cleared once it gave up", j === undefined);
  const lf = await engine.lastFailure();
  check("R2-4 failure is recorded for the user", lf !== null && lf.missing.length === 4,
    JSON.stringify(lf));
}

// R3-4 a reinstall wipes storage.local but not the bookmarks. The orphan vault
// must be REPORTED, never auto-adopted -- age cannot distinguish it from a
// synced peer's live hide -- and explicit adoption must then restore it.
async function testReinstallReportsOrphanAndAdoptsOnRequest() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  // Simulate uninstall/reinstall: bookmarks survive, extension storage does not.
  mock.storage.clear();
  mock.nodes.get(vault.id).dateAdded = Date.now() - 7 * 60 * 60 * 1000;

  const r = await engine.recover({ maxHiddenMs: 0 });
  check("R3-4 old orphan is NOT auto-adopted",
    mock.nodes.get("1").children.length === 0,
    `bar=${mock.nodes.get("1").children.length} — adopted without being asked`);
  check("R3-4 orphan is reported for the user to decide",
    (r.swept?.pendingAdoption ?? []).some((p) => p.id === vault.id && p.count === 4),
    JSON.stringify(r.swept));
  check("R3-4 status surfaces it too",
    (await engine.status()).pendingAdoption.length === 1);

  const a = await engine.adoptVault(vault.id);
  check("R3-4 explicit adoption restores the bar",
    a.ok === true && mock.nodes.get("1").children.length === 4,
    JSON.stringify(a));
  check("R3-4 the emptied vault is then removed", !mock.nodes.has(vault.id));
}

// R3-4b adopting must refuse anything that is not one of our vault folders.
async function testAdoptRejectsNonVault() {
  const mock = build();
  const engine = await loadEngine(mock);
  const victim = mock.nodes.get("1").children[0];
  const a = await engine.adoptVault(victim);
  check("R3-4b adoptVault refuses a normal bookmark folder", a.ok === false, JSON.stringify(a));
  check("R3-4b and does not touch it", mock.nodes.has(victim));
}

// R3-1 a decoy that cannot be removed must not fail the restore, must not cost
// the journal, and must still get cleaned up eventually.
async function testStrayDecoyClearedWithoutFailingRestore() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: true });

  // One decoy refuses to be removed for the whole of the first restore.
  const journalNow = mock.storage.get("secureshare.journal");
  const stubborn = journalNow.groups[0].decoyIds[2];
  const realRemove = mock.api.bookmarks.removeTree;
  let block = true;
  mock.api.bookmarks.removeTree = async (id) => {
    if (block && id === stubborn) throw new Error("simulated removal failure");
    return realRemove.call(mock.api.bookmarks, id);
  };

  const r = await engine.restore();
  check("R3-1 a stuck decoy does not fail the restore", r.ok === true, JSON.stringify(r));
  check("R3-1 the real bookmarks are back", mock.nodes.get("1").children.length === 5);
  check("R3-1 journal was cleared, not held hostage by a fake bookmark",
    mock.storage.get("secureshare.journal") === undefined);
  check("R3-1 the stray is tracked outside the journal",
    (mock.storage.get("secureshare.strayDecoys") ?? []).includes(stubborn),
    JSON.stringify(mock.storage.get("secureshare.strayDecoys")));

  // The watchdog finishes the job once the removal works again.
  block = false;
  await engine.sweepStrayDecoys();
  mock.api.bookmarks.removeTree = realRemove;
  check("R3-1 stray decoy is eventually cleaned up",
    JSON.stringify(mock.snapshot("1")) === before,
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
}

// R3-1b a stray that outlives the sweep must not be vaulted by the next hide
// and handed back to the user as a real bookmark.
async function testStrayDecoyNotAdoptedByNextHide() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const stubborn = mock.storage.get("secureshare.journal").groups[0].decoyIds[2];
  const realRemove = mock.api.bookmarks.removeTree;
  let block = true;
  mock.api.bookmarks.removeTree = async (id) => {
    if (block && id === stubborn) throw new Error("simulated removal failure");
    return realRemove.call(mock.api.bookmarks, id);
  };
  await engine.restore();
  block = false;
  await engine.hide({ decoys: false }); // drains strays before it plans
  await engine.restore();
  mock.api.bookmarks.removeTree = realRemove;
  check("R3-1b next hide/restore cycle does not promote a decoy to a real bookmark",
    JSON.stringify(mock.snapshot("1")) === before,
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
}

// R3-3 one deleted bookmark must not fail every subsequent restore, nor block
// the next two meetings through the reconcile-before-hide gate.
async function testDeletionDoesNotExposeTheBar() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = [...mock.nodes.values()].find((n) => n.title.startsWith("Skrim —"));
  await mock.api.bookmarks.removeTree(vaultItems(mock, vault)[1]); // user deletes one
  const r = await engine.restore();
  check("R3-3 restore with one deleted item reports ok", r.ok === true, JSON.stringify(r));
  check("R3-3 it is still reported as missing", (r.missing ?? []).length === 1);

  for (let meeting = 2; meeting <= 4; meeting++) {
    const h = await engine.hide({ decoys: false });
    const bar = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
    check(`R3-3 meeting ${meeting} still hides the bar`,
      h.ok === true && bar.length === 0,
      `ok=${h.ok} err=${h.error} bar=[${bar}]`);
    await engine.restore();
  }
}

// R3-6 the decoy journal must store the loop INDEX, not a count of successes.
// They agree until one create throws, and the crash sweep then hunts for the
// wrong decoy spec -- stranding a real fake bookmark on the bar forever.
//
// The generic fault injector cannot reach this: it fails exactly one call, and
// this needs a caught create failure AND a later crash in the same loop.
async function testDecoyJournalUsesIndexNotCount() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const engine = await loadEngine(mock);

  const realCreate = mock.api.bookmarks.create;
  const realSet = mock.api.storage.local.set;
  let killNextWrite = false;

  mock.api.bookmarks.create = async (props) => {
    if (props.title === "Calendar") throw new Error("simulated create failure");
    const node = await realCreate.call(mock.api.bookmarks, props);
    // "Maps" exists now; kill the worker before its id can be journalled.
    if (props.title === "Maps") killNextWrite = true;
    return node;
  };
  mock.api.storage.local.set = async (obj) => {
    if (killNextWrite) {
      killNextWrite = false;
      throw new Error("worker terminated");
    }
    return realSet.call(mock.api.storage.local, obj);
  };

  await engine.hide({ decoys: true }).catch(() => {});
  mock.api.bookmarks.create = realCreate;
  mock.api.storage.local.set = realSet;

  const j = mock.storage.get("secureshare.journal");
  check("R3-6 precondition: one decoy created but never journalled",
    mock.nodes.get("1").children.some((c) => mock.nodes.get(c).title === "Maps") &&
    !(j?.groups?.[0]?.decoyIds ?? []).some((id) => mock.nodes.get(id)?.title === "Maps"));

  await engine.recover({ maxHiddenMs: 0 }).catch(() => {});
  await engine.recover({ maxHiddenMs: 0 }).catch(() => {});

  check("R3-6 a failed create does not strand the next decoy",
    JSON.stringify(mock.snapshot("1")) === before,
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
}

// --- service worker: never executed by a test until round 3 ---------------

// SW-1 Chrome reports our OWN mutations back to us. Serialised markDirty reads
// them after the chain drains, when the state is already HIDDEN -- so without
// id attribution every clean hide marks itself dirty.
async function testOwnEventsDoNotMarkDirty() {
  const mock = build();
  const { engine } = await loadSw(mock);

  check("SW wires the three structural bookmark events",
    mock._listeners.onCreated.length === 1 &&
    mock._listeners.onRemoved.length === 1 &&
    mock._listeners.onMoved.length === 1);
  check("SW does not wire onChanged — a rename moves nothing",
    mock._listeners.onChanged.length === 0);

  const h = await engine.hide({ decoys: true });
  await flush(engine);
  const j = mock.storage.get("secureshare.journal");
  check("SW-1 our own hide events do not mark the journal dirty",
    h.ok === true && j.dirty !== true,
    `dirty=${j?.dirty} reason=${j?.dirtyReason}`);
  check("SW-1 events really were delivered (else this proves nothing)",
    mock.events.length > 0, `${mock.events.length} events`);
}

// SW-2 the reordering the false-positive dirty flag actually caused.
async function testManagedPositionPreservedWithEventsLive() {
  const mock = new MockChrome();
  mock.seed("1", { title: "A", url: "https://a.example/" });
  mock.seed("1", { title: "Corp", url: "https://c.example/", unmodifiable: "managed" });
  mock.seed("1", { title: "Bee", url: "https://b.example/" });
  const before = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(",");
  const { engine } = await loadSw(mock);

  await engine.hide({ decoys: false });
  await flush(engine);
  await engine.restore();
  const after = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(",");
  check("SW-2 managed bookmark keeps its position with events live",
    before === after, `before=[${before}] after=[${after}]`);
}

// SW-3 attribution must not suppress everything: a real external change still
// has to reach the journal, and an irrelevant one still has to be ignored.
async function testExternalChangeStillMarksDirty() {
  const mock = build();
  const { engine } = await loadSw(mock);
  await engine.hide({ decoys: false });
  await flush(engine);

  await mock.api.bookmarks.create({ parentId: "2", title: "Saved elsewhere", url: "https://e.example/" });
  await flush(engine);
  check("SW-3 a change outside the bar does not stale an index",
    mock.storage.get("secureshare.journal").dirty !== true,
    JSON.stringify(mock.storage.get("secureshare.journal").dirtyReason));

  await mock.api.bookmarks.create({ parentId: "1", title: "Mid-meeting", url: "https://m.example/" });
  await flush(engine);
  check("SW-3 a change ON the bar does mark it dirty",
    mock.storage.get("secureshare.journal").dirty === true,
    JSON.stringify(mock.storage.get("secureshare.journal")));

  const r = await engine.restore();
  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("SW-3 the append path preserves journalled relative order",
    r.ok === true && titles.join(",").includes("Work,Headlines,Personal,Reading"),
    titles.join(","));
}

// SW-4 calling alarms.create() unconditionally resets the period and can starve
// the alarm forever. The guard was untestable while the mock ignored the key.
async function testWatchdogArmedOnce() {
  const mock = build();
  await loadSw(mock);
  await flush();
  check("SW-4 watchdog alarm armed on first wake", mock.alarmCreates === 1,
    `${mock.alarmCreates} creates`);

  await loadSw(mock); // a second worker wake with the alarm still present
  await flush();
  check("SW-4 an existing alarm is not re-created", mock.alarmCreates === 1,
    `${mock.alarmCreates} creates — period reset on every wake`);
}

// SW-5 the alarm handler is the only thing that finishes cosmetic cleanup, and
// the badge is the only channel that reaches a user not looking at the popup.
async function testWatchdogSweepsAndBadges() {
  const mock = build();
  const { engine } = await loadSw(mock);
  const foreign = mock.seed("2", { title: VAULT_TITLE_LEGACY, children: [
    { title: "Peer bookmark", url: "https://peer.example/" },
  ] }, Date.now());
  await flush(engine);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  // Three rules on one code path, and the differences are the point.
  //
  // This first vault has no receipt, so nothing proves whose it is. It could be
  // a peer's, or it could be OURS from before receipts existed -- and muting the
  // only notice a user gets that their own bookmarks are parked is the more
  // expensive mistake. Not knowing stays loud.
  check("SW-5 a vault with no receipt badges as a fault, because it might be ours",
    mock.badge.text === "!" && mock.badge.color === "#FFB020",
    `badge=${JSON.stringify(mock.badge)}`);
  check("SW-5 and still does not adopt it", mock.nodes.get(foreign.id)?.children.length === 1);

  // A vault whose receipt names a vault id that is not this folder's IS
  // provably another machine's live hide. That is not a fault -- it is this
  // computer's half of a share running elsewhere, and it undoes itself when
  // that share ends. Red would send the user hunting for a problem and hurry
  // them into the one action that harms: restoring here puts the other
  // machine's bookmarks back onto the bar it is presenting from.
  const peer = build();
  const { engine: e2 } = await loadSw(peer);
  const theirs = peer.seed("2", { title: VAULT_TITLE_LEGACY }, Date.now());
  peer.seed(theirs.id, {
    title: "⚠️ SecureShare recovery — your 1 bookmark is IN THIS FOLDER.",
    url: receiptMod.buildUrl(
      receiptMod.buildPayload({
        barId: "1", otherId: "2", vaultId: "99999", // their id, not this folder's
        items: [{ id: "777", index: 0 }],
      }),
      "https://example.invalid/r",
    ),
  });
  peer.seed(theirs.id, { title: "Their bookmark", url: "https://peer.example/" });
  await flush(e2);
  await peer._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(e2);
  check("SW-5 a provable peer hide badges quietly instead",
    peer.badge.text === "•" && peer.badge.color === "#17DE82",
    `badge=${JSON.stringify(peer.badge)}`);

  // Our OWN vault, left behind by a reinstall: nothing but the user can finish
  // it, and nothing else will ask.
  const mine = build();
  const { engine: e3 } = await loadSw(mine);
  await e3.hide({ decoys: false });
  mine.storage.clear(); // uninstall: the bookmarks survive, the journal does not
  await flush(e3);
  await mine._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(e3);
  check("SW-5 our own vault from a reinstall still badges as a fault",
    mine.badge.text === "!" && mine.badge.color === "#FFB020",
    `badge=${JSON.stringify(mine.badge)}`);
}

// --------------------------------------------------------------------------
// P-*  the popup, driven by the worker's real reply shapes. Most of it is
//      cosmetic and untested on purpose; these two decisions are not. One
//      chooses whether to tell a user that hiding reaches their other devices,
//      and the other decides what to say to a machine whose bar was emptied BY
//      one -- where the obvious-looking action is the harmful one.
// --------------------------------------------------------------------------

/**
 * Just enough DOM for popup.js. Ids auto-vivify, so the test states what it
 * cares about rather than restating popup.html; visibilityState is "hidden" so
 * poll() never starts an interval the suite would then have to chase.
 *
 * `body.classList` and requestAnimationFrame are here because the popup drops
 * its `booting` class on the frame after the first render -- opening the popup
 * is not a state change, so the first paint has to land without replaying the
 * scrim animation. Running the callback synchronously is the right shape for a
 * suite that then asserts on the settled render.
 */
function fakeDom() {
  const els = new Map();
  const el = (id) => {
    if (!els.has(id)) {
      els.set(id, {
        id, textContent: "", hidden: false, className: "", disabled: false,
        dataset: {}, onclick: null,
      });
    }
    return els.get(id);
  };
  const classes = new Set(["booting"]);
  globalThis.document = {
    getElementById: el,
    addEventListener() {},
    visibilityState: "hidden",
    body: {
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
      },
    },
  };
  globalThis.requestAnimationFrame = (fn) => {
    fn();
    return 0;
  };
  return el;
}

/** What Chrome hands back from `getManifest()` for a store install: it injects
 *  `update_url`, and omits it for a copy loaded unpacked. */
const STORE_MANIFEST = { update_url: "https://clients2.google.com/service/update2/crx" };
const UNPACKED_MANIFEST = {};

/**
 * Load a fresh popup.js against one set of worker replies and let it render.
 *
 * The manifest defaults to a STORE install, so every fixture below asserts on
 * what a real user gets rather than on what a developer sees. Passing `null`
 * omits `getManifest` outright -- the third case, a Chrome that will not answer.
 */
async function renderPopup(fixture, manifest = STORE_MANIFEST) {
  const el = fakeDom();
  const runtime = {
    // `in`, not `??`: a lastFailure of null is a real answer meaning "nothing
    // failed", and coalescing it to a stub would test the wrong branch.
    sendMessage: async (m) => (m.type in fixture ? fixture[m.type] : { ok: true }),
  };
  if (manifest) runtime.getManifest = () => manifest;
  globalThis.chrome = { runtime, tabs: { create: async () => {} } };
  await import(fresh("popup.js"));
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  return el;
}

// P-1 the sync warning is the honest half of the "hiding syncs" problem, and it
// is only honest where it is true. A profile whose bar does not sync has no
// other devices to lose, and warning it about them is a scare with no referent.
async function testPopupWarnsAboutSyncOnlyWhenTheBarSyncs() {
  const hidden = (syncing) => ({
    status: {
      hidden: true, state: "hidden", since: Date.now() - 60_000, dirty: false,
      itemsDisplaced: 12, ownedVaults: 1, pendingAdoption: [], skippedBars: 0,
      bars: [{ barId: "1", syncing, children: 0 }],
    },
    shares: { sharing: 1, frames: [{ frame: "42:0", sessions: 1, quietMs: 100 }] },
    lastFailure: null,
  });

  check("P-1 a synced bar is told the hide reaches its other devices",
    (await renderPopup(hidden(true)))("syncNote").hidden === false);
  check("P-1 a bar that does not sync is not warned about devices it has none of",
    (await renderPopup(hidden(false)))("syncNote").hidden === true);
  // Older Chrome does not report the flag. Silence would be the surprise this
  // note exists to prevent, so unknown says it.
  check("P-1 a Chrome that will not say still gets the warning",
    (await renderPopup(hidden(null)))("syncNote").hidden === false);
}

// P-2 the peer device -- the machine that did nothing, and whose bar went empty
// anyway. This is where the "hiding syncs" complaint is actually felt, and the
// card here used to make the user deduce it from "this folder was not created
// by this installation" while offering, as its primary button, the one action
// that puts the OTHER machine's bookmarks onto its live call.
async function testPopupExplainsAPeerHideInsteadOfOfferingRecovery() {
  const withVault = (local, hasReceipt = true) => ({
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      ownedVaults: 0, skippedBars: 0,
      pendingAdoption: [
        { id: "88", count: 12, hidAt: Date.now() - 300_000, local, receipt: hasReceipt },
      ],
      bars: [{ barId: "1", syncing: true, children: 6 }],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: null,
  });

  const peer = await renderPopup(withVault(false));
  check("P-2 a peer's live hide leads with what happened, not with a fault",
    peer("adopt").dataset.origin === "peer" &&
      peer("adoptHead").textContent === "Hidden by another device",
    `${peer("adopt").dataset.origin} / ${peer("adoptHead").textContent}`);
  check("P-2 and says the bar returns without the user doing anything",
    /comes back on its own/.test(peer("adoptOrigin").textContent),
    peer("adoptOrigin").textContent);
  check("P-2 the button that would expose the other machine is demoted and caveated",
    peer("adoptBtn").className.includes("btn--quiet") && peer("adoptCaveat").hidden === false,
    `${peer("adoptBtn").className} / caveat hidden=${peer("adoptCaveat").hidden}`);

  const mine = await renderPopup(withVault(true));
  check("P-2 our own vault from a reinstall keeps the confident offer",
    mine("adopt").dataset.origin === "mine" &&
      !mine("adoptBtn").className.includes("btn--quiet") &&
      mine("adoptCaveat").hidden === true,
    `${mine("adopt").dataset.origin} / ${mine("adoptBtn").className}`);
  check("P-2 and is still explained as a reinstall",
    /reinstall/.test(mine("adoptOrigin").textContent), mine("adoptOrigin").textContent);

  // A vault with no receipt at all is NOT a peer's -- it could equally be ours
  // from before receipts existed, or one whose receipt the user deleted. Saying
  // "another device is screen sharing" there would be a confident lie, so this
  // keeps the older, vaguer wording while staying cautious about the button.
  const unknown = await renderPopup(withVault(false, false));
  check("P-2 a vault with no receipt is not claimed to be another device's",
    unknown("adopt").dataset.origin === "unknown" &&
      !/comes back on its own/.test(unknown("adoptOrigin").textContent),
    `${unknown("adopt").dataset.origin} / ${unknown("adoptOrigin").textContent}`);
  check("P-2 but not knowing is still a reason for the demoted button",
    unknown("adoptBtn").className.includes("btn--quiet") &&
      unknown("adoptCaveat").hidden === false);

  // P-2b every string in this card is assembled around a count, so one hidden
  // bookmark used to produce "1 bookmark are sitting in a Skrim folder". It is
  // a small thing that lands at the worst moment there is -- the user is
  // already looking at an empty bar wondering what happened to their data.
  const oneOf = (local) => {
    const s = withVault(local);
    s.status.pendingAdoption[0].count = 1;
    return s;
  };
  const singularMine = await renderPopup(oneOf(true));
  check("P-2b one hidden bookmark reads as one bookmark",
    singularMine("adoptDetail").textContent.startsWith("1 bookmark is sitting"),
    singularMine("adoptDetail").textContent);
  check("P-2b and the sentence after it agrees too",
    /It can go back exactly where it was\./.test(singularMine("adoptOrigin").textContent),
    singularMine("adoptOrigin").textContent);

  const singularPeer = await renderPopup(oneOf(false));
  check("P-2b the peer wording agrees as well",
    singularPeer("adoptDetail").textContent.startsWith("1 bookmark was moved"),
    singularPeer("adoptDetail").textContent);

  check("P-2b while a dozen still reads as a dozen",
    peer("adoptDetail").textContent.startsWith("12 bookmarks were moved") &&
      mine("adoptDetail").textContent.startsWith("12 bookmarks are sitting"),
    `${peer("adoptDetail").textContent} / ${mine("adoptDetail").textContent}`);

  // A folder that would not read back reports no count at all. "Bookmarks" is
  // plural, so nothing here may quietly switch it to the singular verb.
  const noCount = withVault(true);
  noCount.status.pendingAdoption[0].count = null;
  const vague = await renderPopup(noCount);
  check("P-2b an unreadable folder stays plural rather than inventing a number",
    vague("adoptDetail").textContent.startsWith("Bookmarks are sitting"),
    vague("adoptDetail").textContent);
}

// P-3 the developer disclosure. It carries a no-decoy hide, a forced recover and
// the raw worker reply -- a debugging surface, and until now nothing stopped it
// shipping to every installed user, one click from a Force restore they have no
// way to read. Gated rather than deleted: the manual stage-2 walk drives hide
// and restore by hand from exactly these buttons.
async function testDeveloperControlsShipToNobody() {
  const atRest = {
    status: {
      hidden: false, state: "clear", since: null, dirty: false, itemsDisplaced: 0,
      ownedVaults: 0, pendingAdoption: [], skippedBars: 0,
      bars: [{ barId: "1", syncing: true, children: 6 }],
    },
    shares: { sharing: 0, frames: [] },
    lastFailure: null,
  };
  const DEV_IDS = ["hide", "hideNoDecoy", "restore", "forceRestore", "copyOut"];

  const shipped = await renderPopup(atRest);
  check("P-3 an installed copy never shows the developer disclosure",
    shipped("dev").hidden === true, `hidden=${shipped("dev").hidden}`);
  // Hiding is for the eye; the unwired handler is what removes the path. A
  // shipped popup should have no way to reach recover() at all -- not by
  // keyboard, not by unsetting `hidden` from devtools.
  check("P-3 and does not even wire them, so there is no path to recover()",
    DEV_IDS.every((id) => shipped(id).onclick === null),
    DEV_IDS.filter((id) => shipped(id).onclick !== null).join(","));
  // The product half of the popup is untouched by the gate.
  check("P-3 the gate does not touch the button the user actually came for",
    typeof shipped("primary").onclick === "function");

  const unpacked = await renderPopup(atRest, UNPACKED_MANIFEST);
  check("P-3 an unpacked copy keeps the controls the manual walk depends on",
    unpacked("dev").hidden === false &&
      DEV_IDS.every((id) => typeof unpacked(id).onclick === "function"),
    `hidden=${unpacked("dev").hidden}`);

  // A Chrome that will not answer must read as shipped. The two ways of being
  // wrong do not cost the same: one costs a developer their debug panel, the
  // other puts Force restore in a stranger's popup.
  const unknown = await renderPopup(atRest, null);
  check("P-3 a manifest that will not read fails closed, not open",
    unknown("dev").hidden === true &&
      DEV_IDS.every((id) => unknown(id).onclick === null));
}

// M3 fault injection across the RESTORE phase, which was never covered.
async function testFaultInjectionRestore(maxCalls = 60) {
  let repaired = 0, broken = 0;
  const brokenAt = [];
  for (let n = 1; n <= maxCalls; n++) {
    const mock = build();
    const before = JSON.stringify(mock.snapshot("1"));
    const engine = await loadEngine(mock);
    await engine.hide({ decoys: true });
    mock.calls = 0;
    mock.failed = false;
    mock.failAt = n;
    try { await engine.restore(); } catch { /* expected */ }
    if (!mock.failed) break;
    mock.failAt = null;
    try { await engine.recover({ maxHiddenMs: 0 }); } catch {}
    try { await engine.recover({ maxHiddenMs: 0 }); } catch {}
    const after = JSON.stringify(mock.snapshot("1"));
    if (after === before) repaired++; else { broken++; brokenAt.push(n); }
  }
  return { repaired, broken, brokenAt };
}

// --------------------------------------------------------------------------
// M2 -- the getDisplayMedia hook.
//
// Three layers, tested separately because they fail separately:
//   H-*  the MAIN-world hook, against a fake MediaDevices. This is where the
//        privacy-critical timing lives: the session must be announced when
//        getDisplayMedia is CALLED, not when it resolves.
//   B-*  the isolated-world bridge, against a fake window.
//   E-*  hook -> window -> bridge -> worker -> engine -> bookmarks, unbroken.
//   S-*  session arbitration for the cases a single frame cannot produce:
//        a second tab, a closed tab, a worker that was terminated mid-share.
// --------------------------------------------------------------------------

/**
 * A page's `window`, minus everything the hook and bridge do not touch.
 * postMessage delivery is a task in the browser, so it is queued here too --
 * the hook must not depend on its own message having been handled.
 */
function fakeWindow({ ack = true } = {}) {
  const listeners = new Map();
  const w = {
    posted: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event) {
      for (const f of [...(listeners.get(type) ?? [])]) f(event);
    },
    postMessage(data) {
      w.posted.push(data);
      queueMicrotask(() => {
        w.dispatch("message", { data, source: w });
        // Stands in for the bridge, which answers a `start` once the worker has
        // finished hiding. Inbound, so deliberately not recorded in `posted`.
        // `ack: false` is a worker that never answers at all.
        if (ack && data?.kind === "start") {
          const reply = { ns: data.ns, v: data.v, kind: "hidden", sid: data.sid };
          queueMicrotask(() => w.dispatch("message", { data: reply, source: w }));
        }
      });
    },
    of(kind) {
      return w.posted.filter((m) => m.kind === kind);
    },
  };
  return w;
}

class FakeTrack {
  // Defaults to a whole-screen capture: the case that MUST stay hidden, so a
  // test that forgets to say what it is sharing gets the conservative answer.
  constructor(kind = "video", surface = "monitor") {
    this.kind = kind;
    this.readyState = "live";
    this.surface = surface;
    this._ended = [];
    this._config = [];
  }
  addEventListener(type, fn) {
    if (type === "ended") this._ended.push(fn);
    if (type === "configurationchange") this._config.push(fn);
  }
  /** `surface: null` stands in for a Chrome that does not report the key. */
  getSettings() {
    return this.surface === null ? {} : { displaySurface: this.surface };
  }
  /** Chrome's "Share this tab instead": the surface changes under a live track. */
  reconfigure(surface) {
    this.surface = surface;
    for (const f of this._config) f();
  }
  /** Spec: stop() does NOT fire `ended`. The hook has to notice by itself. */
  stop() {
    this.readyState = "ended";
  }
  /** Chrome's own "Stop sharing" button: readyState flips AND `ended` fires. */
  stopSharing() {
    this.readyState = "ended";
    for (const f of this._ended) f();
  }
}

function fakeStream(tracks) {
  return { getVideoTracks: () => tracks.filter((t) => t.kind === "video") };
}

/** getDisplayMedia as a real class method, so name/length are meaningful. */
function fakeMediaDevices(behaviour) {
  return class MediaDevices {
    getDisplayMedia(constraints) {
      return behaviour(constraints);
    }
  };
}

/** Hand control of the hook's beat to the test. */
function fakeTimers() {
  const timers = new Map();
  let next = 1;
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn) => {
    const id = next++;
    timers.set(id, fn);
    return id;
  };
  globalThis.clearInterval = (id) => timers.delete(id);
  return {
    tick: () => { for (const fn of [...timers.values()]) fn(); },
    running: () => timers.size,
    restore: () => {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    },
  };
}

const fresh = (f) => `file://${path.join(BUILD, f)}?v=${Math.random()}`;

async function loadHook(MD, win) {
  globalThis.window = win;
  globalThis.MediaDevices = MD;
  await import(fresh("hook.js"));
  return Object.create(MD.prototype); // stands in for navigator.mediaDevices
}

async function loadBridge(win) {
  globalThis.window = win;
  await import(fresh("bridge.js"));
}

// H-1 the whole milestone in one assertion. Chrome's picker previews every
// window BEFORE the user chooses one, and the first frames go out the instant
// they click Share -- so a hide that waits for the promise has already lost.
async function testHookAnnouncesBeforeThePickerResolves() {
  const win = fakeWindow();
  let settle;
  const MD = fakeMediaDevices(() => new Promise((res, rej) => { settle = { res, rej }; }));
  const md = await loadHook(MD, win);

  const p = md.getDisplayMedia({ video: true });
  // Deliberately no await: the announcement must already have happened.
  check("H-1 session announced synchronously, before the picker resolves",
    win.posted.length === 1 && win.posted[0].kind === "start",
    JSON.stringify(win.posted));
  check("H-1 announcement is namespaced and versioned",
    win.posted[0]?.ns === "secureshare" && win.posted[0]?.v === 1);
  check("H-1 carries a session id", typeof win.posted[0]?.sid === "string" && win.posted[0].sid);

  check("H-1 the real getDisplayMedia has NOT been called yet", settle === undefined);
  await flush();
  check("H-1 it is called once the bar is reported down", settle !== undefined);

  settle.res(fakeStream([new FakeTrack()]));
  await p;
  check("H-1 no end while the share is live", win.of("end").length === 0);
}

// H-2 a cancelled picker rejects. Being early costs a hide/restore cycle only
// if this path releases the session -- otherwise it costs the user their bar.
async function testHookReleasesOnCancelledPicker() {
  const win = fakeWindow();
  const MD = fakeMediaDevices(() => Promise.reject(new Error("Permission denied")));
  const md = await loadHook(MD, win);

  let threw = null;
  await md.getDisplayMedia({ video: true }).catch((e) => { threw = e; });
  check("H-2 rejection still reaches the page", threw?.message === "Permission denied");
  check("H-2 cancelled picker releases the session",
    win.of("start").length === 1 && win.of("end").length === 1 &&
      win.of("end")[0].sid === win.of("start")[0].sid,
    JSON.stringify(win.posted));
}

// H-3 the path almost every real share ends on.
async function testHookEndsOnStopSharingButton() {
  const win = fakeWindow();
  const track = new FakeTrack();
  const MD = fakeMediaDevices(() => Promise.resolve(fakeStream([track])));
  const md = await loadHook(MD, win);

  await md.getDisplayMedia({ video: true });
  check("H-3 nothing ended yet", win.of("end").length === 0);
  track.stopSharing();
  check("H-3 Chrome's Stop sharing ends the session", win.of("end").length === 1,
    JSON.stringify(win.posted));
}

// H-4 MediaStreamTrack.stop() is specified NOT to fire `ended`. Meet's own
// "Stop presenting" takes this path, so without the stop() wrapper the bar
// would stay hidden until the next beat -- or forever, if the tab then idles.
async function testHookEndsOnPageInitiatedStop() {
  const win = fakeWindow();
  const track = new FakeTrack();
  const MD = fakeMediaDevices(() => Promise.resolve(fakeStream([track])));
  const md = await loadHook(MD, win);

  await md.getDisplayMedia({ video: true });
  track.stop();
  await Promise.resolve(); // the wrapper reconciles in a microtask
  check("H-4 page-initiated stop() ends the session, with no `ended` event",
    win.of("end").length === 1, JSON.stringify(win.posted));
}

// H-5 the beat is the liveness signal for a frame that dies without a word, and
// it must cover the picker-open window too -- an open picker is itself a
// preview of the screen.
async function testHookBeatsWhileSharingAndStopsWhenIdle() {
  const timers = fakeTimers();
  try {
    const win = fakeWindow();
    const track = new FakeTrack();
    let settle;
    const MD = fakeMediaDevices(() => new Promise((res) => { settle = res; }));
    const md = await loadHook(MD, win);

    const p = md.getDisplayMedia({ video: true });
    timers.tick();
    check("H-5 beats while the picker is still open",
      win.of("beat").length === 1 && win.of("beat")[0].sids.length === 1,
      JSON.stringify(win.of("beat")));

    await flush();
    settle(fakeStream([track]));
    await p;
    timers.tick();
    check("H-5 keeps beating once the share is live", win.of("beat").length === 2);

    // A track that dies without firing `ended` -- a renderer that lost the
    // capture, or a source window that vanished.
    track.readyState = "ended";
    timers.tick();
    check("H-5 a silently dead track is caught by the beat", win.of("end").length === 1,
      JSON.stringify(win.posted));
    check("H-5 the beat stops when nothing is sharing", timers.running() === 0);
  } finally {
    timers.restore();
  }
}

// H-6 this file patches a native method on every page the user opens. A plain
// wrapper function changes name, length and toString, and sites that sniff for
// exactly that will refuse to start a call.
async function testHookIsTransparentToThePage() {
  const win = fakeWindow();
  const MD = fakeMediaDevices(() => Promise.resolve(fakeStream([new FakeTrack()])));
  const original = MD.prototype.getDisplayMedia;
  await loadHook(MD, win);
  const patched = MD.prototype.getDisplayMedia;

  check("H-6 patch installed", patched !== original);
  check("H-6 name preserved", patched.name === original.name, patched.name);
  check("H-6 arity preserved", patched.length === original.length, String(patched.length));
  // Function.prototype.toString on a callable Proxy returns a native-code
  // string, which is the answer we want -- it is what an unpatched browser
  // gives. The one thing it must never do is print this extension's source
  // into the page's console.
  check("H-6 toString still reads as a native method",
    patched.toString().includes("[native code]"), patched.toString());
  check("H-6 toString leaks no extension source",
    !/secureshare|postMessage/.test(patched.toString()), patched.toString());

  // Patched on the PROTOTYPE: SDKs that call through
  // MediaDevices.prototype.getDisplayMedia.call(...) bypass an own property on
  // navigator.mediaDevices entirely.
  const md = Object.create(MD.prototype);
  await MD.prototype.getDisplayMedia.call(md, { video: true });
  check("H-6 a prototype-direct call is still seen", win.of("start").length === 1);
}

// H-7 the hook must survive being injected twice into one world without
// stacking proxies -- every layer would double every message.
async function testHookDoesNotDoublePatch() {
  const win = fakeWindow();
  const MD = fakeMediaDevices(() => Promise.resolve(fakeStream([new FakeTrack()])));
  const md = await loadHook(MD, win);
  const once = MD.prototype.getDisplayMedia;
  await loadHook(MD, win);
  check("H-7 a second injection leaves the patch alone",
    MD.prototype.getDisplayMedia === once);

  await md.getDisplayMedia({ video: true });
  check("H-7 one call still announces exactly one session", win.of("start").length === 1,
    JSON.stringify(win.posted));
}

// H-8 nothing this file does may reach the page. A synchronous throw from the
// real method still has to arrive unchanged, with no session left behind.
async function testHookNeverBreaksThePage() {
  const win = fakeWindow();
  const boom = new TypeError("Failed to execute 'getDisplayMedia'");
  const MD = fakeMediaDevices(() => { throw boom; });
  const md = await loadHook(MD, win);

  // Deliberate change of shape, and the only one the deferred call costs: the
  // real method is now invoked after an await, so a method that throws
  // SYNCHRONOUSLY surfaces to the page as a rejection instead. No page can tell
  // the difference on real Chrome -- Web IDL turns even
  // `getDisplayMedia.call(null)` into a rejected promise, never a throw, which
  // M3 confirmed against a live browser (live-test D4). The error object itself
  // still arrives untouched, and the session is still released.
  let threw = null;
  await md.getDisplayMedia().catch((e) => { threw = e; });
  check("H-8 a synchronous throw reaches the page unchanged, as a rejection", threw === boom);
  check("H-8 and leaves no session behind", win.of("end").length === 1);

  // A page is free to replace postMessage with something hostile.
  const win2 = fakeWindow();
  win2.postMessage = () => { throw new Error("nope"); };
  const track = new FakeTrack();
  const MD2 = fakeMediaDevices(() => Promise.resolve(fakeStream([track])));
  const md2 = await loadHook(MD2, win2);
  let broke = null;
  const stream = await md2.getDisplayMedia({ video: true }).catch((e) => { broke = e; });
  check("H-8 a hostile postMessage does not break the share",
    broke === null && typeof stream?.getVideoTracks === "function", String(broke));
}

// H-9 the fix M3 forced. Chrome captures the picker's preview thumbnails within
// a few ms of the call, and a real hide takes 30-123ms, so announcing the share
// and calling straight through is a race -- one a live browser lost, showing the
// bookmarks bar inside the picker's own preview. The call now waits for the bar
// to be reported down, which makes the ordering a guarantee instead of a bet.
async function testHookHoldsThePickerUntilTheBarIsDown() {
  const win = fakeWindow({ ack: false });
  let called = 0;
  const MD = fakeMediaDevices(() => { called++; return Promise.resolve(fakeStream([new FakeTrack()])); });
  const md = await loadHook(MD, win);

  const p = md.getDisplayMedia({ video: true });
  check("H-9 the share is announced immediately", win.of("start").length === 1);
  await flush();
  check("H-9 but Chrome is NOT allowed to open its picker yet", called === 0);

  const { sid } = win.of("start")[0];
  win.dispatch("message", { source: win, data: { ns: "secureshare", v: 1, kind: "hidden", sid } });
  await flush();
  check("H-9 the picker opens as soon as the bar is down", called === 1);
  await p;

  // A reply for someone else's session must not release this one.
  const win2 = fakeWindow({ ack: false });
  let called2 = 0;
  const MD2 = fakeMediaDevices(() => { called2++; return Promise.resolve(fakeStream([new FakeTrack()])); });
  const md2 = await loadHook(MD2, win2);
  md2.getDisplayMedia({ video: true });
  win2.dispatch("message", {
    source: win2,
    data: { ns: "secureshare", v: 1, kind: "hidden", sid: "some-other-session" },
  });
  await flush();
  check("H-9 a reply for a different sid does not release the wait", called2 === 0);
}

// H-10 the other half of that trade. A worker that is broken, updating, or just
// slow must delay the picker by a bounded amount and then get out of the way:
// being late with the bar is a bad afternoon, blocking the share is a broken
// meeting. Deliberately real time -- the deadline is the thing under test.
async function testHookFailsOpenWhenNobodyAnswers() {
  const win = fakeWindow({ ack: false });
  let called = 0;
  const MD = fakeMediaDevices(() => { called++; return Promise.resolve(fakeStream([new FakeTrack()])); });
  const md = await loadHook(MD, win);

  const started = Date.now();
  await md.getDisplayMedia({ video: true });
  const waited = Date.now() - started;
  check("H-10 the share happens even though nothing ever answered", called === 1);
  check("H-10 and it is held no longer than the deadline",
    waited >= 300 && waited < 1500, `${waited}ms`);
}

// H-11 the answer to "hiding syncs". The hide has to start before we know what
// is being shared, but a captured Chrome tab cannot contain the bookmarks bar
// -- so the moment the stream says `displaySurface: "browser"` the session is
// handed back and the bar returns, here and on every synced device, instead of
// staying down for the whole meeting.
async function testHookReleasesATabCapture() {
  const win = fakeWindow();
  const tab = new FakeTrack("video", "browser");
  const MD = fakeMediaDevices(() => Promise.resolve(fakeStream([tab])));
  const md = await loadHook(MD, win);

  await md.getDisplayMedia({ video: true });
  check("H-11 the share was still announced before the picker opened",
    win.of("start").length === 1);
  check("H-11 a tab capture releases the bar as soon as the stream resolves",
    win.of("end").length === 1 && win.of("end")[0].sid === win.of("start")[0].sid);

  // Releasing must not leave a half-live session behind: the beat exists to
  // hold a hide up, and there is no longer a hide to hold.
  const win2 = fakeWindow();
  const timers = fakeTimers();
  try {
    const md2 = await loadHook(
      fakeMediaDevices(() => Promise.resolve(fakeStream([new FakeTrack("video", "browser")]))),
      win2,
    );
    await md2.getDisplayMedia({ video: true });
    check("H-11 and stops beating, because nothing needs the bar down",
      timers.running() === 0);
  } finally {
    timers.restore();
  }
}

// H-12 the same read, failing closed. displaySurface is consulted only to
// RELEASE, so anything that is not provably a tab -- a whole screen, a window,
// a Chrome that does not report the key, a track that throws, or one tab track
// alongside one screen track -- has to leave the bar exactly where a share
// without this feature would: down.
async function testHookKeepsHidingWhenTheSurfaceIsNotProvablyATab() {
  const cases = [
    ["a whole screen stays hidden", [new FakeTrack("video", "monitor")]],
    ["a window stays hidden", [new FakeTrack("video", "window")]],
    ["an unreported surface stays hidden", [new FakeTrack("video", null)]],
    ["a track that throws stays hidden", [Object.assign(new FakeTrack("video", "browser"), {
      getSettings() { throw new Error("nope"); },
    })]],
    ["one screen track among tabs stays hidden", [
      new FakeTrack("video", "browser"),
      new FakeTrack("video", "monitor"),
    ]],
  ];
  for (const [label, tracks] of cases) {
    const win = fakeWindow();
    const md = await loadHook(fakeMediaDevices(() => Promise.resolve(fakeStream(tracks))), win);
    await md.getDisplayMedia({ video: true });
    check(`H-12 ${label}`, win.of("end").length === 0, JSON.stringify(win.of("end")));
  }
}

// H-13 Chrome's "Share this tab instead" swaps the captured surface under a
// live track without a second getDisplayMedia call. Both directions matter: an
// upgrade must release, and a downgrade must put the bar back down -- the one
// case where being wrong puts bookmarks on a live capture.
async function testHookFollowsASurfaceChange() {
  const win = fakeWindow();
  const track = new FakeTrack("video", "monitor");
  const md = await loadHook(fakeMediaDevices(() => Promise.resolve(fakeStream([track]))), win);
  await md.getDisplayMedia({ video: true });
  const sid = win.of("start")[0].sid;
  check("H-13 a screen share holds the bar down", win.of("end").length === 0);

  track.reconfigure("browser");
  check("H-13 switching to a tab releases it",
    win.of("end").length === 1 && win.of("end")[0].sid === sid);

  track.reconfigure("monitor");
  check("H-13 switching back re-asserts the hide for the same session",
    win.of("start").length === 2 && win.of("start")[1].sid === sid);

  track.reconfigure("browser");
  check("H-13 and it can be released again", win.of("end").length === 2);

  // Ending a released share must not send a second `end`: the worker retired
  // that session at release time, and a duplicate would wake it for nothing.
  track.stopSharing();
  check("H-13 ending an already-released share says nothing more",
    win.of("end").length === 2, JSON.stringify(win.of("end")));
}

// B-1..B-4 the bridge is the only thing standing between an arbitrary page and
// the worker, so it forwards on shape and provenance and nothing else.
async function testBridgeRelaysAndRejects() {
  const win = fakeWindow();
  const sent = [];
  globalThis.chrome = {
    runtime: { id: "x", sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
  };
  await loadBridge(win);

  const ok = (data) => win.dispatch("message", { source: win, data });
  ok({ ns: "secureshare", v: 1, kind: "start", sid: "a" });
  check("B-1 start is relayed", sent.length === 1 &&
    sent[0].type === "share:start" && sent[0].sid === "a", JSON.stringify(sent));

  ok({ ns: "secureshare", v: 1, kind: "beat", sids: ["a"] });
  ok({ ns: "secureshare", v: 1, kind: "end", sid: "a" });
  check("B-1 beat and end are relayed",
    sent.map((m) => m.type).join(",") === "share:start,share:beat,share:end",
    JSON.stringify(sent.map((m) => m.type)));

  const before = sent.length;
  // Another frame's message arrives here with ITS window as the source; that
  // frame has its own bridge and already relayed it. Forwarding it too would
  // book one share twice and attribute the copy to the wrong frame.
  win.dispatch("message", { source: {}, data: { ns: "secureshare", v: 1, kind: "start", sid: "b" } });
  ok({ ns: "other", v: 1, kind: "start", sid: "b" });
  ok({ ns: "secureshare", v: 2, kind: "start", sid: "b" });
  ok({ ns: "secureshare", v: 1, kind: "hide", sid: "b" });
  ok({ ns: "secureshare", v: 1, kind: "start" });
  ok({ ns: "secureshare", v: 1, kind: "start", sid: 42 });
  ok({ ns: "secureshare", v: 1, kind: "beat", sids: "a" });
  ok(null);
  ok("start");
  check("B-2 foreign, malformed and misdirected messages are all dropped",
    sent.length === before, JSON.stringify(sent.slice(before)));

  // 64 sids from one frame is a page trying to grow worker state, not a share.
  ok({ ns: "secureshare", v: 1, kind: "beat", sids: Array.from({ length: 64 }, (_, i) => `s${i}`) });
  check("B-3 a sid flood is capped", sent[sent.length - 1].sids.length === 16,
    String(sent[sent.length - 1].sids.length));

  win.dispatch("pagehide", {});
  check("B-4 pagehide reports the frame leaving",
    sent[sent.length - 1].type === "share:bye");
}

// B-5 the bridge runs on every page the user opens. A page that never shares
// must never cost a message -- including on unload, which would otherwise wake
// the worker once per tab close, forever.
async function testBridgeStaysSilentOnPagesThatNeverShare() {
  const win = fakeWindow();
  const sent = [];
  globalThis.chrome = {
    runtime: { id: "x", sendMessage: (m) => { sent.push(m); return Promise.resolve(); } },
  };
  await loadBridge(win);

  win.dispatch("message", { source: win, data: { ns: "secureshare", v: 1, kind: "end", sid: "z" } });
  win.dispatch("pagehide", {});
  check("B-5 a page that never shared sends nothing at all", sent.length === 0,
    JSON.stringify(sent));

  // After an extension reload the page lives on with a dead runtime. Touching
  // sendMessage then throws "Extension context invalidated" into the console.
  globalThis.chrome = { runtime: { id: undefined, sendMessage: () => { throw new Error("invalidated"); } } };
  const win2 = fakeWindow();
  await loadBridge(win2);
  let broke = null;
  try {
    win2.dispatch("message", { source: win2, data: { ns: "secureshare", v: 1, kind: "start", sid: "a" } });
  } catch (e) { broke = e; }
  check("B-5 an invalidated extension context is not thrown into the page", broke === null,
    String(broke));
}

/** Wire a page (hook + bridge) to a loaded worker through the mock. */
async function loadPage(mock, behaviour) {
  // No stubbed acknowledgement here: the real bridge is loaded below, and
  // whether IT reports the hide back to the hook is exactly what the E-layer
  // is for. Auto-acking would let the whole reply path rot unnoticed.
  const win = fakeWindow({ ack: false });
  globalThis.chrome = mock.api;
  await loadBridge(win);
  const md = await loadHook(fakeMediaDevices(behaviour), win);
  return { win, md };
}

// E-1 the milestone end to end: a real call in a page world empties the bar,
// through every hop, with nothing stubbed in between.
async function testEndToEndShareHidesAndRestores() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);
  const track = new FakeTrack();
  let settle;
  const { md } = await loadPage(mock, () => new Promise((res) => { settle = res; }));

  const p = md.getDisplayMedia({ video: true });
  check("E-1 Chrome is not allowed to open its picker on the spot", settle === undefined);
  await mock.idle();
  await flush(engine);
  const barTitles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("E-1 bar is already down while the picker is still open",
    !barTitles.some((t) => ["Work", "Headlines", "Personal", "Reading"].includes(t)),
    barTitles.join(","));
  // The whole loop: hook -> bridge -> worker -> hide -> worker's reply ->
  // bridge -> hook -> the real getDisplayMedia. Nothing here is stubbed, so
  // this is what proves the bridge really does report the hide back.
  check("E-1 and the picker opens only once the worker has answered", settle !== undefined);
  check("E-1 the worker counts one live share",
    (await mock.message({ type: "shares" })).sharing === 1);

  settle(fakeStream([track]));
  await p;
  await mock.idle();
  await flush(engine);
  check("E-1 still hidden once the share is live",
    (await engine.status()).hidden === true);

  track.stopSharing();
  await mock.idle();
  await flush(engine);
  check("E-1 bar is byte-identical after the share ends",
    JSON.stringify(mock.snapshot("1")) === before);
  check("E-1 no live shares left", (await mock.message({ type: "shares" })).sharing === 0);
  check("E-1 no vault left behind",
    ![...mock.nodes.values()].some((n) => n.title.startsWith("Skrim —")));
}

// E-2 the cancelled picker, end to end. This is the cost of being early, and it
// has to settle back exactly where it started.
async function testEndToEndCancelledPickerRestores() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);
  let settle;
  const { md } = await loadPage(mock, () => new Promise((_, rej) => { settle = rej; }));

  const p = md.getDisplayMedia({ video: true });
  await mock.idle();
  await flush(engine);
  check("E-2 bar goes down the moment the picker opens",
    (await engine.status()).hidden === true);

  settle(new Error("NotAllowedError"));
  await p.catch(() => {});
  await mock.idle();
  await flush(engine);
  check("E-2 cancelling puts the bar back, exactly",
    JSON.stringify(mock.snapshot("1")) === before);
  check("E-2 and clears the session", (await mock.message({ type: "shares" })).sharing === 0);
}

// E-3 the sync fix end to end, with nothing stubbed: the bar still goes down
// before Chrome may open its picker -- it has to, nobody knows what will be
// picked yet -- and then comes back the moment the resolved stream says the
// user picked a tab, WHILE THAT SHARE IS STILL RUNNING. Every hop is real, so
// this is what proves the release survives the bridge and the session counter
// and reaches chrome.bookmarks.
async function testEndToEndTabShareReleasesTheBarMidMeeting() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);
  const track = new FakeTrack("video", "browser");
  let settle;
  const { md } = await loadPage(mock, () => new Promise((res) => { settle = res; }));

  const p = md.getDisplayMedia({ video: true });
  await mock.idle();
  await flush(engine);
  check("E-3 the bar is down before the picker opens, as always",
    (await engine.status()).hidden === true);

  settle(fakeStream([track]));
  await p;
  await mock.idle();
  await flush(engine);

  check("E-3 a tab share puts the bar back without waiting for the meeting to end",
    (await engine.status()).hidden === false);
  check("E-3 and puts it back byte-identical",
    JSON.stringify(mock.snapshot("1")) === before);
  check("E-3 no vault is left parked in Other Bookmarks for peers to inherit",
    ![...mock.nodes.values()].some((n) => n.title.startsWith("Skrim —")));
  check("E-3 the worker is no longer counting the share",
    (await mock.message({ type: "shares" })).sharing === 0);
  check("E-3 even though the share is genuinely still live", track.readyState === "live");

  // And ending it changes nothing, rather than tripping a second restore.
  track.stopSharing();
  await mock.idle();
  await flush(engine);
  check("E-3 ending the share afterwards is a no-op",
    JSON.stringify(mock.snapshot("1")) === before);
}

// SW-6 the toolbar icon is the state readout, and the scrim's POSITION is what
// says which state it is -- so it has to actually track the state rather than
// being set once at install. This walks the full cycle. It matters more than a
// cosmetic assertion looks: the icon is what a user sees WITHOUT opening the
// popup, and "exposed" showing while the bar is already clear is the one
// direction of wrong that would send someone hunting for a share to stop.
async function testToolbarIconTracksState() {
  const mock = build();
  const { engine } = await loadSw(mock);
  const tab = (id, frameId = 0) => ({ tab: { id }, frameId });
  const icon = () => String(mock.icon ?? "").replace(/^icons\/state-|-32\.png$/g, "");

  await flush(engine);
  check("SW-6 nothing sharing, bar up: armed", icon() === "armed", `icon=${mock.icon}`);

  // A share starts. The hide is automatic, so by the time the chain drains the
  // bar is already clear -- the icon must be reporting COVERED, not exposed.
  await mock.message({ type: "share:start", sid: "a" }, tab(1));
  await flush(engine);
  check("SW-6 auto-hide fired, so the icon reads hidden not exposed",
    icon() === "hidden" && (await engine.status()).hidden === true, `icon=${mock.icon}`);

  await mock.message({ type: "share:end", sid: "a" }, tab(1));
  await flush(engine);
  check("SW-6 back to armed once the share ends and the bar is restored",
    icon() === "armed" && (await engine.status()).hidden === false, `icon=${mock.icon}`);

  // The state the flare cut exists for: a share is live and the bookmarks are
  // still up. Reached by restoring underneath a running share, which is exactly
  // what the popup's "Hide now" button is offered for.
  await mock.message({ type: "share:start", sid: "b" }, tab(2));
  await flush(engine);
  await mock.message({ type: "restore" });
  await flush(engine);
  check("SW-6 sharing with the bar back up is the exposed cut",
    icon() === "exposed", `icon=${mock.icon}`);
}

// S-1 two tabs presenting at once is one hide and one restore, not two of each.
// Restoring on the first `end` would repopulate the bar on a live share.
async function testTwoTabsShareOneHide() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);
  const tab = (id, frameId = 0) => ({ tab: { id }, frameId });

  await mock.message({ type: "share:start", sid: "a" }, tab(1));
  await mock.message({ type: "share:start", sid: "b" }, tab(2));
  await flush(engine);
  check("S-1 two tabs count as two sessions",
    (await mock.message({ type: "shares" })).sharing === 2);

  await mock.message({ type: "share:end", sid: "a" }, tab(1));
  await flush(engine);
  check("S-1 the first tab stopping does NOT expose the bar",
    (await engine.status()).hidden === true);

  await mock.message({ type: "share:end", sid: "b" }, tab(2));
  await flush(engine);
  check("S-1 the last one restores", JSON.stringify(mock.snapshot("1")) === before);
}

// S-6 the bar can come back up in the middle of a live share: the popup's
// Restore, or a signed-in peer device syncing one over. The next share to start
// has to put it down again -- which only happens if every start re-asserts the
// hide instead of trusting a count that says one is already in effect.
async function testNewShareReassertsTheHide() {
  const mock = build();
  const { engine } = await loadSw(mock);

  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 1 }, frameId: 0 });
  await flush(engine);
  check("S-6 the first share hides the bar", (await engine.status()).hidden === true);

  await mock.message({ type: "restore" }); // the popup's escape hatch
  await flush(engine);
  check("S-6 precondition: the bar is exposed while tab 1 still shares",
    (await engine.status()).hidden === false);

  await mock.message({ type: "share:start", sid: "b" }, { tab: { id: 2 }, frameId: 0 });
  await flush(engine);
  check("S-6 a second share puts it back down", (await engine.status()).hidden === true);
  check("S-6 and both are still counted",
    (await mock.message({ type: "shares" })).sharing === 2);
}

// S-2 two frames of ONE tab -- a conferencing app embedded in an iframe is the
// normal case. Keyed by frame, so one frame leaving cannot end the other.
async function testTwoFramesOfOneTab() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 7 }, frameId: 0 });
  await mock.message({ type: "share:start", sid: "b" }, { tab: { id: 7 }, frameId: 3 });
  await flush(engine);
  check("S-2 frames of one tab are counted separately",
    (await mock.message({ type: "shares" })).sharing === 2);

  await mock.message({ type: "share:bye" }, { tab: { id: 7 }, frameId: 3 });
  await flush(engine);
  check("S-2 one frame unloading leaves the other sharing",
    (await engine.status()).hidden === true);

  // Closing the tab takes every frame in it, with no message from either.
  mock.closeTab(7);
  await mock.idle();
  await flush(engine);
  check("S-2 a closed tab ends every share in it",
    JSON.stringify(mock.snapshot("1")) === before);
}

// S-3 a renderer that crashes, a tab that is discarded, a laptop lid closed
// mid-meeting: no `end`, no `bye`, no close. The frame just stops beating, and
// the watchdog is the only thing left that can put the bar back.
async function testStaleFrameExpiresOnTheWatchdog() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 4 }, frameId: 0 });
  await flush(engine);
  check("S-3 sharing", (await engine.status()).hidden === true);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("S-3 a frame that is still beating is left alone",
    (await engine.status()).hidden === true);

  // Age the record past three missed beats, the way a worker waking after the
  // frame died would find it.
  const stored = mock.sessionStorage.get("secureshare.shares");
  stored.frames["4:0"].lastSeen = Date.now() - 60_000;
  mock.sessionStorage.set("secureshare.shares", stored);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("S-3 a silent frame is expired and the bar comes back",
    JSON.stringify(mock.snapshot("1")) === before);
  check("S-3 nothing is left counted", (await mock.message({ type: "shares" })).sharing === 0);
}

// S-4 MV3 kills the worker after ~30s idle and an extension update wipes
// storage.session outright, both while a share runs on. The beat is read
// straight off the live tracks, so it is what re-teaches a worker that forgot.
async function testBeatReteachesAForgetfulWorker() {
  const mock = build();
  const { engine } = await loadSw(mock);
  const sharer = { tab: { id: 9 }, frameId: 0 };

  await mock.message({ type: "share:start", sid: "a" }, sharer);
  await flush(engine);

  // The worker's whole memory of the share, gone.
  mock.sessionStorage.clear();
  await engine.restore();
  check("S-4 precondition: the bar is exposed mid-share",
    (await engine.status()).hidden === false);

  await mock.message({ type: "share:beat", sids: ["a"] }, sharer);
  await flush(engine);
  check("S-4 the next beat re-registers the share",
    (await mock.message({ type: "shares" })).sharing === 1);
  check("S-4 and puts the bar back down", (await engine.status()).hidden === true);

  // A share that ends while the worker is asleep sends an `end` nobody hears.
  // Retiring it is the other half of why the beat REPLACES the frame's set
  // rather than merging into it: a merge leaves the dead session counted
  // forever, and the bar down with it long after the meeting finished.
  await mock.message({ type: "share:start", sid: "b" }, sharer);
  await flush(engine);
  check("S-4 precondition: two sessions in one frame",
    (await mock.message({ type: "shares" })).sharing === 2);

  await mock.message({ type: "share:beat", sids: ["b"] }, sharer);
  await flush(engine);
  check("S-4 a beat retires the session whose `end` was lost",
    (await mock.message({ type: "shares" })).sharing === 1);

  // And an empty frame is dropped outright rather than left at zero.
  await mock.message({ type: "share:beat", sids: [] }, sharer);
  await flush(engine);
  check("S-4 an empty beat ends the frame's shares",
    (await mock.message({ type: "shares" })).sharing === 0);
}

// --- X-*: recorders we cannot hook -----------------------------------------
//
// Loom does not call getDisplayMedia and does not run in a page we may inject
// into: it opens chrome-extension://<loom>/html/pinnedTab.html as a pinned tab
// and calls chrome.desktopCapture from there. The tab is the only evidence.

const LOOM_TAB = "chrome-extension://liecbddmkiiihnedobmlmillhodjkdmb/html/pinnedTab.html";
const shares = (mock) => mock.message({ type: "shares" });

// X-1 the URL matcher, which is the whole of the detection. Anchored on the
// extension id AND the path, because being too wide here would park a user's
// bookmarks every time that extension opened any page at all.
async function testRecorderUrlMatching() {
  const { recorderFor } = await import(`file://${path.join(BUILD, "recorders.js")}`);
  const hit = (u) => recorderFor(u)?.name ?? null;

  check("X-1 Loom's capture page is recognised", hit(LOOM_TAB) === "Loom");
  check("X-1 query and fragment do not defeat it",
    hit(`${LOOM_TAB}?session=1#x`) === "Loom");
  check("X-1 a suffixed rename still matches (paths are prefixes)",
    hit(LOOM_TAB.replace("pinnedTab.html", "pinnedTabV2.html")) === "Loom");
  check("X-1 Loom's OTHER pages are not capture pages",
    hit("chrome-extension://liecbddmkiiihnedobmlmillhodjkdmb/html/logs.html") === null);
  check("X-1 another extension at the same path is not Loom",
    hit("chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/html/pinnedTab.html") === null);
  check("X-1 a web page that merely spells it out is not a recorder",
    hit(`https://evil.test/${LOOM_TAB}`) === null);
  for (const junk of [null, undefined, 42, "", "chrome-extension://short/x"]) {
    check(`X-1 junk url ${JSON.stringify(junk)} is answered, not thrown`,
      recorderFor(junk) === null);
  }
}

// X-2 the case the user hit: recording with the Loom extension. The pinned tab
// appearing hides the bar; the pinned tab closing puts it back.
async function testRecorderTabHidesAndRestores() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  mock.openTab(9, LOOM_TAB);
  await flush(engine);
  check("X-2 Loom's capture tab hides the bar", (await engine.status()).hidden === true);
  const snap = await shares(mock);
  check("X-2 and is reported as one recorder session",
    snap.sharing === 1 && snap.frames[0]?.recorder === "Loom", JSON.stringify(snap));

  // Chrome fires onUpdated repeatedly for one page load -- status, title,
  // favicon -- with no url in changeInfo. Treating those as "it is not a
  // recorder page any more" would release the hide seconds after taking it.
  mock._listeners.onTabUpdated[0](9, { status: "complete" }, { id: 9, url: LOOM_TAB });
  await flush(engine);
  check("X-2 a status-only update does not release the hide",
    (await engine.status()).hidden === true);
  check("X-2 nor drop the session", (await shares(mock)).sharing === 1);

  mock.closeTab(9);
  await mock.idle();
  await flush(engine);
  check("X-2 closing it restores the bar exactly",
    JSON.stringify(mock.snapshot("1")) === before);
  check("X-2 and nothing is left counted", (await shares(mock)).sharing === 0);
}

// X-3 the recorder has no hook and therefore no beat. The 35s beat clock would
// expire it mid-recording -- 35 seconds into a five-minute Loom -- so recorder
// records are exempt, and it is the tab query that retires them instead.
async function testRecorderOutlivesTheBeatClock() {
  const mock = build();
  const { engine } = await loadSw(mock);

  mock.openTab(9, LOOM_TAB);
  await flush(engine);

  // Age it far past three missed beats, the way a long recording would.
  const stored = mock.sessionStorage.get("secureshare.shares");
  check("X-3 precondition: the recording is registered",
    !!stored?.frames?.["9:ext"], JSON.stringify(stored));
  if (!stored?.frames?.["9:ext"]) return; // a named failure beats a TypeError
  stored.frames["9:ext"].lastSeen = Date.now() - 10 * 60_000;
  mock.sessionStorage.set("secureshare.shares", stored);

  // The end state is not the assertion. The scan that runs straight after the
  // sweep would re-hide a wrongly-expired recording, so the bar would look
  // right by the time the watchdog returned -- having put every bookmark back
  // onto the screen being recorded, and taken it away again, once a minute for
  // the whole recording. Bookmark mutations are the observable, not the bar.
  const quiet = mock.events.length;
  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-3 a long recording is NOT expired by the beat clock",
    (await engine.status()).hidden === true);
  check("X-3 and the bar does not flicker back onto the recording",
    mock.events.length === quiet, `${mock.events.length - quiet} bookmark events`);
  check("X-3 and it is still counted", (await shares(mock)).sharing === 1);
}

// X-4 the two ways the worker loses track, both of which happen routinely: MV3
// terminates it after ~30s idle and an update wipes storage.session. The tab
// query is the recorder's equivalent of the beat and has to heal BOTH
// directions -- a recording it forgot, and a hide nobody is left to release.
async function testRecorderScanHealsBothDirections() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  // Direction 1: the recording started while the worker was asleep, so no
  // onCreated was ever delivered. It is running now, and the scan must find it.
  mock.tabs.set(9, { id: 9, url: LOOM_TAB });
  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-4 a scan discovers a recording the worker never heard start",
    (await engine.status()).hidden === true);

  // Direction 2: the tab is gone and onRemoved was missed. Nothing else can
  // release this hide -- the recorder sends no `end` and beats no heartbeat.
  mock.tabs.delete(9);
  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-4 a scan retires a recording whose tab is gone",
    JSON.stringify(mock.snapshot("1")) === before);

  // And the same on a cold start, without waiting up to a minute for the first
  // alarm: a worker that boots into a recording already in progress is the
  // COMMON case, since MV3 kills it after ~30s idle and a Loom runs for
  // minutes. The wake scan is what covers that window.
  const cold = build();
  cold.tabs.set(9, { id: 9, url: LOOM_TAB });
  const { engine: e2 } = await loadSw(cold);
  await flush(e2);
  check("X-4 a cold worker wake finds a recording already running, with no alarm",
    (await e2.status()).hidden === true);
}

// X-5 Loom's pinned tab navigates to loom.com when the recording is published.
// The recorder record must go and the TAB must not -- it is an ordinary page
// from that moment on, and it may start a share of its own.
async function testRecorderTabNavigatingAwayReleases() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  mock.openTab(9, LOOM_TAB);
  await flush(engine);
  check("X-5 recording", (await engine.status()).hidden === true);

  mock.navigateTab(9, "https://www.loom.com/share/abc");
  await flush(engine);
  check("X-5 navigating away releases the hide at once, not on the watchdog",
    JSON.stringify(mock.snapshot("1")) === before);

  // And the same tab can still share as a page, through the ordinary hook path.
  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 9 }, frameId: 0 });
  await flush(engine);
  check("X-5 the tab still works as an ordinary sharing tab",
    (await engine.status()).hidden === true);
  await mock.message({ type: "share:end", sid: "a" }, { tab: { id: 9 }, frameId: 0 });
  await flush(engine);
  check("X-5 and releases normally", JSON.stringify(mock.snapshot("1")) === before);
}

// X-6 a recorder must not fight the popup. The scan runs every minute for the
// whole recording, so a sync that merely confirms the status quo re-asserting
// the hide would undo a Restore the user made by hand, silently, forever.
async function testRecorderScanDoesNotFightRestore() {
  const mock = build();
  const { engine } = await loadSw(mock);

  mock.openTab(9, LOOM_TAB);
  await flush(engine);
  await mock.message({ type: "restore" }); // the popup's escape hatch
  await flush(engine);
  check("X-6 precondition: the bar is back up while Loom still records",
    (await engine.status()).hidden === false);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-6 the watchdog does not put it back down behind the user",
    (await engine.status()).hidden === false);
  check("X-6 and the recording is still tracked, so its end still releases",
    (await shares(mock)).sharing === 1);
}

// X-7 the two worlds add up rather than cancelling. A Meet call and a Loom
// recording at once is one hide, and it lasts until BOTH have finished.
async function testRecorderAndPageShareCoexist() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  const { engine } = await loadSw(mock);

  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 1 }, frameId: 0 });
  mock.openTab(9, LOOM_TAB);
  await flush(engine);
  check("X-7 both are counted", (await shares(mock)).sharing === 2);

  mock.closeTab(9);
  await mock.idle();
  await flush(engine);
  check("X-7 the recorder ending does not expose a live Meet call",
    (await engine.status()).hidden === true);

  await mock.message({ type: "share:end", sid: "a" }, { tab: { id: 1 }, frameId: 0 });
  await flush(engine);
  check("X-7 the last one out restores", JSON.stringify(mock.snapshot("1")) === before);
}

// X-8 without the "tabs" permission chrome.tabs.query throws, and on some
// Chrome build one of these listeners may not exist. Neither may take the
// worker down: the extension has to keep working for Meet and Zoom exactly as
// it did before recorder detection was added.
async function testRecorderDetectionFailsSafe() {
  const mock = build();
  const api = mock.api;
  api.tabs.query = async () => { throw new Error("no 'tabs' permission"); };
  const { engine } = await loadSw(mock);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-8 a refused tab query does not break the watchdog",
    (await engine.status()).hidden === false);

  const before = JSON.stringify(mock.snapshot("1"));
  await mock.message({ type: "share:start", sid: "a" }, { tab: { id: 1 }, frameId: 0 });
  await flush(engine);
  check("X-8 and ordinary page shares still hide the bar",
    (await engine.status()).hidden === true);

  // The recorder scan prunes as a side effect of any mutation, so with a
  // working tabs query it silently does the expiry sweep's job too. That must
  // not become the only thing doing it: on a profile that never granted "tabs",
  // or a Chrome that changed the API, the scan never runs and a crashed
  // renderer would hold the bar down until MAX_HIDDEN_MS. sessions.sweep() has
  // to stand on its own.
  const stored = mock.sessionStorage.get("secureshare.shares");
  stored.frames["1:0"].lastSeen = Date.now() - 60_000;
  mock.sessionStorage.set("secureshare.shares", stored);

  await mock._listeners.onAlarm[0]({ name: "secureshare.watchdog" });
  await flush(engine);
  check("X-8 a dead frame is still expired with the tab query broken",
    JSON.stringify(mock.snapshot("1")) === before);
}

// S-5 these messages arrive from arbitrary pages. Identity comes from the
// sender Chrome fills in, never from the payload, and a repeated start must not
// buy repeated work.
async function testSessionMessagesAreBounded() {
  const mock = build();
  const { engine } = await loadSw(mock);

  const noTab = await mock.message({ type: "share:start", sid: "a" }, {});
  check("S-5 a sender with no tab is refused", noTab.ok === false, JSON.stringify(noTab));

  const noSid = await mock.message({ type: "share:start" }, { tab: { id: 1 }, frameId: 0 });
  check("S-5 a start with no sid is refused", noSid.ok === false, JSON.stringify(noSid));

  const sharer = { tab: { id: 1 }, frameId: 0 };
  for (let i = 0; i < 40; i++) {
    await mock.message({ type: "share:start", sid: `s${i}` }, sharer);
  }
  await flush(engine);
  const s = await mock.message({ type: "shares" });
  check("S-5 a getDisplayMedia loop cannot grow worker state past the cap",
    s.sharing === 16, JSON.stringify(s));
  check("S-5 and the bar is hidden throughout", (await engine.status()).hidden === true);
}

// --- RC-*: surviving the extension itself ---------------------------------
//
// Everything above assumes the extension is still there to finish what it
// started. These cover the case it is not: uninstalled mid-hide, or broken by a
// Chrome release, with chrome.storage.local -- and therefore the journal --
// gone. The bookmarks are never lost in that case, only their addresses, and
// the receipt inside the vault is the copy of those addresses that Chrome keeps.

const receiptOf = (mock, vault) => {
  const node = vault.children.map((id) => mock.nodes.get(id)).find(isReceiptNode);
  return node ? receiptMod.decode(node.url) : null;
};

/** The uninstall, exactly: bookmarks survive, extension storage does not. */
async function uninstall(mock) {
  mock.storage.clear();
  mock.sessionStorage.clear();
  return loadEngine(mock); // a reinstall gets a cold module, not a warm one
}

// RC-1 the receipt exists, decodes, and describes this hide.
async function testReceiptIsWritten() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: true });

  const vault = findVault(mock);
  const rec = receiptOf(mock, vault);
  check("RC-1 a hide leaves a decodable receipt in the vault", !!rec);
  check("RC-1 it names its own vault, which is what proves it was written here",
    String(rec?.vault) === String(vault.id), `${rec?.vault} vs ${vault.id}`);
  check("RC-1 it records every displaced item with its original bar index",
    rec?.items.length === 4 && rec.items.every(([, i]) => typeof i === "number"),
    JSON.stringify(rec?.items));
  check("RC-1 it records the decoys it put on the bar",
    rec?.decoys.length === 6 && rec.decoys.every(([id, t, u]) => id && t && u),
    JSON.stringify(rec?.decoys));
  check("RC-1 the receipt never reaches the bar",
    !mock.nodes.get("1").children.some((id) => isReceiptNode(mock.nodes.get(id))));
  check("RC-1 and is not counted as one of the user's bookmarks",
    (await engine.status()).itemsDisplaced === 4);

  await engine.restore();
  check("RC-1 a completed restore leaves no receipt behind anywhere",
    ![...mock.nodes.values()].some(isReceiptNode));
}

// RC-2 THE HEADLINE. Uninstall while hidden, reinstall, one click: the bar is
// byte-identical -- original positions, no decoys, no leftover folder. This is
// the case the extension used to document as unrecoverable by design.
async function testUninstalledWhileHiddenIsRecoverable() {
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  let engine = await loadEngine(mock);
  await engine.hide({ decoys: true });

  const vault = findVault(mock);
  engine = await uninstall(mock);

  const pending = await engine.pendingAdoptions();
  check("RC-2 a reinstall finds the stranded vault", pending.length === 1);
  check("RC-2 and can prove it was hidden on THIS computer",
    pending[0]?.local === true && pending[0]?.count === 4,
    JSON.stringify(pending[0]));
  check("RC-2 it knows when, from the receipt rather than the folder's dateAdded",
    typeof pending[0]?.hidAt === "number");
  check("RC-2 and can name the decoys it left on the bar",
    pending[0]?.decoys.length === 6);

  const a = await engine.adoptVault(vault.id);
  check("RC-2 restoring from the receipt is the exact path, not the append one",
    a.ok === true && a.exact === true, JSON.stringify(a));
  check("RC-2 the bar is byte-identical to before the uninstall",
    JSON.stringify(mock.snapshot("1")) === before,
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
  check("RC-2 the vault is gone", !mock.nodes.has(vault.id));
  check("RC-2 nothing is left waiting", (await engine.pendingAdoptions()).length === 0);
}

// RC-3 exactness has to mean POSITION, not just order. A policy-managed
// bookmark sits in the middle of the bar and cannot move, so appending the
// survivors -- all a pre-receipt reinstall could do -- reorders the bar around
// it. Only the recorded indices put everything back where it was.
async function testReinstallRestoresPositionNotJustOrder() {
  const mock = new MockChrome();
  mock.seed("1", FIXTURE[0]);
  mock.seed("1", FIXTURE[1]);
  mock.seed("1", { title: "Corp policy", url: "https://c.example/", unmodifiable: "managed" });
  mock.seed("1", FIXTURE[2]);
  mock.seed("1", FIXTURE[3]);
  mock.seed("2", { title: "Existing other", url: "https://o.example/" });

  const before = JSON.stringify(mock.snapshot("1"));
  let engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = findVault(mock);

  engine = await uninstall(mock);
  await engine.adoptVault(vault.id);

  check("RC-3 a managed bookmark mid-bar is still mid-bar after a reinstall",
    JSON.stringify(mock.snapshot("1")) === before,
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
}

// RC-4 the user tidied up before reinstalling: dragged one bookmark out of the
// vault themselves and deleted another. The rest must still go home, and
// nothing may be invented to fill the gaps.
async function testReinstallToleratesAUserWhoHelped() {
  const mock = build();
  let engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = findVault(mock);
  engine = await uninstall(mock);

  const items = vaultItems(mock, mock.nodes.get(vault.id));
  await mock.api.bookmarks.move(items[0], { parentId: "1" }); // dragged back
  await mock.api.bookmarks.removeTree(items[3]); // and deleted one

  const a = await engine.adoptVault(vault.id);
  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("RC-4 adoption still succeeds", a.ok === true, JSON.stringify(a));
  check("RC-4 every survivor is on the bar, in order, exactly once",
    titles.join(",") === "Work,Headlines,Personal",
    titles.join(","));
  check("RC-4 and the emptied vault is cleaned up", !mock.nodes.has(vault.id));
}

// RC-4b the same reinstall, on a profile that does NOT sync -- signed out of
// Chrome, or bookmark sync switched off. Nothing can reach this storage, so the
// sweep adopts the vault on its own rather than asking, and the user never sees
// the recovery page: `recover()` drains it before the install handler can offer
// one. That automatic path therefore has to be as good as the button, and it
// was not. It appended the items and deleted the receipt unread, stranding six
// look-alike bookmarks on the bar permanently and losing the original layout --
// on the one profile shape that never gets a second chance to fix it.
//
// The mock's roots say `syncing: true`, which is why this went unnoticed: every
// other test in this file takes the branch that asks the user.
async function testUnsyncedReinstallDrainsExactlyNotApproximately() {
  const mock = build();
  mock.nodes.get("1").syncing = false;
  mock.nodes.get("2").syncing = false;
  // A managed bookmark mid-bar, as in RC-3: appending the survivors reorders
  // the bar around anything that cannot move, so this is what tells "exact"
  // apart from "in the right order".
  mock.seed("1", { title: "Corp policy", url: "https://c.example/", unmodifiable: "managed" });

  const before = JSON.stringify(mock.snapshot("1"));
  let engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const vault = findVault(mock);

  engine = await uninstall(mock);
  // Exactly what sw.js does on install -- no adoptVault, no popup, no click.
  await engine.recover({ maxHiddenMs: 0 });

  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("RC-4b an unsynced reinstall puts the bar back without being asked",
    JSON.stringify(mock.snapshot("1")) === before, titles.join(","));
  check("RC-4b and takes its own decoys with it",
    !titles.some((t) => ["Google", "Gmail", "Calendar", "Drive", "Maps", "News"].includes(t)),
    titles.join(","));
  check("RC-4b the vault and its receipt are gone", !mock.nodes.has(vault.id));
  check("RC-4b nothing is left waiting for the user",
    (await engine.pendingAdoptions()).length === 0);

  // A decoy the sweep could not remove must survive as a stray, not vanish
  // from the record -- that is what keeps the next hide from vaulting it and
  // handing it back as a bookmark of the user's.
  const strays = mock.storage.get("secureshare.strayDecoys") ?? [];
  check("RC-4b and leaves no stray decoy unaccounted for", strays.length === 0,
    JSON.stringify(strays));
}

// RC-4c a receiptless vault on the same unsynced profile -- written before
// receipts existed, or one whose receipt the user deleted. There is nothing to
// be exact FROM, so appending is correct and the decoys are not ours to name.
// The point is that the receipt path must not have broken the fallback.
async function testUnsyncedReinstallWithoutAReceiptStillAppends() {
  const mock = build();
  mock.nodes.get("1").syncing = false;
  mock.nodes.get("2").syncing = false;

  let engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = findVault(mock);
  engine = await uninstall(mock);

  for (const id of [...mock.nodes.get(vault.id).children]) {
    if (isReceiptNode(mock.nodes.get(id))) await mock.api.bookmarks.removeTree(id);
  }
  await engine.recover({ maxHiddenMs: 0 });

  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("RC-4c a receiptless vault still gives every bookmark back, in order",
    titles.join(",") === "Work,Headlines,Personal,Reading", titles.join(","));
  check("RC-4c and is cleaned up afterwards", !mock.nodes.has(vault.id));
}

/** The receipt node itself, rather than its decoded payload. */
const receiptNodeOf = (mock, vault) =>
  vault.children.map((id) => mock.nodes.get(id)).find(isReceiptNode) ?? null;

// RC-4d the sweep deletes bookmarks off the user's bar, so the rule that keeps
// that safe is the one worth attacking: an id is never authority on its own.
// Sync can renumber a tree, and the six decoys are among the most commonly
// bookmarked URLs there are -- so a receipt naming id 7 must not delete id 7
// when id 7 is now the user's own bookmark. It is re-read and shape-checked at
// the moment of deletion, which is the only moment that can be checked at.
async function testSweepNeverDeletesABookmarkTheIdNoLongerNames() {
  const mock = build();
  mock.nodes.get("1").syncing = false;
  mock.nodes.get("2").syncing = false;

  let engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const vault = findVault(mock);
  const rec = receiptOf(mock, mock.nodes.get(vault.id));
  const stolenId = String(rec.decoys[0][0]);

  engine = await uninstall(mock);
  // That id now names something of the user's -- sync remapped it while this
  // profile had no extension installed to notice.
  const impostor = mock.nodes.get(stolenId);
  impostor.title = "Mum's birthday list";
  impostor.url = "https://example.com/mum";

  await engine.recover({ maxHiddenMs: 0 });

  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("RC-4d a decoy id that now names a real bookmark is left alone",
    mock.nodes.has(stolenId) && titles.includes("Mum's birthday list"),
    titles.join(","));
  check("RC-4d while the five that are still ours are removed",
    !titles.some((t) => ["Google", "Gmail", "Calendar", "Drive", "Maps", "News"].includes(t)),
    titles.join(","));
}

// RC-4e a vault sitting in local-only storage whose receipt was written
// somewhere else -- a bookmarks HTML export restored by hand, or a synced
// folder dragged into local Other Bookmarks. Its ids name other things here, so
// its indices are worthless and its decoy list is not ours to act on. The sweep
// falls back to appending, exactly as it does for a vault with no receipt.
async function testSweepIgnoresAReceiptItCannotProveIsLocal() {
  const mock = build();
  mock.nodes.get("1").syncing = false;
  mock.nodes.get("2").syncing = false;

  let engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const vault = findVault(mock);
  const node = receiptNodeOf(mock, mock.nodes.get(vault.id));
  const payload = receiptMod.decode(node.url);
  // Everything else about it is intact; only the one field that proves origin
  // now names a vault this profile has never had.
  node.url = receiptMod.buildUrl({ ...payload, vault: "90210" });

  engine = await uninstall(mock);
  await engine.recover({ maxHiddenMs: 0 });

  const titles = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);
  check("RC-4e a foreign receipt buys no exactness -- the items are appended",
    titles.slice(-4).join(",") === "Work,Headlines,Personal,Reading", titles.join(","));
  check("RC-4e and its decoy list is not treated as permission to delete",
    titles.filter((t) => ["Google", "Gmail", "Calendar", "Drive", "Maps", "News"].includes(t))
      .length === 6,
    titles.join(","));
  check("RC-4e the vault is still drained and cleaned up", !mock.nodes.has(vault.id));
}

// RC-5 a vault that arrived over sync from another computer. Its receipt names
// a vault id that means nothing here, so it must NOT be claimed as local -- the
// popup's whole decision rests on that flag, and getting it wrong empties a
// peer's vault onto the shared bar mid-meeting.
async function testPeerVaultIsNotClaimedAsLocal() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = findVault(mock);
  await engine.restore();

  // Rebuild it the way sync would deliver it: same titles, new local ids.
  const foreign = mock.seed("2", { title: VAULT_TITLE_LEGACY });
  mock.seed(foreign.id, {
    title: `⚠️ SecureShare recovery — your 4 bookmarks are IN THIS FOLDER.`,
    // A payload from the other machine: its own vault id, not this folder's.
    url: receiptMod.buildUrl(
      receiptMod.buildPayload({
        barId: "1", otherId: "2", vaultId: "99999",
        items: [["777", 0], ["778", 1]].map(([id, index]) => ({ id, index })),
      }),
      "https://example.invalid/r",
    ),
  });
  mock.seed(foreign.id, { title: "Their bookmark", url: "https://peer.example/" });

  const pending = await engine.pendingAdoptions();
  const found = pending.find((p) => p.id === foreign.id);
  check("RC-5 a peer's vault is reported", !!found);
  check("RC-5 but never as local", found?.local === false, JSON.stringify(found));
  check("RC-5 its receipt is still not counted as one of their bookmarks",
    found?.count === 1, JSON.stringify(found));

  const a = await engine.adoptVault(foreign.id);
  check("RC-5 adopting it anyway falls back to appending, not to bogus indices",
    a.ok === true && a.exact !== true, JSON.stringify(a));
  check("RC-5 and their bookmark lands on the bar",
    mock.nodes.get("1").children.some((c) => mock.nodes.get(c).title === "Their bookmark"));
  check("RC-5 while our own receipt is not handed to them as a bookmark of theirs",
    !mock.nodes.get("1").children.some((c) => isReceiptNode(mock.nodes.get(c))),
    mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title).join(","));
}

// RC-6 a vault that could not be fully drained keeps its receipt. It is the
// only remaining record of where the stuck items belong, and a half-finished
// restore must not also destroy the map.
async function testStuckVaultKeepsItsReceipt() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const vault = findVault(mock);

  const realMove = mock.api.bookmarks.move;
  const stuck = vaultItems(mock, mock.nodes.get(vault.id))[2];
  mock.api.bookmarks.move = async (id, dest) => {
    if (id === stuck) throw new Error("simulated stuck item");
    return realMove.call(mock.api.bookmarks, id, dest);
  };
  const r = await engine.restore();
  mock.api.bookmarks.move = realMove;

  check("RC-6 a stuck item fails the restore", r.ok === false && r.stuck.length === 1);
  check("RC-6 the vault survives", mock.nodes.has(vault.id));
  check("RC-6 and so does the receipt that says where the stuck item belongs",
    !!receiptOf(mock, mock.nodes.get(vault.id)));

  const again = await engine.restore();
  check("RC-6 a later retry finishes the job", again.ok === true);
  check("RC-6 and only then is the receipt discarded",
    ![...mock.nodes.values()].some(isReceiptNode));
}

// RC-7 recognition survives the product being renamed. The payload token is
// deliberately not a brand name, so a receipt written under the old name still
// decodes -- otherwise a rename would strand exactly the bookmarks this whole
// mechanism exists to hand back.
async function testReceiptSurvivesARename() {
  const url = receiptMod.buildUrl(
    receiptMod.buildPayload({
      barId: "1", otherId: "2", vaultId: "5",
      items: [{ id: "9", index: 3 }],
      decoys: [{ id: "10", title: "Google", url: "https://www.google.com/" }],
    }),
    "https://whatever-we-are-called-next.example/restore",
  );
  const rec = receiptMod.decode(url);
  check("RC-7 a receipt decodes regardless of the host it points at", !!rec);
  check("RC-7 with its payload intact",
    rec.items[0][1] === 3 && rec.decoys[0][1] === "Google", JSON.stringify(rec));
  check("RC-7 and is recognised as ours by the payload, not the title",
    receiptMod.isReceipt({ title: "renamed beyond recognition", url }));
  check("RC-7 an emoji title round-trips through the encoder",
    receiptMod.decode(receiptMod.buildUrl({ v: 1, items: [], note: "⚠️ ünïcödé" }))?.note ===
      "⚠️ ünïcödé");
  // site/restore.html has to decode the same bytes with no extension, no
  // modules and no imports, so it carries its own copy of these eight lines.
  // A copy that silently drifts would fail exactly when it is the only thing
  // left -- so the wire format is asserted here, against the real encoder.
  const asTheWebsiteWould = (u) => {
    let b64 = u.slice(u.indexOf("ssr1.") + 5).replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  };
  const site = asTheWebsiteWould(url);
  check("RC-7 the hosted page's standalone decoder reads the real wire format",
    site.v === 1 && site.items[0][1] === 3 && site.decoys[0][2] === "https://www.google.com/",
    JSON.stringify(site));

  check("RC-7 a mangled payload degrades to 'no receipt', never to a throw",
    receiptMod.decode("https://x.example/#ssr1.not-base64!!") === null &&
      receiptMod.decode("https://x.example/") === null &&
      receiptMod.decode(undefined) === null);
}

// RC-8 the uninstall URL. Off until there is a page to point at, because a dead
// link delivered at the moment of uninstall is worse than silence.
async function testUninstallUrl() {
  const hidden = { state: "hidden", startedAt: 1000, groups: [{ items: [1, 2, 3] }] };
  check("RC-8 nothing is set while no recovery page is configured",
    receiptMod.uninstallUrlFor(hidden) === "" && receiptMod.RECOVERY_BASE === null);
  check("RC-8 with one configured, it carries what was displaced and when",
    receiptMod.uninstallUrlFor(hidden, "https://x.example/r") ===
      "https://x.example/r?uninstalled=1&n=3&at=1000");
  check("RC-8 an uninstall with nothing hidden gets no tab at all",
    receiptMod.uninstallUrlFor({ state: "clear", groups: [] }, "https://x.example/r") === "" &&
      receiptMod.uninstallUrlFor(null, "https://x.example/r") === "");
  check("RC-8 and it can never exceed Chrome's 1023-character cap",
    receiptMod.uninstallUrlFor(hidden, "https://x.example/" + "p".repeat(1100)).length <=
      receiptMod.UNINSTALL_URL_MAX + "https://x.example/".length + 1100);

  const mock = build();
  const { engine } = await loadSw(mock);
  await engine.hide({ decoys: false });
  await flush(engine);
  check("RC-8 so a shipping build sets no uninstall URL today",
    mock.uninstallUrl === null, String(mock.uninstallUrl));
  await engine.restore();
}

// RC-9 a fresh install that finds stranded bookmarks opens the recovery page
// itself. A badge on a toolbar icon is not a channel to a user who does not yet
// know this extension is what has their bookmarks.
async function testFreshInstallOffersRecovery() {
  const mock = build();
  let engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  await uninstall(mock);

  const sw = await loadSw(mock);
  await mock._listeners.onInstalled[0]({ reason: "update" });
  await flush(sw.engine);
  check("RC-9 an auto-update does not open anything",
    mock.tabsCreated.length === 0, mock.tabsCreated.join(","));

  await mock._listeners.onInstalled[0]({ reason: "install" });
  await flush(sw.engine);
  check("RC-9 a fresh install opens the recovery page",
    mock.tabsCreated.length === 1 && mock.tabsCreated[0].endsWith("recovery.html"),
    mock.tabsCreated.join(","));

  // And never for a user whose bar was never hidden.
  const clean = build();
  const sw2 = await loadSw(clean);
  await clean._listeners.onInstalled[0]({ reason: "install" });
  await flush(sw2.engine);
  check("RC-9 but not for a first-time install with nothing stranded",
    clean.tabsCreated.length === 0, clean.tabsCreated.join(","));
}

// RC-10 "broke after a Chrome update", concretely: a namespace this worker
// touches at top level stops existing. Every listener is registered
// synchronously -- so one throw used to leave NONE of them registered,
// including onMessage, and the popup could not reach the engine to put the bar
// back by hand. The worker must come up degraded, not dead.
async function testBrokenApiDoesNotSilenceTheWorker() {
  const mock = build();
  mock.api.alarms.onAlarm.addListener = () => {
    throw new TypeError("chrome.alarms.onAlarm is undefined");
  };
  const { engine } = await loadSw(mock);

  check("RC-10 the worker still answers status", (await mock.message({ type: "status" })).hidden === false);
  const h = await mock.message({ type: "hide", options: { decoys: false } });
  check("RC-10 and can still hide", h.ok === true, JSON.stringify(h));
  const r = await mock.message({ type: "restore" });
  check("RC-10 and can still put everything back", r.ok === true, JSON.stringify(r));
  await flush(engine);
}

// --- the headline test ----------------------------------------------------

async function testFaultInjection(maxCalls = 90) {
  let repaired = 0, broken = 0;
  const brokenAt = [];

  for (let n = 1; n <= maxCalls; n++) {
    const mock = build();
    const before = JSON.stringify(mock.snapshot("1"));
    const engine = await loadEngine(mock);

    mock.failAt = n;
    try { await engine.hide({ decoys: true }); } catch { /* expected */ }
    if (!mock.failed) break; // ran out of calls to fail

    // Simulate the worker dying and restarting: fault cleared, recovery runs.
    mock.failAt = null;
    try { await engine.recover({ maxHiddenMs: 0 }); } catch { /* must not throw */ }
    try { await engine.recover({ maxHiddenMs: 0 }); } catch { /* idempotent 2nd pass */ }

    const after = JSON.stringify(mock.snapshot("1"));
    if (after === before) repaired++;
    else { broken++; brokenAt.push(n); }
  }
  return { repaired, broken, brokenAt };
}

// --------------------------------------------------------------------------
// SETTINGS, TUCK, BACKUP -- the three additions. Same discipline as the rest:
// a tuck/untuck round trip must be byte-identical, an import must be additive
// and touch nothing already there, and every one of these must refuse to run
// while the bar is hidden, because the bar then holds decoys and the real items
// are in the vault.

async function testDecoySettingControlsHide() {
  const mock = build();
  const engine = await loadEngine(mock);
  const before = JSON.stringify(mock.snapshot("1"));
  const barLen = () => mock.nodes.get("1").children.length;

  // Default settings: an option-less hide still drops decoys, exactly as the
  // automatic hide always has -- which is what keeps the live test unchanged.
  await engine.hide();
  check("decoy setting: default hide still leaves decoys", barLen() === 6, `${barLen()} on the bar`);
  await engine.restore();
  check("decoy setting: default restore is byte-identical", JSON.stringify(mock.snapshot("1")) === before);

  // Turned off: the same option-less hide now leaves the bar truly empty.
  await engine.setSettings({ decoys: false });
  await engine.hide();
  check("decoy setting: off leaves an empty bar", barLen() === 0, `${barLen()} on the bar`);
  await engine.restore();
  check("decoy setting: off still restores exactly", JSON.stringify(mock.snapshot("1")) === before);

  // An explicit option still wins over the setting -- the developer override.
  await engine.hide({ decoys: true });
  check("decoy setting: an explicit option overrides the setting", barLen() === 6, `${barLen()} on the bar`);
  await engine.restore();
  check("decoy setting: override restore is exact", JSON.stringify(mock.snapshot("1")) === before);
}

async function testTuckRoundTrip() {
  const mock = build();
  const engine = await loadEngine(mock);
  const before = JSON.stringify(mock.snapshot("1"));
  const barBefore = mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title);

  const t = await engine.tuck({ name: "Bookmarks" });
  check("tuck: reports success", t.ok === true && t.tucked === true, JSON.stringify(t));
  const barKids = mock.nodes.get("1").children;
  check("tuck: the bar is left holding one folder", barKids.length === 1, `${barKids.length} on the bar`);
  const folder = mock.nodes.get(barKids[0]);
  check("tuck: the folder is named as asked", folder.title === "Bookmarks" && folder.url === undefined, folder.title);
  const inside = folder.children.map((c) => mock.nodes.get(c).title);
  check("tuck: every bar item moved into it, in order",
    JSON.stringify(inside) === JSON.stringify(barBefore), inside.join(","));

  const st = await engine.tuckStatus();
  check("tuck: status reports tucked", st.tucked === true && st.folders === 1 && st.name === "Bookmarks", JSON.stringify(st));

  const u = await engine.untuck();
  check("untuck: reports success", u.ok === true && u.untucked === true, JSON.stringify(u));
  check("untuck: the bar is byte-identical to before it was tucked",
    JSON.stringify(mock.snapshot("1")) === before);
  const st2 = await engine.tuckStatus();
  check("untuck: status reports not tucked", st2.tucked === false && st2.folders === 0, JSON.stringify(st2));
}

async function testTuckComposesWithHide() {
  const mock = build();
  const engine = await loadEngine(mock);
  const before = JSON.stringify(mock.snapshot("1"));

  await engine.tuck({ name: "Bookmarks" });
  await engine.hide(); // default: decoys on
  const bar = mock.nodes.get("1").children.map((c) => mock.nodes.get(c));
  check("tuck+hide: the tuck folder is moved off the bar",
    !bar.some((n) => n.url === undefined && n.title === "Bookmarks"), bar.map((n) => n.title).join(","));
  check("tuck+hide: decoys stand in for it", bar.length === 6, `${bar.length} on the bar`);

  await engine.restore();
  const bar2 = mock.nodes.get("1").children.map((c) => mock.nodes.get(c));
  check("tuck+hide+restore: the tuck folder comes back",
    bar2.length === 1 && bar2[0].title === "Bookmarks" && bar2[0].url === undefined,
    bar2.map((n) => n.title).join(","));

  const u = await engine.untuck();
  check("tuck+hide+restore+untuck: everything is byte-identical",
    u.ok === true && JSON.stringify(mock.snapshot("1")) === before);
}

async function testTuckRefusesWhileHidden() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const before = JSON.stringify(mock.snapshot("0"));

  const t = await engine.tuck({ name: "Bookmarks" });
  check("tuck: refuses while the bar is hidden", t.ok === false && t.hidden === true, JSON.stringify(t));
  const u = await engine.untuck();
  check("untuck: refuses while the bar is hidden", u.ok === false && u.hidden === true, JSON.stringify(u));
  check("tuck: a refusal changes nothing in the tree", JSON.stringify(mock.snapshot("0")) === before);

  await engine.restore();
}

async function testTuckSweepsItemsAddedLater() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.tuck({ name: "Bookmarks" });
  await mock.api.bookmarks.create({ parentId: "1", title: "Fresh", url: "https://fresh.example/" });
  check("tuck: a bookmark added afterwards sits outside the folder",
    mock.nodes.get("1").children.length === 2);

  const t = await engine.tuck({ name: "Bookmarks" });
  check("tuck again: reuses the same folder rather than nesting a second",
    t.folders === 1 && mock.nodes.get("1").children.length === 1, JSON.stringify(t));
  const folder = mock.nodes.get(mock.nodes.get("1").children[0]);
  check("tuck again: the new bookmark is swept in",
    folder.children.map((c) => mock.nodes.get(c).title).includes("Fresh"));

  await engine.untuck();
}

async function testExportBarSerializes() {
  const mock = build();
  const engine = await loadEngine(mock);
  const res = await engine.exportBar("html");
  check("export: reports the bar's link count", res.ok === true && res.count === 6,
    JSON.stringify({ ok: res.ok, count: res.count }));
  check("export: produces a Netscape bookmark file",
    res.data.includes("<!DOCTYPE NETSCAPE-Bookmark-file-1>") && res.data.includes("<DL>"));
  check("export: a nested link survives with its URL",
    res.data.includes(">Leaf</A>") && res.data.includes("https://d.example/2"));

  const parsed = portableMod.parseNetscape(res.data);
  check("export: round-trips through the parser to the same link count",
    portableMod.countLinks(parsed) === 6, `${portableMod.countLinks(parsed)}`);

  const text = await engine.exportBar("text");
  check("export: the text outline shows folders and links",
    text.ok === true && text.data.includes("Work/") && text.data.includes("Docs — https://d.example/1"),
    text.data.slice(0, 60));
}

async function testExportRefusesWhileHidden() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: true });
  const res = await engine.exportBar("html");
  check("export: refuses while hidden rather than exporting decoys",
    res.ok === false && res.hidden === true, JSON.stringify(res));
  await engine.restore();
}

async function testImportAddsAFolderNonDestructively() {
  const mock = build();
  const engine = await loadEngine(mock);
  const before = JSON.stringify(mock.snapshot("1"));
  const barLenBefore = mock.nodes.get("1").children.length;

  const nodes = [
    { title: "Imported A", url: "https://a.import/" },
    { title: "Sub", children: [{ title: "B", url: "https://b.import/" }] },
  ];
  const res = await engine.importTree(nodes);
  check("import: reports what it created", res.ok === true && res.created === 2, JSON.stringify(res));

  const barKids = mock.nodes.get("1").children.map((c) => mock.nodes.get(c));
  check("import: adds exactly one folder to the bar", barKids.length === barLenBefore + 1);
  const folder = barKids[barKids.length - 1];
  check("import: into a dated folder", folder.url === undefined && /^Imported bookmarks/.test(folder.title), folder.title);
  const inside = folder.children.map((c) => mock.nodes.get(c));
  check("import: with the links and nesting intact",
    inside.length === 2 && inside[0].title === "Imported A" && inside[0].url === "https://a.import/" &&
      inside[1].url === undefined && mock.nodes.get(inside[1].children[0]).url === "https://b.import/",
    inside.map((n) => n.title).join(","));

  const originals = JSON.parse(before).c;
  const nowTop = mock.nodes.get("1").children.slice(0, barLenBefore).map((c) => mock.snapshot(c));
  check("import: leaves every existing bookmark exactly as it was",
    JSON.stringify(nowTop) === JSON.stringify(originals));
}

async function testImportRefusesWhileHidden() {
  const mock = build();
  const engine = await loadEngine(mock);
  await engine.hide({ decoys: false });
  const before = JSON.stringify(mock.snapshot("0"));
  const res = await engine.importTree([{ title: "X", url: "https://x.import/" }]);
  check("import: refuses while the bar is hidden", res.ok === false && res.hidden === true, JSON.stringify(res));
  check("import: a refusal creates nothing", JSON.stringify(mock.snapshot("0")) === before);
  await engine.restore();
}

// --- portable.js, exercised as the pure module the page ships ----------------

function shapeOf(nodes) {
  return (nodes ?? []).map((n) =>
    n.url === undefined || n.url === null
      ? { t: n.title, c: shapeOf(n.children) }
      : { t: n.title, u: n.url });
}

async function testPortableRoundTrip() {
  const tree = [
    { title: "Work", children: [
      { title: "Docs", url: "https://d.example/1" },
      { title: "Nested", children: [{ title: "Leaf", url: "https://d.example/2" }] },
    ] },
    { title: "Headlines", url: "https://n.example/" },
    { title: "Empty folder", children: [] },
  ];
  const html = portableMod.toNetscapeHtml(tree, { title: "Bookmarks" });
  const back = portableMod.parseNetscape(html);
  check("portable: a tree survives serialise -> parse unchanged",
    JSON.stringify(shapeOf(back)) === JSON.stringify(shapeOf(tree)), JSON.stringify(shapeOf(back)));
  check("portable: link count is preserved", portableMod.countLinks(back) === 3);
}

async function testPortableParsesAStandardExport() {
  const html = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
    '    <DT><H3 ADD_DATE="1600000000" LAST_MODIFIED="1600000001">Work</H3>',
    "    <DL><p>",
    '        <DT><A HREF="https://a.example/?x=1&amp;y=2" ADD_DATE="1600000002">A &amp; B</A>',
    '        <DT><A HREF="https://b.example/">B</A>',
    "    </DL><p>",
    '    <DT><A HREF="https://c.example/">C</A>',
    "</DL><p>",
  ].join("\n");
  const nodes = portableMod.parseNetscape(html);
  check("portable: a real browser export parses to the right shape",
    nodes.length === 2 && nodes[0].title === "Work" && nodes[0].children.length === 2 && nodes[1].title === "C",
    JSON.stringify(shapeOf(nodes)));
  check("portable: entities in a title are decoded", nodes[0].children[0].title === "A & B", nodes[0].children[0].title);
  check("portable: entities in a URL are decoded too",
    nodes[0].children[0].url === "https://a.example/?x=1&y=2", nodes[0].children[0].url);
  check("portable: ADD_DATE becomes a millisecond timestamp",
    nodes[0].children[0].dateAdded === 1600000002000, String(nodes[0].children[0].dateAdded));
  check("portable: three links found", portableMod.countLinks(nodes) === 3);
}

async function testPortableEscapesAndUnescapes() {
  const tree = [{ title: 'A & B < C > "D" 🎉', url: "https://x.example/?a=1&b=2&c=<>" }];
  const html = portableMod.toNetscapeHtml(tree);
  check("portable: markup characters are escaped in the file",
    html.includes("&amp;") && html.includes("&lt;") && html.includes("&quot;D&quot;"), "");
  const back = portableMod.parseNetscape(html);
  check("portable: a title with markup and an emoji round-trips exactly",
    back[0].title === 'A & B < C > "D" 🎉', JSON.stringify(back[0].title));
  check("portable: a URL with ampersands and angle brackets round-trips exactly",
    back[0].url === "https://x.example/?a=1&b=2&c=<>", back[0].url);
}

async function testPortableToleratesMalformedInput() {
  check("portable: empty input yields an empty tree",
    portableMod.parseNetscape("").length === 0 && portableMod.parseNetscape("not html at all").length === 0);
  // A stray unbalanced </DL> must not throw or corrupt what follows it.
  const salvaged = portableMod.parseNetscape(
    '</DL><DT><A HREF="https://ok.example/">Ok</A></DL></DL>',
  );
  check("portable: a malformed file degrades to what it can salvage, never throws",
    portableMod.countLinks(salvaged) === 1 && salvaged.some((n) => n.url === "https://ok.example/"),
    JSON.stringify(salvaged));
}

// --------------------------------------------------------------------------

const t0 = Date.now();
await testRoundTrip("after-removal");
await testRoundTrip("before-removal");
await testIdempotency();
await testNoDecoys();
await testEmptyBar();
await testManaged();
const hideMs = await testLargeBar();
await testUserAddsWhileHidden();
await testUserDeletesWhileHidden();
await testVaultDeletedWhileHidden();
await testDraggedBackThenHide();
await testNoIndexCascade();
await testVaultNukedReportsFailure();
await testRecoverKeepsHealthyHide();
await testManagedPositionPreserved();
await testForeignVaultUntouched();
await testUnreadableVaultNotDeleted();
await testUnpairableBarFailsHide();
await testRealGoogleBookmarkSurvives();
await testDecoyShapeDoesNotBlindVerification();
await testRestoreGivesUp();
await testReinstallReportsOrphanAndAdoptsOnRequest();
await testAdoptRejectsNonVault();
await testStrayDecoyClearedWithoutFailingRestore();
await testStrayDecoyNotAdoptedByNextHide();
await testDeletionDoesNotExposeTheBar();
await testDecoyJournalUsesIndexNotCount();
await testOwnEventsDoNotMarkDirty();
await testManagedPositionPreservedWithEventsLive();
await testExternalChangeStillMarksDirty();
await testWatchdogArmedOnce();
await testWatchdogSweepsAndBadges();
await testHookAnnouncesBeforeThePickerResolves();
await testHookReleasesOnCancelledPicker();
await testHookEndsOnStopSharingButton();
await testHookEndsOnPageInitiatedStop();
await testHookBeatsWhileSharingAndStopsWhenIdle();
await testHookIsTransparentToThePage();
await testHookDoesNotDoublePatch();
await testHookNeverBreaksThePage();
await testHookHoldsThePickerUntilTheBarIsDown();
await testHookFailsOpenWhenNobodyAnswers();
await testHookReleasesATabCapture();
await testHookKeepsHidingWhenTheSurfaceIsNotProvablyATab();
await testHookFollowsASurfaceChange();
await testBridgeRelaysAndRejects();
await testBridgeStaysSilentOnPagesThatNeverShare();
await testEndToEndShareHidesAndRestores();
await testEndToEndCancelledPickerRestores();
await testEndToEndTabShareReleasesTheBarMidMeeting();
await testToolbarIconTracksState();
await testTwoTabsShareOneHide();
await testNewShareReassertsTheHide();
await testTwoFramesOfOneTab();
await testStaleFrameExpiresOnTheWatchdog();
await testBeatReteachesAForgetfulWorker();
await testSessionMessagesAreBounded();
await testRecorderUrlMatching();
await testRecorderTabHidesAndRestores();
await testRecorderOutlivesTheBeatClock();
await testRecorderScanHealsBothDirections();
await testRecorderTabNavigatingAwayReleases();
await testRecorderScanDoesNotFightRestore();
await testRecorderAndPageShareCoexist();
await testRecorderDetectionFailsSafe();
await testReceiptIsWritten();
await testUninstalledWhileHiddenIsRecoverable();
await testReinstallRestoresPositionNotJustOrder();
await testReinstallToleratesAUserWhoHelped();
await testUnsyncedReinstallDrainsExactlyNotApproximately();
await testUnsyncedReinstallWithoutAReceiptStillAppends();
await testSweepNeverDeletesABookmarkTheIdNoLongerNames();
await testSweepIgnoresAReceiptItCannotProveIsLocal();
await testPeerVaultIsNotClaimedAsLocal();
await testStuckVaultKeepsItsReceipt();
await testReceiptSurvivesARename();
await testUninstallUrl();
await testFreshInstallOffersRecovery();
await testBrokenApiDoesNotSilenceTheWorker();
await testPopupWarnsAboutSyncOnlyWhenTheBarSyncs();
await testPopupExplainsAPeerHideInsteadOfOfferingRecovery();
await testDeveloperControlsShipToNobody();
await testDecoySettingControlsHide();
await testTuckRoundTrip();
await testTuckComposesWithHide();
await testTuckRefusesWhileHidden();
await testTuckSweepsItemsAddedLater();
await testExportBarSerializes();
await testExportRefusesWhileHidden();
await testImportAddsAFolderNonDestructively();
await testImportRefusesWhileHidden();
await testPortableRoundTrip();
await testPortableParsesAStandardExport();
await testPortableEscapesAndUnescapes();
await testPortableToleratesMalformedInput();
const fi = await testFaultInjection();
const fr = await testFaultInjectionRestore();

console.log("=".repeat(66));
console.log(`Skrim engine tests — ${Date.now() - t0}ms`);
console.log("=".repeat(66));
console.log(`  assertions passed : ${pass}`);
console.log(`  assertions failed : ${fail}`);
console.log(`  1000-item hide    : ${hideMs}ms`);
console.log(`\n  FAULT INJECTION (kill the worker at call N, then recover):`);
console.log(`    fully repaired  : ${fi.repaired}`);
console.log(`    NOT repaired    : ${fi.broken}`);
if (fi.brokenAt.length) console.log(`    broken at calls : ${fi.brokenAt.join(", ")}`);
console.log(`\n  FAULT INJECTION — RESTORE phase:`);
console.log(`    fully repaired  : ${fr.repaired}`);
console.log(`    NOT repaired    : ${fr.broken}`);
if (fr.brokenAt.length) console.log(`    broken at calls : ${fr.brokenAt.join(", ")}`);

if (failures.length) {
  console.log(`\n  FAILURES:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log("=".repeat(66));
fs.rmSync(BUILD, { recursive: true, force: true });
process.exit(fail === 0 && fi.broken === 0 && fr.broken === 0 ? 0 : 1);
