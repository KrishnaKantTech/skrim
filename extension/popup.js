// Skrim popup.
//
// A thin view over two worker messages -- `status` (the journal) and `shares`
// (what the MAIN-world hook is seeing). Everything on screen is derived from
// those two in one place, `render`, so a state can never be half-applied: no
// handler pokes at the DOM directly.
//
// The developer disclosure keeps the M2 debug affordances (the no-decoy hide,
// the forced recover, the raw response) that the live test and manual walks
// depend on -- kept for an unpacked copy, off for an installed one. See `DEV`.

const $ = (id) => document.getElementById(id);

const POLL_MS = 1800;

/**
 * Is this a copy of the extension that did NOT come from the Web Store?
 *
 * Chrome injects `update_url` into the manifest it hands back for a store
 * install and omits it for one loaded unpacked. That is the whole signal, and it
 * is the right shape for this: synchronous, no permission to justify in the
 * listing, and no build step to forget to run before packaging.
 *
 * Read so that every uncertain answer -- no `chrome`, no `getManifest`, a
 * manifest that will not read -- lands on `false`. The two ways of being wrong
 * do not cost the same: hiding this from a developer costs them the preview
 * harness, and showing it to a user puts Force restore next to their bookmarks.
 */
function isUnpackedBuild() {
  try {
    return !("update_url" in chrome.runtime.getManifest());
  } catch {
    return false;
  }
}

const DEV = isUnpackedBuild();

