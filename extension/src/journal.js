// Crash-safety journal.
//
// Written to chrome.storage.local BEFORE any bookmark is touched and cleared
// only after a verified restore. Survives service-worker termination, extension
// reload, browser crash, and OS restart -- so any interrupted hide is repaired
// on the next startup instead of leaving bookmarks stranded.

const KEY = "secureshare.journal";

export const State = {
  CLEAR: "clear",
  HIDING: "hiding",
  HIDDEN: "hidden",
  RESTORING: "restoring",
};

export async function read() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] ?? null;
}

export async function write(journal) {
  await chrome.storage.local.set({ [KEY]: journal });
}

export async function setState(state) {
  const j = await read();
  if (!j) return null;
  j.state = state;
  j.updatedAt = Date.now();
  await write(j);
  return j;
}

export async function clear() {
  await chrome.storage.local.remove(KEY);
}

/**
 * `mode` records WHICH mechanism displaced the bar, so restore always matches
 * the hide even if the user flips the tuck toggle mid-share. "vault" moves the
 * bar into an Other-Bookmarks folder (the default); "tuck" parks it into a
 * folder that stays ON the bar. Absent on journals written before tuck-mode
 * existed, which read as "vault" -- the historical behaviour to the byte.
 */
export function create(groups, mode = "vault") {
  return {
    v: 1,
    state: State.HIDING,
    mode,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    groups,
  };
}

/** True when the journal describes bookmarks that are currently displaced. */
export function isDisplaced(journal) {
  return !!journal && journal.state !== State.CLEAR;
}
