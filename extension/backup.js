// The backup page.
//
// Copy, download and import for the bookmarks bar, on a full page rather than in
// the popup for one hard reason: a file dialog steals focus, and a popup closes
// the instant it loses focus -- so <input type="file"> and a Save-As dialog both
// die there. A tab has the lifetime these need.
//
// Like recovery.js, it prefers the worker (which owns the one engine chain, so a
// backup can never interleave with a hide) and falls back to driving the engine
// in this page's own context if the worker will not answer. The parsing and
// serialising are the pure functions in portable.js; the only thing this file
// adds is the browser plumbing -- clipboard, Blob download, FileReader.

import * as engine from "./src/engine.js";
import * as portable from "./src/portable.js";
import { copyBookmarks } from "./src/clipboard.js";

const $ = (id) => document.getElementById(id);
const WORKER_TIMEOUT_MS = 2000;

async function call(type, direct, extra = {}) {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type, ...extra }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("worker timeout")), WORKER_TIMEOUT_MS),
      ),
    ]);
    if (res !== undefined && res !== null) return res;
  } catch {
    /* the worker is the preference, not the requirement */
  }
  return direct();
}

const getStatus = () => call("status", () => engine.status());
const exportBar = (format) => call("exportBar", () => engine.exportBar(format), { format });
const importBookmarks = (nodes) =>
  call("importBookmarks", () => engine.importTree(nodes), { nodes });
const listBackups = () => call("listBackups", () => engine.listBackups());
const makeBackup = (label) =>
  call("makeBackup", () => engine.snapshotBar("manual", { label, force: true }), { label });
const backupFile = (id) => call("backupFile", () => engine.backupFile(id), { id });
const restoreBackup = (id, opts = {}) =>
  call("restoreBackup", () => engine.restoreBackup(id, opts), { id, ...opts });
const deleteBackup = (id) => call("deleteBackup", () => engine.deleteBackup(id), { id });
const setSettings = (patch) =>
  call("setSettings", () => engine.setSettings(patch), { patch });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function setResult(el, tone, text) {
  el.dataset.tone = tone;
  el.textContent = text;
}

// --------------------------------------------------------------------- state

// Fetched on load only to show the count; Download and Copy each re-fetch fresh
// when clicked, so nothing here can go stale under the user.
let barHidden = false;

async function refresh() {
  let status = null;
  try {
    status = await getStatus();
  } catch {
    /* fall through -- treat as not hidden and let the export call decide */
  }
  barHidden = !!status?.hidden;
  $("banner").hidden = !barHidden;

  if (barHidden) {
    $("exportLede").textContent =
      "Your bookmarks are hidden right now, so there is nothing safe to back up yet.";
    $("download").disabled = true;
    $("copy").disabled = true;
    $("importBtn").disabled = true;
    $("importFile").disabled = true;
    // The snapshot card stays rendered while the bar is hidden. Taking one and
    // putting one back are both refused (they would capture, or overwrite, the
    // placeholder links) -- but Download and Delete work off stored copies and
    // have no reason to be locked, and someone mid-share reaching for a backup
    // is exactly who needs the download button.
    await renderSnaps();
    return;
  }

  $("importBtn").disabled = false;
  $("importFile").disabled = false;

  const res = await exportBar("html").catch(() => null);
  if (res?.ok) {
    const n = res.count ?? 0;
    $("exportLede").innerHTML =
      n === 0
        ? "Your bookmarks bar is empty — there is nothing to back up yet."
        : `Your bookmarks bar holds <span class="count">${plural(n, "bookmark")}</span>, folders and all.`;
    $("download").disabled = n === 0;
    $("copy").disabled = n === 0;
  } else if (res?.hidden) {
    barHidden = true;
    $("banner").hidden = false;
    $("exportLede").textContent =
      "Your bookmarks are hidden right now, so there is nothing safe to back up yet.";
  } else {
    $("exportLede").textContent = "Could not read your bookmarks bar.";
  }

  await renderSnaps();
}

// -------------------------------------------------------------------- export

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

$("download").onclick = async () => {
  const btn = $("download");
  // Fetch fresh rather than trusting the copy read at page load: the bar may
  // have changed in another tab while this page sat open.
  const res = await exportBar("html").catch(() => null);
  const html = res?.ok ? res.data : null;
  if (!html) {
    setResult(
      $("exportResult"),
      "bad",
      res?.hidden ? "Restore your bar first." : "Could not read your bookmarks to save.",
    );
    return;
  }
  try {
    saveFile(`skrim-bookmarks-${today()}.html`, html);
    setResult($("exportResult"), "ok", "Saved to your downloads.");
  } catch (err) {
    setResult($("exportResult"), "bad", `Could not save: ${String(err?.message ?? err)}`);
  }
  btn.blur();
};

