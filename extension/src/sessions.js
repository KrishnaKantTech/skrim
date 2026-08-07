// Screen-share session bookkeeping.
//
// The hook reports one session per getDisplayMedia call, from any frame of any
// tab. This module reduces that stream of events to a single question -- is
// anything sharing right now? -- and drives hide/restore off the answer. Two
// tabs presenting at once must produce one hide and one restore, not two of
// each, so sessions are counted rather than toggled.
//
// State lives in chrome.storage.session, never in module scope: MV3 terminates
// the worker after ~30s idle and a meeting lasts an hour. storage.session is
// also exactly the right lifetime -- Chrome wipes it when the browser closes,
// and a browser restart ends every share, so a stale session can never outlive
// the share it describes. (The bookmark journal is the opposite case and
// correctly lives in storage.local: an interrupted hide MUST survive a crash.)

import * as engine from "./engine.js";

const KEY = "secureshare.shares";

// A sharing frame beats every 10s. Three missed beats means it is gone --
// navigated, crashed, discarded, or frozen -- and its sessions with it.
const STALE_MS = 35_000;
// An external recorder has no hook and therefore no beat: its capture page is
// another extension's, where our content scripts are not allowed to run. Its
// liveness is proven by the TAB still existing, which the watchdog re-checks --
// so these records are exempt from the beat clock and would otherwise be
// expired mid-recording, 35s in.
const EXT_FRAME = "ext";
const EXT_SID = "recorder";
const extKey = (tabId) => `${tabId}:${EXT_FRAME}`;
// Bounds on state a page can grow by calling getDisplayMedia in a loop.
const MAX_FRAMES = 64;
const MAX_SIDS_PER_FRAME = 16;

let chain = Promise.resolve();

/** Same discipline as the engine: one operation at a time, failures isolated. */
function serialize(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

async function read() {
  const got = await chrome.storage.session.get(KEY);
  const s = got[KEY];
  return s && typeof s === "object" && s.frames && typeof s.frames === "object"
    ? s
    : { frames: {} };
}

async function write(s) {
  // Removed rather than stored empty, so "nothing is sharing" is the absence of
  // a record and cannot be misread as a record of zero.
  if (Object.keys(s.frames).length === 0) await chrome.storage.session.remove(KEY);
  else await chrome.storage.session.set({ [KEY]: s });
}

/**
 * A frame, not a tab. A tab can hold several sharing frames (a conferencing app
 * embedded in an iframe is the normal case, not the exotic one) and each gets
 * its own hook, its own beat, and its own death.
 */
function keyOf(sender) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return null; // not a content script
  return `${tabId}:${sender.frameId ?? 0}`;
}

function frameOf(s, key) {
  let f = s.frames[key];
  if (!f) {
    if (Object.keys(s.frames).length >= MAX_FRAMES) {
      // Evict the frame that has been quiet longest rather than refusing the
      // new one: a live share must always be able to register.
      let oldest = null;
      for (const [k, v] of Object.entries(s.frames)) {
        if (oldest === null || v.lastSeen < s.frames[oldest].lastSeen) oldest = k;
      }
      if (oldest !== null) delete s.frames[oldest];
    }
    f = s.frames[key] = { sids: [], lastSeen: 0 };
  }
  return f;
}

function count(s) {
  let n = 0;
  for (const f of Object.values(s.frames)) n += f.sids?.length ?? 0;
  return n;
}

function prune(s, now) {
  for (const [k, f] of Object.entries(s.frames)) {
    if (!Array.isArray(f?.sids) || f.sids.length === 0) {
      delete s.frames[k];
      continue;
    }
    // A recorder record is held open by its tab, not by a beat. syncRecorders
    // is what retires it; ageing it out here would put the bookmarks bar back
    // 35 seconds into every Loom recording.
    if (f.ext) continue;
    if (!(f.lastSeen > now - STALE_MS)) delete s.frames[k];
  }
}

/**
 * Apply a mutation, then reconcile the bookmarks bar with the result.
 *
 * `fn` returns "hide" to re-assert the hide even when a share was already
 * counted. Every `start` does: a second presenter joining, or the first frame
 * of a share that began while the bar had been put back by hand, must both end
 * with the bar down. hide() is idempotent and costs two reads when it is
 * already hidden, so re-asserting is cheaper than reasoning about whether to.
 */
