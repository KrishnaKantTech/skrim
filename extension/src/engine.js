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
// The folders the tuck feature parks bar items in, one id per bar group. State,
// not a preference: it names live bookmark folders, so it lives here with the
// engine's other bookkeeping rather than in settings, where a reset could
// strand them.
const TUCK_KEY = "secureshare.tuck";

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
          await bmMove(k.id, { parentId: group.bar.id, index: Math.min(at(k), len) });
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

  // Decoys. `decoyNext` is the loop INDEX, journalled after each iteration --
  // NOT a count of successes. They diverge the moment one create throws, and a
  // count then points the crash sweep at the wrong decoy spec, stranding a fake
  // bookmark on the bar forever. With the index, a crash between create()
  // returning and the write leaves decoyNext pointing at exactly the decoy that
  // was created but never journalled, whatever failed before it.
  // Kept out of the journal: only the receipt needs the (title, url) of each
  // decoy that actually got created, and pairing them by position in decoyIds
  // would be wrong the moment one create throws and the two lists shear.
  const decoysMade = new Map(); // entry -> [{ id, title, url }]

  // The caller can force decoys on or off (the developer buttons, the tests,
  // the rollback paths that never want them); when it does not say, the user's
  // setting decides. Read here rather than at the top so the early-return paths
  // -- nothing to hide, already hidden, a rolled-back partial -- add no storage
  // call and keep the fault-injection call numbering they were written against.
  const wantDecoys = decoys ?? (await settings.read()).decoys;

  if (wantDecoys) {
    const entry = entries[0]; // one set is enough; the bar renders storages merged
    entry.decoyPhase = true;
    await journal.write(j);
    const made = [];
    decoysMade.set(entry, made);
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
  }

  // The receipt. Written LAST, deliberately: by here the bar is already clear,
  // so the one thing on the critical path of a starting screen share -- the
  // moves -- has already happened, and the receipt can therefore also name the
  // decoys, which do not exist any earlier. A crash in the window before it is
  // written costs nothing that matters: the journal covers every failure the
  // extension is still installed for, and the receipt only ever has to answer
  // the one it is not.
  for (const entry of entries) {
    const made = decoysMade.get(entry) ?? [];
    try {
      const node = await bmCreate({
        parentId: entry.vaultId,
        index: 0,
        title: receipt.buildTitle({ items: entry.items.length, decoys: made }),
        url: receipt.buildUrl(
          receipt.buildPayload({
            barId: entry.barId,
            otherId: entry.otherId,
            vaultId: entry.vaultId,
            items: entry.items,
            decoys: made,
          })
        ),
      });
      entry.receiptId = node.id;
      await journal.write(j);
    } catch { /* a recovery aid must never be the reason a hide fails */ }
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

async function restoreImpl({ internal = false } = {}) {
  const j = await journal.read();
  if (!journal.isDisplaced(j)) {
    dirtySuppressed = true;
    return { ok: true, alreadyRestored: true, ...(await housekeeping()) };
  }

  if (!internal) await journal.setState(journal.State.RESTORING);

  // Decoys first, so real items land on a bar that is as close to empty as
  // possible. Identity is re-verified: an id remapped by sync must never take
  // a real bookmark with it.
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

  let restored = 0;
  const missing = [];
  const stuck = [];

  for (const entry of j.groups) {
    const barKids = await childrenOrNull(entry.barId);
    // Track length locally so every index is in range without re-reading the
    // bar N times. Chrome rejects out-of-range indices; it does not clamp.
    let len = barKids === null ? 0 : barKids.length;

    for (const item of entry.items) {
      // When the tree changed under us, stale absolute indices are worse than
      // useless; appending at least preserves journalled relative order.
      const target = j.dirty ? len : Math.min(item.index, len);
      try {
        await bmMove(item.id, { parentId: entry.barId, index: target });
        len++;
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
    if (await emptyVault(entry.vaultId)) {
      if (await safeRemoveTree(entry.vaultId)) await dropOwnedVault(entry.vaultId);
    }
  }

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
        [LAST_FAILURE_KEY]: {
          at: Date.now(),
          attempts: j.attempts,
          restored,
          missing: missing.map((m) => m.id),
          stuck: stuck.map((m) => m.id),
          decoysStuck: hk.strays.remaining,
          mismatches: mismatches.length,
        },
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
        relevant.add(e.vaultId);
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
// Settings passthrough. The engine is the one place that already runs every
// bookmark operation on a single chain, so a setting the popup writes and the
// engine reads a millisecond later on the next hide cannot interleave.

export const getSettings = () => settings.read();
export const setSettings = (patch) => settings.write(patch);

// ---------------------------------------------------------------------------
// Tuck.
//
// A second, standing way to keep the bar clear, unrelated to screen sharing:
// park everything on the bar inside a single folder that stays there. The
// folder is left with an ordinary, forgettable name (the user's, defaulting to
// a generic one), so the bar reads as tidy rather than as hidden. Untuck puts
// every item back where the folder sat.
//
// It composes with hide for free: the tuck folder is an ordinary bar child, so
// a share that starts while tucked moves the folder into the vault with
// everything else and restore brings it back. Both refuse to run while the bar
// is hidden -- the real items are in the vault then, and the id list would
// describe a bar that is not currently the one on screen.

async function readTuck() {
  const got = await chrome.storage.local.get(TUCK_KEY);
  const t = got[TUCK_KEY];
  return Array.isArray(t?.folders) ? t.folders.map(String) : [];
}

async function writeTuck(folders) {
  const clean = [...new Set((folders ?? []).map(String))];
  if (clean.length === 0) await chrome.storage.local.remove(TUCK_KEY);
  else await chrome.storage.local.set({ [TUCK_KEY]: { folders: clean } });
}

/** Which recorded folders still exist as folders, pruning the record if not. */
async function tuckStatusImpl() {
  const recorded = await readTuck();
  const live = [];
  for (const id of recorded) {
    const node = (await chrome.bookmarks.get(id).catch(() => []))?.[0] ?? null;
    if (node && node.url === undefined) live.push(id);
  }
  if (live.length !== recorded.length) await writeTuck(live);
  const { tuckName } = await settings.read();
  return { tucked: live.length > 0, folders: live.length, name: tuckName };
}

async function tuckImpl({ name } = {}) {
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "cannot tuck while the bar is hidden" };
  }
  // Remember the name so the panel pre-fills it and the next tuck reuses it.
  const saved =
    typeof name === "string" && name.trim()
      ? await settings.write({ tuckName: name })
      : await settings.read();
  const folderTitle = saved.tuckName;

  const { groups } = await getGroups().catch(() => ({ groups: [] }));
  if (groups.length === 0) return { ok: false, error: "no bookmarks bar" };

  const recorded = new Set(await readTuck());
  const isTuckFolder = (k) => k.url === undefined && recorded.has(k.id);
  const folders = [];
  let moved = 0;

  for (const g of groups) {
    const barKids = await childrenOrNull(g.bar.id);
    if (barKids === null) continue;
    // Reuse this bar's existing tuck folder if it already has one, so tucking
    // again just sweeps in anything added since rather than nesting folders.
    let folderId = barKids.find(isTuckFolder)?.id ?? null;
    // Everything movable on the bar that is not itself a tuck folder -- links
    // and folders alike, because a tidy bar means all of it goes in.
    const loose = barKids.filter((k) => isMutable(k) && !isTuckFolder(k));
    if (loose.length === 0) {
      if (folderId) folders.push(folderId);
      continue;
    }
    if (!folderId) {
      const created = await bmCreate({ parentId: g.bar.id, title: folderTitle });
      folderId = created.id;
    }
    for (const k of loose) {
      try {
        await bmMove(k.id, { parentId: folderId });
        moved++;
      } catch { /* one stuck item must not block the rest */ }
    }
    folders.push(folderId);
  }

  // Keep any recorded folder we did not revisit this pass but that still exists,
  // so untuck never loses track of one.
  for (const id of recorded) {
    if (!folders.includes(id) && (await nodeExists(id))) folders.push(id);
  }
  await writeTuck(folders);
  return { ok: true, tucked: folders.length > 0, folders: folders.length, moved, name: folderTitle };
}

async function untuckImpl() {
  if (journal.isDisplaced(await journal.read())) {
    return { ok: false, hidden: true, error: "cannot untuck while the bar is hidden" };
  }
  const recorded = await readTuck();
  let restored = 0;
  const kept = [];

  for (const id of recorded) {
    const node = (await chrome.bookmarks.get(id).catch(() => []))?.[0] ?? null;
    if (!node) continue; // already gone
    if (node.url !== undefined) continue; // no longer a folder -- leave it alone
    const barId = node.parentId;
    const kids = await childrenOrNull(id);
    if (kids === null) {
      kept.push(id); // unreadable this pass -- keep the record, retry later
      continue;
    }
    const barKids = await childrenOrNull(barId);
    let len = barKids === null ? 0 : barKids.length;
    // Land the items where the folder sat, in the order they were inside it.
    let at = typeof node.index === "number" ? node.index : len;
    for (const k of kids) {
      try {
        await bmMove(k.id, { parentId: barId, index: Math.min(at, len) });
        at++;
        len++;
        restored++;
      } catch { /* keep going; a stuck item just leaves the folder non-empty */ }
    }
    const left = await childrenOrNull(id);
    if (left !== null && left.length === 0) {
      if (!(await safeRemoveTree(id))) kept.push(id);
    } else {
      kept.push(id); // something would not move -- keep the folder and the record
    }
  }
  await writeTuck(kept);
  return { ok: kept.length === 0, untucked: true, restored, folders: kept.length };
}

export const tuck = (opts) => serialize(() => tuckImpl(opts));
export const untuck = () => serialize(untuckImpl);
export const tuckStatus = () => serialize(tuckStatusImpl);

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
  const data =
    format === "text"
      ? portable.toTextOutline(children)
      : portable.toNetscapeHtml(children, { title: "Bookmarks bar" });
  return { ok: true, format: format === "text" ? "text" : "html", data, count };
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
