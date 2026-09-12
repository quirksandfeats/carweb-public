#!/usr/bin/env python3
"""Merge the DBpedia/Wikipedia harvest into auto-generated source tables.

Reads  harvest/carweb_dbpedia_harvest.csv  (4 sections: MAIN, PEOPLE, MAKES, RECENT)
Writes d_auto.py  (AUTO_MODELS, AUTO_MAKES, AUTO_DESIGNERS, SUCCESSION, RELATED)
       harvest/merge_report.txt
Curated tables (d_models/d_people/d_links) always win on conflicts.
"""
import csv, io, re, sys, unicodedata
from collections import defaultdict, Counter
from d_people import MAKES as CUR_MAKES, DESIGNERS as CUR_DESIGNERS
from d_models import MODELS as CUR_MODELS

H = open("harvest/carweb_dbpedia_harvest.csv", encoding="utf-8").read()
sections = {}
for part in H.split("#===")[1:]:
    name, _, body = part.partition("===\n")
    sections[name] = body.strip()

def rows(section):
    r = csv.reader(io.StringIO(sections[section]))
    head = next(r)
    return list(r)

def deunder(s): return s.replace("_", " ").strip()

def norm(s):
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "", s.lower())

# ------------------------------------------------------------------ makes ---
# canonical make list: curated makes + common brands; longest-prefix match on titles
EXTRA_MAKES = {
    # brand: (country, founded)
    "Datsun": ("Japan", 1931), "Toyopet": ("Japan", 1947), "Prince": ("Japan", 1952),
    "Daihatsu": ("Japan", 1951), "Hino": ("Japan", 1942), "Mitsuoka": ("Japan", 1968),
    "Autozam": ("Japan", 1989), "Eunos": ("Japan", 1989), "Efini": ("Japan", 1991),
    "Vauxhall": ("United Kingdom", 1857), "Morris": ("United Kingdom", 1912),
    "Wolseley": ("United Kingdom", 1901), "Riley": ("United Kingdom", 1890),
    "MG": ("United Kingdom", 1924), "Austin-Healey": ("United Kingdom", 1952),
    "Hillman": ("United Kingdom", 1907), "Humber": ("United Kingdom", 1868),
    "Singer": ("United Kingdom", 1905), "Sunbeam": ("United Kingdom", 1905),
    "Standard": ("United Kingdom", 1903), "Jensen": ("United Kingdom", 1934),
    "Reliant": ("United Kingdom", 1935), "Bond": ("United Kingdom", 1949),
    "Marcos": ("United Kingdom", 1959), "Ginetta": ("United Kingdom", 1958),
    "Bristol": ("United Kingdom", 1945), "AC": ("United Kingdom", 1901),
    "Daimler": ("United Kingdom", 1896), "Vanden Plas": ("United Kingdom", 1913),
    "Caterham": ("United Kingdom", 1973), "Westfield": ("United Kingdom", 1982),
    "Noble": ("United Kingdom", 1999), "Ariel": ("United Kingdom", 1999),
    "BAC": ("United Kingdom", 2009), "Radical": ("United Kingdom", 1997),
    "Morgan": ("United Kingdom", 1910), "Panther": ("United Kingdom", 1972),
    "Talbot": ("France", 1903), "Simca": ("France", 1934), "Panhard": ("France", 1887),
    "Matra": ("France", 1964), "Venturi": ("France", 1984), "DS": ("France", 2014),
    "Facel Vega": ("France", 1954), "Ligier": ("France", 1968), "Aixam": ("France", 1983),
    "Borgward": ("Germany", 1919), "Glas": ("Germany", 1883), "NSU": ("Germany", 1873),
    "DKW": ("Germany", 1916), "Auto Union": ("Germany", 1932), "Wartburg": ("Germany", 1956),
    "Trabant": ("Germany", 1957), "Melkus": ("Germany", 1959), "Isdera": ("Germany", 1982),
    "Wiesmann": ("Germany", 1988), "Gumpert": ("Germany", 2004), "Artega": ("Germany", 2006),
    "Alpina": ("Germany", 1965), "Ruf": ("Germany", 1939), "Maybach": ("Germany", 1909),
    "Autobianchi": ("Italy", 1955), "Innocenti": ("Italy", 1947), "Iso": ("Italy", 1953),
    "Bizzarrini": ("Italy", 1964), "Cizeta": ("Italy", 1988), "Qvale": ("Italy", 2000),
    "Abarth": ("Italy", 1949), "Ghia": ("Italy", 1916), "Zagato": ("Italy", 1919),
    "Italdesign": ("Italy", 1968), "Fornasari": ("Italy", 1999), "Mazzanti": ("Italy", 2002),
    "Covini": ("Italy", 1978), "DR": ("Italy", 2006),
    "Oldsmobile": ("United States", 1897), "Buick": ("United States", 1899),
    "Lincoln": ("United States", 1917), "Packard": ("United States", 1899),
    "Studebaker": ("United States", 1852), "Rambler": ("United States", 1900),
    "Checker": ("United States", 1922), "Shelby": ("United States", 1962),
    "GMC": ("United States", 1911), "Hummer": ("United States", 1992),
    "Saleen": ("United States", 1983), "Panoz": ("United States", 1989),
    "Vector": ("United States", 1978), "Mosler": ("United States", 1985),
    "SSC": ("United States", 1998), "Hennessey": ("United States", 1991),
    "Fisker": ("United States", 2007), "Karma": ("United States", 2014),
    "Polaris": ("United States", 1954), "Callaway": ("United States", 1977),
    "Avanti": ("United States", 1965), "Zimmer": ("United States", 1978),
    "Excalibur": ("United States", 1964), "Clénet": ("United States", 1976),
    "Pontiac": ("United States", 1926),
    "Holden": ("Australia", 1856), "HSV": ("Australia", 1987), "Ford Australia": ("Australia", 1925),
    "Bolwell": ("Australia", 1963), "Elfin": ("Australia", 1957),
    "GAZ": ("Russia", 1932), "VAZ": ("Russia", 1966), "ZAZ": ("Ukraine", 1923),
    "ZIL": ("Russia", 1916), "Moskvitch": ("Russia", 1930), "UAZ": ("Russia", 1941),
    "Izh": ("Russia", 1966), "Aurus": ("Russia", 2018),
    "Tatra": ("Czech Republic", 1850), "Praga": ("Czech Republic", 1907),
    "Polski Fiat": ("Poland", 1932), "FSM": ("Poland", 1971), "Syrena": ("Poland", 1957),
    "Dacia": ("Romania", 1966), "ARO": ("Romania", 1957), "Oltcit": ("Romania", 1981),
    "Yugo": ("Serbia", 1980),
    "Volga": ("Russia", 1956),
    "Premier": ("India", 1944), "Hindustan": ("India", 1942), "Tata": ("India", 1945),
    "Mahindra": ("India", 1945), "Maruti Suzuki": ("India", 1981), "Maruti": ("India", 1981),
    "Force": ("India", 1958),
    "Proton": ("Malaysia", 1983), "Perodua": ("Malaysia", 1993),
    "Ssangyong": ("South Korea", 1954), "SsangYong": ("South Korea", 1954),
    "Daewoo": ("South Korea", 1982), "Asia": ("South Korea", 1965),
    "Renault Samsung": ("South Korea", 1994), "KG Mobility": ("South Korea", 1954),
    "Chery": ("China", 1997), "Geely": ("China", 1986), "Great Wall": ("China", 1984),
    "Haval": ("China", 2013), "BAIC": ("China", 1958), "SAIC": ("China", 1955),
    "FAW": ("China", 1953), "Dongfeng": ("China", 1969), "Changan": ("China", 1862),
    "GAC": ("China", 1954), "JAC": ("China", 1964), "MG Motor": ("China", 2006),
    "NIO": ("China", 2014), "XPeng": ("China", 2014), "Li Auto": ("China", 2015),
    "Hongqi": ("China", 1958), "Wuling": ("China", 2002), "Zeekr": ("China", 2021),
    "Lynk & Co": ("China", 2016), "Aiways": ("China", 2017), "Leapmotor": ("China", 2015),
    "Denza": ("China", 2010), "Ora": ("China", 2018), "Roewe": ("China", 2006),
    "Brilliance": ("China", 1992), "Lifan": ("China", 1992), "Zotye": ("China", 2005),
    "Landwind": ("China", 2004), "Haima": ("China", 1992), "Soueast": ("China", 1995),
    "Foton": ("China", 1996), "Maxus": ("China", 2011), "Aion": ("China", 2018),
    "Avatr": ("China", 2021), "Deepal": ("China", 2022), "IM": ("China", 2020),
    "Xiaopeng": ("China", 2014), "Hozon": ("China", 2014), "Neta": ("China", 2018),
    "VinFast": ("Vietnam", 2017),
    "Anadol": ("Turkey", 1966), "Togg": ("Turkey", 2018), "Tofaş": ("Turkey", 1968),
    "SEAT": ("Spain", 1950), "Cupra": ("Spain", 2018), "Hispano-Suiza": ("Spain", 1904),
    "GTA": ("Spain", 2005), "Tramontana": ("Spain", 2005),
    "Spyker": ("Netherlands", 1999), "Donkervoort": ("Netherlands", 1978),
    "Vencer": ("Netherlands", 2010), "Burton": ("Netherlands", 1998),
    "Gillet": ("Belgium", 1992), "Imperia": ("Belgium", 1906),
    "Rinspeed": ("Switzerland", 1979), "Monteverdi": ("Switzerland", 1967),
    "Sbarro": ("Switzerland", 1971), "Micro": ("Switzerland", 1996),
    "Puch": ("Austria", 1899), "KTM": ("Austria", 1992),
    "Rimac": ("Croatia", 2009), "DOK-ING": ("Croatia", 1991),
    "Buddy": ("Norway", 1991), "Think": ("Norway", 1991),
    "Uniti": ("Sweden", 2016), "NEVS": ("Sweden", 2012),
    "El-Bil": ("Denmark", 1985), "Zenvo": ("Denmark", 2007),
    "Automobili Pininfarina": ("Italy", 2018),
    "W Motors": ("United Arab Emirates", 2012),
    "Laraki": ("Morocco", 1999),
    "Perana": ("South Africa", 1967),
    "Troller": ("Brazil", 1995), "Gurgel": ("Brazil", 1969), "Puma": ("Brazil", 1966),
    "Agrale": ("Brazil", 1962), "Chamonix": ("Brazil", 1987),
    "IKA": ("Argentina", 1956), "Siam Di Tella": ("Argentina", 1910),
    "Enfield": ("Greece", 1973), "Namco": ("Greece", 1972),
    "ELVO": ("Greece", 1972),
    "Sono": ("Germany", 2016), "e.GO": ("Germany", 2015),
    "Lightyear": ("Netherlands", 2016),
    "Canoo": ("United States", 2017), "Bollinger": ("United States", 2015),
    "Aptera": ("United States", 2006), "Faraday Future": ("United States", 2014),
    "Slate": ("United States", 2022), "Scout": ("United States", 2022),
    "Ineos": ("United Kingdom", 2017), "Munro": ("United Kingdom", 2019),
    "Alef": ("United States", 2015),
}
ALL_MAKES = dict(CUR_MAKES)
for k, v in EXTRA_MAKES.items(): ALL_MAKES.setdefault(k, v)

