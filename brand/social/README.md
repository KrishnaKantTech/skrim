# Social covers

Generated. Do not edit the PNGs — change `tools/make-social.mjs` and re-run:

```
node tools/make-social.mjs
```

Every cut is drawn from the same geometry `brand/logo/*.svg` and the extension
icons come from, so the covers cannot drift away from the mark: a scrim parked
at 41% of the height, a hard leading edge, and content lines underneath it.
Blown up to 1200×630 the "content lines" become a real bookmark bar, which is
the whole trick — **the cover is the mark at poster scale**, not a logo dropped
onto a gradient.

| file | size | where |
| --- | --- | --- |
| `skrim-og.png` | 1200×630 | `og:image`, `twitter:image`, LinkedIn, Slack and Discord unfurls |
| `skrim-x-header.png` | 1500×500 | X profile header |
| `skrim-square.png` | 1080×1080 | Instagram, LinkedIn feed, Mastodon |

Each also ships at `@2x`. Serve the nominal size to OG scrapers — some cap the
file size and a few still refuse anything over 5 MB — and the `@2x` anywhere a
retina timeline will show it.

## What the composition is doing

The positioning splits in two — *market on the fear, position on the polish* —
and the layout splits with it. The polish line sits in the green, because a
headline is the one thing a reader takes away from a 400px-wide unfurl. The
fear is carried entirely without words by the bookmarks the scrim is caught
half-way through swallowing: `Salary negotiation · scripts`,
`Am I underpaid? (calc)`, `resume-FINAL-v7.pdf`.

That clipped first row is the only part of the layout that must not be nudged
for looks. The chip is cut so its **bottom 64%** shows, which is the half of a
letterform you can still read; cut it at the middle and the row turns to mush
and reads as a layout accident rather than as something being covered.

## The colour rules it is obeying

- **Green means covered, so the scrim is the only green object on the card.**
  The bookmarks are neutral — `ink-900` chips, `ink-300` labels — because
  content that is still exposed must never wear the colour that means safe.
  This is also why `--glowfall` under the leading edge is held at 7% alpha: any
  stronger and it casts green over bookmarks that have not been covered yet.
- **Type on a green fill is ink.** The headline, the wordmark and `skrim.app`
  are all `ink-950` on `green-400` — 10.80:1. White would measure 1.78:1.
- The leading edge is `green-200`, two steps up from the fill. It sits just
  *below* the scrim rather than inside it: on green it would be invisible, on
  the dark field it reads as a lit edge with the bookmarks it is mid-way
  through swallowing showing underneath. It is light falling downward, never a
  drop shadow — a shadow would make the protective thing feel heavy.

Measured contrast on everything that carries text:

| | ratio |
| --- | --- |
| headline / wordmark, `ink-950` on `green-400` | 10.80:1 |
| `skrim.app`, `ink-950` at 68% on `green-400` | 5.19:1 |
| sub-copy, `ink-400` on `ink-950` | 7.09:1 |
| chip labels, `ink-300` on `ink-900` | 9.93:1 |

## Format notes

**X header.** X paints the profile avatar over the bottom-left corner, so that
corner is left deliberately empty and the sub-copy starts at x=470, well clear
of it. Its scrim is at 47%, not 41%: 41% of 500px is not enough room for a
lockup and a headline, and the alternative — shrinking the headline — costs
more than the ratio is worth on a cut nobody sees next to the others.

**Square.** The headline breaks to three lines here, which is where it reads
best, and the field holds seven chip rows.

The three are composed by hand rather than scaled from one master. A 1200×630
layout squeezed into 1500×500 puts the headline exactly where X paints the
avatar. What they share is the geometry and the tokens, not the arrangement.

## Changing the copy

Headline, sub-copy, the two footer tags and the bookmark pool are all at the top
of `tools/make-social.mjs`. The headline says *automatic* on purpose — that is
the only reason to install this over doing nothing — which is also why the
footer carries neutral fact tags and not the keycaps an earlier cut had. A
keystroke on the artwork would advertise the exact thing the product replaces.

The pool is one flat list, sliced into rows of a
different length per format — a row has to run off the right edge of whichever
card it lands on, because a bookmark bar that stops short of the edge looks
like a *diagram* of a bookmark bar. The build throws if a format asks for more
chips than the pool holds rather than quietly rendering short rows.

There is no SVG cut. The covers are type-led and the fonts are not universally
installed, so an SVG would either need the woff2 embedded (larger than the PNG)
or the type converted to paths (no longer editable, and no longer the point).
Every platform these are aimed at wants a raster anyway.
