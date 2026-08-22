# Skrim

**Hides your bookmarks bar automatically while you share your screen. Puts it back when you stop.**

You share a tab on a client call and there it is along the top of the window:
the other client's name, the job board, the doc nobody was supposed to see.
Chrome has no setting for this. The keyboard shortcut only helps if you
remember it before the picker opens, every single time — and the one time it
matters is the time you forget.

Skrim is free, has no account, and makes no network requests at all.

---

## Don't trust that. Check it.

This extension asks for your `bookmarks` permission and then moves every
bookmark you own. You should not take anyone's word for what it does with
them. That is why the source is here.

**Claim: Skrim makes no network requests of any kind.**

```bash
grep -rniE "fetch\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|importScripts" extension/
```

No results. There is no fetch, no XHR, no beacon, no WebSocket, no remote
script, no CDN reference, and no analytics anywhere in the package. Fonts are
self-hosted. `setUninstallURL` is never called. There is no server to talk to
because there is no server.

That is what lets every one of Chrome's nine data-collection categories be
declared **Not collected** — as a checkable fact rather than a promise.

**"But there's a Cloudflare Worker in this repo."**

There is — `worker/` and `site/` are skrim.app: the privacy policy, the recovery
page, and a waitlist form. That code is **outside `extension/` on purpose**, and
the grep above is scoped to `extension/` for exactly that reason.

The boundary is enforced, not just intended: `tools/check-listing.mjs` re-runs
that grep on every check, so network code cannot migrate into the extension
without the store listing's nine "Not collected" disclosures failing first.
Nothing the extension ships can reach the worker, and the worker never sees an
extension user — only someone who typed their address into a form on the website.

**Claim: nothing is ever permanently deleted.**

```bash
node tools/test-engine.mjs         # ~1s, prints a scoreboard, exit 0 = all green
node tools/mutate-m2.mjs           # proves those tests would catch a regression
node tools/mutate-recovery.mjs     # same, for the crash-recovery layer
node tools/mutate-live.mjs         # same, for the settings that change a LIVE hide
node tools/live-test.mjs           # ~75s, drives a real Chrome
node tools/store-install-test.mjs  # ~60s, a fresh profile and a store-shaped copy
node tools/qa-features.mjs         # ~40s, clicks the real toggles in a real Chrome
```

Every item Skrim deletes is an item Skrim itself created.

---

## How it works, and why it's strange

**Chrome exposes no API for bookmarks-bar visibility.** It is a browser
preference, not an extension surface. So the only lever any extension has is to
move the bookmarks themselves.

When a screen share starts:

1. Everything on your bookmarks bar is moved into a folder inside Other Bookmarks.
2. A few neutral placeholder links (Google, Gmail, Calendar, Drive, Maps, News)
   take their place — a conspicuously empty bar is its own tell.
3. When the share ends, every bookmark returns to the exact index it came from,
   and the folder, the placeholders and the receipt are deleted.

Both of those are switches, and both take effect **while the bar is already
hidden** — the moment you actually reach for them is mid-call. Turning
placeholder links on or off changes the hidden bar there and then; switching
"Tuck the bar into a folder" converts the hide that is running, moving your
bookmarks straight from the folder in Other Bookmarks into one plainly-named
folder that stays on the bar, or back. Nothing is ever staged on the bar to get
there, so the share never sees a bookmark mid-switch, and an interruption at any
point leaves everything one restore from home.

Skrim sees the share start by wrapping `navigator.mediaDevices.getDisplayMedia`
in the MAIN world at `document_start`. It observes exactly three facts: that a
share started, which surface was picked, and when the track ended. It does not
read, modify or transmit page content.

**If Chrome dies half-way through**, the next startup finishes the restore. A
once-per-minute alarm re-checks that an outstanding hide or restore actually
completed, because MV3 shuts the service worker down whenever it feels like it.
**If you uninstall while your bar is still hidden**, the folder contains a
receipt bookmark whose *title* spells out how to put everything back by hand.

---

## What it does not cover

Said out loud rather than buried, because it's the difference between a tool
you can rely on and one that fails silently:

- **Desktop apps.** The Zoom desktop client, the Loom desktop app, OBS and
  QuickTime capture outside Chrome entirely, where no extension can see them.
- **Chrome's own picker preview.** On a page that requests your screen the
  instant it loads, the thumbnail Chrome draws inside the share picker can
  still show the bar for a moment. Meet and Zoom both preview clean; this is a
  limit of the picker, not something an extension can reach.

## If something goes wrong, there is a copy

Skrim keeps its own snapshots of your bookmarks bar — one taken right before
every hide, one a day if anything changed, and any you take by hand. They live
inside the extension on this computer, cost no extra permission, and are never
sent anywhere.

