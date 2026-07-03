"""
Drug-interaction and Beers-Criteria warnings for elderly care.

Runs BEFORE the LLM call when `patient.medications` is present. Results are:
  (a) Injected into the system prompt so the LLM can reason about them.
  (b) Returned as structured `drug_warnings` in the API response, so the
      mobile app can surface them as first-class warnings.

Knowledge base is a curated set of high-impact rules relevant to elderly
patients. Not exhaustive — designed to catch the most common and dangerous
cases documented in:
  - 2023 AGS Beers Criteria for Potentially Inappropriate Medications
  - STOPP/START v3 (screening tool for older people's prescriptions)
  - WHO essential medicines elderly safety notes
  - FDA / ADR reports for common combinations

The checker operates on simple drug-name normalization (lowercase, strip
dose strings) plus a small brand→generic map. Good enough for checking a
6-12 medication list.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple


@dataclass
class DrugWarning:
    level: str      # "avoid" | "major" | "moderate" | "monitor"
    category: str   # "beers_avoid" | "interaction" | "anticholinergic_burden" | "qt_prolong"
    drugs: List[str]
    message: str
    citation: str


# ── Brand → generic map (partial; covers the common ones) ─────────────
# Users often write brand names. We normalize to the generic so rules match.
_BRAND_TO_GENERIC: Dict[str, str] = {
    # Cardio
    "coumadin": "warfarin",
    "xarelto": "rivaroxaban",
    "eliquis": "apixaban",
    "lipitor": "atorvastatin",
    "zocor": "simvastatin",
    "plavix": "clopidogrel",
    "tenormin": "atenolol",
    "inderal": "propranolol",
    "lopressor": "metoprolol",
    "toprol": "metoprolol",
    "norvasc": "amlodipine",
    "cardizem": "diltiazem",
    "calan": "verapamil",
    "prinivil": "lisinopril",
    "zestril": "lisinopril",
    "cozaar": "losartan",
    "diovan": "valsartan",
    "lasix": "furosemide",
    "microzide": "hydrochlorothiazide",
    "aldactone": "spironolactone",
    "digitek": "digoxin",
    "lanoxin": "digoxin",
    "cordarone": "amiodarone",
    # Diabetes
    "glucophage": "metformin",
    "diabeta": "glyburide",
    "micronase": "glyburide",
    "glucotrol": "glipizide",
    # Pain / NSAIDs
    "advil": "ibuprofen",
    "motrin": "ibuprofen",
    "aleve": "naproxen",
    "naprosyn": "naproxen",
    "celebrex": "celecoxib",
    "tylenol": "acetaminophen",
    "panadol": "acetaminophen",
    "ultram": "tramadol",
    "oxycontin": "oxycodone",
    "percocet": "oxycodone",
    "vicodin": "hydrocodone",
    # Psychiatry / sleep
    "ambien": "zolpidem",
    "valium": "diazepam",
    "ativan": "lorazepam",
    "xanax": "alprazolam",
    "klonopin": "clonazepam",
    "halcion": "triazolam",
    "elavil": "amitriptyline",
    "pamelor": "nortriptyline",
    "prozac": "fluoxetine",
    "zoloft": "sertraline",
    "paxil": "paroxetine",
    "lexapro": "escitalopram",
    "celexa": "citalopram",
    "effexor": "venlafaxine",
    "cymbalta": "duloxetine",
    "remeron": "mirtazapine",
    "trazodone": "trazodone",
    # Antihistamines / anticholinergics
    "benadryl": "diphenhydramine",
    "unisom": "doxylamine",
    "ditropan": "oxybutynin",
    "detrol": "tolterodine",
    "enablex": "darifenacin",
    # GI
    "prilosec": "omeprazole",
    "nexium": "esomeprazole",
    "protonix": "pantoprazole",
    "zantac": "ranitidine",
    # Antibiotics / misc
    "cipro": "ciprofloxacin",
    "levaquin": "levofloxacin",
    "zithromax": "azithromycin",
    # Aspirin
    "ecotrin": "aspirin",
    "bayer": "aspirin",
    "asa": "aspirin",
    # Inhalers
    "proventil": "albuterol",
    "ventolin": "albuterol",
    "spiriva": "tiotropium",
    "advair": "salmeterol",
}


# ── Drug classes (groups of generics) ─────────────────────────────────
_NSAIDS = {"ibuprofen", "naproxen", "diclofenac", "celecoxib", "indomethacin",
           "ketorolac", "meloxicam", "piroxicam"}
_BENZODIAZEPINES = {"diazepam", "lorazepam", "alprazolam", "clonazepam",
                    "triazolam", "midazolam", "temazepam", "oxazepam"}
_OPIOIDS = {"oxycodone", "hydrocodone", "morphine", "fentanyl", "codeine",
            "tramadol", "methadone", "hydromorphone"}
_Z_DRUGS = {"zolpidem", "zaleplon", "eszopiclone", "zopiclone"}
_ANTICHOLINERGICS_HIGH = {
    "diphenhydramine", "doxylamine", "oxybutynin", "tolterodine",
    "darifenacin", "amitriptyline", "nortriptyline", "imipramine",
    "doxepin", "paroxetine", "chlorpheniramine", "hyoscyamine",
    "scopolamine", "cyclobenzaprine",
}
_SSRI = {"fluoxetine", "sertraline", "paroxetine", "escitalopram",
         "citalopram", "fluvoxamine"}
_MAOI = {"phenelzine", "tranylcypromine", "isocarboxazid", "selegiline"}
_SEROTONERGIC_NON_SSRI = {"tramadol", "venlafaxine", "duloxetine",
                          "mirtazapine", "trazodone", "linezolid"}
_ACE_INHIBITORS = {"lisinopril", "enalapril", "ramipril", "benazepril",
                   "captopril", "quinapril", "fosinopril"}
_ARB = {"losartan", "valsartan", "candesartan", "olmesartan", "telmisartan",
        "irbesartan"}
_K_SPARING_DIURETICS = {"spironolactone", "eplerenone", "triamterene",
                        "amiloride"}
_NON_DHP_CCB = {"verapamil", "diltiazem"}
_BETA_BLOCKERS = {"atenolol", "metoprolol", "propranolol", "bisoprolol",
                  "carvedilol", "nebivolol"}
_QT_PROLONGING = {"amiodarone", "sotalol", "azithromycin", "ciprofloxacin",
                  "levofloxacin", "haloperidol", "quetiapine", "methadone",
                  "ondansetron"}
_PPIS = {"omeprazole", "esomeprazole", "pantoprazole", "lansoprazole",
         "rabeprazole"}


# ── Rules ──────────────────────────────────────────────────────────────
@dataclass
class Rule:
    drugs_a: Set[str]
    drugs_b: Optional[Set[str]]  # None → single-drug rule (Beers, anticholinergic)
    level: str
    category: str
    message: str
    citation: str


RULES: List[Rule] = [
    # ── Beers Criteria: avoid in elderly ──
    Rule({"diphenhydramine", "doxylamine", "chlorpheniramine"}, None,
         "avoid", "beers_avoid",
         "First-generation antihistamines have strong anticholinergic effects. "
         "High risk of confusion, dry mouth, constipation, urinary retention, "
         "and falls in elderly patients.",
         "AGS Beers 2023"),
    Rule(_BENZODIAZEPINES, None,
         "avoid", "beers_avoid",
         "Benzodiazepines in elderly: risk of cognitive impairment, falls, "
         "fractures, and motor vehicle accidents. Withdrawal must be gradual.",
         "AGS Beers 2023"),
    Rule(_Z_DRUGS, None,
         "avoid", "beers_avoid",
         "Z-drugs (zolpidem, etc.) have adverse effects similar to "
         "benzodiazepines in elderly. Risk of falls, delirium, and motor "
         "vehicle accidents. Avoid chronic use.",
         "AGS Beers 2023"),
    Rule({"glyburide", "chlorpropamide"}, None,
         "avoid", "beers_avoid",
         "Long-acting sulfonylureas carry high risk of severe prolonged "
         "hypoglycemia in elderly. Prefer glipizide or other short-acting "
         "alternatives.",
         "AGS Beers 2023"),
    Rule({"cyclobenzaprine", "orphenadrine", "methocarbamol", "carisoprodol"}, None,
         "avoid", "beers_avoid",
         "Muscle relaxants are poorly tolerated in elderly due to "
         "anticholinergic effects, sedation, and fall risk.",
         "AGS Beers 2023"),
    Rule({"amitriptyline", "imipramine", "doxepin"}, None,
         "avoid", "beers_avoid",
         "Tertiary-amine tricyclics have highly anticholinergic and "
         "sedative effects. Avoid in elderly; prefer nortriptyline if a "
         "tricyclic is needed.",
         "AGS Beers 2023"),
    Rule({"digoxin"}, None,
         "monitor", "beers_avoid",
         "Digoxin: doses >0.125 mg/day are associated with toxicity in "
         "elderly with reduced renal function. Monitor renal function and "
         "levels closely.",
         "AGS Beers 2023"),

    # ── Major pairwise interactions ──
    Rule({"warfarin"}, _NSAIDS,
         "major", "interaction",
         "Warfarin + NSAID: greatly increased risk of major GI bleeding. "
         "Avoid combination. If analgesia needed, use acetaminophen.",
         "AGS Beers 2023 / FDA"),
    Rule({"warfarin"}, {"aspirin"},
         "major", "interaction",
         "Warfarin + aspirin: increased bleeding risk. Only combine when "
         "specifically indicated (e.g. mechanical valve) with close INR "
         "monitoring.",
         "AHA/ACC guidance"),
    Rule(_ACE_INHIBITORS | _ARB, _K_SPARING_DIURETICS,
         "major", "interaction",
         "ACE inhibitor or ARB + potassium-sparing diuretic: high risk of "
         "hyperkalemia, particularly in elderly or renal impairment. Monitor "
         "potassium and renal function.",
         "STOPP v3"),
    Rule(_ACE_INHIBITORS | _ARB, _NSAIDS,
         "major", "interaction",
         "ACE inhibitor or ARB + NSAID: risk of acute kidney injury, "
         "especially in elderly or volume-depleted patients. Avoid if "
         "possible.",
         "STOPP v3"),
    Rule(_SSRI | _SEROTONERGIC_NON_SSRI, _MAOI,
         "avoid", "interaction",
         "SSRI / SNRI / tramadol + MAOI: serotonin syndrome risk. Absolutely "
         "avoid. Requires 14-day washout between agents.",
         "FDA black box"),
    Rule(_SSRI, _SEROTONERGIC_NON_SSRI,
         "moderate", "interaction",
         "SSRI + other serotonergic drug (tramadol, venlafaxine, trazodone, "
         "linezolid): monitor for serotonin syndrome — agitation, tremor, "
         "hyperthermia, clonus.",
         "FDA labeling"),
    Rule({"digoxin"}, {"amiodarone"},
         "major", "interaction",
         "Digoxin + amiodarone: amiodarone increases digoxin levels ~2x. "
         "Reduce digoxin dose by 50% and monitor levels.",
         "ACC/AHA"),
    Rule({"digoxin"}, {"verapamil"},
         "major", "interaction",
         "Digoxin + verapamil: verapamil raises digoxin levels. Reduce "
         "digoxin dose and monitor.",
         "ACC/AHA"),
    Rule(_BETA_BLOCKERS, _NON_DHP_CCB,
         "major", "interaction",
         "Beta-blocker + non-dihydropyridine CCB (verapamil/diltiazem): "
         "risk of bradycardia, AV block, and heart failure. Generally avoid "
         "combination.",
         "ACC/AHA"),
    Rule(_OPIOIDS, _BENZODIAZEPINES,
         "avoid", "interaction",
         "Opioid + benzodiazepine: FDA black-box warning for profound "
         "sedation and fatal respiratory depression. Combination should be "
         "avoided in elderly.",
         "FDA black box"),
    Rule({"metformin"}, {"contrast", "iv contrast", "iodinated contrast"},
         "major", "interaction",
         "Metformin + iodinated IV contrast: risk of lactic acidosis if renal "
         "function worsens. Hold metformin on day of contrast and for 48h "
         "post-procedure if eGFR <30.",
         "ACR guidelines"),
    Rule({"clopidogrel"}, {"omeprazole", "esomeprazole"},
         "moderate", "interaction",
         "Clopidogrel + omeprazole/esomeprazole: reduced clopidogrel "
         "activation (CYP2C19 inhibition) may reduce antiplatelet effect. "
         "Prefer pantoprazole.",
         "FDA labeling"),
    Rule({"aspirin"}, _NSAIDS,
         "moderate", "interaction",
         "Aspirin + NSAID: NSAIDs can blunt aspirin's cardioprotective "
         "antiplatelet effect. Separate doses by at least 2 hours (aspirin "
         "first).",
         "FDA / AHA"),
    Rule(_QT_PROLONGING, _QT_PROLONGING,
         "major", "qt_prolong",
         "Two or more QT-prolonging drugs together raise risk of torsades "
         "de pointes. Obtain ECG and monitor QTc before continuing.",
         "CredibleMeds"),
]


# ── Normalization helpers ──────────────────────────────────────────────
_DOSE_STRIP_RE = re.compile(
    r"\s*\d+(\.\d+)?\s*(mg|mcg|g|ml|unit|units|iu|tab|tabs|tablet|tablets|cap|caps|capsule|capsules)\b.*$",
    re.IGNORECASE,
)

_PAREN_STRIP_RE = re.compile(r"\s*\([^)]*\)")


def normalize_drug_name(raw: str) -> str:
    """
    Turn a user-supplied drug string into a canonical generic name.
    Examples:
      "Lisinopril 10mg daily" -> "lisinopril"
      "Coumadin (warfarin)"   -> "warfarin"
      "Bayer Aspirin 81mg"    -> "aspirin"
      "Lisinopril™"           -> "lisinopril"
    """
    if not raw:
        return ""
    s = raw.strip().lower()
    s = _PAREN_STRIP_RE.sub("", s)
    s = _DOSE_STRIP_RE.sub("", s)
    # Strip trademark / registered-mark symbols and other non-letter trailing chars.
    # Keep only ASCII letters + hyphen for the drug-name token.
    s = re.sub(r"[^a-z\s,/\-]", "", s)
    # take the first alphabetic token
    parts = re.split(r"[\s,/-]+", s.strip())
    candidate = parts[0] if parts else s.strip()
    # brand -> generic
    return _BRAND_TO_GENERIC.get(candidate, candidate)


def normalize_medications(meds: List[str]) -> List[str]:
    return [normalize_drug_name(m) for m in meds if m and m.strip()]


# ── Core checker ───────────────────────────────────────────────────────
def check_medications(
    medications: List[str],
    age: Optional[float] = None,
) -> List[DrugWarning]:
    """
    Return a list of drug warnings for the given medication list.
    Duplicate-free. Highest-severity warnings first.

    If `age` is provided, Beers Criteria warnings (category `beers_avoid`)
    are ONLY emitted when age >= 65. Beers is specifically validated for
    older adults; applying it to younger patients produces false positives.
    All other rules (pairwise interactions, QT prolongation, opioid+benzo,
    anticholinergic burden) apply at any age.

    If `age` is None (unknown), we conservatively include Beers warnings
    so that elderly wearers without an age recorded still get them.
    """
    if not medications:
        return []

    meds = set(normalize_medications(medications))
    apply_beers = (age is None) or (age >= 65)

    warnings: List[DrugWarning] = []
    seen: Set[Tuple[str, frozenset]] = set()

    def _add(level, category, drugs, message, citation):
        key = (category + "|" + message[:40], frozenset(drugs))
        if key in seen:
            return
        seen.add(key)
        warnings.append(DrugWarning(
            level=level, category=category,
            drugs=sorted(drugs), message=message, citation=citation,
        ))

    for rule in RULES:
        # Skip Beers-specific rules if patient is known to be under 65.
        if rule.category == "beers_avoid" and not apply_beers:
            continue

        a_present = meds & rule.drugs_a
        if not a_present:
            continue
        if rule.drugs_b is None:
            _add(rule.level, rule.category, list(a_present),
                 rule.message, rule.citation)
        else:
            b_present = meds & rule.drugs_b
            if rule.drugs_a is rule.drugs_b or rule.drugs_a == rule.drugs_b:
                if len(a_present) >= 2:
                    _add(rule.level, rule.category, list(a_present),
                         rule.message, rule.citation)
            else:
                if a_present and b_present:
                    _add(rule.level, rule.category,
                         list(a_present) + list(b_present),
                         rule.message, rule.citation)

    # Anticholinergic burden — still concerning at any age, but the
    # dementia-risk framing is specific to older adults.
    antichol_present = meds & _ANTICHOLINERGICS_HIGH
    if len(antichol_present) >= 2:
        if apply_beers:
            msg = (f"High cumulative anticholinergic burden ({len(antichol_present)} "
                   "anticholinergic drugs detected). Associated with confusion, "
                   "constipation, urinary retention, dry mouth, blurred vision, "
                   "and increased risk of cognitive decline / dementia in older adults.")
        else:
            msg = (f"High cumulative anticholinergic burden ({len(antichol_present)} "
                   "anticholinergic drugs detected). Associated with confusion, "
                   "constipation, urinary retention, dry mouth, and blurred vision.")
        _add("major", "anticholinergic_burden", list(antichol_present), msg,
             "ACB Calculator / Beers 2023")

    order = {"avoid": 0, "major": 1, "moderate": 2, "monitor": 3}
    warnings.sort(key=lambda w: order.get(w.level, 99))
    return warnings


def format_warnings_for_prompt(warnings: List[DrugWarning]) -> str:
    """Render warnings as text for injection into the LLM system prompt."""
    if not warnings:
        return ""
    lines = ["Drug-safety warnings for this patient's medication list:"]
    for w in warnings:
        drugs = ", ".join(w.drugs)
        lines.append(f"- [{w.level.upper()}] {drugs}: {w.message} ({w.citation})")
    lines.append(
        "When relevant to the user's question, mention these warnings. Do not "
        "recommend changing prescriptions — direct the user to the prescriber."
    )
    return "\n".join(lines)
