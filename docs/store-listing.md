# Skrim — Chrome Web Store listing copy

Everything the Developer Dashboard asks for, written to be pasted field by
field. Each block below is headed with the exact dashboard field it belongs to
and its character limit. Text inside a fenced block is the copy — paste it
verbatim, fences excluded.

Written off the code, not off a template. Every claim below is checkable in the
repo, and the two that carry the most weight were re-verified while writing
this:

- **zero network egress** — `grep -rniE "fetch\(|XMLHttpRequest|sendBeacon|new
  WebSocket|EventSource|importScripts" extension/` returns nothing, and so does
  a search for any `http(s)://` in the extension's HTML and CSS. `RECOVERY_BASE`
  is still `null`, so `setUninstallURL` is never even called. Nothing in the
  package can make a request.
- **the permission set** — `bookmarks`, `storage`, `alarms`, `tabs`, plus
  `<all_urls>` content scripts, read from `extension/manifest.json`, not from
  memory.

**If either of those changes, this file and `site/privacy.html` are both wrong
until updated.** The one candidate is setting `receipt.UNINSTALL_PING`: an
uninstall URL is a real GET carrying a count and a timestamp in its query
string, and it breaks the "no network requests at all" line in the description.

`receipt.RECOVERY_BASE` is a different switch and does not touch this claim. It
only decides where a receipt bookmark POINTS; the payload rides in the fragment,
which a browser never transmits, so a receipt is a link the user may click
rather than a request Skrim makes. It is set to `https://skrim.app/restore`.

Run `node tools/check-listing.mjs` after any edit — it re-checks every character
limit here against the real field caps and re-verifies the egress claim.

---

## Store listing tab

### Title (max 75)

```
Skrim
```

Comes from `manifest.json` `name`. Leave it alone — the brand is the word.

### Summary (max 132)

```
Hides your bookmarks bar automatically while you share your screen.
```

This is byte-identical to `manifest.json` `description`, which is what
pre-fills the field. Keep them identical: if you edit one, edit the other, or
the next package upload silently reverts the listing.

If you want the search terms weighted harder, this alternative also fits — but
it only ships once `manifest.json` matches it:

```
Auto-hides your Chrome bookmarks bar the moment a screen share starts, and puts it back when it ends.
```

### Description (max 16,000)

The store renders this as plain text — no markdown, no bold, line breaks
preserved. Written that way on purpose.

```
Skrim hides your bookmarks bar the moment you start sharing your screen, and puts it back the moment you stop.

THE PROBLEM

You share a tab on a client call and there it is along the top of the window: the other client's name, the job board, the doc nobody was supposed to see. Chrome has no setting for this. The keyboard shortcut only helps if you remember it before the picker opens, every single time, and the one time it matters is the time you forget.

HOW IT WORKS

Skrim watches for a screen share starting — in Google Meet, in Zoom on the web, or on any site that asks Chrome for your screen. When one starts:

- everything on your bookmarks bar is moved into a folder inside Other Bookmarks
- a few neutral, unremarkable placeholder links take their place, so a conspicuously empty bar isn't its own tell
- when the share ends, every bookmark returns to the exact position it came from, and the folder and the placeholders are deleted

Nothing is ever deleted permanently and nothing is copied out of your browser. If the share, Chrome, or the machine dies half-way through, the next startup finishes the restore. If you uninstall while your bookmarks are still hidden, the folder holds a receipt bookmark whose title spells out how to put the bar back by hand.

Click the toolbar icon at any time to see what Skrim is currently seeing, and to hide or restore the bar yourself.

WHAT IT COVERS

- Google Meet and Zoom on the web — tested end to end in a real browser
- Any other site that uses Chrome's own screen-share API
- Tab shares, window shares and whole-screen shares
- Loom's Chrome extension recorder

WHAT IT DOES NOT COVER — worth knowing before you install

- Desktop apps. The Zoom desktop client, the Loom desktop app, OBS and QuickTime capture outside Chrome entirely, where no extension can see them.
- Chrome's own picker preview. On a page that asks for your screen the instant it loads, the thumbnail Chrome draws inside the share picker can still show the bar for a moment. Google Meet and Zoom both preview clean; this is a limit of the picker, not something an extension can reach.

PRIVACY

Skrim makes no network requests at all. There is no server, no account, no analytics, no telemetry, no crash reporting. Your bookmarks are read and rearranged inside your own browser and are never copied, uploaded, or transmitted. Every one of Chrome's data-collection categories is declared "not collected", and that is a checkable claim rather than a promise: there is no fetch, no XHR, no beacon and no WebSocket anywhere in the code, and no remote resource of any kind.

ONE THING TO KNOW IF YOU USE CHROME SYNC

Bookmarks are synced data, so while your bar is hidden here it is also empty on your other signed-in devices. That is Chrome's sync doing exactly what you turned it on to do — Skrim sends nothing anywhere.

It costs less than it sounds. A shared tab cannot contain the bookmarks bar, so as soon as Chrome confirms you picked a tab, Skrim releases the hide and the bar comes straight back — here immediately, on your other devices a couple of seconds later. Tab sharing is what Meet and Zoom suggest by default. A window or whole-screen share is the case that genuinely holds the bar down for the length of the meeting. On the other device, Skrim explains what happened and offers to bring the bar back. Or turn on Tuck into a folder in the settings and the situation never comes up: instead of clearing the bar, Skrim parks it inside one folder that stays put, so your other computers keep their bookmarks — they just see a single tidy folder while you present.

REQUIREMENTS

Chrome 116 or later. Free. No account, no sign-in, no upsell.

Google Meet, Zoom, Loom, OBS and QuickTime are trademarks of their respective owners. Skrim is not affiliated with, endorsed by, or sponsored by any of them.
```

