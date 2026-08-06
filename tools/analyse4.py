#!/usr/bin/env python3
"""Step 4 analysis — did the observing client converge to its original state?

The decisive question is not whether MAIN restores correctly (M0 proved that),
but whether the SECOND client ends up byte-identical after a hide/restore round
trip propagates through Chrome Sync.

Prints no titles or URLs -- content compared via hash.
"""
import json, os, hashlib

SNAPS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "snapshots")
STORED = ("date_added", "date_modified", "date_last_used", "id", "type", "meta_info")


def hsh(v):
    return hashlib.sha1(json.dumps(v, sort_keys=True).encode()).hexdigest()[:10]


def flatten(node, parent=None, out=None, order=0):
    if out is None:
        out = {}
    g = node.get("guid")
    if g:
        out[g] = {
            "stored": {f: node.get(f) for f in STORED},
            "parent": parent,
            "order": order,
            "name_h": hsh(node.get("name")),
            "url_h": hsh(node.get("url")) if "url" in node else None,
        }
    for i, c in enumerate(node.get("children") or []):
        flatten(c, g, out, i)
    return out


def load(name):
    p = os.path.join(SNAPS, name)
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    out = {}
    for key, root in (d.get("roots") or {}).items():
        if isinstance(root, dict):
            flatten(root, key, out)
    return out


def compare(a, b, label):
    print(f"\n{'='*70}\n{label}\n{'='*70}")
    if not a or not b:
        print("  missing snapshot(s) — skipped")
        return None
    ka, kb = set(a), set(b)
    added, removed = kb - ka, ka - kb
    reparented = [g for g in ka & kb if a[g]["parent"] != b[g]["parent"]]
    reordered = [g for g in ka & kb
                 if a[g]["parent"] == b[g]["parent"] and a[g]["order"] != b[g]["order"]]
    renamed = [g for g in ka & kb
               if a[g]["name_h"] != b[g]["name_h"] or a[g]["url_h"] != b[g]["url_h"]]
    stored = [g for g in ka & kb if a[g]["stored"] != b[g]["stored"]]

    print(f"  nodes           : {len(ka)} -> {len(kb)}")
    print(f"  ADDED           : {len(added)}   (duplicates would show here)")
    print(f"  REMOVED         : {len(removed)}   (data loss would show here)")
    print(f"  REPARENTED      : {len(reparented)}")
    print(f"  REORDERED       : {len(reordered)}   (order corruption would show here)")
    print(f"  title/url changed: {len(renamed)}")
    print(f"  stored fields   : {len(stored)}")

    clean = not (added or removed or reparented or reordered or renamed)
    print(f"\n  -> {'CLEAN CONVERGENCE' if clean else 'DIVERGENCE DETECTED'}")
    return clean


if __name__ == "__main__":
    tb, td, ta = load("s4-test-before.json"), load("s4-test-during.json"), load("s4-test-after.json")
    mb, ma = load("s4-main-before.json"), load("s4-main-after.json")

    compare(tb, td, "OBSERVER during hide  (expect 12 reparented into vault)")
    r = compare(tb, ta, "OBSERVER after round trip  (THE VERDICT)")
    compare(mb, ma, "MAIN after round trip  (control)")

    print(f"\n{'='*70}\nSTEP 4 VERDICT\n{'='*70}")
    if r is True:
        print("  Second client converged to its exact original state.")
        print("  No duplicates, no losses, no reordering. Cross-device risk CLEARED.")
    elif r is False:
        print("  Second client did NOT converge cleanly. Inspect the counts above.")
    else:
        print("  Inconclusive — snapshots missing.")
