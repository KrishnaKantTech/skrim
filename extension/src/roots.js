// Bookmark root detection.
//
// Two M0 findings drive this file:
//
// 1. getTree() returns only roots that exist. Mobile bookmarks is absent
//    entirely when empty, so the vault must live under Other Bookmarks.
//
// 2. Chrome's split local/account bookmark storage can surface TWO sets of
//    permanent folders, both rendered merged on one bar. An item moved into a
//    vault in the other storage would silently flip its sync status, so roots
//    are grouped by their `syncing` flag and each group is hidden and restored
//    independently.

const BAR_ID = "1";
const OTHER_ID = "2";

/**
 * Policy-managed bookmarks are read-only; chrome.bookmarks.move() rejects on
 * them. Enterprise profiles have these, so every child list must be filtered.
 */
export function isMutable(node) {
  return !node.unmodifiable;
}

function isBar(n) {
  return n.folderType === "bookmarks-bar" || (n.folderType == null && n.id === BAR_ID);
}

function isOther(n) {
  return n.folderType === "other" || (n.folderType == null && n.id === OTHER_ID);
}

/**
 * Returns { groups, skippedBars }.
 *
 * skippedBars is load-bearing: a bar we cannot pair with an Other Bookmarks in
 * the same storage is a bar we cannot vault, and therefore a bar we must not
 * claim to have hidden. Callers MUST fail rather than silently leaving it
 * populated -- findLeaks only inspects bars that made it into a group, so a
 * skipped bar is unreachable by verification by construction.
 */
export async function getGroups() {
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children ?? [];

  const bars = roots.filter(isBar);
  const others = roots.filter(isOther);

  if (bars.length === 0) {
    throw new Error("No bookmarks-bar root found");
  }

  const groups = [];
  const usedOthers = new Set();

  for (const bar of bars) {
    // Pair with the other-bookmarks root in the SAME storage. `syncing` is
    // undefined on older Chrome, where there is only one storage and the single
    // unused match is correct.
    //
    // There is deliberately no `?? others[0]` fallback. With split storage and
    // an empty account Other Bookmarks (which getTree() omits entirely, per the
    // Mobile-bookmarks behaviour), that fallback would route account bookmarks
    // into a LOCAL vault and silently flip their sync status -- the exact bug
    // this grouping exists to prevent. The bar is skipped and COUNTED, and the
    // caller aborts the hide; leaving it unhidden while reporting success would
    // put the user's bookmarks on a live screen share.
    const other =
      others.find((o) => o.syncing === bar.syncing && !usedOthers.has(o.id)) ??
      (bar.syncing === undefined
        ? others.find((o) => !usedOthers.has(o.id))
        : undefined);

    if (!other) continue;
    usedOthers.add(other.id);
    groups.push({ bar, other, syncing: bar.syncing ?? null });
  }

  if (groups.length === 0) {
    throw new Error("No usable bar/other root pair found");
  }
  return { groups, skippedBars: bars.length - groups.length };
}
