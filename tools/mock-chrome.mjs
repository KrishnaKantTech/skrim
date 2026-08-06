// In-memory chrome.bookmarks + chrome.storage.local, good enough to run the
// real engine in Node.
//
// Two capabilities the browser cannot give us:
//   * fault injection -- fail the Nth API call, so every await in hide/restore
//     can be interrupted deterministically and the recovery path proven.
//   * dual move semantics -- chrome.bookmarks.move()'s index handling for a
//     SAME-PARENT move is a known ambiguity. The engine is tested under both
//     interpretations; if it passes both it is correct regardless.

export class MockChrome {
  constructor({ sameParentIndexMode = "before-removal" } = {}) {
    this.sameParentIndexMode = sameParentIndexMode;
    this.nextId = 100;
    this.calls = 0;
    this.failAt = null;
    this.failed = false;
    this.nodes = new Map();
    this.storage = new Map();
    // storage.session is a SEPARATE store with a different lifetime: Chrome
    // wipes it when the browser closes. Sharing one Map with storage.local
    // would make it impossible to test that a share cannot outlive a restart.
    this.sessionStorage = new Map();
    this._alarms = new Map();
    this._listeners = {
      onCreated: [], onRemoved: [], onChanged: [], onMoved: [],
      onAlarm: [], onInstalled: [], onStartup: [], onMessage: [],
      onTabRemoved: [], onTabCreated: [], onTabUpdated: [],
    };
    // Open tabs, by id. Only recorder detection reads these, and all it needs
    // is the URL -- but it needs the URL of ANOTHER extension's page, which is
    // the whole reason the "tabs" permission is now in the manifest.
    this.tabs = new Map();
    this.events = [];
    this.alarmCreates = 0;
    this.badge = { text: null, color: null };
    this.uninstallUrl = null;
    this.tabsCreated = [];
    // The frame a runtime.sendMessage is attributed to. Chrome fills this in
    // from the sending context; tests move it to model a second tab or frame.
    this.sender = { tab: { id: 1 }, frameId: 0 };
    this.inflight = [];

    this._mk("0", null, "", { isRoot: true });
    this._mk("1", "0", "Bookmarks bar", { folderType: "bookmarks-bar", syncing: true });
    this._mk("2", "0", "Other bookmarks", { folderType: "other", syncing: true });
  }

  _mk(id, parentId, title, extra = {}) {
    const node = { dateAdded: Date.now(),
      id, parentId, title, children: [],
      ...extra,
    };
    this.nodes.set(id, node);
    if (parentId) this.nodes.get(parentId).children.push(id);
    return node;
  }

  /** Add a folder/bookmark subtree for test fixtures. */
  seed(parentId, spec, dateAdded = Date.now() - 86400000) {
    const id = String(this.nextId++);
    const node = this._mk(id, parentId, spec.title, {
      url: spec.url,
      unmodifiable: spec.unmodifiable,
      dateAdded,
    });
    for (const c of spec.children ?? []) this.seed(id, c, dateAdded);
    return node;
  }

  _tick() {
    this.calls++;
    if (this.failAt !== null && this.calls === this.failAt) {
      this.failed = true;
      throw new Error(`injected failure at call ${this.calls}`);
    }
  }

  /**
   * Chrome reports every mutation back to the extension, including the
   * extension's OWN. Dispatch is deliberately ASYNCHRONOUS and deliberately
   * ahead of the caller's own await continuation: queueMicrotask schedules the
   * listener before the promise returned by create()/move() resolves, which is
   * the harshest ordering the browser can produce. Synchronous dispatch would
   * hide a whole bug class, because with these events the ORDERING is the bug.
   */
  _emit(kind, ...args) {
    const ls = this._listeners[kind];
    if (!ls || ls.length === 0) return;
    this.events.push({ kind, args });
    for (const f of ls) {
      queueMicrotask(() => {
        try { f(...args); } catch { /* listeners must not break the mutator */ }
      });
    }
  }

