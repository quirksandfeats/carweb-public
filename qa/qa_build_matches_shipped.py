#!/usr/bin/env python3
"""Rebuilds the graph from data_src in a scratch copy and compares it with app/data.js.

A fix made only in the built files, or a table changed without building, is lost
or brought in by the next rebuild, and the stored scans point at these cars. Runs
without network and writes nothing in the repository. Positions are not compared:
the layout step bakes them afterwards.
"""
import json, os, shutil, subprocess, sys, tempfile

DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(DIR, "..")

fails = 0
def check(name, cond, extra=None):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if extra is None else " -- %s" % (extra,)))
    if not cond: fails += 1

def load(path):
    text = open(path, encoding="utf-8").read()
    return json.loads(text[text.index("{"):text.rindex("}") + 1])

def nodes_of(graph):
    return {n["id"]: {k: v for k, v in n.items() if k not in ("x", "y")} for n in graph["nodes"]}

def links_of(graph):
    return {json.dumps(l, sort_keys=True, ensure_ascii=False) for l in graph["links"]}

tmp = tempfile.mkdtemp()
src = os.path.join(tmp, "data_src")
shutil.copytree(os.path.join(ROOT, "data_src"), src,
                ignore=shutil.ignore_patterns("node_modules", "__pycache__"))
for script in ("merge_harvest.py", "build_data.py"):
    run = subprocess.run([sys.executable, script], cwd=src, capture_output=True, text=True)
    check(script + " runs", run.returncode == 0, run.stdout[-300:] + run.stderr[-300:] if run.returncode else None)

check("the harvest merges into the d_auto.py on file",
      open(os.path.join(src, "d_auto.py"), encoding="utf-8").read() ==
      open(os.path.join(ROOT, "data_src", "d_auto.py"), encoding="utf-8").read())

built, shipped = load(os.path.join(tmp, "app", "data.js")), load(os.path.join(ROOT, "app", "data.js"))
a, b = nodes_of(shipped), nodes_of(built)
check("no car or person is only in one of them", a.keys() == b.keys(), sorted(a.keys() ^ b.keys())[:10])
changed = [i for i in a if i in b and a[i] != b[i]]
check("every node says the same", not changed, changed[:10])
la, lb = links_of(shipped), links_of(built)
check("every link is the same", la == lb, sorted(la ^ lb)[:6])
check("the counts match the graph", shipped["meta"]["counts"] == built["meta"]["counts"])

shutil.rmtree(tmp, ignore_errors=True)
print("ALL PASS" if not fails else "%d FAILED" % fails)
sys.exit(1 if fails else 0)
