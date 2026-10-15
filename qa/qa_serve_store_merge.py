#!/usr/bin/env python3
"""serve.py's store writes: the merge two pages rely on, and the mirror's parts.

Real user report: approvals made in his own tab while the agent's page was
scanning were lost, because each page saved its whole copy and the file kept
the last one. And on 14 Oct 2026 the mirror passed Cloudflare's 25 MiB limit
per file, so every deploy failed. No server, browser or network: serve.py is
imported and pointed at a temporary directory.
"""
import importlib.util, json, os, sys, tempfile

DIR = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("serve", os.path.join(DIR, "..", "app", "serve.py"))
serve = importlib.util.module_from_spec(spec)
sys.argv = ["serve.py"]
spec.loader.exec_module(serve)

tmp = tempfile.mkdtemp()
serve.DIR = tmp
serve.LLM_FAMILIES_PATH = os.path.join(tmp, "llm_families.json")
serve.LLM_FAMILIES_DATA_JS_PATH = os.path.join(tmp, "llm_families_data.js")
serve.LLM_BACKUP_DIR = os.path.join(tmp, "backups")   # a reset's copy stays out of the real folder

fails = 0
def check(name, cond, extra=None):
    global fails
    print(("PASS " if cond else "FAIL ") + name + ("" if extra is None else " -- %s" % (extra,)))
    if not cond: fails += 1

copy = lambda d: json.loads(json.dumps(d))

# ---- two pages saving over each other ----
base = {"families": {"a": {"status": "none"}, "b": {"status": "provisional"}},
        "recheck": {"x": {"status": "provisional"}, "y": {"status": "provisional"}},
        "fullScan": {"seed": "s1", "done": [1]}, "lastJob": {"id": "j1"}}
serve.write_llm_families(copy(base))
agent = copy(base)
agent["families"]["c"] = {"status": "confirmed"}
del agent["recheck"]["y"]
agent["fullScan"]["done"].append(2)
agent["__changed"] = {"set": {"families": ["c"]}, "del": {"recheck": ["y"]}, "atomic": ["fullScan"]}
user = copy(base)                       # loaded before the agent saved
user["recheck"]["x"] = {"status": "applied"}
user["__changed"] = {"set": {"recheck": ["x"]}, "del": {}, "atomic": []}
serve.merge_llm_families(agent)
serve.merge_llm_families(user)
got = serve.read_llm_families()
check("the agent's new entry survives the user's later save", got["families"].get("c") == {"status": "confirmed"})
check("the user's approval is saved", got["recheck"].get("x") == {"status": "applied"})
check("the user's older copy does not bring back what the agent removed", "y" not in got["recheck"])
check("a part saved whole keeps the agent's version", got["fullScan"]["done"] == [1, 2])
check("an entry nobody changed is left as it was", got["families"]["b"] == {"status": "provisional"})
check("the list of changes is not itself saved", "__changed" not in got)

serve.write_llm_families({"families": {}, "fullScan": {"seed": "z"}})
serve.merge_llm_families({"families": {}, "__changed": {"atomic": ["fullScan"]}})
check("a part saved whole that the page dropped is removed", "fullScan" not in serve.read_llm_families())
serve.merge_llm_families({"families": {"only": {}}})
check("a save without a list of changes still replaces the file", serve.read_llm_families() == {"families": {"only": {}}})

open(serve.LLM_FAMILIES_PATH, "w").write("{broken")
try:
    serve.merge_llm_families({"families": {}, "__changed": {"set": {"families": []}}})
    check("a file that will not parse is refused", False)
except serve.StoreUnreadable:
    check("a file that will not parse is refused, not written over", open(serve.LLM_FAMILIES_PATH).read() == "{broken")

# ---- the mirror, in parts ----
def rebuilt():
    """What a browser ends up with: the first file, then each part it names."""
    import subprocess
    script = ("const fs=require('fs'),vm=require('vm'),p=require('path');const c={window:{}};vm.createContext(c);"
              "const d=process.argv[1];vm.runInContext(fs.readFileSync(p.join(d,'llm_families_data.js'),'utf8'),c);"
              "for(const f of c.window.LLM_FAMILIES_PARTS||[])vm.runInContext(fs.readFileSync(p.join(d,f),'utf8'),c);"
              "process.stdout.write(JSON.stringify({s:c.window.LLM_FAMILIES_STATIC,n:(c.window.LLM_FAMILIES_PARTS||[]).length}))")
    return json.loads(subprocess.run(["node", "-e", script, tmp], capture_output=True, text=True, check=True).stdout)

small = {"families": {"a": {"x": 1}}, "fullScan": None}
serve.write_llm_families(small)
r = rebuilt()
check("a small store is one file", r["n"] == 0 and r["s"] == small, r)

serve.MIRROR_PART_BYTES = 2000
big = {"families": {"f%03d" % i: {"label": "car %d" % i, "pad": "x" * 60} for i in range(120)},
       "relations": {"r%03d" % i: {"status": "confirmed"} for i in range(80)},
       "fullScan": {"seed": "s", "done": ["d%d" % i for i in range(30)]}, "lastJob": {"id": "j"}}
serve.write_llm_families(copy(big))
r = rebuilt()
sizes = [os.path.getsize(os.path.join(tmp, f)) for f in os.listdir(tmp) if f.startswith("llm_families_data")]
check("a large store is written in several parts", r["n"] >= 3, r["n"])
check("the parts rebuild exactly the store, key order included",
      json.dumps(r["s"]) == json.dumps(big))
check("no part is much over the limit", max(sizes) < 2000 + 600, sizes)
check("fullScan is never split", r["s"]["fullScan"] == big["fullScan"])

serve.write_llm_families(small)
left = sorted(f for f in os.listdir(tmp) if f.startswith("llm_families_data_"))
check("parts a smaller store no longer needs are deleted", left == [], left)
check("a reset leaves one empty mirror", (serve.reset_llm_families(), rebuilt())[1] == {"s": {}, "n": 0})

print("\n%s" % ("ALL PASS" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
