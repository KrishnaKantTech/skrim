# Popup design in Figma

File `lRKOINn4lkQ4ZDusMDIyTO`, page "Extension"
(<https://www.figma.com/design/lRKOINn4lkQ4ZDusMDIyTO/Bookmarks-Hiding-Screenshot?node-id=0-1>).

Mirrors `extension/popup.{html,css,js}`. The code is the source of truth; this
file exists so the popup can be shown, critiqued, and pulled into store assets
without loading the extension.

## What is there

Variable collection **SecureShare** (`VariableCollectionId:4:2`) — 44 variables:
18 `Light/*` + 18 `Dark/*` colour tokens taken verbatim from `popup.css`, plus 8
numbers (`radius/lg|md|sm`, `space/body-x|body-top|body-bottom|body-gap|facts-row`).
`on-accent` and `on-danger` exist only in Figma; they carry the dark-mode rule
that the danger button needs near-black ink.

Six 336px frames, auto-layout, everything bound to a variable:

| Frame | Node |
|---|---|
| Popup / Light / Armed | `6:2` |
| Popup / Light / Exposed | `6:38` |
| Popup / Light / Hidden — sharing | `6:82` |
| Popup / Light / Hidden — manual | `7:15` |
| Popup / Light / Alerts | `7:78` |
| Popup / Light / Developer | `7:114` |

Icons are the real inline SVGs from `popup.html`, imported with
`createNodeFromSvg` and rebound to tokens. Type is Inter, standing in for the
`-apple-system` stack; Roboto Mono in the developer response block.

## What is not there, and why

**The dark row.** Six more frames. The build ran out of Figma MCP tool calls on
the Starter plan before it got to them.

**Light and Dark are not variable modes.** `addMode` fails with "Limited to 1
modes only" on Starter, so the two themes are parallel `Light/` and `Dark/`
token groups instead. On a paid plan they collapse into two modes of one token
set, and the dark row stops being a second set of frames at all — it becomes a
mode switch. That is the right fix; the script below is the workaround.

**Exposed, Hidden — manual and Developer were never rendered and checked.** They
came off the same builder as the three that were, but nobody has looked at them.

Frames also run 3–10% shorter than the browser (Armed 404 vs 417, Hidden —
manual 542 vs 605): Figma's text-box height for wrapped text differs slightly
from the browser's line box even with line-height pinned to 145%.

## Finishing the dark row

The Light→Dark variable mapping is `id + 1` (`4:3`→`4:4` … `4:37`→`4:38`), so
cloning and rebinding is mechanical. Load Inter Regular/Medium/Semi Bold and
Roboto Mono Regular first — `clone()` touches text nodes.

```js
const roots = ["6:2", "6:38", "6:82", "7:15", "7:78", "7:114"];
const created = [];
for (const id of roots) {
  const src = await figma.getNodeByIdAsync(id);
  const dup = src.clone();
  figma.currentPage.appendChild(dup);
  dup.name = src.name.replace("/ Light /", "/ Dark /");
  dup.x = src.x;
  dup.y = src.y + src.height + 120;
  for (const n of [dup, ...dup.findAll(() => true)]) {
    for (const key of ["fills", "strokes"]) {
      if (!(key in n) || !Array.isArray(n[key]) || !n[key].length) continue;
      const next = [];
      let changed = false;
      for (const p of n[key]) {
        const bid = p.boundVariables?.color?.id; // "VariableID:4:N"
        const num = bid && Number(bid.split(":")[2]);
        if (!num || num > 38) { next.push(p); continue; } // 39+ are the numbers
        const dark = await figma.variables.getVariableByIdAsync(`VariableID:4:${num + 1}`);
        next.push(figma.variables.setBoundVariableForPaint(p, "color", dark));
        changed = true;
      }
      if (changed) n[key] = next;
    }
  }
  created.push(dup.id);
}
return { createdNodeIds: created };
```

## Open question

Every frame says **SecureShare**, matching the shipped `popup.html`. The brand
name is Skrim. Renaming the popup header is one string; renaming the product is
not — see `engine.js` `VAULT_TITLE`, which is how a vault folder is recognised.
Change that and every vault hidden by an older build stops being recognised as
ours and lands in the adoption notice instead.
