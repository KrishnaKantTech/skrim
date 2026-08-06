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

export function create(groups) {
  return {
    v: 1,
    state: State.HIDING,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    groups,
  };
}

/** True when the journal describes bookmarks that are currently displaced. */
export function isDisplaced(journal) {
  return !!journal && journal.state !== State.CLEAR;
}
