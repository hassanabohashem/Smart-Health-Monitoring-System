"""
Red-flag symptom detection.

Runs BEFORE the LLM call. If a phrase strongly suggests a life-threatening
condition, we immediately:
  - Flip emergency=True and recommended_action=call_911
  - Log the event
  - (The LLM is still called for the full response, but the mobile app can
    react to the emergency flag the moment the response lands.)

Categories drawn from the CDC STEADI, AHA stroke guidance, and WHO ICOPE
red-flag lists, prioritizing conditions where minutes matter.

Designed to be high-precision (few false positives) rather than high-recall.
A normal chat assistant should err on the side of NOT raising a red flag
unless the phrasing is unambiguous.

Supports English + Arabic.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import List


@dataclass
class RedFlag:
    category: str      # e.g. "chest_pain"
    label: str         # human-readable label, e.g. "possible heart attack"
    severity: str      # "critical" | "high"
    matched_text: str  # the snippet that triggered it
    advice: str        # one-line immediate advice shown before LLM response


# ── Pattern bank ──────────────────────────────────────────────────────────
# Each entry: (regex pattern, category, label, severity, advice)
#
# Rules for writing patterns:
# - Prefer phrases, not single words. "pain" alone is useless.
# - Use word boundaries to avoid "not chest pain" issues — we also include
#   negation checks below.
# - English is lowercased before matching. Arabic matches on the raw text.
# - Keep patterns tight. A false positive here locks up the UI with "CALL 911".

_CALL_911_ADVICE = (
    "**Call emergency services (911) now.** While waiting, keep the person "
    "calm and still, loosen any tight clothing, and do not give food or water "
    "unless directed by a dispatcher."
)

_STROKE_ADVICE = (
    "**Call 911 now.** Note the exact time symptoms started — this is critical "
    "for stroke treatment. Do NOT give aspirin or food. Keep the person lying "
    "on their side."
)

_CARDIAC_ADVICE = (
    "**Call 911 now.** Have the person sit down, stay calm, and chew one "
    "aspirin if they are not allergic. Unlock the front door for paramedics."
)

_BREATHING_ADVICE = (
    "**Call 911 now.** Help the person into an upright seated position. "
    "Loosen tight clothing. If they use a rescue inhaler, help them use it."
)

_BLEEDING_ADVICE = (
    "**Call 911 now.** Apply firm pressure to the wound with a clean cloth. "
    "Do not remove the cloth if it soaks through — add another on top."
)

_FALL_WITH_SYMPTOMS_ADVICE = (
    "**Call 911 now.** Do not move the person unless they are in danger. "
    "Keep them still, warm, and monitor their breathing."
)

_UNRESPONSIVE_ADVICE = (
    "**Call 911 now.** Check if they are breathing. If not breathing and "
    "you are trained, begin CPR immediately. Otherwise, follow dispatcher "
    "instructions."
)

# ── Pediatric-specific advice strings ────────────────────────────────────
_INFANT_FEVER_ADVICE = (
    "**Any fever (≥38°C / 100.4°F) in an infant under 3 months is a "
    "medical emergency. Call 911 or go to the ER now.** Do not give fever "
    "medication without medical guidance for infants this age."
)

_MENINGITIS_ADVICE = (
    "**Call 911 now.** A non-blanching rash with fever, neck stiffness, or "
    "extreme drowsiness can indicate meningococcal disease. Press a clear "
    "glass against the rash — if it does NOT fade, this is a medical "
    "emergency. Do not wait."
)

_FEBRILE_SEIZURE_ADVICE = (
    "**Call 911 now.** Place the child on their side on a flat surface. "
    "Do not put anything in their mouth. Time the seizure. Keep them safe "
    "from nearby objects. Most febrile seizures stop within minutes, but "
    "any first seizure or one lasting >5 minutes needs emergency evaluation."
)

_CROUP_ADVICE = (
    "**Call 911 now if breathing is severely difficult.** A barking cough "
    "with stridor (high-pitched noise on inhale) and labored breathing in "
    "a child can indicate severe croup or epiglottitis. Keep the child "
    "calm and upright. Cool, humid air can help while waiting for help."
)

_INFANT_DEHYDRATION_ADVICE = (
    "**This is urgent — call your pediatrician or go to the ER.** A "
    "sunken fontanelle (soft spot), no wet diapers for 6+ hours, no "
    "tears when crying, or unusual sleepiness in a baby indicate severe "
    "dehydration. Infants can deteriorate quickly."
)


# Reusable fragments
# Matches "can't", "can’t" (curly), "cant", "cannot", "can not"
_CANT = r"(?:can(?:['\u2019\s]*t|not)|can\s+not)"
# Possessive/article before a noun, optional
_POSS = r"(?:\s+(?:his|her|my|their|our|the))?"


# English patterns (case-insensitive)
_EN_PATTERNS = [
    # Cardiac / chest pain
    (r"\b(crushing|severe|squeezing|radiating)\s+chest\s+(pain|pressure|tightness)\b",
     "chest_pain", "possible heart attack", "critical", _CARDIAC_ADVICE),
    (r"\bchest\s+(pain|pressure)\s+(with|and)\s+(arm|jaw|neck|back|shoulder)\b",
     "chest_pain", "possible heart attack (radiating)", "critical", _CARDIAC_ADVICE),
    (r"\b(heart\s*attack|myocardial\s+infarction)\b",
     "chest_pain", "heart attack", "critical", _CARDIAC_ADVICE),
    (r"\b(elephant\s+on\s+my\s+chest|crushing\s+pressure)\b",
     "chest_pain", "possible heart attack", "critical", _CARDIAC_ADVICE),

    # Stroke (FAST)
    (r"\b(sudden|acute)\s+(weakness|numbness|paralysis)\s+(on|in)" + _POSS + r"\s+(one\s+side|left|right)\b",
     "stroke", "possible stroke (one-sided weakness)", "critical", _STROKE_ADVICE),
    (r"\b(face\s+(?:is\s+)?drooping|face\s+(?:is\s+)?droop(?:ed|s)|"
     r"(one\s+side\s+of\s+)?(his|her|my|the|mom[''`]?s|dad[''`]?s|grandma[''`]?s|grandpa[''`]?s)\s+face\s+(?:is\s+)?droop)",
     "stroke", "possible stroke (facial droop)", "critical", _STROKE_ADVICE),
    (r"\b(slurred|garbled|slurring)\s+speech\b",
     "stroke", "possible stroke (speech)", "critical", _STROKE_ADVICE),
    (r"\bspeech\s+is\s+(slurred|garbled)\b",
     "stroke", "possible stroke (speech)", "critical", _STROKE_ADVICE),
    (r"\b(sudden|worst)\s+(severe\s+)?(headache|thunderclap)\b",
     "stroke", "possible stroke (thunderclap headache)", "critical", _STROKE_ADVICE),
    (r"\b" + _CANT + r"\s+(move|lift)\s+(his|her|my|their)\s+(arm|leg|hand)\b",
     "stroke", "possible stroke (limb weakness)", "critical", _STROKE_ADVICE),

    # Breathing
    (r"\b" + _CANT + r"\s+breathe\b",
     "breathing", "severe breathing difficulty", "critical", _BREATHING_ADVICE),
    (r"\b(struggling|gasping)\s+(to|for)\s+(breathe|breath|air)\b",
     "breathing", "severe breathing difficulty", "critical", _BREATHING_ADVICE),
    (r"\b(turning|lips\s+are)\s+blue\b",
     "breathing", "cyanosis", "critical", _BREATHING_ADVICE),
    (r"\b(choking|suffocating)\b",
     "breathing", "airway obstruction", "critical", _BREATHING_ADVICE),

    # Unresponsiveness / consciousness
    (r"\b(unconscious|unresponsive|won['\u2019\s]*t\s+wake\s+up|"
     + _CANT + r"\s+wake\s+(him|her|them)\s+up)\b",
     "unresponsive", "unresponsive patient", "critical", _UNRESPONSIVE_ADVICE),
    (r"\b(passed\s+out|fainted)\s+(and|then)\s+"
     r"(not|hasn['\u2019\s]*t|wouldn['\u2019\s]*t)\s+(woken|responding)\b",
     "unresponsive", "unresponsive after fainting", "critical", _UNRESPONSIVE_ADVICE),
    (r"\bnot\s+(breathing|responsive)\b",
     "unresponsive", "not breathing / not responsive", "critical", _UNRESPONSIVE_ADVICE),

    # Severe bleeding
    (r"\b(uncontrolled|heavy|severe|won['\u2019\s]*t\s+stop)\s+(bleeding|blood\s+loss)\b",
     "bleeding", "severe bleeding", "critical", _BLEEDING_ADVICE),
    (r"\b(bleeding|blood\s+loss)\s+(that\s+)?won['\u2019\s]*t\s+stop\b",
     "bleeding", "severe bleeding", "critical", _BLEEDING_ADVICE),
    (r"\bvomit(ing)?\s+blood\b",
     "bleeding", "vomiting blood", "critical", _CALL_911_ADVICE),
    (r"\bcough(ing)?\s+up\s+blood\b",
     "bleeding", "coughing blood", "critical", _CALL_911_ADVICE),

    # Fall with serious symptoms (allow intermediate words between fell and can't)
    (r"\b(fell|fallen)\b.{0,60}?\b" + _CANT + r"\s+(get\s+up|move|stand)\b",
     "fall", "fall with immobility", "critical", _FALL_WITH_SYMPTOMS_ADVICE),
    (r"\b(fell|fallen).{0,40}(hit|banged|knocked).{0,10}head\b",
     "fall", "fall with head trauma", "critical", _FALL_WITH_SYMPTOMS_ADVICE),

    # Suicide / self-harm
    (r"\b(want\s+to\s+die|kill\s+myself|end\s+(my|it)\s+all)\b",
     "self_harm", "self-harm risk", "critical",
     "**If you're in crisis, please call a local crisis line now, or dial 911.** "
     "You are not alone. Help is available."),

    # Severe allergic reaction
    (r"\b(anaphylaxis|anaphylactic)\b",
     "allergy", "anaphylaxis", "critical", _CALL_911_ADVICE),
    (r"\b(throat|tongue|face)\s+(swelling|swollen)\b.{0,40}(hard|" + _CANT + r")\s+(breathe|swallow)\b",
     "allergy", "possible anaphylaxis", "critical", _CALL_911_ADVICE),

    # Severe confusion / altered mental state (sudden)
    (r"\b(sudden(ly)?|acutely)\s+confused\b",
     "confusion", "sudden confusion", "high", _CALL_911_ADVICE),
    (r"\bdoesn['\u2019\s]*t\s+(know|recognize)\s+(where|who|what)\b",
     "confusion", "sudden disorientation", "high", _CALL_911_ADVICE),

    # \u2500\u2500 PEDIATRIC RED FLAGS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    # Newborn / infant fever (any temp \u226538\u00b0C in <3mo is an emergency)
    (r"\b(newborn|baby|infant|my\s+(\d+(\s*month|\s*week)|3\s*month|2\s*month|1\s*month))\b.{0,80}?\b(fever|feverish|temp(erature)?\s+of|high\s+temp)\b",
     "infant_fever", "fever in young infant", "critical", _INFANT_FEVER_ADVICE),
    (r"\b(my\s+)?baby[s']*\s+(temp(erature)?|fever)\b",
     "infant_fever", "fever in infant", "critical", _INFANT_FEVER_ADVICE),

    # Meningitis / meningococcal disease
    (r"\b(non[\s-]?blanching|petechial|purpuric)\s+rash\b",
     "meningitis", "possible meningococcal rash", "critical", _MENINGITIS_ADVICE),
    (r"\b(stiff\s+neck|neck\s+(is\s+)?stiff)\b.{0,50}?\b(fever|hot|temp|cold|headache)\b",
     "meningitis", "possible meningitis", "critical", _MENINGITIS_ADVICE),
    (r"\bmeningitis\b",
     "meningitis", "meningitis suspected", "critical", _MENINGITIS_ADVICE),
    (r"\brash\s+(that\s+)?(doesn['\u2019]t|won['\u2019]t|does\s+not)\s+(fade|disappear|blanch)\b",
     "meningitis", "non-blanching rash", "critical", _MENINGITIS_ADVICE),

    # Febrile seizure (or any pediatric seizure)
    (r"\b(my\s+)?(child|baby|toddler|son|daughter)\b.{0,30}?\b(seizur|convuls|fitting)\w*\b",
     "seizure", "child seizure", "critical", _FEBRILE_SEIZURE_ADVICE),
    (r"\bfebrile\s+seizure\b",
     "seizure", "febrile seizure", "critical", _FEBRILE_SEIZURE_ADVICE),

    # Croup / severe pediatric breathing distress
    (r"\b(barking|seal[\s-]?like)\s+cough\b",
     "croup", "possible croup", "high", _CROUP_ADVICE),
    (r"\bstridor\b",
     "croup", "stridor \u2014 upper-airway obstruction", "critical", _CROUP_ADVICE),
    (r"\b(child|baby|toddler)\b.{0,40}?\b(can['\u2019]t|cannot|struggling\s+to)\s+breathe\b",
     "breathing", "child breathing distress", "critical", _CROUP_ADVICE),

    # Severe infant dehydration
    (r"\bsunken\s+fontanelle\b",
     "infant_dehydration", "infant dehydration (sunken fontanelle)", "critical",
     _INFANT_DEHYDRATION_ADVICE),
    (r"\b(no\s+(wet\s+diapers|tears))\b.{0,40}?\b(\d+\s*hours?|all\s+day|whole\s+day|today)\b",
     "infant_dehydration", "infant dehydration", "high",
     _INFANT_DEHYDRATION_ADVICE),
    (r"\b(my\s+)?baby\s+(is|seems|looks)\s+(very\s+)?(lethargic|listless|floppy|won['\u2019]t\s+wake|unresponsive)\b",
     "unresponsive", "infant unresponsiveness", "critical", _UNRESPONSIVE_ADVICE),
]

# Arabic patterns. Flexible whitespace and allow masculine/feminine endings.
_AR_PATTERNS = [
    # Chest pain / heart attack
    (r"(ألم|وجع)\s*(شديد\s*)?(في\s+)?(الصدر|صدر[يه])",
     "chest_pain", "ألم صدر شديد", "critical", _CARDIAC_ADVICE),
    (r"(أزمة|نوبة)\s*قلبية",
     "chest_pain", "احتمال نوبة قلبية", "critical", _CARDIAC_ADVICE),

    # Stroke
    (r"(سكتة|جلطة)\s*دماغية",
     "stroke", "احتمال سكتة دماغية", "critical", _STROKE_ADVICE),
    (r"(شلل|ضعف)\s*(نصفي|في\s+جانب)",
     "stroke", "ضعف نصفي", "critical", _STROKE_ADVICE),

    # Breathing — include feminine (قادرة) and variants of "breathe"
    (r"(لا\s*يستطيع|لا\s*أستطيع|مش\s*قادر[ةه]?)\s*(التنفس|أتنفس|يتنفس|تتنفس|ينفس)",
     "breathing", "صعوبة شديدة في التنفس", "critical", _BREATHING_ADVICE),
    (r"ضيق\s*(تنفس|نفس)\s*شديد",
     "breathing", "ضيق تنفس شديد", "critical", _BREATHING_ADVICE),

    # Unresponsive — flexible spacing + feminine
    (r"فاقد[ةه]?\s*(الوعي|للوعي)",
     "unresponsive", "فقدان الوعي", "critical", _UNRESPONSIVE_ADVICE),
    (r"(لا\s*يستجيب|مش\s*بير[دف]|لا\s*ير[دف])",
     "unresponsive", "عدم استجابة", "critical", _UNRESPONSIVE_ADVICE),

    # Bleeding
    (r"نزيف\s*(شديد|حاد|غزير)",
     "bleeding", "نزيف شديد", "critical", _BLEEDING_ADVICE),

    # ── PEDIATRIC ARABIC RED FLAGS ─────────────────────────────────
    # Infant fever
    (r"(رضيع|طفل\s*صغير|بيبي).{0,50}?(حرارة|سخونة|حمى)",
     "infant_fever", "حمى عند رضيع", "critical", _INFANT_FEVER_ADVICE),
    # Meningitis / non-blanching rash
    (r"(تصلب|تيبس)\s*(الرقبة|رقبته)",
     "meningitis", "احتمال التهاب سحايا", "critical", _MENINGITIS_ADVICE),
    (r"التهاب\s*(ال)?سحايا",
     "meningitis", "التهاب السحايا", "critical", _MENINGITIS_ADVICE),
    # Pediatric seizure (either direction: child first or seizure first)
    (r"(طفل|رضيع|ابن|ابنت|بنت).{0,40}?(تشنج|نوبة\s*صرع|اختلاج)",
     "seizure", "تشنج عند طفل", "critical", _FEBRILE_SEIZURE_ADVICE),
    (r"(تشنج|نوبة\s*صرع|اختلاج).{0,40}?(طفل|رضيع|ابن|ابنت|بنت)",
     "seizure", "تشنج عند طفل", "critical", _FEBRILE_SEIZURE_ADVICE),
    # Croup / stridor
    (r"سعال\s*(نباحي|كأنه\s*كلب)",
     "croup", "احتمال خناق", "high", _CROUP_ADVICE),
    # Sunken fontanelle / infant dehydration
    (r"(نافوخ|يافوخ)\s*(غائر|منغمس)",
     "infant_dehydration", "جفاف عند رضيع", "critical",
     _INFANT_DEHYDRATION_ADVICE),
]


# Phrases that, if present, usually mean the user is describing a past event
# or asking a hypothetical — we should NOT trigger a red flag.
#
# IMPORTANT: Each entry is matched as a WHOLE-WORD phrase (surrounded by
# whitespace, punctuation, or string boundary). Short tokens like "لو"
# ("if" in Arabic) would otherwise match as a substring inside longer words
# such as "الوعي" ("consciousness") and produce false negation.
_NEGATION_CONTEXTS = [
    # English
    "last year", "last month", "years ago", "when i was", "used to",
    "what if", "what happens when", "what should i do if", "in case",
    "hypothetically", "just curious", "for reference", "for education",
    # Arabic (multi-word phrases only — single short particles are unsafe)
    "في الماضي", "ماذا لو", "لو كان", "لو حدث",
]


def _is_negated(text: str, matched_start: int, matched_end: int) -> bool:
    """
    Check if the matched text appears in a hypothetical/past context.
    We look at a ±60-char window around the match, and require the
    negation phrase to appear as a whole word (not as a substring).
    """
    window_start = max(0, matched_start - 60)
    window_end = min(len(text), matched_end + 60)
    window = text[window_start:window_end].lower()
    import re as _re
    for neg in _NEGATION_CONTEXTS:
        # Whole-word-ish match: must be flanked by non-letter chars or boundary
        pat = r"(?:^|[^\w\u0600-\u06FF])" + _re.escape(neg) + r"(?:$|[^\w\u0600-\u06FF])"
        if _re.search(pat, window):
            return True
    return False


def detect_red_flags(question: str) -> List[RedFlag]:
    """
    Scan a user question for red-flag phrases.

    Returns a list of RedFlag objects (possibly empty). Usually at most 1-2,
    because we stop after the first match per category.
    """
    if not question:
        return []

    out: List[RedFlag] = []
    seen_categories: set = set()

    en_text = question.lower()
    # English patterns
    for pattern, cat, label, sev, advice in _EN_PATTERNS:
        if cat in seen_categories:
            continue
        m = re.search(pattern, en_text, re.IGNORECASE)
        if m and not _is_negated(en_text, m.start(), m.end()):
            out.append(RedFlag(
                category=cat, label=label, severity=sev,
                matched_text=m.group(0), advice=advice,
            ))
            seen_categories.add(cat)

    # Arabic patterns (on raw text)
    for pattern, cat, label, sev, advice in _AR_PATTERNS:
        if cat in seen_categories:
            continue
        m = re.search(pattern, question)
        if m and not _is_negated(question, m.start(), m.end()):
            out.append(RedFlag(
                category=cat, label=label, severity=sev,
                matched_text=m.group(0), advice=advice,
            ))
            seen_categories.add(cat)

    return out


def red_flag_prelude(flags: List[RedFlag]) -> str:
    """
    Build a short emergency preamble to prepend to the assistant's response
    when one or more red flags fire.
    """
    if not flags:
        return ""
    main = flags[0]  # show advice for the first (highest-priority) flag
    parts = [
        "---",
        f"🚨 **URGENT: {main.label.upper()}**",
        "",
        main.advice,
    ]
    if len(flags) > 1:
        other_labels = ", ".join(f.label for f in flags[1:])
        parts.append("")
        parts.append(f"_Also detected: {other_labels}._")
    parts.append("---")
    parts.append("")
    return "\n".join(parts)