// As text and as links, for a note or a message. Not for Chrome's bookmark
// manager -- it pastes only from its own internal format, which nothing outside
// Chrome can write; that is what the download and the import below are for. The
// success message says so, because the button alone reads like it should work.
$("copy").onclick = async () => {
  const res = await exportBar("text").catch(() => null);
  if (!res?.ok || !res.data) {
    setResult(
      $("exportResult"),
      res?.hidden ? "bad" : "muted",
      res?.hidden ? "Restore your bar first." : "Nothing to copy.",
    );
    return;
  }
  if (await copyBookmarks(res.data, res.rich)) {
    setResult(
      $("exportResult"),
      "ok",
      `Copied ${plural(res.count ?? 0, "bookmark")} as text and links — ready to paste into a note or a message. ` +
        "To put them back into a browser, use Download file and that browser's own import.",
    );
  } else {
    setResult($("exportResult"), "bad", "The browser blocked the copy. Try the download instead.");
  }
};

// -------------------------------------------------------------------- import

$("importBtn").onclick = () => $("importFile").click();

$("importFile").onchange = async (e) => {
  const input = e.currentTarget;
  const file = input.files && input.files[0];
  if (!file) return;
  setResult($("importResult"), "muted", `Reading ${file.name}…`);
  let text = "";
  try {
    text = await file.text();
  } catch (err) {
    setResult($("importResult"), "bad", `Could not read the file: ${String(err?.message ?? err)}`);
    input.value = "";
    return;
  }

  const nodes = portable.parseNetscape(text);
  const found = portable.countLinks(nodes);
  if (found === 0) {
    setResult(
      $("importResult"),
      "bad",
      "No bookmarks found in that file. It should be a bookmark file exported from a browser (.html).",
    );
    input.value = "";
    return;
  }

  setResult($("importResult"), "muted", `Importing ${plural(found, "bookmark")}…`);
  const res = await importBookmarks(nodes).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));
  input.value = "";

  if (res?.ok) {
    setResult(
      $("importResult"),
      "ok",
      `Imported ${plural(res.created ?? found, "bookmark")} into a new folder, “${res.folderTitle}”, on your bar.`,
    );
    refresh();
  } else if (res?.hidden) {
    setResult($("importResult"), "bad", "Your bar is hidden right now. Restore it first, then import.");
  } else {
    setResult($("importResult"), "bad", `Could not import: ${res?.error ?? "unknown error"}.`);
  }
};

// ------------------------------------------------------------------- backups
//
// The two cards above are about a file the user carries away. This one is about
// the copies Skrim keeps for itself: one before every hide, one a day, plus
// whatever is taken by hand. The engine owns all of it -- taking a snapshot,
// diffing one back onto the bar, retention -- so everything below is rendering
// and one confirm step.
//
// Nothing here builds markup from a string. A bookmark title, a folder name and
// a backup's own label are all arbitrary user text, and this page renders them
// beside a button that deletes things.

const KIND_WORDS = {
  prehide: "before hide",
  daily: "daily",
  manual: "manual",
  safety: "safety",
};

