#!/usr/bin/env python3
"""Does MTP change the model's answers on THIS machine -- and how good are
those answers on real Wikipedia articles?

Two questions, one harness, because they need the same expensive setup (a
server per configuration) and because the second one is what makes the first
one meaningful:

  EQUIVALENCE -- speculative decoding is only worth adopting because it is
      supposed to change SPEED AND NOTHING ELSE. The drafted tokens are
      verified against the same 9B weights rather than trusted, so at
      temperature 0 the output should be byte-identical to the same model
      decoded without MTP. This diffs them to confirm that on your hardware.

  GROUNDING -- for each answer, whether every chassis code, person and
      related-nameplate the model returned actually appears in the source
      text it was given. This is the same hallucination guard llm_families.js
      applies at runtime, run offline over whole articles, and it needs no
      hand-labelled ground truth to be meaningful.

The pairing matters. "Is MTP identical to baseline?" only tells you the decode
path is faithful; it says nothing about whether the answers are any good. And
a grounding score on its own can't tell you whether MTP moved it. Reported per
configuration, together, you can see both -- including the case that would
otherwise be invisible: MTP diverging *into worse output*.

WHY MTP CANNOT BE "MORE ACCURATE" THAN BASELINE
    Same weights, same model. The draft head only proposes; the full model
    verifies. At temperature 0 the non-speculative output IS the correct
    answer by definition -- it is what the model actually predicts. A
    divergence is the decode path being wrong, and wrong is a coin flip, not
    an upgrade. The ceiling is "identical", which is why that is what gets
    measured.

BACKGROUND: llama.cpp issue #23302 reports draft-mtp diverging from baseline
at --spec-draft-n-max >= 3, at temperature 0, on macOS/Metal. Run this to find
out whether it reproduces on your machine before trusting any n-max value.

Usage:
    python3 qa/qa_mtp_equivalence.py                      # builtin prompts, n-max 1..6
    python3 qa/qa_mtp_equivalence.py --source wikipedia   # real articles (slower)
    python3 qa/qa_mtp_equivalence.py --source both
    python3 qa/qa_mtp_equivalence.py --source wikipedia --articles "BMW 3 Series,Porsche 911"
    python3 qa/qa_mtp_equivalence.py --max-n 4            # stop after n-max 4
    python3 qa/qa_mtp_equivalence.py --refresh-wiki       # re-fetch cached articles

Wikipedia articles are fetched ONCE and cached under qa/wiki_cache/. That is
not an optimization -- every configuration must see byte-identical input or
the comparison means nothing, and a cached corpus also makes runs weeks apart
comparable. Live articles change under you; --refresh-wiki is the deliberate
way to take a new snapshot.

First run downloads the MTP GGUF (~6.14GB) if app/serve.py's LLAMA_MODEL isn't
in llama_model_cache/ yet. Uses its own port so it never disturbs a running app.
"""
import argparse
import json
import os
import re
import shutil
import statistics
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

DIR = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(DIR, "..", "app")
WIKI_CACHE = os.path.join(DIR, "wiki_cache")
sys.path.insert(0, APP)

# Pull the model spec straight from serve.py rather than restating it -- that
# file is the one place the model is configured, and a test that hardcoded its
# own copy would keep passing after you changed the real one.
try:
    import serve  # noqa: E402
except Exception as e:  # pragma: no cover
    sys.exit("couldn't import app/serve.py to read the model config: %s" % e)

MODEL = serve.LLAMA_MODEL
ALIAS = serve.LLAMA_MODEL_ALIAS
CACHE_DIR = os.path.abspath(serve.LLAMA_CACHE_DIR)

UA = "carweb-qa-mtp-equivalence/1.0 (local model QA; https://en.wikipedia.org/wiki/Special:UserAgent)"

# The real contract from llm_families.js SYSTEM_PROMPT, trimmed to its
# operative rules. Kept faithful in shape (JSON-only, this exact schema,
# never invent) because prompt shape drives token distribution, and token
# distribution is what a speculative decoder's acceptance rate responds to.
SYSTEM = (
    "You extract car production-generation data, who designed/engineered each "
    "generation, and every shared-platform/rebadge/sister-model relationship to a "
    "DIFFERENT nameplate, from Wikipedia infobox wikitext, section headings, and "
    "short paragraph excerpts.\n"
    "Respond with ONLY JSON, no prose, matching exactly this shape:\n"
    '{"hasMultipleGenerations": boolean, "generations": [{"code": string, '
    '"yearStart": number|null, "yearEnd": number|null, "designers": string[], '
    '"engineers": string[], "sharedPlatforms": string[]}]}\n'
    "Be exhaustive: every distinct generation named anywhere in the text must appear, "
    "not just the first few. Use the specific chassis/platform code where the text "
    "gives one. Use null for a year you cannot find, never omit the generation. "
    "sharedPlatforms holds CARS, never platform names. "
    "Never invent a code, year, person or related nameplate that is not in the text."
)