function send(type, extra = {}) {
  return chrome.runtime.sendMessage({ type, ...extra });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function when(ts) {
  if (!ts) return "unknown time";
  return new Date(ts).toLocaleString();
}

/** Elapsed, for the "Hidden for" row. Coarse on purpose -- it is reassurance,
 *  not a stopwatch, and a ticking seconds counter reads as alarm. */
function elapsed(ts) {
  if (!ts) return "—";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return plural(mins, "min");
  const hrs = Math.floor(mins / 60);
  return `${plural(hrs, "hr")} ${mins % 60}m`;
}

/** Frames are keyed `tabId:frameId`; one conferencing tab routinely reports
 *  several. Users count tabs, so collapse to the tab before showing it. */
function tabsSharing(shares) {
  const tabs = new Set();
  for (const f of shares?.frames ?? []) tabs.add(String(f.frame).split(":")[0]);
  return tabs.size;
}

/** Chrome can present two bars at once (local + account) and shows them merged,
 *  so the user gets the merged number. The per-bar split, and which one syncs,
 *  stays in the developer response where it is a debugging fact, not a UI one. */
function barSummary(bars) {
  if (!bars?.length) return "—";
  if (bars.some((b) => b.children === null)) return "unreadable";
  return plural(
    bars.reduce((n, b) => n + b.children, 0),
    "item",
  );
}

// ---------------------------------------------------------------- the view

/**
 * The four things this popup can be showing, in priority order: mid-operation,
 * hidden, sharing-with-the-bar-still-up, and at rest. `exposed` is the only one
 * that is a problem -- but it does not get a red button. Flare marks the state
 * you are in; green marks the way out of it, so "Hide now" is the same green
 * fill as "Hide bookmarks". The button colour answers "what should I press",
 * not "how bad is this", and the hero, the pill and the headline have already
 * answered the second question three times over.
 */
function derive(s, shares) {
  const sharing = tabsSharing(shares);
  const busy = s.state === "hiding" || s.state === "restoring";

  if (busy) {
    const hiding = s.state === "hiding";
    return {
      tone: "busy",
      title: hiding ? "Hiding your bookmarks…" : "Putting them back…",
      sub: hiding
        ? "Clearing the bar and parking everything in a private folder."
        : "Rebuilding your bar the way you left it.",
      action: null,
      label: hiding ? "Hiding…" : "Restoring…",
      sharing,
    };
  }

  if (s.hidden) {
    return {
      tone: "shielded",
      title: "Bookmarks hidden",
      sub: sharing
        ? `Screen sharing is live in ${plural(sharing, "tab")}. Your bar is clear.`
        : "Hidden by you. Nothing is sharing right now.",
      action: "restore",
      label: "Restore bookmarks",
      sharing,
    };
  }

  if (sharing > 0) {
    return {
      tone: "exposed",
      title: "Your bar is exposed",
      sub: `Screen sharing is live in ${plural(sharing, "tab")}, but your bookmarks are still on the bar.`,
      action: "hide",
      label: "Hide now",
      sharing,
    };
  }

  return {
    tone: "armed",
    title: "Bookmarks visible",
    sub: "Auto-hide is armed. Your bar clears the moment a screen share starts.",
    action: "hide",
    label: "Hide bookmarks",
    sharing,
  };
}

function render(s, shares, failure) {
  const v = derive(s, shares);

  $("hero").dataset.tone = v.tone;
  $("heroTitle").textContent = v.title;
  $("heroSub").textContent = v.sub;

  // The pill is the second, independent carrier of the same state, and it
  // carries a word as well as a colour. Note it is NOT keyed on "is something
  // sharing": a share running while the bar is already clear is the state this
  // product exists to produce, so it is green. Only a share with the bookmarks
  // still up is flare.
  const pill = $("pill");
  const covered = v.tone === "shielded";
  pill.dataset.tone =
    v.tone === "exposed" ? "exposed" : covered ? "covered" : "idle";
  $("pillText").textContent =
    v.sharing > 0 ? `Sharing · ${v.sharing}` : covered ? "Hidden" : "Armed";

  // `data-action` is what styles the button, not just what it does: "hide" is
  // the green fill that moves towards cover, "restore" is the quiet outline
  // that lifts the scrim.
  const primary = $("primary");
  $("primaryLabel").textContent = v.label;
  primary.disabled = !v.action;
  primary.dataset.action = v.action ?? "";
  if (v.tone === "busy") primary.dataset.busy = "";
  else delete primary.dataset.busy;

  $("sharing").textContent = v.sharing === 0 ? "None" : plural(v.sharing, "tab");
  $("count").textContent = s.hidden ? plural(s.itemsDisplaced, "bookmark") : "None";
  $("bars").textContent = barSummary(s.bars);

  $("sinceRow").hidden = !s.hidden || !s.since;
  if (s.since) $("since").textContent = elapsed(s.since);

  // Only warn the people it is true for. `syncing === false` is a definitive
  // "this bar does not sync" -- signed out, or bookmark sync switched off -- and
  // telling that user their other devices are affected is a scare about devices
  // they do not have. null/undefined is an older Chrome that does not report the
  // flag at all, and that says it: being wrong in the other direction is exactly
  // the surprise this note exists to prevent.
  const syncs = (s.bars ?? []).some((b) => b.syncing !== false);
  $("syncNote").hidden = !s.hidden || !syncs;
  // A tuck hide syncs too, but as a folder that STAYS on the bar -- so the note
  // is reassurance, not a warning: other devices keep their bookmarks. The vault
  // hide gets the original "your bar goes empty everywhere" caution.
  $("syncNoteText").textContent =
    s.hidden && s.mode === "tuck"
      ? "This hide stays on your bar and syncs as a folder, so your other signed-in computers keep their bookmarks instead of watching the bar clear."
      : "Hiding syncs. Your bar stays empty on every signed-in device until you restore.";
  $("dirtyNote").hidden = !(s.hidden && s.dirty);

  // Unowned vaults, which are two completely different stories wearing the same
  // shape: our own bookmarks left parked by a reinstall, or -- far more often --
  // this machine's half of a screen share happening on another computer.
  const pending = s.pendingAdoption ?? [];
  $("adopt").hidden = pending.length === 0;
  if (pending.length > 0) {
    const p = pending[0];
    // `local` is proof, not a guess: the folder's receipt names its own vault
    // id, and bookmark ids are profile-local, so it can only have been written
    // here. That distinction is the difference between "your reinstall found
    // your own bookmarks" and "do not touch another machine's live hide".
    // Three origins, not two. `local` answers "was this written here?" and a
    // vault with no receipt at all answers false to that without being a peer's
    // -- it could be ours from before receipts existed, or one whose receipt was
    // deleted. Claiming "another device is sharing" there would be a confident
    // lie, so it keeps the older, vaguer wording. Both non-local cases get the
    // demoted button: not knowing is a reason for caution, not for confidence.
    const peer = !p.local && !!p.receipt;
    $("adopt").dataset.origin = p.local ? "mine" : peer ? "peer" : "unknown";
    // count is null when the folder would not read back. Saying "0 bookmarks"
    // there would be the exact opposite of the truth.
    const what = typeof p.count === "number" ? plural(p.count, "bookmark") : "Bookmarks";
    // Every sentence below is built around that count, so the verb and the
    // pronoun have to agree with it -- "1 bookmark are sitting" is the copy a
    // user meets at the one moment they are already worried their bookmarks are
    // gone, which is the worst possible moment to look unfinished. The unknown
    // count reads as plural, because "Bookmarks" is.
    const one = p.count === 1;

    $("adoptHead").textContent = peer
      ? "Hidden by another device"
      : "Hidden bookmarks found";
    $("adoptDetail").textContent = peer
      ? `${what} ${one ? "was" : "were"} moved off your bar by Chrome Sync ${when(p.hidAt ?? p.dateAdded)}.`
      : `${what} ${one ? "is" : "are"} sitting in a Skrim folder created ${when(p.hidAt ?? p.dateAdded)}.`;
    // Lead with the overwhelmingly likely truth. An empty bar with no
    // explanation is the whole complaint; making the user deduce it from "this
    // folder was not created by this installation" was not an explanation.
    $("adoptOrigin").textContent = p.local
      ? "Hidden on this computer and never put back — most likely a reinstall. " +
        (one
          ? "It can go back exactly where it was."
          : "They can go back exactly where they were.")
      : peer
        ? "Another computer signed into this Chrome profile is screen sharing " +
          "right now, and hiding syncs. Your bar comes back on its own the " +
          "moment that share ends — you do not have to do anything."
        : "This folder was not created by this installation. Restore it only if " +
          "you are not screen sharing on another device right now.";
    // Demoted, not removed. On a live peer share this is the one button that
    // does harm -- it syncs the bookmarks back onto the bar the other machine
    // is presenting, and a restore is never re-hidden -- but it is still the
    // only way out if that machine crashed or was uninstalled mid-share.
    $("adoptBtn").textContent = p.local
      ? "Put them back exactly"
      : "Put them back anyway";
    $("adoptBtn").className = p.local ? "btn btn--ghost" : "btn btn--ghost btn--quiet";
    $("adoptCaveat").hidden = !!p.local;
    $("adoptBtn").dataset.id = p.id;
  }

  const has = failure && typeof failure === "object" && failure.at;
  $("failure").hidden = !has;
  if (has) {
    $("failureDetail").textContent =
      `${when(failure.at)} — gave up after ${plural(failure.attempts, "attempt")}. ` +
      `Restored ${failure.restored ?? 0}, ` +
      `${failure.stuck?.length ?? 0} stuck, ` +
      `${failure.missing?.length ?? 0} missing, ` +
      `${failure.decoysStuck?.length ?? 0} decoys left behind.`;
  }
}

function renderError(err) {
  $("hero").dataset.tone = "exposed";
  $("heroTitle").textContent = "Can't reach Skrim";
  $("heroSub").textContent =
    "The background service worker did not answer. Reload the extension and try again.";
  $("primary").disabled = true;
  $("pill").dataset.tone = "off";
  $("pillText").textContent = "Offline";
  show({ error: String(err?.message ?? err) });
}

// --------------------------------------------------------------- plumbing

function show(result) {
  $("out").textContent = JSON.stringify(result, null, 2);
}

// Guards the poll against an in-flight hide/restore: a refresh landing on top
// of a half-finished operation would flicker the hero back and forth.
let busy = false;

async function refresh() {
  try {
    const [s, shares, failure] = await Promise.all([
      send("status"),
      send("shares"),
      send("lastFailure"),
    ]);
    render(s, shares, failure);
    return s;
  } catch (err) {
    renderError(err);
  }
}

async function run(type, extra) {
  if (busy) return;
  busy = true;
  $("primary").dataset.busy = "";
  $("primary").disabled = true;
  const t0 = performance.now();
  try {
    const res = await send(type, extra);
    show({ ms: Math.round(performance.now() - t0), ...res });
  } catch (err) {
    show({ error: String(err?.message ?? err) });
  } finally {
    busy = false;
    await refresh();
  }
}

$("primary").onclick = (e) => {
  const action = e.currentTarget.dataset.action;
  // `conceal`, not `hide`: the one Hide button honours BOTH the user's settings
  // -- decoys, and the tuck toggle that hides into a folder instead of the vault
  // -- exactly as an automatic hide does. The developer panel below keeps the
  // raw vault `hide` with its explicit decoy override.
  if (action === "hide") run("conceal");
  else if (action === "restore") run("restore");
};

$("adoptBtn").onclick = (e) => run("adoptVault", { id: e.currentTarget.dataset.id });

// The recovery page is the same job with room to explain it -- and, unlike this
// popup, it keeps working when the service worker will not start.
$("adoptMore").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("recovery.html") });
$("dismissFailure").onclick = () => run("dismissFailure");
$("panic").onclick = () => run("recover");

