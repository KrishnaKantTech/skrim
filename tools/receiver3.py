#!/usr/bin/env python3
"""Step 4 — cross-client sync convergence test.

Two Chrome clients signed into one account:
  MAIN = ~/Library/.../Chrome/Profile 1        (we mutate here)
  TEST = <repo>/.test-chrome/Default           (passive observer)

The probe hides bookmarks on MAIN and holds. This receiver watches TEST's
Bookmarks file until the hidden state propagates, snapshots both, releases the
gate, then watches TEST until the restore propagates. Answers the question M0
could not: does a hide/restore round trip converge cleanly on a second client?
"""
import http.server, json, os, shutil, threading, time, sys

PORT = 8765
MAIN = os.path.expanduser("~/Library/Application Support/Google/Chrome/Profile 1/Bookmarks")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST = os.path.join(ROOT, ".test-chrome", "Default", "Bookmarks")
SNAPS = os.path.join(ROOT, "snapshots")
LOG = os.path.join(SNAPS, "step4-log.jsonl")

PROPAGATE_TIMEOUT = 150   # under the probe's 300s hard cap
POLL = 1.0

gate_open = False


def bar_count(path):
    """Top-level children of the bookmarks bar, or None if unreadable."""
    try:
        with open(path) as fh:
            d = json.load(fh)
        return len((d["roots"]["bookmark_bar"].get("children") or []))
    except Exception:
        return None


def snap(which, tag):
    src = MAIN if which == "main" else TEST
    dest = os.path.join(SNAPS, f"s4-{which}-{tag}.json")
    try:
        shutil.copy(src, dest)
        return True
    except Exception as e:
        print(f"  [snap:{which}-{tag}] FAILED {e}", flush=True)
        return False


def watch_test(target, label):
    """Poll TEST's bar count until it reaches target. Returns seconds, or None."""
    start = time.time()
    last = None
    print(f"  watching TEST for bar_count=={target} ({label})...", flush=True)
    while time.time() - start < PROPAGATE_TIMEOUT:
        n = bar_count(TEST)
        if n != last:
            print(f"    t+{time.time()-start:5.1f}s  TEST bar_count={n}", flush=True)
            last = n
        if n == target:
            return time.time() - start
        time.sleep(POLL)
    print(f"    TIMEOUT after {PROPAGATE_TIMEOUT}s (last seen {last})", flush=True)
    return None


def phase_hidden():
    global gate_open
    t = watch_test(0, "hide propagating")
    snap("main", "during"); snap("test", "during")
    if t is not None:
        print(f"  >>> HIDE propagated to TEST in {t:.1f}s", flush=True)
    else:
        print("  >>> HIDE did NOT propagate within timeout", flush=True)
    with open(LOG, "a") as fh:
        fh.write(json.dumps({"phase": "hidden", "propagate_s": t}) + "\n")
    gate_open = True
    print("  gate OPEN -> probe will restore", flush=True)


def phase_restored(expected):
    t = watch_test(expected, "restore propagating")
    snap("main", "after"); snap("test", "after")
    if t is not None:
        print(f"  >>> RESTORE propagated to TEST in {t:.1f}s", flush=True)
    else:
        print("  >>> RESTORE did NOT propagate within timeout", flush=True)
    with open(LOG, "a") as fh:
        fh.write(json.dumps({"phase": "restored", "propagate_s": t}) + "\n")
    print("\n=== STEP 4 COMPLETE - run analyse4.py ===", flush=True)


class H(http.server.BaseHTTPRequestHandler):
    def _send(self, body=b"ok"):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send()

    def do_GET(self):
        self._send(b"go" if (gate_open and self.path.startswith("/gate")) else b"wait")

    def do_POST(self):
        global gate_open
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except Exception:
            body = {"_raw": raw}
        print(f"\n[{time.strftime('%H:%M:%S')}] {self.path}", flush=True)
        print("  " + json.dumps(body)[:900], flush=True)
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"t": time.time(), "path": self.path, "body": body}) + "\n")
        self._send()

        if self.path == "/start":
            gate_open = False
            snap("main", "before"); snap("test", "before")
            print(f"  baseline  MAIN bar={bar_count(MAIN)}  TEST bar={bar_count(TEST)}", flush=True)
        elif self.path == "/moved":
            threading.Thread(target=phase_hidden, daemon=True).start()
        elif self.path == "/done":
            n_expected = body.get("moved", 12)
            threading.Thread(target=phase_restored, args=(n_expected,), daemon=True).start()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    for p, name in ((MAIN, "MAIN"), (TEST, "TEST")):
        if not os.path.exists(p):
            sys.exit(f"{name} Bookmarks not found: {p}")
    open(LOG, "w").close()
    print(f"MAIN bar_count = {bar_count(MAIN)}")
    print(f"TEST bar_count = {bar_count(TEST)}")
    print(f"Listening on http://localhost:{PORT} — click the probe icon in Profile 1.", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