### Category

**Privacy & Security.** It is a privacy tool with a screen-sharing trigger, and
that is the aisle someone with this problem browses. Workflow & Planning is the
runner-up and describes the moment of use rather than the reason for it.

---

## The ASO pass — staged, do not apply yet

Written 2026-08-07, while the item is **in review**. Nothing in this section is
live and nothing here should be pasted into the dashboard today.

**Why not today.** Editing a pending item resubmits it. The queue position is
lost and the review clock starts again, which trades a real approval date for a
keyword. Wait for approval, confirm the public URL loads signed-out, then apply
this — the dashboard-only half immediately, the package half with 0.2.1.

In-store search is the compounding channel for an extension: it outranks every
social post over time, and it is the one place a stranger arrives already
looking for what this does. The fields are weighted roughly title → summary →
description, and rank is then moved by install count, rating count and average.

### The terms to rank for

From MARKETING-PLAN.md § 2, in the words the ICPs actually type:

| Query | Where it appears today |
| --- | --- |
| hide bookmarks bar screen share | description only |
| hide bookmarks bar zoom / google meet | description only |
| hide bookmarks bar google meet | description only |
| bookmarks showing on screen share | nowhere |
| hide bookmarks when recording | nowhere (`recorder` appears once, of Loom) |
| screen share privacy | description, once |

A keyword frequency pass over the live description: `bookmarks bar` ×3,
`screen share` ×3, `hide` ×3, `privacy` ×1, `record` ×1, `screen sharing` ×0.
The body is in reasonable shape. **The gap is at the top**, in the two fields
that carry the most weight.

### Recommended title — needs a package upload

The single biggest miss on the whole listing: the title is **5 characters of a
75 cap**, and "Skrim" is a coined word that matches no query anyone types. The
title is the heaviest-weighted field in store search and it is currently doing
none of that work.

    Skrim — Hide Bookmarks Bar on Screen Share

42 characters. Brand first so the word still does its branding job, then one
plain descriptive phrase — the form Chrome expects. It is not stuffing: it is
one phrase, it is exactly what the extension does, and it reads as a name.

Two deliberate omissions:

- **No "Google Meet" or "Zoom" in the title.** Another company's trademark in
  the name field is a rejection risk and reads as an affiliation claim. They
  belong in the summary and description, which is where they already are, and
  where naming them in text is fine (see CLAIMS.md § Trademarks).
- **No "free", no "best", no comma-separated keyword tail.** Chrome demotes for
  keyword stuffing and the listing's whole argument is that it does not oversell.

This ships through `manifest.json` `name`, not the dashboard — the store reads
the title from the package. So it is a 0.2.1 change, and it will re-trigger
review by itself. Do it as part of the first real post-approval update rather
than as its own submission.

### Recommended summary — needs the same package upload

Currently 67 of 132 characters, and it spends none of the remaining 65 on the
trigger words people search with.

    Automatically hides your bookmarks bar when a screen share or recording starts, and puts every bookmark back when it ends.

122 characters. It adds `recording` — a real, checkable capability (Loom's
Chrome extension recorder) that today appears nowhere above the fold — and it
puts the restore promise in the field that shows in search results, because
"will it give them back?" is the objection that stops the install.

