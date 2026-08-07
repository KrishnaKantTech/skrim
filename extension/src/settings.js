// User settings.
//
// One object in chrome.storage.local, read by the engine at hide time and by
// the popup for its toggles. The DEFAULTS are the extension's historical
// behaviour to the byte -- an install that has never opened the settings panel
// behaves exactly as it did before this file existed, which is what keeps the
// live test and the store-install test green without a settings fixture.
//
// Preferences only. The tuck folder's id is STATE, not a preference, so it
// lives with the engine's other bookkeeping (see TUCK_KEY) and is never mixed
// in here -- a wiped preference must never be able to strand a folder.

const KEY = "secureshare.settings";

export const DEFAULTS = {
  // Whether a hide drops the neutral placeholder links on the bar. On by
  // default: a conspicuously empty bar mid-call is its own tell, which is the
  // whole reason the decoys exist. A user who would rather have a truly empty
  // bar can turn them off, and then both the automatic hide and the popup's
  // Hide button leave nothing behind.
  decoys: true,
  // The last name used for the tuck folder, so the panel can pre-fill it. A
  // generic, unremarkable default: a folder called this on the bar draws no
  // second glance, which is the point of the feature.
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
  if (typeof patch?.tuckName === "string") {
    const trimmed = patch.tuckName.trim().slice(0, 60);
    if (trimmed) next.tuckName = trimmed;
  }
  const clean = { decoys: next.decoys, tuckName: next.tuckName };
  await chrome.storage.local.set({ [KEY]: clean });
  return clean;
}