Putting one back **moves** what is still there rather than deleting the bar and
building it again: bookmarks keep their ids and their dates, and your other
signed-in computers see a handful of moves instead of a delete and a create for
every item. It shows you exactly what it will change before it changes anything,
and takes a copy of the bar as it stands first — so a restore is itself
undoable. Open it from the popup: **Settings & backup → Backups & files**.

Old ones are dropped by count, never by age. A backup is never deleted for
being old, because that is precisely when you would go looking for it.

## One thing to know if you use Chrome Sync

Bookmarks are synced data, so while your bar is hidden here it is also empty on
your other signed-in devices. That is Chrome's sync doing exactly what you
turned it on to do — Skrim sends nothing anywhere.

It costs less than it sounds. A shared **tab** cannot contain the bookmarks
bar, so as soon as Chrome confirms you picked a tab, Skrim releases the hide —
here immediately, on other devices a couple of seconds later. Tab sharing is
what Meet and Zoom suggest by default. A **window** or **whole-screen** share is
the case that genuinely holds the bar down for the length of the meeting; on
your other device, Skrim explains what happened and offers to bring the bar back.

---

## Permissions, and why each one exists

| Permission | Why |
| --- | --- |
| `bookmarks` | This *is* the feature. Chrome offers no other lever. |
| `storage` | Crash safety only — which IDs moved, and what index each came from. IDs and positions, never titles or URLs. Deleted as soon as the restore it protects is verified. |
| `alarms` | One repeating alarm, once per minute, to finish a hide or restore that an MV3 worker shutdown interrupted. |
| `tabs` | Matches only `chrome-extension://` URLs against a one-entry list (Loom's capture page). An ordinary web page can never match it. Compared in memory, discarded in the same call. |
| `<all_urls>` | A share can start on any site, and the wrapper must be in place *before* the page calls `getDisplayMedia` — it cannot be injected in response, because by then the picker is already open. |

---

## What's in this repo

| | |
| --- | --- |
| `extension/` | The extension. No network code, ever — see above. |
| `tools/` | The test suite, the mutation testers, the two harnesses that drive a real Chrome (`live-test` for the mechanism, `store-install-test` for the shipped shape of it), and the generators that build the store assets, the promo film and the social covers from the same geometry as the logo. |
| `site/` | skrim.app's pages. `privacy.html` is linked from the store listing; `restore.html` is what a receipt URL resolves to, so it has to keep working for as long as anyone holds one. |
| `worker/` | The Cloudflare Worker serving skrim.app: host canonicalisation, the waitlist endpoint, security headers. |
| `brand/` | Logo geometry, tokens, store screenshots and tiles, the promo film, social covers. All generated. |
| `probe/` | The throwaway extension from the Chrome Sync spike. Kept because `M0-FINDINGS.md` refers to it. |
| `STATUS.md` | The engineering log. Long, specific, and the honest record rather than a summary. |
| `M0-FINDINGS.md` | What the Chrome Sync fan-out spike actually found. |

## Build it yourself

Requires Chrome 116 or later. No build step, no dependencies, no bundler.

```bash
git clone <this repo>
```

Then `chrome://extensions` → enable Developer mode → **Load unpacked** →
select the `extension/` folder.

An unpacked copy also exposes a **Developer** disclosure at the bottom of the
popup with manual hide/restore controls. A Web Store copy does not: the panel is
hidden and its handlers are left unbound whenever `chrome.runtime.getManifest()`
reports an `update_url`, which Chrome injects for an installed copy and omits
for an unpacked one.

## Tests

```
assertions            594 pass / 0 fail
fault inject HIDE      30 repaired / 0 broken
fault inject RESTORE   41 repaired / 0 broken
fault inject BACKUP    19 safe / 0 bookmarks lost
mutations              91 caught / 0 survived
live (real Chrome)     71 pass / 0 fail
store install          33 pass / 0 fail
feature QA             46 pass / 0 fail
1000-item hide         5ms
```

Every fix is mutation-tested: revert it in a scratch copy and the suite must go
red. That check has earned its keep twice now — one fix had no coverage at all
until it was run, and a later one turned out to be protecting the *dangerous*
half of a change while three defensive checks around it went untested.

---

## License

**Skrim is source-available, not open source.** See [LICENSE](LICENSE).

Read it, audit it, build it, run it, change it for yourself — at home or at
work, commercially or not. Publishing it or redistributing it, in original or
modified form, is not permitted.

The source is here so the privacy claims are checkable, not so the extension can
be repackaged. Installing from the Chrome Web Store needs no license at all.
