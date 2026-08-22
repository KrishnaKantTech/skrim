// Local bookmark-bar snapshots.
//
// Skrim moves your bookmarks. When a move goes wrong -- and one did, on
// 2026-08-21, stranding 11 of 12 -- the only thing that gets them back is a
// copy of what the bar looked like beforehand. This file is that copy: taken
// automatically before every hide and once a day, kept inside the extension,
// and replayed by engine.js.
//
// It deliberately touches NOTHING but chrome.storage.local. No bookmark reads,
// no DOM, no chrome.bookmarks -- so the whole of the tricky part (dedupe,
// retention, ids) is exercisable in Node the way portable.js is, and the engine
// stays the one file that mutates a tree.
//
// Storage shape, one key per snapshot plus a small index:
//
//   skrim.backups.index -> [{ id, at, kind, count, folders, bytes, hash, label }]
//   skrim.backup.<id>   -> { v, at, kind, label, groups: [{ syncing, children }] }
//   skrim.backups.meta  -> { lastAutoAt }
//
// The index is separate on purpose: listing twenty backups must not deserialise
// twenty bookmark trees, which is the difference between a page that opens
// instantly and one that stalls for a heavy bar.

const INDEX_KEY = "skrim.backups.index";
const META_KEY = "skrim.backups.meta";
const SNAP_PREFIX = "skrim.backup.";

export const VERSION = 1;

/**
 * Why a snapshot was taken. The words matter -- they are what the list shows --
 * but the BUCKET below is what retention counts, because "before a hide" and
 * "once a day" are the same promise made twice and should not each get their
 * own quota.
 */
export const Kind = {
  PREHIDE: "prehide",
  DAILY: "daily",
  MANUAL: "manual",
  SAFETY: "safety",
};

const BUCKET = {
  [Kind.PREHIDE]: "auto",
  [Kind.DAILY]: "auto",
  [Kind.MANUAL]: "manual",
  [Kind.SAFETY]: "safety",
};

/** Plain words for the UI. Never shown as the raw kind. */
export const LABELS = {
  [Kind.PREHIDE]: "before hide",
  [Kind.DAILY]: "daily",
  [Kind.MANUAL]: "manual",
  [Kind.SAFETY]: "safety",
};

// Retention is by COUNT ONLY, never by age. A backup that expires while the
// user is away from the computer is a backup that is gone at exactly the moment
// it was for. The byte budget below is a second, independent ceiling so a
// pathological bar cannot fill chrome.storage.local (10 MB) and take the
// journal down with it -- and it too never empties a bucket.
export const CAPS = { auto: 15, manual: 10, safety: 5 };
export const BYTE_BUDGET = 4 * 1024 * 1024;
/** A single snapshot larger than this is refused rather than stored. */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** Order the byte budget evicts in. Automatic copies are the cheapest to lose. */
const EVICT_ORDER = ["auto", "safety", "manual"];

// ---------------------------------------------------------------------------
// Ids and names.

const p2 = (n) => String(n).padStart(2, "0");

/**
 * `20260821-184032-prehide` -- LOCAL date and time to the second, then the
 * kind. Local, not UTC, because the same string is what the user sees rendered
 * in their own timezone in the list; a UTC id would sort correctly and read
 * wrongly. Sorts lexicographically in the same order it sorts chronologically,
 * which is what makes the index cheap to keep ordered.
 */
