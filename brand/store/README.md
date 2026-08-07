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

Nothing here needs a marquee tile (1400×560) — that field is only used if the
extension is featured, and it can be added later without touching the listing.

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
