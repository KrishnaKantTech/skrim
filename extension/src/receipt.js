// The in-tree recovery receipt.
//
// Every other record this extension keeps lives in chrome.storage.local, which
// Chrome DELETES when the extension is uninstalled. The bookmarks themselves
// survive -- they are the user's own data, sitting in the vault folder -- but
// the journal saying where each one belongs does not. That asymmetry is the
// entire reason "uninstalled while hidden" used to be unrecoverable: the items
// were never lost, only their addresses were.
//
// The receipt closes it by writing the recovery data into the one store that
// outlives the extension: the bookmark tree itself. It is an ordinary bookmark
// placed inside the vault, whose TITLE is a complete instruction a human can
// follow with no software at all, and whose URL carries the machine-readable
// payload in its fragment.
//
// Four properties are load-bearing:
//
//  * The URL never has to RESOLVE. The only reader is our own code, parsing
//    node.url as a string, so a receipt written before the product had a domain
//    stays fully restorable after it has one -- and a dead link costs the user
//    nothing, because the title already told them everything.
//  * Nothing here is a brand name. Recognition is by the `ssr1.` payload token,
//    so renaming the product cannot orphan a receipt already in someone's tree.
//  * A fragment is never sent to a server, so pointing the URL at a real host
//    later does not put bookmark data on the wire.
//  * Bookmark ids are PROFILE-LOCAL. A receipt naming its own vault's id is
//    therefore proof it was written on this machine -- which is what lets a
//    reinstall tell "my own pre-uninstall vault" apart from "a synced peer's
//    live hide", the one distinction the tree could not otherwise make.

// Version token. Deliberately not the product name: this string ends up in a
// user's bookmarks and has to keep meaning the same thing across a rename.
const TOKEN = "ssr1.";

/** Only ever grown, never edited: old receipts must stay recognisable. Index 0
 *  is the one we write, so promoting a name here is the whole rename -- every
 *  other entry keeps matching receipts already sitting in people's trees. */
const TITLE_MARKS = ["Skrim recovery", "SecureShare recovery"];

export const RECEIPT_TITLE_MARK = TITLE_MARKS[0];

// ---------------------------------------------------------------------------
// base64url, UTF-8 safe. btoa is byte-oriented, so a title with an emoji in it
// throws unless the string is encoded first. Chunked because String.fromCharCode
// is applied to the byte array and a spread of a few thousand entries is close
// enough to the argument limit to be worth not finding out about in the field.

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x2000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(text) {
  const b64 = text.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------

/**
 * Where a clicked receipt should land. Set RECOVERY_BASE to a hosted page once
 * one exists -- `site/restore.html` in this repo is that page, and it decodes
 * the same payload with no extension installed. Until then the receipt points
 * at the extension's own recovery page, which works for every case except the
 * uninstall, and the uninstall case is carried by the title.
 */
export const RECOVERY_BASE = null;

export function recoveryBase() {
  if (RECOVERY_BASE) return RECOVERY_BASE;
  try {
    return chrome.runtime.getURL("recovery.html");
  } catch {
    return "recovery.html";
  }
}

export function buildUrl(payload, base = recoveryBase()) {
  return `${base}#${TOKEN}${b64urlEncode(JSON.stringify(payload))}`;
}

/**
 * Pulls a payload out of anything that might carry one -- a URL string or a
 * bookmark node. Returns null rather than throwing: this parses data that has
 * been sitting in a user's bookmark tree across arbitrary versions, syncs and
 * hand edits, and a malformed one must degrade to "no receipt", never to a
 * broken restore.
 */
export function decode(input) {
  const url = typeof input === "string" ? input : input?.url;
  if (typeof url !== "string") return null;
  const at = url.indexOf(TOKEN);
  if (at < 0) return null;
  try {
    const payload = JSON.parse(b64urlDecode(url.slice(at + TOKEN.length)));
    if (!payload || payload.v !== 1 || !Array.isArray(payload.items)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * A receipt is anything inside one of our vaults carrying a decodable payload.
 * The title is only a fallback, for a receipt whose URL a user has edited: the
 * point of the check is "do not hand this back to the user as a bookmark of
 * theirs", and a mangled receipt is still not theirs.
 */
export function isReceipt(node) {
  if (!node || node.url === undefined) return false;
  if (decode(node.url)) return true;
  return TITLE_MARKS.some((m) => typeof node.title === "string" && node.title.includes(m));
}

/**
 * The whole recovery procedure, in one sentence, in a place Chrome will keep
 * after the extension is gone. Everything a stranded user has to do is here:
 * where the bookmarks are, what to do with them, and which bar items are ours
 * to delete -- that last one being the only fact they could not work out alone.
 */
export function buildTitle({ items = 0, decoys = [] } = {}) {
  const n = items === 1 ? "1 bookmark is" : `${items} bookmarks are`;
  const head =
    `⚠️ ${RECEIPT_TITLE_MARK} — your ${n} IN THIS FOLDER. ` +
    `Drag them onto your bookmarks bar to put them back`;
  if (decoys.length === 0) return `${head}.`;
  const names = decoys.map((d) => d.title).join(", ");
  return (
    `${head}, then delete these ${decoys.length} look-alike links we added to ` +
    `the bar: ${names}.`
  );
}

/**
 * The payload. Ids are the exact-restore path and indices are the fallback, so
 * both are kept: within this profile the ids still name the same nodes after a
 * reinstall, and on a machine where sync has renumbered everything the ordinal
 * position in the vault is all that is left.
 *
 * The user's own titles and URLs are deliberately NOT included. The vault next
 * to this receipt already holds them, so copying them in would only widen what
 * a shared bookmark file discloses. The decoys are ours, and are listed so a
 * recovery page can name them without shipping our table.
 */
export function buildPayload({ barId, otherId, vaultId, items, decoys = [] }) {
  return {
    v: 1,
    at: Date.now(),
    bar: String(barId),
    other: String(otherId),
    vault: String(vaultId),
    items: items.map((i) => [String(i.id), i.index]),
    decoys: decoys.map((d) => [String(d.id), d.title, d.url]),
  };
}

/** Decoys as objects, for display. Never as deletion authority -- see engine. */
export function decoysOf(payload) {
  return (payload?.decoys ?? []).map(([id, title, url]) => ({ id, title, url }));
}

// ---------------------------------------------------------------------------

/** Chrome's hard cap on a runtime.setUninstallURL. */
export const UNINSTALL_URL_MAX = 1023;

/**
 * The page Chrome opens when the user removes the extension.
 *
 * Returns "" -- meaning "set nothing" -- unless bookmarks are actually
 * displaced, because an uninstall with the bar intact has nothing to recover
 * and a survey nobody asked for is not what this hook is for.
 *
 * It carries a count and a timestamp, not the payload: the cap is 1023
 * characters and a big enough bar would silently overflow it, while the receipt
 * inside the vault has no limit and is already where the user is going. This is
 * the shout, not the map.
 */
export function uninstallUrlFor(journal, base = RECOVERY_BASE) {
  if (!base || !journal || journal.state === "clear") return "";
  const items = (journal.groups ?? []).reduce(
    (sum, entry) => sum + (entry.items?.length ?? 0),
    0
  );
  if (items === 0) return "";
  const url = `${base}?uninstalled=1&n=${items}&at=${journal.startedAt ?? Date.now()}`;
  return url.length > UNINSTALL_URL_MAX ? base : url;
}
