#!/usr/bin/env python3
"""Diff the Bookmarks file snapshots by node guid.

The decisive question: when a folder moves, does Chrome dirty only that folder's
record, or does it rewrite descendant records too? Only the former keeps sync
fan-out proportional to top-level children rather than total bookmarks.

Prints no titles or URLs -- content is compared via hash only.
"""
import json, os, sys, hashlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "snapshots")
FIELDS = ("date_added", "date_modified", "date_last_used", "id", "type",
          "sync_transaction_version", "meta_info")


def hsh(v):
    return hashlib.sha1(json.dumps(v, sort_keys=True).encode()).hexdigest()[:10]


def flatten(node, depth=0, parent=None, out=None, order=0):
    if out is None:
        out = {}
    g = node.get("guid")
    rec = {f: node.get(f) for f in FIELDS}
    rec["depth"] = depth
    rec["parent"] = parent
    rec["order"] = order
    rec["name_h"] = hsh(node.get("name"))
    rec["url_h"] = hsh(node.get("url")) if "url" in node else None
    rec["nkids"] = len(node.get("children", []) or [])
    if g:
        out[g] = rec
    for i, c in enumerate(node.get("children", []) or []):
        flatten(c, depth + 1, g, out, i)
    return out


def load(tag):
    p = os.path.join(OUT, f"snap-{tag}.json")
    if not os.path.exists(p):
        return None
    d = json.load(open(p))
    all_nodes = {}
    for key, root in d.get("roots", {}).items():
        if isinstance(root, dict):
            flatten(root, 0, key, all_nodes)
    return all_nodes


def compare(a, b, label):
    print(f"\n{'='*66}\n{label}\n{'='*66}")
    if a is None or b is None:
        print("  missing snapshot, skipped")
        return
    ka, kb = set(a), set(b)
    print(f"  nodes: {len(ka)} -> {len(kb)}   added={len(kb-ka)} removed={len(ka-kb)}")

    changed = {}
    for g in ka & kb:
        diffs = {k: (a[g][k], b[g][k]) for k in a[g]
                 if a[g][k] != b[g][k] and k not in ("parent", "order", "depth")}
        struct = {k: (a[g][k], b[g][k]) for k in ("parent", "order", "depth")
                  if a[g][k] != b[g][k]}
        if diffs or struct:
            changed[g] = {"content": diffs, "structural": struct,
                          "depth": a[g]["depth"], "nkids": a[g]["nkids"]}

    print(f"  changed nodes: {len(changed)}")
    if not changed:
        print("  -> byte-identical node records. No fan-out.")
        return

    by_depth = {}
    content_dirty = 0
    for g, c in changed.items():
        by_depth.setdefault(c["depth"], 0)
        by_depth[c["depth"]] += 1
        if c["content"]:
            content_dirty += 1

    print(f"  changed by depth: {dict(sorted(by_depth.items()))}")
    print(f"  with CONTENT field changes (date_modified etc): {content_dirty}")
    print(f"  structural-only (parent/order): {len(changed) - content_dirty}")

    print("\n  sample (max 12):")
    for g, c in list(changed.items())[:12]:
        bits = []
        if c["structural"]:
            bits.append("moved:" + ",".join(c["structural"]))
        if c["content"]:
            bits.append("fields:" + ",".join(c["content"]))
        print(f"    depth={c['depth']:<2} kids={c['nkids']:<4} {' | '.join(bits)}")

    deep = [g for g, c in changed.items() if c["depth"] > 1]
    print(f"\n  VERDICT: {len(deep)} nodes deeper than depth 1 were touched.")
    if not deep:
        print("  -> Only top-level bar children dirtied. Fan-out is proportional")
        print("     to top-level count. GREEN LIGHT.")
    else:
        print("  -> Descendants were also dirtied. Fan-out scales with total")
        print("     bookmarks. RED FLAG for the extension-only approach.")


if __name__ == "__main__":
    before, during, after = load("before"), load("during"), load("after")
    compare(before, during, "PHASE 1: before -> during (bookmarks hidden in vault)")
    compare(before, after, "PHASE 2: before -> after (restored)")
