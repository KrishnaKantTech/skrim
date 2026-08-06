# M0 Spike — Findings

Measured 2026-07-30 on Chrome 150.0.7871.187, macOS. Profile 1: 560 nodes,
12 top-level bar children, 466 URLs, 7 levels deep, bookmark sync live
(`syncing: true` on all roots).

## Verdict: GREEN LIGHT for the extension-only architecture

| Question | Result |
|---|---|
| Sync fan-out | ~14 ops per hide — green |
| Restore fidelity | 4/4 runs byte-identical |
| Hide latency | 2–9 ms for 12 nodes |
| Tree shape / `folderType` | Resolved; 2 plan changes |
| Cross-device convergence | Clean — no duplicates, losses, or reordering |
| Account-bookmark storage | Not testable on this machine; code defensively |

## 1. Sync fan-out — RESOLVED

The decisive question was whether `chrome.bookmarks.move()` dirties only the
moved node or rewrites its whole subtree.

| | Hide | Full round trip |
|---|---|---|
| Reparented | 12 | 0 |
| Added (vault) | 1 | 0 |
| Stored-field changes | 1 | 2 |
| Title/URL changes | 0 | 0 |
| **Dirty entities** | **~14** | **~2** |
| Descendants rewritten | 0 of 543 | 0 |

Fan-out is proportional to **top-level child count**, not total bookmarks.
~28 sync ops per meeting. Negligible.

The 2 residual differences after a round trip are `date_modified` on the
bookmarks-bar and other-bookmarks folders — unavoidable and correct, since
their children lists did change. All 558 other records are byte-identical.

## 2. Restore fidelity — PROVEN (3/3 runs)

`identical: true` on every run, comparing hashed shape of the entire subtree
(ids, indices, titles, URLs, folderType, syncing) before vs after.

Order and hierarchy survive because we move only the **direct children** of the
bar — `move()` relocates each subtree as a unit. This is structural, not
bookkeeping.

## 3. Latency — NON-ISSUE

| Run | Hide (12 nodes) | Restore |
|---|---|---|
| 1 | 3 ms | 11 ms |
| 2 | 9 ms | 9 ms |
| 3 | 3 ms | 8 ms |

~0.25–0.75 ms per node. A 100-item bar would hide in ~25 ms. Combined with
hooking `getDisplayMedia` at call time (before the picker even appears), hiding
before the first captured frame is effectively guaranteed.

## 4. Tree shape — TWO PLAN CHANGES

`getTree()` returned `rootCount: 2` — only `bookmarks-bar` and `other`.

- **Mobile bookmarks is NOT exposed when empty.** Kills the plan to park the
  vault under Mobile to avoid the "Other bookmarks" chevron tell. The vault must
  live under Other Bookmarks, so users whose Other Bookmarks is empty will see a
  chevron appear mid-share. **This raises the priority of decoy mode.**
- `folderType` and `syncing` are populated on Chrome 150. Root detection can use
  `folderType` with the well-known id (`"1"`, `"2"`) as fallback.

## 5. Chrome's bookmark file writer is debounced unpredictably

Observed flush latency after a mutation ranged from **2 seconds to ~5 minutes**.
Any tooling that reads the `Bookmarks` file must poll for an mtime change rather
than sleeping a fixed interval. (v1 of the probe used a fixed 8s hold and
captured three identical pre-experiment snapshots — a null result.)

Note: `snap-during` is ~16 KB larger than `snap-before` purely because Chrome
pretty-prints and 466 nodes dropped one indent level. Compare by guid, never by
file size or diff.

## 6. Cross-device convergence (Step 4) — CLEARED

Rig: a second Chrome launched with an isolated `--user-data-dir`, signed into the
same account (verified identical `gaia_id`). Chrome refuses a duplicate signed-in
*profile* within one user-data-dir, but that check is per-user-data-dir, so a
separate one gives a genuine second sync client on one machine.

| Observer client | Added | Removed | Reparented | Reordered | Title/URL |
|---|---|---|---|---|---|
| During hide | 1 (vault) | 0 | 12 | 0 | 0 |
| **After round trip** | **0** | **0** | **0** | **0** | **0** |

The observing client converged to its exact original state. None of the three
feared failure modes — duplicates, data loss, order corruption — occurred. MAIN
behaved identically as a control.

**Propagation latency ~2s each way** (observed visually). File-based measurements
read 5.1s and 10.1s, inflated by the write debounce documented in §5; treat
file-derived timings as upper bounds.

### Product consequence — must be documented for users

That propagation is bidirectional: **hiding bookmarks on one machine empties the
bookmarks bar on every other signed-in device for as long as the hide lasts.**
Not a data-integrity issue, but a visible side effect that is inherent to
mutating synced data — no bookmark mutation is local, so nothing inside this
architecture can hide the bar without it.

**Addressed 2026-07-31, for the common case.** The duration was the worse half
of this, and most of it turned out to be unnecessary. The hide has to start
before the picker opens, because nobody knows yet what will be shared — but once
the stream resolves, `track.getSettings().displaySurface` says what was picked:

| value | bar reachable by the capture? | what we do |
|---|---|---|
| `"browser"` (a Chrome tab) | **never** — a tab capture is the page's contents, not the browser frame | release immediately |
| `"window"` | maybe | stay hidden |
| `"monitor"` | yes | stay hidden |

So a tab share now costs peers a few seconds — the time the picker is open —
instead of the whole meeting. That is the sharing mode Meet and Zoom both
recommend by default. Read only ever to RELEASE: a missing or unrecognised
value keeps the bar down, so the failure mode is the old behaviour, never
exposure. `configurationchange` re-evaluates it, since Chrome's "Share this tab
instead" swaps the surface under a live track.

Verified against real Chrome, not just the mock: `live-test.mjs` `TS3` reads
`displaySurface` off a real track with nothing patched, so if Chrome ever stops
reporting `"browser"` for a captured tab, that check fails rather than the
feature silently reverting.

**Not addressed:** window and whole-screen shares still hold the bar down, on
every device, for the meeting. The extension cannot tell whether a shared
*window* is a Chrome window, and over-releasing there would put bookmarks on a
live call — so it does not guess. What the product does instead is say so: the
popup's sync note appears only on a bar that actually syncs (`syncing !== false`
on the roots), and a device whose bar was emptied *by* a peer is told that in
so many words rather than being shown a recovery prompt. This remains the
strongest argument for the native-keystroke approach in a later version.

## Still open

- **Account-bookmark storage.** Not active on this machine (no `AccountBookmarks`
  file, `rootCount: 2`). Under Chrome's split local/account storage, `getTree()`
  may surface two bookmarks-bar folders; moving an account bookmark into a local
  vault would silently change its sync status. Code defensively and detect at
  runtime.
- **Uninstall while hidden.** Unrecoverable by design — no API can catch own
  uninstall. Mitigate with a self-documenting vault folder name; contents keep
  their order, so manual drag-back works.

## Tooling

- `probe/` — throwaway MV3 probe extension (v2, gate-driven hold)
- `tools/receiver.py` — webhook receiver, polls mtime, snapshots on confirmed write
- `tools/diff2.py` — guid-level fan-out analysis (use this; `diff.py` counts depth
  shifts and produces a false red flag)
- `snapshots/` — snapshots + `Bookmarks-Profile1-BACKUP.json`