Byte-identical to `manifest.json` `description`, same rule as the current one:
edit one, edit the other, or the next upload silently reverts the listing.

### Description — dashboard-only, apply as soon as it is approved

Two changes, both small, neither touching a claim:

1. **Name the surfaces in the opening line.** The first two lines are what
   search indexes hardest and what the truncated preview shows. Replace the
   current opener with:

       Skrim hides your bookmarks bar the moment you start sharing your screen — in Google Meet, in Zoom on the web, or in any site or recorder that uses Chrome's screen-share API — and puts it back the moment you stop.

2. **Add a short question block before REQUIREMENTS.** Real queries, answered
   honestly. This is legitimate long-tail indexing because every line is a
   question people genuinely arrive with:

       COMMON QUESTIONS

       How do I hide my bookmarks bar when screen sharing? Chrome has no setting for it, and Ctrl+Shift+B only works if you remember it before the picker opens. Skrim does it automatically, every time.

       Does it work with Google Meet and Zoom? Yes, on the web. Desktop apps capture outside Chrome, where no extension can see them.

       Will I get my bookmarks back? Every one, at the exact position it came from — including after a crash, and including if you uninstall Skrim while the bar is hidden.

       Does it hide my tabs or notifications too? No. It covers one thing: the bookmarks bar.

Both stay inside CLAIMS.md. The second answer says "on the web" out loud, which
is the one line CLAIMS.md forbids leaving out.

### Left open, on purpose

- **Microsoft Teams on the web** is a high-volume query this listing does not
  say a word about. Teams uses `getDisplayMedia`, so it should be covered by the
  general claim already made — but *should be* is not *tested*, and CLAIMS.md
  only lets Meet and Zoom be named as verified. **Test one Teams-on-the-web
  share end to end.** If it works, it is the cheapest keyword left on the table
  and it goes in the description's WHAT IT COVERS list. If it does not, that is
  a bug worth knowing about before anyone reports it.
- **Screenshot filenames and alt text are not indexed** by store search, so
  there is no ASO work in `brand/store/`. Leave them alone; they are correct.

---

### Language

English (United States).

---

## Privacy practices tab

### Single purpose description

```
Skrim has a single purpose: to hide the Chrome bookmarks bar while you share your screen, and restore it when the share ends.

Chrome exposes no API to hide the bookmarks bar, so the only lever is to move the bookmarks themselves: Skrim moves the bar into a folder under Other Bookmarks when a share starts, and back when it ends.

Every part serves that one function: content scripts detect a share starting or stopping, the bookmarks permission does the hide and restore, storage and alarms let it survive a crash or an idled-out service worker, and the popup shows the state with a manual hide or restore.

The popup's settings serve that same hide, not a second purpose: placeholder links keep the emptied bar from looking conspicuous, tucking into a folder is the same hide so synced computers keep theirs, and, because it moves your real bookmarks, you can keep your own backup so trying it never risks them. Nothing is injected into pages, no account, nothing collected or transmitted.
```

### Permission justification — `bookmarks`

```
This permission is the feature itself; the extension does nothing else.

When a screen share starts, Skrim reads the children of the bookmarks-bar node, creates a folder under Other Bookmarks, and moves each item into it. It adds a few placeholder links so the bar does not look conspicuously empty, plus one receipt bookmark whose title tells the user how to reverse the change by hand. When the share ends it moves every item back to its recorded index and deletes the folder, the placeholders and the receipt.

Bookmarks are read and rearranged in place inside the user's own profile — never uploaded, never transmitted. The extension makes no network requests of any kind. Nothing is deleted permanently: every item Skrim removes is one Skrim itself created.

There is no alternative: Chrome exposes no API for bookmarks-bar visibility (it is a preference, not an extension surface), so moving the bookmarks is the only way to clear the bar.
```

### Permission justification — `storage`

```
Used for crash safety and to store the user's settings, inside the user's own profile only.

chrome.storage.local holds: a journal of which bookmark IDs moved and from what index (IDs and positions only — never titles or URLs); the IDs of the folder and placeholders Skrim created, so cleanup never touches the user's own; a last-failure record shown on the recovery screen; and the user's settings (decoys on/off and the tuck folder name — preferences only). chrome.storage.session holds which tab and frame is sharing and when it last checked in.

The crash records are deleted once the restore each protects is verified; the settings persist until changed or uninstalled; the session data drops when the browser closes.

Without it there is no way to be safe. A Chrome crash, an extension update, or a service-worker shutdown in the middle of a hide would otherwise leave the user's bookmarks sitting in a folder with nothing left that knows where they belong.
```

