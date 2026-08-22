// Hide / restore engine.
//
// Core insight validated in M0: only the DIRECT CHILDREN of the bookmarks bar
// need to move. chrome.bookmarks.move() relocates each subtree as a unit, so
// hierarchy and internal order are preserved structurally rather than by
// bookkeeping. Measured on a real 560-node / 7-level tree: 12 moves, ~3ms, 14
// dirty sync entities, byte-identical round trips.
//
// Hard-won rules encoded here, each from a specific reviewed failure:
//
//  * chrome.bookmarks.move REJECTS an out-of-range index, it does not clamp.
//    A single failed move used to poison every subsequent one.
//  * Never treat "could not enumerate a folder" as "the folder is empty" when
//    the next statement is a recursive delete.
//  * Journal the loop INDEX before the mutation, not a success count after it.
//  * A journal saying HIDDEN is a claim, not a fact. Verify against the tree.
//  * Never adopt a vault we cannot prove is ours. Age cannot prove it.
//  * A deleted bookmark is not a failed restore, and a stuck decoy is not a
//    failed restore. Only failing them costs the user their real bookmarks.
//  * Chrome reports our own mutations back to us. Attribute them by id.

import { getGroups, isMutable } from "./roots.js";
import * as journal from "./journal.js";
import * as receipt from "./receipt.js";
import * as settings from "./settings.js";
import * as portable from "./portable.js";
import * as backups from "./backups.js";

export const VAULT_TITLE =
  "Skrim — hidden while screen sharing (drag these back to your bookmarks bar)";

/**
 * Every title a vault has ever been created with, newest first. Entries are
 * only ever added; none is ever removed or edited. A vault is named by the
 * product, the product is not finished being named, and a rename that stopped
 * recognising the folders already in people's trees would strand exactly the
 * bookmarks this file exists to give back. Recognition is therefore a list, not
 * a constant -- `VAULT_TITLE` is only the one we WRITE.
 *
 * The SecureShare entry is the pre-rename name. A tree that has not been
 * touched since then still holds folders under it, and after a sync so does a
 * tree that has.
 */
export const VAULT_TITLES = [
  VAULT_TITLE,
  "SecureShare — hidden while screen sharing (drag these back to your bookmarks bar)",
];

const isVaultTitle = (t) => VAULT_TITLES.includes(t);

/** Union of a title search over every name a vault may carry. */
async function findVaults() {
  const seen = new Map();
  for (const title of VAULT_TITLES) {
    for (const node of await chrome.bookmarks.search({ title })) {
      if (!node.url) seen.set(node.id, node);
    }
  }
  return [...seen.values()];
}

const OWNED_VAULTS_KEY = "secureshare.ownedVaults";
const LAST_FAILURE_KEY = "secureshare.lastFailure";
const STRAY_DECOYS_KEY = "secureshare.strayDecoys";

// Give up rather than retry a hopeless restore forever.
const MAX_RESTORE_ATTEMPTS = 3;
// Cosmetic litter should never grow without bound.
const MAX_STRAYS = 60;
// An index nothing can reach, so a Math.min(index, len) clamp appends.
const APPEND = 1e9;

const DECOYS = [
  { title: "Google", url: "https://www.google.com/" },
  { title: "Gmail", url: "https://mail.google.com/" },
  { title: "Calendar", url: "https://calendar.google.com/" },
  { title: "Drive", url: "https://drive.google.com/" },
  { title: "Maps", url: "https://maps.google.com/" },
  { title: "News", url: "https://news.google.com/" },
];

/**
 * Is this node still one of OUR placeholders?
 *
 * Checked by shape at the moment of deletion and never by the id alone: sync
 * can remap an id onto a bookmark of the user's, and these six are among the
 * most commonly bookmarked URLs in existence. Every path that deletes a decoy
 * asks this first, which is why it lives here rather than at each of them.
 */
const isDecoyNode = (node) =>
  !!node && DECOYS.some((d) => d.title === node.title && d.url === node.url);

// ---------------------------------------------------------------------------
// Serialisation. Two share events can arrive back to back; interleaved moves
// would corrupt the journal.

let chain = Promise.resolve();

function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

// ---------------------------------------------------------------------------
// Self-attribution.
//
// Chrome delivers onCreated / onMoved / onRemoved for OUR OWN mutations, and
// markDirty is serialised -- so those events queue behind the running hide and
// are handled only once the chain drains, by which time the state is already
// HIDDEN. Unattributed, they set `dirty` on every clean hide, which flips
// restore onto the append path and walks a policy-managed bookmark to the front
// of the bar on every meeting.
//
// Matched by id, never by a time window: a 1000-item hide outlives any window
// short enough to be useful, and a suspended laptop breaks every other one.
//
// Claims are made INSIDE the chain, so the mutation that produced an event has
// always been recorded before the event can be examined -- even though Chrome
// may dispatch the event before our own await resolves.

const selfMutated = new Map(); // id -> { n, at }
const SELF_MUTATION_TTL = 5 * 60 * 1000;

function noteSelfMutation(id) {
  if (id == null) return;
  const key = String(id);
  const cur = selfMutated.get(key);
  if (cur) {
    cur.n++;
    cur.at = Date.now();
  } else {
    selfMutated.set(key, { n: 1, at: Date.now() });
  }
  if (selfMutated.size > 4000) {
    const cutoff = Date.now() - SELF_MUTATION_TTL;
    for (const [k, v] of selfMutated) if (v.at < cutoff) selfMutated.delete(k);
  }
}

/** Consumes one outstanding self-mutation for this id. */
function claimSelfMutation(id) {
  if (id == null) return false;
  const key = String(id);
  const cur = selfMutated.get(key);
  if (!cur) return false;
  if (--cur.n <= 0) selfMutated.delete(key);
  return true;
}

// markDirty runs for every bookmark event in the profile; a sync merge or a
// bookmark-manager bulk edit delivers hundreds, and each one used to cost a
// storage read even when it returned early. hideImpl, restoreImpl and markDirty
// all run inside serialize(), so this cache is totally ordered with respect to
// every state change it depends on and cannot go stale. It starts false because
// a cold worker may inherit a live HIDDEN journal from a previous generation.
let dirtySuppressed = false;

// ---------------------------------------------------------------------------
// Helpers

async function childrenOf(id) {
  const sub = await chrome.bookmarks.getSubTree(id);
  return sub[0]?.children ?? [];
}

/** null (not []) when the folder could not be read -- callers must distinguish. */
async function childrenOrNull(id) {
  try {
    return await childrenOf(id);
  } catch {
    return null;
  }
}

async function nodeExists(id) {
  try {
    const got = await chrome.bookmarks.get(id);
    return Array.isArray(got) && got.length > 0;
  } catch {
    return false;
  }
}

// Every mutation goes through these three so the resulting event can be
// recognised as ours. A throw means no event was emitted, so nothing is noted.

async function bmCreate(props) {
  const node = await chrome.bookmarks.create(props);
  noteSelfMutation(node?.id);
  return node;
}

async function bmMove(id, dest) {
  const node = await chrome.bookmarks.move(id, dest);
  noteSelfMutation(id);
  return node;
}

