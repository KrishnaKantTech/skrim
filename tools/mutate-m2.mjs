// Mutation testing for M2 -- the getDisplayMedia hook.
//
//   node tools/mutate-m2.mjs        exit 0 == every decision below is load-bearing
//
// Each entry reverts one design decision in a scratch copy of the extension and
// requires the suite to go red. A mutation that stays green is not a passing
// test, it is an UNTESTED DECISION: the code could be written either way and
// nothing would notice. Two of the entries here were green when first written,
// and the tests that now catch them (S-4's lost `end`, S-6's re-assert) exist
// only because of that.
//
// When you change M2 behaviour on purpose, the anchor strings below stop
// matching and this fails loudly with "anchor not found" -- which is the point.
// Update the mutation to describe the NEW decision rather than deleting it.

import { run } from "./mutate-run.mjs";

const MUTATIONS = [
  {
    name: "M2-a  announce the share only once the picker RESOLVES",
    file: "extension/src/hook.js",
    from: `        sid = newSid();
        live.set(sid, { tracks: null, safe: false });
        post("start", { sid });`,
    to: `        sid = newSid();
        live.set(sid, { tracks: null, safe: false });`,
    also: [{
      file: "extension/src/hook.js",
      from: `      (stream) => {
        try {
          watch(sid, stream);`,
      to: `      (stream) => {
        try {
          post("start", { sid });
          watch(sid, stream);`,
    }],
  },
  {
    name: "M2-b  do not wrap track.stop() (rely on the `ended` event alone)",
    file: "extension/src/hook.js",
    from: `        const stop = t.stop;
        if (typeof stop === "function") {`,
    to: `        const stop = t.stop;
        if (false && typeof stop === "function") {`,
  },
  {
    name: "M2-c  a pending session (picker open) does not count as live",
    file: "extension/src/hook.js",
    from: `    e.tracks === null || e.tracks.some((t) => t.readyState === "live");`,
    to: `    e.tracks !== null && e.tracks.some((t) => t.readyState === "live");`,
  },
  {
    name: "M2-d  restore on any `end`, not on the transition to zero",
    file: "extension/src/sessions.js",
    from: `    else if (after === 0 && before > 0) result = await engine.restore();`,
    to: `    else if (before > 0) result = await engine.restore();`,
  },
  {
    name: "M2-e  a beat MERGES into the frame's set instead of replacing it",
    file: "extension/src/sessions.js",
    from: `      f.sids = clean;
      f.lastSeen = Date.now();`,
    to: `      f.sids = [...new Set([...f.sids, ...clean])];
      f.lastSeen = Date.now();`,
  },
  {
    name: "M2-f  never expire a frame that stopped beating",
    file: "extension/src/sessions.js",
    from: `    if (!Array.isArray(f?.sids) || f.sids.length === 0 || !(f.lastSeen > now - STALE_MS)) {`,
    to: `    if (!Array.isArray(f?.sids) || f.sids.length === 0) {`,
  },
  {
    name: "M2-g  bridge trusts messages from any window, not just its own frame",
    file: "extension/src/bridge.js",
    from: `    if (event.source !== window) return;`,
    to: `    if (false) return;`,
  },
  {
    name: "M2-h  a new share does not re-assert the hide",
    file: "extension/src/sessions.js",
    from: `      f.sids.push(sid);
      return "hide";`,
    to: `      f.sids.push(sid);`,
  },
  {
    name: "M2-i  a closed tab does not end the shares inside it",
    file: "extension/src/sw.js",
    from: `  sessions.dropTab(tabId).catch((e) => console.error("[secureshare] dropTab", e));`,
    to: `  void tabId;`,
  },
  {
    name: "M2-j  the watchdog does not sweep expired sessions",
    file: "extension/src/sessions.js",
    from: `export function sweep() {
  return serialize(() => mutate(() => {}));`,
    to: `export function sweep() {
  return serialize(async () => ({ ok: true }));`,
  },
  {
    name: "M2-k  the hook is injected twice (no double-patch guard)",
    file: "extension/src/hook.js",
    from: `  if (MD.prototype[HOOKED]) return;`,
    to: `  if (false) return;`,
  },
  {
    name: "M2-l  bridge forwards `end` for shares it never saw start",
    file: "extension/src/bridge.js",
    from: "    if (!engaged) return; // an `end` we never saw the `start` for",
    to: "    engaged = true;",
  },

  // --- M3: the picker must not open before the bar is down -----------------
  // Found by the live test, not by this suite: a real Chrome showed the
  // bookmarks bar inside the picker's own preview thumbnail, because hiding
  // began at the call and the picker photographed the screen first.
  {
    name: "M3-a  call getDisplayMedia straight through, without waiting for the hide",
    file: "extension/src/hook.js",
    from: "      return untilHidden(sid).then(() => {",
    to: "      return Promise.resolve().then(() => {",
  },
  {
    name: "M3-b  wait for the hide forever, instead of failing open on a deadline",
    timeoutMs: 12_000, // it hangs by construction; do not pay the full budget
    file: "extension/src/hook.js",
    from: `      waiting.set(sid, settle);
      setTimeout(settle, HIDE_WAIT_MS);`,
    to: "      waiting.set(sid, settle);",
  },
  {
    name: "M3-c  the bridge never reports the hide back to the hook",
    file: "extension/src/bridge.js",
    from: `        try {
          window.postMessage({ ns: NS, v: 1, kind: "hidden", sid: d.sid }, "/");
        } catch { /* a page may have replaced postMessage */ }`,
    to: "        /* mutated: the hook is never told */",
  },
  {
    name: "M3-d  release the wait on ANY reply, not the one for this sid",
    file: "extension/src/hook.js",
    from: "        waiting.get(d.sid)?.();",
    to: "        for (const settle of [...waiting.values()]) settle();",
  },

  // SY-* the surface-aware release: the answer to "hiding syncs". Hiding is a
  // bookmark mutation and bookmark mutations sync, so every minute the bar is
  // held down here is a minute it is down on every other signed-in device. A
  // captured Chrome tab cannot show the bar, so that session is handed back at
  // once. Each decision below is one way to get that wrong, and the two
  // directions are NOT symmetric: releasing too eagerly puts bookmarks on a
  // live screen share, and releasing too little is only the old behaviour.
  {
    name: "SY-a  release on ANY surface, not only a captured tab",
    file: "extension/src/hook.js",
    from: "      return track.getSettings?.().displaySurface === TAB_SURFACE;",
    to: "      return true;",
  },
  {
    name: "SY-b  never release: hold the bar down for the whole meeting",
    file: "extension/src/hook.js",
    from: `    startBeat();
    // Last, and only now: the surface is not knowable until the tracks exist.
    // Everything above this line has already run as if the share were unsafe,
    // which is the order that keeps a failure here costing privacy nothing.
    evaluate(sid);
  }`,
    to: `    startBeat();
  }`,
  },
  {
    name: "SY-c  ignore configurationchange (\"Share this tab instead\")",
    file: "extension/src/hook.js",
    from: '        t.addEventListener("configurationchange", () => evaluate(sid));',
    to: "        /* mutated: a surface swap goes unnoticed */",
  },
  {
    name: "SY-d  a released session still demands the bar, so the beat re-hides it",
    file: "extension/src/hook.js",
    from: "    [...live].filter(([, e]) => !e.safe && stillLive(e)).map(([sid]) => sid);",
    to: "    [...live].filter(([, e]) => stillLive(e)).map(([sid]) => sid);",
  },
  {
    name: "SY-e  send a second `end` when an already-released share stops",
    file: "extension/src/hook.js",
    from: `      // A released session was retired in the worker when it was released.
      // Ending it again would wake the worker to do nothing.
      if (!e.safe) post("end", { sid });`,
    to: `      post("end", { sid });`,
  },

  // The other half of the same problem: what we SAY about the hide that is left.
  // A screen or window share still empties the bar on every synced device, and
  // the peer machine is where that is actually felt -- by someone who did not
  // start a share and is looking at an empty bar.
  {
    name: "SY-f  warn about sync on every profile, including ones that do not sync",
    file: "extension/popup.js",
    from: '  $("syncNote").hidden = !s.hidden || !syncs;',
    to: '  $("syncNote").hidden = !s.hidden;',
  },
  {
    name: "SY-g  present a peer's live hide as a recovery offer, as it used to be",
    file: "extension/popup.js",
    from: "    const peer = !p.local && !!p.receipt;",
    to: "    const peer = false;",
  },
  {
    name: "SY-h  offer the confident Restore button on a vault we did not write",
    file: "extension/popup.js",
    from: '    $("adoptBtn").className = p.local ? "btn btn--ghost" : "btn btn--ghost btn--quiet";',
    to: '    $("adoptBtn").className = "btn btn--ghost";',
  },
  {
    name: "SY-i  badge a peer's live hide red, as a fault to go and fix",
    file: "extension/src/sw.js",
    from: "    const attention = !!failure || pending.some((p) => p.local || !p.receipt);",
    to: "    const attention = !!failure || pending.length > 0;",
  },
  {
    name: "SY-j  treat a receiptless vault as provably a peer's, and mute it",
    file: "extension/src/sw.js",
    from: "    const attention = !!failure || pending.some((p) => p.local || !p.receipt);",
    to: "    const attention = !!failure || pending.some((p) => p.local);",
  },

  // M4 -- what the packaged copy is allowed to contain. The developer
  // disclosure is a debugging surface with a forced recover in it, and the
  // difference between "a developer sees this" and "everyone sees this" is one
  // constant that nothing used to check.
  {
    name: "M4-a  ship the developer disclosure to every installed user",
    file: "extension/popup.js",
    from: "const DEV = isUnpackedBuild();",
    to: "const DEV = true;",
  },
  {
    name: "M4-b  hide the disclosure but still wire it, so it is one attribute away",
    file: "extension/popup.js",
    from: '$("dev").hidden = !DEV;\nif (DEV) {',
    to: '$("dev").hidden = !DEV;\nif (true) {',
  },
  {
    name: "M4-c  a manifest that will not read counts as a developer build",
    file: "extension/popup.js",
    from: "    return !(\"update_url\" in chrome.runtime.getManifest());\n  } catch {\n    return false;",
    to: "    return !(\"update_url\" in chrome.runtime.getManifest());\n  } catch {\n    return true;",
  },
];

run(MUTATIONS, { label: "M2", tmpName: "secureshare-mutate-m2" });