### Permission justification — `alarms`

```
Chrome shuts down a Manifest V3 service worker whenever it goes idle, and that can happen in the middle of a hide or a restore.

Skrim registers a single repeating alarm, once per minute, that wakes the worker to re-check that an outstanding hide or restore actually completed and to finish it if it did not. When there is nothing outstanding it does nothing and returns.

This is the only thing standing between an interrupted restore and a user left with an empty bookmarks bar and no idea why. It performs no other work, and it is not used for scheduling, polling, or any kind of background data collection.
```

### Permission justification — `tabs`

```
Some screen recorders do not use Chrome's screen-share API: they capture from a page belonging to their own extension, which no other extension is allowed to inspect. Loom's pinned capture tab is the case this exists for.

Skrim listens for tab create/update/remove events and compares the URL against a short built-in list of known capture pages — currently one entry, Loom's. The match only ever succeeds on a chrome-extension:// URL whose extension ID is on that list; an ordinary web page can never match it. The URL is compared in memory and discarded in the same call: nothing is stored, nothing is sent anywhere, and no browsing history is read or retained.

Skrim also uses chrome.tabs.create for exactly one thing — opening its own bundled recovery page after a restore failed.

Without this permission such a recording is invisible, and the user's bookmarks bar stays up for its whole duration: the exact failure the extension exists to prevent.
```

### Permission justification — host permissions (`<all_urls>` content scripts)

```
A screen share can start on any website, so every site needs cover. Timing is why a narrower request is not possible: the wrapper must already be in place when a page calls navigator.mediaDevices.getDisplayMedia. It cannot be injected in response to that call, because by then the call has happened and the picker is open.

Skrim runs two small content scripts at document_start in all frames. One, in the MAIN world, wraps getDisplayMedia to observe three facts and nothing else: that a share started, which surface was picked, and when the track ended. The other forwards those three facts to the service worker. The surface is read only in order to release the hide early — a shared tab cannot contain the bookmarks bar.

That is the entirety of what runs on a page. The scripts do not read, modify or transmit page content, do not touch the DOM, and do not read cookies, storage, forms or credentials. Nothing about the page — not its URL, not its contents — is stored or sent anywhere.
```

### Are you using remote code?

**No, I am not using remote code.** If the reviewer asks for a justification:

```
All JavaScript executed by this extension is contained in the uploaded package. There are no CDN references, no remotely hosted scripts or styles, no eval of fetched strings, and no network requests of any kind. Fonts are self-hosted inside the package.
```

### Data usage

Every one of the nine categories: **Not collected.** This is the same answer
`site/privacy.html` publishes, and it rests on the zero-egress check at the top
of this file.

| Category | Answer |
| --- | --- |
| Personally identifiable information | Not collected |
| Health information | Not collected |
| Financial and payment information | Not collected |
| Authentication information | Not collected |
| Personal communications | Not collected |
| Location | Not collected |
| Web history | Not collected |
| User activity | Not collected |
| Website content | Not collected |

All three certification checkboxes: **yes.**

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL

```
https://skrim.app/privacy
```

Live and serving 200, byte-identical to `site/privacy.html` — the check is
`diff <(curl -s https://skrim.app/privacy) site/privacy.html`. It publishes the
same nine **Not collected** answers as the table below, so the listing and the
policy cannot disagree without that diff failing first. Contact address on the
page is `support@skrim.app`.

### Support URL

```
https://skrim.app/support
```

**The dashboard fetches this one and fails validation on a 404.** It is on the
*Store listing* tab, not Privacy, and an invalid value greys out **Submit for
review** without saying which field is at fault until you open "Why can't I
submit?" — which is exactly the wall the 0.3.0 resubmit hit, because the field
had been filled in against a page that did not exist yet.

The page is generated by `tools/make-pages.mjs` like the intent pages, and for
the same anti-drift reason: it reuses the `LIMITS` and `SYNC_NOTE` blocks
verbatim rather than restating them, so a limit cannot change on four pages and
stay stale on this one. It carries no waitlist CTA — whoever is on it already
has Skrim or is a reviewer checking the link resolves.

