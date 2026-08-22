# Local backups — plan

Written 2026-08-22, after the restore bug that stranded 11 of 12 bookmarks.

## The point

Skrim moves your bookmarks. When a move goes wrong, you need the old bar back.
Today the only safety net is a file you remembered to download by hand. This
plan makes Skrim keep its own snapshots, on its own, and put one back in a
click.

## Decisions (settled)

| Question | Answer |
|---|---|
| What is saved | The bookmarks bar only — the one thing Skrim ever touches |
| When it runs | Before every hide, plus once a day if the bar changed |
| Where it lives | Inside the extension (`chrome.storage.local`) — no new permission |
| How restore works | Put the bar back by **diff** (default), or add as a folder (safe option) |
| Old backups | Trimmed by count only. Never by age. |

## Feature list

### 1. Automatic backups
- **Before every hide.** A snapshot is taken right before the bar is moved,
  on the same chain as the hide itself. This is the one that matters — it is
  the exact state yesterday's bug lost.
- **Once a day.** The watchdog alarm already runs every minute. It checks: is
  it more than 24h since the last auto backup, and has the bar actually
  changed? Only then it snapshots. No new alarm.
- **Never while hidden.** A hidden bar holds decoys, not your bookmarks.
  Snapshotting then would save the wrong thing, so it is skipped.
- **Never blocks a hide.** If the backup fails for any reason, the hide still
  runs. A safety net must not become a new way to fail.
- **No duplicates.** Each snapshot carries a hash of the tree. If nothing
  changed since the last one, we just touch its date instead of saving a copy.

### 2. Manual backups
- **"Back up now"** button on the backup page. Saves a snapshot marked
  `manual`, with an optional short name you type ("before the big cleanup").
- Manual snapshots are kept longer than automatic ones (see retention).

### 3. The backup list
On the backup page, under the existing copy/download/import cards:
- Newest first. Each row shows: date and time, how many bookmarks, and a small
  tag — `auto`, `before hide`, `manual`, or `safety`.
- Row actions: **Restore**, **Download** (as the standard `.html` file, same
  format as today), **Delete**.
- An empty list explains itself: "No backups yet. The first one is saved before
  your next hide."

### 4. Restore
Two ways, both refuse while the bar is hidden.

**A. Put the bar back (default) — by diff, not by wipe.**

Not "delete everything and rebuild". Skrim compares the bar as it is now
against the snapshot and only touches what actually differs:

- item is in both → **move** it into place. It keeps its id, its date and its
  sync identity. Nothing is deleted, nothing is recreated.
- item is missing → create it
- item is extra → delete it

Restoring after the Aug 21 bug would be about 11 moves and zero deletes. Your
other computers barely notice, and dates are kept.

How it runs:
1. Takes a `safety` snapshot of the bar as it is right now, first. So a restore
   is itself undoable.
2. Builds one index of everything under the bar. Links are matched by URL,
   folders by title. An item that drifted into the wrong folder is found there
   and moved back, instead of being deleted and made again.
3. Walks the snapshot top down, placing each item at its right spot.
4. Deletes only what is left over and does not belong.
5. Reports the counts: moved, created, deleted, renamed.

The confirm dialog shows those counts before anything happens
("12 moved, 1 added, nothing deleted").

**B. Add as a folder.** Drops the whole snapshot into one new folder on the
bar. Deletes nothing. This is the existing import path, reused.

**Rules the diff obeys:**
- Company-locked (policy) bookmarks are never moved, renamed or deleted, and
  never recorded in a snapshot either — recording one could only ever produce a
  duplicate on the way back. They keep their place at the front of their folder.
- A folder is never moved inside itself. Everything is placed into a parent
  that is already final, whose whole ancestor chain has therefore already been
  matched — so the folder being moved cannot be one of its own future
  ancestors. True by construction, not by a check, and tested.
- Split local/account storage: the snapshot records each bar separately, so
  account bookmarks can never be restored into local storage. This is the same
  rule `roots.js` already enforces for hiding.
- Any single failed move or create is reported, not fatal. The rest still runs.

### 5. The toggle
- New setting `autoBackup`, **on by default**. Off means: no automatic
  snapshots at all. Manual ones still work, and existing snapshots stay.
- Lives in the popup's "Settings & backup" panel as a third switch, and is
  mirrored on the backup page. Both write the same setting.

### 6. Retention — by count, never by age
Small and predictable, and it can never leave you with nothing:
- 15 newest automatic (`before hide` + `daily` share this bucket)
- 10 newest `manual`
- 5 newest `safety`
- Plus a hard budget of ~4 MB total. Over budget, the oldest automatic ones go
  first, then safety, then manual. It never empties a bucket completely.

**No delete-by-age.** Deliberately. A backup that expires while you are away
from the computer is a backup that is gone exactly when you need it.

For scale: 500 bookmarks is roughly 60 KB a snapshot. Chrome gives us 10 MB.

### 7. Names
Three names, three jobs.
- **Internal id**: `20260821-184032-prehide` — local date, time to the second,
  kind. A second collision gets `-2`.
