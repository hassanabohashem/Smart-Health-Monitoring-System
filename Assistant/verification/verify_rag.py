# Path resolution to allow core imports when run from the verification subfolder
import os
import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

"""Verify RAG (Retrieval-Augmented Generation) integration."""
import json
import sys
import urllib.parse
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:8000"


def post(path, body):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


results = []

def check(label, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    tail = f"  ({detail})" if detail else ""
    print(f"[{mark}] {label}{tail}")
    results.append(cond)
    return cond


# ── Index sanity ───────────────────────────────────────────────────────
print("\n== Index stats ==")
s = get("/rag/stats")
check(f"corpus has {len(s['corpus_files'])} files",
      len(s["corpus_files"]) >= 5)
check("index_exists is True (built during prior calls)",
      s["index_exists"] is True)

# ── Retrieval quality (English) ───────────────────────────────────────
print("\n== Retrieval quality — English ==")

# Each tuple: (query, acceptable sources — PASS if at least one is retrieved)
queries_en = [
    ("how to prevent falls in elderly",
     ["03_fall_prevention_steadi.md", "14_world_falls_prevention_guidelines.pdf"]),
    ("beers criteria dangerous medications",
     ["02_beers_criteria_summary.md"]),
    ("what is normal SpO2 for elderly",
     ["01_vital_signs_reference.md"]),
    ("how much water should elderly drink",
     ["05_daily_wellness.md", "12_us_dietary_guidelines.pdf"]),
    ("heart failure warning signs",
     ["04_common_chronic_conditions.md"]),
]

for q, acceptable_sources in queries_en:
    q_enc = urllib.parse.quote(q)
    r = get(f"/rag/preview?q={q_enc}&k=3")
    chunks = r["chunks"]
    found = [s for s in acceptable_sources if s in chunks]
    check(
        f"retrieves from {'/'.join(acceptable_sources)} for '{q}'",
        len(found) > 0,
        detail=f"got chunks containing: {found or 'none'}",
    )

# ── Retrieval quality (Arabic) ────────────────────────────────────────
print("\n== Retrieval quality — Arabic ==")

queries_ar = [
    ("علامات الخطر عند كبار السن", "06_arabic_wellness.md"),
    ("الوقاية من السقوط", "06_arabic_wellness.md"),
]

for q, expected_source in queries_ar:
    q_enc = urllib.parse.quote(q)
    r = get(f"/rag/preview?q={q_enc}&k=3")
    chunks = r["chunks"]
    check(
        f"retrieves from {expected_source} for Arabic query",
        expected_source in chunks,
    )

# ── End-to-end: chat uses RAG context ─────────────────────────────────
print("\n== End-to-end: chat answers cite corpus ==")

# A question whose answer SHOULD come from 03_fall_prevention_steadi.md
r = post("/chat", {
    "question": "What specific medications increase fall risk in elderly?"
})
ans_low = r["answer"].lower()
# Beers / STEADI content should show up. These are ALL drug/class names from
# the corpus files — any 2+ of them suggests the LLM used the retrieved context.
keywords = [
    "benzodiazepine", "zolpidem", "opioid", "antihistamine", "diphenhydramine",
    "tricyclic", "amitriptyline", "cyclobenzaprine", "glyburide", "sulfonylurea",
    "z-drug", "muscle relaxant", "orphenadrine", "carisoprodol", "methocarbamol",
    "oxybutynin", "beers",
    # Broader terms — the LLM may abstract instead of naming specific drugs
    "antidepressant", "antipsychotic", "frid", "sedation", "orthostatic",
    "anticholinergic", "diuretic", "sleep aid",
]
matched = [k for k in keywords if k in ans_low]
check(
    "answer mentions corpus-specific fall-risk meds",
    len(matched) >= 2,
    detail=f"matched keywords: {matched}",
)

# Question about Beers-specific medication
r = post("/chat", {
    "question": "Is Benadryl safe for my 82-year-old grandmother to take at night for sleep?"
})
ans_low = r["answer"].lower()
check(
    "Benadryl question yields correct Beers-style answer",
    ("anticholinergic" in ans_low or "beers" in ans_low or "confusion" in ans_low or "fall" in ans_low),
    detail=r["answer"][:200],
)

# ── Summary ───────────────────────────────────────────────────────────
print()
passed = sum(1 for x in results if x)
total = len(results)
print(f"TOTAL: {passed}/{total} checks passed ({passed/total:.0%})")
sys.exit(0 if passed == total else 1)
