// Isolate a single fault-injection failure and show exactly what the API call
// sequence was and what state recovery left behind.
import { MockChrome } from "./mock-chrome.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "extension", "src");
const BUILD = fs.mkdtempSync(path.join(os.tmpdir(), "secureshare-dbg-"));
fs.writeFileSync(path.join(BUILD, "package.json"), JSON.stringify({ type: "module" }));
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith(".js")) fs.copyFileSync(path.join(SRC, f), path.join(BUILD, f));
}

const FIXTURE = [
  { title: "Work", children: [{ title: "Docs", url: "https://d.example/1" }] },
  { title: "Headlines", url: "https://n.example/" },
  { title: "Personal", children: [{ title: "Project X", url: "https://x.example/" }] },
  { title: "Reading", url: "https://r.example/" },
];

function build() {
  const m = new MockChrome();
  for (const s of FIXTURE) m.seed("1", s);
  m.seed("2", { title: "Existing other", url: "https://o.example/" });
  return m;
}

function trace(mock) {
  const log = [];
  const api = mock.api;
  for (const [ns, fns] of [["bookmarks", api.bookmarks], ["storage.local", api.storage.local]]) {
    for (const name of Object.keys(fns)) {
      const orig = fns[name];
      if (typeof orig !== "function") continue;
      fns[name] = async (...args) => {
        const n = mock.calls + 1;
        log.push(`${String(n).padStart(3)}  ${ns}.${name}(${JSON.stringify(args).slice(0, 70)})`);
        return orig.apply(fns, args);
      };
    }
  }
  return log;
}

const target = Number(process.argv[2] ?? 16);

// Pass 1: full trace with no fault, to label the call sequence.
{
  const mock = build();
  const log = trace(mock);
  globalThis.chrome = mock.api;
  const engine = await import(`file://${path.join(BUILD, "engine.js")}?a=${Math.random()}`);
  await engine.hide({ decoys: true });
  console.log("=== call sequence during a clean hide ===");
  for (const line of log) console.log(line);
}

// Pass 2: inject the fault and inspect the wreckage.
{
  const mock = build();
  const before = JSON.stringify(mock.snapshot("1"));
  globalThis.chrome = mock.api;
  const engine = await import(`file://${path.join(BUILD, "engine.js")}?b=${Math.random()}`);

  mock.failAt = target;
  let hideErr = null;
  try { await engine.hide({ decoys: true }); } catch (e) { hideErr = String(e.message); }
  console.log(`\n=== after hide with fault at call ${target} ===`);
  console.log("hide threw:", hideErr);
  console.log("journal   :", JSON.stringify(mock.storage.get("secureshare.journal")));
  console.log("bar       :", mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title));
  console.log("other     :", mock.nodes.get("2").children.map((c) => mock.nodes.get(c).title));

  mock.failAt = null;
  const rec1 = await engine.recover();
  console.log("\nrecover() ->", JSON.stringify(rec1));
  const after = JSON.stringify(mock.snapshot("1"));
  console.log("bar after :", mock.nodes.get("1").children.map((c) => mock.nodes.get(c).title));
  console.log("other after:", mock.nodes.get("2").children.map((c) => mock.nodes.get(c).title));
  console.log("\nREPAIRED  :", after === before);
  if (after !== before) {
    console.log("  expected:", before);
    console.log("  actual  :", after);
  }
}

fs.rmSync(BUILD, { recursive: true, force: true });