- **In the list**: `Aug 21, 6:40 PM`, a tag chip, and a count. A named manual
  backup shows its name large with the date small underneath.
- **Downloaded file**: `skrim-backup-2026-08-21-1840-before-hide.html`, or
  `skrim-backup-2026-08-21-1840-before-the-big-cleanup.html` for a named one
  (cleaned up, capped at 40 characters).

Tags read in plain words: `before hide`, `daily`, `manual`, `safety`.

### 8. Backups stay on this computer
They cannot travel and that is on purpose. `chrome.storage.sync` caps at
100 KB total and 8 KB an item — a bookmark tree does not fit. The only thing
that syncs natively is bookmarks themselves, and hiding snapshots inside your
bookmark tree is exactly what Skrim should not do. Each computer keeps a
backup of its own bar, which is the honest thing anyway. The Download button
is how a backup crosses machines.

## How it is built

### New file: `src/backups.js`
Pure storage logic, no bookmark reads. Testable in Node like `portable.js`.
- `list()` — the index, newest first
- `get(id)` — one snapshot's tree
- `put(tree, kind, label)` — hash, dedupe, write, then trim by retention
- `remove(id)`, `trim()`

Storage shape:
- `skrim.backups.index` → `[{ id, at, kind, count, bytes, hash, label }]`
- `skrim.backup.<id>` → `{ v: 1, at, kind, children: [...] }`

One key per snapshot, so listing them does not read them all. The tree is
stored as the same portable node shape `portable.js` already uses, so download
is a straight call to `toNetscapeHtml`.

### Changes to `src/engine.js`
Everything runs on the existing `serialize()` chain, so a backup can never
interleave with a hide.
- `snapshotBar(kind, label)` — reads the bar, hands it to `backups.put`
- `listBackups()`, `deleteBackup(id)`, `downloadBackup(id)`
- `restoreBackup(id, { mode })` — `"diff"` (default) or `"folder"`
- `hideImpl` / `tuckHideImpl` — call `snapshotBar("prehide")` before the
  journal is written, wrapped so a failure cannot stop the hide

### Changes to `src/settings.js`
- `autoBackup: true` added to `DEFAULTS`, handled in `write()`

### Changes to `src/sw.js`
- New messages: `listBackups`, `makeBackup`, `getBackup`, `restoreBackup`,
  `deleteBackup`
- The watchdog gains the daily check (guarded: not while displaced, not if
  `autoBackup` is off)

### Changes to `backup.html` / `backup.js`
- A "Your backups" section with the list, the toggle, and "Back up now"
- The confirm dialog for replace
- Reuses the existing worker-first-then-direct `call()` helper

### Changes to `popup.html` / `popup.js`
- Third switch in the settings panel
- The backup row gains a count: "Back up your bookmarks — 6 saved"

### Changes to `recovery.js`
- When a stranded vault is found, also point at the backups. That is exactly
  the moment they are worth the most.

### Tests (`tools/test-engine.mjs`, `mock-chrome.mjs`)
- Snapshot round trip: bar → snapshot → diff restore → identical tree
- Diff restore moves instead of recreating: ids survive, dateAdded survives
- Reproduces the Aug 21 bug (items in the wrong folder) and fixes it in moves only
- Dedupe: two hides with no change in between make one snapshot
- Retention: 40 snapshots trim to the caps, manual ones survive
- Refuses while hidden, in both directions
- A failing backup does not fail a hide
- Policy-locked items are never moved, renamed or deleted
- Safety snapshot exists after a diff restore, and restoring it undoes the restore
- A folder swap (A/B becomes B/A) never moves a folder into itself
- Split local/account bars restore to their own storage, never across

## One thing to know

**A created bookmark gets today's date.** Chrome will not let an extension set
`dateAdded` on create. The diff restore mostly moves rather than creates, so
this only affects items that were genuinely gone and had to be remade. Links,
titles, folders and order are exact either way.

## Status — done, 2026-08-22

Built and tested. Test numbers after the change:

```
assertions            594 pass / 0 fail
fault inject BACKUP    19 safe / 0 bookmarks lost   (and all 19 fixed by a re-run)
mutations              91 caught / 0 survived        (29 of them new, for this)
live (real Chrome)     71 pass / 0 fail
store install          33 pass / 0 fail
feature QA             46 pass / 0 fail
```

Two things found on the way that were not in the plan:

- The index sorted same-millisecond entries by id, which sorts by KIND once the
  clock matches — so a manual backup taken a moment before a daily one read as
  the newer of the two. Now sorted on time alone, leaning on a stable sort.
- Two mutation anchors elsewhere in the repo (`RC-a`, `M2-f`) had gone stale
  against code that moved since they were written, so both were reporting a
  false pass. Repaired; every suite is now genuinely green.

## Order of work

1. `backups.js` + its tests (no UI, nothing user-visible yet)
2. Engine wiring + pre-hide snapshot + the daily check
3. The backup page UI
4. The popup switch and count
5. Recovery page link
6. Full test pass, then version bump
