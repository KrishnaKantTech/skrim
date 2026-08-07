# Chrome Web Store images

Generated. Do not edit the PNGs — change `tools/make-store-assets.mjs` and
re-run:

```
node tools/make-store-assets.mjs      # writes this directory
node tools/check-listing.mjs          # reads the PNG headers back
```

Upload the **nominal** files. The `@2x` copies are for the landing page, which
will want them; the dashboard rejects anything that is not the exact size.

| file | size | dashboard field |
| --- | --- | --- |
| `screenshot-1-armed.png` | 1280×800 | Screenshot 1 |
| `screenshot-2-hidden.png` | 1280×800 | Screenshot 2 |
| `screenshot-3-restore.png` | 1280×800 | Screenshot 3 |
| `screenshot-4-privacy.png` | 1280×800 | Screenshot 4 |
| `screenshot-5-coverage.png` | 1280×800 | Screenshot 5 |
| `promo-tile-440x280.png` | 440×280 | Small promo tile |
| `marquee-tile-1400x560.png` | 1400×560 | Marquee promo tile |

The marquee is only shown if the extension is featured, and it is the one field
that can be filled in later without touching anything else. It is here now
because the carousel is the one surface where the tile is seen *before* the
name, and because a Google editor looking for something to feature will not
wait while one is made.

**The promo video field is not a file.** It takes a YouTube URL. The master is
built by `tools/make-promo-video.mjs` into `brand/video/` — see the README
there for what to upload and what to put in the YouTube fields.

## The popup in these images is the real popup

`tools/popup-preview.mjs` serves `extension/popup.{html,css,js}` against stubbed
fixtures. `make-store-assets.mjs` mounts that same handler behind its own routes
and drops the result into an iframe, so a screenshot cannot drift from the
shipped UI the way a redrawn mock would. Change the popup and re-run, and the
screenshots follow.

The browser frame around it **is** a drawing — deliberately generic, no Chrome
logo and no Chrome UI copied pixel for pixel. It exists to make the bookmarks
bar read as a bookmarks bar, which is the only part of it the product touches.

## The order is an argument

1. **Before the share** — a bar carrying twelve things you would not want on a
   call, and the popup sitting armed
2. **During the share** — the same bar holding six forgettable stand-ins
3. **After the share** — the three bars stacked, before / sharing / restored,
   so "goes back exactly" is shown rather than claimed
4. **Privacy** — the four statements the "not collected" disclosures rest on
5. **Coverage** — what it catches, and the two things it cannot, said out loud

Screenshots 1–3 are read as one sequence, so their numbers chain: twelve on the
bar, twelve tucked away, the same twelve back. Two of those numbers live in the
popup fixtures and one in the generator, and the generator throws if they ever
disagree.

## What `check-listing.mjs` holds

- every file above exists, is a PNG, and is **exactly** the size in the table —
  read out of the PNG header, the same bytes the dashboard reads
- none of them is blank, which is what a headless render writes when the page
  failed to load
- the stand-in bookmarks drawn in screenshot 2 still match `DECOYS` in
  `extension/src/engine.js`. Add a decoy there without re-running the generator
  and that image shows a bar the extension never produces — a misleading
  screenshot, not a cosmetic drift

## The marquee is the small tile at poster scale, on purpose

Same object, same geometry: the scrim parked at the mark's own 41%, the lit
leading edge, the titles caught half-way through being swallowed. It is not a
second idea, because the two are seen in the same listing and a listing whose
tiles argue with each other looks like two products.

Three things are different, and all three come from where it is shown:

- **Nothing load-bearing sits outside x 140..1260.** The carousel crops the tile
  from the sides on a narrow viewport. The bookmark field is what runs off the
  edges, which is fine — it is supposed to feel like it carries on past the
  frame.
- **The field fades into the ground at the bottom** rather than being cut by it.
  A row of chips sliced through its own letterforms reads as a rendering fault.
- **The mono line carries the proof.** At 440px there is no room for it; at
  1400px the band is otherwise 600px of empty green.

## Colour

Same two rules as `brand/social/`: green means covered, and type on a green fill
is ink. The scrim band is green, and so is the "Covered" column on screenshot 5,
where the word is literal. The bookmarks about to be swallowed are neutral, and
so are the stand-ins that replace them — neither is protected, and neither may
wear the colour that says so.

## Looking at them

```
node tools/make-store-assets.mjs --serve
```

Serves the compositions at `localhost:8749/shot/<name>` in a real browser, which
is the only way to catch a font that fell back or a row that wrapped one word
too far.
