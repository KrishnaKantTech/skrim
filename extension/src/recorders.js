// Recorders we cannot hook, and how to recognise one that is running.
//
// M2's hook works by patching MediaDevices.prototype in the page's MAIN world.
// That reaches every conferencing app -- Meet, Slack, Teams, Zoom Web -- because
// they are web pages calling getDisplayMedia in a frame we are allowed to inject
// into. It cannot reach a recorder that lives in ANOTHER EXTENSION, for two
// independent reasons, either of which alone is fatal:
//
//   1. Chrome forbids content scripts on chrome-extension:// pages belonging to
//      a different extension. There is no manifest key, no permission and no
//      flag that changes this. Our hook is simply never installed there.
//   2. Those recorders typically do not call getDisplayMedia at all. They call
//      chrome.desktopCapture.chooseDesktopMedia() -- an extension-only API that
//      opens the same native picker -- and hand the resulting id to
//      getUserMedia({video:{mandatory:{chromeMediaSource:"desktop", ...}}}).
//      Even if we could inject, we would be patching the wrong method.
//
// Loom is the case that brought this in, and it was read out of the shipped
// extension rather than guessed: version 5.5.202 declares "desktopCapture", and
// js/pinnedTab.js -- the script of html/pinnedTab.html -- is the only file that
// calls chooseDesktopMedia and the only one mentioning chromeMediaSource. The
// worker opens that page with
//     chrome.tabs.create({url:"./html/pinnedTab.html", active, index:0, pinned:true})
// before the countdown, i.e. before the picker. So the capture context is a real
// TAB, and a tab is the one thing about another extension that chrome.tabs will
// tell us about.
//
// That is the whole mechanism: a recorder's capture page appearing as a tab is
// the start signal, and the tab going away is the end signal. It needs the
// "tabs" permission to see the URL, and nothing else.
//
// KNOWN FRAGILITY, stated rather than engineered around: this is a name-based
// match against another product's internals. If Loom renames the page we stop
// seeing it (the path is matched as a PREFIX, which absorbs a suffix change but
// not a rename), and if Loom ever moves the capture into an offscreen document
// -- which is not a tab -- no chrome.* API can see it at all. Failure is silent
// and is the OLD behaviour: the bar stays up, exactly as it does today.

/**
 * One entry per recorder. `paths` are matched as prefixes of the URL path, with
 * query and fragment already stripped, so `/html/pinnedTab` covers
 * `pinnedTab.html`, `pinnedTab.html?x=1` and a suffixed rename.
 *
 * Add entries; do not narrow existing ones. An id that is wrong or stale never
 * matches and costs nothing. A path that is too WIDE is the expensive mistake:
 * it would hold the bookmarks bar down for every ordinary page that recorder
 * opens, so list only pages that exist to capture.
 */
export const RECORDERS = [
  {
    id: "liecbddmkiiihnedobmlmillhodjkdmb",
    name: "Loom",
    paths: ["/html/pinnedTab"],
  },
];

// Chrome extension ids are exactly 32 characters from a-p. Anchoring the match
// on that shape means a page URL can never be mistaken for one.
const EXT_URL = /^chrome-extension:\/\/([a-p]{32})(\/[^?#]*)/;

/**
 * The recorder whose capture page this URL is, or null.
 *
 * Deliberately total: it is fed tab URLs from every tab in the browser, most of
 * which are ordinary pages, and undefined is the normal answer for a tab whose
 * URL we are not allowed to read.
 */
export function recorderFor(url) {
  if (typeof url !== "string") return null;
  const m = EXT_URL.exec(url);
  if (!m) return null;
  const [, id, path] = m;
  for (const r of RECORDERS) {
    if (r.id !== id) continue;
    if (r.paths.some((p) => path.startsWith(p))) return r;
  }
  return null;
}

/**
 * A tab's URL is not always where you expect it. chrome.tabs.onCreated fires
 * before the navigation commits, so a tab opened AT a URL carries it in
 * `pendingUrl` and `url` is empty -- and that is precisely the case here, since
 * the recorder page is opened by tabs.create. Reading only one of the two would
 * miss the start of every recording or the whole scan, depending which.
 */
export function recorderForTab(tab) {
  return recorderFor(tab?.url) ?? recorderFor(tab?.pendingUrl);
}
