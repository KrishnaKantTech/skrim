// Mutation testing for the LIVE SETTINGS layer -- the switches that change the
// hide that is already running.
//
//   node tools/mutate-live.mjs      exit 0 == every decision below is load-bearing
//
// Each entry reverts ONE design decision in a scratch copy of the extension and
// requires the suite to go red. A mutation that stays green is not a passing
// test, it is an UNTESTED DECISION: the code could be written either way and
// nothing would notice.
//
// The decisions here are unusually worth pinning, because every one of them is
// exercised while a user's bookmarks are off the bar and a call is on screen.
// L-e in particular was not a hypothetical: the missing `decoyIds` seed was a
// real bug this suite caught the first time it ran.
//
// When behaviour changes on purpose the anchor strings stop matching and this
// fails loudly with "anchor not found" -- which is the point. Rewrite the
// mutation to describe the NEW decision rather than deleting it.

import { run } from "./mutate-run.mjs";

const MUTATIONS = [
  {
    name: "L-a  a switch only ever describes the NEXT hide, never the live one",
    file: "extension/src/engine.js",
    from: `async function retuneLive(patch, saved) {
  const j = await liveHide();
  if (!j) return null;`,
    to: `async function retuneLive(patch, saved) {
  const j = await liveHide();
  if (j) return null;
  if (!j) return null;`,
  },
  {
    name: "L-b  move items between hiding places VIA the bar, one stop on screen",
    file: "extension/src/engine.js",
    from: `      try {
        await bmMove(item.id, { parentId: entry.folderId });
        moved++;`,
    to: `      try {
        await bmMove(item.id, { parentId: entry.barId });
        await bmMove(item.id, { parentId: entry.folderId });
        moved++;`,
  },
  {
    name: "L-c  the vault restore leaves a half-switched tuck folder on the bar",
    file: "extension/src/engine.js",
    from: `  // And any folder a half-finished switch to tuck mode left on the bar. A
  // classic vault hide journals neither a folderId nor a folderTitle, so this
  // is a no-op for every hide that was never converted.
  await dropTuckFolders(j);`,
    to: `  // And any folder a half-finished switch to tuck mode left on the bar. A
  // classic vault hide journals neither a folderId nor a folderTitle, so this
  // is a no-op for every hide that was never converted.`,
  },
  {
    name: "L-d  convert a hide the user has already dragged bookmarks out of",
    file: "extension/src/engine.js",
    from: `  if (!(await stillHidden(j))) return { converted: false, reason: "exposed" };`,
    to: `  if (false) return { converted: false, reason: "exposed" };`,
  },
  {
    name: "L-e  assume every journal entry already has a decoyIds array",
    file: "extension/src/engine.js",
    from: `  entry.decoyIds = entry.decoyIds ?? [];
  entry.decoyPhase = true;`,
    to: `  entry.decoyPhase = true;`,
  },
  {
    name: "L-f  leave the receipt naming placeholders that no longer exist",
    file: "extension/src/engine.js",
    from: `    if (entry.receiptId && (await bmUpdate(entry.receiptId, { title, url }))) return true;`,
    to: `    if (entry.receiptId) return true;`,
  },
  {
    name: "L-g  edit a hide that is still mid-flight, not just a settled one",
    file: "extension/src/engine.js",
    from: `  if (j.state !== journal.State.HIDDEN) return null;`,
    to: `  if (false) return null;`,
  },
  {
    name: "L-h  the popup reports a refused conversion as if it had worked",
    file: "extension/popup.js",
    from: `  if (live.error || live.converted === false) {`,
    to: `  if (false) {`,
  },
];

run(MUTATIONS, { label: "live-settings", tmpName: "secureshare-mutate-live" });