# aliases seen at the start of Wikipedia titles -> canonical make
MAKE_ALIAS = {
    "Mercedes-AMG": "Mercedes-Benz", "Mercedes-Maybach": "Mercedes-Benz",
    "Mercedes": "Mercedes-Benz", "VW": "Volkswagen", "Chevy": "Chevrolet",
    "Škoda": "Škoda", "Skoda": "Škoda", "Citroen": "Citroën",
    "Rolls Royce": "Rolls-Royce", "Range Rover": "Land Rover",
    "Mini": "Mini", "MINI": "Mini", "smart": "Smart",
    "Alpine (automobile)": "Alpine", "Lada": "Lada", "AvtoVAZ": "Lada",
    "Ramcharger": "Dodge", "Ram": "Dodge", "Scion": "Scion",
    "Vauxhall Motors": "Vauxhall", "General Motors": "General Motors",
    "Lynk & Co": "Lynk & Co", "Lynk&Co": "Lynk & Co",
    "Alfa": "Alfa Romeo", "Aston": "Aston Martin", "Austin Healey": "Austin-Healey",
    "De Lorean": "DMC", "DeLorean": "DMC",
    "Rolls-Royce Motor Cars": "Rolls-Royce",
}

# manufacturer IRI -> canonical make (for titles whose make can't be prefix-derived)
MANUF_MAP = {
    "Toyota": "Toyota", "Honda": "Honda", "Nissan": "Nissan", "Mazda": "Mazda",
    "Subaru": "Subaru", "Suzuki": "Suzuki", "Mitsubishi_Motors": "Mitsubishi",
    "Daihatsu": "Daihatsu", "Isuzu": "Isuzu", "Hino_Motors": "Hino",
    "Hyundai_Motor_Company": "Hyundai", "Kia": "Kia", "Kia_Motors": "Kia",
    "Genesis_Motor": "Genesis", "SsangYong_Motor": "Ssangyong",
    "Volkswagen": "Volkswagen", "Audi": "Audi", "Porsche": "Porsche", "BMW": "BMW",
    "Mercedes-Benz": "Mercedes-Benz", "Daimler_AG": "Mercedes-Benz", "Opel": "Opel",
    "Ford_Motor_Company": "Ford", "Ford_of_Britain": "Ford", "Ford_of_Europe": "Ford",
    "Ford_Australia": "Ford", "General_Motors": "General Motors",
    "Chevrolet": "Chevrolet", "Buick": "Buick", "Cadillac": "Cadillac", "GMC_(automobile)": "GMC",
    "Chrysler": "Chrysler", "Dodge": "Dodge", "Jeep": "Jeep", "Stellantis": "Chrysler",
    "Fiat": "Fiat", "Fiat_Automobiles": "Fiat", "Ferrari": "Ferrari",
    "Lamborghini": "Lamborghini", "Maserati": "Maserati", "Alfa_Romeo": "Alfa Romeo",
    "Lancia": "Lancia", "Renault": "Renault", "Peugeot": "Peugeot", "Citroën": "Citroën",
    "Groupe_PSA": "Peugeot", "Volvo_Cars": "Volvo", "Saab_Automobile": "Saab",
    "Jaguar_Cars": "Jaguar", "Land_Rover": "Land Rover", "Rover_Company": "Rover",
    "Rover_(marque)": "Rover", "MG_Cars": "MG", "Austin_Motor_Company": "Austin",
    "British_Leyland": "Austin", "British_Motor_Corporation": "Austin",
    "Aston_Martin": "Aston Martin", "Bentley": "Bentley", "Rolls-Royce_Motor_Cars": "Rolls-Royce",
    "Rolls-Royce_Limited": "Rolls-Royce", "Lotus_Cars": "Lotus", "McLaren_Automotive": "McLaren",
    "Tesla,_Inc.": "Tesla", "Lucid_Motors": "Lucid", "Rivian": "Rivian",
    "BYD_Auto": "BYD", "Geely": "Geely", "Chery": "Chery", "Nio_(car_company)": "NIO",
    "Tata_Motors": "Tata", "Mahindra_&_Mahindra": "Mahindra", "Maruti_Suzuki": "Maruti Suzuki",
    "Škoda_Auto": "Škoda", "SEAT": "SEAT", "Dacia": "Dacia", "AvtoVAZ": "Lada",
    "Proton_Holdings": "Proton", "Perodua": "Perodua", "Holden": "Holden",
    "American_Motors_Corporation": "AMC", "Studebaker": "Studebaker",
    "Datsun": "Datsun", "Smart_(marque)": "Smart", "Mini_(marque)": "Mini",
}

