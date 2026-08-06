// MAIN-world hook on MediaDevices.prototype.getDisplayMedia.
//
// This runs in the page's own JavaScript world, which is the only place a
// page's call to getDisplayMedia is visible: an isolated-world content script
// gets its own `navigator.mediaDevices` wrapper, so a patch there would sit
// beside the one the page actually calls and see nothing.
//
// Two hard rules, because this file executes inside every page the user opens:
//   * it must never throw into the page, and
//   * the patched method must be indistinguishable from the native one.
// Hence a Proxy rather than a wrapper function. `name` and `length` forward to
// the target untouched, and Function.prototype.toString on a callable Proxy
// returns a "[native code]" string rather than our source -- so a site that
// sniffs for a patched API sees a native method. A plain `function (...args)`
// wrapper gets all three wrong and prints this file into the page's console.
//
// TIMING -- the whole point of the milestone. The session is announced when
// getDisplayMedia is CALLED, not when it resolves. Chrome's picker shows a live
// preview of every window before the user picks one, and the first captured
// frames go out the instant they click Share; a hide that starts on the
// resolved promise has already lost. Being early costs one hide/restore cycle
// when the picker is cancelled -- the reject path releases the session. Being
// late costs the bookmarks bar on the wire, which is the thing this extension
// exists to prevent.
//
// RELEASE -- the other half of that trade. Hiding early means hiding before we
// know what is being shared, so once the stream resolves we look: a captured
// Chrome tab cannot contain the bookmarks bar, and that session is handed back
// immediately instead of holding the bar down for the whole meeting. The hide
// syncs, so on the common case -- Meet and Zoom both default to tab sharing --
// this is the difference between every other signed-in device losing its
// bookmarks bar for an hour and losing it for a few seconds.
//
// Nothing here is a security boundary. A hostile page can call the real
// getDisplayMedia just as easily as it can forge one of these messages, so the
// bridge validates shape and provenance but does not try to authenticate the
// page. Every action it can provoke is journalled and reversible.

