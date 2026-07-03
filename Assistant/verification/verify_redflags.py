# Path resolution to allow core imports when run from the verification subfolder
import os
import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

"""End-to-end verification of red-flag symptom detection."""
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


def check(label, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    tail = f"  ({detail})" if detail else ""
    print(f"[{mark}] {label}{tail}")
    return cond


results = []

print("\n== RED-FLAG POSITIVES (should fire) ==")

POSITIVE = [
    ("chest_pain",
     "My dad has crushing chest pain radiating to his left arm"),
    ("chest_pain",
     "I think my grandpa is having a heart attack"),
    ("stroke",
     "My mom's face is drooping on one side and she has slurred speech"),
    ("stroke",
     "Sudden weakness on her left side, she can't move her arm"),
    ("breathing",
     "I can't breathe"),
    ("breathing",
     "Dad is gasping for air and his lips are turning blue"),
    ("unresponsive",
     "My grandfather is unconscious and won't wake up"),
    ("bleeding",
     "Heavy bleeding that won't stop"),
    ("fall",
     "She fell down the stairs and can't get up"),
]

for expected_cat, q in POSITIVE:
    r = post("/chat", {"question": q})
    has_flag = any(rf["category"] == expected_cat for rf in r.get("red_flags", []))
    results.append(check(
        f"[{expected_cat}] '{q[:50]}'",
        has_flag and r["emergency"] is True and r["recommended_action"] == "call_911",
        detail=f"flags={[rf['category'] for rf in r.get('red_flags', [])]} emergency={r['emergency']}",
    ))

print("\n== RED-FLAG NEGATIVES (should NOT fire) ==")

NEGATIVE = [
    "What is a normal heart rate for elderly?",
    "My grandma likes to walk every morning",
    "What medications help with high blood pressure?",
    # Past / hypothetical
    "Last year my dad had chest pain and went to the hospital",
    "What if my mom couldn't breathe? What should I do?",
    "Years ago she fell and hit her head, is that still relevant?",
    # General wellness
    "How much water should elderly people drink daily?",
    "Should I worry about my dad forgetting names sometimes?",
]

for q in NEGATIVE:
    r = post("/chat", {"question": q})
    flags = r.get("red_flags", [])
    results.append(check(
        f"no flag: '{q[:60]}'",
        len(flags) == 0,
        detail=f"got flags={[f['category'] for f in flags]}" if flags else "",
    ))

print("\n== ARABIC POSITIVES ==")

ARABIC = [
    ("chest_pain", "جدي عنده ألم شديد في الصدر"),
    ("breathing",  "ماما مش قادرة أتنفس"),
    ("unresponsive", "أبويا فاقد الوعي"),
    ("bleeding",   "نزيف شديد من ذراعها"),
]

for expected_cat, q in ARABIC:
    r = post("/chat", {"question": q})
    has_flag = any(rf["category"] == expected_cat for rf in r.get("red_flags", []))
    results.append(check(
        f"[AR {expected_cat}] '{q}'",
        has_flag and r["emergency"] is True,
        detail=f"flags={[rf['category'] for rf in r.get('red_flags', [])]}",
    ))

print("\n== PRELUDE APPENDED ==")

r = post("/chat", {"question": "My dad has crushing chest pain radiating to his arm"})
has_urgent_marker = "URGENT" in r["answer"] or "🚨" in r["answer"] or "Call" in r["answer"][:500]
results.append(check("Red-flag prelude appears in answer",
                     has_urgent_marker,
                     detail=r["answer"][:150]))
results.append(check("Red-flag emergency_reason is set",
                     r.get("emergency_reason", "").startswith("red_flag:"),
                     detail=f"reason={r.get('emergency_reason')}"))

# ── Summary ────────────────────────────────────────────────────────────
print()
passed = sum(1 for x in results if x)
total = len(results)
rate = passed / total if total else 0
print(f"TOTAL: {passed}/{total} checks passed ({rate:.0%})")
sys.exit(0 if passed == total else 1)