// The disclosure is both hidden AND left unwired on an installed copy. Hiding
// alone would satisfy the eye; not binding the handlers is what means a shipped
// popup has no path to `recover()` at all -- no keyboard reach, no devtools
// click, nothing for a stray `hidden = false` to expose. `#out` stays in the
// document either way, so `show()` and `renderError()` need no guard.
$("dev").hidden = !DEV;
if (DEV) {
  $("hide").onclick = () => run("hide", { options: { decoys: true } });
  $("hideNoDecoy").onclick = () => run("hide", { options: { decoys: false } });
  $("restore").onclick = () => run("restore");
  $("forceRestore").onclick = () => run("recover");

  $("copyOut").onclick = async (e) => {
    await navigator.clipboard.writeText($("out").textContent).catch(() => {});
    const btn = e.currentTarget;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = "Copy"), 1200);
  };
}

// ---------------------------------------------------------- settings & backup
//
// Shown to every copy, not just an unpacked one -- these are product controls,
// not debug ones. The panel talks to the worker with the same `send` the rest
// of the popup uses, so nothing here reaches chrome.bookmarks or storage
// directly, and its state is loaded lazily the first time it opens rather than
// on every poll. Every handler is a property assignment, never addEventListener,
// so the popup still imports cleanly under the headless render the suite uses.