# ---------------------------------------------------------------------------
# Builtin prompts: small, offline, fully deterministic. Sized to emit a few
# hundred tokens rather than a one-liner -- the divergence in issue #23302
# first appeared at token 38, so a prompt that emits 10 tokens can pass while
# a real extraction diverges.
# ---------------------------------------------------------------------------
BUILTIN = [
    ("g-class", """Car: Mercedes-Benz G-Class

Infobox wikitext:
| production = 1979-present
| platform = W460, W461, W462, W463
| related = Peugeot P4

Section headings:
W460 (1979-1991)
W461 (1992-present)
W463 (1990-2018)
W464 (2018-present)

Excerpts:
The W460 entered production in 1979 as a military vehicle. The civilian W463 arrived in 1990 with a redesigned interior. A licence-built variant was sold in France as the Peugeot P4. The W464, launched in 2018, was engineered under Gunnar Guthenke."""),
    ("golf", """Car: Volkswagen Golf

Infobox wikitext:
| production = 1974-present
| platform = A1, A2, A3, A4, A5 (PQ35), A6 (PQ35), A7 (MQB), A8 (MQB Evo)
| related = Audi A3, SEAT Leon, Skoda Octavia, Volkswagen Jetta

Section headings:
Mk1 (1974)
Mk2 (1983)
Mk3 (1991)
Mk4 (1997)
Mk5 (2003)
Mk6 (2008)
Mk7 (2012)
Mk8 (2019)

Excerpts:
The Mk1 was styled by Giorgetto Giugiaro at Italdesign. The Mk7 introduced the MQB platform, shared with the Audi A3, SEAT Leon and Skoda Octavia. The Mk4 was developed under Hartmut Warkuss. The Mk8 arrived in 2019 on MQB Evo."""),
    ("single-gen", """Car: Bugatti Galibier

Infobox wikitext:
| production = 2009 (concept)
| platform = Bugatti Veyron platform
| related =

Section headings:
Concept

Excerpts:
The Galibier was shown as a four-door concept in 2009 and never entered series production. It used a derivative of the Veyron's W16 powertrain."""),
]

# Default Wikipedia corpus. Chosen for VARIETY of extraction difficulty rather
# than for being famous cars -- each one stresses a different failure mode the
# app has actually hit:
#   G-Class        per-generation infobox side-cards (the merged-article case)
#   Golf           eight generations; the "stops after finding 3" failure
#   Dacia Logan    generations announced only in body prose, no chassis codes
#   Toyota 86      heavy rebadge/sister-model web (Subaru BRZ, Scion FR-S)
#   Peugeot 205    older article, sparser structure, designer credit in prose
DEFAULT_ARTICLES = [
    "Mercedes-Benz G-Class",
    "Volkswagen Golf",
    "Dacia Logan",
    "Toyota 86",
    "Peugeot 205",
]


