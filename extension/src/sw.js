// Service worker.
//
// MV3 terminates this worker after ~30s idle, so: every listener is registered
// synchronously at top level (a listener added after an await is missed on cold
// start), and no state lives in module scope -- it is all in the journal.

import * as engine from "./engine.js";
import * as journal from "./journal.js";
import * as sessions from "./sessions.js";
import * as receipt from "./receipt.js";
import * as recorders from "./recorders.js";

const WATCHDOG_ALARM = "secureshare.watchdog";
const WATCHDOG_PERIOD_MIN = 1;

// A hide that has not reached HIDDEN within this long was interrupted.
const STUCK_MS = 60_000;
// Nothing legitimately stays hidden this long; restore rather than strand it.
const MAX_HIDDEN_MS = 4 * 60 * 60 * 1000;

/**
 * Chrome drops an extension's alarms when it is disabled, and neither
 * onInstalled nor onStartup fires on re-enable -- so without this the watchdog
 * silently disappears until the next browser restart. Re-armed on every worker
 * wake, but only when absent: calling create() unconditionally resets the
 * period and can starve the alarm indefinitely.
 */
async function ensureWatchdog() {
  try {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!existing) {
      await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
    }
  } catch (err) {
    console.warn("[secureshare] watchdog arm failed", err);
  }
}

/**
 * The only channel that reaches a user who is not already looking at the popup.
 * A restore that gave up, or a vault we refuse to adopt on our own, both leave
 * bookmarks parked in Other Bookmarks -- silently, until this badge says so.
 *
 * Two tones, because these are two different messages. A failed restore, or our
 * OWN vault left behind by a reinstall, is a fault: something is wrong and only
 * the user can finish it. A vault that arrived over sync is not -- it is this
 * machine's half of a screen share running on another computer, it is the
 * expected consequence of hiding synced data (M0-FINDINGS §6), and it undoes
 * itself when that share ends. Shouting "!" in red at it would send the user
 * hunting for a problem and hurry them into the one action that does harm:
 * restoring here syncs the bookmarks back onto the bar the other machine is
 * presenting from, and a restore is never re-hidden.
 */
async function refreshBadge() {
  try {
    const [failure, pending] = await Promise.all([
      engine.lastFailure(),
      engine.pendingAdoptions(),
    ]);
    // Quiet ONLY where a peer's live hide is provable: a receipt exists, and it
    // names a vault id that is not this folder's. A vault with no receipt at all
    // answers `local: false` too, but it could equally be ours from before
    // receipts existed -- so it stays loud. Being wrong towards "•" would mute
    // the only notice a user gets that their own bookmarks are parked.
    const attention = !!failure || pending.some((p) => p.local || !p.receipt);
    const peerHiding = !attention && pending.length > 0;
    await chrome.action.setBadgeText({
      text: attention ? "!" : peerHiding ? "•" : "",
    });
    if (attention || peerHiding) {
      // brand: amber-400 is attention, green-400 is covered -- a peer's live
      // hide is not a fault, it is this machine covered from somewhere else.
      // Ink on both, never white: white on green-400 measures 1.78:1.
      await chrome.action.setBadgeBackgroundColor({
        color: attention ? "#FFB020" : "#17DE82",
      });
      await chrome.action
        .setBadgeTextColor({ color: "#0A100E" })
        .catch(() => {});
    }
  } catch (err) {
    console.warn("[secureshare] badge refresh failed", err);
  }
  await syncUninstallUrl();
}

/**
 * The toolbar icon is the state readout, and the scrim's POSITION is what says
 * which state it is: parked at 41% while armed, all the way down once the bar
 * is clear, retracted with every line showing when a share is live and the
 * bookmarks are still up. Three silhouettes, so it needs no badge to say this
 * and it survives being read by someone who cannot separate the green from the
 * flare. The badge above is a different sentence -- "something needs you" --
 * and the two are deliberately not fighting for the same pixels.
 */
async function refreshIcon() {
  try {
    const [j, shares] = await Promise.all([journal.read(), sessions.snapshot()]);
    // Displaced, not HIDDEN: mid-hide and mid-restore the bookmarks are already
    // off the bar, and an icon that said "exposed" there would be wrong in the
    // one direction that matters.
    const state = journal.isDisplaced(j)
      ? "hidden"
      : (shares?.sharing ?? 0) > 0
        ? "exposed"
        : "armed";
    await chrome.action.setIcon({
      path: {
        16: `icons/state-${state}-16.png`,
        32: `icons/state-${state}-32.png`,
      },
    });
  } catch (err) {
    console.warn("[secureshare] icon refresh failed", err);
  }
}

/**
 * Everything the toolbar shows. Called as one because every event that can
 * change the icon can also change the badge.
 */
const refreshAction = () => Promise.all([refreshIcon(), refreshBadge()]);