function whenText(ms) {
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

function sizeText(bytes) {
  if (!(bytes > 0)) return "";
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Save a string as a file the user's downloads. Shared by both save paths. */
function saveFile(name, text) {
  const blob = new Blob([text], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

let snapBusy = false;

function setSnapBusy(on) {
  snapBusy = on;
  for (const b of document.querySelectorAll("#snapList button, #backupNow")) {
    b.disabled = on || (b.dataset.needsBar === "1" && barHidden);
  }
}

async function renderSnaps() {
  const res = await listBackups().catch(() => null);
  const list = $("snapList");
  list.textContent = "";

  if (!res?.entries) {
    $("snapEmpty").hidden = false;
    $("snapEmpty").textContent = "Could not read your backups.";
    $("snapFoot").hidden = true;
    return;
  }

  $("autoToggle").checked = res.autoBackup !== false;
  $("autoHint").textContent =
    res.autoBackup !== false
      ? "A copy of your bar is saved right before every hide, and once a day if anything changed. Everything stays on this computer."
      : "Automatic backups are off. Nothing is saved before a hide. You can still take one by hand below, and the backups already here are kept.";

  $("snapEmpty").hidden = res.entries.length > 0;
  if (res.entries.length === 0) {
    $("snapEmpty").textContent =
      res.autoBackup !== false
        ? "No backups yet. The first one is saved before your next hide."
        : "No backups yet.";
  }

  for (const e of res.entries) {
    list.appendChild(snapRow(e));
  }

  const use = res.usage ?? {};
  $("snapFoot").hidden = res.entries.length === 0;
  $("snapFoot").textContent =
    `${res.entries.length} ${res.entries.length === 1 ? "backup" : "backups"} kept` +
    (use.bytes ? `, ${sizeText(use.bytes)} in all` : "") +
    ". Older ones are dropped by count, never by age — a backup is never deleted just for being old.";

  setSnapBusy(false);
}

function snapRow(e) {
  const li = document.createElement("li");
  li.className = "snap";

  const text = document.createElement("div");
  text.className = "snap__text";

  if (e.label) {
    const name = document.createElement("span");
    name.className = "snap__name";
    name.textContent = e.label;
    text.appendChild(name);
  }

  const when = document.createElement("span");
  when.className = "snap__when";
  when.textContent = whenText(e.at);
  const tag = document.createElement("span");
  tag.className = "tag";
  tag.dataset.kind = e.kind;
  tag.textContent = KIND_WORDS[e.kind] ?? e.kind;
  when.appendChild(tag);
  text.appendChild(when);

  const meta = document.createElement("span");
  meta.className = "snap__meta";
  const bits = [plural(e.count ?? 0, "bookmark")];
  if (e.folders > 0) bits.push(plural(e.folders, "folder"));
  if (e.bytes) bits.push(sizeText(e.bytes));
  meta.textContent = bits.join(" · ");
  text.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "snap__actions";
  // Restoring reads and rewrites the bar, so it needs a bar that is not hidden.
  // Downloading reads a copy out of storage and needs nothing at all -- which
  // is exactly the button someone wants when their bar is mid-share.
  actions.appendChild(button("Put back", "primary", () => askRestore(e), true));
  actions.appendChild(button("Download", "", () => downloadSnap(e), false));
  actions.appendChild(button("Delete", "", () => removeSnap(e), false));

  li.appendChild(text);
  li.appendChild(actions);
  return li;
}

function button(label, cls, onClick, needsBar) {
  const b = document.createElement("button");
  b.type = "button";
  if (cls) b.className = cls;
  b.textContent = label;
  if (needsBar) {
    b.dataset.needsBar = "1";
    b.disabled = barHidden;
    if (barHidden) b.title = "Restore your bar first.";
  }
  b.onclick = onClick;
  return b;
}

// ---------------------------------------------------------------- the confirm

let pending = null;

/**
 * Ask the worker what the restore WOULD do, then show those numbers.
 *
 * A dry run, not an estimate: it walks the same matcher against the same tree
 * and reports the same counts, so the figures the user agrees to are the ones
 * that are about to happen.
 */
async function askRestore(entry) {
  setSnapBusy(true);
  setResult($("snapResult"), "muted", "Working out what would change…");
  const plan = await restoreBackup(entry.id, { dry: true }).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));
  setSnapBusy(false);

  if (!plan?.ok) {
    setResult(
      $("snapResult"),
      "bad",
      plan?.hidden
        ? "Your bar is hidden right now. Restore it first."
        : `Could not read that backup: ${plan?.error ?? "unknown error"}.`,
    );
    return;
  }

  pending = entry;
  const s = plan.stats ?? {};
  $("confirmTitle").textContent = "Put your bar back?";
  $("confirmLede").textContent =
    `Your bookmarks bar will be set back to how it looked on ${whenText(entry.at)}` +
    (entry.label ? ` — “${entry.label}”.` : ".");

  const rows = [
    ["Moved back into place", s.moved ?? 0, false],
    ["Already right, left alone", s.kept ?? 0, false],
    ["Added back", s.created ?? 0, false],
    ["Renamed", s.renamed ?? 0, false],
    ["Deleted", (s.removed ?? 0) + (s.removedFolders ?? 0), true],
  ];
  const ul = $("confirmPlan");
  ul.textContent = "";
  for (const [label, n, warn] of rows) {
    const li = document.createElement("li");
    if (n === 0) li.dataset.zero = "1";
    if (warn && n > 0) li.dataset.warn = "1";
    const k = document.createElement("span");
    k.textContent = label;
    const v = document.createElement("b");
    v.textContent = String(n);
    li.append(k, v);
    ul.appendChild(li);
  }

  const notes = [
    "A copy of your bar as it is right now is saved first, so this can be undone.",
  ];
  // Moving keeps a bookmark's identity, so only what has to be made again
  // loses its age. Saying it only when it is true keeps it a fact, not noise.
  if ((s.created ?? 0) > 0) {
    notes.push(
      `Chrome will not let an extension set a bookmark's date, so ${plural(s.created, "bookmark")} added back will show today's date.`,
    );
  }
  if (plan.skippedBars > 0) {
    notes.push("One bookmarks bar on this profile is not in this backup and will be left alone.");
  }
  $("confirmNote").textContent = notes.join(" ");
  setResult($("snapResult"), "muted", "");
  $("confirmDialog").showModal();
}

$("confirmCancel").onclick = () => {
  pending = null;
  $("confirmDialog").close();
};

$("confirmGo").onclick = () => runRestore("diff");
$("confirmFolder").onclick = () => runRestore("folder");

async function runRestore(mode) {
  const entry = pending;
  pending = null;
  $("confirmDialog").close();
  if (!entry) return;

  setSnapBusy(true);
  setResult($("snapResult"), "muted", "Putting your bookmarks back…");
  const res = await restoreBackup(entry.id, { mode }).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));

  if (!res?.ok) {
    setResult(
      $("snapResult"),
      "bad",
      res?.hidden
        ? "Your bar is hidden right now. Restore it first, then try again."
        : `Could not restore: ${res?.error ?? "unknown error"}.`,
    );
    setSnapBusy(false);
    return;
  }

  if (mode === "folder") {
    setResult(
      $("snapResult"),
      "ok",
      `Added ${plural(res.created ?? 0, "bookmark")} to a new folder, “${res.folderTitle}”, on your bar. Nothing else was changed.`,
    );
  } else {
    const s = res.stats ?? {};
    const did = [];
    if (s.moved) did.push(`${plural(s.moved, "bookmark")} moved back`);
    if (s.created) did.push(`${plural(s.created, "bookmark")} added`);
    if (s.renamed) did.push(`${plural(s.renamed, "name")} put right`);
    const gone = (s.removed ?? 0) + (s.removedFolders ?? 0);
    if (gone) did.push(`${gone} removed`);
    setResult(
      $("snapResult"),
      s.failed ? "bad" : "ok",
      (did.length ? `Your bar is back — ${did.join(", ")}.` : "Your bar was already exactly right.") +
        (s.failed ? ` ${plural(s.failed, "item")} could not be placed; running this again usually finishes it.` : "") +
        " The copy taken just before this is at the top of the list, if you want it back.",
    );
  }
  await refresh();
}

