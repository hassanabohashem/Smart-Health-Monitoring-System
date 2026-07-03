# Path resolution to allow core imports when run from the verification subfolder
import os
import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

"""Verify drug-interaction and Beers warnings."""
import json
import sys
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


results = []

def check(label, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    tail = f"  ({detail})" if detail else ""
    print(f"[{mark}] {label}{tail}")
    results.append(cond)


def chat_with_meds(meds, question="Tell me about my medications."):
    return post("/chat", {
        "question": question,
        "patient": {"age": 78, "sex": "F", "medications": meds},
    })


# ── Unit tests on the checker directly ─────────────────────────────────
from core.drug_interactions import (
    check_medications, normalize_drug_name, DrugWarning,
)

print("\n== Drug name normalization ==")
cases = [
    ("Lisinopril 10mg daily", "lisinopril"),
    ("Coumadin (warfarin)", "warfarin"),
    ("Bayer aspirin 81mg", "aspirin"),
    ("Advil", "ibuprofen"),
    ("Ambien 10mg", "zolpidem"),
    ("Benadryl", "diphenhydramine"),
]
for raw, expected in cases:
    got = normalize_drug_name(raw)
    check(f"normalize({raw!r}) -> {got!r}", got == expected)

print("\n== Single-drug Beers warnings ==")
# Benadryl alone -> avoid
ws = check_medications(["Benadryl"])
check("Benadryl -> beers_avoid warning",
      any(w.category == "beers_avoid" and "diphenhydramine" in w.drugs for w in ws))
ws = check_medications(["Ambien"])
check("Ambien -> z-drug beers warning",
      any(w.category == "beers_avoid" and "zolpidem" in w.drugs for w in ws))

print("\n== Pairwise interactions ==")
# Warfarin + Ibuprofen -> major GI bleed warning
ws = check_medications(["Coumadin", "Advil"])
check("Warfarin + NSAID -> major bleeding interaction",
      any(w.level == "major" and "warfarin" in w.drugs and
          any(n in w.drugs for n in ["ibuprofen", "naproxen"]) for w in ws))

# ACE + K-sparing -> hyperkalemia
ws = check_medications(["lisinopril", "spironolactone"])
check("ACE + K-sparing diuretic -> major hyperkalemia warning",
      any(w.level == "major" and "lisinopril" in w.drugs and "spironolactone" in w.drugs for w in ws))

# SSRI + MAOI -> avoid
ws = check_medications(["fluoxetine", "phenelzine"])
check("SSRI + MAOI -> avoid",
      any(w.level == "avoid" for w in ws))

# Opioid + benzo -> avoid (black box)
ws = check_medications(["oxycodone", "lorazepam"])
check("Opioid + benzo -> avoid",
      any(w.level == "avoid" for w in ws))

print("\n== Anticholinergic burden ==")
ws = check_medications(["amitriptyline", "oxybutynin"])
check("2 anticholinergics -> burden warning",
      any(w.category == "anticholinergic_burden" for w in ws))

print("\n== Safe combinations (no warnings) ==")
# Common safe combo: lisinopril + atorvastatin + metformin
ws = check_medications(["lisinopril", "atorvastatin", "metformin"])
check("Safe combo -> no warnings", len(ws) == 0,
      detail=f"got {[w.level + ':' + w.category for w in ws]}")

# ── API-level tests ────────────────────────────────────────────────────
print("\n== API exposes drug_warnings ==")
r = chat_with_meds(["Coumadin 5mg", "Advil 200mg"], "Is it safe to take these together?")
check("API returns drug_warnings array",
      isinstance(r.get("drug_warnings"), list) and len(r["drug_warnings"]) > 0)
check("Warning has required fields",
      all(k in r["drug_warnings"][0] for k in ["level", "category", "drugs", "message", "citation"]))

# LLM should either (a) directly mention the interaction, or (b) safely
# defer to a healthcare professional. Both are acceptable — the structured
# drug_warnings field already has the details.
ans_low = r["answer"].lower()
ans_raw = r["answer"]
mentions_interaction = (
    any(w in ans_low for w in ["warfarin", "coumadin", "bleeding", "ibuprofen",
                                "advil", "nsaid", "interaction", "risk"]) or
    any(w in ans_raw for w in ["وارفارين", "كومادين", "نزيف", "تفاعل", "خطر",
                                "إيبوبروفين", "آدفيل"])
)
defers_safely = any(w in ans_low for w in [
    "consult", "healthcare", "doctor", "professional", "prescriber",
    "pharmacist", "can't provide", "cannot provide", "can't answer",
])
check("LLM answer addresses the interaction (mention or defer)",
      mentions_interaction or defers_safely,
      detail=r["answer"][:150])

print("\n== Brand names get normalized and flagged ==")
r = chat_with_meds(["Benadryl", "Ambien", "Xanax"], "Are these safe for my grandma?")
check("Multi-Beers meds flagged",
      len(r.get("drug_warnings", [])) >= 2,
      detail=f"warnings count: {len(r.get('drug_warnings', []))}")

print("\n== No meds / empty -> no warnings ==")
r = post("/chat", {"question": "Hello"})
check("No patient -> no drug_warnings",
      r.get("drug_warnings") == [])

r = post("/chat", {"question": "Hello",
                   "patient": {"age": 70, "medications": []}})
check("Empty meds list -> no drug_warnings",
      r.get("drug_warnings") == [])

# ── Summary ─────────────────────────────────────────────────────────────
print()
passed = sum(1 for x in results if x)
total = len(results)
print(f"TOTAL: {passed}/{total} checks passed ({passed/total:.0%})")
sys.exit(0 if passed == total else 1)
