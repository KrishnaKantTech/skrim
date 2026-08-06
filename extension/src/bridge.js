// Isolated-world relay between the page hook and the service worker.
//
// The hook has to live in the MAIN world to see the page's getDisplayMedia, and
// the MAIN world has no chrome.runtime. So the hook shouts into its own window
// and this file -- same frame, isolated world, full extension API -- forwards.
//
// It validates shape and provenance but deliberately does not try to
// authenticate the page. A hostile page can call the real getDisplayMedia just
// as easily as it can forge one of these messages, so authentication here would
// buy nothing; every action a forged message can provoke is journalled and
// reversible, and the picker a real call opens is user-visible.
//
// Runs on every page the user opens, so until a share actually starts its
// entire cost is one `message` listener.

(() => {
  "use strict";

  const NS = "secureshare";
  const KINDS = new Set(["start", "end", "beat"]);
  // Matches the hook's per-frame cap; a page spraying sids cannot grow the
  // worker's stored state without bound.
  const MAX_SIDS = 16;

  // Set on the first real share. Everything below is conditional on it, so a
  // page that never shares never sends the worker a single message -- including
  // the pagehide notice, which would otherwise wake the worker on every unload
  // in every tab.
  let engaged = false;

  /**
   * `onSettled` is how the hook learns the bar is actually down. The worker
   * answers a share:start only after engine.hide() has resolved, so the reply
   * is the signal -- and it is delivered on failure too, because a hook left
   * waiting would hold the picker shut for a share the user asked for.
   */
  function send(msg, onSettled) {
    const done = () => { try { onSettled?.(); } catch { /* not our problem */ } };
    try {
      // Falsy after the extension is reloaded or updated while this page lives
      // on. Touching chrome.runtime.sendMessage then throws "Extension context
      // invalidated" straight into the page's console.
      if (!chrome.runtime?.id) return done();
      const p = chrome.runtime.sendMessage(msg);
      // No receiver (worker starting, or shutting down) rejects; that is normal
      // and the beat re-delivers the state a moment later.
      if (p && typeof p.then === "function") p.then(done, done);
      else done();
    } catch { done(); /* never surface extension state to the page */ }
  }

  window.addEventListener("message", (event) => {
    // Same frame only: a message posted by an embedded iframe arrives here with
    // source === that iframe's window, and its own bridge already relayed it.
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.ns !== NS || d.v !== 1 || !KINDS.has(d.kind)) return;

    if (d.kind === "beat") {
      if (!Array.isArray(d.sids)) return;
      const sids = d.sids.filter((s) => typeof s === "string" && s).slice(0, MAX_SIDS);
      if (sids.length === 0) return;
      if (!engaged) engaged = true;
      send({ type: "share:beat", sids });
      return;
    }

    if (typeof d.sid !== "string" || !d.sid) return;
    if (d.kind === "start") {
      engaged = true;
      // The reply carries nothing; its arrival is the whole message. Posted
      // back to this window only, with the sid, so a slow reply cannot release
      // a later call's wait.
      send({ type: "share:start", sid: d.sid }, () => {
        try {
          window.postMessage({ ns: NS, v: 1, kind: "hidden", sid: d.sid }, "/");
        } catch { /* a page may have replaced postMessage */ }
      });
      return;
    }
    if (!engaged) return; // an `end` we never saw the `start` for
    send({ type: `share:${d.kind}`, sid: d.sid });
  });

  // Best-effort fast path for navigating away or closing the tab mid-share.
  // Delivery during unload is not guaranteed, which is why it is not the only
  // mechanism: tabs.onRemoved covers a closed tab instantly, and the worker
  // expires a frame that stops beating regardless of why it went quiet.
  window.addEventListener("pagehide", () => {
    if (engaged) send({ type: "share:bye" });
  });
})();
