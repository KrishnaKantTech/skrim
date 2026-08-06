#!/usr/bin/env python3
"""Corrected fan-out analysis.

diff.py counted a node as "changed" if its absolute depth shifted. That is a
derived property of the traversal, not a stored field: moving a subtree one
level deeper necessarily shifts every descendant's depth, so it flagged all 555
descendants and produced a false red flag.

A bookmark sync entity is dirty when its STORED fields change, or when it is
reparented / reordered within its parent. Depth is neither. This measures those
three things only.

Prints no titles or URLs -- content compared via hash.
"""
import json, os, hashlib

SNAPS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "snapshots")
STORED = ("date_added", "date_modified", "date_last_used", "id", "type",
          "sync_transaction_version", "meta_info")


def hsh(v):
    return hashlib.sha1(json.dumps(v, sort_keys=True).encode()).hexdigest()[:10]


def flatten(node, parent=None, out=None, order=0, depth=0):
    if out is None:
        out = {}
    g = node.get("guid")
    if g:
        out[g] = {
            "stored": {f: node.get(f) for f in STORED},
            "parent": parent,
            "order": order,
            "depth": depth,
            "name_h": hsh(node.get("name")),
            "url_h": hsh(node.get("url")) if "url" in node else None,
            "nkids": len(node.get("children") or []),
        }
    for i, c in enumerate(node.get("children") or []):
        flatten(c, g, out, i, depth + 1)
    return out


def load(tag):
    p = os.path.join(SNAPS, f"snap-{tag}.json")
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    out = {}
    for key, root in (d.get("roots") or {}).items():
        if isinstance(root, dict):
            flatten(root, key, out)
    return out


def analyse(a, b, label):
    print(f"\n{'='*70}\n{label}\n{'='*70}")
    if not a or not b:
        print("  missing snapshot")
        return
    ka, kb = set(a), set(b)
    added, removed = kb - ka, ka - kb

    reparented, reordered, stored_changed, renamed = [], [], [], []
    for g in ka & kb:
        x, y = a[g], b[g]
        if x["parent"] != y["parent"]:
            reparented.append(g)
        elif x["order"] != y["order"]:
            reordered.append(g)
        if x["stored"] != y["stored"]:
            stored_changed.append((g, [k for k in STORED if x["stored"][k] != y["stored"][k]]))
        if x["name_h"] != y["name_h"] or x["url_h"] != y["url_h"]:
            renamed.append(g)

    depth_only = [g for g in ka & kb
                  if a[g]["depth"] != b[g]["depth"]
                  and a[g]["parent"] == b[g]["parent"]
                  and a[g]["order"] == b[g]["order"]
                  and a[g]["stored"] == b[g]["stored"]]

    print(f"  total nodes           : {len(ka)} -> {len(kb)}")
    print(f"  added                 : {len(added)}")
    print(f"  removed               : {len(removed)}")
    print(f"  REPARENTED            : {len(reparented)}")
    print(f"  reordered (same parent): {len(reordered)}")
    print(f"  stored fields changed : {len(stored_changed)}")
    print(f"  title/url changed     : {len(renamed)}")
    print(f"  depth shifted ONLY (traversal artifact, not a real change): {len(depth_only)}")

    if stored_changed:
        print("\n  stored-field changes:")
        for g, fields in stored_changed[:15]:
            print(f"    kids={a[g]['nkids']:<4} depth={a[g]['depth']} -> {','.join(fields)}")

    dirty = len(added) + len(removed) + len(reparented) + len(reordered) \
        + len({g for g, _ in stored_changed})
    print(f"\n  >>> DIRTY ENTITIES (sync-relevant): ~{dirty}")
    return dirty, len(ka)


if __name__ == "__main__":
    before, during, after = load("before"), load("during"), load("after")
    d1 = analyse(before, during, "PHASE 1: before -> during   (12 items hidden in vault)")
    d2 = analyse(before, after, "PHASE 2: before -> after    (full round trip)")

    print(f"\n{'='*70}\nVERDICT\n{'='*70}")
    if d1:
        dirty, total = d1
        print(f"  Hiding dirtied ~{dirty} of {total} nodes.")
        if dirty <= 40:
            print("  -> Fan-out is proportional to TOP-LEVEL count, not total bookmarks.")
            print("     Descendant records were NOT rewritten. GREEN LIGHT.")
        else:
            print("  -> Fan-out scales with total bookmarks. RED FLAG.")
    if d2:
        print(f"  After a full round trip, {d2[0]} of {d2[1]} nodes differ from baseline.")