/**
 * Chrome opens this URL in a tab the moment the user uninstalls us -- the only
 * notification an extension gets about its own removal, and it arrives too late
 * to do anything but explain. Uninstalling while the bar is hidden leaves the
 * bookmarks parked in a folder, so that is exactly when it has something to say.
 *
 * Capped at 1023 characters by Chrome, which is why it carries a summary and
 * not the payload: the full recovery data is in the receipt inside the vault,
 * where there is no length limit and no need for it to be delivered.
 *
 * Off by a switch of its own, receipt.UNINSTALL_PING -- NOT the switch that
 * points a receipt at a hosted page. That one costs nothing because a fragment
 * never leaves the browser; this one is a real GET carrying a count and a
 * timestamp, which is the difference between "no network requests at all" and a
 * listing that has to say otherwise. Turning it on is a disclosure decision.
 */
async function syncUninstallUrl() {
  try {
    if (!chrome.runtime.setUninstallURL || !receipt.UNINSTALL_PING) return;
    await chrome.runtime.setUninstallURL(receipt.uninstallUrlFor(await journal.read()));
  } catch (err) {
    console.warn("[secureshare] uninstall url failed", err);
  }
}

/**
 * A fresh install that finds bookmarks already parked in a vault is almost
 * always the same story: this profile hid its bar, the extension went away
 * before it could put it back, and the user has reinstalled to get them. The
 * badge alone would leave that sitting behind a toolbar icon they have no
 * reason to click, so the recovery page opens itself once, on install only.
 */
async function offerRecoveryOnInstall(reason) {
  if (reason !== "install") return;
  try {
    const pending = await engine.pendingAdoptions();
    if (pending.length === 0) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL("recovery.html") });
  } catch (err) {
    console.warn("[secureshare] recovery page failed to open", err);
  }
}

/**
 * Take the copy of the bar as it was before Skrim had touched it -- on a fresh
 * install only, never on an update, where "before Skrim" is already history.
 *
 * The engine owns every rule about whether the bar is worth snapshotting right
 * now; this notes that the profile is owed one and asks once. If the answer is
 * "not yet" -- a reinstall over bookmarks still parked in a vault is the case
 * that matters -- the want survives and the watchdog picks it up once recovery
 * has put the real bar back.
 */
async function takeOriginalBackupOnInstall(reason) {
  if (reason !== "install") return;
  try {
    await engine.wantOriginalBackup();
    const res = await engine.maybeOriginalBackup();
    console.log("[secureshare] original backup", res);
  } catch (err) {
    console.warn("[secureshare] original backup failed", err);
  }
}

/**
 * Registration that cannot take the worker down with it.
 *
 * Every listener here is registered at top level because MV3 misses any added
 * after an await -- which also means one throw at import time leaves NONE of
 * them registered, including onMessage, so the popup could not even reach the
 * engine to put the bar back by hand. A Chrome release that renames or drops a
 * namespace is exactly the "the extension broke after an update" case that has
 * to stay recoverable, so each registration is isolated and a failure is
 * reported rather than fatal.
 */
function safely(what, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`[secureshare] could not register ${what}`, err);
  }
}

/**
 * Ask chrome.tabs which recorder capture pages are open, and make the session
 * table agree. See recorders.js: for a recorder living in another extension the
 * tab is the only evidence there is, so this is both the discovery pass and the
 * expiry pass for that half of the world.
 *
 * Run on every worker wake as well as on the watchdog, because a wake is
 * exactly when the table may have been lost -- MV3 terminates us after ~30s
 * idle and an update wipes storage.session outright, both of which can happen
 * in the middle of a recording that is still running.
 *
 * Failures are swallowed on purpose. Without the "tabs" permission, or on a
 * Chrome that has changed the API, this returns nothing and the extension
 * behaves the way it did before recorder detection existed.
 */
async function scanRecorderTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    const found = [];
    for (const t of tabs ?? []) {
      const r = recorders.recorderForTab(t);
      if (r && typeof t.id === "number") found.push({ tabId: t.id, name: r.name });
    }
    await sessions.syncRecorders(found);
  } catch (err) {
    console.warn("[secureshare] recorder scan failed", err);
  }
}