# Aliases whose text is a SUB-BRAND or model line of the canonical make rather
# than a spelling variant of it. For these the matched text has to STAY in the
# model name. "Range Rover (P38A)" is a Land Rover, but stripping the matched
# "Range Rover" left a model literally called "(P38A)" -- which is how the Land
# Rover nameplate family ended up rendering with an empty label, since the
# family label is the text the members share once parentheticals come off.
# "Mercedes" -> "Mercedes-Benz", "VW" -> "Volkswagen" and "AvtoVAZ" -> "Lada"
# are the other kind: the same brand spelled differently, and there the matched
# text must still be dropped or every model gains a redundant prefix.
SUB_BRAND_ALIAS = {
    "Mercedes-AMG", "Mercedes-Maybach", "Range Rover", "Ram", "Ramcharger",
}

def known_make_prefix(title_spaced):
    """longest known make that prefixes the title"""
    cands = []
    for mk in list(ALL_MAKES) + list(MAKE_ALIAS):
        if title_spaced.lower().startswith(mk.lower() + " "):
            cands.append(mk)
    if not cands: return None, None
    mk = max(cands, key=len)
    rest = title_spaced[len(mk):].strip()
    canon = MAKE_ALIAS.get(mk, mk)
    if canon != mk and mk in SUB_BRAND_ALIAS:
        rest = title_spaced.strip()   # keep the sub-brand in the model name
    return canon, rest