Re-verify after any deploy, the same way as the policy URL:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://skrim.app/support   # want 200
```

---

## Store images

Built, in `brand/store/`. Upload the nominal files — the `@2x` copies beside
them are for the landing page, and the dashboard rejects anything that is not
the exact size.

| Dashboard field | File | Size |
| --- | --- | --- |
| Screenshot 1 | `brand/store/screenshot-1-armed.png` | 1280×800 |
| Screenshot 2 | `brand/store/screenshot-2-hidden.png` | 1280×800 |
| Screenshot 3 | `brand/store/screenshot-3-restore.png` | 1280×800 |
| Screenshot 4 | `brand/store/screenshot-4-privacy.png` | 1280×800 |
| Screenshot 5 | `brand/store/screenshot-5-coverage.png` | 1280×800 |
| Small promo tile | `brand/store/promo-tile-440x280.png` | 440×280 |
| Marquee promo tile | `brand/store/marquee-tile-1400x560.png` | 1400×560 |

The marquee is only shown if the extension is featured, and it is the one field
that can be filled in later without touching anything else. It is built anyway,
because the featured carousel is the only surface where the tile is seen before
the name, and because an editor looking for something to feature will not wait
while one is made. It is the small tile at poster scale — same scrim, same
geometry — with nothing load-bearing outside the centre 1120px, which is what
the carousel crops to on a narrow viewport.

Regenerate with `node tools/make-store-assets.mjs`; `brand/store/README.md`
covers the rest. Three things about them are worth knowing before a reviewer
reads them:

- **The popup in the images is the real popup.** `tools/popup-preview.mjs`
  serves `extension/popup.{html,css,js}` against stubbed fixtures, and the
  generator mounts that same handler and iframes the result. Change the popup,
  re-run, and the screenshots follow. The browser frame around it is a drawing,
  deliberately generic — no Chrome logo, no Chrome UI copied pixel for pixel.
- **The store has no caption field**, so every word is baked into the PNG. The
  claims in them are the claims made above, in the same words: screenshot 4
  carries the four statements the nine "Not collected" disclosures rest on, and
  screenshot 5 carries the *not covered* list — desktop apps and the picker
  preview — rather than burying it. A screenshot promising something the
  extension does not do is a rejection, and the honest version costs nothing
  here because the description already says it.
- **Numbers chain across screenshots 1–3**: twelve bookmarks on the bar, twelve
  tucked away, the same twelve back. Two of those live in the popup fixtures and
  one in the generator, and the generator throws if they disagree.

`node tools/check-listing.mjs` reads the PNG headers back and fails if a file is
missing, off-size, or blank, and it fails if the stand-in bookmarks drawn in
screenshot 2 stop matching `DECOYS` in `extension/src/engine.js`.

---

## Promotional video

**This field is not an upload.** It takes a YouTube URL, and only YouTube. The
master is built by `node tools/make-promo-video.mjs` into `brand/video/`:

| file | what it is |
| --- | --- |
| `brand/video/skrim-promo.mp4` | 1920×1080, 30fps, 36s, H.264, silent |
| `brand/video/skrim-promo-poster-1280x720.png` | the YouTube custom thumbnail |

```
Promotional video   https://www.youtube.com/watch?v=REPLACE_ME
```

Upload it **public**, not unlisted — the dashboard rejects a video it cannot
resolve, and an unlisted video that later goes private empties the field
silently. Use the long `watch?v=` form; the `youtu.be` short form has been
refused. Turn off end screens and cards: they render on top of the last five
seconds, which is the whole end card. `brand/video/README.md` carries the
suggested YouTube title and description.

Two things about the film are the same claims as the screenshots, and are worth
knowing for the same reason:

- **It depicts a whole-screen share, not a tab share.** `extension/src/hook.js`
  releases the hide the moment Chrome reports `displaySurface === "browser"`,
  because a captured tab cannot contain the bookmarks bar. A film showing the
  bar held down for the length of a tab share would advertise behaviour the
  extension deliberately does not have.
- **Nothing on screen is invented extension UI.** No toast, no progress bar, no
  badge — the extension raises none of those. The popup in the film is the real
  popup, in an iframe, exactly as it is in the screenshots, and the browser
  around it is the same generic drawing.

The film also carries the *not covered* list and the sync disclosure out loud,
in scenes 4 and 5, for the same reason screenshots 4 and 5 do.

---

## Two answers a reviewer is likely to ask for

Not dashboard fields — reply text, kept here so the answer is consistent with
everything above.

**"Why does the popup contain debugging controls?"** It does not, in a Web Store
copy. The Developer disclosure is `hidden` in the markup and its handlers are
left unbound whenever `chrome.runtime.getManifest()` reports an `update_url` —
which Chrome injects for an installed copy and omits for an unpacked one. Every
uncertain answer resolves to "shipped". See STATUS.md § M4.

**"Why are bookmarks modified at all?"** Because Chrome has no other lever.
Bookmarks-bar visibility is a browser preference with no extension API, so
moving the bookmarks is the only way to clear the bar. Every move is recorded
and reversed, and the extension is built around finishing that reversal even
after a crash.

---

## Rejection history

**0.3.0, 17 Aug 2026 — "Spam and placement in the Store", ref Yellow Argon.**
Violation: *"Having excessive keywords in the item's description"*, quoting
exactly `(Google, Gmail, Calendar, Drive, Maps, News)` from the HOW IT WORKS
list. Nothing was wrong with the package: same permissions, same version, an
approved 0.2.0 sitting underneath. The parenthetical was a factual list of the
decoy link names, but six brand names in a row is the shape of keyword stuffing
and the filter reads shape, not intent. Fixed by naming no brands there.

**The rule this leaves behind:** the description may name a product where it is
making a claim about that product — "tested in Google Meet and Zoom on the web",
"the Zoom desktop client captures outside Chrome" — because each of those
carries information. It may not carry a bare *list* of brand names. The
trademark line at the foot of the description is fine and should stay; it is
attribution, not metadata.

Not appealed. The offending clause was six words and the resubmit is a listing
edit with no package re-upload, so an appeal would have been slower and less
certain than deleting it.

---

## Still blocking submission

| | Field | State |
| --- | --- | --- |
| 1 | ~~Privacy policy URL~~ | **Done** — `https://skrim.app/privacy`, live |
| 2 | ~~Screenshots (1280×800)~~ | **Done** — five, `brand/store/` |
| 3 | ~~Small promo tile (440×280)~~ | **Done** — `brand/store/promo-tile-440x280.png` |
| 4 | ~~Clean-profile walk, no dev mode~~ | **Done** — see below |

