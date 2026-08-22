// The recovery page.
//
// This exists for the failure the popup cannot cover. The popup is a view over
// the service worker, so a worker that will not start -- an API renamed by a
// Chrome release, a corrupted profile, a bug in our own top-level code -- takes
// the popup down with it, and the user is left with an empty bar and no button.
//
// So this page talks to the worker FIRST, because a live worker owns the engine
// and two engines mutating the same tree at once is a race worth not having,
// and falls back to driving the engine in this page's own context when nothing
// answers. Extension pages are ordinary pages: they load whether or not the
// worker does.

import * as engine from "./src/engine.js";
import * as receipt from "./src/receipt.js";

const $ = (id) => document.getElementById(id);

const WORKER_TIMEOUT_MS = 2000;

/**
 * Ask the worker; drive the engine directly if it does not answer. The timeout
 * is the point: sendMessage to a worker that is failing to boot can hang rather
 * than reject, and this page is the last thing standing when that happens.
 */
async function call(type, direct, extra = {}) {
  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type, ...extra }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("worker timeout")), WORKER_TIMEOUT_MS)
      ),
    ]);
    if (res !== undefined && res !== null) return res;
  } catch {
    /* fall through -- the worker is the preference, not the requirement */
  }
  return direct();
}

const pendingAdoptions = () =>
  call("pendingAdoptions", () => engine.pendingAdoptions());

const adoptVault = (id) =>
  call("adoptVault", () => engine.adoptVault(id), { id });

// ---------------------------------------------------------------------------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const when = (ts) => (ts ? new Date(ts).toLocaleString() : "an unknown time");

function summary(r) {
  if (r?.ok) {
    const bits = [`Restored ${plural(r.restored ?? 0, "bookmark")}`];
    if (r.exact) bits.push("in their original positions");
    if (r.missing?.length) bits.push(`${r.missing.length} had been deleted`);
    return { tone: "ok", text: `${bits.join(", ")}.` };
  }
  return {
    tone: "bad",
    text:
      `Could not finish: ${r?.error ?? "some bookmarks would not move"}. ` +
      `Nothing was lost — they are still in the folder. Try again, or move them by hand.`,
  };
}

function card(v) {
  const el = document.createElement("div");
  el.className = "card";
  // A vault whose receipt names a vault id that is not its own arrived over
  // sync from another computer, where it may be a hide that is still running.
  // Draining it would empty that machine's bar onto the shared, synced one --
  // so it is shown, flagged, and left entirely to the user.
  el.dataset.origin = v.local ? "mine" : "peer";

  const what = typeof v.count === "number" ? plural(v.count, "bookmark") : "Bookmarks";
  // Agrees with the count, the same way the popup's card does. A page that
  // exists to reassure someone whose bar is empty cannot afford to read as
  // though nobody proof-read it.
  const one = v.count === 1;
  const h = document.createElement("h3");
  h.textContent = v.local
    ? `${what} hidden on this computer`
    : `${what} in a folder from another computer`;

  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = v.local
    ? `Hidden ${when(v.hidAt ?? v.dateAdded)}. ` +
      (one
        ? "It can go back exactly where it was."
        : "They can go back exactly where they were.")
    : `Created ${when(v.dateAdded)}. If that computer is sharing its screen right now, ` +
      `putting these back will un-hide its bar too. If it is not, this is safe.`;

  const btn = document.createElement("button");
  btn.textContent = v.local ? "Put them back" : "Put them back anyway";
  if (!v.local) btn.className = "quiet";

  const result = document.createElement("p");
  result.className = "result";

  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = "Working…";
    const r = await adoptVault(v.id).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    const s = summary(r);
    result.dataset.tone = s.tone;
    result.textContent = s.text;
    btn.textContent = s.tone === "ok" ? "Done" : "Try again";
    btn.disabled = s.tone === "ok";
    if (s.tone === "ok") setTimeout(load, 900);
  };

  el.append(h, meta, btn, result);
  return el;
}

async function load() {
  const host = $("vaults");
  let pending = [];
  try {
    pending = (await pendingAdoptions()) ?? [];
  } catch (err) {
    host.innerHTML = "";
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = `Could not read your bookmarks: ${String(err?.message ?? err)}`;
    host.append(p);
    return;
  }

  host.innerHTML = "";
  if (pending.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      "Nothing is waiting. Every bookmark this extension has hidden is back on your bar.";
    host.append(p);
  } else {
    for (const v of pending) host.append(card(v));
  }

  showDecoys(pending);
}

/**
 * The one fact a stranded user cannot work out alone: which of the links on
 * their bar are ours. Taken from the receipts when there are any, because those
 * name the exact bookmarks created for THIS hide, and from the built-in list
 * otherwise so the answer is never simply missing.
 */
function showDecoys(pending) {
  const fromReceipts = pending.flatMap((v) => v.decoys ?? []);
  const seen = new Map();
  for (const d of fromReceipts) seen.set(`${d.title}|${d.url}`, d);
  const list = [...seen.values()];
  if (list.length === 0) {
    $("decoyList").textContent = "";
    return;
  }
  $("decoyList").textContent =
    "On the bar, these are ours — safe to delete: " +
    list.map((d) => `${d.title} (${d.url})`).join(", ");
}

/**
 * A receipt opened from the bookmark itself. The payload is in the fragment, so
 * it is readable with no worker, no storage and -- once this page has a hosted
 * twin -- no extension at all.
 */
function showReceiptFromUrl() {
  const payload = receipt.decode(location.href);
  if (!payload) return;
  $("receiptNote").textContent =
    `This receipt was written ${when(payload.at)} and covers ` +
    `${plural(payload.items.length, "bookmark")}. They belong on the bookmarks bar, ` +
    `at the positions recorded here. If the folder is still in Other bookmarks, ` +
    `use the button above and they will go back exactly.`;
}

/**
 * The copies Skrim keeps for itself, mentioned here because this page is the one
 * place someone arrives already knowing something has gone wrong -- and a
 * snapshot taken before the last hide is a better answer than dragging a folder
 * around by hand.
 *
 * Below the vault list, never above it: the vault holds the actual bookmarks
 * that are missing right now, and a backup is the fallback when putting them
 * back does not go right.
 */
async function showBackups() {
  let res = null;
  try {
    res = await call("listBackups", () => engine.listBackups());
  } catch {
    return; /* the box stays hidden; the manual steps below always work */
  }
  const n = res?.entries?.length ?? 0;
  if (n === 0) return;
  const newest = res.entries[0];
  $("backupsNote").textContent =
    `Skrim has ${plural(n, "copy", "copies")} of how your bookmarks bar looked, kept on this ` +
    `computer. The most recent is from ${when(newest.at)} and holds ` +
    `${plural(newest.count ?? 0, "bookmark")}. Any of them can be put straight back onto ` +
    `the bar, or downloaded as a file.`;
  $("backupsBox").hidden = false;
}

$("openBackups").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("backup.html") });

showReceiptFromUrl();
load();
showBackups();
