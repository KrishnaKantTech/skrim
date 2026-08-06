// The mutation runner, shared by every mutation set.
//
// Each mutation reverts ONE design decision in a scratch copy of the extension
// and requires the suite to go red. A mutation that stays green is not a
// passing test, it is an UNTESTED DECISION: the code could be written either
// way and nothing would notice.
//
// When behaviour changes on purpose the anchor strings stop matching and this
// fails loudly with "anchor not found" -- which is the point. Rewrite the
// mutation to describe the NEW decision rather than deleting it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function apply(dir, m) {
  for (const edit of [m, ...(m.also ?? [])]) {
    const p = path.join(dir, edit.file);
    const src = fs.readFileSync(p, "utf8");
    if (!src.includes(edit.from)) throw new Error(`anchor not found in ${edit.file}`);
    fs.writeFileSync(p, src.replace(edit.from, edit.to));
  }
}

export function run(mutations, { label, tmpName }) {
  const TMP = path.join(os.tmpdir(), tmpName);
  let allCaught = true;

  for (const m of mutations) {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    fs.cpSync(path.join(ROOT, "extension"), path.join(TMP, "extension"), { recursive: true });
    fs.cpSync(path.join(ROOT, "tools"), path.join(TMP, "tools"), { recursive: true });

    let out, caught, detail;
    try {
      apply(TMP, m);
      try {
        out = execFileSync("node", [path.join(TMP, "tools/test-engine.mjs")], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          // A mutation that makes something wait forever cannot fail an
          // assertion: the suite simply never finishes. Hanging IS the red
          // signal there, so it gets a short budget rather than the default.
          timeout: m.timeoutMs ?? 60_000,
        });
      } catch (e) {
        // The suite exits non-zero when red; that IS the signal, not an error.
        out = String(e.stdout ?? "");
        if (!out.includes("assertions failed")) throw e;
      }
      const failed = Number(/assertions failed : (\d+)/.exec(out)?.[1] ?? -1);
      const broken = [...out.matchAll(/NOT repaired\s+: (\d+)/g)].map((x) => Number(x[1]));
      caught = failed > 0 || broken.some((n) => n > 0);
      detail = `${failed} assertion(s) failed` +
        (broken.some((n) => n > 0) ? `, ${broken.join("/")} not repaired` : "");
      if (caught) {
        const names = [...out.matchAll(/✗ (.+)/g)].map((x) => x[1].trim()).slice(0, 3);
        detail += names.length ? ` — ${names.join("; ")}` : "";
      }
    } catch (err) {
      caught = true; // a crash is also a red suite
      detail = `suite crashed: ${String(err.message).split("\n")[0].slice(0, 90)}`;
    }
    if (!caught) allCaught = false;
    console.log(`${caught ? "CAUGHT " : "MISSED "} ${m.name}\n         ${detail}`);
  }

  console.log(
    allCaught ? `\nAll ${label} decisions are load-bearing.` : "\nSOME MUTATIONS SURVIVED."
  );
  process.exit(allCaught ? 0 : 1);
}