# ===========================================================================
# Wikipedia fetch + digest
# ===========================================================================
def fetch_wikitext(title, refresh=False):
    """Fetch an article's raw wikitext, caching to disk. Same API endpoint the
    app itself uses (action=parse&prop=wikitext&redirects=1)."""
    os.makedirs(WIKI_CACHE, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", title)
    path = os.path.join(WIKI_CACHE, safe + ".wikitext")
    if os.path.exists(path) and not refresh:
        with open(path, encoding="utf-8") as f:
            return f.read(), path, True
    url = ("https://en.wikipedia.org/w/api.php?action=parse&format=json"
           "&prop=wikitext&redirects=1&page=" + urllib.parse.quote(title))
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.loads(r.read().decode())
    if "error" in j:
        raise RuntimeError("wikipedia: %s" % j["error"].get("info", "unknown error"))
    wt = j.get("parse", {}).get("wikitext", {}).get("*")
    if not wt:
        raise RuntimeError("no wikitext returned for %r" % title)
    with open(path, "w", encoding="utf-8") as f:
        f.write(wt)
    return wt, path, False


def strip_wiki_markup(s):
    """Port of llm_families.js stripWikiMarkup, including its one subtlety: for
    a piped wikilink, keep the TARGET rather than the display text when the
    target carries a parenthetical the display lacks -- that is where chassis
    codes hide ("Mercedes-Benz A-Class (W176)|Mercedes-Benz A-Class")."""
    s = re.sub(r"<ref[^>]*/>|<ref[^>]*>[\s\S]*?</ref>", "", s, flags=re.I)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)

    def link(m):
        target, display = m.group(1), m.group(2)
        if display and re.search(r"\([^)]*\)", target) and not re.search(r"\([^)]*\)", display):
            return target
        return display or target

    s = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]", link, s)
    s = re.sub(r"'''?", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip()


GEN_CUE = re.compile(r"\b(?:(?:first|second|third|fourth|fifth|sixth|seventh|1st|2nd|3rd|4th|5th|6th|7th)[\s-]generation|facelift(?:ed)?|Mk\.?\s?\d+|generation\s+[IVX]+\b)", re.I)
PEOPLE_CUE = re.compile(r"\b(?:design(?:ed)?\s+by|styled\s+by|penned\s+by|design\s+director|chief\s+designer|led\s+by|headed\s+by|engineered\s+by|developed\s+by|chief\s+engineer|project\s+lead|lead\s+engineer|under\s+the\s+direction\s+of)\b", re.I)
YEAR_CUE = re.compile(r"\b(?:19|20)\d{2}\s*(?:[-–—]|to|until|through)\s*(?:(?:19|20)\d{2}|present)\b", re.I)
PLATFORM_CUE = re.compile(r"\b(?:shares?\s+(?:its|the|a)?\s*platform|platform[\s-]mate|badge[\s-]engineer(?:ed|ing)?|rebadged?|re-?badge|sister\s+model|twin(?:ned)?\s+with|sold\s+as\s+the|marketed\s+as\s+the|captive\s+import|clone\s+of|jointly\s+developed\s+with|co-developed\s+with)\b", re.I)


def _infobox_field(text, name):
    """One `| field = value` row out of an infobox blob, wiki-markup stripped."""
    m = re.search(r"^\s*\|\s*%s\s*=\s*(.+?)\s*$" % name, text, re.M | re.I)
    if not m:
        return None
    v = strip_wiki_markup(m.group(1))
    return v or None


def extract_digest(wikitext, max_cues=60, cue_chars=900, max_infoboxes=12, infobox_chars=12000):
    """Port of llm_families.js extractDigest, verified field-by-field against
    the real JS on a fixture article (see the port-check note in the project
    docs). Returns the same shape the app builds its prompt from:
    infobox / headings / cues / platformField / relatedField / perGen.

    Cue count is lower than the app's 160 -- the app runs one request against a
    131072-token context, whereas this harness runs eight servers back to back,
    and a full-size Golf digest makes every configuration slower without making
    a divergence any easier to detect. Raise --cues to reproduce the app's exact
    prompt rather than its exact shape.
    """
    hmatches = [(m.start(), m.group(1).strip())
                for m in re.finditer(r"^={2,4}\s*([^=\n]+?)\s*={2,4}\s*$", wikitext, re.M)]

    # Every infobox, not just the first: a merged nameplate article gives each
    # generation its own side-card, and that is frequently the only clean
    # source for that generation's exact year range.
    boxes = []
    pos = 0
    while True:
        m = re.compile(r"\{\{\s*Infobox", re.I).search(wikitext, pos)
        if not m:
            break
        start = m.start()
        depth, i = 0, start
        while i < len(wikitext):
            if wikitext.startswith("{{", i):
                depth += 1; i += 2; continue
            if wikitext.startswith("}}", i):
                depth -= 1; i += 2
                if depth <= 0:
                    break
                continue
            i += 1
        heading = None
        for hpos, htext in reversed(hmatches):
            if hpos < start:
                heading = htext
                break
        boxes.append({"raw": wikitext[start:min(i, start + infobox_chars)], "heading": heading})
        pos = max(i, m.end())
        if len(boxes) >= max_infoboxes:
            break

    infobox = boxes[0]["raw"] if boxes else ""

    # The "related"/"platform" rows specifically. {{Infobox automobile}} groups
    # them under a template-generated "Body and chassis" divider that is not a
    # real heading, so they end up buried among dozens of other fields -- a
    # small local model reliably missed them there, so the app lifts them out
    # and restates them separately. Same here.
    platform_field = _infobox_field(infobox, "platform") or ""
    related_field = _infobox_field(infobox, "related") or ""

    # Per-generation side-cards: every infobox AFTER the main one, parsed down
    # to the fields that actually matter for attribution.
    per_gen = []
    for b in boxes[1:]:
        per_gen.append({
            "heading": b["heading"],
            "production": _infobox_field(b["raw"], "production"),
            "related": _infobox_field(b["raw"], "related"),
            "platform": _infobox_field(b["raw"], "platform"),
            "raw": b["raw"],
        })

    seen, cues = set(), []
    for para in re.split(r"\n\s*\n", wikitext):
        if not (GEN_CUE.search(para) or PEOPLE_CUE.search(para)
                or PLATFORM_CUE.search(para) or YEAR_CUE.search(para)):
            continue
        clean = strip_wiki_markup(para)[:cue_chars]
        key = clean.lower()
        if len(clean) > 20 and key not in seen:
            seen.add(key)
            cues.append(clean)
        if len(cues) >= max_cues:
            break

    return {
        "infobox": infobox,
        "headings": [h for _, h in hmatches][:80],
        "cues": cues,
        "platformField": platform_field,
        "relatedField": related_field,
        "perGen": per_gen,
    }


def build_user_message(title, digest):
    """Port of llm_families.js buildMessages."""
    parts = ["Car: %s" % title, "",
             "Infobox wikitext:", digest["infobox"] or "(no infobox found)",
             "", "Section headings:", "\n".join(digest["headings"]) or "(none)"]
    if digest["platformField"] or digest["relatedField"]:
        parts += ["", "Infobox 'related'/'platform' field:",
                  "; ".join(x for x in (digest["platformField"], digest["relatedField"]) if x)]
    for n, g in enumerate(digest["perGen"], start=2):
        parts += ["", "Generation infobox #%d (%s):" % (n, g["heading"] or "unlabelled")]
        for k in ("production", "platform", "related"):
            if g[k]:
                parts.append("%s: %s" % (k, g[k]))
        parts.append("Raw infobox wikitext for this generation:")
        parts.append(g["raw"])
    if digest["cues"]:
        parts += ["", "Excerpts:"] + digest["cues"]
    return "\n".join(parts)


# ===========================================================================
# Grounding: did the model invent anything?
# ===========================================================================
_TRANSLIT = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "ae", "Ö": "oe", "Ü": "ue", "ß": "ss"}