def coinable_marque(token):
    """Whether a leading title token may be registered as a brand-new marque.

    Excludes a purely-numeric token -- a leading model year, common on pre-1959
    titles like "1937 Cord 812", which would otherwise register a marque called
    "1937". That guard already existed.

    Also excludes any token CONTAINING a digit, which is new. Real marque names
    effectively never do, and every one this rule had coined was a model whose
    title happened to resist prefix-matching: "MGS5" and "MGS6" became marques
    each owning a single model called "EV" (the cars are the MG S5 EV and S6
    EV), alongside "ZAZ-969", "ZIS-110", "Jenhoo EV48" and "Beltoise BT01".
    A rejected title falls through to the manufacturer field, and failing that
    is reported as unmatched -- which is the honest outcome, and far better
    than a bogus marque diluting a 1,130-strong make list.
    """
    return not any(ch.isdigit() for ch in token)


# Words that mark a parenthetical as one of Wikipedia's disambiguators rather
# than a generation or chassis code: "(1906 automobile)", "(French automobile)",
# "(steam automobile)", "(Nash Motors)", "(marque)", "(vehicle)". Deliberately
# does NOT match "(P38A)", "(Mark I)", "(EL-series)" or "(classic)".
DISAMBIGUATOR_RE = re.compile(
    r"\b(automobiles?|cars?|marque|vehicles?|company|motors?|truck|van|brand|"
    r"manufacturer|coachbuilder|cyclecar|microcar|supercar|hypercar|dragster|"
    r"roadster|revival|prototype|tractor|motorcycle)\b", re.I)