async function runWatchdog() {
  // First: a frame that died without a word -- renderer crash, discarded tab,
  // lid closed mid-meeting -- never sends an `end`. Expiry is the only thing
  // that finishes those shares, and it may restore, so it runs before the
  // journal is read rather than against a stale copy of it.
  await sessions.sweep();
  await scanRecorderTabs();

  const j = await journal.read();
  if (!journal.isDisplaced(j)) {
    // Cosmetic cleanup deliberately cannot fail a restore, so this is the only
    // thing that ever finishes it.
    await engine.sweepStrayDecoys();
    // The once-a-day snapshot. Cheap to ask on every tick: it checks a stored
    // timestamp before it reads a single bookmark, so an unchanged bar costs
    // one tree read a day rather than one a minute. Only ever from the settled
    // branch -- a displaced bar holds decoys, not bookmarks.
    await engine
      .maybeDailyBackup()
      .catch((e) => console.warn("[secureshare] daily backup failed", e));
    // And the install-time copy, for the one install that could not take it at
    // the time: a reinstall over a bar still parked in a vault. Guarded by a
    // stored timestamp that is zero on every profile that already has one, so
    // for almost everybody this is a single storage read.
    await engine
      .maybeOriginalBackup()
      .catch((e) => console.warn("[secureshare] original backup failed", e));
    await refreshAction();
    return;
  }

  const age = Date.now() - (j.updatedAt ?? j.startedAt ?? 0);

  if ((j.state === journal.State.HIDING || j.state === journal.State.RESTORING) && age > STUCK_MS) {
    console.warn("[secureshare]", j.state, "stuck, recovering");
    await engine.recover({ maxHiddenMs: MAX_HIDDEN_MS });
    await refreshAction();
    return;
  }
  if (j.state === journal.State.HIDDEN && age > MAX_HIDDEN_MS) {
    console.warn("[secureshare] hidden past max duration, restoring");
    await engine.restore();
    await refreshAction();
  }
}

// --- listeners: top level, synchronous ------------------------------------

safely("watchdog", ensureWatchdog);

safely("onInstalled", () =>
  chrome.runtime.onInstalled.addListener((details) => {
    ensureWatchdog();
    // An auto-update mid-meeting must NOT un-hide the bar on a live share.
    // recover() already refuses to touch a healthy HIDDEN state; passing the max
    // age keeps the stale-hide safety net intact.
    engine
      .recover({ maxHiddenMs: MAX_HIDDEN_MS })
      .then((r) => console.log("[secureshare] install recover", details.reason, r))
      .catch((e) => console.error("[secureshare] install recover failed", e))
      .finally(refreshAction)
      .then(() => takeOriginalBackupOnInstall(details.reason))
      .then(() => offerRecoveryOnInstall(details.reason));
  })
);

safely("onStartup", () =>
  chrome.runtime.onStartup.addListener(() => {
    ensureWatchdog();
    // A browser restart always ends any share, so a hide surviving it is stale.
    // Chrome wipes storage.session across a restart too; this is belt and braces
    // for the case where it did not, e.g. a session-restore of sharing tabs.
    sessions.reset().catch((e) => console.error("[secureshare] session reset failed", e));
    engine
      .recover({ maxHiddenMs: 0 })
      .then((r) => console.log("[secureshare] startup recover", r))
      .catch((e) => console.error("[secureshare] startup recover failed", e))
      .finally(refreshAction);
  })
);

safely("onAlarm", () =>
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
      runWatchdog().catch((e) => console.error("[secureshare] watchdog failed", e));
    }
  })
);

// The engine snapshots the tree at hide time and replays it at restore time.
// These are how it learns the tree changed underneath it -- a user dragging the
// vault contents back, or a synced device ~2s away.
//
// The id and the touched parents are both forwarded. Chrome reports our OWN
// moves and creates back to us, and markDirty is serialised, so without the id
// every clean hide would mark itself dirty the moment the chain drained.
// The parents narrow it further: only the bar and the vault can stale an index.
//
// onChanged is deliberately absent. A rename or a URL edit moves nothing, so it
// can never invalidate a journalled index -- wiring it would only produce false
// positives that cost the bar its exact layout on restore.
const dirty = (reason, parents) => (id, info) =>
  engine
    .markDirty(reason, id, parents(info))
    .catch((e) => console.error("[secureshare] markDirty", e));

safely("bookmark events", () => {
  chrome.bookmarks.onCreated.addListener(dirty("created", (b) => [b?.parentId]));
  chrome.bookmarks.onRemoved.addListener(dirty("removed", (i) => [i?.parentId]));
  chrome.bookmarks.onMoved.addListener(dirty("moved", (i) => [i?.parentId, i?.oldParentId]));
});

// A closed tab takes every sharing frame in it, instantly. Needs no permission:
// the callback carries only the id, which is all dropTab uses.
safely("onTabRemoved", () =>
  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.dropTab(tabId).catch((e) => console.error("[secureshare] dropTab", e));
  })
);