/** Briefly swap a button's label to acknowledge an action, then restore it. */
function flash(btn, text, ms = 1300) {
  const original = btn.dataset.label ?? btn.textContent;
  btn.dataset.label = original;
  btn.textContent = text;
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    btn.textContent = btn.dataset.label ?? original;
    delete btn.dataset.label;
  }, ms);
}

let settingsLoaded = false;

async function loadSettingsPanel() {
  try {
    const [cfg, s] = await Promise.all([send("getSettings"), send("status")]);
    renderSettings(cfg, s);
    settingsLoaded = true;
  } catch {
    /* leave the controls at their markup defaults */
  }
}

// The decoy hint's default copy, restated here for the same reason renderSettings
// restates the tuck hint: the panel owns the text once it has loaded.
const DECOY_HINT =
  "Leave a few neutral bookmarks on the bar while it's hidden. A bar that goes suddenly empty is its own giveaway.";

/**
 * Placeholder links only exist to fill a bar that a VAULT hide leaves empty. A
 * tuck hide leaves the folder on the bar instead, so decoys never run in that
 * mode. Reflect that by greying the toggle and saying why -- WITHOUT touching the
 * stored `decoys` preference, so it returns intact when tuck mode is turned off.
 */
function applyDecoyAvailability(tuckOn) {
  $("decoyToggle").disabled = tuckOn;
  $("decoyHint").textContent = tuckOn
    ? "Not used while the bar tucks into a folder — the folder is the cover."
    : DECOY_HINT;
}