# A parenthetical that is nothing but a production span -- "Gordon
# (1912-1916)" against "Gordon (1954-1958)" -- is disambiguating two unrelated
# cars by era, so it reads as a label the same way. Both dash characters,
# because Wikipedia titles use an en dash and the data carries both.
DATE_RANGE_RE = re.compile(r"^\d{4}\s*[-\u2013]\s*\d{4}$")

JUNK_TITLE = re.compile(r"(List_of|Category:|Template:|_\(disambiguation\)|^Timeline|_lineup$)", re.I)

def clean_designers(raw):
    out = []
    if not raw: return out
    for part in raw.split("~"):
        p = deunder(part).strip()
        p = re.sub(r"\s*\(.*?\)$", "", p)          # strip trailing parens
        p = p.strip(" .;")
        if not p: continue
        # split multi-name literals
        chunks = re.split(r"\s+and\s+|,|&|;|/", p)
        for c in chunks:
            c = c.strip()
            if not c or len(c) > 38: continue
            if re.search(r"\d", c): continue        # years, displacements…
            if c.lower() in ("unknown", "n/a", "various", "in-house", "none"): continue
            bad = ("design", "styling", "studio", "centre", "center", "team",
                   "department", "gmbh", "s.p.a", "inc.", "ltd", "company")
            # keep known studios (curated) even if word matches
            if c in CUR_DESIGNERS: out.append(c); continue
            if any(b in c.lower() for b in bad): continue
            if len(c.split()) > 4: continue
            out.append(c)
    # dedupe, preserve order
    seen = set(); res = []
    for c in out:
        k = norm(c)
        if k in seen: continue
        seen.add(k); res.append(c)
    return res

# ------------------------------------------------------------------- main ---
main_rows = rows("MAIN")
by_title = {}
for s, y, e, mm, dd, rr, pp, ss in main_rows:
    if JUNK_TITLE.search(s): continue
    y = int(y)
    if y < 1880 or y > 2026: continue
    if s in by_title:
        prev = by_title[s]
        if y < prev["y"]: prev["y"] = y
        continue
    by_title[s] = dict(s=s, y=y, e=int(e) if e else None, mm=mm, dd=dd, rr=rr, pp=pp, ss=ss)

# RECENT top-up (live Wikipedia 2023–26)
recent_rows = [r for r in rows("RECENT")]
for t, y in recent_rows:
    if JUNK_TITLE.search(t): continue
    if t not in by_title:
        by_title[t] = dict(s=t, y=int(y), e=None, mm="", dd="", rr="", pp="", ss="")

# PEOPLE metadata
NAT = {"italian":"Italy","german":"Germany","french":"France","british":"United Kingdom",
 "english":"United Kingdom","american":"United States","japanese":"Japan","swedish":"Sweden",
 "dutch":"Netherlands","belgian":"Belgium","spanish":"Spain","austrian":"Austria",
 "swiss":"Switzerland","danish":"Denmark","korean":"South Korea","south korean":"South Korea",
 "argentine":"Argentina","brazilian":"Brazil","australian":"Australia","canadian":"Canada",
 "croatian":"Croatia","greek":"Greece","czech":"Czech Republic","polish":"Poland",
 "russian":"Russia","romanian":"Romania","turkish":"Turkey","chinese":"China","indian":"India",
 "malaysian":"Malaysia","norwegian":"Norway"}
people_meta = {}
for pn, b, d, nn in rows("PEOPLE"):
    name = deunder(re.sub(r"_\(.*?\)$", "", pn))
    country = None
    for cand in deunder(nn).split("~"):
        c = cand.strip()
        cl = c.lower()
        if cl in NAT: country = NAT[cl]; break
        if c in {"Italy","Germany","France","United Kingdom","United States","Japan","Sweden",
                 "Netherlands","Belgium","Spain","Austria","Switzerland","Denmark","South Korea",
                 "Argentina","Brazil","Australia","Canada","Croatia","Greece","Czech Republic",
                 "Poland","Russia","Romania","Turkey","China","India","Malaysia","Norway"}:
            country = c; break
    people_meta[norm(name)] = (int(b) if b else None, int(d) if d else None, country)