  _view(id, recurse = true) {
    const n = this.nodes.get(id);
    if (!n) return null;
    const parent = n.parentId ? this.nodes.get(n.parentId) : null;
    const out = {
      id: n.id,
      parentId: n.parentId ?? undefined,
      title: n.title,
      index: parent ? parent.children.indexOf(n.id) : undefined,
    };
    if (n.url !== undefined) out.url = n.url;
    if (n.folderType) out.folderType = n.folderType;
    if (n.syncing !== undefined) out.syncing = n.syncing;
    if (n.unmodifiable) out.unmodifiable = n.unmodifiable;
    if (n.dateAdded !== undefined) out.dateAdded = n.dateAdded;
    if (n.url === undefined) {
      out.children = recurse ? n.children.map((c) => this._view(c, true)) : [];
    }
    return out;
  }

  /** Structural fingerprint used to assert exact restoration. */
  snapshot(id = "0") {
    const n = this.nodes.get(id);
    const kids = n.children.map((c) => this.snapshot(c));
    return { t: n.title, u: n.url ?? null, c: kids };
  }

  /**
   * Deliver a runtime message the way Chrome does, with a sender. Content
   * scripts are the only callers that carry one, and every share message is
   * identified by it rather than by anything in the payload.
   */
  message(msg, sender = {}) {
    const p = new Promise((resolve, reject) => {
      const ls = this._listeners.onMessage;
      if (ls.length === 0) return reject(new Error("no onMessage listener"));
      ls[0](msg, sender, resolve);
    });
    this.inflight.push(p);
    return p;
  }

  /** Drain messages posted through the page, plus the work they set off. */
  async idle(rounds = 8) {
    for (let i = 0; i < rounds; i++) {
      await new Promise((r) => setTimeout(r, 0));
      const batch = this.inflight.splice(0);
      if (batch.length > 0) await Promise.allSettled(batch);
    }
  }

  /** Close a tab: fires onRemoved for every listener. */
  closeTab(tabId) {
    this.tabs.delete(tabId);
    for (const f of this._listeners.onTabRemoved) f(tabId, { isWindowClosing: false });
  }

  /**
   * Open a tab AT a url, the way chrome.tabs.create does.
   *
   * Chrome hands onCreated a tab whose `url` is still empty and whose
   * `pendingUrl` holds the destination -- the navigation has not committed yet.
   * Modelling that faithfully matters: reading only `url` here would make every
   * recorder test pass against a mock and miss every real recording.
   */
  openTab(tabId, url) {
    this.tabs.set(tabId, { id: tabId, url: "", pendingUrl: url });
    for (const f of this._listeners.onTabCreated) f({ id: tabId, url: "", pendingUrl: url });
    this.tabs.set(tabId, { id: tabId, url });
    return tabId;
  }

  /** An existing tab navigates. Chrome reports the new url in changeInfo. */
  navigateTab(tabId, url) {
    this.tabs.set(tabId, { id: tabId, url });
    for (const f of this._listeners.onTabUpdated) f(tabId, { url }, { id: tabId, url });
  }