// ------------------------------------------------------------- the other rows

async function downloadSnap(entry) {
  setSnapBusy(true);
  const file = await backupFile(entry.id).catch(() => null);
  setSnapBusy(false);
  if (!file?.ok) {
    setResult($("snapResult"), "bad", "Could not read that backup.");
    return;
  }
  try {
    saveFile(file.name, file.data);
    setResult($("snapResult"), "ok", `Saved ${file.name} to your downloads.`);
  } catch (err) {
    setResult($("snapResult"), "bad", `Could not save: ${String(err?.message ?? err)}`);
  }
}

async function removeSnap(entry) {
  // No confirm dialog. Deleting one backup destroys nothing the user has --
  // their bookmarks are untouched -- and a second modal for it would train
  // people to click through the one that does matter.
  setSnapBusy(true);
  const res = await deleteBackup(entry.id).catch(() => null);
  if (res?.ok) setResult($("snapResult"), "muted", "Backup deleted.");
  else setResult($("snapResult"), "bad", "Could not delete that backup.");
  await renderSnaps();
}

$("backupNow").onclick = async () => {
  setSnapBusy(true);
  setResult($("snapResult"), "muted", "Saving a copy…");
  const label = $("backupLabel").value;
  const res = await makeBackup(label).catch((err) => ({
    ok: false,
    error: String(err?.message ?? err),
  }));
  if (res?.ok) {
    $("backupLabel").value = "";
    setResult($("snapResult"), "ok", "Saved. It is at the top of the list.");
  } else {
    setResult(
      $("snapResult"),
      "bad",
      res?.hidden
        ? "Your bar is hidden right now, so a backup would capture the placeholder links. Restore it first."
        : res?.tooBig
          ? "Your bookmarks bar is too large to keep a copy of inside the extension. Use Download file above instead."
          : `Could not save a copy: ${res?.error ?? "unknown error"}.`,
    );
  }
  await renderSnaps();
};

$("autoToggle").onchange = async (e) => {
  const want = e.currentTarget.checked;
  const res = await setSettings({ autoBackup: want }).catch(() => null);
  if (!res) {
    // Put the switch back to what is actually stored rather than leaving it
    // showing a preference that was never saved.
    e.currentTarget.checked = !want;
    setResult($("snapResult"), "bad", "Could not save that setting.");
    return;
  }
  await renderSnaps();
};

refresh();