# MAKES metadata (country cleanup)
COUNTRIES = {"United_States":"United States","United_Kingdom":"United Kingdom","Japan":"Japan",
 "Germany":"Germany","Italy":"Italy","France":"France","Sweden":"Sweden","Spain":"Spain",
 "South_Korea":"South Korea","China":"China","India":"India","Russia":"Russia",
 "Czech_Republic":"Czech Republic","Poland":"Poland","Netherlands":"Netherlands",
 "Belgium":"Belgium","Austria":"Austria","Switzerland":"Switzerland","Australia":"Australia",
 "Canada":"Canada","Brazil":"Brazil","Argentina":"Argentina","Mexico":"Mexico",
 "Malaysia":"Malaysia","Turkey":"Turkey","Romania":"Romania","Serbia":"Serbia",
 "Ukraine":"Ukraine","Croatia":"Croatia","Denmark":"Denmark","Norway":"Norway",
 "Greece":"Greece","Vietnam":"Vietnam","Morocco":"Morocco","South_Africa":"South Africa",
 "United_Arab_Emirates":"United Arab Emirates","Soviet_Union":"Russia","East_Germany":"Germany",
 "West_Germany":"Germany","Czechoslovakia":"Czech Republic","Yugoslavia":"Serbia",
 "England":"United Kingdom","Scotland":"United Kingdom","Wales":"United Kingdom"}
makes_meta = {}
for mn, f, cc in rows("MAKES"):
    country = None
    for cand in cc.split("~"):
        cand = cand.strip()
        if cand in COUNTRIES: country = COUNTRIES[cand]; break
        if deunder(cand) in COUNTRIES.values(): country = deunder(cand); break
    makes_meta[mn] = (int(f) if f else None, country)

# ------------------------------------------------- match against curated ---
cur_by_wp = {}
cur_by_mn = {}
for (make, name, y0, y1, ds, wp, note) in CUR_MODELS:
    w = (wp or f"{make} {name}")
    cur_by_wp[norm(w)] = (make, name)
    cur_by_mn[(norm(make), norm(name))] = (make, name)

auto_models = []     # (make, name, y0, y1, [designers], wp, note)
auto_makes = {}      # make -> (country, founded)
auto_designers = {}  # name -> (kind,b,d,country,note)
unmatched_make = Counter()
title_to_ref = {}    # harvest title -> ("cur",(make,name)) | ("auto",(make,name))

# pass 0: count first words so recurring unknown brands can become makes
first_words = Counter()
for t in by_title:
    spaced = deunder(t)
    w = spaced.split(" (")[0].split()
    if w: first_words[w[0]] += 1

def manufacturer_make(rec):
    """derive a make from the dbo:manufacturer field, auto-registering it"""
    for m in rec["mm"].split("~"):
        m = m.strip()
        if not m: continue
        if m in MANUF_MAP: return MANUF_MAP[m]
        cand = deunder(re.sub(r"_\(.*?\)$", "", m))
        cand = re.sub(r"\s+(Motors?|Motor Company|Auto|Automobiles?|Automotive|Cars|Group|Corporation|Holdings?|Company|Inc\.?|Ltd\.?|AG|GmbH|S\.p\.A\.?|Co\.)$", "", cand).strip()
        if not cand or len(cand) > 28: continue
        # Same rule as the two title-derived coining sites: never register a
        # marque whose name carries a digit. This third path was missed and is
        # how "Beltoise BT01" and "Jenhoo EV48" became marques -- DBpedia gives
        # both articles a self-referential dbo:manufacturer, so the model name
        # arrived here as the manufacturer name.
        if cand not in ALL_MAKES and not coinable_marque(cand): continue
        if cand not in ALL_MAKES and cand not in auto_makes:
            f, ctry = makes_meta.get(m, (None, None))
            auto_makes[cand] = (ctry or "Unknown", f)
            ALL_MAKES[cand] = auto_makes[cand]
        return cand
    return None