async function mutate(fn) {
  const s = await read();
  const before = count(s);
  prune(s, Date.now());
  const force = fn(s) === "hide";
  const after = count(s);
  await write(s);

  let result = null;
  try {
    // conceal(), not hide(): the automatic share-hide honours the tuck toggle,
    // parking the bar into a folder instead of a vault when the user asked for
    // that. restore() is mode-aware and puts back whichever one ran.
    if (after > 0 && (force || before === 0)) result = await engine.conceal();
    // Restore only on the transition, never on a beat that merely confirms
    // nothing is sharing -- that would fight a hide made from the popup.
    else if (after === 0 && before > 0) result = await engine.restore();
  } catch (err) {
    return { ok: false, sharing: after, error: String(err?.message ?? err) };
  }
  return { ok: true, sharing: after, ...(result ? { engine: result } : {}) };
}

const rejected = (why) => Promise.resolve({ ok: false, error: why });

/** getDisplayMedia was called. The picker is opening; the bar goes down now. */
export function noteStart(sender, sid) {
  const key = keyOf(sender);
  if (!key) return rejected("share:start from a non-tab sender");
  if (typeof sid !== "string" || !sid) return rejected("share:start without a sid");
  return serialize(() =>
    mutate((s) => {
      const f = frameOf(s, key);
      f.lastSeen = Date.now();
      // A duplicate sid, or a page calling getDisplayMedia in a loop past the
      // cap, must not buy another hide -- that is the one path where a page
      // controls how much work the worker does.
      if (f.sids.includes(sid) || f.sids.length >= MAX_SIDS_PER_FRAME) return;
      f.sids.push(sid);
      return "hide";
    }),
  );
}

/** The tracks ended, or the picker was cancelled. */
export function noteEnd(sender, sid) {
  const key = keyOf(sender);
  if (!key) return rejected("share:end from a non-tab sender");
  return serialize(() =>
    mutate((s) => {
      const f = s.frames[key];
      if (!f) return;
      f.sids = f.sids.filter((x) => x !== sid);
      f.lastSeen = Date.now();
      if (f.sids.length === 0) delete s.frames[key];
    }),
  );
}

/**
 * Periodic truth from a sharing frame. The reported set REPLACES whatever we
 * held for that frame -- it was read off the live tracks, so it is the more
 * reliable of the two -- which is what makes a worker that was terminated
 * mid-share, or an extension update that wiped storage.session, self-healing.
 */
export function noteBeat(sender, sids) {
  const key = keyOf(sender);
  if (!key) return rejected("share:beat from a non-tab sender");
  if (!Array.isArray(sids)) return rejected("share:beat without sids");
  const clean = sids
    .filter((x) => typeof x === "string" && x)
    .slice(0, MAX_SIDS_PER_FRAME);
  return serialize(() =>
    mutate((s) => {
      if (clean.length === 0) {
        delete s.frames[key];
        return;
      }
      const f = frameOf(s, key);
      f.sids = clean;
      f.lastSeen = Date.now();
    }),
  );
}

/** The frame is unloading. Best effort -- expiry is the guarantee. */
export function noteBye(sender) {
  const key = keyOf(sender);
  if (!key) return rejected("share:bye from a non-tab sender");
  return serialize(() =>
    mutate((s) => {
      delete s.frames[key];
    }),
  );
}

/**
 * A closed tab takes every frame in it. Instant, and needs no permission --
 * chrome.tabs.onRemoved carries only the id, which is all this uses.
 */
export function dropTab(tabId) {
  if (typeof tabId !== "number") return rejected("dropTab without a tab id");
  const prefix = `${tabId}:`;
  return serialize(() =>
    mutate((s) => {
      for (const k of Object.keys(s.frames)) {
        if (k.startsWith(prefix)) delete s.frames[k];
      }
    }),
  );
}

