// Bookmark import / export, as pure string transforms.
//
// This file touches neither chrome nor the DOM on purpose: the whole of the
// tricky logic -- serialising a tree to the standard bookmark file every
// browser can read, and parsing one back -- is therefore exercisable in Node,
// byte for byte, the same way the engine is. The page (backup.js) is the thin
// glue that reads the tree from chrome.bookmarks, hands it here, and puts the
// result on the clipboard or into a download; nothing load-bearing lives there.
//
// The interchange format is the Netscape Bookmark File -- the `<DL><DT>` HTML
// that Chrome, Firefox, Safari and Edge all export and import. Choosing it over
// a private JSON means a Skrim export restores into any browser with no Skrim
// installed, which is the entire point of letting someone back their bar up
// before they trust an extension that rearranges it.
//
// A node here is the shape chrome.bookmarks hands back, narrowed to what a
// backup needs: `{ title, url?, dateAdded?, children? }`. A `url` of undefined
// marks a folder; everything else is a link.

// ---------------------------------------------------------------------------
// HTML entities. A bookmark title is arbitrary user text and a URL can carry an
// ampersand, so both have to survive a round trip through markup unharmed.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const UNESCAPES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
  "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function unescapeHtml(s) {
  return String(s ?? "").replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp);|&#x?[0-9a-fA-F]+;/g,
    (m) => {
      if (UNESCAPES[m]) return UNESCAPES[m];
      // Numeric entity -- decimal (&#123;) or hex (&#x1F;). Anything that does
      // not resolve to a real code point is left as written rather than lost.
      const hex = /^&#x/i.test(m);
      const code = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    },
  );
}

// ---------------------------------------------------------------------------
// Serialise.

const secondsAttr = (ms) =>
  typeof ms === "number" && ms > 0 ? ` ADD_DATE="${Math.floor(ms / 1000)}"` : "";

/**
 * A tree of nodes -> a Netscape bookmark file. `children` is the bar's direct
 * children; the H1/TITLE name only labels the document and is not re-imported
 * as a folder, matching what every browser writes.
 */
export function toNetscapeHtml(children, { title = "Bookmarks" } = {}) {
  const out = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. It will be read and overwritten. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    `<TITLE>${escapeHtml(title)}</TITLE>`,
    `<H1>${escapeHtml(title)}</H1>`,
    "<DL><p>",
  ];
  const walk = (nodes, depth) => {
    const pad = "    ".repeat(depth);
    for (const n of nodes ?? []) {
      if (n.url === undefined || n.url === null) {
        out.push(`${pad}<DT><H3${secondsAttr(n.dateAdded)}>${escapeHtml(n.title)}</H3>`);
        out.push(`${pad}<DL><p>`);
        walk(n.children, depth + 1);
        out.push(`${pad}</DL><p>`);
      } else {
        out.push(`${pad}<DT><A HREF="${escapeHtml(n.url)}"${secondsAttr(n.dateAdded)}>${escapeHtml(n.title)}</A>`);
      }
    }
  };
  walk(children, 1);
  out.push("</DL><p>");
  return out.join("\n") + "\n";
}

/**
 * The same tree as a plain-text outline, for the clipboard. Folders end in a
 * slash and links read `Title — url`; two spaces of indent per level. This is
 * for a human pasting into a note, not for re-import -- the download is the
 * re-importable artifact.
 *
 * Worth being explicit about what the clipboard cannot do, because it reads
 * like a bug otherwise: Chrome's own bookmark manager pastes only from a
 * pickled internal format it writes for itself, and neither an extension nor a
 * page can put that on the clipboard -- `navigator.clipboard` namespaces any
 * custom type as a *web* format the manager never looks at. So copying can
 * never feed the bookmark manager; moving bookmarks into a browser is the
 * download plus that browser's own import. The clipboard's job here is the
 * note, the message, the doc -- which is why it also travels as HTML below.
 */
export function toTextOutline(children) {
  const lines = [];
  const walk = (nodes, depth) => {
    const pad = "  ".repeat(depth);
    for (const n of nodes ?? []) {
      if (n.url === undefined || n.url === null) {
        lines.push(`${pad}${n.title || "(unnamed folder)"}/`);
        walk(n.children, depth + 1);
      } else {
        const t = n.title || n.url;
        lines.push(`${pad}${t} — ${n.url}`);
      }
    }
  };
  walk(children, 0);
  return lines.join("\n");
}