export function makeId(at, kind, taken = new Set()) {
  const d = new Date(at);
  const stem =
    `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}` +
    `-${kind}`;
  if (!taken.has(stem)) return stem;
  // Two snapshots in the same second of the same kind. Rare, but a hide
  // immediately after a manual backup can do it, and an id collision would
  // silently overwrite the older one.
  for (let n = 2; n < 1000; n++) {
    const alt = `${stem}-${n}`;
    if (!taken.has(alt)) return alt;
  }
  return `${stem}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A user-typed name, made safe to be part of a filename. */
export function slugify(s, max = 40) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * `skrim-backup-2026-08-21-1840-before-hide.html`, or the user's own name in
 * place of the kind when they gave one.
 */
export function fileNameFor(entry) {
  const d = new Date(entry?.at ?? Date.now());
  const stamp =
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `-${p2(d.getHours())}${p2(d.getMinutes())}`;
  const tail = slugify(entry?.label) || slugify(LABELS[entry?.kind] ?? entry?.kind ?? "backup");
  return `skrim-backup-${stamp}-${tail || "backup"}.html`;
}

// ---------------------------------------------------------------------------
// Fingerprint.
//
// Two 32-bit FNV-1a passes over a canonical rendering of the tree, with
// different offsets, concatenated. A 64-bit fingerprint plus the exact link
// count and canonical length are all compared before two snapshots are called
// identical -- because the ONLY consequence of a false match is a backup that
// was never taken, which is the one failure this whole file exists to prevent.

function canonical(groups) {
  const out = [];
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      if (n.url === undefined || n.url === null) {
        out.push("F ", String(n.title ?? ""), " [");
        walk(n.children);
        out.push("] ");
      } else {
        out.push("L ", String(n.title ?? ""), " ", String(n.url), " ");
      }
    }
  };
  for (const g of groups ?? []) {
    out.push("G ", String(g.syncing), " [");
    walk(g.children);
    out.push("] ");
  }
  return out.join("");
}

function fnv(str, offset) {
  let h = offset >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fingerprint(groups) {
  const s = canonical(groups);
  const a = fnv(s, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv(s, 0x9e3779b9).toString(16).padStart(8, "0");
  return { hash: `${a}${b}`, len: s.length };
}

/** Links (not folders) across every group -- what the UI calls "N bookmarks". */
export function countLinks(groups) {
  let n = 0;
  const walk = (nodes) => {
    for (const c of nodes ?? []) {
      if (c.url === undefined || c.url === null) walk(c.children);
      else n++;
    }
  };
  for (const g of groups ?? []) walk(g.children);
  return n;
}

/** Folders across every group. Shown next to the count so a folder-heavy backup
 *  of an otherwise thin bar does not read as an almost-empty one. */
export function countFolders(groups) {
  let n = 0;
  const walk = (nodes) => {
    for (const c of nodes ?? []) {
      if (c.url === undefined || c.url === null) {
        n++;
        walk(c.children);
      }
    }
  };
  for (const g of groups ?? []) walk(g.children);
  return n;
}

/** Every group's children in one list, for download and for counting. */
export function flatten(groups) {
  const out = [];
  for (const g of groups ?? []) for (const c of g.children ?? []) out.push(c);
  return out;
}

// ---------------------------------------------------------------------------
// Storage.
//
// Every read is defensive. A corrupt or half-written index must degrade to "no
// backups" and then repair itself on the next write, never throw -- because the
// caller is usually a hide, and a hide must not be able to fail because of its
// own safety net.

async function readRaw(key, fallback) {
  try {
    const got = await chrome.storage.local.get(key);
    const v = got?.[key];
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * The index, newest first, with anything malformed dropped.
 *
 * Sorted on `at` ALONE, leaning on the sort being stable, so entries that share
 * a millisecond keep the order they were written in. Breaking that tie on the
 * id instead would sort them by KIND -- ids differ only in their trailing word
 * once the clock matches -- and a manual backup taken a moment before a daily
 * one would sort above it and be treated as the newer of the two.
 */
export async function list() {
  const raw = await readRaw(INDEX_KEY, []);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (e) =>
        e &&
        typeof e === "object" &&
        typeof e.id === "string" &&
        typeof e.at === "number" &&
        typeof e.kind === "string",
    )
    .sort((a, b) => b.at - a.at);
}

async function writeIndex(entries) {
  await chrome.storage.local.set({ [INDEX_KEY]: entries });
}

export async function meta() {
  const m = await readRaw(META_KEY, {});
  return m && typeof m === "object" ? m : {};
}

export async function setMeta(patch) {
  const next = { ...(await meta()), ...patch };
  try {
    await chrome.storage.local.set({ [META_KEY]: next });
  } catch {
    /* the schedule losing a beat is not worth failing a caller over */
  }
  return next;
}

/** One snapshot's full tree, or null if the blob is gone or unreadable. */
export async function get(id) {
  if (typeof id !== "string" || !id) return null;
  const snap = await readRaw(SNAP_PREFIX + id, null);
  if (!snap || typeof snap !== "object" || !Array.isArray(snap.groups)) return null;
  return snap;
}

/**
 * Save a snapshot.
 *
 * `groups` is [{ syncing, children }] -- one entry per bar/other-bookmarks pair
 * the profile has. Kept apart rather than merged because Chrome's split
 * local/account storage renders two bars as one, and restoring a merged copy
 * into a single bar would silently flip account bookmarks to local. See
 * roots.js, which enforces the same rule for hiding.
 *
 * Returns { ok, id, deduped, entry } or { ok: false, error }.
 */
export async function put(groups, kind, { label = "", at = Date.now(), force = false } = {}) {
  if (!Array.isArray(groups)) return { ok: false, error: "no groups" };
  if (!BUCKET[kind]) return { ok: false, error: `unknown kind: ${kind}` };

  const clean = groups.map((g) => ({
    syncing: g?.syncing ?? null,
    children: Array.isArray(g?.children) ? g.children : [],
  }));
  const { hash, len } = fingerprint(clean);
  const count = countLinks(clean);
  const folders = countFolders(clean);
  const index = await list();

  // Identical to the newest snapshot we hold? Then a second copy records
  // nothing. The entry is left exactly as it was -- its date is when that bar
  // state was FIRST seen, which is the more useful of the two -- and `seenAt`
  // notes that we looked again.
  const newest = index[0];
  if (
    !force &&
    newest &&
    newest.hash === hash &&
    newest.len === len &&
    newest.count === count
  ) {
    newest.seenAt = at;
    try {
      await writeIndex(index);
    } catch {
      /* cosmetic */
    }
    return { ok: true, id: newest.id, deduped: true, entry: newest };
  }

  const trimmedLabel = String(label ?? "").trim().slice(0, 60);
  const snap = { v: VERSION, at, kind, label: trimmedLabel, groups: clean };
  let bytes;
  try {
    bytes = JSON.stringify(snap).length;
  } catch {
    return { ok: false, error: "snapshot could not be serialised" };
  }
  if (bytes > MAX_SNAPSHOT_BYTES) {
    return { ok: false, error: "too big", tooBig: true, bytes };
  }

  const id = makeId(at, kind, new Set(index.map((e) => e.id)));
  try {
    await chrome.storage.local.set({ [SNAP_PREFIX + id]: snap });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }

  const entry = { id, at, kind, count, folders, bytes, hash, len, label: trimmedLabel };
  const { kept, dropped } = plan([entry, ...index]);
  try {
    await writeIndex(kept);
  } catch (err) {
    // The blob landed but the index did not. Drop the orphan rather than leave
    // storage holding a tree nothing can ever list or delete.
    await chrome.storage.local.remove(SNAP_PREFIX + id).catch(() => {});
    return { ok: false, error: String(err?.message ?? err) };
  }
  await removeBlobs(dropped);
  return { ok: true, id, entry, deduped: false, dropped: dropped.length };
}

async function removeBlobs(ids) {
  if (!ids || ids.length === 0) return;
  try {
    await chrome.storage.local.remove(ids.map((i) => SNAP_PREFIX + i));
  } catch {
    /* a blob that outlives its index entry costs space, never correctness */
  }
}

/**
 * Which entries survive retention. Pure, so the caps and the byte budget are
 * testable without storage.
 *
 * Two passes: per-bucket counts first, then the shared byte budget. Neither can
 * empty a bucket -- the newest of each kind is always kept, however large,
 * because "we deleted your only backup to save space" is not a trade a backup
 * system gets to make.
 */
export function plan(entries) {
  // Newest first, stable, for the same reason list() is: callers hand this the
  // new entry at the head, and a same-millisecond tie must not reorder it
  // behind the entry it was taken after.
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  const seen = { auto: 0, manual: 0, safety: 0 };
  const kept = [];
  const dropped = [];
  for (const e of sorted) {
    const b = BUCKET[e.kind] ?? "auto";
    seen[b] = (seen[b] ?? 0) + 1;
    if (seen[b] <= (CAPS[b] ?? 15)) kept.push(e);
    else dropped.push(e.id);
  }

  let total = kept.reduce((n, e) => n + (e.bytes ?? 0), 0);
  if (total <= BYTE_BUDGET) return { kept, dropped };

  for (const bucket of EVICT_ORDER) {
    // Oldest first within the bucket, and never the last one standing.
    const inBucket = kept.filter((e) => (BUCKET[e.kind] ?? "auto") === bucket);
    for (let i = inBucket.length - 1; i >= 1 && total > BYTE_BUDGET; i--) {
      const victim = inBucket[i];
      total -= victim.bytes ?? 0;
      dropped.push(victim.id);
      kept.splice(kept.indexOf(victim), 1);
    }
    if (total <= BYTE_BUDGET) break;
  }
  return { kept, dropped };
}

/** Delete one snapshot, index entry and blob together. */
export async function remove(id) {
  const index = await list();
  const next = index.filter((e) => e.id !== id);
  if (next.length === index.length) return { ok: false, error: "no such backup" };
  try {
    await writeIndex(next);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  await removeBlobs([id]);
  return { ok: true, id };
}

/** Everything, for a user who would rather Skrim held no copies at all. */
export async function clear() {
  const index = await list();
  try {
    await chrome.storage.local.remove([
      INDEX_KEY,
      META_KEY,
      ...index.map((e) => SNAP_PREFIX + e.id),
    ]);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  return { ok: true, removed: index.length };
}

/** Bytes held, and how the caps stand. For the page's footer line. */
export async function usage() {
  const index = await list();
  const bytes = index.reduce((n, e) => n + (e.bytes ?? 0), 0);
  const counts = { auto: 0, manual: 0, safety: 0 };
  for (const e of index) counts[BUCKET[e.kind] ?? "auto"]++;
  return { total: index.length, bytes, counts, caps: { ...CAPS }, budget: BYTE_BUDGET };
}