/**
 * A recorder extension's capture page has appeared as a tab. See recorders.js
 * for why a tab is the only evidence we get.
 *
 * Keyed `<tabId>:ext` rather than a namespace of its own, so everything that
 * already reasons about tabs keeps working unchanged: chrome.tabs.onRemoved
 * takes it away through dropTab's `<tabId>:` prefix, and the popup's
 * frame-key-to-tab split counts it as the tab it is.
 *
 * Registering is idempotent and only the FIRST registration re-asserts the
 * hide. tabs.onUpdated fires several times for one page load, and a hide per
 * event would fight the popup's Restore button through a whole recording.
 */
export function noteRecorderTab(tabId, name) {
  if (typeof tabId !== "number") return rejected("noteRecorderTab without a tab id");
  return serialize(() =>
    mutate((s) => {
      const key = extKey(tabId);
      const known = s.frames[key]?.sids?.includes(EXT_SID);
      const f = frameOf(s, key);
      f.ext = true;
      f.name = typeof name === "string" ? name : undefined;
      f.lastSeen = Date.now();
      if (known) return;
      f.sids = [EXT_SID];
      return "hide";
    }),
  );
}

/**
 * That tab is no longer a capture page -- it navigated somewhere else.
 *
 * Only the `:ext` record goes. dropTab would take the whole tab with it, and a
 * recorder page that navigates to its own web app leaves behind a perfectly
 * ordinary tab that our content scripts DO reach and that may start a share of
 * its own a moment later.
 */
export function dropRecorderTab(tabId) {
  if (typeof tabId !== "number") return rejected("dropRecorderTab without a tab id");
  return serialize(() =>
    mutate((s) => {
      delete s.frames[extKey(tabId)];
    }),
  );
}

/**
 * The whole truth about recorder tabs, from a chrome.tabs query: these ids are
 * capturing right now, and no others are.
 *
 * This is the recorder's equivalent of the beat, and it exists for the same
 * reasons. A worker terminated mid-recording, or an extension update that wiped
 * storage.session, forgets a recording that is still running -- and a tab closed
 * while the worker was asleep is a hide nobody is left to release. Replacing the
 * whole set rather than merging heals both directions.
 */
export function syncRecorders(tabs) {
  if (!Array.isArray(tabs)) return rejected("syncRecorders without a tab list");
  const live = new Map();
  for (const t of tabs) {
    if (t && typeof t.tabId === "number") live.set(t.tabId, t.name);
  }
  return serialize(() =>
    mutate((s) => {
      let added = false;
      for (const [k, f] of Object.entries(s.frames)) {
        if (!f?.ext) continue;
        const id = Number(k.slice(0, -(EXT_FRAME.length + 1)));
        if (live.has(id)) live.delete(id); // already counted; leave it alone
        else delete s.frames[k];
      }
      for (const [id, name] of live) {
        const f = frameOf(s, extKey(id));
        f.ext = true;
        f.name = name;
        f.sids = [EXT_SID];
        f.lastSeen = Date.now();
        added = true;
      }
      // Only a recording we did not already know about buys a hide. A sync that
      // merely confirms the status quo must not re-assert one, or the watchdog
      // would undo a Restore the user made by hand, every minute, silently.
      return added ? "hide" : undefined;
    }),
  );
}

/**
 * Expiry pass, from the watchdog alarm. The only thing that ends a share whose
 * frame died without a word -- a renderer crash, a discarded tab, a laptop lid
 * closed mid-meeting.
 */
export function sweep() {
  return serialize(() => mutate(() => {}));
}

/** Browser restart: nothing can still be sharing. */
export function reset() {
  return serialize(async () => {
    await chrome.storage.session.remove(KEY);
    return { ok: true, sharing: 0 };
  });
}

export function snapshot() {
  return serialize(async () => {
    const s = await read();
    const now = Date.now();
    prune(s, now);
    return {
      sharing: count(s),
      frames: Object.entries(s.frames).map(([k, f]) => ({
        frame: k,
        sessions: f.sids.length,
        quietMs: now - f.lastSeen,
        // Why the bar is down, for the popup's developer section: "a page called
        // getDisplayMedia" and "Loom is recording" are the same hide but very
        // different support conversations.
        ...(f.ext ? { recorder: f.name ?? "recorder" } : {}),
      })),
    };
  });
}
