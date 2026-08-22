// Mutation testing for the recovery layer -- what happens to a user's
// bookmarks when the extension itself is gone.
//
//   node tools/mutate-recovery.mjs     exit 0 == every decision below is load-bearing
//
// See tools/mutate-run.mjs for how this works and what a MISSED line means.

import { run } from "./mutate-run.mjs";

const MUTATIONS = [
  {
    name: "RC-a  do not write a receipt at all (the pre-fix behaviour)",
    file: "extension/src/engine.js",
    // The loop this names has since been folded into one line; the DECISION it
    // reverts -- write no receipt at all -- is unchanged.
    from: "  for (const entry of entries) {\n    await syncReceipt(j, entry, decoysMade.get(entry) ?? []);",
    to: "  for (const entry of []) {\n    await syncReceipt(j, entry, decoysMade.get(entry) ?? []);",
  },
  {
    name: "RC-b  keep the receipt after a completed restore (never clear the vault)",
    file: "extension/src/engine.js",
    from: "  if (kids.some((k) => !receipt.isReceipt(k))) return false;\n  for (const k of kids) await safeRemoveTree(k.id);",
    to: "  if (kids.length > 0) return false;",
  },
  {
    name: "RC-c  destroy the receipt even while items it describes are still stuck",
    file: "extension/src/engine.js",
    from: "  if (kids.some((k) => !receipt.isReceipt(k))) return false;",
    to: "  for (const k of kids) if (receipt.isReceipt(k)) await safeRemoveTree(k.id);\n  if ((await childrenOrNull(id))?.length) return false;",
  },
  {
    name: "RC-d  hand the receipt back to the user as a bookmark of theirs",
    file: "extension/src/engine.js",
    from: "    const real = kids.filter((k) => !receipt.isReceipt(k));",
    to: "    const real = kids;",
  },
  {
    name: "RC-e  trust ANY receipt as proof of local origin (drop the vault-id check)",
    file: "extension/src/engine.js",
    from: "const isLocalReceipt = (rec, vaultNode) =>\n  !!rec && String(rec.vault) === String(vaultNode?.id);",
    to: "const isLocalReceipt = (rec) => !!rec;",
  },
  {
    name: "RC-f  restore by position in the vault, not by the recorded bar index",
    file: "extension/src/engine.js",
    from: "    index: byId.get(String(k.id)) ?? APPEND,",
    to: "    index: items.indexOf(k),",
  },
  {
    name: "RC-k  sweep an adopted vault by appending, ignoring its receipt",
    file: "extension/src/engine.js",
    from: "      const at = (k) => (byId ? byId.get(String(k.id)) ?? APPEND : APPEND);",
    to: "      const at = () => APPEND;",
  },
  {
    name: "RC-l  leave the decoys behind when the sweep drains a vault",
    file: "extension/src/engine.js",
    from: "    if (exact) await removeDecoysById((rec.decoys ?? []).map(([id]) => String(id)));",
    to: "    /* mutated: the sweep no longer clears its own placeholders */",
  },
  {
    name: "RC-n  trust a foreign receipt for placement (drop the local-origin gate)",
    file: "extension/src/engine.js",
    from: "    const exact = isLocalReceipt(rec, node);",
    to: "    const exact = !!rec;",
  },
  {
    name: "RC-o  delete decoys by id alone, without re-checking what the id names",
    file: "extension/src/engine.js",
    from: "    if (!isDecoyNode(node)) continue; // id remapped by sync -- not ours",
    to: "    /* mutated: the id is taken as authority */",
  },
  {
    name: "RC-g  recognise a receipt by its title alone (so a rename orphans it)",
    file: "extension/src/receipt.js",
    from: "  if (decode(node.url)) return true;\n  return TITLE_MARKS.some",
    to: "  return TITLE_MARKS.some",
  },
  {
    name: "RC-h  register listeners unguarded, so one dead API silences the worker",
    file: "extension/src/sw.js",
    from: "function safely(what, fn) {\n  try {\n    fn();\n  } catch (err) {",
    to: "function safely(what, fn) {\n  if (true) {\n    fn();\n  } else if (false) {\n    const err = null;",
  },
  {
    name: "RC-i  open the recovery page on every install reason, including auto-update",
    file: "extension/src/sw.js",
    from: '  if (reason !== "install") return;',
    to: "  /* mutated: any reason opens a tab */",
  },
  {
    name: "RC-j  set an uninstall URL even when nothing is hidden",
    file: "extension/src/receipt.js",
    from: '  if (!base || !journal || journal.state === "clear") return "";',
    to: "  if (!base) return base;\n  if (!journal) return base;",
  },
];

run(MUTATIONS, { label: "recovery", tmpName: "secureshare-mutate-rc" });
