#!/usr/bin/env python3
"""Harvest fresh car data from DBpedia + live Wikipedia into
harvest/carweb_dbpedia_harvest.csv (4 sections: MAIN, PEOPLE, MAKES, RECENT).

Stdlib only — no pip installs needed. Takes ~1–2 minutes.
"""
import json, os, sys, time, datetime
import urllib.request, urllib.parse

UA = {"User-Agent": "CarWeb/2.0 (personal knowledge-graph project)"}

def sparql(query, tries=3):
    body = urllib.parse.urlencode({"query": query, "timeout": "170000"}).encode()
    req = urllib.request.Request("https://dbpedia.org/sparql", data=body,
        headers={**UA, "Accept": "text/csv",
                 "Content-Type": "application/x-www-form-urlencoded"})
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read().decode("utf-8")
        except Exception as e:
            if i == tries - 1: raise
            print(f"  retry {i+1} after: {e}", file=sys.stderr)
            time.sleep(5)

# MAX, not MIN, on the production end year. A car with several
# dbo:productionEndYear statements -- one per market, body style or engine
# variant -- was being given the EARLIEST of them, which frequently equals its
# start year and produced a one-year production run: Porsche 911 (930) came out
# as 1975-1975 for a car built until 1989, Toyota Corolla (E10) as 1966-1966,
# BMW 6 Series (E24) as 1976-1976. "When did production end" is a maximum.
# 803 of 6,785 models carried end == year before this.
Q_MAIN = '''SELECT ?s ?y (MAX(?ey) AS ?e)
(GROUP_CONCAT(DISTINCT ?mf;separator="~") AS ?mm)
(GROUP_CONCAT(DISTINCT ?dn;separator="~") AS ?dd)
(GROUP_CONCAT(DISTINCT ?rl;separator="~") AS ?rr)
(GROUP_CONCAT(DISTINCT ?pr;separator="~") AS ?pp)
(GROUP_CONCAT(DISTINCT ?sc;separator="~") AS ?ss)
WHERE{
 ?k skos:broader dbc:Cars_by_year_of_introduction.
 ?c dct:subject ?k.
 BIND(xsd:integer(STRAFTER(STR(?k),"in_")) AS ?y)FILTER(?y>=1880)
 BIND(STRAFTER(STR(?c),"resource/") AS ?s)
 OPTIONAL{?c dbo:productionEndYear ?b.BIND(year(?b) AS ?ey)}
 OPTIONAL{?c dbo:manufacturer ?m.BIND(STRAFTER(STR(?m),"resource/") AS ?mf)}
 OPTIONAL{?c dbo:designer|dbp:designer ?d.BIND(IF(isIRI(?d),STRAFTER(STR(?d),"resource/"),STR(?d)) AS ?dn)}
 OPTIONAL{?c dbo:relatedMeanOfTransportation ?r.BIND(STRAFTER(STR(?r),"resource/") AS ?rl)}
 OPTIONAL{?c dbo:predecessor ?p2.BIND(STRAFTER(STR(?p2),"resource/") AS ?pr)}
 OPTIONAL{?c dbo:successor ?s2.BIND(STRAFTER(STR(?s2),"resource/") AS ?sc)}
}GROUP BY ?s ?y'''

Q_PEOPLE = '''SELECT ?pn (MIN(?by) AS ?b)(MIN(?dy) AS ?d)(GROUP_CONCAT(DISTINCT ?nat;separator="~") AS ?nn)
WHERE{
 {SELECT DISTINCT ?p WHERE{?x a dbo:Automobile.?x dbo:designer|dbp:designer ?p.FILTER(isIRI(?p))}}
 BIND(STRAFTER(STR(?p),"resource/") AS ?pn)
 OPTIONAL{?p dbo:birthDate ?bb.BIND(year(?bb) AS ?by)}
 OPTIONAL{?p dbo:deathDate ?dd.BIND(year(?dd) AS ?dy)}
 OPTIONAL{?p dbo:nationality|dbp:nationality ?na.BIND(IF(isIRI(?na),STRAFTER(STR(?na),"resource/"),STR(?na)) AS ?nat)}
}GROUP BY ?pn'''

Q_MAKES = '''SELECT ?mn (MIN(?fy) AS ?f)(GROUP_CONCAT(DISTINCT ?cn;separator="~") AS ?cc)
WHERE{
 {SELECT DISTINCT ?m WHERE{?x a dbo:Automobile.?x dbo:manufacturer ?m}}
 BIND(STRAFTER(STR(?m),"resource/") AS ?mn)
 OPTIONAL{?m dbo:foundingYear ?fd.BIND(year(?fd) AS ?fy)}
 OPTIONAL{?m dbo:locationCountry|dbp:locationCountry|dbo:location ?co.BIND(IF(isIRI(?co),STRAFTER(STR(?co),"resource/"),STR(?co)) AS ?cn)}
}GROUP BY ?mn'''

def wiki_recent():
    """Live Wikipedia 'Cars introduced in YYYY' members for recent years
    (DBpedia's snapshot lags the newest model years)."""
    rows = []
    now = datetime.date.today().year
    for y in range(now - 3, now + 2):
        cont = ""
        while True:
            u = ("https://en.wikipedia.org/w/api.php?action=query&list=categorymembers"
                 f"&cmtitle=Category:Cars_introduced_in_{y}&cmlimit=500&cmtype=page&format=json"
                 + (f"&cmcontinue={urllib.parse.quote(cont)}" if cont else ""))
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60) as r:
                j = json.load(r)
            for m in j.get("query", {}).get("categorymembers", []):
                t = m["title"].replace(" ", "_").replace('"', '""')
                rows.append(f'"{t}",{y}')
            cont = j.get("continue", {}).get("cmcontinue", "")
            if not cont: break
        print(f"  wikipedia {y}: done", file=sys.stderr)
    return "title,year\n" + "\n".join(rows)

def main():
    os.makedirs("harvest", exist_ok=True)
    print("1/4 DBpedia: models 1880–today (the big one, ~30–60 s)…", file=sys.stderr)
    main_csv = sparql(Q_MAIN)
    n = main_csv.count("\n")
    if n < 3000: sys.exit(f"suspiciously short main response ({n} rows) — aborting, kept old harvest")
    print(f"      {n} rows", file=sys.stderr)
    print("2/4 DBpedia: people metadata…", file=sys.stderr)
    people_csv = sparql(Q_PEOPLE)
    print("3/4 DBpedia: manufacturer metadata…", file=sys.stderr)
    makes_csv = sparql(Q_MAKES)
    print("4/4 Wikipedia: recent model years…", file=sys.stderr)
    recent_csv = wiki_recent()
    with open("harvest/carweb_dbpedia_harvest.csv", "w", encoding="utf-8") as f:
        f.write("#===MAIN===\n" + main_csv.strip() + "\n")
        f.write("#===PEOPLE===\n" + people_csv.strip() + "\n")
        f.write("#===MAKES===\n" + makes_csv.strip() + "\n")
        f.write("#===RECENT===\n" + recent_csv.strip() + "\n")
    print("harvest written.", file=sys.stderr)

if __name__ == "__main__":
    main()