(() => {
  "use strict";

  const NS = "secureshare";
  const HOOKED = Symbol.for("secureshare.hooked");
  // How long the picker is held shut waiting for the bar to actually go down.
  //
  // M3 measured a real hide at 30-123ms depending on how busy the machine is,
  // and Chrome's picker captures its preview thumbnails within a few ms of the
  // call -- so announcing the share and calling straight through is a race, and
  // a live test lost it. This is the deadline, not the cost: the common case
  // resolves as soon as the worker answers.
  //
  // Capped, and it fails OPEN. A worker that is broken, mid-update, or simply
  // slower than this delays the picker by at most this much and the share
  // proceeds anyway. Being late with the bar is a bad afternoon; blocking the
  // share is a broken meeting.
  const HIDE_WAIT_MS = 400;
  // While anything is sharing, tell the worker so every BEAT_MS. Two jobs: it
  // is the liveness signal for a frame that navigates away or crashes without
  // ever firing `ended`, and it re-teaches the state to a worker that was
  // terminated mid-share. Restoring late is harmless -- hiding late is not --
  // so this is deliberately slow relative to the event paths below.
  const BEAT_MS = 10_000;
  // MediaStreamTrack.getSettings().displaySurface for a captured Chrome tab.
  //
  // A tab capture is the page's own rendered contents and nothing else -- the
  // tab strip, the omnibox and the bookmarks bar are all outside the captured
  // surface, on every platform. So the moment we learn a share is a tab share
  // there is provably nothing left to protect, and the bookmarks can go
  // straight back rather than staying vaulted for the whole meeting.
  //
  // That matters well beyond this machine: the hide is a bookmark mutation and
  // bookmark mutations SYNC, so a bar held down for an hour here is a bar held
  // down for an hour on every other signed-in device (M0-FINDINGS §6). Tab
  // sharing is what Meet and Zoom recommend by default, so releasing it early
  // takes the common case from an hour of collateral damage to a few seconds.
  //
  // This value is only ever read to RELEASE. Nothing decides to hide from it.
  const TAB_SURFACE = "browser";

  const MD = globalThis.MediaDevices;
  if (!MD || !MD.prototype || typeof MD.prototype.getDisplayMedia !== "function") {
    return; // insecure origin, or a Chrome without the API
  }
  if (MD.prototype[HOOKED]) return;

  // Patched on the PROTOTYPE, not on `navigator.mediaDevices`. An own property
  // on the instance is bypassed by
  // `MediaDevices.prototype.getDisplayMedia.call(navigator.mediaDevices, …)`,
  // which some SDKs use to dodge exactly this kind of patch.
  const original = MD.prototype.getDisplayMedia;

  /**
   * sid -> { tracks, safe }. `tracks` is null while the picker is still open.
   *
   * `safe` marks a session whose captured surface cannot contain the bookmarks
   * bar. Such a session stays in this map -- Chrome can swap the surface under
   * a live track, and we have to be able to put the bar back down if it does --
   * but it no longer counts towards the worker's tally of shares that require
   * the bar to be hidden.
   */
  const live = new Map();
  let beat = 0;

  /** sid -> resolve, for calls currently holding the picker shut. */
  const waiting = new Map();

  /**
   * Resolves when the bridge reports the bar is down for this sid, or when the
   * deadline passes -- whichever comes first, and at most once either way.
   */
  function untilHidden(sid) {
    return new Promise((resolve) => {
      const settle = () => {
        if (waiting.delete(sid)) resolve();
      };
      waiting.set(sid, settle);
      setTimeout(settle, HIDE_WAIT_MS);
    });
  }

  try {
    // The page can forge this and open its own picker early. That is not worth
    // defending: the page is the thing doing the capturing, so it is already
    // free to look at whatever the user shares with it.
    window.addEventListener(
      "message",
      (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (!d || d.ns !== NS || d.v !== 1 || d.kind !== "hidden") return;
        waiting.get(d.sid)?.();
      },
      true,
    );
  } catch { /* no listener: every call then falls back to the deadline */ }

  const post = (kind, extra) => {
    try {
      // "/" is the source window's own origin: same-window delivery, and the
      // only targetOrigin that is always valid, including for opaque origins.
      window.postMessage({ ns: NS, v: 1, kind, ...extra }, "/");
    } catch { /* a page may have replaced postMessage; never break it */ }
  };

  const newSid = () => {
    try {
      return crypto.randomUUID();
    } catch { /* randomUUID needs a secure context */ }
    return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  };

  // A pending session (null tracks) counts as live: the picker being open is
  // itself a preview of the screen, so the bar must already be down.
  const stillLive = (e) =>
    e.tracks === null || e.tracks.some((t) => t.readyState === "live");

  /**
   * The sessions that still require the bar to be down: live, and not released
   * as a tab capture. This -- not `live.size` -- is what the worker is told and
   * what keeps the beat running, because a released session is one the worker
   * has already been asked to forget.
   */
  const demanding = () =>
    [...live].filter(([, e]) => !e.safe && stillLive(e)).map(([sid]) => sid);

  function stopBeatIfIdle() {
    if (beat && demanding().length === 0) {
      clearInterval(beat);
      beat = 0;
    }
  }

  function startBeat() {
    // setInterval rather than a self-rescheduling timeout: a frame that is
    // frozen or discarded simply stops beating, which is precisely the signal
    // the worker needs to expire it.
    if (!beat) beat = setInterval(() => reconcile(true), BEAT_MS);
  }

  /**
   * Drop every session whose tracks have all ended and report it. `withBeat`
   * also sends the surviving set, which is authoritative -- it is read straight
   * off the live tracks, so it repairs any divergence in the worker.
   */
  function reconcile(withBeat) {
    for (const [sid, e] of [...live]) {
      if (stillLive(e)) continue;
      live.delete(sid);
      // A released session was retired in the worker when it was released.
      // Ending it again would wake the worker to do nothing.
      if (!e.safe) post("end", { sid });
    }
    const sids = demanding();
    if (withBeat && sids.length > 0) post("beat", { sids });
    stopBeatIfIdle();
  }

  function finish(sid) {
    const e = live.get(sid);
    if (live.delete(sid) && !e.safe) post("end", { sid });
    stopBeatIfIdle();
  }

  /**
   * Is this track capturing a Chrome tab, and therefore incapable of showing
   * the bookmarks bar?
   *
   * Read only ever to RELEASE, so every uncertainty resolves to "keep hiding":
   * a Chrome that does not report displaySurface, a track that will not answer,
   * a getSettings the page has replaced -- all of them fall through to false
   * and the bar stays down exactly as it did before this existed.
   */
  function isTabCapture(track) {
    try {
      return track.getSettings?.().displaySurface === TAB_SURFACE;
    } catch {
      return false; // never let a hostile or exotic track talk us into exposure
    }
  }

  /**
   * Re-read what this session is actually capturing and tell the worker whether
   * it still needs the bar down. Runs once the tracks arrive, and again on
   * every `configurationchange` -- Chrome's "Share this tab instead" swaps the
   * captured surface under a live track, with no second getDisplayMedia call.
   *
   * A session with no video tracks never reaches here (watch() finishes it),
   * and `every` on a multi-track capture means one non-tab surface keeps the
   * whole session demanding.
   */
  function evaluate(sid) {
    const e = live.get(sid);
    if (!e || e.tracks === null) return;
    const safe = e.tracks.length > 0 && e.tracks.every(isTabCapture);
    if (safe === e.safe) return;
    e.safe = safe;
    if (safe) {
      // `end` is the worker's word for "this session no longer requires the bar
      // down", which is exactly what has just become true. Reusing it keeps the
      // bridge and the session bookkeeping untouched.
      post("end", { sid });
      stopBeatIfIdle();
    } else {
      // Downgraded to something that can show the bar. Re-announce, which the
      // worker treats as a fresh share and re-asserts the hide for.
      post("start", { sid });
      startBeat();
    }
  }

  function watch(sid, stream) {
    let tracks = [];
    try {
      tracks = stream.getVideoTracks();
    } catch { /* not a MediaStream; treated as no tracks */ }
    if (tracks.length === 0) {
      finish(sid); // audio-only capture displays nothing
      return;
    }
    live.set(sid, { tracks, safe: false });
    for (const t of tracks) {
      try {
        // Fires when the user clicks Chrome's own "Stop sharing" -- the path
        // almost every real share ends on.
        t.addEventListener("ended", () => reconcile(false));
        // Chrome can change what a live track is capturing without a new call
        // -- "Share this tab instead" is the one users can reach. Without this,
        // a screen share that became a tab share would stay hidden for the rest
        // of the meeting, and a tab share that became anything else would leave
        // the bar up on a live capture.
        t.addEventListener("configurationchange", () => evaluate(sid));
        // MediaStreamTrack.stop() is specified NOT to fire `ended`, so a page
        // that ends its own share (Meet's "Stop presenting") would otherwise
        // leave the bar hidden until the next beat.
        const stop = t.stop;
        if (typeof stop === "function") {
          Object.defineProperty(t, "stop", {
            configurable: true,
            writable: true,
            value: function () {
              try {
                return stop.apply(this, arguments);
              } finally {
                queueMicrotask(() => reconcile(false));
              }
            },
          });
        }
      } catch { /* an exotic track shape still gets the beat as a backstop */ }
    }
    startBeat();
    // Last, and only now: the surface is not knowable until the tracks exist.
    // Everything above this line has already run as if the share were unsafe,
    // which is the order that keeps a failure here costing privacy nothing.
    evaluate(sid);
  }

  const patched = new Proxy(original, {
    apply(target, thisArg, args) {
      let sid = null;
      try {
        sid = newSid();
        live.set(sid, { tracks: null, safe: false });
        post("start", { sid });
        startBeat();
      } catch { /* announcing must never stop the share from happening */ }

      // Nothing was announced, so there is nothing to wait for: call through
      // exactly as the unpatched method would, synchronous throw and all.
      if (sid === null) return Reflect.apply(target, thisArg, args);

      // The call is deferred until the bar is down. Transient activation
      // survives it -- Chrome's window is 5 seconds and this waits at most
      // HIDE_WAIT_MS -- and the whole point is that Chrome must not get to
      // open its picker, and photograph the screen for the preview, first.
      return untilHidden(sid).then(() => {
        let result;
        try {
          result = Reflect.apply(target, thisArg, args);
        } catch (err) {
          finish(sid); // a throw means no picker was ever shown
          throw err;
        }
        if (!result || typeof result.then !== "function") {
          finish(sid);
          return result;
        }
        return settle(sid, result);
      });
    },
  });

  /** The resolved/rejected halves of a call, once one is actually in flight. */
  function settle(sid, result) {
    return result.then(
      (stream) => {
        try {
          watch(sid, stream);
        } catch {
          finish(sid);
        }
        return stream;
      },
      (err) => {
        finish(sid); // cancelled picker, or denied by policy
        throw err;
      },
    );
  }

  try {
    MD.prototype.getDisplayMedia = patched;
    Object.defineProperty(MD.prototype, HOOKED, { value: true });
  } catch { /* frozen prototype: leave the page exactly as it was */ }
})();
