# Skrim — resume point

Last updated: 2026-08-06. Read this first; it replaces re-deriving context.

**The product is now called Skrim** (was SecureShare). See "BR" below for what
that renamed and, more importantly, what it deliberately did not.

**Two repos as of 2026-08-06.** This one is public and source-available
(`github.com/krishnawp/skrim`, see `LICENSE` and `README.md`) — the source is
published so the privacy claims are checkable, not so the extension can be
repackaged. Everything commercial — pricing, funnel maths, launch sequencing —
lives in a **separate private repo**, `skrim-gtm`, alongside this one on disk.
That split is not tidiness: this repo is cloned into a Cloudflare build
container on every deploy and is readable by anyone, and neither should be true
of a pricing plan.

## How to test right now

```bash
cd /path/to/skrim
node tools/test-engine.mjs          # ~1s, prints a scoreboard, exit 0 = all green
node tools/mutate-m2.mjs            # proves the M2 tests would catch a regression
node tools/mutate-recovery.mjs      # same, for the uninstall/crash recovery layer
node tools/mutate-recorders.mjs     # same, for the Loom / other-extension layer
node tools/live-test.mjs            # ~75s, drives a REAL Chrome; needs no attention
node tools/check-listing.mjs        # store listing vs Chrome's field caps AND the code it claims
```

The website is live and can be swept without a login (see "SITE" below):

```bash
curl -sI https://skrim.app/privacy | head -1          # the store listing's link
curl -so /dev/null -w '%{http_code}\n' https://skrim.app/nope   # 404.html
curl -s -X POST https://skrim.app/api/waitlist \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"email":"x@example.com","company":"bot"}'      # honeypot: {"ok":true}, no row
```

The honeypot and invalid-email paths are the two that exercise the endpoint end
to end while provably writing nothing, which is what makes them safe to run
against production as often as you like.

Load the extension by hand: `chrome://extensions` → Developer mode → "Load
unpacked" → the `extension/` folder. (`--load-extension` no longer works on
Chrome 150 — see "Loading an unpacked extension" below.) Click the toolbar icon
for the popup; the Screen sharing row shows what the hook is currently seeing.
The old debug controls (Hide / Hide-no-decoys / Restore / Force restore / the
raw response) all still exist, inside the "Developer" disclosure at the bottom —
**but only on an unpacked copy**, which is what loading it by hand gives you.
See "M4" below for what decides that and why it is not a build step.

To look at every popup state without a browser profile, run the preview harness
in `tools/popup-preview.mjs` — it serves the real popup files with a stubbed
`chrome.runtime` and a fixture per state.

