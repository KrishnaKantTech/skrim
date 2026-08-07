# The promo video

Generated. Do not edit the mp4 — change `tools/make-promo-video.mjs` and re-run:

```
node tools/make-promo-video.mjs                 # writes this directory
node tools/make-promo-video.mjs --serve         # scrub it in a real browser
node tools/make-promo-video.mjs --at 6800,9200  # one beat, as a PNG
```

| file | what it is |
| --- | --- |
| `skrim-promo.mp4` | 1920×1080, 30fps, 36s, H.264, **silent**. The master. |
| `skrim-promo-poster-1280x720.png` | the YouTube custom thumbnail |

## The store field is a YouTube URL, not an upload

The Developer Dashboard's **Promotional video** field takes a link, and it only
accepts YouTube. So the errand is:

1. Upload `skrim-promo.mp4` to the YouTube account that will own it. **Not
   unlisted** — the dashboard rejects a video it cannot resolve publicly, and an
   unlisted video that later goes private silently empties the field.
2. Set the custom thumbnail to `skrim-promo-poster-1280x720.png`.
3. Paste the watch URL (`https://www.youtube.com/watch?v=…`) into the field.
   The short `youtu.be` form has been refused before; use the long one.
4. **Turn off** end screens, cards and any "Subscribe" overlay. They render on
   top of the last five seconds, which is the whole end card.

Suggested YouTube fields, kept in the listing's voice:

```
Title
Skrim — hide your bookmarks bar automatically while you share your screen

Description
Skrim hides your bookmarks bar the moment you start sharing your screen, and
puts it back the moment you stop. Every bookmark moves into a folder, a few
forgettable stand-ins take their place, and when the share ends everything
returns to the exact position it came from.

No account. No servers. No network requests at all.

Free for Chrome: skrim.app

Category: Science & Technology
Language: English
```

## It is silent, and that is a decision

There is no voiceover and no music bed. Store listings autoplay muted, most
people watch a 36-second product film with the sound off, and a licensed track
is a licence to keep track of forever. So every word is on screen and the film
is legible with the volume at zero.

If a track is ever added, it goes on afterwards without re-rendering:

```
ffmpeg -i skrim-promo.mp4 -i bed.m4a -c:v copy -c:a aac -b:a 192k \
       -shortest skrim-promo-scored.mp4
```

## What is in it, and why it is drawn rather than recorded

Six scenes, in the order the store listing argues:

| | | |
| --- | --- | --- |
| 0:00 | Before the share | twelve bookmarks arrive on the bar, one at a time |
| 0:05 | The share starts | the pill lights, the scrim falls, six stand-ins are underneath it |
| 0:13 | The share ends | the scrim falls again and the same twelve come back |
| 0:19 | What leaves your computer | four cards, including the sync disclosure |
| 0:25 | What it covers | both columns, including the two it does not |
| 0:31 | End card | the band grows into the frame |

A screen recording of the real extension would be the honest thing if it were
legible, and it is not: the entire event is a 24px strip emptying in about
200ms. So the film is drawn — but from the **same components the store
screenshots are drawn from**, imported out of `tools/make-store-assets.mjs`
rather than copied, with **the real popup in an iframe** exactly as the
screenshots have it. There is no second drawing of a bookmarks bar in this repo.
Change the popup and the film follows.

Two things it deliberately does not do:

- **It depicts a whole-screen share, not a tab share.** `src/hook.js` releases
  the hide the moment Chrome reports `displaySurface === "browser"`, because a
  captured tab cannot contain the bookmarks bar. A film showing the bar held
  down for the length of a tab share would be advertising behaviour the
  extension deliberately does not have. Hence "Sharing your screen" in the film
  where screenshot 2 says "Sharing this tab".
- **Nothing on screen is invented extension UI.** No toast, no progress bar, no
  badge — the extension raises none of those. What the popup shows is the popup.

The numbers chain the way the screenshots' do: twelve arrive on the bar, the
caption says twelve moved and six stood in, and the popup beside it reads
`12 bookmarks` / `6 items` — because that caption is built from `EXPOSED.length`
and `DECOYS.length`, and the popup is rendering `FIXTURES.justHidden`. The
minimum Chrome version in scene 4 is read out of `extension/manifest.json` at
build time for the same reason.

`FIXTURES.justHidden` exists for this film: `shielded` says "Hidden for 4 mins",
and four minutes two seconds after the viewer watched the bar clear is a
continuity error. It is also the only preview state that reaches `elapsed()`'s
under-a-minute branch.

## How it renders

Every animation is a **paused Web Animation with an explicit delay**, so
`seek(t)` is the entire clock — no wall time, no `requestAnimationFrame`, no
`setTimeout`. One headless Chrome is held open over CDP and driven frame by
frame: seek, screenshot, seek, screenshot. Frame 480 is identical whether it is
rendered first or last, which is the only reason a 1080-frame render can be
trusted without watching all 36 seconds of it.

Rendered at `deviceScaleFactor: 2` — 3840×2160 — and supersampled down by
ffmpeg with lanczos. That is what keeps 17px type and a 3px lit edge intact
after H.264 has had them. CRF 16, `+faststart`, no B-frame surprises.

One thing that will bite the next person: the popup's CSS **transitions** have
to be `finish()`ed, not pinned to `currentTime = 0`. Pinned to zero they render
the empty shell the popup shows for one frame before its stubbed `sendMessage`
resolves — an outline button where the shipped one is a green fill. The film had
that bug for exactly one render.

## Looking at it before committing 1080 frames

```
node tools/make-promo-video.mjs --serve
```

Opens the film at `localhost:8751/film?scrub=1` with a scrubber. Space plays it
at wall speed. This is the only way to catch a caption that wrapped one word too
far, or a beat that reads slower than it timed.