for t, rec in sorted(by_title.items()):
    spaced = deunder(t)
    key = norm(spaced)
    if key in cur_by_wp:
        title_to_ref[t] = ("cur", cur_by_wp[key]); continue
    make, rest = known_make_prefix(spaced)
    if not make:
        # try manufacturer field
        for m in rec["mm"].split("~"):
            if m in MANUF_MAP: make = MANUF_MAP[m]; break
    if not make:
        # recurring unknown first word -> treat as a marque (e.g. Aeolus, AITO).
        # Excludes purely-numeric tokens (a leading model year, common on
        # older/pre-1959 article titles like "1937 Cord 812") so a year never
        # gets mistaken for a marque name.
        w = spaced.split(" (")[0].split()
        if w and first_words[w[0]] >= 2 and len(w) > 1 and re.match(r"^[A-Z0-9]", w[0]) and coinable_marque(w[0]):
            make = w[0]
            if make not in ALL_MAKES and make not in auto_makes:
                f, ctry = makes_meta.get(make.replace(" ", "_"), (None, None))
                if not ctry:
                    for m in rec["mm"].split("~"):
                        _, c2 = makes_meta.get(m, (None, None))
                        if c2: ctry = c2; break
                auto_makes[make] = (ctry or "Unknown", f)
                ALL_MAKES[make] = auto_makes[make]
            rest = spaced[len(make):].strip()
    if not make:
        make = manufacturer_make(rec)
        if make: rest = spaced
    if not make:
        # last resort: keep the article as a one-off under its first word
        # (again excluding a bare leading year -- better to leave it unmatched
        # for the report than register a "make" like '1937')
        w = spaced.split(" (")[0].split()
        if w and re.match(r"^[A-Z0-9]", w[0]) and coinable_marque(w[0]):
            make = w[0]
            rest = spaced[len(make):].strip() or spaced
            if make not in ALL_MAKES and make not in auto_makes:
                f, ctry = makes_meta.get(make.replace(" ", "_"), (None, None))
                auto_makes[make] = (ctry or "Unknown", f)
                ALL_MAKES[make] = auto_makes[make]
    if not make:
        unmatched_make[spaced] += 1
        continue
    name = rest if rest else spaced
    # strip a leading repeat of the make from name; tidy qualifiers
    name = re.sub(r"\s*\((automobile|car|sedan|SUV)\)$", "", name).strip()
    # A name that is nothing BUT a parenthetical rendered as "AAG · (1906
    # automobile)" on the card and as a bare "(1906 automobile)" dot on the
    # graph. Where that parenthetical is a Wikipedia DISAMBIGUATOR -- its way of
    # separating unrelated things that share a title -- the text inside it is
    # the only distinguishing information there is, so promote it to the label.
    #
    # Restricted to disambiguators on purpose. A parenthetical naming a chassis
    # code is not one, and stripping its brackets breaks nameplate grouping:
    # the Range Rover generations arrive as "(P38A)", "(L322)", "(L405)" and
    # "(L460)" under the Land Rover marque, and base_name() collapses all four
    # to the same empty base, which is exactly what groups them into one
    # nameplate. Rewritten to "P38A", "L322" and so on they group by nothing at
    # all and the family dissolves -- which is what happened when this rule
    # fired on everything.
    if name.startswith("(") and name.endswith(")"):
        inner = name[1:-1].strip()
        if DISAMBIGUATOR_RE.search(inner) or DATE_RANGE_RE.match(inner):
            name = inner or make
    if not name: continue
    if (norm(make), norm(name)) in cur_by_mn:
        title_to_ref[t] = ("cur", cur_by_mn[(norm(make), norm(name))]); continue
    ds = clean_designers(rec["dd"])
    for d in ds:
        if d not in CUR_DESIGNERS and d not in auto_designers:
            b, dd_, ctry = people_meta.get(norm(d), (None, None, None))
            auto_designers[d] = ("person", b, dd_, ctry, None)
    if make not in CUR_MAKES and make not in auto_makes:
        c_f = ALL_MAKES.get(make)
        if not c_f:
            f, ctry = makes_meta.get(make.replace(" ", "_"), (None, None))
            c_f = (ctry or "Unknown", f)
        auto_makes[make] = c_f
    auto_models.append((make, name, rec["y"], rec["e"], ds, spaced, None))
    title_to_ref[t] = ("auto", (make, name))

# succession / related edges (harvest-title space -> (make,name) refs)
def refs_of(field):
    out = []
    for x in field.split("~"):
        x = x.strip()
        if x and x in title_to_ref: out.append(title_to_ref[x][1])
    return out

SUCCESSION, RELATED = [], []
seen_pairs = set()
for t, rec in by_title.items():
    if t not in title_to_ref: continue
    a = title_to_ref[t][1]
    for b in refs_of(rec["ss"]):
        p = tuple(sorted((a, b)))
        if a != b and p not in seen_pairs:
            seen_pairs.add(p); SUCCESSION.append((a, b))   # a -> succeeded by b
    for b in refs_of(rec["pp"]):
        p = tuple(sorted((a, b)))
        if a != b and p not in seen_pairs:
            seen_pairs.add(p); SUCCESSION.append((b, a))
    for b in refs_of(rec["rr"]):
        p = tuple(sorted((a, b)))
        if a != b and p not in seen_pairs:
            seen_pairs.add(p); RELATED.append(p)

