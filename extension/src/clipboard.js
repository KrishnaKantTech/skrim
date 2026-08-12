// Putting bookmarks on the clipboard.
//
// Shared by the popup and the backup page so the two Copy buttons cannot drift
// apart in what they actually write.
//
// Two flavours go on at once: `text/plain` (the outline) and `text/html` (the
// same tree as anchors). A target takes whichever it understands -- a code
// editor or a terminal gets the outline, a doc or a message box gets clickable
// links -- and neither has to be chosen up front.
//
// What this deliberately does not attempt: Chrome's bookmark manager. It pastes
// only from a pickled internal format it writes for itself, unreachable from
// any extension or page, so no clipboard payload will ever land there. Moving
// bookmarks into a browser is the download plus that browser's import; see the
// note in portable.js.

/**
 * Write `text` and, where the browser allows it, `html` alongside.
 *
 * Falls back a step at a time rather than all-or-nothing: an older browser
 * without `ClipboardItem`, or one that refuses the HTML flavour, still gets the
 * outline. Resolves to `true` only when something actually reached the
 * clipboard, because the caller's message to the user turns on that.
 */
export async function copyBookmarks(text, html) {
  if (!text) return false;

  if (html && typeof ClipboardItem === "function" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": new Blob([text], { type: "text/plain" }),
          "text/html": new Blob([html], { type: "text/html" }),
        }),
      ]);
      return true;
    } catch {
      /* the rich write is the nicety; the outline below is the promise */
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