function renderSettings(cfg, s) {
  const hidden = !!s?.hidden;

  // The real stored value either way -- greyed while tucking, never overwritten.
  if (cfg && typeof cfg.decoys === "boolean") $("decoyToggle").checked = cfg.decoys;

  // The tuck toggle and its folder name are both preferences that take effect on
  // the NEXT hide, never the current one -- a live hide is put back by whatever
  // the journal recorded, not by these -- so both stay editable while hidden.
  if (cfg && typeof cfg.tuckMode === "boolean") $("tuckToggle").checked = cfg.tuckMode;
  $("tuckToggle").disabled = false;
  applyDecoyAvailability(!!cfg?.tuckMode);
  // Do not stomp on a name the user is mid-way through typing.
  if (document.activeElement !== $("tuckName")) $("tuckName").value = cfg?.tuckName ?? "";
  $("tuckName").disabled = false;
  // When the current hide IS a tuck, the hint by the field says so.
  $("tuckHint").textContent =
    hidden && s?.mode === "tuck"
      ? `Your bar is tucked into “${cfg?.tuckName ?? "a folder"}”. It comes back out the moment you restore.`
      : "When you hide, park the bar inside one folder that stays put instead of clearing it — so your other synced computers keep their bookmarks.";

  // Only the backup copy actually needs a visible bar; keep its lock and note.
  $("copyBtn").disabled = hidden;
  $("settingsLocked").hidden = !hidden;
}

// Lazy: the first open loads the real state; later opens are left as the user
// last saw them, and any action re-renders from the worker's reply anyway.
$("settings").ontoggle = (e) => {
  if (e.currentTarget.open && !settingsLoaded) loadSettingsPanel();
};

$("decoyToggle").onchange = async (e) => {
  const decoys = !!e.currentTarget.checked;
  await send("setSettings", { patch: { decoys } }).catch(() => {});
};

// The tuck toggle just arms the mode; nothing moves until the next hide, so this
// only writes the preference -- and greys the placeholder-links control, which
// does not apply while tucking, live before the round trip.
$("tuckToggle").onchange = async (e) => {
  const tuckMode = !!e.currentTarget.checked;
  applyDecoyAvailability(tuckMode);
  await send("setSettings", { patch: { tuckMode } }).catch(() => {});
};

// The folder name has no submit -- whatever is in the box is what the next tuck
// uses -- so it is saved as the user types (debounced), and again on blur to
// catch the final keystroke. An empty box is ignored by the worker, which keeps
// the last good name.
let tuckNameTimer = null;
function saveTuckName() {
  clearTimeout(tuckNameTimer);
  return send("setSettings", { patch: { tuckName: $("tuckName").value } }).catch(() => {});
}
$("tuckName").oninput = () => {
  clearTimeout(tuckNameTimer);
  tuckNameTimer = setTimeout(saveTuckName, 400);
};
$("tuckName").onblur = saveTuckName;

$("copyBtn").onclick = async (e) => {
  const btn = e.currentTarget;
  const res = await send("exportBar", { format: "text" }).catch(() => null);
  if (res?.ok && res.data) {
    const wrote = await navigator.clipboard
      .writeText(res.data)
      .then(() => true)
      .catch(() => false);
    flash(btn, wrote ? "Copied ✓" : "Press ⌘/Ctrl+C");
  } else {
    flash(btn, res?.hidden ? "Restore first" : "Nothing to copy");
  }
};

// Download and import need a file dialog, which would close this popup out from
// under them -- so they live on a full page the popup opens.
$("backupBtn").onclick = () =>
  chrome.tabs.create({ url: chrome.runtime.getURL("backup.html") });

// A share can start while the popup is open, so the popup follows it. Gated on
// visibility: as a real popup it is always visible and always polling, but the
// live test opens popup.html as a background tab and must not be taxed for it.
let timer = null;

function poll() {
  clearInterval(timer);
  if (document.visibilityState !== "visible") return;
  timer = setInterval(() => {
    if (!busy) refresh();
  }, POLL_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
  poll();
});

// The first render is the popup reporting a state that already existed, not a
// change -- so it lands without motion, and transitions are armed on the next
// frame for the changes that follow. See `.booting` in popup.css.
refresh().finally(() =>
  requestAnimationFrame(() => document.body.classList.remove("booting")),
);
poll();