# country fixes for auto-registered makes the harvest couldn't resolve
COUNTRY_FIX = {
 "Baojun":"China","Trumpchi":"China","Aeolus":"China","Forthing":"China","Beijing":"China",
 "Jinbei":"China","Changhe":"China","Jetour":"China","Huanghai":"China","Huansu":"China",
 "Luxgen":"Taiwan","Saipa":"Iran","Exeed":"China","IKCO":"Iran","Fengon":"China",
 "Hyptec":"China","Sehol":"China","Ultima":"United Kingdom","Farizon":"China",
 "KGM":"South Korea","Sauber":"Switzerland","Stimson":"United Kingdom","Tatuus":"Italy",
 "WM":"China","Yema":"China","Zhongxing":"China","ZiL":"Russia","Cowin":"China",
 "Hawtai":"China","Jiabao":"China","Kandi":"China","Luxeed":"China","Riich":"China",
 "Senova":"China","UMM":"Portugal","Vanderhall":"United States","Ascari":"United Kingdom",
 "Bisu":"China","Chevron":"United Kingdom","Dorcen":"China","Gonow":"China","ICar":"China",
 "Jetta":"China","Keyton":"China","LEVC":"United Kingdom","Lola":"United Kingdom",
 "Maextro":"China","Rely":"China","Renault Sport":"France","Rezvani":"United States",
 "Shuanghuan":"China","Traum":"China","Yudo":"China","Courage":"France","Li":"China",
 "Ora":"China","Tank":"China","Wey":"China","Voyah":"China","Skywell":"China",
 "Arcfox":"China","Bestune":"China","Kaiyi":"China","Livan":"China","Nezha":"China",
 "Qoros":"China","Venucia":"China","Weltmeister":"China","Xingyue":"China","Onvo":"China",
 "Firefly":"China","Stelato":"China","Aito":"China","AITO":"China","Polestar":"Sweden",
 "Radford":"United Kingdom","Ginetta":"United Kingdom","Praga":"Czech Republic",
 "Pagani":"Italy","Bertone":"Italy","Pininfarina":"Italy","Touring":"Italy",
 "Fioravanti":"Italy","Castagna":"Italy","Spada":"Italy","Osca":"Italy","OSCA":"Italy",
 "Intermeccanica":"Italy","Moretti":"Italy","Siata":"Italy","Vignale":"Italy",
 "Marussia":"Russia","Kombat":"Russia","Dartz":"Latvia","Tushek":"Slovenia",
 "Arrinera":"Poland","Hyperion":"United States","Czinger":"United States",
 "Drako":"United States","Lordstown":"United States","VLF":"United States",
 "Elio":"United States","Nikola":"United States","Ram":"United States",
 "Brabus":"Germany","Mansory":"Germany","9ff":"Germany","TechArt":"Germany",
 "Apollo":"Germany","Bitter":"Germany","Yes!":"Germany","Adam":"Pakistan",
 "Effeffe":"Italy","David":"Spain","Hurtan":"Spain","Aspark":"Japan","Aspid":"Spain",
 "GLM":"Japan","Tommykaira":"Japan","Dome":"Japan","Vemac":"Japan","Galpin":"United States",
 "Deus":"Austria","Deus Automobiles":"Austria","Buffalo":"United States",
}

# --------------------------------------------------------------- emit -------
for mk in list(auto_makes):
    co, f = auto_makes[mk]
    if co == "Unknown" and mk in COUNTRY_FIX:
        auto_makes[mk] = (COUNTRY_FIX[mk], f)

def pyrepr(x): return repr(x)

with open("d_auto.py", "w", encoding="utf-8") as f:
    f.write("# AUTO-GENERATED by merge_harvest.py — do not edit by hand.\n")
    f.write("# Source: DBpedia (CC BY-SA) + live Wikipedia category top-up.\n\n")
    f.write("AUTO_MAKES = {\n")
    for k in sorted(auto_makes): f.write(f" {k!r}: {auto_makes[k]!r},\n")
    f.write("}\n\nAUTO_DESIGNERS = {\n")
    for k in sorted(auto_designers): f.write(f" {k!r}: {auto_designers[k]!r},\n")
    f.write("}\n\nAUTO_MODELS = [\n")
    for m in sorted(auto_models): f.write(f" {m!r},\n")
    f.write("]\n\nSUCCESSION = [\n")
    for p in sorted(SUCCESSION): f.write(f" {p!r},\n")
    f.write("]\n\nRELATED = [\n")
    for p in sorted(RELATED): f.write(f" {p!r},\n")
    f.write("]\n")

with open("harvest/merge_report.txt", "w", encoding="utf-8") as f:
    f.write(f"harvest titles kept:   {len(by_title)}\n")
    f.write(f"matched curated:       {sum(1 for v in title_to_ref.values() if v[0]=='cur')}\n")
    f.write(f"auto models:           {len(auto_models)}\n")
    f.write(f"auto makes:            {len(auto_makes)}\n")
    f.write(f"auto designers:        {len(auto_designers)}\n")
    f.write(f"succession edges:      {len(SUCCESSION)}\n")
    f.write(f"related edges:         {len(RELATED)}\n")
    f.write(f"unmatched (no make):   {len(unmatched_make)}\n\n")
    f.write("---- unmatched titles ----\n")
    for t, _ in unmatched_make.most_common(400): f.write(t + "\n")

print(f"auto models={len(auto_models)} makes={len(auto_makes)} designers={len(auto_designers)} "
      f"succ={len(SUCCESSION)} rel={len(RELATED)} unmatched={len(unmatched_make)}")
