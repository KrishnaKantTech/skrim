// Mutation testing for the local backups -- the snapshots Skrim keeps of the
// bookmarks bar, and the diff restore that puts one back.
//
//   node tools/mutate-backups.mjs    exit 0 == every decision below is load-bearing
//
// Each entry reverts ONE design decision in a scratch copy of the extension and
// requires the suite to go red. A mutation that stays green is not a passing
// test, it is an UNTESTED DECISION: the code could be written either way and
// nothing would notice.
//
// The diff restore is the reason this file is long. "The bar looks right
// afterwards" is satisfied by deleting the bar and building it again from the
// snapshot -- which resets every bookmark's id and date and fires a delete plus
// a create at every other signed-in computer. So several of the mutations below
// produce a CORRECT-LOOKING tree on purpose, and exist to prove the suite is
// checking how it got there, not just where it ended up.
//
// When this behaviour changes on purpose the anchor strings stop matching and
// this fails loudly with "anchor not found" -- which is the point. Rewrite the
// mutation to describe the NEW decision rather than deleting it.

import { run } from "./mutate-run.mjs";

const MUTATIONS = [
  // --- backups.js: storage, dedupe, retention ------------------------------
  {
    name: "BK-a  save a fresh copy every time, even of an unchanged bar",
    file: "extension/src/backups.js",
    from: `  const newest = index[0];
  if (
    !force &&
    newest &&`,
    to: `  const newest = index[0];
  if (
    false &&
    newest &&`,
  },
  {
    name: "BK-b  dedupe on the hash alone, without the length and count agreeing",
    file: "extension/src/backups.js",
    from: `    newest.hash === hash &&
    newest.len === len &&
    newest.count === count`,
    to: `    newest.hash === hash`,
  },
  {
    name: "BK-c  let the byte budget empty a bucket completely",
    file: "extension/src/backups.js",
    from: `    for (let i = inBucket.length - 1; i >= 1 && total > BYTE_BUDGET; i--) {`,
    to: `    for (let i = inBucket.length - 1; i >= 0 && total > BYTE_BUDGET; i--) {`,
  },
  {
    name: "BK-d  break a same-millisecond tie on the id, which sorts by KIND",
    file: "extension/src/backups.js",
    from: `    .sort((a, b) => b.at - a.at);
}`,
    to: `    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}`,
  },
  {
    name: "BK-e  drop the per-bucket caps and keep everything",
    file: "extension/src/backups.js",
    from: `    if (seen[b] <= (CAPS[b] ?? 15)) kept.push(e);`,
    to: `    if (true) kept.push(e);`,
  },
  {
    name: "BK-f  fingerprint the titles and urls without the nesting delimiters",
    file: "extension/src/backups.js",
    from: `        out.push("F ", String(n.title ?? ""), " [");
        walk(n.children);
        out.push("] ");`,
    to: `        out.push("F ", String(n.title ?? ""), " ");
        walk(n.children);`,
  },
  {
    name: "BK-g  leave the blob behind when the index write fails",
    file: "extension/src/backups.js",
    from: `    await chrome.storage.local.remove(SNAP_PREFIX + id).catch(() => {});
    return { ok: false, error: String(err?.message ?? err) };`,
    to: `    return { ok: false, error: String(err?.message ?? err) };`,
  },

  // --- when a snapshot is taken --------------------------------------------
  {
    name: "BK-h  hide without taking a copy of the bar first",
    file: "extension/src/engine.js",
    from: `  await autoSnapshot(backups.Kind.PREHIDE);`,
    to: `  /* mutated: no snapshot before a hide */`,
  },
  {
    name: "BK-i  ignore the automatic-backups switch and always snapshot",
    file: "extension/src/engine.js",
    from: `    const { autoBackup } = await settings.read();
    if (!autoBackup) return { ok: false, off: true };
    return await snapshotBarImpl(kind, opts);`,
    to: `    return await snapshotBarImpl(kind, opts);`,
  },
  {
    name: "BK-j  snapshot a hidden bar, capturing the placeholder links",
    file: "extension/src/engine.js",
    from: `  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  let read;`,
    to: `  let read;`,
  },
  {
    name: "BK-k  let a failing backup take the hide down with it",
    file: "extension/src/engine.js",
    from: `  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** How long between automatic daily snapshots. */`,
    to: `  } finally {
    /* mutated: the snapshot's failure is now the caller's problem */
  }
}

/** How long between automatic daily snapshots. */`,
  },
  {
    name: "BK-l  do not advance the daily clock, so an unchanged bar retries every minute",
    file: "extension/src/engine.js",
    from: `    if (res.ok || res.hidden !== true) await backups.setMeta({ lastAutoAt: now });`,
    to: `    if (res.ok && !res.deduped) await backups.setMeta({ lastAutoAt: now });`,
  },
  {
    name: "BK-m  let a backwards clock jump park the next daily snapshot in the future",
    file: "extension/src/engine.js",
    from: `    if (last <= now && now - last < DAILY_MS) return { ok: false, tooSoon: true };`,
    to: `    if (now - last < DAILY_MS) return { ok: false, tooSoon: true };`,
  },
  {
    name: "BK-n  record policy-managed bookmarks in the snapshot",
    file: "extension/src/engine.js",
    from: `  for (const n of nodes ?? []) {
    if (!isMutable(n)) continue;
    out.push(`,
    to: `  for (const n of nodes ?? []) {
    out.push(`,
  },

  // --- the diff restore ----------------------------------------------------
  {
    name: "BK-o  restore without taking a safety copy first",
    file: "extension/src/engine.js",
    from: `    const safety = await snapshotBarImpl(backups.Kind.SAFETY, {
      label: "before restoring a backup",
      force: true,
    });`,
    to: `    const safety = { ok: true, id: null };`,
  },
  {
    name: "BK-p  take the safety copy WITHOUT forcing, so an unchanged bar gets none",
    file: "extension/src/engine.js",
    from: `      label: "before restoring a backup",
      force: true,
    });`,
    to: `      label: "before restoring a backup",
    });`,
  },
  {
    name: "BK-r  delete the leftovers as we go, before everything has been placed",
    file: "extension/src/engine.js",
    from: `    await reconcileFolder(barId, snap.groups[si].children, ctx, 0);
    await sweepUnplaced(barId, ctx, 0);`,
    to: `    await sweepUnplaced(barId, ctx, 0);
    await reconcileFolder(barId, snap.groups[si].children, ctx, 0);`,
  },
  {
    name: "BK-s  match a bookmark anywhere, without preferring the folder it is already in",
    file: "extension/src/engine.js",
    from: `    let score = rec.parentId === parentId ? 2 : 0;`,
    to: `    let score = 0;`,
  },
  {
    name: "BK-t  recreate every bookmark instead of moving the one that is still there",
    file: "extension/src/engine.js",
    from: `    let rec = matchNode(w, isFolder, parentId, ctx);`,
    to: `    let rec = null;`,
  },
  {
    name: "BK-u  never skip an item that is already in the right place",
    file: "extension/src/engine.js",
    from: `      if (at === k) {
        s.kept++;
      } else {`,
    to: `      if (false) {
        s.kept++;
      } else {`,
  },
  {
    name: "BK-v  sweep policy-managed bookmarks away with everything else unplaced",
    file: "extension/src/engine.js",
    from: `    const rec = ctx.nodes.get(id);
    if (!rec) continue;
    if (ctx.used.has(id)) {`,
    to: `    const rec = ctx.nodes.get(id) ?? { folder: false };
    if (ctx.used.has(id)) {`,
  },
  {
    name: "BK-w  index policy-managed bookmarks, so the restore can move and delete them",
    file: "extension/src/engine.js",
    from: `      ids.push(k.id);
      if (!isMutable(k)) continue;`,
    to: `      ids.push(k.id);`,
  },
  {
    name: "BK-x  pair the snapshot's bars to the profile's by position, not by storage",
    file: "extension/src/engine.js",
    from: `      if ((snapGroups[i].syncing ?? null) === (liveGroups[j].syncing ?? null)) {`,
    to: `      if (true) {`,
  },
  {
    name: "BK-y  refuse a backup whose sync flag flipped (drop the one-to-one fallback)",
    file: "extension/src/engine.js",
    from: `  if (pairs.length === 0 && snapGroups.length === 1 && liveGroups.length === 1) {`,
    to: `  if (false) {`,
  },
  {
    name: "BK-z  restore the whole backup into the first bar, merging the storages",
    file: "extension/src/engine.js",
    from: `    await reconcileFolder(barId, snap.groups[si].children, ctx, 0);`,
    to: `    await reconcileFolder(barId, snap.groups.flatMap((g) => g.children), ctx, 0);`,
  },
  {
    name: "BK-aa  put a bookmark back without correcting the title it was given",
    file: "extension/src/engine.js",
    from: `      if (rec.title !== title) {
        if (!ctx.dry) await bmUpdate(rec.id, { title });`,
    to: `      if (false) {
        if (!ctx.dry) await bmUpdate(rec.id, { title });`,
  },
  {
    name: "BK-ab  let the dry run mutate the tree it is only supposed to be measuring",
    file: "extension/src/engine.js",
    from: `async function runMove(rec, parentId, index, ctx) {
  if (ctx.dry) {
    placeInModel(rec, parentId, index, ctx);
    return true;
  }
  try {`,
    to: `async function runMove(rec, parentId, index, ctx) {
  try {`,
  },
  {
    name: "BK-ac  restore onto a hidden bar, overwriting it with the placeholder links",
    file: "extension/src/engine.js",
    from: `  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  const snap = await backups.get(id);`,
    to: `  const snap = await backups.get(id);`,
  },
  {
    name: "BK-ad  go ahead with the restore even when the safety copy could not be taken",
    file: "extension/src/engine.js",
    from: `    if (!safety.ok) {
      return {
        ok: false,
        error: \`could not take a safety copy first (\${safety.error ?? "unknown"}), so nothing was changed\`,
      };
    }`,
    to: `    /* mutated: no safety copy is no longer a reason to stop */`,
  },
  // --- the copy taken at install -------------------------------------------
  {
    name: "BK-ae  never take a copy of the bar Skrim arrived to",
    file: "extension/src/sw.js",
    from: `      .then(() => takeOriginalBackupOnInstall(details.reason))`,
    to: `      /* mutated: nothing is saved when Skrim is installed */`,
  },
  {
    name: "BK-af  take an 'original' on every update too, long after Skrim arrived",
    file: "extension/src/sw.js",
    from: `async function takeOriginalBackupOnInstall(reason) {
  if (reason !== "install") return;`,
    to: `async function takeOriginalBackupOnInstall(reason) {
  void reason;`,
  },
  {
    name: "BK-ag  drop the watchdog retry, so a deferred want is never filled",
    file: "extension/src/sw.js",
    from: `    await engine
      .maybeOriginalBackup()
      .catch((e) => console.warn("[secureshare] original backup failed", e));`,
    to: `    /* mutated: a want the install could not fill stays unfilled */`,
  },
  {
    name: "BK-ah  put the original in the automatic bucket, where retention counts it out",
    file: "extension/src/backups.js",
    from: `  [Kind.ORIGINAL]: "original",
  [Kind.PREHIDE]: "auto",`,
    to: `  [Kind.ORIGINAL]: "auto",
  [Kind.PREHIDE]: "auto",`,
  },
  {
    name: "BK-ai  leave the original out of usage()'s tally, so the footer counts NaN",
    file: "extension/src/backups.js",
    from: `  const counts = { original: 0, auto: 0, manual: 0, safety: 0 };`,
    to: `  const counts = { auto: 0, manual: 0, safety: 0 };`,
  },
  {
    name: "BK-aj  snapshot a reinstall's bar with the user's bookmarks still in a vault",
    file: "extension/src/engine.js",
    from: `    const stranded = await pendingAdoptionsImpl().catch(() => []);
    if (stranded.length > 0) return { ok: false, stranded: true };`,
    to: `    /* mutated: a bar someone's bookmarks are missing from will do */`,
  },
  {
    name: "BK-ak  take the original WITHOUT forcing, so an identical daily swallows it",
    file: "extension/src/engine.js",
    from: `    const res = await snapshotBarImpl(backups.Kind.ORIGINAL, { at: now, force: true });`,
    to: `    const res = await snapshotBarImpl(backups.Kind.ORIGINAL, { at: now });`,
  },
  {
    name: "BK-al  never spend the want, so the watchdog takes an original every minute",
    file: "extension/src/engine.js",
    from: `    if (res.ok) await backups.setMeta({ originalWantedAt: 0 });
    return res;`,
    to: `    return res;`,
  },
  {
    name: "BK-am  let an unfilled want live forever, ready to mislabel a bar months later",
    file: "extension/src/engine.js",
    from: `    if (now - wanted > ORIGINAL_WINDOW_MS) {
      await backups.setMeta({ originalWantedAt: 0 });
      return { ok: false, expired: true };
    }`,
    to: `    /* mutated: a want never expires */`,
  },
  // --- renaming a copy ------------------------------------------------------
  {
    name: "BK-an  bump the date on a rename, reordering the list under the user",
    file: "extension/src/backups.js",
    from: `  index[pos] = { ...index[pos], label: trimmed, bytes };`,
    to: `  index[pos] = { ...index[pos], label: trimmed, bytes, at: Date.now() };`,
  },
  {
    name: "BK-ao  rename the index entry only, leaving the download file on the old name",
    file: "extension/src/backups.js",
    from: `    await chrome.storage.local.set({ [SNAP_PREFIX + id]: next, [INDEX_KEY]: index });`,
    to: `    await chrome.storage.local.set({ [INDEX_KEY]: index });`,
  },
  {
    name: "BK-ap  leave the entry's old size behind, so the byte budget counts the wrong thing",
    file: "extension/src/backups.js",
    from: `  index[pos] = { ...index[pos], label: trimmed, bytes };`,
    to: `  index[pos] = { ...index[pos], label: trimmed };`,
  },
  {
    name: "BK-aq  let a rename run a name of any length past the 60 a new backup gets",
    file: "extension/src/backups.js",
    from: `  const trimmed = String(label ?? "").trim().slice(0, 60);
  if (trimmed === (index[pos].label ?? "")) {`,
    to: `  const trimmed = String(label ?? "");
  if (trimmed === (index[pos].label ?? "")) {`,
  },
  {
    name: "BK-ar  put a tidy name on an entry whose tree is already gone",
    file: "extension/src/backups.js",
    from: `  const snap = await get(id);
  if (!snap) return { ok: false, error: "that backup is missing or damaged" };`,
    to: `  const snap = (await get(id)) ?? { v: VERSION, at: 0, kind: "manual", groups: [] };`,
  },
  {
    name: "BK-as  accept a rename of an id that is not in the index at all",
    file: "extension/src/backups.js",
    from: `  const pos = index.findIndex((e) => e.id === id);
  if (pos < 0) return { ok: false, error: "no such backup" };`,
    to: `  const pos = Math.max(0, index.findIndex((e) => e.id === id));`,
  },
];

run(MUTATIONS, { label: "backups", tmpName: "secureshare-mutate-bk" });