/**
 * The same tree as an HTML fragment, to ride the clipboard alongside the text
 * outline. Nested `<ul>`, one `<a>` per link, folders as a bold label -- plain
 * enough to survive the sanitiser every rich-text target runs paste through,
 * and to degrade to something readable in the ones that strip lists.
 *
 * Deliberately not the Netscape `<DL><DT>` shape: that format is for a file an
 * importer parses, and pasted into a document it renders as an unindented run
 * of links. Two different jobs, two different serialisers.
 */
export function toHtmlLinks(children) {
  const walk = (nodes, depth) => {
    const items = [];
    for (const n of nodes ?? []) {
      if (n.url === undefined || n.url === null) {
        const label = escapeHtml(n.title || "(unnamed folder)");
        items.push(`<li><strong>${label}</strong>${walk(n.children, depth + 1)}</li>`);
      } else {
        // A javascript: or data: URL in an href is inert on the clipboard but
        // not in whatever the user pastes into, so only web-shaped links keep
        // their anchor; anything else travels as its own text.
        const href = escapeHtml(n.url);
        const text = escapeHtml(n.title || n.url);
        items.push(
          isSafeHref(n.url) ? `<li><a href="${href}">${text}</a></li>` : `<li>${text}</li>`,
        );
      }
    }
    return items.length ? `<ul>${items.join("")}</ul>` : "";
  };
  return walk(children, 0);
}

/** Schemes safe to leave as a live anchor in someone else's document. */
function isSafeHref(url) {
  return /^(https?|ftp|mailto):/i.test(String(url ?? "").trim());
}

// ---------------------------------------------------------------------------
// Parse.
//
// Netscape bookmark files are notoriously loose HTML -- unclosed <DT>/<p>,
// inconsistent casing, optional attributes -- so this is a tolerant token
// scanner rather than a strict parser, and it never throws: a line it does not
// understand is skipped, so a malformed export degrades to "fewer bookmarks",
// never to a broken import. The four tokens that carry structure are a folder
// heading (<H3>), a link (<A>), and the two list delimiters (<DL>, </DL>).

const TOKEN =
  /<DT>\s*<H3[^>]*>([\s\S]*?)<\/H3>|<DT>\s*<A\s+([^>]*?)>([\s\S]*?)<\/A>|<DL[^>]*>|<\/DL>/gi;

const attr = (attrs, name) => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i").exec(attrs);
  return m ? m[1] : null;
};

/**
 * A Netscape bookmark file -> the bar's direct children, same node shape the
 * serialiser takes. `<DL>` and `</DL>` are kept in strict push/pop balance:
 * every open pushes a folder (the one a preceding `<H3>` just named, or the
 * current folder again for the top-level list that has no heading), and every
 * close pops -- so a stray or missing delimiter cannot corrupt the nesting of
 * everything after it.
 */
export function parseNetscape(html) {
  const root = { children: [] };
  const stack = [root];
  const current = () => stack[stack.length - 1];
  let pending = null; // a folder whose <DL> has not opened yet

  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(html))) {
    const tok = m[0];
    if (/^<DL/i.test(tok)) {
      stack.push(pending ?? current());
      pending = null;
    } else if (/^<\/DL/i.test(tok)) {
      if (stack.length > 1) stack.pop();
    } else if (m[1] !== undefined) {
      // <H3> folder heading. Recorded as a child now; its own list opens on the
      // next <DL>.
      const folder = { title: unescapeHtml(m[1].trim()), children: [] };
      current().children.push(folder);
      pending = folder;
    } else if (m[2] !== undefined) {
      // <A> link. A HREF is the one thing it must have to be a bookmark.
      const href = attr(m[2], "href");
      if (href == null) continue;
      const add = attr(m[2], "add_date");
      // The URL is HTML-escaped in the file too -- Chrome writes an ampersand
      // in a query string as `&amp;` -- so it comes back through the same
      // unescape the title does, or every multi-parameter link would break.
      const node = { title: unescapeHtml(m[3].trim()), url: unescapeHtml(href) };
      const ms = add ? Number(add) * 1000 : NaN;
      if (Number.isFinite(ms) && ms > 0) node.dateAdded = ms;
      current().children.push(node);
    }
  }
  return root.children;
}

/** Total links (not folders) in a tree -- what the UI reports as "N bookmarks". */
export function countLinks(children) {
  let n = 0;
  for (const c of children ?? []) {
    if (c.url === undefined || c.url === null) n += countLinks(c.children);
    else n++;
  }
  return n;
}