def _norm(s):
    """Aggressive normalisation so 'Mk 7' / 'Mk.7' / 'mk7' compare equal, and
    spelling variants of the same name don't produce a false 'invented' verdict.

    German umlauts are expanded BEFORE stripping combining marks, because both
    spellings are common in this data and they normalise differently otherwise:
    an article saying "Prüfer" against a model writing "Pruefer" would come out
    as 'prufer' vs 'pruefer' and get flagged as an invention. Expanding first
    lands both on 'pruefer'. Everything else (Citroën, Skoda, Peugeot's accents)
    is handled by the combining-mark strip below.
    """
    s = str(s)
    for k, v in _TRANSLIT.items():
        s = s.replace(k, v)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s.lower())


def check_grounding(content, source_text):
    """Every code / person / related nameplate the model returned, checked for
    actually appearing in the text it was shown. This is the app's own
    hallucination guard (llm_families.js drops ungrounded entries at runtime),
    applied offline to whole articles.

    HEURISTIC, not a verdict: a normalised substring test can mark a
    legitimately-rephrased name as ungrounded. Treat a nonzero count as
    "go look at these", and -- for the purpose this harness exists for -- as a
    number that should be IDENTICAL across configurations. If MTP ever changes
    it, that is the thing worth knowing.
    """
    r = {"json_ok": False, "schema_ok": False, "generations": 0,
         "ungrounded": [], "years_null": 0}
    try:
        obj = json.loads(content)
    except Exception:
        return r
    r["json_ok"] = True
    gens = obj.get("generations")
    if not isinstance(gens, list) or not isinstance(obj.get("hasMultipleGenerations"), bool):
        return r
    r["schema_ok"] = True
    r["generations"] = len(gens)
    hay = _norm(source_text)
    for g in gens:
        if not isinstance(g, dict):
            r["schema_ok"] = False
            continue
        code = g.get("code")
        if isinstance(code, str) and code.strip() and _norm(code) not in hay:
            r["ungrounded"].append("code:%s" % code)
        if g.get("yearStart") is None or g.get("yearEnd") is None:
            r["years_null"] += 1
        for field, tag in (("designers", "person"), ("engineers", "person"),
                           ("sharedPlatforms", "related")):
            vals = g.get(field)
            if vals is None:
                continue
            if not isinstance(vals, list):
                r["schema_ok"] = False
                continue
            for v in vals:
                if isinstance(v, str) and v.strip() and _norm(v) not in hay:
                    r["ungrounded"].append("%s:%s" % (tag, v))
    return r