**Nothing is blocking submission.**

### The clean-profile walk, and what it found

Run against a copy of `extension/` with `update_url` injected into the manifest —
the key Chrome adds for a store install, and the one thing the developer
disclosure is gated on — in a profile built from scratch. That is the only way to
exercise what an installed user gets rather than what a developer gets.

It confirmed the disclosure is hidden *and* its handlers unbound, that no
reachable control can call `recover()`, that the popup, the recovery page and an
ordinary page's console are all silent, that a hide and restore round-trips the
bar byte-identically with nothing left in storage, and that a receipt bookmark
opens and decodes from a real bookmark click.

Four defects came out of it, all fixed:

- **The automatic sweep ignored the receipt.** On a profile whose bar reports
  `syncing: false` — signed out, or bookmark sync off — a reinstall after an
  uninstall-while-hidden drained the vault by *appending*, and deleted the
  receipt unread. Six placeholder bookmarks stayed on the bar permanently and
  the original layout was lost. `sweepOrphanVaults` now uses the receipt for
  both, the way `adoptVault` always did. Covered by `RC-4b`–`RC-4e`, and by
  `RC-k`, `RC-l`, `RC-n`, `RC-o` in `mutate-recovery.mjs`.
- **The popup exceeded Chrome's 600px cap** when an unowned vault turned up
  during a live hide, clipping the facts list and the sync note off the bottom.
  The column is capped and `.body` scrolls; `L2c` measures it, `L2d` guards the
  recovery page against inheriting the same cap.
- **"1 bookmark are sitting in a Skrim folder."** Verb and pronoun now agree with
  the count, in both the popup card and the recovery page. `P-2b`, mutation `SY-k`.
- **Light-mode muted text was 4.23:1**, under AA. `--muted` was measured against
  the page but is used inside panels; it is `ink-600` now — 6.41:1 on `ink-50`.

### One thing to decide before submitting

`tabs` makes Chrome show **"Read your browsing history"** on the install prompt.
It is the scariest line a user sees, on an extension whose whole pitch is
privacy, and it buys exactly one feature: noticing Loom's capture tab. Moving it
to `optional_permissions` behind a toggle would drop it from the prompt at the
cost of Loom coverage until the user opts in. Not a defect and not a blocker —
but it is a listing decision, not an engineering one, so it is called out here
rather than settled quietly. See `STATUS.md` § known limits.