async function safeRemoveTree(id) {
  try {
    await chrome.bookmarks.removeTree(id);
    noteSelfMutation(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Put one journalled item back on its bar.
 *
 * The index is a REQUEST, never a requirement. chrome.bookmarks.move rejects an
 * out-of-range index rather than clamping it, so every index this file computes
 * has to be able to be wrong without costing the user the bookmark -- and an
 * index that is wrong for one item is usually wrong for every item after it,
 * because the count it was derived from does not advance on a refusal. A move
 * with no index at all appends, which cannot be out of range; it costs at worst
 * one item's position, which is the whole reason a second attempt is worth
 * making before calling an item stuck.
 *
 * The ORIGINAL error is rethrown when the append fails too. It names the index
 * we actually asked for, which is the one that has to be diagnosable.
 */
async function restoreToBar(id, barId, index) {
  try {
    return await bmMove(id, { parentId: barId, index });
  } catch (err) {
    try {
      return await bmMove(id, { parentId: barId });
    } catch {
      throw err;
    }
  }
}

/**
 * Retitle a node of OURS -- a receipt whose contents changed under it, or a tuck
 * folder the user renamed mid-share. Deliberately NOT self-attributed: an update
 * emits only onChanged, which is deliberately not wired to markDirty (a rename
 * moves nothing, so it cannot stale an index). Noting a mutation nobody will
 * ever claim would leave a stale entry for a LATER real event on the same id to
 * consume, and quietly excuse a move the user made.
 */
async function bmUpdate(id, props) {
  try {
    await chrome.bookmarks.update(id, props);
    return true;
  } catch {
    return false;
  }
}

async function ownedVaults() {
  const got = await chrome.storage.local.get(OWNED_VAULTS_KEY);
  return got[OWNED_VAULTS_KEY] ?? [];
}

async function addOwnedVault(id) {
  const list = await ownedVaults();
  if (!list.includes(id)) {
    list.push(id);
    await chrome.storage.local.set({ [OWNED_VAULTS_KEY]: list });
  }
}

async function dropOwnedVault(id) {
  const list = (await ownedVaults()).filter((v) => v !== id);
  await chrome.storage.local.set({ [OWNED_VAULTS_KEY]: list });
}

// ---------------------------------------------------------------------------
// Stray decoys.
//
// Decoys are cosmetic, so they must never gate a restore -- a leftover fake
// "Calendar" bookmark forcing a give-up would discard the journal, which is the
// only record of where the user's REAL bookmarks belong. But removing that gate
// without giving cleanup somewhere else to live stranded the decoy on the bar
// forever, because the journal that named it was then cleared.
//
// So cleanup gets its own lifecycle: a flat id list, outliving any journal,
// drained by the watchdog and before every hide. Nothing here can block a hide
// or fail a restore.

async function strayDecoys() {
  const got = await chrome.storage.local.get(STRAY_DECOYS_KEY);
  return got[STRAY_DECOYS_KEY] ?? [];
}

async function addStrayDecoys(ids) {
  if (!ids || ids.length === 0) return;
  const list = await strayDecoys();
  let changed = false;
  for (const id of ids) {
    if (!list.includes(id)) {
      list.push(id);
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [STRAY_DECOYS_KEY]: list.slice(-MAX_STRAYS) });
}

async function sweepStrayDecoysImpl() {
  const list = await strayDecoys();
  if (list.length === 0) return { cleared: 0, remaining: [] };

  const remaining = [];
  let cleared = 0;
  for (const id of list) {
    let node;
    try {
      node = (await chrome.bookmarks.get(id))?.[0] ?? null;
    } catch {
      // Unreadable this pass. Only forget it if it is genuinely gone.
      if (await nodeExists(id)) remaining.push(id);
      else cleared++;
      continue;
    }
    if (!node) {
      cleared++; // already gone
    } else if (!isDecoyNode(node)) {
      cleared++; // id remapped by sync -- leave the real bookmark alone
    } else if (await safeRemoveTree(id)) {
      cleared++;
    } else {
      remaining.push(id);
    }
  }
  await chrome.storage.local.set({ [STRAY_DECOYS_KEY]: remaining });
  return { cleared, remaining };
}

/**
 * True when a vault holds nothing but its own receipt -- and clears the receipt
 * on the way, so the caller can delete the folder.
 *
 * The order matters. A receipt is only discarded once the items it describes
 * are provably back on the bar; while ANY of them is still in the vault it
 * remains the sole record of where they belong, and a restore that failed
 * halfway must not also destroy the map to what it failed to move.
 */
async function emptyVault(id) {
  const kids = await childrenOrNull(id);
  if (kids === null) return false; // unreadable: never guess, never delete
  if (kids.some((k) => !receipt.isReceipt(k))) return false;
  for (const k of kids) await safeRemoveTree(k.id);
  const left = await childrenOrNull(id);
  return left !== null && left.length === 0;
}

/**
 * Take the placeholders a receipt names off the bar, by id.
 *
 * The sweep needs this where restoreImpl does not: restoreImpl works from a
 * journal, and a journal only exists while the extension that wrote it does.
 * An uninstall takes storage.local with it, so after a reinstall the receipt
 * inside the vault is the ONLY surviving record that six ordinary-looking
 * bookmarks on the bar are ours to delete.
 *
 * Anything that will not go this pass is handed to the stray list rather than
 * dropped -- housekeeping drains that immediately afterwards, and every hide
 * drains it again, so a decoy can never be stranded with no record of it.
 */
async function removeDecoysById(ids) {
  const left = [];
  for (const id of ids ?? []) {
    let node;
    try {
      node = (await chrome.bookmarks.get(id))?.[0] ?? null;
    } catch {
      // Unreadable this pass. Only forget it if it is genuinely gone.
      if (await nodeExists(id)) left.push(id);
      continue;
    }
    if (!node) continue; // already gone
    if (!isDecoyNode(node)) continue; // id remapped by sync -- not ours
    if (!(await safeRemoveTree(id))) left.push(id);
  }
  await addStrayDecoys(left);
}

/** Everything that is safe to do on any wake, in any state. */
async function housekeeping() {
  return { swept: await sweepOrphanVaults(), strays: await sweepStrayDecoysImpl() };
}

// ---------------------------------------------------------------------------
// Orphan sweep.
//
// Only drains vaults this profile can PROVE are its own: either present in the
// storage.local registry (which does not sync), or sitting in a storage that
// does not sync at all, where no peer can reach us.
//
// It used to adopt any unowned vault older than six hours, on the theory that
// no meeting runs that long. Both halves are false. A laptop suspended or taken
// offline mid-hide keeps its vault indefinitely, so the desktop would empty a
// peer's vault onto the shared, synced bar and then delete it -- the precise
// disclosure this extension exists to prevent. And a clock running fast skips
// the threshold outright, since the age compares our Date.now() against a
// dateAdded written by another machine.
//
// So we no longer guess. Unowned vaults are REPORTED, badged, and adopted only
// when the user says so.

async function pendingAdoptionsImpl() {
  const owned = new Set(await ownedVaults());
  let found = [];
  try {
    found = await findVaults();
  } catch {
    return [];
  }
  const out = [];
  for (const node of found) {
    if (owned.has(node.id)) continue;
    const kids = await childrenOrNull(node.id);
    out.push(await describeVault(node, kids));
  }
  return out;
}

/**
 * What the popup and the recovery page need to say to a user staring at an
 * unowned vault, which is always the same question: is this MINE, from before
 * I uninstalled, or is it another of my computers hiding its bar right now?
 *
 * `local` answers it. Bookmark ids are profile-local, so a receipt that names
 * its own vault's id was written here; the same folder arriving over sync
 * carries a receipt naming an id that means something else (or nothing) on this
 * machine. That is the only durable evidence of origin in the tree -- age is
 * not, which is why this extension stopped guessing from it.
 */
const isLocalReceipt = (rec, vaultNode) =>
  !!rec && String(rec.vault) === String(vaultNode?.id);

async function describeVault(node, kids) {
  const rec = (kids ?? []).map((k) => receipt.decode(k.url)).find(Boolean) ?? null;
  const real = (kids ?? []).filter((k) => !receipt.isReceipt(k));
  return {
    id: node.id,
    parentId: node.parentId ?? null,
    count: kids === null ? null : real.length,
    dateAdded: node.dateAdded ?? null,
    hidAt: rec?.at ?? null,
    local: isLocalReceipt(rec, node),
    exact: isLocalReceipt(rec, node),
    // Whether there is a receipt AT ALL, which is a different question from
    // whether it is ours. No receipt means the origin is simply unknown -- a
    // vault written before receipts existed, or one whose receipt the user
    // deleted -- and that must not be reported as a peer's live hide. `local`
    // alone cannot tell those apart: both answer false.
    receipt: !!rec,
    decoys: receipt.decoysOf(rec),
  };
}

export async function sweepOrphanVaults() {
  let recovered = 0;
  let removed = 0;
  let skippedForeign = 0;
  let adopted = 0;
  const pendingAdoption = [];
  const result = () => ({ recovered, removed, skippedForeign, adopted, pendingAdoption });

  const owned = new Set(await ownedVaults());
  let found = [];
  try {
    found = await findVaults();
  } catch {
    return result();
  }

  const { groups } = await getGroups().catch(() => ({ groups: [] }));

  for (const node of found) {
    const kids = await childrenOrNull(node.id);
    if (kids === null) continue; // unreadable: never guess, never delete

    if (!owned.has(node.id)) {
      const home = groups.find((g) => g.other.id === node.parentId);
      if (home?.syncing !== false) {
        // Might be a synced peer's live hide. Even an EMPTY one: sync can
        // deliver the folder ~2s before the moves that fill it, so deleting it
        // would break a hide that is still in progress on another machine.
        pendingAdoption.push(await describeVault(node, kids));
        skippedForeign++;
        continue;
      }
      adopted++; // local-only storage: unreachable by any peer, so it is ours
    }

    // Read the receipt BEFORE anything moves. Draining the vault destroys it,
    // and on the path that matters here -- a reinstall, where the journal died
    // with the old installation -- it is the only record of where each item
    // belongs and which bar items are ours. Trusted for placement only when it
    // proves it was written on this profile: ids from another machine name
    // other things here, and a plan built on them would reorder a bar on a
    // guess. Same test the popup shows the user before asking them.
    const rec = kids.map((k) => receipt.decode(k.url)).find(Boolean) ?? null;
    const exact = isLocalReceipt(rec, node);

    // Our placeholders first, so the recorded indices land on a bar that is
    // the one the receipt described rather than that bar plus six of ours.
    if (exact) await removeDecoysById((rec.decoys ?? []).map(([id]) => String(id)));

    // The receipt is ours, not the user's. Moving it to the bar would hand
    // someone a bookmark titled "drag these back" sitting on the bar it is
    // telling them to drag things onto.
    const real = kids.filter((k) => !receipt.isReceipt(k));
    if (real.length > 0) {
      const group = groups.find((g) => g.other.id === node.parentId) ?? groups[0];
      if (!group) continue;
      const barKids = await childrenOrNull(group.bar.id);
      if (barKids === null) continue;
      let len = barKids.length;
      // With a local receipt every item goes back to the index it left from.
      // Without one, the bar's current length is the only always-valid index --
      // order survives, position does not, which is all a receiptless vault can
      // offer. Anything the receipt does not name is something the user put in
      // the folder themselves; it gets a home, not one we invented for it.
      const byId = exact
        ? new Map(rec.items.map(([itemId, index]) => [String(itemId), index]))
        : null;
      const at = (k) => (byId ? byId.get(String(k.id)) ?? APPEND : APPEND);
      const queue = byId ? [...real].sort((a, b) => at(a) - at(b)) : real;
      for (const k of queue) {
        try {
          // Same rule as the restore paths: the index is a request. These items
          // come out of a vault rather than off the bar, so the count cannot
          // drift the way it can there -- but a bar changing underneath a sweep
          // is exactly the reinstall-and-sync case this runs in, and an item
          // that lands in the wrong place beats one that does not land.
          await restoreToBar(k.id, group.bar.id, Math.min(at(k), len));
          len++;
          recovered++;
        } catch { /* one stuck item must not block the rest */ }
      }
    }

    if (await emptyVault(node.id)) {
      if (await safeRemoveTree(node.id)) {
        removed++;
        await dropOwnedVault(node.id);
      }
    }
  }
  // Prune registry ids whose node is gone, so the list cannot grow unbounded.
  const live = [];
  for (const id of owned) if (await nodeExists(id)) live.push(id);
  if (live.length !== owned.size) {
    await chrome.storage.local.set({ [OWNED_VAULTS_KEY]: live });
  }

  return result();
}

// ---------------------------------------------------------------------------
// Is the journal's HIDDEN claim still true of the actual tree?
//
// The vault is named "drag these back to your bookmarks bar", so users do
// exactly that. Without this check the next hide would no-op and every
// bookmark would be on screen for the whole share.

async function stillHidden(j) {
  // A tuck hide leaves a folder on the bar rather than an empty one, so its
  // "still hidden" question is a different one -- see stillTucked.
  if (j?.mode === "tuck") return stillTucked(j);
  for (const entry of j.groups ?? []) {
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) return false;
    const decoys = new Set(entry.decoyIds ?? []);
    for (const k of kids) {
      if (!isMutable(k)) continue;
      if (decoys.has(k.id)) continue;
      // Deliberately NOT shape-matched: a user's own bookmark to google.com
      // would then excuse itself from verification and stay on screen.
      return false; // a real bookmark is visible
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The two things a vault hide leaves behind besides the vault itself: the
// placeholders on the bar, and the receipt inside the vault that explains them.
// Both are built here rather than inline, because the live settings below have
// to be able to add and rewrite them long after the hide that made them ran.

/**
 * Drop the placeholder set onto one bar, journalling as it goes.
 *
 * `decoyNext` is the loop INDEX, journalled after each iteration -- NOT a count
 * of successes. They diverge the moment one create throws, and a count then
 * points the crash sweep at the wrong decoy spec, stranding a fake bookmark on
 * the bar forever. With the index, a crash between create() returning and the
 * write leaves decoyNext pointing at exactly the decoy that was created but
 * never journalled, whatever failed before it.
 *
 * Returns the (id, title, url) of each one that actually got created, which is
 * what the receipt needs and the journal deliberately does not keep: pairing
 * them by position in decoyIds would be wrong the moment one create throws and
 * the two lists shear.
 */
async function createDecoys(j, entry) {
  // A tuck hide journals no decoy fields at all -- it has never had any -- and
  // switching one to vault mode mid-share is how an entry without them gets
  // here. Seeded before the write, so the journal that goes to disk describes
  // the phase that is about to run rather than half of it.
  entry.decoyIds = entry.decoyIds ?? [];
  entry.decoyPhase = true;
  entry.decoyNext = 0;
  await journal.write(j);
  const made = [];
  for (let i = 0; i < DECOYS.length; i++) {
    let created = null;
    try {
      created = await bmCreate({
        parentId: entry.barId,
        title: DECOYS[i].title,
        url: DECOYS[i].url,
      });
    } catch { /* decoys are cosmetic; never fail a hide over them */ }
    if (created) {
      entry.decoyIds.push(created.id);
      made.push({ id: created.id, ...DECOYS[i] });
    }
    entry.decoyNext = i + 1;
    await journal.write(j);
  }
  return made;
}

/**
 * Write the vault's receipt, or bring the one already there up to date.
 *
 * Updating in place matters for the live settings: a receipt names the
 * placeholders it is standing next to, and one that still names six bookmarks
 * the user has just switched off would tell a stranded reader to go and delete
 * bookmarks of their own. A recovery aid must never be the reason anything
 * fails, so every path here reports rather than throws.
 */
async function syncReceipt(j, entry, decoys = []) {
  if (!entry.vaultId) return false;
  try {
    const title = receipt.buildTitle({ items: entry.items.length, decoys });
    const url = receipt.buildUrl(
      receipt.buildPayload({
        barId: entry.barId,
        otherId: entry.otherId,
        vaultId: entry.vaultId,
        items: entry.items,
        decoys,
      })
    );
    if (entry.receiptId && (await bmUpdate(entry.receiptId, { title, url }))) return true;
    const node = await bmCreate({ parentId: entry.vaultId, index: 0, title, url });
    entry.receiptId = node.id;
    await journal.write(j);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

async function hideImpl({ decoys } = {}) {
  const existing = await journal.read();
  if (journal.isDisplaced(existing)) {
    if (await stillHidden(existing)) {
      return { ok: true, alreadyHidden: true, moved: 0 };
    }
    // Journal and reality disagree. Reconcile first -- and if that leaves the
    // journal in place, stop: it is the only record of where the displaced
    // items belong, and proceeding would overwrite it.
    //
    // gaveUp is the exception, not a failure to respect: the reconcile has
    // already cleared the journal and filed a lastFailure record, so there is
    // nothing left to overwrite and refusing would only keep the bar exposed.
    const reconciled = await restoreImpl({ internal: true });
    if (!reconciled.ok && !reconciled.gaveUp) {
      return { ok: false, error: "reconcile before hide failed", reconciled };
    }
  }

  // Before snapshotting the bar. A decoy left behind by an earlier restore is
  // indistinguishable from a real bookmark to the planner, so it would be
  // vaulted and then handed back to the user as a genuine "Google" bookmark.
  // One storage read in the common case, where the list is empty.
  await sweepStrayDecoysImpl();

  const { groups, skippedBars } = await getGroups();
  if (skippedBars > 0) {
    // We cannot vault this bar, and findLeaks cannot even see it. Reporting
    // success would leave real bookmarks on a live screen share.
    return {
      ok: false,
      error: "unpairable bookmarks bar; refusing to report a partial hide",
      skippedBars,
    };
  }
  const plan = [];
  for (const g of groups) {
    const all = await childrenOf(g.bar.id);
    const kids = all.filter(isMutable);
    if (kids.length === 0) continue;
    // Absolute index within the UNFILTERED bar, so policy-managed siblings that
    // stay behind are not silently reordered on restore.
    plan.push({ group: g, kids: kids.map((k) => ({ id: k.id, index: k.index })) });
  }

  if (plan.length === 0) return { ok: true, moved: 0, reason: "nothing to hide" };

  const entries = [];
  for (const p of plan) {
    const vault = await bmCreate({
      parentId: p.group.other.id,
      title: VAULT_TITLE,
    });
    await addOwnedVault(vault.id);
    entries.push({
      barId: p.group.bar.id,
      otherId: p.group.other.id,
      vaultId: vault.id,
      syncing: p.group.syncing,
      items: p.kids,
      decoyIds: [],
      decoyPhase: false,
      decoyNext: 0,
    });
  }

  const j = journal.create(entries);
  await journal.write(j);

  // Move out. No index: appending into a fresh vault preserves order and can
  // never go out of bounds, so one failure cannot poison the rest.
  let moved = 0;
  const failures = [];
  for (const entry of entries) {
    for (const item of entry.items) {
      try {
        await bmMove(item.id, { parentId: entry.vaultId });
        moved++;
      } catch (err) {
        failures.push({ id: item.id, error: String(err?.message ?? err) });
      }
    }
  }

  if (failures.length > 0) {
    await journal.setState(journal.State.RESTORING);
    const rollback = await restoreImpl({ internal: true });
    return { ok: false, error: "partial hide, rolled back", failures, rollback };
  }

  // Decoys. See createDecoys for why the journalling looks the way it does.
  const decoysMade = new Map(); // entry -> [{ id, title, url }]

  // The caller can force decoys on or off (the developer buttons, the tests,
  // the rollback paths that never want them); when it does not say, the user's
  // setting decides. Read here rather than at the top so the early-return paths
  // -- nothing to hide, already hidden, a rolled-back partial -- add no storage
  // call and keep the fault-injection call numbering they were written against.
  const wantDecoys = decoys ?? (await settings.read()).decoys;

  if (wantDecoys) {
    const entry = entries[0]; // one set is enough; the bar renders storages merged
    decoysMade.set(entry, await createDecoys(j, entry));
  }

  // The receipt. Written LAST, deliberately: by here the bar is already clear,
  // so the one thing on the critical path of a starting screen share -- the
  // moves -- has already happened, and the receipt can therefore also name the
  // decoys, which do not exist any earlier. A crash in the window before it is
  // written costs nothing that matters: the journal covers every failure the
  // extension is still installed for, and the receipt only ever has to answer
  // the one it is not.
  for (const entry of entries) {
    await syncReceipt(j, entry, decoysMade.get(entry) ?? []);
  }

  // Verify: no real bookmark may remain visible on any bar.
  let leaked = await findLeaks(entries);
  if (leaked.length > 0) {
    // One repair attempt before the nuclear option -- rolling back exposes the
    // entire bar on a live screen share, which is worse than the leak.
    for (const l of leaked) {
      try {
        await bmMove(l.id, { parentId: l.vaultId });
      } catch { /* fall through to the recheck */ }
    }
    leaked = await findLeaks(entries);
  }

  if (leaked.length > 0) {
    await journal.setState(journal.State.RESTORING);
    const rollback = await restoreImpl({ internal: true });
    return { ok: false, error: "verification failed, rolled back", leaked, rollback };
  }

  dirtySuppressed = false; // from here on, a tree change is worth recording
  await journal.setState(journal.State.HIDDEN);
  return {
    ok: true,
    moved,
    decoys: entries.reduce((n, e) => n + e.decoyIds.length, 0),
  };
}

async function findLeaks(entries) {
  const leaks = [];
  for (const entry of entries) {
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) continue;
    const decoySet = new Set(entry.decoyIds ?? []);
    for (const k of kids) {
      if (!isMutable(k)) continue;
      if (decoySet.has(k.id)) continue;
      leaks.push({ id: k.id, vaultId: entry.vaultId });
    }
  }
  return leaks;
}

// ---------------------------------------------------------------------------
// Placeholder teardown, shared by every path that ends or edits a hide.
//
// Lifted out of restoreImpl unchanged, because the live settings below need the
// exact same care for a reason restore does not have: a user turning the
// placeholders OFF mid-share is asking for six bookmarks to come off a bar that
// is on screen right now, and getting that wrong in either direction -- leaving
// one behind, or deleting a real bookmark whose id sync has reused -- is the
// same failure it has always been.

async function clearJournalledDecoys(j) {
  for (const entry of j.groups) {
    // Removed one at a time and persisted after each, mirroring the write-ahead
    // ordering used to create them. A fault mid-loop then leaves the journal
    // holding exactly the ids still present, so recovery finishes the job by id
    // -- no shape guessing, nothing stranded.
    const queue = [...(entry.decoyIds ?? [])];
    const retained = [];
    while (queue.length > 0) {
      const id = queue.shift();
      let done = false;
      try {
        const node = (await chrome.bookmarks.get(id))?.[0] ?? null;
        if (!node) {
          done = true; // already gone
        } else if (!isDecoyNode(node)) {
          done = true; // id remapped by sync -- leave the real bookmark alone
        } else {
          done = await safeRemoveTree(id);
        }
      } catch {
        // Unreadable this pass. Only drop it if it is genuinely gone; a
        // transient failure must keep the id journalled, or the decoy is
        // stranded on the bar with no record that it exists.
        done = !(await nodeExists(id));
      }
      if (!done) retained.push(id);
      entry.decoyIds = [...retained, ...queue];
      await journal.write(j);
    }
    // Hand anything we could not remove to the stray list, which outlives this
    // journal. The journal keeps its own copy too, so a crash mid-loop still
    // recovers by id -- the two records serve different lifetimes.
    await addStrayDecoys(retained);

    // Sweep the ONE decoy that may have been created without reaching the
    // journal (crash between create() returning and its write). Bounded hard:
    // only the exact next decoy in sequence, only if newer than the hide
    // started. Matching more broadly would delete a user's own bookmark to
    // google.com -- these are the six most common bookmarks in existence.
    if (entry.decoyPhase) {
      const spec = DECOYS[entry.decoyNext ?? 0];
      if (spec) {
        const kids = await childrenOrNull(entry.barId);
        const hit = (kids ?? []).find(
          (k) =>
            k.url === spec.url &&
            k.title === spec.title &&
            typeof k.dateAdded === "number" &&
            k.dateAdded >= (j.startedAt ?? 0)
        );
        if (hit) await safeRemoveTree(hit.id);
      }
      if (retained.length === 0) entry.decoyPhase = false;
      await journal.write(j);
    }
  }
}

/**
 * Take our tuck folders off the bar, once they are empty.
 *
 * Called by BOTH restore paths, not just the tuck one. A hide that was switched
 * from the vault to a folder mid-share and then interrupted leaves a journal
 * saying "vault" and a folder on the bar; whichever path runs has to be able to
 * finish the job, or the user is left with an empty folder they did not make.
 * A folder still holding a stuck item is kept, along with the journal, so the
 * watchdog can retry.
 */
async function dropTuckFolders(j) {
  // The ids actually removed, for the one caller that has to edit the journal
  // afterwards. Reported rather than re-derived: "is it gone?" answered by a
  // read that failed reads exactly like "yes", and clearing a folderId on a
  // transient failure would strand the folder on the bar with no record of it.
  const removed = new Set();

  for (const entry of j.groups ?? []) {
    if (!entry.folderId) continue;
    const left = await childrenOrNull(entry.folderId);
    if (left !== null && left.length === 0 && (await safeRemoveTree(entry.folderId))) {
      removed.add(entry.folderId);
    }
  }

  // Orphan sweep. A crash between creating a folder and journalling its id
  // leaves an EMPTY folder on the bar the id-based delete above cannot see.
  // Bounded exactly like the decoy sweep -- our title, empty, and newer than
  // this hide began -- so it can never take a folder the user made themselves.
  if (!j.folderTitle) return removed;
  for (const barId of new Set((j.groups ?? []).map((e) => e.barId))) {
    const kids = await childrenOrNull(barId);
    for (const k of kids ?? []) {
      if (k.url !== undefined || k.title !== j.folderTitle) continue;
      if (typeof k.dateAdded === "number" && k.dateAdded < (j.startedAt ?? 0)) continue;
      const inside = await childrenOrNull(k.id);
      if (inside !== null && inside.length === 0 && (await safeRemoveTree(k.id))) {
        removed.add(k.id);
      }
    }
  }
  return removed;
}

/**
 * What a give-up has to leave behind.
 *
 * The journal is cleared once the retries run out, so this record becomes the
 * only thing that still knows a restore failed -- and the 2026-08-21 failure
 * showed what it was missing. It said "11 stuck" and no more: not one word of
 * why any move was refused, and no mention that the eleven were sitting in a
 * folder called "Bookmarks" on the bar. For a tuck hide that is a folder
 * nothing left in the extension can recognise afterwards, so the count was
 * genuinely all the user had. Diagnosing it needed the browser profile on disk.
 *
 * `errors` is deduplicated because eleven items refused for one reason is one
 * fact, and `where` names the container each group's items are still in, so
 * anything downstream can point at them instead of counting them.
 */
function failureRecord(j, fields) {
  const { attempts, restored, missing, stuck, decoysStuck, mismatches } = fields;
  return {
    at: Date.now(),
    attempts,
    mode: j.mode ?? "vault",
    restored,
    missing: missing.map((m) => m.id),
    stuck: stuck.map((m) => m.id),
    errors: [...new Set(stuck.map((s) => s.error).filter(Boolean))].slice(0, 4),
    where: (j.groups ?? [])
      .map((e) => ({
        barId: e.barId,
        folderId: e.folderId ?? null,
        vaultId: e.vaultId ?? null,
      }))
      .filter((w) => w.folderId || w.vaultId),
    folderTitle: j.folderTitle ?? null,
    decoysStuck,
    mismatches,
  };
}

// ---------------------------------------------------------------------------

async function restoreImpl({ internal = false } = {}) {
  const j = await journal.read();
  if (!journal.isDisplaced(j)) {
    dirtySuppressed = true;
    return { ok: true, alreadyRestored: true, ...(await housekeeping()) };
  }

  // A tuck hide is put back by a different, simpler path: its items sit in a
  // folder on the bar, not a vault, and no decoys, receipts or owned vaults are
  // in play. Branch before any of that machinery runs. recover() reaches restore
  // through here too, so an interrupted tuck is repaired by the same code.
  if (j.mode === "tuck") return tuckRestoreImpl(j, { internal });

  if (!internal) await journal.setState(journal.State.RESTORING);

  // Decoys first, so real items land on a bar that is as close to empty as
  // possible. Identity is re-verified: an id remapped by sync must never take
  // a real bookmark with it.
  await clearJournalledDecoys(j);

  let restored = 0;
  const missing = [];
  const stuck = [];

  for (const entry of j.groups) {
    const barKids = await childrenOrNull(entry.barId);
    // Track length locally so every index is in range without re-reading the
    // bar N times. Chrome rejects out-of-range indices; it does not clamp.
    let len = barKids === null ? 0 : barKids.length;
    // Which of these are ALREADY on the bar. Moving one of those is a reorder,
    // not an arrival, so it leaves the bar exactly as long as it was -- and a
    // length counted by successes is then one past the end for every item after
    // it, forever, because it only advances when a move succeeds. See
    // restoreToBar: this is the arithmetic, that is the safety net.
    const onBar = new Set((barKids ?? []).map((k) => k.id));

    for (const item of entry.items) {
      // When the tree changed under us, stale absolute indices are worse than
      // useless; appending at least preserves journalled relative order.
      const target = j.dirty ? len : Math.min(item.index, len);
      try {
        await restoreToBar(item.id, entry.barId, target);
        if (!onBar.has(item.id)) {
          onBar.add(item.id);
          len++;
        }
        restored++;
      } catch (err) {
        // Distinguish "the user deleted it" (permanent, drop it) from "the move
        // failed" (transient, keep the journal so the watchdog retries).
        if (await nodeExists(item.id)) {
          stuck.push({ id: item.id, error: String(err?.message ?? err) });
        } else {
          missing.push({ id: item.id });
        }
      }
    }
  }

  // Verify by RELATIVE order, not absolute position: a bookmark the user added
  // during the share legitimately shifts everything and must not read as
  // corruption.
  const mismatches = [];
  for (const entry of j.groups) {
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) {
      mismatches.push({ barId: entry.barId, error: "bar unreadable" });
      continue;
    }
    const gone = new Set([...missing, ...stuck].map((m) => m.id));
    const expected = entry.items.map((i) => i.id).filter((id) => !gone.has(id));
    const actual = kids.map((k) => k.id).filter((id) => expected.includes(id));
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        mismatches.push({ index: i, expected: expected[i], actual: actual[i] ?? null });
      }
    }
  }

  // Only ever delete a vault we can confirm is empty -- "empty" meaning it
  // holds nothing but the receipt, which is discarded with it. A vault still
  // holding a real item keeps both.
  for (const entry of j.groups) {
    if (!entry.vaultId) continue;
    if (await emptyVault(entry.vaultId)) {
      if (await safeRemoveTree(entry.vaultId)) await dropOwnedVault(entry.vaultId);
    }
  }

  // And any folder a half-finished switch to tuck mode left on the bar. A
  // classic vault hide journals neither a folderId nor a folderTitle, so this
  // is a no-op for every hide that was never converted.
  await dropTuckFolders(j);

  // Drain the stray list before judging the outcome, so `decoysStuck` reports
  // what is actually still on the bar rather than what failed one attempt ago.
  const hk = await housekeeping();
  const decoysStuck = hk.strays.remaining.length;

  // What counts as failure, and therefore as worth retrying.
  //
  // NOT `missing`: that means the user deleted the bookmark. It is permanent,
  // expected, and no retry can fix it. Gating success on it made one deleted
  // bookmark fail every future restore, burn the three-attempt budget, and --
  // through the reconcile-before-hide gate -- refuse to hide the bar for the
  // next two meetings. Only a restore that recovered NOTHING is real loss.
  //
  // NOT `decoysStuck` either: a leftover fake "Calendar" bookmark is cosmetic,
  // and letting it force a give-up would discard the journal that is the only
  // record of where the user's real bookmarks belong. Both are reported.
  const totalItems = j.groups.reduce((n, e) => n + e.items.length, 0);
  const totalLoss = totalItems > 0 && restored === 0 && missing.length === totalItems;
  const ok = stuck.length === 0 && mismatches.length === 0 && !totalLoss;

  let gaveUp = false;
  if (ok) {
    await journal.clear();
    await chrome.storage.local.remove(LAST_FAILURE_KEY);
  } else {
    // Keep the journal: it is the only record of where these belong. But bound
    // the retries -- an item that can never move (policy applied mid-session,
    // getGroups throwing) would otherwise wedge the watchdog into a 60-second
    // loop forever, with status() reporting hidden: true permanently.
    j.attempts = (j.attempts ?? 0) + 1;
    if (j.attempts >= MAX_RESTORE_ATTEMPTS) {
      gaveUp = true;
      await chrome.storage.local.set({
        [LAST_FAILURE_KEY]: failureRecord(j, {
          attempts: j.attempts,
          restored,
          missing,
          stuck,
          decoysStuck: hk.strays.remaining,
          mismatches: mismatches.length,
        }),
      });
      await journal.clear();
    } else {
      j.state = journal.State.RESTORING;
      j.updatedAt = Date.now();
      await journal.write(j);
    }
  }

  dirtySuppressed = true; // no live hide either way, so nothing to mark

  return {
    ok,
    gaveUp,
    attempts: j.attempts ?? 0,
    restored,
    missing,
    stuck,
    decoysStuck,
    mismatches,
    ...hk,
  };
}

// ---------------------------------------------------------------------------
// Public API

export const hide = (opts) => serialize(() => hideImpl(opts));
export const restore = (opts) => serialize(() => restoreImpl(opts));

/**
 * Hide by whichever mechanism the user has chosen. This is the entry point the
 * PRODUCT drives -- the automatic share-hide and the popup's Hide button --
 * while `hide` stays the pure vault primitive the tests and the developer panel
 * use. The choice is read from settings here and written into the journal by the
 * hide it dispatches to, so restore, which is mode-aware, always matches even if
 * the toggle is flipped mid-share.
 *
 * settings.read() falls back to safe defaults (tuck OFF) on a storage failure,
 * so a glitch can only ever route to the vault path, never strand a hide.
 */
async function concealImpl(opts = {}) {
  const saved = await settings.read();
  // The snapshot goes HERE and not inside hideImpl/tuckHideImpl for two
  // reasons. It is taken before either mechanism is chosen, so one copy covers
  // both; and `hide` stays the pure vault primitive the fault-injection sweep
  // counts chrome calls through, which a storage write in the middle of would
  // renumber.
  //
  // Unconditional, with autoSnapshot reading the switch itself: the ONE place
  // that decides whether an automatic snapshot happens is inside that function,
  // so there is no second copy of the rule here to fall out of step with it.
  // It can never throw -- a hide must not be able to fail because of its own
  // safety net -- and its result is deliberately ignored.
  await autoSnapshot(backups.Kind.PREHIDE);
  return saved.tuckMode ? tuckHideImpl(saved.tuckName) : hideImpl(opts);
}

export const conceal = (opts) => serialize(() => concealImpl(opts));

/**
 * Repair an INTERRUPTED operation. Deliberately does not touch a healthy
 * HIDDEN state: onInstalled fires on extension auto-update, and un-hiding
 * mid-meeting would repopulate the bar on a live screen share.
 */
export const recover = ({ maxHiddenMs = Infinity } = {}) =>
  serialize(async () => {
    const j = await journal.read();
    if (!j || j.state === journal.State.CLEAR) {
      return { recovered: false, ...(await housekeeping()) };
    }
    const age = Date.now() - (j.updatedAt ?? j.startedAt ?? 0);
    const stale = maxHiddenMs <= 0 ? true : age > maxHiddenMs;
    if (j.state === journal.State.HIDDEN && !stale) {
      return { recovered: false, healthyHide: true };
    }
    return { recovered: true, ...(await restoreImpl({ internal: true })) };
  });

/**
 * Record that the tree changed under a live hide, so restore appends in
 * journalled relative order instead of trusting stale absolute indices.
 *
 * `parentIds` are the parents the event touched. Only the bars we are hiding
 * and the vaults we filled can stale an index; a bookmark saved into some other
 * folder mid-meeting cannot, and must not cost the bar its exact layout.
 * onChanged is deliberately not wired to this at all -- a rename moves nothing.
 */
export const markDirty = (reason, id, parentIds) =>
  serialize(async () => {
    // Inside the chain: the hide that emitted this event has finished, so every
    // id it touched is already recorded.
    if (claimSelfMutation(id)) return { marked: false, self: true };
    if (dirtySuppressed) return { marked: false, suppressed: true };

    const j = await journal.read();
    if (!j || j.state !== journal.State.HIDDEN) {
      dirtySuppressed = true;
      return { marked: false };
    }
    if (Array.isArray(parentIds) && parentIds.length > 0) {
      const relevant = new Set();
      for (const e of j.groups ?? []) {
        relevant.add(e.barId);
        relevant.add(e.vaultId); // vault hide
        relevant.add(e.folderId); // tuck hide -- only one of the two is set
      }
      if (!parentIds.some((p) => p != null && relevant.has(p))) {
        return { marked: false, irrelevant: true };
      }
    }
    if (j.dirty) {
      dirtySuppressed = true;
      return { marked: false };
    }
    j.dirty = true;
    j.dirtyReason = reason;
    await journal.write(j);
    dirtySuppressed = true;
    return { marked: true };
  });

/**
 * Claim an unowned vault as ours and drain it. Explicit because nothing in the
 * tree can distinguish our own pre-reinstall vault from a synced peer's live
 * hide, and getting it wrong empties someone else's vault onto a shared bar.
 */
export const adoptVault = (id) =>
  serialize(async () => {
    const node = (await chrome.bookmarks.get(id).catch(() => []))?.[0] ?? null;
    if (!node) return { ok: false, error: "vault no longer exists" };
    if (node.url || !isVaultTitle(node.title)) {
      return { ok: false, error: "not a Skrim vault" };
    }
    await addOwnedVault(id);

    // The exact path. A receipt turns "these bookmarks are in a folder
    // somewhere" back into the journal that was deleted with the extension, so
    // the ordinary restore runs -- original indices, decoys removed by id,
    // relative-order verification, vault deleted afterwards. Everything that
    // path already guarantees is inherited rather than reimplemented.
    const plan = await planFromReceipt(node);
    if (plan) {
      const live = await journal.read();
      if (!journal.isDisplaced(live)) {
        await journal.write(plan);
        return { exact: true, ...(await restoreImpl({ internal: true })) };
      }
    }
    // No receipt, or a live journal we must not overwrite: fall back to the
    // sweep, which appends to the end of the bar. Order survives, position
    // does not -- which is exactly what a pre-receipt vault can offer.
    return { ok: true, exact: false, ...(await housekeeping()) };
  });

/**
 * Rebuild a journal from a vault's receipt.
 *
 * The ids come first and the ordinals second, because they fail in opposite
 * situations. On the machine that wrote the receipt -- the reinstall case, and
 * the only one worth being exact for -- the ids still name the same nodes, so
 * items the user has since dragged out or deleted simply drop out and the rest
 * land where they started. On a machine that received the folder over sync the
 * ids mean nothing, and position in the vault is the only signal left.
 *
 * Returns null rather than a partial plan whenever the evidence is not good
 * enough, and the caller falls back to appending. A wrong plan is worse than a
 * blunt one: it reorders a bar the user did not ask us to touch.
 */
async function planFromReceipt(vaultNode) {
  const kids = await childrenOrNull(vaultNode.id);
  if (kids === null) return null;
  const rec = kids.map((k) => receipt.decode(k.url)).find(Boolean);
  // Exactness requires the same proof of origin the popup shows the user before
  // asking them. Ids from another machine name other things here, so a receipt
  // that cannot show it was written on this profile buys nothing an append does
  // not, and a plan built from it would reorder a bar on a guess.
  if (!isLocalReceipt(rec, vaultNode)) return null;

  const items = kids.filter((k) => !receipt.isReceipt(k));
  if (items.length === 0) return null;

  // The bar named in the receipt, but only if it is still a bar in THIS
  // profile: an id from another machine could name anything here, including a
  // folder of the user's, and moving their bookmarks into it would be a
  // corruption we performed on purpose.
  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  const group =
    groups.find((g) => g.bar.id === String(rec.bar)) ??
    groups.find((g) => g.other.id === vaultNode.parentId) ??
    groups[0];
  if (!group) return null;

  const byId = new Map(rec.items.map(([itemId, index]) => [String(itemId), index]));
  const planned = items.map((k) => ({
    id: k.id,
    // Anything in the vault the receipt does not name is something the user put
    // there. It gets a home on the bar, but not one we invented for it.
    index: byId.get(String(k.id)) ?? APPEND,
  }));
  // Belt and braces, not load-bearing: restoreImpl clamps with
  // Math.min(index, len) and increments as it goes, which lands each item
  // correctly from any input order. Sorting ascending just makes the replay
  // read the way the bar does, and keeps that true if the clamp ever changes.
  planned.sort((a, b) => a.index - b.index);

  return {
    ...journal.create([
      {
        barId: group.bar.id,
        otherId: group.other.id,
        vaultId: vaultNode.id,
        syncing: group.syncing,
        items: planned,
        // Ids only. The (title, url) pairs in the receipt are for display; the
        // authority to DELETE stays with our own table, so a receipt someone
        // edited cannot name a bookmark of the user's and have it removed.
        decoyIds: (rec.decoys ?? []).map(([decoyId]) => String(decoyId)),
        decoyPhase: false,
        decoyNext: 0,
      },
    ]),
    state: journal.State.RESTORING,
    fromReceipt: true,
  };
}

export const pendingAdoptions = () => serialize(pendingAdoptionsImpl);

export const sweepStrayDecoys = () => serialize(sweepStrayDecoysImpl);

export const lastFailure = async () => {
  const got = await chrome.storage.local.get(LAST_FAILURE_KEY);
  return got[LAST_FAILURE_KEY] ?? null;
};

export const clearLastFailure = () => chrome.storage.local.remove(LAST_FAILURE_KEY);

export const status = () =>
  serialize(async () => {
    const j = await journal.read();
    const { groups, skippedBars } = await getGroups().catch(() => ({
      groups: [],
      skippedBars: 0,
    }));
    const bars = [];
    for (const g of groups) {
      const kids = await childrenOrNull(g.bar.id);
      bars.push({ barId: g.bar.id, syncing: g.syncing, children: kids?.length ?? null });
    }
    return {
      hidden: journal.isDisplaced(j),
      // "vault" or "tuck" while displaced, so the popup can say which. Null at
      // rest. An older journal without the field reads as the vault default.
      mode: journal.isDisplaced(j) ? j.mode ?? "vault" : null,
      state: j?.state ?? journal.State.CLEAR,
      since: j?.startedAt ?? null,
      dirty: j?.dirty ?? false,
      dirtyReason: j?.dirtyReason ?? null,
      itemsDisplaced: j ? j.groups.reduce((n, e) => n + e.items.length, 0) : 0,
      ownedVaults: (await ownedVaults()).length,
      pendingAdoption: await pendingAdoptionsImpl(),
      skippedBars,
      bars,
    };
  });

// ---------------------------------------------------------------------------
// Settings. The engine is the one place that already runs every bookmark
// operation on a single chain, so a setting the popup writes and the engine
// reads a millisecond later on the next hide cannot interleave -- and a setting
// that has to act on the hide already running (see "Live settings" below) is on
// that same chain as everything it edits.

export const getSettings = () => settings.read();

export const setSettings = (patch) =>
  serialize(async () => {
    const saved = await settings.write(patch);
    let live = null;
    try {
      live = await retuneLive(patch, saved);
    } catch (err) {
      // Reported, never thrown. The preference is already stored, and every
      // step of a conversion leaves the bookmarks one restore from home, so the
      // worst case here is a hide that is still whole in one mode or the other
      // -- which must not come back to the popup as a dead toggle.
      live = { error: String(err?.message ?? err) };
    }
    return live ? { ...saved, live } : saved;
  });

// ---------------------------------------------------------------------------
// Tuck hide.
//
// The other way to clear the bar for a screen share, chosen by the tuck toggle:
// instead of moving the bar's items OFF to an Other-Bookmarks vault, park them
// inside a single, ordinarily-named folder that STAYS on the bar. The share
// sees one tidy folder; the names and URLs are one click away but not on screen.
//
// Why offer it at all: sync. A vault hide moves items into Other Bookmarks, and
// Chrome syncs that -- so a second signed-in computer watches its own bar empty
// mid-meeting (M0-FINDINGS §6). A tuck keeps everything on the bar, so that
// second computer keeps its bookmarks; they just sit inside the folder until the
// share ends and the folder is emptied back out. Nothing is ever parked outside
// the bar, so an uninstall while tucked leaves a plainly-named folder the user
// can open by hand -- no vault, no receipt, no recovery page needed.
//
// It rides the same journal state machine as the vault hide (mode: "tuck"), so
// status, the toolbar icon, the watchdog's stuck-hide recovery and share
// idempotency all work unchanged. restore() and recover() branch on that mode.

/** The tuck equivalent of stillHidden: the folder is still on the bar and holds
 *  the items, and nothing movable sits loose beside it. */
async function stillTucked(j) {
  const folderIds = new Set((j.groups ?? []).map((e) => e.folderId).filter(Boolean));
  for (const entry of j.groups ?? []) {
    // The folder we parked into must still be a folder, still on its bar. A null
    // folderId means the hide was interrupted before it was created -- not tucked.
    if (!entry.folderId) return false;
    const node = (await chrome.bookmarks.get(entry.folderId).catch(() => []))?.[0] ?? null;
    if (!node || node.url !== undefined || node.parentId !== entry.barId) return false;
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) return false;
    for (const k of kids) {
      if (!isMutable(k)) continue;
      if (folderIds.has(k.id)) continue; // the tuck folder itself belongs here
      return false; // a real bookmark the user dragged back out is on screen
    }
  }
  return true;
}

/** Anything movable still loose on a bar, other than the tuck folder itself. */
async function findTuckLeaks(entries) {
  const leaks = [];
  for (const entry of entries) {
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) continue;
    for (const k of kids) {
      if (!isMutable(k)) continue;
      if (k.id === entry.folderId) continue;
      leaks.push({ id: k.id, folderId: entry.folderId });
    }
  }
  return leaks;
}

async function tuckHideImpl(name) {
  // Reconcile a stale hide first, exactly as the vault path does. Whatever
  // displaced the bar, restore is mode-aware and puts it back before we re-hide.
  const existing = await journal.read();
  if (journal.isDisplaced(existing)) {
    if (existing.mode === "tuck" && (await stillHidden(existing))) {
      return { ok: true, alreadyHidden: true, moved: 0 };
    }
    const reconciled = await restoreImpl({ internal: true });
    if (!reconciled.ok && !reconciled.gaveUp) {
      return { ok: false, error: "reconcile before hide failed", reconciled };
    }
  }

  const folderTitle = (String(name ?? "").trim().slice(0, 60)) || settings.DEFAULTS.tuckName;

  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  if (groups.length === 0) return { ok: false, error: "no bookmarks bar" };

  // Snapshot each bar's movable children -- links AND folders, because a tidy
  // bar hides all of it -- with their absolute indices, so restore lands them
  // back around any policy-managed siblings that never moved.
  const plan = [];
  for (const g of groups) {
    const kids = (await childrenOf(g.bar.id)).filter(isMutable);
    if (kids.length === 0) continue;
    plan.push({ barId: g.bar.id, syncing: g.syncing, items: kids.map((k) => ({ id: k.id, index: k.index })) });
  }
  if (plan.length === 0) return { ok: true, moved: 0, reason: "nothing to hide" };

  // Write-ahead: the journal records every item BEFORE anything moves, so an
  // interruption is repaired by id. folderId is filled in per group as the
  // folder is created, and each write persists the id of a folder that now
  // exists -- so recovery can always find and empty it.
  const entries = plan.map((p) => ({ barId: p.barId, syncing: p.syncing, folderId: null, items: p.items }));
  const j = journal.create(entries, "tuck");
  // The intended folder name, so a crash between creating a folder and writing
  // its id can still be cleaned up by name on recovery (see tuckRestoreImpl).
  j.folderTitle = folderTitle;
  await journal.write(j);

  let moved = 0;
  const failures = [];
  for (const entry of entries) {
    let folder;
    try {
      folder = await bmCreate({ parentId: entry.barId, title: folderTitle });
    } catch (err) {
      failures.push({ barId: entry.barId, error: String(err?.message ?? err) });
      continue;
    }
    entry.folderId = folder.id;
    await journal.write(j);
    for (const item of entry.items) {
      try {
        await bmMove(item.id, { parentId: folder.id });
        moved++;
      } catch (err) {
        failures.push({ id: item.id, error: String(err?.message ?? err) });
      }
    }
  }

  if (failures.length > 0) {
    await journal.setState(journal.State.RESTORING);
    const rollback = await restoreImpl({ internal: true });
    return { ok: false, error: "partial tuck, rolled back", failures, rollback };
  }

  // Verify: nothing movable may remain loose on any bar except the tuck folder.
  let leaked = await findTuckLeaks(entries);
  if (leaked.length > 0) {
    for (const l of leaked) {
      try { await bmMove(l.id, { parentId: l.folderId }); } catch { /* recheck below */ }
    }
    leaked = await findTuckLeaks(entries);
  }
  if (leaked.length > 0) {
    await journal.setState(journal.State.RESTORING);
    const rollback = await restoreImpl({ internal: true });
    return { ok: false, error: "verification failed, rolled back", leaked, rollback };
  }

  dirtySuppressed = false; // from here a tree change is worth recording
  await journal.setState(journal.State.HIDDEN);
  return { ok: true, moved, folders: entries.length, name: folderTitle };
}

async function tuckRestoreImpl(j, { internal = false } = {}) {
  if (!internal) await journal.setState(journal.State.RESTORING);

  // A tuck hide creates no placeholders, so this is normally nothing at all.
  // It is not nothing after a switch from vault mode that was interrupted
  // between flipping the journal and clearing the bar: the ids are journalled,
  // and this is now the path that has to honour them.
  await clearJournalledDecoys(j);

  let restored = 0;
  const missing = [];
  const stuck = [];

  for (const entry of j.groups) {
    const barKids = await childrenOrNull(entry.barId);
    // Track length locally so every index is in range without re-reading the bar
    // N times. Chrome rejects an out-of-range index; it does not clamp.
    let len = barKids === null ? 0 : barKids.length;
    // A tuck folder sits ON the bar and is meant to be opened, so an item the
    // user dragged back out mid-share is the ordinary case here, not the exotic
    // one. Moving it back is a reorder, which does not lengthen the bar. See
    // the same set in restoreImpl for why counting successes cannot stand in.
    const onBar = new Set((barKids ?? []).map((k) => k.id));
    for (const item of entry.items) {
      // When the tree changed under us, a stale absolute index is worse than
      // useless; appending preserves journalled relative order instead.
      const target = j.dirty ? len : Math.min(item.index, len);
      try {
        await restoreToBar(item.id, entry.barId, target);
        if (!onBar.has(item.id)) {
          onBar.add(item.id);
          len++;
        }
        restored++;
      } catch (err) {
        if (await nodeExists(item.id)) {
          stuck.push({ id: item.id, error: String(err?.message ?? err) });
        } else {
          missing.push({ id: item.id });
        }
      }
    }
  }

  // Verify by RELATIVE order, not absolute position: a bookmark the user added
  // during the share legitimately shifts everything and must not read as
  // corruption. The tuck folder is excluded -- it is deleted below.
  const mismatches = [];
  for (const entry of j.groups) {
    const kids = await childrenOrNull(entry.barId);
    if (kids === null) {
      mismatches.push({ barId: entry.barId, error: "bar unreadable" });
      continue;
    }
    const gone = new Set([...missing, ...stuck].map((m) => m.id));
    const expected = entry.items.map((i) => i.id).filter((id) => !gone.has(id));
    const actual = kids.map((k) => k.id).filter((id) => expected.includes(id));
    for (let i = 0; i < expected.length; i++) {
      if (actual[i] !== expected[i]) {
        mismatches.push({ index: i, expected: expected[i], actual: actual[i] ?? null });
      }
    }
  }

  // Delete each now-empty tuck folder, and sweep any our own crash orphaned.
  await dropTuckFolders(j);

  // A vault left over from a switch INTO tuck mode: the items are back on the
  // bar by now, so all it can still hold is our own receipt. Same rule as the
  // vault path -- only ever delete one we can confirm is empty. Whatever this
  // misses, the orphan sweep in housekeeping below drains, because a converted
  // vault is one we own.
  for (const entry of j.groups) {
    if (!entry.vaultId) continue;
    if (await emptyVault(entry.vaultId)) {
      if (await safeRemoveTree(entry.vaultId)) await dropOwnedVault(entry.vaultId);
    }
  }

  const totalItems = j.groups.reduce((n, e) => n + e.items.length, 0);
  const totalLoss = totalItems > 0 && restored === 0 && missing.length === totalItems;
  const ok = stuck.length === 0 && mismatches.length === 0 && !totalLoss;

  // Whatever the decoy clear at the top could not remove. Used to be hardcoded
  // to none, which was true for as long as a tuck hide could not have any --
  // it can, since a switch out of vault mode can be interrupted with the
  // placeholders still journalled. Read off the journal the clear has already
  // pruned, rather than by re-walking the tree: the ids left in it ARE the ones
  // still on the bar, and they are on the stray list too, which outlives this.
  const decoysStuck = j.groups.flatMap((e) => e.decoyIds ?? []);

  let gaveUp = false;
  if (ok) {
    await journal.clear();
    await chrome.storage.local.remove(LAST_FAILURE_KEY);
  } else {
    j.attempts = (j.attempts ?? 0) + 1;
    if (j.attempts >= MAX_RESTORE_ATTEMPTS) {
      gaveUp = true;
      await chrome.storage.local.set({
        [LAST_FAILURE_KEY]: failureRecord(j, {
          attempts: j.attempts,
          restored,
          missing,
          stuck,
          decoysStuck,
          mismatches: mismatches.length,
        }),
      });
      await journal.clear();
    } else {
      j.state = journal.State.RESTORING;
      j.updatedAt = Date.now();
      await journal.write(j);
    }
  }

  dirtySuppressed = true; // no live hide either way, so nothing to mark
  return {
    ok, gaveUp, attempts: j.attempts ?? 0, restored, missing, stuck,
    decoysStuck: decoysStuck.length, mismatches, ...(await housekeeping()),
  };
}

// ---------------------------------------------------------------------------
// Live settings.
//
// Both switches in the panel used to describe the NEXT hide. That is the wrong
// tense for the moment a user actually reaches for them: the bar is already
// down, the call is already running, and "actually, leave a few placeholders" or
// "actually, use a folder so my other laptop keeps its bookmarks" could only be
// answered by putting the whole bar back on a live screen share and hiding it
// again. So a change made while hidden is applied to the hide that is running.
//
// Three rules make that safe, and they are the same three the hide paths follow:
//
//  * `entry.items` -- the ids, and the bar indices they came from -- is never
//    edited by any of this. Both restore paths move those ids back to the bar
//    from WHEREVER they are, so at every await in a conversion, in either
//    direction, the user's bookmarks are one restore away from home.
//  * The journal is written before the mutation it describes, and `mode` flips
//    only once the container it names exists. Whichever mode a crash leaves
//    behind, that path now cleans up both containers -- see dropTuckFolders and
//    the vault sweep in tuckRestoreImpl.
//  * Nothing is ever staged on the bar. Items go vault -> folder and folder ->
//    vault directly, because the bar is the one place the share can see. A
//    conversion that fails halfway leaves every item in one hiding place or the
//    other, never on screen, which is why none of these paths roll back.

/** The hide a settings change can still edit, or null. */
async function liveHide() {
  const j = await journal.read();
  if (!journal.isDisplaced(j)) return null;
  // HIDING and RESTORING mean the tree is mid-rewrite and the journal is a plan
  // rather than a description of it. Editing that would be editing a moving
  // target; the preference is stored either way and the next hide honours it.
  if (j.state !== journal.State.HIDDEN) return null;
  return j;
}

const decoyCount = (j) =>
  (j.groups ?? []).reduce((n, e) => n + (e.decoyIds ?? []).length, 0);

/**
 * Put the placeholders on the bar, or take them off, mid-hide. Vault mode only:
 * a tuck hide's cover is the folder, and the popup greys the switch to say so.
 *
 * Driven off what the journal says is actually THERE rather than off the
 * previous preference, so it is also the repair for a hide whose placeholders
 * a crash left half-made: switching off and on again rebuilds the set.
 */
async function setDecoysLive(j, want) {
  const had = decoyCount(j);

  if (want) {
    if (had > 0) return { decoys: had, changed: false };
    const entry = j.groups[0];
    if (!entry) return { decoys: 0, changed: false };
    const made = await createDecoys(j, entry);
    await syncReceipt(j, entry, made);
    return { decoys: made.length, changed: made.length > 0 };
  }

  if (had === 0) return { decoys: 0, changed: false };
  // Which entries carried them, before the clear empties the lists: only those
  // receipts are describing something that has just stopped being true.
  const carried = new Set(j.groups.filter((e) => (e.decoyIds ?? []).length > 0));
  await clearJournalledDecoys(j);
  for (const entry of j.groups) if (carried.has(entry)) await syncReceipt(j, entry, []);
  const left = decoyCount(j);
  return { decoys: left, removed: had - left, changed: true };
}

/**
 * Vault hide -> tuck hide, in place.
 *
 * The items go straight from the vault into a folder on the bar. Nothing
 * touches the bar loose, and the moment the mode flips it is the tuck path that
 * owns the cleanup -- including the vault we are emptying, which it now knows
 * how to drop.
 */
async function toTuckLive(j, name) {
  // Only edit a hide that is still true of the tree. Bookmarks already back on
  // the bar are not a hide to convert, they are a hide to repair -- which is
  // restore's job, and the next hide's reconcile.
  if (!(await stillHidden(j))) return { converted: false, reason: "exposed" };

  const folderTitle = String(name ?? "").trim().slice(0, 60) || settings.DEFAULTS.tuckName;

  // The placeholders come off first, while the journal still says "vault" and
  // that path still owns them. In tuck mode the folder IS the cover, and six
  // look-alike links sitting beside it would be the tell the mode avoids.
  await clearJournalledDecoys(j);

  // Write-ahead: the name is journalled before any folder carries it, so a
  // crash between create() and its write is still cleaned up by title.
  j.folderTitle = folderTitle;
  await journal.write(j);

  for (const entry of j.groups) {
    if (entry.folderId) continue; // already there: an interrupted switch, resumed
    let folder;
    try {
      folder = await bmCreate({ parentId: entry.barId, title: folderTitle });
    } catch (err) {
      // Nothing has left the vault yet, so this is still exactly the hide it
      // was a moment ago, minus placeholders the preference no longer wants.
      return { converted: false, error: String(err?.message ?? err) };
    }
    entry.folderId = folder.id;
    await journal.write(j);
  }

  j.mode = "tuck";
  await journal.write(j);

  let moved = 0;
  const stuck = [];
  for (const entry of j.groups) {
    for (const item of entry.items) {
      // Appending, never by index: order inside the folder is the journal's to
      // replay on the way out, and an out-of-range index is the one thing
      // move() rejects outright.
      try {
        await bmMove(item.id, { parentId: entry.folderId });
        moved++;
      } catch {
        if (await nodeExists(item.id)) stuck.push(item.id);
      }
    }
  }

  // The vault has nothing left to hold, and its receipt goes with it: a folder
  // sitting in plain sight on the bar needs no map, which is the other half of
  // why this mode survives an uninstall better than the vault does.
  for (const entry of j.groups) {
    if (!entry.vaultId) continue;
    if (!(await emptyVault(entry.vaultId))) continue;
    if (!(await safeRemoveTree(entry.vaultId))) continue;
    await dropOwnedVault(entry.vaultId);
    entry.vaultId = null;
    entry.receiptId = null;
    await journal.write(j);
  }

  return { converted: true, mode: "tuck", moved, stuck, name: folderTitle };
}

/**
 * Tuck hide -> vault hide, in place. The mirror of the above: a vault in the
 * matching Other Bookmarks, the folder's contents moved into it, the folder
 * taken off the bar, and then the two things a vault hide owes the user -- the
 * placeholders, if they want them, and a receipt that outlives an uninstall.
 */
async function toVaultLive(j, wantDecoys) {
  if (!(await stillTucked(j))) return { converted: false, reason: "exposed" };

  // Every group needs the Other Bookmarks in its OWN storage: routing an
  // account bookmark into a local vault would silently flip its sync status,
  // which is the whole reason roots are grouped. Resolved for all of them
  // before anything moves, so a bar we cannot pair leaves the tuck untouched
  // instead of half-converted.
  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  for (const entry of j.groups) {
    if (entry.vaultId) continue;
    const home = groups.find((g) => g.bar.id === entry.barId);
    if (!home) return { converted: false, error: "no vault home for this bar" };
    entry.otherId = home.other.id;
  }

  for (const entry of j.groups) {
    if (entry.vaultId) continue;
    let vault;
    try {
      vault = await bmCreate({ parentId: entry.otherId, title: VAULT_TITLE });
    } catch (err) {
      return { converted: false, error: String(err?.message ?? err) };
    }
    // Journalled BEFORE it is registered as ours, because those are the two
    // records that can rescue it and the journal is the cheaper one to write.
    // Either alone is enough -- the journal by id, through the restore paths;
    // the registry by ownership, through the orphan sweep -- so this leaves a
    // single call in which a crash could strand an empty folder, rather than
    // three.
    entry.vaultId = vault.id;
    await journal.write(j);
    await addOwnedVault(vault.id);
  }

  j.mode = "vault";
  await journal.write(j);

  let moved = 0;
  const stuck = [];
  for (const entry of j.groups) {
    for (const item of entry.items) {
      try {
        await bmMove(item.id, { parentId: entry.vaultId });
        moved++;
      } catch {
        if (await nodeExists(item.id)) stuck.push(item.id);
      }
    }
  }

  // The folder comes off the bar once it is empty -- and its name comes out of
  // the journal with it, so a later restore's title sweep cannot reach a folder
  // the user has since made under the same name. A folder still holding a stuck
  // item keeps both, and the items in it are journalled either way.
  const removed = await dropTuckFolders(j);
  for (const entry of j.groups) {
    if (entry.folderId && removed.has(entry.folderId)) entry.folderId = null;
  }
  if (j.groups.every((e) => !e.folderId)) delete j.folderTitle;
  await journal.write(j);

  const made = wantDecoys && j.groups[0] ? await createDecoys(j, j.groups[0]) : [];
  for (const entry of j.groups) {
    await syncReceipt(j, entry, entry === j.groups[0] ? made : []);
  }

  return { converted: true, mode: "vault", moved, stuck, decoys: made.length };
}

/** Retitle the live tuck folder, so the name field means something mid-share. */
async function renameTuckFolders(j, name) {
  const title = String(name ?? "").trim().slice(0, 60);
  if (!title || title === j.folderTitle) return { renamed: false };
  let renamed = 0;
  for (const entry of j.groups) {
    if (!entry.folderId) continue;
    if (await bmUpdate(entry.folderId, { title })) renamed++;
  }
  if (renamed === 0) return { renamed: false };
  // After the rename, never before: the title is what the orphan sweep hunts
  // by, and a journal naming a folder that does not exist yet would let it
  // reach a folder of the user's under the old name.
  j.folderTitle = title;
  await journal.write(j);
  return { renamed: true, name: title };
}

/**
 * Apply a just-saved settings change to the hide that is currently running.
 * Returns null when there was nothing live to change, which is the ordinary
 * case: the bar is not hidden, and the preference simply waits for the next one.
 */
async function retuneLive(patch, saved) {
  const j = await liveHide();
  if (!j) return null;
  const mode = j.mode ?? "vault";

  // The mode switch first, and alone. It rebuilds the cover from scratch in the
  // other mechanism, reading the placeholder preference as it has just been
  // saved -- so a single patch that changes both settles in one pass, with no
  // second pass undoing half of it.
  if (typeof patch?.tuckMode === "boolean" && patch.tuckMode !== (mode === "tuck")) {
    const res = patch.tuckMode
      ? await toTuckLive(j, saved.tuckName)
      : await toVaultLive(j, saved.decoys);
    return { switched: patch.tuckMode ? "tuck" : "vault", ...res };
  }

  if (typeof patch?.decoys === "boolean" && mode === "vault") {
    return await setDecoysLive(j, patch.decoys);
  }

  if (typeof patch?.tuckName === "string" && mode === "tuck") {
    return await renameTuckFolders(j, saved.tuckName);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Backup: export the bar to a portable file, and import one back.
//
// The reassurance this exists to give is "you can walk away with your
// bookmarks", so export writes the standard Netscape bookmark file every
// browser reads, and import is strictly additive: everything lands in one new
// folder, so it can never overwrite, reorder or delete a bookmark the user
// already had, and undoing it is deleting that one folder. Both refuse while
// the bar is hidden, where the bar holds decoys and the real items are vaulted.

/** A chrome bookmark node, narrowed to the portable shape (see portable.js). */
function toPortableNode(node) {
  if (node.url === undefined || node.url === null) {
    return {
      title: node.title ?? "",
      dateAdded: node.dateAdded,
      children: (node.children ?? []).map(toPortableNode),
    };
  }
  return { title: node.title ?? "", url: node.url, dateAdded: node.dateAdded };
}

function defaultImportTitle() {
  let date;
  try {
    date = new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    date = new Date().toISOString().slice(0, 10);
  }
  return `Imported bookmarks — ${date}`;
}

async function exportBarImpl(format = "html") {
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  if (groups.length === 0) return { ok: false, error: "no bookmarks bar" };

  const children = [];
  for (const g of groups) {
    const sub = await chrome.bookmarks.getSubTree(g.bar.id).catch(() => []);
    for (const k of sub[0]?.children ?? []) children.push(toPortableNode(k));
  }
  const count = portable.countLinks(children);
  if (format === "text") {
    // `rich` rides along for the clipboard's HTML flavour. Additive: a caller
    // that only knows about `data` is unaffected.
    return {
      ok: true,
      format: "text",
      data: portable.toTextOutline(children),
      rich: portable.toHtmlLinks(children),
      count,
    };
  }
  return {
    ok: true,
    format: "html",
    data: portable.toNetscapeHtml(children, { title: "Bookmarks bar" }),
    count,
  };
}

async function importTreeImpl(nodes, { folderTitle } = {}) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { ok: false, error: "nothing to import" };
  }
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  if (groups.length === 0) return { ok: false, error: "no bookmarks bar" };
  const barId = groups[0].bar.id;
  const title =
    typeof folderTitle === "string" && folderTitle.trim()
      ? folderTitle.trim().slice(0, 80)
      : defaultImportTitle();

  const folder = await bmCreate({ parentId: barId, title });
  let created = 0;
  const build = async (parentId, list) => {
    for (const n of list ?? []) {
      if (!n || typeof n !== "object") continue;
      if (n.url === undefined || n.url === null) {
        const f = await bmCreate({ parentId, title: String(n.title ?? "") });
        await build(f.id, n.children);
      } else if (typeof n.url === "string" && n.url) {
        try {
          await bmCreate({ parentId, title: String(n.title ?? ""), url: n.url });
          created++;
        } catch { /* a single unparseable URL must not sink the whole import */ }
      }
    }
  };
  await build(folder.id, nodes);
  return { ok: true, created, folderId: folder.id, folderTitle: title };
}

export const exportBar = (format) => serialize(() => exportBarImpl(format));
export const importTree = (nodes, opts) => serialize(() => importTreeImpl(nodes, opts));

// ---------------------------------------------------------------------------
// Snapshots.
//
// The backup page's Download button hands the user a file and hopes they keep
// it. These are the copies Skrim keeps for itself: one the moment Skrim is
// installed, one before every hide, one a day, plus whatever the user takes by
// hand. backups.js owns the storage, the dedupe and the retention; this section
// owns the two things that need the bookmark tree -- reading it into a
// snapshot, and putting one back.
//
// Everything here runs on the same serialize() chain as hide and restore, so a
// snapshot can never be taken halfway through a hide, and a restore from a
// snapshot can never interleave with one.

/** A bookmark subtree, narrowed to the portable shape, policy nodes dropped.
 *  A policy-managed bookmark cannot be moved, renamed or deleted, so recording
 *  one would only ever produce a duplicate on the way back. */
function toPortableTree(nodes) {
  const out = [];
  for (const n of nodes ?? []) {
    if (!isMutable(n)) continue;
    out.push(
      n.url === undefined || n.url === null
        ? { title: n.title ?? "", dateAdded: n.dateAdded, children: toPortableTree(n.children) }
        : { title: n.title ?? "", url: n.url, dateAdded: n.dateAdded },
    );
  }
  return out;
}

/**
 * Every bar the profile has, kept APART by storage rather than merged.
 *
 * Chrome's split local/account storage can surface two bars and renders them as
 * one strip. A snapshot that merged them would, on the way back, move account
 * bookmarks into local storage and silently change their sync status -- the
 * exact failure roots.js exists to prevent for hiding. So the snapshot carries
 * the `syncing` flag with each set, and the restore pairs them up again.
 */
async function readBarGroups() {
  const { groups, skippedBars } = await getGroups();
  const out = [];
  for (const g of groups) {
    const sub = await chrome.bookmarks.getSubTree(g.bar.id).catch(() => null);
    if (!sub) continue;
    out.push({
      syncing: g.syncing ?? null,
      barId: g.bar.id,
      children: toPortableTree(sub[0]?.children ?? []),
    });
  }
  return { groups: out, skippedBars };
}

async function snapshotBarImpl(kind, { label = "", force = false, at = Date.now() } = {}) {
  // A hidden bar holds decoys, and the real items are in a vault. Snapshotting
  // then would save the cover story as if it were the bookmarks.
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  let read;
  try {
    read = await readBarGroups();
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  if (read.groups.length === 0) return { ok: false, error: "no bookmarks bar" };
  // `barId` is this profile's, right now; it means nothing to a restore days
  // later and is not worth storing.
  const stored = read.groups.map((g) => ({ syncing: g.syncing, children: g.children }));
  return backups.put(stored, kind, { label, force, at });
}

/**
 * The automatic path. Returns a result, never throws, and never runs when the
 * user has switched automatic backups off. Its caller is a hide.
 */
async function autoSnapshot(kind, opts) {
  try {
    const { autoBackup } = await settings.read();
    if (!autoBackup) return { ok: false, off: true };
    return await snapshotBarImpl(kind, opts);
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** How long between automatic daily snapshots. */
const DAILY_MS = 24 * 60 * 60 * 1000;

/**
 * The once-a-day snapshot, called from the watchdog -- which fires every
 * minute, so the cheap guard comes first: a stored timestamp, not a tree read.
 * Only when a day has actually passed does this touch chrome.bookmarks, and the
 * timestamp is advanced even when the result was a duplicate, so an unchanged
 * bar costs one read a day rather than one a minute.
 */
async function maybeDailyBackupImpl(now = Date.now()) {
  try {
    const { autoBackup } = await settings.read();
    if (!autoBackup) return { ok: false, off: true };
    if (journal.isDisplaced(await journal.read())) return { ok: false, hidden: true };
    const m = await backups.meta();
    const last = typeof m.lastAutoAt === "number" ? m.lastAutoAt : 0;
    // A clock that jumped backwards (timezone change, NTP correction) must not
    // park the next daily snapshot days into the future.
    if (last <= now && now - last < DAILY_MS) return { ok: false, tooSoon: true };
    const res = await snapshotBarImpl(backups.Kind.DAILY, { at: now });
    if (res.ok || res.hidden !== true) await backups.setMeta({ lastAutoAt: now });
    return res;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * How long after an install the original copy is still worth taking.
 *
 * A fresh install takes it within a second of the event, so this window is only
 * ever spent by the install that CANNOT: a reinstall over bookmarks still
 * parked in a vault, where the bar on screen is the cover story rather than the
 * user's. That clears as soon as they go through recovery, which might be a
 * minute later or might be next weekend -- but a bar first seen a month after
 * the install is nobody's "original", so the want expires rather than sitting
 * there forever waiting to mislabel one.
 */
const ORIGINAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Note that this profile is owed its original copy. Called on install only. */
async function wantOriginalBackupImpl(at = Date.now()) {
  await backups.setMeta({ originalWantedAt: at });
  return { ok: true, at };
}

/**
 * The bar as it was before Skrim had touched it: taken once, at install, and
 * then held out of retention's reach for as long as the extension is installed.
 *
 * It is the copy that matters most and the one an ordinary quota would lose
 * first. Fifteen automatic snapshots is a fortnight of meetings, after which
 * every copy Skrim holds is of a bar Skrim has already been moving around --
 * and if the thing that went wrong was Skrim, every one of them has the fault
 * baked in. This one predates all of that.
 *
 * Called from the install event and again from the watchdog, because the
 * install that most needs this copy is the one that cannot take it: a reinstall
 * over a bar whose bookmarks are still in a vault from before. There what is on
 * the bar is decoys, saving it would record the cover story as the bookmarks,
 * and the real bar does not exist again until recovery has run. So the want is
 * stored and retried rather than dropped on the floor.
 *
 * Forced past the dedupe deliberately. A retry can land on a bar byte-identical
 * to one an earlier daily copy already holds, and folding into that entry would
 * leave the profile with no snapshot of kind `original` at all -- which is to
 * say, with nothing in the permanent slot this whole path exists to fill.
 */
async function maybeOriginalBackupImpl(now = Date.now()) {
  try {
    // The cheap guard first, the same way the daily one does it: on every
    // profile but the handful still owed a copy, this is one storage read and
    // out, and the watchdog asks once a minute forever.
    const m = await backups.meta();
    const wanted = typeof m.originalWantedAt === "number" ? m.originalWantedAt : 0;
    if (wanted <= 0) return { ok: false, notWanted: true };
    // A clock that jumped FORWARD must not expire the want on a profile that
    // installed minutes ago; one that jumped backwards leaves this negative,
    // which is simply "not expired yet" and retries, as it should.
    if (now - wanted > ORIGINAL_WINDOW_MS) {
      await backups.setMeta({ originalWantedAt: 0 });
      return { ok: false, expired: true };
    }
    const { autoBackup } = await settings.read();
    if (!autoBackup) return { ok: false, off: true };
    if (journal.isDisplaced(await journal.read())) return { ok: false, hidden: true };
    // Bookmarks parked in a vault nobody has adopted: whatever is on the bar
    // right now, it is not what this profile's bar looks like. Wait for the
    // recovery page rather than immortalise the wrong tree.
    const stranded = await pendingAdoptionsImpl().catch(() => []);
    if (stranded.length > 0) return { ok: false, stranded: true };

    const res = await snapshotBarImpl(backups.Kind.ORIGINAL, { at: now, force: true });
    if (res.ok) await backups.setMeta({ originalWantedAt: 0 });
    return res;
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// Restoring a snapshot, by diff.
//
// The obvious build -- delete the bar and make it again from the snapshot --
// is wrong in two ways that matter. It fires a delete and a create for every
// bookmark, which every other signed-in computer then has to swallow; and
// chrome.bookmarks.create cannot set dateAdded, so it silently resets the age of
// the user's entire bar.
//
// So this MOVES. It indexes everything already under the bar, matches each item
// in the snapshot to the real bookmark that is still there -- wherever it has
// drifted to -- and relocates it. An item that is already in the right place is
// not touched at all. Only what is genuinely missing is created, and only what
// is genuinely surplus is deleted. Recovering from the 2026-08-21 index bug is
// eleven moves and no deletions.
//
// Two invariants make it safe rather than merely clever:
//
//  1. A node is only ever moved into a parent that is ALREADY FINAL. Placement
//     starts at the bar and descends, so every node in that parent's ancestor
//     chain has already been matched, and the node now being placed has not --
//     therefore it cannot be one of its own future ancestors. A folder can never
//     be moved into itself, by construction rather than by a check. (Placement
//     within a folder is breadth first, children after all siblings, which is a
//     readability choice rather than the safety one: it keeps a folder's whole
//     index arithmetic in a single loop.)
//  2. Within one parent, items are placed left to right, so a same-parent move
//     is always BACKWARDS -- to an index lower than the node currently sits at.
//     chrome.bookmarks.move()'s index handling for a same-parent move is a known
//     ambiguity (see mock-chrome.mjs); both readings of it agree on a backwards
//     move, so this never has to know which Chrome it is talking to.
//
// Deletion happens once, at the very end, after everything has been placed.
// Doing it as we went would destroy a folder whose contents a later part of the
// snapshot still needed to match against.

const MAX_TREE_DEPTH = 50;

/**
 * Everything mutable under a bar, flat, plus each folder's child order.
 *
 * `nodes` deliberately omits policy-managed bookmarks so nothing can ever match
 * one, move one, or delete one. `childIds` deliberately includes them, because
 * they still occupy a slot and the index arithmetic has to know.
 */
async function indexBar(barId) {
  const sub = await chrome.bookmarks.getSubTree(barId).catch(() => null);
  const nodes = new Map();
  const childIds = new Map();
  const byKey = new Map();
  let order = 0;

  const walk = (kids, parentId, depth) => {
    const ids = [];
    for (const k of kids ?? []) {
      ids.push(k.id);
      if (!isMutable(k)) continue;
      const folder = k.url === undefined || k.url === null;
      const rec = {
        id: k.id,
        parentId,
        title: k.title ?? "",
        url: folder ? undefined : k.url,
        folder,
        order: order++,
      };
      nodes.set(k.id, rec);
      const key = folder ? `F:${rec.title}` : `L:${rec.url}`;
      const bucket = byKey.get(key);
      if (bucket) bucket.push(rec);
      else byKey.set(key, [rec]);
      if (folder && depth < MAX_TREE_DEPTH) walk(k.children, k.id, depth + 1);
      else if (folder) childIds.set(k.id, []);
    }
    childIds.set(parentId, ids);
  };
  walk(sub?.[0]?.children ?? [], barId, 0);
  return { nodes, childIds, byKey };
}

/**
 * The real bookmark that a snapshot entry refers to, or null to create one.
 *
 * Links are keyed by URL and folders by title -- the two things that actually
 * identify a bookmark to a person. Among equal candidates, one still sitting in
 * the folder we are filling wins over one that has drifted, and for a link an
 * exact title match breaks the remaining tie. So a bar with three copies of the
 * same URL in three folders keeps all three where they belong instead of
 * shuffling them.
 */
function matchNode(want, isFolder, parentId, ctx) {
  const key = isFolder ? `F:${want.title ?? ""}` : `L:${want.url}`;
  const cands = ctx.byKey.get(key);
  if (!cands) return null;
  let best = null;
  let bestScore = -1;
  for (const rec of cands) {
    if (ctx.used.has(rec.id)) continue;
    if (rec.folder !== isFolder) continue;
    // Defensive only -- invariant 1 above makes this unreachable. If it ever
    // fires, creating a fresh node is strictly better than throwing.
    if (isFolder && isAncestorOf(rec.id, parentId, ctx)) continue;
    let score = rec.parentId === parentId ? 2 : 0;
    if (!isFolder && rec.title === (want.title ?? "")) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = rec;
      if (score === 3 || (isFolder && score === 2)) break;
    }
  }
  return best;
}

function isAncestorOf(ancestorId, nodeId, ctx) {
  let p = nodeId;
  for (let i = 0; i < MAX_TREE_DEPTH + 2 && p; i++) {
    if (p === ancestorId) return true;
    p = ctx.nodes.get(p)?.parentId;
  }
  return false;
}

/** Move a node in our model of the tree. Mirrors what Chrome just did. */
function placeInModel(rec, parentId, index, ctx) {
  const from = ctx.childIds.get(rec.parentId);
  if (from) {
    const i = from.indexOf(rec.id);
    if (i >= 0) from.splice(i, 1);
  }
  const to = ctx.childIds.get(parentId) ?? [];
  to.splice(Math.max(0, Math.min(index, to.length)), 0, rec.id);
  ctx.childIds.set(parentId, to);
  rec.parentId = parentId;
}

function subtreeCount(id, ctx) {
  let links = 0;
  let folders = 0;
  const walk = (nid, depth) => {
    const rec = ctx.nodes.get(nid);
    if (!rec || depth > MAX_TREE_DEPTH) return;
    if (!rec.folder) {
      links++;
      return;
    }
    folders++;
    for (const c of [...(ctx.childIds.get(nid) ?? [])]) walk(c, depth + 1);
  };
  walk(id, 0);
  return { links, folders };
}

function forgetSubtree(id, ctx) {
  const rec = ctx.nodes.get(id);
  if (!rec) return;
  const sib = ctx.childIds.get(rec.parentId);
  if (sib) {
    const i = sib.indexOf(id);
    if (i >= 0) sib.splice(i, 1);
  }
  const kill = (nid, depth) => {
    if (depth > MAX_TREE_DEPTH) return;
    for (const c of [...(ctx.childIds.get(nid) ?? [])]) kill(c, depth + 1);
    ctx.childIds.delete(nid);
    ctx.nodes.delete(nid);
  };
  kill(id, 0);
}

/**
 * Make one folder's children match `want`, then recurse into the folders it
 * placed. Breadth before depth -- see invariant 1.
 */
async function reconcileFolder(parentId, want, ctx, depth = 0) {
  if (depth > MAX_TREE_DEPTH) return;
  const s = ctx.stats;
  const descend = [];

  for (let k = 0; k < (want?.length ?? 0); k++) {
    const w = want[k];
    if (!w || typeof w !== "object") continue;
    const isFolder = w.url === undefined || w.url === null;
    if (!isFolder && (typeof w.url !== "string" || !w.url)) continue;
    const title = String(w.title ?? "");

    let rec = matchNode(w, isFolder, parentId, ctx);

    if (rec) {
      ctx.used.add(rec.id);
      const cur = ctx.childIds.get(parentId) ?? [];
      const at = rec.parentId === parentId ? cur.indexOf(rec.id) : -1;
      if (at === k) {
        s.kept++;
      } else {
        // Same parent: `at` is strictly greater than k, because 0..k-1 already
        // hold the snapshot's first k items. A backwards move, which both
        // readings of chrome.bookmarks.move agree on.
        const ok = await runMove(rec, parentId, k, ctx);
        if (ok) s.moved++;
        else s.failed++;
      }
      if (rec.title !== title) {
        if (!ctx.dry) await bmUpdate(rec.id, { title });
        rec.title = title;
        s.renamed++;
      } else if (!isFolder && rec.url !== w.url) {
        if (!ctx.dry) await bmUpdate(rec.id, { url: w.url });
        rec.url = w.url;
        s.renamed++;
      }
    } else {
      rec = await runCreate(w, isFolder, title, parentId, k, ctx);
      if (!rec) {
        s.failed++;
        continue;
      }
      s.created++;
    }

    if (isFolder) descend.push([rec.id, w.children]);
  }

  for (const [id, kids] of descend) await reconcileFolder(id, kids, ctx, depth + 1);
}

/**
 * The index is a request, never a requirement -- chrome.bookmarks.move rejects
 * an out-of-range index rather than clamping it, so a wrong one must cost at
 * worst a position, never the bookmark. Same reasoning as restoreToBar.
 */
async function runMove(rec, parentId, index, ctx) {
  if (ctx.dry) {
    placeInModel(rec, parentId, index, ctx);
    return true;
  }
  try {
    await bmMove(rec.id, { parentId, index });
    placeInModel(rec, parentId, index, ctx);
    return true;
  } catch {
    try {
      await bmMove(rec.id, { parentId });
      // Appended, not placed. The model records where it ACTUALLY went, so
      // every index computed after this one stays true to the tree.
      placeInModel(rec, parentId, (ctx.childIds.get(parentId) ?? []).length, ctx);
    } catch {
      return false;
    }
    return false;
  }
}

async function runCreate(w, isFolder, title, parentId, index, ctx) {
  const rec = {
    id: null,
    parentId,
    title,
    url: isFolder ? undefined : w.url,
    folder: isFolder,
    order: 1e9 + ctx.newSeq,
  };
  if (ctx.dry) {
    rec.id = `#new${ctx.newSeq++}`;
  } else {
    try {
      const props = { parentId, index, title };
      if (!isFolder) props.url = w.url;
      const node = await bmCreate(props);
      rec.id = node.id;
    } catch {
      try {
        const props = { parentId, title };
        if (!isFolder) props.url = w.url;
        const node = await bmCreate(props);
        rec.id = node.id;
        ctx.nodes.set(rec.id, rec);
        ctx.used.add(rec.id);
        if (isFolder) ctx.childIds.set(rec.id, []);
        placeInModel(rec, parentId, (ctx.childIds.get(parentId) ?? []).length, ctx);
        return rec;
      } catch {
        return null;
      }
    }
  }
  ctx.nodes.set(rec.id, rec);
  ctx.used.add(rec.id);
  if (isFolder) ctx.childIds.set(rec.id, []);
  const to = ctx.childIds.get(parentId) ?? [];
  to.splice(Math.max(0, Math.min(index, to.length)), 0, rec.id);
  ctx.childIds.set(parentId, to);
  return rec;
}

/**
 * Delete what the snapshot does not account for -- once, after every placement
 * is done, so nothing is destroyed that a later match still needed.
 *
 * A node absent from `nodes` is policy-managed: never removed, never descended
 * into, left exactly where it is.
 */
async function sweepUnplaced(parentId, ctx, depth = 0) {
  if (depth > MAX_TREE_DEPTH) return;
  for (const id of [...(ctx.childIds.get(parentId) ?? [])]) {
    const rec = ctx.nodes.get(id);
    if (!rec) continue;
    if (ctx.used.has(id)) {
      if (rec.folder) await sweepUnplaced(id, ctx, depth + 1);
      continue;
    }
    const n = subtreeCount(id, ctx);
    if (!ctx.dry && !(await safeRemoveTree(id))) {
      ctx.stats.failed++;
      continue;
    }
    ctx.stats.removed += n.links;
    ctx.stats.removedFolders += n.folders;
    forgetSubtree(id, ctx);
  }
}

/**
 * Pair each set of bookmarks in the snapshot with the bar it came from.
 *
 * Matched on the `syncing` flag, so account bookmarks are never restored into
 * local storage. The one exception is the ordinary case of a user who signed in
 * or out since the snapshot was taken: one bar then, one bar now, and the flag
 * is the only thing that changed. Refusing there would strand the backup for
 * the most common profile there is.
 */
function pairGroups(snapGroups, liveGroups) {
  const pairs = [];
  const usedLive = new Set();
  const usedSnap = new Set();
  for (let i = 0; i < snapGroups.length; i++) {
    for (let j = 0; j < liveGroups.length; j++) {
      if (usedLive.has(j)) continue;
      if ((snapGroups[i].syncing ?? null) === (liveGroups[j].syncing ?? null)) {
        pairs.push([i, j]);
        usedLive.add(j);
        usedSnap.add(i);
        break;
      }
    }
  }
  if (pairs.length === 0 && snapGroups.length === 1 && liveGroups.length === 1) {
    pairs.push([0, 0]);
    usedSnap.add(0);
    usedLive.add(0);
  }
  return {
    pairs,
    // Bars we hold no snapshot for are LEFT ALONE. Emptying one because this
    // backup has nothing to say about it would be the worst bug in the file.
    skippedBars: liveGroups.length - pairs.length,
    skippedSets: snapGroups.length - pairs.length,
  };
}

function newStats() {
  return { moved: 0, created: 0, removed: 0, removedFolders: 0, renamed: 0, kept: 0, failed: 0 };
}

/**
 * Put the bar back the way a snapshot remembers it.
 *
 * `dry` computes exactly the same plan against the same model without touching
 * a single bookmark, which is what the page's confirm dialog is built from --
 * the numbers the user agrees to are the numbers this produced, not an estimate
 * of them.
 */
async function restoreBackupImpl(id, { mode = "diff", dry = false, folderTitle } = {}) {
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "bar is hidden" };
  }
  const snap = await backups.get(id);
  if (!snap) return { ok: false, error: "that backup is missing or damaged" };
  if (!Array.isArray(snap.groups) || snap.groups.length === 0) {
    return { ok: false, error: "that backup is empty or damaged" };
  }

  if (mode === "folder") {
    const nodes = backups.flatten(snap.groups);
    if (nodes.length === 0) return { ok: false, error: "that backup holds nothing to add" };
    if (dry) {
      return {
        ok: true,
        dry: true,
        mode: "folder",
        stats: { ...newStats(), created: backups.countLinks(snap.groups) },
      };
    }
    const res = await importTreeImpl(nodes, {
      folderTitle: folderTitle ?? backupFolderTitle(snap),
    });
    return res.ok ? { ...res, mode: "folder", backupId: id } : res;
  }

  let live;
  try {
    live = await getGroups();
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
  const paired = pairGroups(snap.groups, live.groups);
  if (paired.pairs.length === 0) {
    return { ok: false, error: "this backup does not match any bookmarks bar on this profile" };
  }

  // Before a single bookmark moves. Forced past the duplicate check on purpose:
  // a safety copy is a promise, and "we did not take one because it looked the
  // same as an older one" is not a sentence this should ever have to say.
  let safetyId = null;
  if (!dry) {
    const safety = await snapshotBarImpl(backups.Kind.SAFETY, {
      label: "before restoring a backup",
      force: true,
    });
    if (!safety.ok) {
      return {
        ok: false,
        error: `could not take a safety copy first (${safety.error ?? "unknown"}), so nothing was changed`,
      };
    }
    safetyId = safety.id;
  }

  const stats = newStats();
  for (const [si, li] of paired.pairs) {
    const barId = live.groups[li].bar.id;
    const idx = await indexBar(barId);
    const ctx = { ...idx, used: new Set(), stats, dry, newSeq: 1 };
    await reconcileFolder(barId, snap.groups[si].children, ctx, 0);
    await sweepUnplaced(barId, ctx, 0);
  }

  return {
    ok: true,
    dry,
    mode: "diff",
    backupId: id,
    safetyId,
    stats,
    skippedBars: paired.skippedBars + (live.skippedBars ?? 0),
    skippedSets: paired.skippedSets,
  };
}

function backupFolderTitle(snap) {
  if (snap?.label) return `Backup — ${snap.label}`.slice(0, 80);
  let when;
  try {
    when = new Date(snap?.at ?? Date.now()).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    when = new Date(snap?.at ?? Date.now()).toISOString().slice(0, 16).replace("T", " ");
  }
  return `Backup — ${when}`.slice(0, 80);
}

/** One snapshot as the standard bookmark file, for the Download button. */
async function backupFileImpl(id) {
  const snap = await backups.get(id);
  if (!snap) return { ok: false, error: "that backup is missing or damaged" };
  const children = backups.flatten(snap.groups);
  return {
    ok: true,
    id,
    at: snap.at,
    kind: snap.kind,
    label: snap.label ?? "",
    count: backups.countLinks(snap.groups),
    name: backups.fileNameFor({ at: snap.at, kind: snap.kind, label: snap.label }),
    data: portable.toNetscapeHtml(children, { title: "Bookmarks bar" }),
  };
}

// --- public surface ---------------------------------------------------------

export const snapshotBar = (kind, opts) =>
  serialize(() => snapshotBarImpl(kind ?? backups.Kind.MANUAL, opts));
export const maybeDailyBackup = (now) => serialize(() => maybeDailyBackupImpl(now));
export const wantOriginalBackup = (at) => serialize(() => wantOriginalBackupImpl(at));
export const maybeOriginalBackup = (now) => serialize(() => maybeOriginalBackupImpl(now));
export const restoreBackup = (id, opts) => serialize(() => restoreBackupImpl(id, opts));
export const backupFile = (id) => serialize(() => backupFileImpl(id));
export const deleteBackup = (id) => serialize(() => backups.remove(id));
export const renameBackup = (id, label) => serialize(() => backups.rename(id, label));
export const clearBackups = () => serialize(() => backups.clear());

/** The list, plus what the page needs to render it without a second round trip. */
export const listBackups = () =>
  serialize(async () => {
    const [entries, use, saved, j] = await Promise.all([
      backups.list(),
      backups.usage(),
      settings.read(),
      journal.read(),
    ]);
    return {
      ok: true,
      entries,
      usage: use,
      autoBackup: saved.autoBackup !== false,
      hidden: journal.isDisplaced(j),
      labels: backups.LABELS,
    };
  });
