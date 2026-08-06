// SecureShare M0 spike probe, v2.
//
// v1 held the "hidden" state for only 8s. Chrome's bookmark file writer turned
// out to be debounced by minutes, so every on-disk snapshot captured identical
// pre-experiment bytes and the fan-out measurement produced nothing.
//
// v2 holds the hidden state until the receiver confirms Chrome has actually
// flushed the Bookmarks file, then restores. A hard cap guarantees restore even
// if the receiver never answers.
//
// Titles and URLs are NEVER transmitted -- only djb2 hashes, enough to prove
// structural equality without exposing bookmark content.

const ENDPOINT = "http://localhost:8765";
const POLL_MS = 5000;
const HARD_CAP_MS = 300000; // 5 min, then restore no matter what

function h(s) {
  let n = 5381;
  for (let i = 0; i < s.length; i++) n = ((n << 5) + n + s.charCodeAt(i)) | 0;
  return (n >>> 0).toString(36);
}

function shape(node) {
  return {
    id: node.id,
    i: node.index,
    t: h(node.title || ""),
    u: node.url ? h(node.url) : null,
    ft: node.folderType ?? null,
    sy: node.syncing ?? null,
    c: (node.children || []).map(shape),
  };
}

async function post(path, body) {
  try {
    await fetch(ENDPOINT + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn("[probe] post failed", path, e.message);
  }
}

// Wait for the receiver to confirm it captured a real on-disk write. Each fetch
// is an extension API call, which also resets the service worker's idle timer --
// that is what keeps the worker alive across a multi-minute hold.
async function waitForGate() {
  const deadline = Date.now() + HARD_CAP_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    polls++;
    await chrome.storage.local.set({ lastPoll: Date.now() }); // keepalive
    try {
      const res = await fetch(`${ENDPOINT}/gate?t=${Date.now()}`);
      const txt = (await res.text()).trim();
      if (txt === "go") return { released: true, polls };
    } catch (e) {
      // receiver down -- keep waiting until the hard cap, then restore
    }
  }
  return { released: false, polls };
}

async function recoverIfNeeded() {
  const { plan } = await chrome.storage.local.get("plan");
  if (!plan) return false;
  console.warn("[probe] stranded plan found, restoring", plan.items.length);
  for (const it of plan.items) {
    try {
      await chrome.bookmarks.move(it.id, { parentId: plan.barId, index: it.index });
    } catch (e) {
      console.error("[probe] recovery move failed", it.id, e.message);
    }
  }
  if (plan.vaultId) {
    try { await chrome.bookmarks.removeTree(plan.vaultId); } catch (e) {}
  }
  await chrome.storage.local.remove("plan");
  await post("/recovered", { items: plan.items.length });
  return true;
}

async function run() {
  if (await recoverIfNeeded()) return;

  const t0 = Date.now();
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0].children || [];

  await post("/start", {
    ua: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? null,
    rootCount: roots.length,
    roots: roots.map((r) => ({
      id: r.id,
      folderType: r.folderType ?? null,
      syncing: r.syncing ?? null,
      topLevel: (r.children || []).length,
    })),
  });

  const bar = roots.find((r) => r.folderType === "bookmarks-bar")
           || roots.find((r) => r.id === "1");
  const other = roots.find((r) => r.folderType === "other")
             || roots.find((r) => r.id === "2");

  if (!bar || !other) {
    await post("/error", { reason: "could not identify bar/other roots" });
    return;
  }

  const before = shape(bar);
  const kids = (bar.children || []).slice();
  if (kids.length === 0) {
    await post("/error", { reason: "bookmarks bar is empty - wrong profile?" });
    return;
  }

  const vault = await chrome.bookmarks.create({
    parentId: other.id,
    title: "M0 probe vault (auto-deleted)",
  });

  await chrome.storage.local.set({
    plan: {
      barId: bar.id,
      vaultId: vault.id,
      items: kids.map((k, i) => ({ id: k.id, index: i })),
    },
  });

  // HIDE
  const tHide = Date.now();
  for (let i = 0; i < kids.length; i++) {
    await chrome.bookmarks.move(kids[i].id, { parentId: vault.id, index: i });
  }
  const hideMs = Date.now() - tHide;

  const midBar = (await chrome.bookmarks.getSubTree(bar.id))[0];
  await post("/moved", {
    moved: kids.length,
    hideMs,
    barChildrenNow: (midBar.children || []).length,
    vaultId: vault.id,
    movedIds: kids.map((k) => k.id),
  });

  const gate = await waitForGate();
  await post("/gate-result", gate);

  // RESTORE
  const tRestore = Date.now();
  for (let i = 0; i < kids.length; i++) {
    await chrome.bookmarks.move(kids[i].id, { parentId: bar.id, index: i });
  }
  const restoreMs = Date.now() - tRestore;

  const after = shape((await chrome.bookmarks.getSubTree(bar.id))[0]);
  try { await chrome.bookmarks.removeTree(vault.id); } catch (e) {}
  await chrome.storage.local.remove("plan");

  const identical = JSON.stringify(before) === JSON.stringify(after);
  await post("/done", {
    identical,
    moved: kids.length,
    hideMs,
    restoreMs,
    heldMs: Date.now() - tHide,
    gateReleased: gate.released,
    totalMs: Date.now() - t0,
    before: identical ? null : before,
    after: identical ? null : after,
  });
  console.log("[probe] done. identical =", identical);
}

// Registered synchronously at top level -- a cold worker misses events otherwise.
chrome.runtime.onInstalled.addListener(() => { run(); });
chrome.runtime.onStartup.addListener(() => { recoverIfNeeded(); });
chrome.action.onClicked.addListener(() => { run(); });
