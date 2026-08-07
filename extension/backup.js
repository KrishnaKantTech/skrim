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
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `skrim-bookmarks-${today()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    setResult($("exportResult"), "ok", "Saved to your downloads.");
  } catch (err) {
    setResult($("exportResult"), "bad", `Could not save: ${String(err?.message ?? err)}`);
  }
  btn.blur();
};

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
  try {
    await navigator.clipboard.writeText(res.data);
    setResult($("exportResult"), "ok", `Copied ${plural(res.count ?? 0, "bookmark")} to the clipboard.`);
  } catch {
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

refresh();
