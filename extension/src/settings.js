// User settings.
//
// One object in chrome.storage.local, read by the engine at hide time and by
// the popup for its toggles. The DEFAULTS are the extension's historical
// behaviour to the byte -- an install that has never opened the settings panel
// behaves exactly as it did before this file existed, which is what keeps the
// live test and the store-install test green without a settings fixture.
//
// Preferences only. `tuckMode` and `tuckName` say HOW the next hide should run;
// the live folder a tuck hide creates is STATE, and lives in the journal with
// the rest of the engine's crash bookkeeping -- so a wiped preference can never
// strand a folder, and a hide in flight is always put back by what it recorded.

const KEY = "secureshare.settings";

export const DEFAULTS = {
  // Whether a hide drops the neutral placeholder links on the bar. On by
  // default: a conspicuously empty bar mid-call is its own tell, which is the
  // whole reason the decoys exist. A user who would rather have a truly empty
  // bar can turn them off, and then both the automatic hide and the popup's
  // Hide button leave nothing behind.
  decoys: true,
  // When on, hiding parks the bar into a folder that STAYS on the bar (see the
  // engine's tuck path) instead of moving items to the Other-Bookmarks vault.
  // Off by default, so an install that never opens the panel keeps the vault
  // behaviour the live and store-install tests were written against. The point
  // of the mode is sync: a second signed-in computer keeps its bookmarks inside
  // the folder rather than watching its bar empty when this one starts sharing.
  tuckMode: false,
  // The name of that folder, and the last one the user typed, so the panel can
  // pre-fill it. A generic, unremarkable default: a folder called this on the
  // bar draws no second glance, which is the point of the feature.
  tuckName: "Bookmarks",
};

/** Every setting, with defaults filled in for anything never written. */
export async function read() {
  try {
    const got = await chrome.storage.local.get(KEY);
    const saved = got[KEY];
    return saved && typeof saved === "object"
      ? { ...DEFAULTS, ...saved }
      : { ...DEFAULTS };
  } catch {
    // A storage read that will not answer must not take a hide down with it:
    // the defaults are the safe behaviour, so fall back to them.
    return { ...DEFAULTS };
  }
}

/**
 * Merge a patch over what is stored and return the result. Only the keys in
 * DEFAULTS are ever persisted, so a stray field from an older or newer build
 * cannot accumulate, and `tuckName` is length-capped because it becomes a
 * folder title the user sees.
 */
export async function write(patch) {
  const cur = await read();
  const next = { ...cur };
  if (typeof patch?.decoys === "boolean") next.decoys = patch.decoys;
  if (typeof patch?.tuckMode === "boolean") next.tuckMode = patch.tuckMode;
  if (typeof patch?.tuckName === "string") {
    const trimmed = patch.tuckName.trim().slice(0, 60);
    if (trimmed) next.tuckName = trimmed;
  }
  const clean = { decoys: next.decoys, tuckMode: next.tuckMode, tuckName: next.tuckName };
  await chrome.storage.local.set({ [KEY]: clean });
  return clean;
}