Manifest sanity-check against Chrome's own parser, without launching a browser:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$PWD/extension" --no-message-box   # silence == valid
```

**Warning:** hiding syncs. While the bar is hidden here it is empty on every
signed-in device. A **tab** share now releases it within seconds (see "Hiding
syncs" below); a window or whole-screen share still holds it down for the
meeting. `live-test.mjs` builds its own throwaway profile (`.test-chrome-auto`,
wiped every run) and never touches a signed-in one; for anything by hand use
`.test-chrome`, never the main profile.

## Current test result — green

```
assertions  284 pass / 0 fail
fault inject HIDE     30 repaired / 0 broken
fault inject RESTORE  41 repaired / 0 broken
mutations             29 M2 + 10 recovery + 10 recorder caught / 0 survived
1000-item hide        5ms
live (real Chrome)    67 pass / 0 fail
real hide latency     13-123ms for a 39-node bar, cold worker +~5ms
click to stream       ~69ms with the picker held shut
```

Every fix is mutation-tested: revert it in a scratch copy and the suite must
go red. All six round-3 fixes were verified this way, and one (the decoy loop
index) had NO coverage until that check exposed it. All twelve M2 decisions
were verified the same way; two (the beat replacing rather than merging a
frame's session set, and a new share re-asserting the hide) had no coverage
until that check exposed it.

## Milestone state

| | scope | state |
|---|---|---|
| M0 | Chrome Sync fan-out spike | **done** — see `M0-FINDINGS.md` |
| M1 | hide/restore engine + crash recovery | **done** — 85/85, 3 review rounds |
| M2 | `getDisplayMedia` MAIN-world hook | **done** — 149/149, 12/12 mutations caught |
| M3 | live test in a real browser | **done** — 54/54 automated, stage 2 walked by hand. Meet and Zoom clean; the local-page picker preview is not, and is accepted (see below) |
| R | surviving uninstall / a broken Chrome update | **done** — 10/10 mutations caught. See below |
| SY | the sync side effect: release tab shares, say the rest out loud | **done** — 10/10 mutations caught. See below |
| X | recorders living in ANOTHER extension (Loom) | **done** — 10/10 mutations caught, premise proven in real Chrome. See below |
| BR | brand guidelines v1.0 applied, rename to Skrim | **done** — see below |
| SITE | skrim.app: policy, recovery page, landing, waitlist | **done 2026-08-06** — deployed, swept green. See below |
| M4 | Web Store prep (policy, listing, $5) | **in progress** — everything code-side is done and `skrim.app/privacy` is now public, which was the last hard blocker. Left: the Chrome Web Store developer account, a clean-profile walk, and the submission itself. See below |

## BR — the brand, and the rename

Brand guidelines v1.0 (the artifact) are now applied to the extension. The rule
that decides everything: **green means covered.** It is the brand colour and the
protected state fused on purpose, so nothing else is allowed to be green, and a
green *fill* only ever moves the user towards cover.

Three things that changed behaviour, not just colour:

- **The exposed state lost its red button.** `Hide now` is the same green fill
  as `Hide bookmarks`. Flare marks the state you are in; green marks the way out
  of it. The hero, the pill and the headline already say it three times.
- **Restore became an outline button**, because it lifts the scrim.
- **The toolbar icon is now the state readout.** `chrome.action.setIcon` swaps
  between three silhouettes whose scrim position *is* the state — armed 41%,
  hidden 100%, exposed 0% with every line showing. Colour is the second channel,
  not the only one: ~1 in 12 men cannot separate our green from our flare, and
  covered-vs-exposed is the distinction this product exists to make.

Two bugs the verification pass caught, both real:

- **The popup replayed the hide animation on every open.** The markup starts on
  `armed` and the first render corrected it, so opening the popup while hidden
  animated a hide that happened an hour ago. Fixed with a `booting` class that
  suppresses transitions until the first render lands (popup.js drops it on the
  next frame). The scrim gesture is now reserved for an actual state change —
  a share starting while the popup is open.
- **The toolbar icon was never synced on a cold worker wake.** Only onInstalled,
  onStartup and messages refreshed it, and MV3 restarts the worker constantly.
  There is now a top-level `safely("action refresh", …)`, same pattern as the
  recorder scan. Covered by SW-6.

### What the rename did NOT touch

The name is user-facing only. Renaming any of these would have been a data
migration wearing a cosmetic disguise:

- **Storage keys stay `secureshare.*`** (`secureshare.journal`,
  `secureshare.shares`, `secureshare.ownedVaults`, `secureshare.watchdog`).
  Renaming them orphans a live journal — i.e. loses a hidden user's bookmarks on
  upgrade. The console prefix `[secureshare]` matches them on purpose, so what a
  developer greps for is what is actually in storage.
- **`VAULT_TITLES` and `TITLE_MARKS` gained an entry, never lost one.** Index 0
  is what we write; every other entry is what we must still recognise. A vault
  or receipt written before the rename is still sitting in people's trees, and
  after a sync it is sitting in trees that have never run the old build.
- **The `ssr1.` receipt token is unchanged** — it was deliberately never a brand
  name, for exactly this reason.

`tools/test-engine.mjs` seeds foreign vaults under the *legacy* title
(`VAULT_TITLE_LEGACY`) while `findVault` looks for the current one, so both ends
of the compat list are exercised on every run. `recovery.html` names both folder
titles, because it is read by people whose extension is already gone.

### Assets

- `extension/tokens.css` — byte-identical copy of `brand/tokens.css`; there is
  no build step, so `diff brand/tokens.css extension/tokens.css` is the check.
  `popup.css` `@import`s it, and `recovery.html` inherits it.
- `extension/fonts/` — Instrument Sans + Geist Mono, self-hosted woff2, ~99KB.
  Not a CDN: the extension CSP blocks one outright.
- `extension/icons/` — 10 PNGs from `tools/make-icons.mjs`, generated from the
  same geometry as `brand/logo/*.svg` and rasterised by the local Chrome. Re-run
  it after any change to the mark; Chrome will not take an SVG for
  `manifest.icons` or `action.default_icon`.

## M4 — what the packaged copy is allowed to contain

### The developer disclosure is now gated, not deleted

The "Developer" section at the bottom of the popup is a debugging surface: a
no-decoy hide, a **forced recover**, and the raw worker reply as JSON. Nothing
stopped it shipping, so every installed user was one click away from an
operation they had no way to read — and a Chrome reviewer reading `popup.html`
would have found it too.

Deleting it was the other option and was rejected: the stage-2 walk below drives
hide and restore by hand from exactly those buttons, and so does every manual
check of a state the preview harness cannot reach. So it is **gated on the copy,
not on the user**.

**The signal is the absence of `update_url` from `chrome.runtime.getManifest()`.**
Chrome injects that key for a Web Store install and omits it for one loaded
unpacked. It was chosen over the two alternatives on failure mode, not taste:

- `chrome.management.getSelf().installType` is the semantically exact answer,
  but it is async and puts the gate behind an API whose permission story we do
  not want to have to explain in the listing.
- A **build step** that strips the markup is the only thing that keeps the code
  out of the package entirely — and it is a step that can be forgotten, whose
  failure mode is the panel shipping. Runtime detection cannot be forgotten.
  Worth revisiting only if a packaging script exists for other reasons.

Three properties, each a mutation in `tools/mutate-m2.mjs` (`M4-a`..`M4-c`):

- **The `hidden` attribute is in the markup, not just applied by script.** It is
  the fail-safe, not the mechanism: if `popup.js` never runs, or throws before
  the gate, an installed user still never sees Force restore.
- **A shipped copy leaves the handlers unbound, not merely hidden.** Hiding
  satisfies the eye; not binding is what means there is no path to `recover()`
  at all — not by keyboard, and not by unsetting `hidden` from devtools
  (`M4-b`).
- **Every uncertain answer reads as "shipped".** No `chrome`, no `getManifest`,
  a manifest that will not read — all return false. The two ways of being wrong
  do not cost the same: one costs a developer their debug panel, the other puts
  Force restore in a stranger's popup (`M4-c`).

**Half the premise is proven against real Chrome, and half cannot be.**
`live-test` `L2b` asserts that an unpacked load really does report no
`update_url` and really does keep its controls — getting that wrong would
silently cost the manual walk its buttons. The store half — that Chrome injects
`update_url` for an installed copy — is not reachable from a local profile at
all, and stays reasoned about. If it were ever wrong, the cost is a visible wart
in a shipped popup, not exposed bookmarks.

`tools/popup-preview.mjs` stubs `getManifest: () => ({})`, because that harness
*is* the developer case; without it `&dev=1` would open a section popup.js keeps
hidden.

### Still to do before submitting

Three things, none of them code: **the Chrome Web Store developer account**
(the $5 and the identity/trader verification — the only step that waits on
Google's queue rather than on us, so it is the one to start first), a
**clean-profile walk**, and the submission. Sequencing lives in `skrim-gtm`.

`skrim.app/privacy` is live as of 2026-08-06 and was the last hard blocker; see
"SITE" below.

**Submit as Unlisted first, then flip to Public.** Same review queue, but on
approval it gives a real store install — and a store install is the only thing
that carries an `update_url`, which is what the developer-gate branch keys off.
`live-test.mjs` L2b asserts the *unpacked* branch only (`updateUrl === false &&
shown && wired`); the shipped branch is covered by `P-3` and `M4-a`..`M4-c` but
has never run in real Chrome, because nothing outside the store can make Chrome
inject that field. Flipping visibility afterwards does not re-trigger review.

**`extension.zip` must be built from inside `extension/`, not by Finder.** The
store reads `manifest.json` at the *archive root*; a Finder "Compress" of the
folder nests everything under `extension/` and the upload is rejected before
review with "Manifest file is missing or unreadable". It also injects a
`__MACOSX/` resource-fork entry per file and sweeps up `.DS_Store`. The first
zip committed here had all three faults. Rebuild with:

```bash
cd extension && zip -r -X ../extension.zip . -x '.DS_Store' && cd ..
unzip -l extension.zip | grep -E 'manifest|__MACOSX|DS_Store'
# manifest.json must appear with NO path prefix, and be the only line printed
```

Nothing checks this automatically — `check-listing.mjs` validates the listing
and the assets, not the package — so it is a manual step to re-verify on every
resubmit. **Bump `manifest.json` `version` on every resubmit too**; the store
refuses a re-upload at a version it has already seen, which is exactly the wall
you hit mid-rejection-round when you are least in the mood for it.

**The store images are built**: `brand/store/`, five screenshots at 1280×800
the small promo tile at 440×280 and the marquee tile at 1400×560, from
`tools/make-store-assets.mjs`. The
popup in them is the real popup — `popup-preview.mjs` already serves the shipped
`popup.{html,css,js}` against stubbed fixtures, so the generator mounts that
same handler behind its own routes and iframes the result, same-origin so it can
read the popup's true rendered height and size the frame to it. Edit the popup,
re-run, and the screenshots follow; a redrawn mock would not. The browser frame
around it *is* a drawing and is deliberately generic — no Chrome logo, no Chrome
UI copied pixel for pixel.

The store has no caption field, so every word is inside the PNG, and the five
are ordered as an argument rather than a gallery: bar up, bar down, the three
bars stacked so "goes back exactly" is shown instead of claimed, what leaves
your computer, and what it covers — including the two things it does not
(desktop apps, Chrome's own picker preview), said out loud rather than buried,
because a screenshot promising more than the extension does is a rejection.
Screenshots 1–3 are read as a sequence, so their numbers chain: twelve on the
bar, twelve tucked away, the same twelve back. Two of those numbers live in the
popup fixtures and one in the generator, and the generator throws if they ever
disagree. This is why `FIXTURES.armed` now carries a bar of 12 rather than 9.

`tools/check-listing.mjs` went from 24 checks to 38 for it: every file exists,
is a PNG, and is exactly its field's size — read out of the PNG header, the same
bytes the dashboard reads — none is the blank few-KB PNG a failed headless
render writes, and the stand-in bookmarks drawn in screenshot 2 still match
`DECOYS` in `extension/src/engine.js`. Mutation-tested like the rest: a moved
file, a resized file, a seventh decoy in `engine.js`, and a broken count chain
each turn it red.

**The listing copy is written**: `docs/store-listing.md`, one fenced block per
Developer Dashboard field with its character cap on the heading — title,
summary, description, single purpose, a justification per permission, the nine
data disclosures, the remote-code answer. Two things about it are worth not
undoing by accident:

- **The Summary must stay byte-identical to `manifest.json` `description`.**
  Chrome pre-fills that field from the manifest, so an edit made only in the
  dashboard silently reverts on the next package upload.
- **The copy makes claims about the code, so the code can break the copy.**
  "No network requests at all" and all nine categories reading "Not collected"
  both rest on the zero-egress grep. Setting `receipt.RECOVERY_BASE` is the
  first thing that would falsify them, and a false data disclosure is a
  takedown rather than a rejection.

**The marquee tile is built** (`brand/store/marquee-tile-1400x560.png`). That
field only matters if the extension is featured, and it can be added later
without touching anything else — it exists now because the featured carousel is
the only surface where the tile is seen *before* the name, and an editor looking
for something to feature will not wait while one is made. It is the small tile
at poster scale rather than a second idea: same scrim at the mark's own 41%,
same lit edge, same titles caught half-way through being swallowed. Two things
about it come from where it is shown and should not be "tidied" away — nothing
load-bearing sits outside the centre 1120px, because the carousel crops from the
sides on a narrow viewport; and the chip field fades into the ground at the
bottom rather than being cut by the frame, because a row sliced through its own
letterforms reads as a rendering fault.

**The promo video is built**: `brand/video/skrim-promo.mp4`, 1920×1080, 30fps,
36 seconds, silent, from `tools/make-promo-video.mjs`, plus a 1280×720 poster
for the YouTube thumbnail. **The store's video field is a YouTube URL, not an
upload** — `brand/video/README.md` carries that errand, including the two ways
it goes wrong (an unlisted video that later goes private empties the field
silently, and end screens render on top of the last five seconds).

Same anti-drift property as the screenshots, and by the same means: the film
imports its browser mock, bookmarks bar, colours and copy lists straight out of
`make-store-assets.mjs`, and iframes the **real popup** off `popup-preview.mjs`.
There is no second drawing of a bookmarks bar in this repo. Four things about it
are decisions rather than accidents:

- **It depicts a whole-screen share, not a tab share.** `src/hook.js` releases
  the hide the moment Chrome reports `displaySurface === "browser"`, so a film
  showing the bar held down for the length of a tab share would be advertising
  behaviour the extension deliberately does not have. Hence the "Sharing your
  screen" pill rather than the screenshots' "Sharing this tab". **Screenshot 2
  says "Sharing this tab" beside a bar that stays hidden and a popup reading
  "Hidden for 4 mins", which is the same mismatch — worth a one-word fix in
  `make-store-assets.mjs` next time that file is opened.**
- **Nothing on screen is invented extension UI.** No toast, no progress bar, no
  badge, because the extension raises none of those.
- **`FIXTURES.justHidden` exists for the film.** `shielded` reads "Hidden for 4
  mins", and four minutes two seconds after the viewer watched the bar clear is
  a continuity error. It is also the only preview state that reaches
  `elapsed()`'s under-a-minute branch.
- **Every animation is a paused Web Animation with an explicit delay**, so
  `seek(t)` is the whole clock — no wall time, no rAF, no `setTimeout`. One
  headless Chrome is held open over CDP and driven frame by frame at dsf=2
  (3840×2160, supersampled down by ffmpeg). Frame 480 is identical whether it is
  rendered first or last, which is the only reason a 1080-frame render can be
  trusted without watching all 36 seconds. ~3 minutes end to end.
  The one trap: the popup's CSS transitions must be `finish()`ed, not pinned to
  `currentTime = 0` — pinned to zero they render the empty shell the popup shows
  for one frame before its stubbed `sendMessage` resolves, which put an outline
  button where the shipped one is a green fill.

`node tools/check-listing.mjs` (~0.1s, 45 checks) is what holds both. It
re-measures every field against Chrome's real caps — the 1000-char cap on the
justification fields is the one that bites, and three of them were over it when
first written — diffs the summary against the manifest, re-runs the egress and
remote-resource greps, asserts `RECOVERY_BASE` is still `null`, and fails if a
permission is added to the manifest without a justification (or justified after
being dropped). Mutation-tested like everything else: a `fetch()` in `sw.js`, a
drifted `description`, a hosted `RECOVERY_BASE` and a new unjustified
permission were each injected and each turned it red. It also now reads the
marquee tile's header, checks the video master is a real `ftyp` mp4 rather than
a truncated render, checks the poster is exactly 1280×720, and checks the
film's popup fixture still agrees with the numbers the film's captions say out
loud.

**The privacy policy is written**: `site/privacy.html`, self-contained like
`restore.html`. It already carries the permission justifications (`bookmarks`,
`storage`, `alarms`, `tabs`, `<all_urls>` content scripts) in a form the listing
can reuse verbatim, and declares all nine Chrome data categories "Not
collected" — resting on zero network egress, which is grep-verifiable: no
`fetch`/XHR/`sendBeacon`/WebSocket anywhere in `extension/`. **Anything that
adds a request breaks that claim and the policy must change with it** — the
first candidate is setting `receipt.RECOVERY_BASE`, since a hosted recovery page
turns the uninstall URL into a real request (a count and a timestamp; the
bookmark payload stays in the fragment). The policy states the bundled
`recovery.html` as today's destination and promises an update before that
changes. Two things it discloses rather than buries: Chrome Sync propagating the
vault/receipt/decoys (see "SY"), and the fragment never reaching a server. It is
**live at `skrim.app/privacy`** as of 2026-08-06, which is the URL to paste into
the listing. The contact address is the developer email until a `skrim.app`
mailbox exists.

One wrinkle the deploy created: the repo now contains network code, in
`worker/`. The policy and all nine "Not collected" disclosures rest on a grep
that is **scoped to `extension/`**, and that scoping is now load-bearing rather
than incidental. `check-listing.mjs` re-runs it on every check, so a `fetch` can
only reach the extension by turning the listing red first. `README.md` states
the boundary out loud for the same reason — an auditor who finds a Worker in a
repo claiming zero egress deserves the answer before they have to ask.

## SITE — skrim.app, deployed 2026-08-06

Live and swept green. A Cloudflare Worker (`worker/index.mjs`) with static
assets (`site/`) and one D1 database (`skrim-waitlist`), configured entirely by
`wrangler.jsonc`.

**Two of these URLs are effectively permanent and must never move.**
`/privacy` goes into the Chrome Web Store listing, where changing it means an
edit and a re-review. `/restore` is worse: it is what `receipt.RECOVERY_BASE`
will point at once it is set, and a receipt URL is written *into the user's
bookmark tree* — it syncs to their other devices and outlives an uninstall, so
it has to resolve for as long as anyone still holds one. That is a commitment
measured in years, made by a one-line config change, which is why the config
says so in a comment rather than leaving it to be rediscovered.

### What is public, and why almost nothing is

`assets.directory` is `./site`. Only what is inside it is uploaded to the edge;
the Worker script is compiled and uploaded through a different channel entirely,
which is why `/worker/index.mjs` 404s while running on every request. The build
container clones the whole repo — `extension/`, `brand/`, `snapshots/`, `.git`
— but none of it is uploaded and none of it is reachable. Verified rather than
assumed: `/STATUS.md`, `/package.json`, `/wrangler.jsonc`, `/schema.sql`,
`/extension/manifest.json`, `/extension/src/engine.js`, `/brand/store/*.png`,
`/tools/test-engine.mjs` and `/.git/config` all return 404.

**This is an allowlist, not a denylist** — the inverse of the Vercel model,
where the build output ships and you exclude from it. Nothing here is web-
reachable unless it is inside `assets.directory`. The one way to break that is
pointing it at `"./"` as a shortcut, which publishes the repo, `.git` included.

`run_worker_first: true` is load-bearing and not a preference:
`not_found_handling` resolves unmatched requests to `404.html` *instead of*
invoking the Worker, so with the default precedence `POST /api/waitlist` would
be answered by the 404 page and the form would silently never write a row.
Running the Worker first also lets it own the www redirect, which asset serving
cannot do.

### The waitlist endpoint

`POST /api/waitlist`, backed by D1. `schema.sql` is one table with `email` as
the PRIMARY KEY rather than an id plus a UNIQUE index, so a resubmit is an
`ON CONFLICT DO NOTHING` no-op instead of a duplicate row to clean up.

**It answers identically whether the address was new, already present, or caught
by the honeypot.** An endpoint that says "already subscribed" is an endpoint
that answers *is this person on your list* — a question about a real individual
that no visitor should be able to ask. Counts are available over the CLI or the
D1 console, where they belong. It accepts both JSON and urlencoded bodies
because the page is built to work with JavaScript disabled, and a signup form
that silently does nothing is worse than no form at all.

### How it deploys

Git-connected via **Workers Builds** — push to `main` and Cloudflare runs
`npx wrangler deploy`. No build step; there is nothing to compile. Local
`wrangler` was never authenticated on this machine and does not need to be.

**`wrangler.jsonc` is the source of truth, so do not edit bindings in the
dashboard** — a D1 binding added there is silently overwritten by the next push.
The dashboard is for *resources* (creating the database, reading logs, running
SQL) and read-only for *configuration*. This is the one thing about the setup
that will bite a future change if it is forgotten.

### Sweep, 2026-08-06

```
/ /privacy /restore              200
unmatched path                   404, serves 404.html
www.skrim.app/privacy            301 -> https://skrim.app/privacy (path kept)
headers on /privacy              nosniff, no-referrer, DENY
GET  /api/waitlist               405 + Allow: POST
POST invalid email  (JSON)       400 {"ok":false,"error":"invalid_email"}
POST invalid email  (form)       303 -> /?invalid=1
POST honeypot filled             200 {"ok":true}, no row written
real signup                      row confirmed in D1
```

`no-referrer` is the header that earns its place rather than being boilerplate:
the uninstall URL arrives at `/restore` carrying `?n=<count>&at=<timestamp>`,
and without it any link a reader then clicked would carry that querystring to a
third party. There is deliberately **no CSP** — every page inlines its own
`<style>` and `<script>`, so a policy permissive enough to run them needs
`unsafe-inline`, and a CSP with `unsafe-inline` is decoration. Hashes were the
alternative and were rejected: they go stale on every content edit, and the
failure mode is a privacy policy that renders blank for a Chrome reviewer.

## M2 — how a share becomes a hide

```
page calls getDisplayMedia()
  └─ hook.js      MAIN world, patches MediaDevices.prototype (a Proxy, so the
     │            page still sees a native-looking method)
     │            posts {ns,v,kind,sid} to its own window
     └─ bridge.js  ISOLATED world, same frame, validates shape + source,
        │          chrome.runtime.sendMessage
        └─ sw.js   routes share:* to
           └─ sessions.js   counts live sessions per FRAME in storage.session,
                            hides on the first, restores on the last
```

**The hide starts when getDisplayMedia is CALLED, not when it resolves, and the
call itself is held until the bar is actually down.** Chrome's picker previews
every window before the user chooses, and the first frames go out the instant
they click Share. A cancelled picker rejects, and the reject path releases the
session — so being early costs one hide/restore cycle, and being late costs the
bookmarks bar on the wire.

Announcing the share and calling straight through left the ordering to chance:
a real hide takes anywhere from 13ms to 123ms depending on machine load, and
nothing guaranteed it finished before Chrome acted on the call. So the hook
waits for the worker to confirm the hide before invoking the real method
(`hidden` reply, bridged back from `share:start`), which turns the ordering from
a bet into a guarantee. (This did NOT change what Chrome's picker preview shows
— see "M3" below for what that ruled out.) It is
bounded at `HIDE_WAIT_MS` (400ms) and **fails open**: a broken or slow worker
delays the picker by at most that and the share proceeds regardless. Measured
cost in a real browser is ~69ms from click to stream. Transient activation
survives the wait — Chrome's window is 5 seconds.

Four independent ways a share ends, because each covers a case the others miss:

| signal | covers | latency |
|---|---|---|
| `ended` event | Chrome's own "Stop sharing" button | instant |
| wrapped `track.stop()` | the page ending its own share (`stop()` fires no `ended`) | instant |
| `tabs.onRemoved` | the tab being closed mid-share | instant |
| 10s beat + 35s expiry | crashed renderer, discarded tab, closed lid, navigation | ≤ 95s |

The beat also carries the frame's live sid list, and that list **replaces**
whatever the worker held. That is what makes a worker terminated mid-share (MV3
kills it after ~30s idle) or an extension update that wiped `storage.session`
self-healing in both directions: it re-registers a share the worker forgot, and
retires one whose `end` nobody was awake to hear.

Session state lives in `storage.session`, never `storage.local`: Chrome wipes it
when the browser closes, and a browser restart ends every share, so a stale
session cannot outlive the share it describes. The bookmark journal is the exact
opposite case and correctly stays in `storage.local`.

## M3 — the live test

M3 is not a new feature. It is the test of M2 against a real `getDisplayMedia`,
a real `chrome.bookmarks` and a real profile. Stage 1 is now automated end to
end in `tools/live-test.mjs` (52 checks, ~90s, no human input). Stage 2 is the
part a machine cannot reach.

### What M3 found

**Stage 1 said the timing bet held. Stage 2, by hand, showed it did not.** On a
local page with a Share button, the bookmarks bar was still visible inside
Chrome's picker preview. On Meet and Zoom — window and entire-screen, both — it
was already empty, and came back correctly on both "end the meeting" and
Chrome's own Stop sharing.

The working hypothesis was that hiding after the call was a race — won against
real conferencing apps, lost against a page that calls `getDisplayMedia` the
instant you click. It turned out to be wrong (below), but two other explanations
were measured and rejected first, and those measurements stand:

- *A cold service worker is slow to wake.* Measured: a genuinely stopped worker
  reaches `hide()` at +12–47ms and finishes at +16–51ms. Cold costs about 5ms.
  Not the cause. (The first attempt at this measurement was itself wrong — the
  harness holds the worker open with a debugger, so every earlier number was a
  warm one. `CS*` now stops the worker outright.)
- *The bar was simply slow.* Measured across runs: 13ms, 30ms, 38ms, 71ms,
  123ms. Machine load moves it by an order of magnitude, which is exactly what
  makes a race an unacceptable design.

**The change: the hook no longer lets Chrome open the picker until the bar is
down.** `share:start` is answered by the worker only after `engine.hide()`
resolves; the bridge posts that reply back into the page as `hidden`; the hook
awaits it and only then calls the real `getDisplayMedia`. Bounded at 400ms and
fails open, so a broken worker can delay a share but never block one. Cost
measured in a real browser: ~69ms from click to stream.

**It did not fix the symptom, and the race was therefore not the cause.**
Re-walked by hand afterwards: the local page's picker preview still shows the
bookmarks bar, with the ordering now guaranteed and unit-tested. If the bar is
provably down *before* Chrome is asked to open the picker and the preview still
shows it, then that preview is not a capture taken at call time — the likeliest
explanation is a window thumbnail Chrome already had. Nothing this extension
does at call time can reach that, and no amount of hiding earlier will.

The change is **kept anyway**, on its own merits and not as a fix for the above:
the ordering is now deterministic rather than dependent on machine load (13ms to
123ms across runs), and the frames that go out the instant the user clicks Share
are the thing this extension actually exists to protect. It costs ~69ms and is
covered by four mutations.

What was NOT established: why Meet and Zoom show a clean preview and the local
page does not. Both were watched by hand, both repeatedly. If this is ever worth
reopening, the cheap next probe is whether the preview is stale rather than
early — hide the bar by hand, wait several seconds, then open a picker and see
whether the thumbnail has caught up.

The one deliberate behaviour change: the real method is now invoked after an
`await`, so a method that throws **synchronously** surfaces as a rejection
instead. No page can tell — Web IDL turns even
`MediaDevices.prototype.getDisplayMedia.call(null)` into a rejected promise,
never a throw, which M3 confirmed against a live browser (`live-test` D4).

### What else stage 1 proved

Also proven against the real browser, none of which the mock could settle:

- content scripts inject at `document_start`, `world: "MAIN"` is honoured, and
  the hook reaches same-origin sub-frames (`all_frames`);
- the patched method still stringifies as `[native code]`, keeps `name` and
  `length`, and is on the prototype, not the instance;
- a real hide → real restore returns the bar **exactly** — order, nesting, URLs;
- a rejected call releases the session and restores by itself;
- two overlapping shares hide once and restore only when the **last** ends;
- closing a sharing tab restores (`tabs.onRemoved`);
- killing the worker mid-share strands nothing: it comes back, the 10s beat
  re-registers the session it never heard start, and restore still works.

The hook's synchronous-`throw` branch is unreachable from a page for the same
Web IDL reason. It stays — an `original` already replaced by another extension
can throw — but it is defensive, not a path real Chrome takes.

### Stage 2 — walked by hand, and how to walk it again

Done once, before and after the ordering change. Result: **Meet and Zoom are
clean** — bar empty in the picker preview for both window and entire-screen
sharing, and back afterwards on both "end the meeting" and Chrome's own Stop
sharing. **The local page is not**, unchanged by the fix. Accepted: the shipping
cases are the real ones.

Everything here needs the real picker, which cannot be automated: it is a native
dialog, and the `--auto-accept-this-tab-capture` flag the harness relies on
bypasses it entirely.

```bash
node tools/live-test.mjs --keep     # runs stage 1, then leaves Chrome open
```

`--keep` runs stage 1, then **restarts Chrome without
`--auto-accept-this-tab-capture`** on the same profile — that flag accepts every
request including the picker, so a browser left over from stage 1 could never
show the one dialog stage 2 exists to look at. The profile also pre-seeds
`bookmark_bar.show_on_all_tabs`, since a new profile hides the bar everywhere
but the New Tab page. Bar seeded, page at `http://127.0.0.1:8787`, and the
terminal keeps serving it until Ctrl-C. **Do not sign this profile in.**

1. **Click "Share screen" and look at the picker's own preview thumbnail.** The
   bar is still visible here and holding the picker shut did not change that;
   see above. Worth re-checking only if the cause is being reopened.
2. **End the share with Chrome's own "Stop sharing" button** — the `ended`
   event. It is the path almost every real share ends on, it is unit-tested,
   and it is the only one of the four end signals stage 1 cannot trigger
   (`track.stop()`, `tabs.onRemoved` and the beat are all covered).
3. **Cancel a picker** and confirm the bar comes back exactly.
4. Then **Meet / Zoom Web / Slack**, which is about their SDKs, not ours.

If the preview still shows the bar, the timing premise is wrong and the fix is
a different shape — a pre-emptive hide on page load for known conferencing
hosts, trading a much longer hidden window for a guaranteed-clean picker. That
is a product decision, not a bug fix, and it lands before M4 not after.

### Loading an unpacked extension on Chrome 150 (this cost an hour)

Three separate blockers, each silent:

- **`--load-extension` no longer loads anything.** No error, no log line, no
  entry in `chrome://extensions`. `--disable-features=DisableLoadExtensionCommandLineSwitch`
  revives it on some builds; it did not on 150.
- **`--disable-extensions-except=<path>` disables the extension it names too.**
  The symptom is the extension's own pages answering `ERR_BLOCKED_BY_CLIENT`.
- **What works:** launch with `--enable-unsafe-extension-debugging`, then call
  CDP `Extensions.loadUnpacked({path})` on the browser target. It returns the
  extension id, and the profile needs `extensions.ui.developer_mode: true`
  pre-seeded into `Default/Preferences` — there is no command-line switch for
  developer mode.

Two more traps the harness works around, both of which look like product bugs:

- `getDisplayMedia({preferCurrentTab:true})` fails with `InvalidStateError` on a
  tab that is not the **active** one, so every share activates its tab first.
- A CDP target exists a moment before its `chrome.*` namespace is populated;
  evaluating into that gap fails with an undefined `chrome.storage`.

Finally: a Chrome still holding a profile's `SingletonLock` makes the next
launch hand its arguments to the *first* process and exit — no extension, no
debugging port, no error. The harness pkills by profile path before launching.

## R — surviving the extension itself

Everything in M1–M3 assumes the extension is still there to finish what it
started. This is the case where it is not.

**The old failure.** Chrome deletes `chrome.storage.local` on uninstall. The
bookmarks survive — they are the user's own data, sitting in the vault folder —
but the journal saying where each one belongs goes with the extension. Nothing
was ever lost except the *addresses*, and that was enough to make it
unrecoverable: no order, no positions, and six fake Google bookmarks on the bar
that the user had no way to identify. A Chrome release that broke the service
worker was the same failure with the data still intact and nothing running to
read it.

**The fix: write the addresses into the one store that outlives the extension —
the bookmark tree.** Every hide now leaves a *receipt* inside the vault: an
ordinary bookmark whose title is a complete instruction a human can follow with
no software at all, and whose URL carries the machine payload in its fragment.

```
Other bookmarks
└── SecureShare — hidden while screen sharing (drag these back…)
    ├── ⚠️ SecureShare recovery — your 39 bookmarks are IN THIS FOLDER. Drag
    │   them onto your bookmarks bar to put them back, then delete these 6
    │   look-alike links we added to the bar: Google, Gmail, Calendar, …
    │   → chrome-extension://<id>/recovery.html#ssr1.<base64url payload>
    ├── Work
    └── …
```

Four properties are load-bearing, and each is a mutation in
`tools/mutate-recovery.mjs`:

- **The URL never has to resolve.** The only reader is our own code parsing
  `node.url` as a string, so a receipt written before the product has a domain
  is still restorable after it has one — and a dead link costs nothing, because
  the title already said everything. Verified against real Chrome: it accepts a
  bookmark with a `chrome-extension://` URL (`live-test` B6b).
- **Recognition is by the `ssr1.` payload token, never by a brand name.** The
  name is not settled; a rename that stopped recognising receipts already in
  people's trees would strand exactly the bookmarks this exists to hand back.
  `VAULT_TITLES` in `engine.js` is the same idea for the folder — append to it,
  never edit it.
- **A receipt naming its own vault's id proves it was written on this profile.**
  Bookmark ids are profile-local, so the same folder arriving over sync carries
  a receipt naming an id that means something else here. That is the only
  durable evidence of origin in the tree, and it is what finally tells "my own
  pre-uninstall vault" apart from "a synced peer's live hide" — the distinction
  age could never make (see the orphan-sweep comment for why age is not it).
- **The receipt outlives a half-finished restore.** It is discarded only once
  every item it describes is provably back on the bar; a vault still holding a
  stuck item keeps both.

**What a reinstall now does.** `adoptVault` rebuilds a journal from the receipt
and runs the ordinary restore — so original indices, decoy removal by id,
relative-order verification and vault cleanup are all inherited rather than
reimplemented. The bar comes back byte-identical, including a policy-managed
bookmark sitting mid-bar that the old append-only path would have walked past
(`RC-2`, `RC-3`). Without proof of local origin it falls back to appending,
which is all a pre-receipt vault could ever offer.

**What a broken worker now does.** `recovery.html` is an extension page, so it
loads whether or not the service worker will start. It asks the worker first —
two engines mutating one tree is a race worth not having — and drives the engine
in its own context when nothing answers within 2s. And every listener in `sw.js`
is registered through `safely()`: they are all top-level by MV3 necessity, so
one throw used to leave *none* of them registered, `onMessage` included, and the
popup could not reach the engine to put the bar back by hand (`RC-10`).

**Still off, deliberately: `setUninstallURL`.** Chrome opens a page of our
choosing the moment the user uninstalls — the only notice an extension ever gets
about its own removal, and precisely when it has something to say. The logic and
its tests are in place (`receipt.uninstallUrlFor`, `RC-8`), gated on
`receipt.RECOVERY_BASE`, which is `null`. A link that does not resolve to a real
page, delivered at that moment, is worse than silence. `site/restore.html` is
the page it points at — self-contained, decodes the same payload with no
extension installed, and its decoder is asserted against the real encoder in
`RC-7` so the two cannot drift. **Turning this on is one constant, after that
page is actually hosted.** `skrim.app` is bought and is where it goes, but
nothing is served from it yet, so the gate stays shut until there is a live URL.

## SY — "hiding syncs", and what was actually done about it

The complaint (M0 §6): the hide is a `chrome.bookmarks` mutation, bookmark
mutations sync, so hiding here empties the bar on **every other signed-in
device** — for the whole meeting. There is no way out head-on. Chrome exposes no
API for bookmarks-bar visibility (`bookmark_bar.show_on_all_tabs` is a pref), so
every lever this extension has is a mutation, and every mutation syncs.

Three approaches were rejected before the one that shipped, and they stay
rejected:

- **A local-only vault via split storage.** Moving an account bookmark into
  local storage *removes it from the account*: peers see a delete, not a move,
  and the round trip re-uploads a new GUID. Strictly worse than today.
- **Fullscreen the window** (`chrome.windows.update({state:"fullscreen"})`).
  Local, no sync, hides the whole toolbar — but on macOS it moves the window to
  a new Space, which can disrupt the very share it is protecting, and it takes
  the tab strip away from a presenter.
- **Native keystroke (⌘⇧B) via a native messaging host.** Genuinely eliminates
  the problem, never touches bookmarks, and needs a separately installed native
  binary — incompatible with plain Web Store distribution. Still the right
  answer for a later version.

### What shipped: release the shares that never needed the hide

The hide must start before the picker opens — nobody knows yet what will be
picked, and Chrome photographs every window for the preview. But the resolved
stream says what was picked, and **a captured Chrome tab cannot contain the
bookmarks bar**: a tab capture is the page's own contents, not the browser frame
around it. So `track.getSettings().displaySurface === "browser"` releases the
session at once, and the bar comes back — here and, ~2s later, everywhere else.

Tab sharing is what Meet and Zoom recommend by default, so the common case goes
from an hour of collateral damage to a few seconds.

Four properties, each a mutation in `tools/mutate-m2.mjs` (`SY-a`..`SY-e`):

- **The surface is read only ever to RELEASE.** A whole screen, a window, a
  Chrome that does not report the key, a `getSettings` that throws, one screen
  track among tabs — all fall through to "keep hiding". The failure mode is the
  old behaviour, never exposure (`H-12`).
- **`configurationchange` re-evaluates it.** Chrome's "Share this tab instead"
  swaps the captured surface under a live track with no second
  `getDisplayMedia` call. Both directions: an upgrade releases, a downgrade puts
  the bar back down (`H-13`).
- **A released session is retired, not forgotten.** It stays in the hook's map
  so a later surface change can re-assert the hide, but it stops counting
  towards the worker's tally and stops holding the beat open — otherwise the
  next beat would re-register it and hide the bar again (`SY-d`).
- **The premise is checked against real Chrome, not the mock.** `live-test.mjs`
  `TS3` reads `displaySurface` off a real track with nothing patched. If Chrome
  ever stops saying `"browser"` for a captured tab, that fails rather than the
  feature silently reverting to hiding for the whole meeting.

The live harness needed a change to keep its meaning: `--auto-accept-this-tab-capture`
bypasses the picker, so **every** share it can start is a tab capture and is now
released — which made the entire "the bar stays down for the duration" half of
the suite unreachable. `window.__ss.surface(kind)` patches
`MediaStreamTrack.prototype.getSettings` in the page's own world (where the hook
reads it from), and `startShare` claims `"monitor"` by default. Passing `null`
uses Chrome's real answer, which is what `TS1`..`TS6` do.

### The half that could not be fixed: saying it out loud

Window and whole-screen shares still hold the bar down everywhere for the
meeting. We cannot tell whether a shared *window* is a Chrome window, and
over-releasing would put bookmarks on a live call, so it does not guess.

- **The sync note is now conditional** on `bars.some(b => b.syncing !== false)`.
  A profile whose bar does not sync has no other devices to lose, and warning it
  about them is a scare with no referent. Unknown (older Chrome, no flag) still
  warns — silence is the surprise the note exists to prevent (`P-1`).
- **The peer device is told what happened.** This is where the complaint is
  actually felt: a machine that started no share, whose bar went empty anyway.
  The detection already existed — `pendingAdoptions()` returns `local`, which is
  the vault's receipt naming its own bookmark id, and ids are profile-local, so
  a vault that arrived over sync cannot forge it. What was wrong was the
  presentation: it read as a recovery offer, and its **primary button was the
  harmful one** — restoring on a peer syncs the bookmarks back onto the bar the
  other machine is presenting from, and a restore is never re-hidden.

  Now: informational tone rather than amber, a heading that says *Hidden by
  another device*, copy that says the bar comes back on its own, and the Restore
  button demoted to `btn--quiet` with a caveat next to it. It is demoted, not
  removed — it is still the only way out if that machine crashed or was
  uninstalled mid-share (`P-2`).
- **Three origins, not two.** `local: false` covers both "a peer's live hide"
  and "no receipt at all, so we cannot tell" — the latter being a pre-receipt
  vault or one whose receipt the user deleted. Claiming another device is
  sharing there would be a confident lie, so `describeVault` now also reports
  `receipt: !!rec` and the unknown case keeps the older, vaguer wording. Both
  non-local cases get the demoted button: not knowing is a reason for caution,
  not for confidence.
- **The badge has two tones.** A failed restore, or our own vault from a
  reinstall, is still a red `!`. A *provable* peer hide is a quiet blue `•` —
  red would send the user hunting for a fault and hurry them into the one action
  that harms. A receiptless vault stays loud: muting the only notice a user gets
  that their own bookmarks are parked is the more expensive mistake (`SW-5`).

## X — Loom, and every other recorder we cannot hook

**The symptom.** Meet, Slack, Teams and Zoom Web all hide the bar correctly.
Recording with the **Loom Chrome extension** did nothing at all.

**The cause, read out of Loom 5.5.202 on this machine rather than guessed.**
Two independent reasons, either fatal on its own:

- Loom captures from `chrome-extension://liecbdd…/html/pinnedTab.html`, opened
  by its own worker with `chrome.tabs.create({url:"./html/pinnedTab.html",
  index:0, pinned:true})`. **Chrome will not run a content script on another
  extension's pages** — no manifest key, no permission, no flag changes that —
  so `hook.js` is simply never installed where the call happens.
- `js/pinnedTab.js` is the only file in the extension that calls
  `chooseDesktopMedia`, and the only one mentioning `chromeMediaSource`. It
  never calls `getDisplayMedia`. **`chrome.desktopCapture` is an extension-only
  API that opens the same native picker**, so even with an injected hook we
  would be patching a method nobody calls.

This is a whole class, not one product: any recorder that captures from its own
extension page is invisible to M2 by construction. Vidyard, Screencastify and
Awesome Screenshot are the same shape.

**The fix: the capture context is a TAB, and a tab is the one thing about
another extension chrome.tabs will tell us about.** A recorder's capture page
appearing as a tab is the start signal; the tab going away is the end signal.
`recorders.js` holds the registry (id + capture-page path prefixes) and the
matcher; `sw.js` wires `tabs.onCreated` / `onUpdated` / the watchdog to it;
`sessions.js` counts the result alongside ordinary shares, so a Loom recording
and a Meet call at once are one hide that lasts until both finish.

Cost: the **`tabs` permission**, which is new. It adds "Read your browsing
history" to the install prompt — next to nothing beside the `<all_urls>` content
scripts already there, which produce the strongest warning Chrome has. M4 has to
justify both in one paragraph, not two.

Five properties, each a mutation in `tools/mutate-recorders.mjs`:

- **A recorder has no beat, so it is exempt from the beat clock.** There is no
  hook in another extension's page to send one. Ageing these records out on the
  35s clock would put the bar back 35 seconds into a five-minute recording
  (`X-a`). The end state alone does not show it — the tab scan that runs right
  after the sweep re-hides immediately — so `X-3` asserts on **bookmark events**,
  not on the bar. The wrong version produced 24 of them per watchdog tick: every
  bookmark back onto the screen being recorded, and away again, once a minute.
- **The tab query is the recorder's beat.** It runs on the watchdog *and* on
  every worker wake, and it **replaces** the whole recorder set, so it heals
  both directions — a recording the worker never heard start (MV3 killed it, or
  an update wiped `storage.session`), and a hide whose tab closed while nothing
  was awake to hear it (`X-f`, `X-g`).
- **A scan that changed nothing must NOT re-assert the hide.** It runs every
  minute for the whole recording; re-asserting would undo the popup's Restore
  behind the user, silently, with no way for them to win (`X-b`).
- **Only a committed navigation is acted on.** `onUpdated` fires many times per
  page load with no `url` in `changeInfo`; treating those as "not a recorder any
  more" released the hide seconds after taking it (`X-d`).
- **Both `url` and `pendingUrl` are read.** Proven necessary against real
  Chrome, not reasoned about: `X-L4` shows `onCreated` delivering
  `{url: "", pendingUrl: "chrome-extension://…"}` — the navigation has not
  committed yet. Reading one field misses the start of every recording (`X-c`).

**The premise is proven in a real browser** (`live-test` `X-L1`..`X-L6`). The
whole feature rests on Chrome reporting a *different* extension's
`chrome-extension://` tab URL to us, and there is no host permission for that
scheme — if Chrome gated it on host permissions we would get nothing back. The
harness now loads a **second throwaway unpacked extension** as a stand-in and
asserts against that, because "Chrome tells you about your own tabs" would be a
different and useless fact.

`X-L2` flaked once on the first write, and the flake was in the harness, not the
product: `chrome.tabs.query` can catch a tab mid-commit with `url` as the empty
**string**, and `t.url ?? t.pendingUrl` yields `""` because an empty string is
not nullish. `recorderForTab` is immune — `recorderFor("")` answers null and the
`??` falls through — which is the same bug the product was already written
against.

### Known fragility, stated rather than engineered around

This is a name-based match against another product's internals, and both halves
can rot:

- **A renamed capture page stops detection.** Paths are matched as prefixes, so
  `/html/pinnedTab` absorbs a suffix change but not a rename. Failure is silent
  and is the OLD behaviour — the bar stays up, exactly as it does today.
- **A move to an offscreen document ends it outright.** An offscreen document is
  not a tab, and no `chrome.*` API can see one belonging to another extension.
  Nothing in this design survives that; nothing else would either.
- **Only Loom is registered.** Its id and path were read off the shipped
  extension on this machine. Adding another recorder is two lines in
  `RECORDERS`, and an id that is wrong or stale never matches and costs nothing
  — but a path that is too **wide** parks a user's bookmarks every time that
  extension opens any page at all (`X-h`).

The self-updating version of this is `chrome.management.getAll()`, filtered to
extensions declaring `desktopCapture` or `tabCapture` — no registry, covers
recorders we have never heard of. It costs the `management` permission ("Manage
your apps, extensions, and themes"), which is worth asking for as an
**optional** permission from the popup rather than at install. That is an M4
decision, not a bug fix.

Also still open, and the honest limit of the whole product: a recorder that is
not a Chrome extension at all — the Loom **desktop app**, Zoom desktop, OBS,
QuickTime — is invisible to every API here. The answer for those is a manual
hide the user can hit: `chrome.commands` shortcut plus a popup toggle. Cheap,
and it covers everything at once. Not built.

## How to re-verify a fix still matters (mutation testing)

A mutation that stays green is not a passing test, it is an untested decision.
M2's twelve are codified and re-runnable:

```bash
node tools/mutate-m2.mjs         # exit 0 == every M2 decision is load-bearing
node tools/mutate-recovery.mjs   # same for the R layer
```

Both drive the shared runner in `tools/mutate-run.mjs`. A mutation that produces
a *syntax* error also reads as CAUGHT, so a "suite crashed" line is a weaker
signal than a named assertion — check what it actually broke before believing
it. `RC-f` was a bogus mutation caught exactly that way.

Editing M2 behaviour on purpose makes its anchor strings stop matching, and the
harness fails with "anchor not found". Rewrite the mutation to describe the new
decision rather than deleting it.

Ad hoc, for anything not yet codified:

```bash
S=/tmp/mut; rm -rf $S; mkdir -p $S
cp -R extension tools $S/
perl -0pi -e 's/<the fix>/<the bug>/' $S/extension/src/engine.js
node $S/tools/test-engine.mjs | grep -E "assertions failed|✗"   # must be non-zero
```

## Round 3 fixes applied

- `ok` no longer gates on `missing` (a deleted bookmark is not a failed
  restore) or on `decoysStuck`. Only `totalLoss` — recovered nothing at all —
  counts as failure. This stopped one deleted bookmark from exposing the bar
  for two subsequent meetings via the reconcile-before-hide gate.
- Hide's reconcile gate now allows `gaveUp` through: the journal is already
  cleared, so refusing would only keep the bar exposed.
- Self-mutation attribution by id (`noteSelfMutation` / `claimSelfMutation`).
  Chrome reports our own moves and creates back to us; serialised `markDirty`
  read them after the chain drained, when the state was already HIDDEN, so
  every clean hide marked itself dirty and restore silently took the append
  path. Claims happen inside the chain, so the note always lands first.
- `markDirty` also filters by touched parent (only the bar and the vault can
  stale an index) and short-circuits on `dirtySuppressed`, so a sync merge no
  longer queues hundreds of storage reads ahead of a hide.
- `onChanged` unwired: a rename moves nothing.
- Decoy journal stores the loop **index** (`decoyNext`), not a success count.
  They diverge the moment one create throws, pointing the crash sweep at the
  wrong decoy spec.
- Dropped `unrecognisedRoots` (false-positived on every enterprise and mobile
  profile) and dead `isDecoyShaped`.
- `lastFailure` is now reachable: message route, popup banner, toolbar badge.
- Cosmetic cleanup has its own lifecycle: `secureshare.strayDecoys`, a flat id
  list outliving any journal, drained by the watchdog and before every hide.
  A stuck decoy can now neither fail a restore nor survive one.
- Mock: bookmark events dispatched via `queueMicrotask` (ahead of the caller's
  own await continuation — the harshest ordering Chrome can produce); alarms
  keyed and persisted; `chrome.action` added.
- `sw.js` is now executed by tests (SW-1..SW-5) via a specifier rewrite that
  shares one engine instance with the assertions.

## Files

```
extension/manifest.json      MV3, permissions: bookmarks, storage, alarms, tabs
extension/src/roots.js       root detection, split local/account storage
extension/src/journal.js     write-ahead journal in storage.local
extension/src/engine.js      hide/restore/recover/adopt  <- the heart
extension/src/receipt.js     the in-tree record that outlives an uninstall  (R)
extension/src/hook.js        MAIN world: the getDisplayMedia patch      (M2)
extension/src/bridge.js      ISOLATED world: page -> worker relay       (M2)
extension/src/sessions.js    live-share counting, drives hide/restore   (M2)
extension/src/recorders.js   recorders we cannot hook: Loom & friends    (X)
extension/src/sw.js          service worker, watchdog alarm, badge + state icon
extension/popup.html/.css/.js  product popup; debug controls behind <details>,
                             and that gated to unpacked copies only          (M4)
extension/recovery.html/.js  recovery UI that works with a dead worker      (R)
extension/tokens.css         brand tokens — BYTE COPY of brand/tokens.css   (BR)
extension/fonts/             Instrument Sans + Geist Mono, self-hosted      (BR)
extension/icons/             10 PNGs, built by tools/make-icons.mjs         (BR)
brand/                       the guideline's shipping parts: tokens, logo   (BR)
tools/make-icons.mjs         rasterises the mark; re-run after a mark change (BR)
extension.zip                the upload package. Build from INSIDE extension/,
                             never with Finder — manifest.json must sit at the
                             archive root or the upload is rejected        (M4)
site/restore.html            the hosted twin; standalone, no extension      (R)
site/privacy.html            live at skrim.app/privacy — the listing's link (M4)
site/index.html              the landing page + waitlist form             (SITE)
site/404.html                what not_found_handling resolves to          (SITE)
worker/index.mjs             skrim.app: www->apex, /api/waitlist, headers (SITE)
                             network code lives HERE and never in extension/
wrangler.jsonc               the whole site config; source of truth over the
                             dashboard, which silently loses bindings     (SITE)
schema.sql                   the waitlist table; email is the primary key (SITE)
LICENSE                      source-available: audit and build, do not republish
README.md                    the public front door — leads with the greps that
                             make the privacy claims checkable
tools/mock-chrome.mjs        in-memory chrome.* + fault injection
tools/test-engine.mjs        the suite
tools/mutate-run.mjs         the shared mutation runner
tools/mutate-m2.mjs          the M2 decisions, each with its mutation      (M2)
tools/mutate-recovery.mjs    the R decisions, likewise                      (R)
tools/mutate-recorders.mjs   the X decisions, likewise                      (X)
tools/live-test.mjs          drives a real Chrome over CDP                 (M3)
tools/live-page.html         the page it drives; window.__ss is its API    (M3)
tools/popup-preview.mjs      every popup state, stubbed, no profile needed
                             (?state=peer is the bar-emptied-by-another-device
                             card; ?state=alerts is our own vault, for contrast)
tools/make-store-assets.mjs  the Web Store images, real popup in an iframe
                             (--serve to look at the compositions in a browser)
brand/store/README.md        which file goes in which dashboard field
M0-FINDINGS.md               sync spike results
docs/figma-popup.md          the popup design in Figma — and what is missing
../skrim-gtm/                SEPARATE PRIVATE REPO — pricing, funnel, launch
                             sequencing. Deliberately not in this one, which is
                             public and is cloned into a build container
```

Test-suite layers: `H-*` hook, `B-*` bridge, `E-*` hook→bookmarks end to end,
`S-*` session arbitration, `SW-*` service worker, `RC-*` surviving the
extension's own removal, `P-*` the three popup decisions that are not cosmetic
(`P-3` is the developer gate, and every other popup fixture renders as a STORE
install so they assert on what a real user gets),
`X-*` recorders in another extension, `SW-6` the toolbar icon's state machine,
plus the fault-injection sweeps. `P-*` loads the real `popup.js` against a
minimal auto-vivifying DOM stub and the worker's real reply shapes. `loadSw()` rewrites the import specifiers in both `sw.js` and
`sessions.js` so all three bind to ONE engine instance — without that, share
messages would drive a second engine module and every M2 assertion about the
bar would be measuring nothing.

## Known limits (accepted, not bugs)

- Uninstalling while hidden is recoverable as of the R milestone, but not
  *automatically*: the receipt has to be acted on. Reinstall and click once, or
  follow the receipt's own title by hand. The residual gap is a user who
  uninstalls, never reinstalls, and never opens their bookmark manager — which
  is what `setUninstallURL` closes, once `site/restore.html` is live at
  `skrim.app` for it to point at.
- Account-bookmark (split storage) paths are coded defensively but untested;
  this machine cannot produce a second signed-in profile on one account.
- Hiding on one device empties the bar on every other signed-in device for as
  long as the hide lasts. A tab share now releases within seconds; a **window or
  whole-screen share still costs the whole meeting**, on every device. Inherent
  to mutating synced data — see "SY" above and `M0-FINDINGS.md` §6.
- A shared *window* cannot be identified as a Chrome window or not, so window
  shares are treated as if the bar were in frame. Deliberate: over-releasing
  puts bookmarks on a live call, under-releasing only costs the old behaviour.
- The peer notice needs the extension to be installed on the peer. Chrome syncs
  extensions by default, but it is a separate toggle from bookmark sync, so
  someone syncing bookmarks with extension sync off gets an empty bar and no
  explanation. Nothing can be done about that from here.
- A peer notice cannot distinguish "that machine is sharing right now" from
  "that machine died mid-share". Age is not evidence (see the orphan-sweep
  comment), so both affordances stay on one screen, ordered by likelihood.
- The share messages are not authenticated, and cannot usefully be. A hostile
  page can forge one — but it can equally just call the real `getDisplayMedia`,
  which trips the genuine hook before the picker even appears. Authentication
  would buy nothing the hide/restore cycle does not already make reversible.
- The content scripts match `<all_urls>`: a screen share can start anywhere, and
  the hook has to be installed before the call, not after. Cost is one `message`
  listener per page until something actually shares. M4 has to justify this in
  the listing, or ship a host list plus an optional-permission toggle.
- No `match_about_blank` / `match_origin_as_fallback`: a share started from an
  `about:blank`, `blob:` or sandboxed iframe is not seen. Both keys were left
  off deliberately — the latter needs Chrome 119 and the manifest declares 116.
- Chrome's picker preview can still show the bookmarks bar on a page that calls
  `getDisplayMedia` immediately. Confirmed by hand, before AND after the hook
  was made to hold the picker shut, so it is not a timing race and the extension
  cannot reach it. Meet and Zoom — the cases that matter — show a clean preview
  in both window and entire-screen mode. Accepted 2026-07-31; the unexplained
  part is why the two differ.

- Recorders that live in another extension are covered by name, one at a time,
  and only Loom is registered. A rename of its capture page, or a move to an
  offscreen document, silently reverts to the old do-nothing behaviour. See "X"
  above, including the `chrome.management` version that would need no registry.
- A recorder that is not a Chrome extension — the Loom **desktop app**, Zoom
  desktop, OBS, QuickTime — is invisible to every API available here. The only
  answer is a manual hide (`chrome.commands` shortcut + popup toggle), which is
  not built.

- A restore is never re-hidden. If the bar comes back mid-share (popup Restore,
  or a peer device syncing one over), it stays back until the NEXT share starts.
  The watchdog deliberately does not re-assert, so the popup's Restore button
  cannot be fought by an alarm the user cannot see.