// A recorder that captures from its own extension page -- Loom's pinned tab is
// the case this was built for -- is invisible to the MAIN-world hook: Chrome
// will not run our content scripts on another extension's pages, and those
// recorders call chrome.desktopCapture rather than getDisplayMedia anyway. The
// tab appearing is the whole signal. See recorders.js.
//
// tabs.onRemoved above already ends it: the record is keyed `<tabId>:ext`, so
// closing Loom's pinned tab drops it through the same prefix as everything else
// in that tab.
safely("recorder tabs", () => {
  chrome.tabs.onCreated.addListener((tab) => {
    const r = recorders.recorderForTab(tab);
    if (!r || typeof tab.id !== "number") return;
    sessions
      .noteRecorderTab(tab.id, r.name)
      .catch((e) => console.error("[secureshare] noteRecorderTab", e));
  });

  // Only a committed navigation is interesting, and changeInfo.url is present
  // only for those -- which also keeps this off the hot path, since onUpdated
  // otherwise fires for every status and title change in every tab.
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (typeof changeInfo?.url !== "string") return;
    const r = recorders.recorderFor(changeInfo.url);
    const done = r
      ? sessions.noteRecorderTab(tabId, r.name)
      : sessions.dropRecorderTab(tabId);
    done.catch((e) => console.error("[secureshare] recorder tab update", e));
  });
});

// Not a listener: a recording already running when this worker woke. MV3 kills
// us after ~30s idle and a recording lasts minutes, so the common case is that
// the worker starts up in the middle of one.
safely("recorder scan", () => {
  scanRecorderTabs().catch((e) => console.error("[secureshare] recorder scan", e));
});

// Also not a listener, and for the same reason. onInstalled and onStartup are
// the only other things that sync the toolbar, and neither fires when MV3
// simply restarts a worker it killed -- nor when the extension is re-enabled.
// The journal survives all of that and the icon does not, so a wake that skips
// this can leave the toolbar showing a state that ended some time ago.
safely("action refresh", () => {
  refreshAction().catch((e) => console.error("[secureshare] action refresh", e));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        // --- from the content-script bridge, i.e. from an arbitrary page.
        // Sender-derived identity only; nothing in the payload is trusted for
        // anything but matching a session the same frame opened.
        case "share:start":
          sendResponse(await sessions.noteStart(sender, msg.sid));
          break;
        case "share:end":
          sendResponse(await sessions.noteEnd(sender, msg.sid));
          break;
        case "share:beat":
          sendResponse(await sessions.noteBeat(sender, msg.sids));
          break;
        case "share:bye":
          sendResponse(await sessions.noteBye(sender));
          break;
        case "shares":
          sendResponse(await sessions.snapshot());
          break;
        case "conceal":
          // The product's hide: honours the tuck toggle. The popup's Hide
          // button and the automatic share-hide both come through here.
          sendResponse(await engine.conceal(msg.options));
          break;
        case "hide":
          // The pure vault hide, for the developer panel only.
          sendResponse(await engine.hide(msg.options));
          break;
        case "restore":
          sendResponse(await engine.restore());
          break;
        case "status":
          sendResponse(await engine.status());
          break;
        case "recover":
          // Explicit user action from the popup: force it, ignoring age.
          sendResponse(await engine.recover({ maxHiddenMs: 0 }));
          break;
        case "lastFailure":
          sendResponse(await engine.lastFailure());
          break;
        case "dismissFailure":
          await engine.clearLastFailure();
          sendResponse({ ok: true });
          break;
        case "pendingAdoptions":
          sendResponse(await engine.pendingAdoptions());
          break;
        case "adoptVault":
          sendResponse(await engine.adoptVault(msg.id));
          break;
        case "getSettings":
          sendResponse(await engine.getSettings());
          break;
        case "setSettings":
          sendResponse(await engine.setSettings(msg.patch));
          break;
        case "exportBar":
          sendResponse(await engine.exportBar(msg.format));
          break;
        case "importBookmarks":
          sendResponse(await engine.importTree(msg.nodes, { folderTitle: msg.folderTitle }));
          break;
        // --- snapshots. The engine owns the one chain every bookmark
        // operation runs on, so a backup taken from the page cannot interleave
        // with a hide happening in the same second.
        case "listBackups":
          sendResponse(await engine.listBackups());
          break;
        case "makeBackup":
          sendResponse(await engine.snapshotBar("manual", { label: msg.label, force: true }));
          break;
        case "backupFile":
          sendResponse(await engine.backupFile(msg.id));
          break;
        case "restoreBackup":
          sendResponse(
            await engine.restoreBackup(msg.id, { mode: msg.mode, dry: msg.dry }),
          );
          break;
        case "deleteBackup":
          sendResponse(await engine.deleteBackup(msg.id));
          break;
        case "renameBackup":
          sendResponse(await engine.renameBackup(msg.id, msg.label));
          break;
        case "clearBackups":
          sendResponse(await engine.clearBackups());
          break;
        default:
          sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
    // Every 10s from every sharing frame, and a badge refresh costs a bookmark
    // search for orphan vaults. A beat changes neither failures nor orphans.
    if (msg?.type !== "share:beat") refreshAction();
  })();
  return true; // keep the channel open for the async response
});