# ===========================================================================
# Server lifecycle + requests
# ===========================================================================
def post_chat(port, messages, seed, timeout=900):
    """One temperature-0, JSON-mode request -- the app's own request shape
    (llm_families.js askLlamaCpp), plus an explicit seed and cache_prompt off
    so nothing but the decode path can vary between runs."""
    body = json.dumps({
        "model": ALIAS, "messages": messages,
        "response_format": {"type": "json_object"},
        "stream": False, "temperature": 0, "top_k": 1,
        "seed": seed, "cache_prompt": False,
    }).encode()
    req = urllib.request.Request("http://127.0.0.1:%d/v1/chat/completions" % port,
                                 data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        obj = json.loads(r.read().decode())
    t = obj.get("timings") or {}
    return (obj["choices"][0]["message"]["content"],
            t.get("predicted_per_second"), t.get("predicted_n"))


def wait_ready(port, proc, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def start_server(port, n_max, ctx, log_path, startup_timeout):
    """n_max None => MTP off (the baseline). Otherwise MTP at that draft width."""
    cmd = [shutil.which("llama-server"), "-hf", MODEL, "--alias", ALIAS,
           "--host", "127.0.0.1", "--port", str(port), "--parallel", "1",
           "--ctx-size", str(ctx), "--jinja",
           "--reasoning", "off", "--reasoning-budget", "0"]
    if n_max is not None:
        cmd += ["--spec-type", "draft-mtp", "--spec-draft-n-max", str(n_max)]
    env = dict(os.environ)
    env["LLAMA_CACHE"] = CACHE_DIR
    log_f = open(log_path, "w", encoding="utf-8")
    proc = subprocess.Popen(cmd, env=env, stdout=log_f, stderr=subprocess.STDOUT,
                            start_new_session=True)
    if not wait_ready(port, proc, startup_timeout):
        try:
            proc.terminate(); proc.wait(timeout=10)
        except Exception:
            try: proc.kill()
            except Exception: pass
        log_f.close()
        return None
    return (proc, log_f)


def stop_server(handle):
    if not handle:
        return
    proc, log_f = handle
    try:
        proc.terminate(); proc.wait(timeout=25)
    except subprocess.TimeoutExpired:
        proc.kill()
    except Exception:
        pass
    try:
        log_f.close()
    except Exception:
        pass


def run_config(label, port, n_max, cases, ctx, seed, startup_timeout, repeats=1):
    """cases: list of (name, user_message, grounding_source).

    repeats > 1 re-runs every case inside the SAME server. That is the cheap
    axis: a repeat costs one generation, not another multi-gigabyte model load,
    so it is how you turn a single noisy tok/s reading into something you can
    actually compare configurations on. It also gives a free within-server
    determinism check -- identical requests to one live server must produce
    identical text, and if they don't, no cross-config diff below means
    anything.
    """
    log_path = os.path.join(DIR, "mtp_test_%s.log" % re.sub(r"[^A-Za-z0-9]+", "_", label))
    print("  starting llama-server (%s)..." % label, flush=True)
    handle = start_server(port, n_max, ctx, log_path, startup_timeout)
    if handle is None:
        print("  FAILED to start -- last lines of %s:" % os.path.basename(log_path))
        try:
            with open(log_path, encoding="utf-8", errors="replace") as f:
                for line in f.readlines()[-12:]:
                    print("    " + line.rstrip())
        except Exception:
            pass
        return None
    try:
        outputs, rates, ground, unstable = {}, [], {}, []
        for name, user, source in cases:
            msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]
            texts, samples, ntok = [], [], None
            for _ in range(max(1, repeats)):
                content, tps, n = post_chat(port, msgs, seed)
                texts.append(content)
                ntok = n or ntok
                if tps:
                    samples.append(tps)
                    rates.append(tps)
            if len(set(texts)) > 1:
                unstable.append(name)
            outputs[name] = texts[0]
            g = check_grounding(texts[0], source)
            ground[name] = g
            flag = ("ok" if g["json_ok"] and g["schema_ok"] else "BAD-JSON")
            if g["ungrounded"]:
                flag = "%d ungrounded" % len(g["ungrounded"])
            if name in unstable:
                flag += "  !! UNSTABLE across repeats"
            rate_txt = ("%6.1f tok/s" % (samples[0] if samples else 0.0)) if len(samples) <= 1 else \
                       ("%6.1f tok/s (%d runs, %.1f-%.1f)"
                        % (statistics.median(samples), len(samples), min(samples), max(samples)))
            print("    %-22s %5s tok  %s  %2d gens  %s"
                  % (name, ntok if ntok else "?", rate_txt, g["generations"], flag), flush=True)
        return {"outputs": outputs,
                "samples": rates,
                "tps": statistics.median(rates) if rates else 0.0,
                "lo": min(rates) if rates else 0.0,
                "hi": max(rates) if rates else 0.0,
                "n_samples": len(rates),
                "unstable": unstable,
                "ground": ground}
    finally:
        stop_server(handle)
        time.sleep(2)  # let the port free before the next config binds it


def summarise_ground(ground):
    tot_ung = sum(len(g["ungrounded"]) for g in ground.values())
    bad = sum(0 if (g["json_ok"] and g["schema_ok"]) else 1 for g in ground.values())
    gens = sum(g["generations"] for g in ground.values())
    return tot_ung, bad, gens


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--max-n", type=int, default=6)
    ap.add_argument("--only-n", default="",
                    help="comma-separated draft widths to test instead of 1..max-n "
                         "(e.g. --only-n 3 to re-confirm just the setting you actually run). "
                         "Each width costs a full server load, so once the curve is known this is "
                         "the cheap way to re-check one point on harder prompts.")
    ap.add_argument("--seed", type=int, default=1234)
    ap.add_argument("--source", choices=["builtin", "wikipedia", "both"], default="builtin")
    ap.add_argument("--articles", default="", help="comma-separated Wikipedia titles (overrides the default corpus)")
    ap.add_argument("--refresh-wiki", action="store_true", help="re-fetch cached articles")
    ap.add_argument("--cues", type=int, default=60,
                    help="max excerpt paragraphs per article (app uses 160; lower keeps this harness's 8 server starts tractable)")
    ap.add_argument("--repeats", type=int, default=1,
                    help="generations per case per config (default 1). Raise to 3+ when the SPEED "
                         "number matters: repeats reuse the loaded server, so they cost generation "
                         "time only, and a single tok/s sample is too noisy to rank configs by.")
    ap.add_argument("--ctx", type=int, default=0, help="context size (default: 32768 builtin / 65536 wikipedia)")
    ap.add_argument("--startup-timeout", type=float, default=900)
    args = ap.parse_args()

    if not shutil.which("llama-server"):
        sys.exit("llama-server isn't on your PATH -- see README.md.")

    cases = []
    if args.source in ("builtin", "both"):
        for name, user in BUILTIN:
            cases.append((name, user, user))  # grounding source == the prompt itself

    if args.source in ("wikipedia", "both"):
        titles = [t.strip() for t in args.articles.split(",") if t.strip()] or DEFAULT_ARTICLES
        print("Wikipedia corpus (cached under qa/wiki_cache/):")
        for t in titles:
            try:
                wt, path, cached = fetch_wikitext(t, refresh=args.refresh_wiki)
            except Exception as e:
                print("  %-28s SKIPPED -- %s" % (t, e))
                continue
            digest = extract_digest(wt, max_cues=args.cues)
            user = build_user_message(t, digest)
            # Ground against the DIGEST, not the whole article: the model can
            # only legitimately ground in what it was actually shown, so
            # checking against the full wikitext would forgive an invention
            # that merely happens to appear somewhere it never saw.
            cases.append(("wiki:" + t, user, user))
            print("  %-28s %7d chars wikitext -> %6d char prompt, %d gen-infobox(es), %d excerpts%s"
                  % (t, len(wt), len(user), len(digest["perGen"]), len(digest["cues"]),
                     "  [cached]" if cached else ""))
        print()

    if not cases:
        sys.exit("no test cases -- every article failed to fetch?")

    if args.only_n.strip():
        try:
            widths = [int(x) for x in args.only_n.split(",") if x.strip()]
        except ValueError:
            sys.exit("--only-n takes comma-separated integers, e.g. --only-n 3 or --only-n 3,4")
        if not widths:
            sys.exit("--only-n was empty")
    else:
        widths = list(range(1, args.max_n + 1))

    ctx = args.ctx or (65536 if args.source in ("wikipedia", "both") else 32768)
    longest = max(len(u) for _, u, _ in cases)
    print("model : %s" % MODEL)
    print("cache : %s" % CACHE_DIR)
    print("port  : %d   cases: %d   seed: %d   ctx: %d   longest prompt: %d chars"
          % (args.port, len(cases), args.seed, ctx, longest))
    print("configs to run: baseline x2 + n-max %s = %d server starts, %d generations each"
          % (",".join(str(w) for w in widths), 2 + len(widths), len(cases) * args.repeats))
    if args.repeats < 3:
        print("NOTE: --repeats %d means one tok/s sample per case. Fine for the IDENTICAL/DIFFERS"
              % args.repeats)
        print("      answer, which is exact either way, but too noisy to rank configs by speed.")
        print("      Use --repeats 3 or more if the speed ranking is what you're after.")
    print()

    # --- control: is this setup even deterministic? -------------------------
    # If two identical non-MTP runs disagree, every downstream comparison is
    # noise and the honest answer is "can't tell", not "MTP broke it".
    print("[1/2] baseline, MTP OFF (run 1 of 2 -- determinism control)")
    base_a = run_config("baseline-a", args.port, None, cases, ctx, args.seed, args.startup_timeout, args.repeats)
    if base_a is None:
        sys.exit("baseline failed to start -- nothing to compare against.")
    print("[2/2] baseline, MTP OFF (run 2 of 2)")
    base_b = run_config("baseline-b", args.port, None, cases, ctx, args.seed, args.startup_timeout, args.repeats)
    if base_b is None:
        sys.exit("second baseline failed to start.")

    if base_a["outputs"] != base_b["outputs"]:
        print("\n!! CONTROL FAILED: two identical MTP-off runs produced different output.")
        print("   This machine isn't decoding deterministically at temperature 0, so an")
        print("   MTP-vs-baseline diff can't be attributed to MTP. Investigate that first.")
        for name in base_a["outputs"]:
            if base_a["outputs"][name] != base_b["outputs"][name]:
                print("   first divergent case: %s" % name)
                break
        sys.exit(2)
    print("  control OK -- MTP-off decoding is reproducible on this machine.\n")

    # Pool both baseline runs' speed samples. They are two separate loads of the
    # same configuration, so the spread between them IS the load-to-load
    # variance every MTP config below is also subject to -- folding it into the
    # baseline range is what stops a config that merely got a warm run from
    # looking faster than one that didn't.
    baseline = dict(base_a)
    pooled = list(base_a["samples"]) + list(base_b["samples"])
    if pooled:
        baseline["samples"] = pooled
        baseline["tps"] = statistics.median(pooled)
        baseline["lo"] = min(pooled)
        baseline["hi"] = max(pooled)
        baseline["n_samples"] = len(pooled)
    baseline["unstable"] = sorted(set(base_a["unstable"]) | set(base_b["unstable"]))
    results = []
    for n in widths:
        print("MTP ON, --spec-draft-n-max %d" % n)
        r = run_config("nmax%d" % n, args.port, n, cases, ctx, args.seed, args.startup_timeout, args.repeats)
        if r is None:
            results.append((n, None, None, None, None, None))
            print()
            continue
        same = r["outputs"] == baseline["outputs"]
        differing = [k for k in baseline["outputs"] if baseline["outputs"][k] != r["outputs"].get(k)]
        results.append((n, same, r["tps"], differing, r["ground"], r))
        print("  -> %s" % ("IDENTICAL to baseline" if same else "DIFFERS on: " + ", ".join(differing)))
        print()

    # ---------------------------- report -----------------------------------
    b_ung, b_bad, b_gens = summarise_ground(baseline["ground"])
    b_rng = "%.1f-%.1f" % (baseline["lo"], baseline["hi"])
    print("=" * 86)
    print("EQUIVALENCE + SPEED     baseline (MTP off): %.1f tok/s  [%d samples, %s]"
          % (baseline["tps"], baseline["n_samples"], b_rng))
    print("=" * 86)
    print("%-7s %-20s %9s %14s %9s %10s"
          % ("n-max", "output vs baseline", "tok/s", "range", "speedup", "ungrounded"))
    print("-" * 86)
    safe = []
    for n, same, tps, differing, ground, extra in results:
        if same is None:
            print("%-7d %-20s %9s %14s %9s %10s" % (n, "server failed", "-", "-", "-", "-"))
            continue
        ung, _, _ = summarise_ground(ground)
        speed = (tps / baseline["tps"]) if baseline["tps"] else 0.0
        print("%-7d %-20s %9.1f %14s %8.2fx %10d"
              % (n, "IDENTICAL" if same else "DIFFERS", tps,
                 "%.1f-%.1f" % (extra["lo"], extra["hi"]), speed, ung))
        if same:
            safe.append((n, speed, extra["lo"], extra["hi"]))
    print("-" * 86)
    print("%-7s %-20s %9.1f %14s %8.2fx %10d"
          % ("(off)", "baseline", baseline["tps"], b_rng, 1.0, b_ung))
    print()

    unstable_any = sorted({c for r in results if r[5] for c in r[5]["unstable"]}
                          | set(baseline["unstable"]))
    if unstable_any:
        print("!! WITHIN-SERVER INSTABILITY: identical repeated requests to one live server")
        print("   returned different text for: %s" % ", ".join(unstable_any))
        print("   Every comparison below is unreliable while that is true -- fix it first.")
        print()

    # --- quality readout, baseline only (identical configs share it) --------
    print("=" * 86)
    print("GROUNDING -- baseline answers, per case")
    print("=" * 86)
    print("%-30s %6s %8s %8s  %s" % ("case", "gens", "null-yrs", "schema", "invented (heuristic)"))
    print("-" * 86)
    for name, g in baseline["ground"].items():
        inv = ", ".join(g["ungrounded"][:3]) + ("..." if len(g["ungrounded"]) > 3 else "")
        print("%-30s %6d %8d %8s  %s"
              % (name[:30], g["generations"], g["years_null"],
                 "ok" if (g["json_ok"] and g["schema_ok"]) else "BAD",
                 inv or "-"))
    print("-" * 86)
    print("totals: %d generations extracted, %d malformed responses, %d ungrounded items"
          % (b_gens, b_bad, b_ung))
    print()
    print("'invented' is a normalised-substring heuristic, not a verdict -- a")
    print("legitimately-rephrased name can show up here. Its real job is being")
    print("IDENTICAL across configurations; if MTP ever moves it, that matters.")
    print()

    # ------------------------------ verdict ---------------------------------
    if not safe:
        print("VERDICT: no --spec-draft-n-max value matched the baseline on this machine.")
        print("Set LLAMA_MTP=0 in app/serve.py -- the speed isn't worth answers that")
        print("differ from what the model actually predicts.")
        return 1

    fastest = max(safe, key=lambda t: t[1])
    f_n, f_speed, f_lo, f_hi = fastest

    # Two configs are tied only when EACH one's median falls inside the other's
    # observed range. A one-sided test ("does its range reach mine?") is far too
    # permissive: a single slow sample widens one config's range enough to
    # swallow configs that are genuinely slower, and then the report claims a
    # tie that the numbers don't support.
    def tied_with(a, b):
        return (b[1] * baseline["tps"] >= a[2] and b[1] * baseline["tps"] <= a[3]
                and a[1] * baseline["tps"] >= b[2] and a[1] * baseline["tps"] <= b[3])

    tie_group = [t for t in safe if t is fastest or tied_with(fastest, t)]
    # Among tied configs prefer the tightest spread -- same speed, more
    # predictable per-request latency -- then the lowest width, which uses the
    # least memory.
    best_n, best_speed, best_lo, best_hi = min(
        tie_group, key=lambda t: (t[3] - t[2], t[0]))

    unsafe = [n for n, same, _, _, _, _ in results if same is False]
    print("VERDICT")
    print("  Safe (identical to baseline): n-max %s" % ", ".join(str(n) for n, _, _, _ in safe))
    if unsafe:
        print("  UNSAFE (output differs):      n-max %s" % ", ".join(str(n) for n in unsafe))
        print("  A differing answer is not a better answer -- same weights, and at")
        print("  temperature 0 the non-speculative result is correct by definition.")
    else:
        print("  UNSAFE: none of the widths tested (%s) -- issue #23302 does not reproduce here."
              % ", ".join(str(w) for w in widths))
    print()
    print("  Fastest safe setting: n-max %d at %.2fx baseline." % (f_n, f_speed))

    ties = [n for n, _, _, _ in tie_group if n != f_n]
    if ties:
        print("  Statistically tied with it (each median inside the other's range):")
        print("    n-max %s -- the measurement cannot separate these."
              % ", ".join(str(n) for n in sorted([f_n] + ties)))
    if best_n != f_n:
        reasons = ["a tighter spread (%.1f-%.1f vs %.1f-%.1f), i.e. more predictable "
                   "per-request latency" % (best_lo, best_hi, f_lo, f_hi)]
        if best_n < f_n:
            reasons.append("a narrower draft window, which is less memory")
        print("  RECOMMENDED: n-max %d (%.2fx, range %.1f-%.1f)."
              % (best_n, best_speed, best_lo, best_hi))
        print("  Same speed as n-max %d within measurement error, but %s."
              % (f_n, " and ".join(reasons)))

    slow = [(n, s) for n, s, _, _ in safe if s < 1.0]
    if slow:
        print("  Note: n-max %s came in BELOW 1.00x -- at those widths the drafting"
              % ", ".join(str(n) for n, _ in slow))
        print("  overhead isn't repaid, so MTP costs ~2GB of RAM to run slower than")
        print("  no MTP at all. Not a setting to pick.")

    if best_speed < 1.05 or best_lo <= baseline["hi"]:
        print("  CAUTION: the best safe config's sample range overlaps the baseline's")
        print("  (%.1f-%.1f vs %.1f-%.1f). On this evidence MTP is not demonstrably"
              % (best_lo, best_hi, baseline["lo"], baseline["hi"]))
        print("  faster at all. Raise --repeats and re-run before committing to it;")
        print("  if it still overlaps, LLAMA_MTP=0 is the honest setting.")
    else:
        print("  Set in app/serve.py:  LLAMA_SPEC_DRAFT_N_MAX default -> %d" % best_n)
    print()
    if baseline["n_samples"] <= len(cases):
        print("Caveat on the speed column: ONE sample per case. tok/s on a laptop varies")
        print("with thermal state and background load -- re-run with --repeats 3 before")
        print("acting on any margin narrower than about 10%.")
    else:
        print("Speed column: median of %d samples per configuration, with the observed range"
              % args.repeats)
        print("beside it. Overlapping ranges are not a difference. The baseline pools both")
        print("of its runs, so its range also captures load-to-load variance -- the same")
        print("variance every MTP config is subject to.")
    print()
    print("Re-run after any llama.cpp upgrade -- both the bug and the speed curve live")
    print("in the build you have installed, not in the model.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