  get api() {
    if (this._api) return this._api;
    const self = this;
    const area = (store) => ({
      async get(key) {
        self._tick();
        const keys = typeof key === "string" ? [key] : Object.keys(key ?? {});
        const out = {};
        for (const k of keys) {
          if (store().has(k)) out[k] = JSON.parse(JSON.stringify(store().get(k)));
        }
        return out;
      },
      async set(obj) {
        self._tick();
        for (const [k, v] of Object.entries(obj)) {
          store().set(k, JSON.parse(JSON.stringify(v)));
        }
      },
      async remove(key) {
        self._tick();
        for (const k of (typeof key === "string" ? [key] : key)) store().delete(k);
      },
    });
    return (this._api = {
      bookmarks: {
        async getTree() {
          self._tick();
          return [self._view("0")];
        },
        async getSubTree(id) {
          self._tick();
          const v = self._view(id);
          if (!v) throw new Error("Can't find bookmark for id.");
          return [v];
        },
        onCreated: { addListener: (f) => self._listeners.onCreated.push(f) },
        onRemoved: { addListener: (f) => self._listeners.onRemoved.push(f) },
        onChanged: { addListener: (f) => self._listeners.onChanged.push(f) },
        onMoved: { addListener: (f) => self._listeners.onMoved.push(f) },
        async get(id) {
          self._tick();
          const ids = Array.isArray(id) ? id : [id];
          const out = [];
          for (const i of ids) {
            if (!self.nodes.has(i)) throw new Error("Can't find bookmark for id.");
            out.push(self._view(i, false));
          }
          return out;
        },
        async search(query) {
          self._tick();
          const title = typeof query === "string" ? query : query.title;
          const out = [];
          for (const n of self.nodes.values()) {
            if (n.id === "0") continue;
            if (n.title === title) out.push(self._view(n.id, false));
          }
          return out;
        },
        async create({ parentId, index, title, url }) {
          self._tick();
          const parent = self.nodes.get(parentId);
          if (!parent) throw new Error("Can't find parent bookmark for bookmark.");
          if (parent.url !== undefined) throw new Error("Parent is not a folder.");
          // Chrome REJECTS an out-of-range index; it does not clamp.
          if (index !== undefined && (index < 0 || index > parent.children.length)) {
            throw new Error("Index out of bounds.");
          }
          const id = String(self.nextId++);
          const node = { id, parentId, title, children: [], dateAdded: Date.now() };
          if (url !== undefined) node.url = url;
          self.nodes.set(id, node);
          parent.children.splice(index ?? parent.children.length, 0, id);
          const view = self._view(id);
          self._emit("onCreated", id, view);
          return view;
        },
        async move(id, { parentId, index }) {
          self._tick();
          const node = self.nodes.get(id);
          if (!node) throw new Error("Can't find bookmark for id.");
          if (node.unmodifiable) throw new Error("Can't modify managed bookmark.");
          const oldParent = self.nodes.get(node.parentId);
          const newParent = self.nodes.get(parentId ?? node.parentId);
          if (!newParent) throw new Error("Can't find parent bookmark for bookmark.");
          if (newParent.url !== undefined) throw new Error("Parent is not a folder.");

          // Cycle guard: cannot move a folder into its own subtree.
          let p = newParent;
          while (p) {
            if (p.id === id) throw new Error("Can't move a folder into itself.");
            p = p.parentId ? self.nodes.get(p.parentId) : null;
          }

          const sameParent = oldParent.id === newParent.id;
          const from = oldParent.children.indexOf(id);

          // Chrome REJECTS an out-of-range index rather than clamping it. This
          // is the single most important fidelity detail in this mock: clamping
          // hides the index-cascade bug class entirely.
          const limit = sameParent
            ? newParent.children.length
            : newParent.children.length;
          if (index !== undefined && (index < 0 || index > limit)) {
            throw new Error("Index out of bounds.");
          }

          const oldIndex = from;
          if (sameParent && self.sameParentIndexMode === "before-removal") {
            // Real BookmarkModel::Move -- index is pre-removal, decremented
            // when it sits after the node's own slot.
            let at = index === undefined ? oldParent.children.length : index;
            if (at === from || at === from + 1) return self._view(id); // no-op
            oldParent.children.splice(from, 1);
            if (at > from) at -= 1;
            if (at < 0 || at > oldParent.children.length) throw new Error("Index out of bounds.");
            oldParent.children.splice(at, 0, id);
          } else {
            oldParent.children.splice(from, 1);
            const at = index === undefined ? newParent.children.length : index;
            if (at < 0 || at > newParent.children.length) throw new Error("Index out of bounds.");
            newParent.children.splice(at, 0, id);
            node.parentId = newParent.id;
          }
          const view = self._view(id);
          self._emit("onMoved", id, {
            parentId: node.parentId,
            index: view.index,
            oldParentId: oldParent.id,
            oldIndex,
          });
          return view;
        },
        async removeTree(id) {
          self._tick();
          const node = self.nodes.get(id);
          if (!node) throw new Error("Can't find bookmark for id.");
          if (["0", "1", "2"].includes(id)) throw new Error("Can't modify the root bookmark folders.");
          const kill = (nid) => {
            const n = self.nodes.get(nid);
            if (!n) return;
            for (const c of [...n.children]) kill(c);
            self.nodes.delete(nid);
          };
          const parent = self.nodes.get(node.parentId);
          const at = parent ? parent.children.indexOf(id) : -1;
          if (parent) parent.children.splice(at, 1);
          kill(id);
          // Chrome fires ONE onRemoved for the subtree root, not per descendant.
          self._emit("onRemoved", id, { parentId: node.parentId, index: at });
        },
      },
      storage: {
        local: area(() => self.storage),
        session: area(() => self.sessionStorage),
      },
      // onRemoved carries the id and nothing else, so it needs no permission.
      // query/onCreated/onUpdated report URLs, and those DO need "tabs" -- the
      // recorder detector cannot work without it.
      tabs: {
        onRemoved: { addListener: (f) => self._listeners.onTabRemoved.push(f) },
        onCreated: { addListener: (f) => self._listeners.onTabCreated.push(f) },
        onUpdated: { addListener: (f) => self._listeners.onTabUpdated.push(f) },
        // Deliberately does NOT _tick(): the fault injector counts chrome calls
        // to kill the worker at call N, and a query that runs on every worker
        // wake would renumber every one of those sweeps.
        async query() {
          return [...self.tabs.values()];
        },
        // Recorded, not simulated: the only assertion worth making is WHETHER
        // the recovery page was offered, and on which install reason.
        async create({ url }) {
          self.tabsCreated.push(url);
          return { id: self.tabsCreated.length, url };
        },
      },
      // Keyed by name and actually persisted, so ensureWatchdog's "only create
      // when absent" guard is testable. The old stub looked up a hardcoded key
      // and create() stored nothing, so the guard always saw "absent" and
      // re-created on every wake -- exactly the alarm starvation it exists to
      // prevent, and completely unverified.
      alarms: {
        async get(name) { return self._alarms.get(name); },
        async create(name, info) {
          self.alarmCreates = (self.alarmCreates ?? 0) + 1;
          self._alarms.set(name, { name, ...info });
        },
        async clear(name) { return self._alarms.delete(name); },
        onAlarm: { addListener: (f) => self._listeners.onAlarm.push(f) },
      },
      action: {
        async setBadgeText({ text }) { self.badge.text = text; },
        async setBadgeBackgroundColor({ color }) { self.badge.color = color; },
        async setBadgeTextColor({ color }) { self.badge.textColor = color; },
        // The toolbar icon carries the covered/exposed state as a SHAPE, so
        // which file is on the button is a fact a test can assert on. Stored
        // by its 32px path, which is the one Chrome uses on a retina display.
        async setIcon({ path }) { self.icon = path?.[32] ?? path?.[16] ?? path; },
      },
      runtime: {
        // Truthy while the extension is loaded; the content-script bridge tests
        // it before every send, because after a reload it goes away and
        // touching sendMessage throws into the page.
        id: "secureshare-mock",
        getURL: (p) => `chrome-extension://secureshare-mock/${p}`,
        // Chrome opens this in a tab when the user uninstalls -- the last thing
        // that happens, and the only notice we ever get. Stored so a test can
        // assert what a user would actually have been handed at that moment.
        async setUninstallURL(url) {
          self.uninstallUrl = url;
        },
        // Closes the loop for end-to-end tests: the bridge sends, and the same
        // mock delivers it to the worker's own listener with a sender. `sender`
        // is what identifies the frame, so it is settable per test.
        sendMessage(msg) {
          return self.message(msg, self.sender);
        },
        onInstalled: { addListener: (f) => self._listeners.onInstalled.push(f) },
        onStartup: { addListener: (f) => self._listeners.onStartup.push(f) },
        onMessage: { addListener: (f) => self._listeners.onMessage.push(f) },
      },
    });
  }
}
