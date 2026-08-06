// Mutation testing for the X layer -- recorders that live in ANOTHER extension
// and therefore cannot be hooked. Loom is the case it was built for.
//
//   node tools/mutate-recorders.mjs   exit 0 == every decision below is load-bearing
//
// Same discipline as mutate-m2.mjs: each entry reverts one design decision in a
// scratch copy and requires the suite to go red. A mutation that stays green is
// an UNTESTED DECISION -- the code could be written either way and nothing
// would notice. Two here were green when first written: the beat-clock
// exemption (X-3) and the status-only onUpdated guard (X-2) both had no
// coverage until this file demanded it.

import { run } from "./mutate-run.mjs";

const MUTATIONS = [
  {
    // Recorder records have no heartbeat -- there is no hook in another
    // extension's page to send one -- so the 35s beat clock would retire them
    // 35 seconds into a five-minute recording.
    name: "X-a  age recorder records out on the beat clock like any other frame",
    file: "extension/src/sessions.js",
    from: "    if (f.ext) continue;",
    to: "    if (false) continue;",
  },
  {
    // The watchdog re-scans every minute for the whole recording. Re-asserting
    // on a sync that changed nothing would undo the popup's Restore, silently,
    // once a minute, with no way for the user to win.
    name: "X-b  re-assert the hide on every scan, not only on a NEW recording",
    file: "extension/src/sessions.js",
    from: "      return added ? \"hide\" : undefined;",
    to: "      return \"hide\";",
  },
  {
    // chrome.tabs.onCreated fires before the navigation commits: a tab opened
    // AT a url carries it in pendingUrl and `url` is still empty. Reading only
    // `url` misses the start of every recording.
    name: "X-c  read only tab.url on creation, not pendingUrl",
    file: "extension/src/recorders.js",
    from: "  return recorderFor(tab?.url) ?? recorderFor(tab?.pendingUrl);",
    to: "  return recorderFor(tab?.url);",
  },
  {
    // Chrome fires onUpdated many times per page load with no url in
    // changeInfo. Without the guard each one reads as "not a recorder any
    // more" and releases the hide seconds after taking it.
    name: "X-d  act on every onUpdated, not only on a committed navigation",
    file: "extension/src/sw.js",
    from: '    if (typeof changeInfo?.url !== "string") return;',
    to: "    if (false) return;",
  },
  {
    // The pinned tab navigating to loom.com is how a published recording ends.
    // Without this the hide waits for the watchdog, up to a minute later.
    name: "X-e  ignore a recorder tab navigating away (wait for the watchdog)",
    file: "extension/src/sessions.js",
    from: "      delete s.frames[extKey(tabId)];",
    to: "      void tabId;",
  },
  {
    // The scan is the recorder's equivalent of the beat: without it a worker
    // that was asleep when the tab closed holds the bar down for MAX_HIDDEN_MS,
    // and one that woke mid-recording never sees the recording at all.
    name: "X-f  never re-scan tabs on the watchdog",
    file: "extension/src/sw.js",
    from: "  await scanRecorderTabs();",
    to: "  await Promise.resolve();",
  },
  {
    // MV3 kills the worker after ~30s idle and a recording runs for minutes, so
    // booting INTO a live recording is the common case, not the exotic one.
    name: "X-g  do not scan on worker wake, only on the alarm",
    file: "extension/src/sw.js",
    from: '  scanRecorderTabs().catch((e) => console.error("[secureshare] recorder scan", e));',
    to: "  void scanRecorderTabs;",
  },
  {
    // Matching the extension id alone would hold the bar down for every
    // ordinary page Loom opens -- its log viewer, its video preview.
    name: "X-h  match the recorder extension by id alone, ignoring the path",
    file: "extension/src/recorders.js",
    from: "    if (r.paths.some((p) => path.startsWith(p))) return r;",
    to: "    return r;",
  },
  {
    // A page URL that merely contains the string, or a 32-char lookalike on
    // another scheme, must never read as a capture page.
    name: "X-i  match the capture page anywhere in the url, not anchored",
    file: "extension/src/recorders.js",
    from: "const EXT_URL = /^chrome-extension:\\/\\/([a-p]{32})(\\/[^?#]*)/;",
    to: "const EXT_URL = /chrome-extension:\\/\\/([a-p]{32})(\\/[^?#]*)/;",
  },
  {
    // A recorder ending must not expose a Meet call running at the same time.
    // Covered by the shared session count -- this proves recorder records
    // actually participate in it rather than driving hide/restore themselves.
    name: "X-j  count a recorder as zero sessions",
    file: "extension/src/sessions.js",
    from: "      f.sids = [EXT_SID];\n      return \"hide\";",
    to: "      f.sids = [];\n      return \"hide\";",
  },
];

run(MUTATIONS, { label: "X", tmpName: "secureshare-mutate-recorders" });
