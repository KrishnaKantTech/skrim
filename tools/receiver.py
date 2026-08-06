#!/usr/bin/env python3
"""SecureShare M0 probe receiver, v2.

v1 snapshotted the Bookmarks file a fixed 2.5s after each webhook. Chrome's
bookmark writer is debounced by minutes, so every snapshot captured identical
pre-experiment bytes.

v2 polls the file's mtime while the probe holds the hidden state, snapshots only
after a confirmed write, then releases the gate so the probe restores.
"""
import http.server, json, os, shutil, threading, time, sys

PORT = 8765
PROFILE = os.path.expanduser("~/Library/Application Support/Google/Chrome/Profile 1")
BOOKMARKS = os.path.join(PROFILE, "Bookmarks")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SNAPS = os.path.join(ROOT, "snapshots")
LOG = os.path.join(SNAPS, "probe-log.jsonl")

WAIT_CAP = 270  # under the probe's 300s hard cap
POLL = 2.0

gate_open = False
baseline_mtime = None


def snap(tag):
    dest = os.path.join(SNAPS, f"snap-{tag}.json")
    shutil.copy(BOOKMARKS, dest)  # copy, not copy2 -- do not inherit mtime
    print(f"  [snap:{tag}] {os.path.getsize(dest)} bytes  "
          f"src_mtime={time.strftime('%H:%M:%S', time.localtime(os.path.getmtime(BOOKMARKS)))}",
          flush=True)


def wait_for_write_then_release():
    """Poll until Chrome actually rewrites Bookmarks, then snapshot and open the gate."""
    global gate_open
    start = time.time()
    print(f"  waiting for Chrome to flush Bookmarks (baseline mtime "
          f"{time.strftime('%H:%M:%S', time.localtime(baseline_mtime))})...", flush=True)
    while time.time() - start < WAIT_CAP:
        time.sleep(POLL)
        try:
            mt = os.path.getmtime(BOOKMARKS)
        except OSError:
            continue
        if mt > baseline_mtime:
            elapsed = time.time() - start
            print(f"  FLUSH DETECTED after {elapsed:.1f}s", flush=True)
            time.sleep(1.0)  # let the write settle
            snap("during")
            gate_open = True
            print("  gate OPEN -> probe will restore", flush=True)
            return
        if int(time.time() - start) % 30 < POLL:
            print(f"    ...still waiting ({time.time()-start:.0f}s)", flush=True)
    print(f"  NO FLUSH within {WAIT_CAP}s -- opening gate anyway", flush=True)
    snap("during-noflush")
    gate_open = True


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
        if self.path.startswith("/gate"):
            self._send(b"go" if gate_open else b"wait")
        else:
            self._send()

    def do_POST(self):
        global gate_open, baseline_mtime
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except Exception:
            body = {"_raw": raw}
        path = self.path
        print(f"\n[{time.strftime('%H:%M:%S')}] {path}", flush=True)
        print("  " + json.dumps(body)[:1400], flush=True)
        with open(LOG, "a") as fh:
            fh.write(json.dumps({"t": time.time(), "path": path, "body": body}) + "\n")
        self._send()

        if path == "/start":
            gate_open = False
            baseline_mtime = os.path.getmtime(BOOKMARKS)
            shutil.copy(BOOKMARKS, os.path.join(SNAPS, "snap-before.json"))
            print(f"  baseline captured", flush=True)
        elif path == "/moved":
            threading.Thread(target=wait_for_write_then_release, daemon=True).start()
        elif path == "/done":
            print("  waiting for post-restore flush...", flush=True)
            def after():
                start = time.time()
                base = os.path.getmtime(BOOKMARKS)
                while time.time() - start < 180:
                    time.sleep(POLL)
                    if os.path.getmtime(BOOKMARKS) > base:
                        time.sleep(1.0)
                        snap("after")
                        break
                print("\n=== PROBE COMPLETE - ready to diff ===", flush=True)
            threading.Thread(target=after, daemon=True).start()

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if not os.path.exists(BOOKMARKS):
        sys.exit(f"No Bookmarks file at {BOOKMARKS}")
    os.makedirs(SNAPS, exist_ok=True)
    open(LOG, "w").close()
    baseline_mtime = os.path.getmtime(BOOKMARKS)
    print(f"Profile: {PROFILE}")
    print(f"Snapshots -> {SNAPS}")
    print(f"Listening on http://localhost:{PORT}", flush=True)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
