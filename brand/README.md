# Skrim brand assets

Brand guidelines v1.0 — the full document, with live contrast readouts and
specimens, is published as an artifact. This directory holds the parts that ship.

```
tokens.css          the design tokens, both themes
tokens.json         same tokens, W3C Design Tokens format (generated from tokens.css)
logo/               the mark, generated from one shared geometry definition
social/             OG, X header and square covers (see social/README.md)
```

`extension/tokens.css` is a **byte-identical copy** of `tokens.css`. The
extension has to ship its own — `brand/` is not in the package — and there is no
build step to generate one, so the sync check is just:

```
diff brand/tokens.css extension/tokens.css
```

The extension's PNG icons are generated from the same geometry the `logo/` files
use, by `tools/make-icons.mjs`. Re-run it after any change to the mark; Chrome
will not accept an SVG for `manifest.icons` or `action.default_icon`.

`social/` is generated from that same geometry by `tools/make-social.mjs` — the
covers are the mark at poster scale, a scrim parked at the same 41% caught
half-way through swallowing a bookmark bar. Re-run it after any change to the
mark, the tokens or the positioning copy.

## The one rule

**Green means covered.** It is the brand colour *and* the protected state,
deliberately fused, which is why nothing else in the system is allowed to be
green. That has two consequences worth remembering:

- A green fill must always move the user *towards* cover — "Hide bookmarks",
  "Hide now", "Try again". The action that lifts the scrim is a quiet outline
  button, never the brightest thing on screen.
- Type on a green fill is `--on-accent` (ink), never white. White on `green-400`
  measures 1.78:1 and fails outright; ink measures 10.80:1.

Roughly 1 in 12 men cannot separate our green from our flare, and covered vs
exposed is the distinction this product exists to make — so colour never carries
state alone. The mark changes shape, the pill carries a word, the headline says
which state you are in.

## Migrating `extension/popup.css` — done

Kept as the record of what moved where, because the old names still turn up in
screenshots, older branches and the guideline's own history.

| was | became | note |
| --- | --- | --- |
| `--accent` `#4f46e5` | `--accent` `var(--green-400)` | fill |
| `--on-accent` `#ffffff` | `--on-accent` `var(--ink-950)` | **white fails on the fill** |
| `--accent-hover` | `--accent-hover` | light mode goes deeper, dark mode lighter |
| `--accent-tint` | `--accent-tint` | |
| `--ok` / `--ok-dot` / `--ok-tint` | `--accent-text` / `--accent-dot` / `--accent-tint` | merged into the brand |
| `--warn` / `--warn-tint` | `--attention` / `--attention-tint` | unchanged in meaning |
| `--danger` / `--danger-tint` | `--exposed` / `--exposed-tint` | renamed: it flags visibility, not an error |
| `--faint` | `--muted` | light mode has no step below `ink-500` that clears 4.5:1 |
| `--r-sm` / `--r-md` / `--r-lg` | `--radius-sm` / `--radius-md` / `--radius-lg` | same values |
| `--ring` | `--ring` | now two-tone, so it survives on any ground |

Dark mode needs one extra check: `ink-500` reaches only 3.73:1 on `ink-900`, so
muted text there must use `ink-400`. The two modes do not use the same step.

Three consequences went further than a rename, and are the parts worth not
undoing by accident:

- **The exposed state lost its red button.** `Hide now` is the same green fill
  as `Hide bookmarks`, because green marks the way *out* of a state and flare
  marks the state you are in. The hero, the pill and the headline already say
  three times over that something is wrong.
- **Restore is an outline button.** It lifts the scrim, so it is never the
  brightest thing on screen — still full width, still the only button in the
  body of the popup.
- **A peer's live hide is green, not amber.** It is a covered state; it just
  happens to be covered from another computer.

## Logo

Every file in `logo/` is generated from one geometry definition — a 32px grid,
6px corner radius, three content lines, and a scrim covering the top 41%.

| file | use | floor |
| --- | --- | --- |
| `mark-primary.svg` | app + web store icon | 32px |
| `mark-inverted.svg` | dark marketing surfaces | 32px |
| `mark-line.svg` | monochrome, inherits `currentColor` | 24px |
| `mark-min.svg` | content lines dropped — they mush below 24px | 16px |
| `state-armed.svg` | nothing sharing, auto-hide watching | toolbar |
| `state-hidden.svg` | scrim fully down | toolbar |
| `state-exposed.svg` | share live, bar still up — the only flare-coloured state | toolbar |

The three `state-*` files are why the toolbar icon needs no badge: the scrim's
position *is* the state, so it changes shape rather than gaining a dot. Colour
them `--accent-dot` (armed, hidden) and `--exposed-dot` (exposed).

## Typography

Instrument Sans (display + text) and Geist Mono (anything countable), both SIL
Open Font License. Self-host; do not link a CDN — the extension CSP blocks it.

Instrument Sans was chosen for 13px in a 336px popup before it was chosen for a
headline: it is slightly narrow with a tall x-height, which buys room where there
is none. Geist Mono carries every number a user might compare or copy — counts,
timers, IDs, developer output — always with `tabular-nums`.
