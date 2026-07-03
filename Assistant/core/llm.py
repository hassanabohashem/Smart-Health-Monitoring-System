"""
LLM wrapper — Groq API call + Llama Guard moderation + hardened prompts.

Features:
- Input moderation (keyword pre-filter + Llama Guard on Groq)
- Output moderation (post-call Llama Guard check)
- Response cache (LRU, keyed on normalized request)
- Retry with exponential backoff on transient errors
- Streaming variant for SSE
- Token-aware chat-history trim
- Structured logging throughout
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Dict, Generator, List, Optional

from groq import Groq

from .config import (
    GROQ_API_KEY, LLM_MODEL, LLM_FALLBACKS, MODERATION_MODEL,
    MODERATION_DISABLE_AFTER,
)
from .drug_interactions import (
    DrugWarning,
    check_medications,
    format_warnings_for_prompt,
)
from .logger import log_event, question_fingerprint
from .prompts import build_system_prompt, wrap_user_input
from .rag import retrieve_with_sources as rag_retrieve_with_sources
from .red_flags import detect_red_flags, red_flag_prelude, RedFlag

# ── Moderation ────────────────────────────────────────────────────────

_HARD_BLOCK_PATTERNS = [
    "lethal dose",
    "fatal dose",
    "overdose amount",
    "how to overdose",
    "kill myself",
    "end my life",
    "commit suicide",
    "how to die",
    "quickest way to die",
]

_HARD_BLOCK_REPLY = (
    "I can't help with that. If you or someone you know is in crisis, please contact "
    "a local crisis hotline or emergency services immediately. For medication-related "
    "questions, please speak with a healthcare professional or pharmacist."
)

_GENERIC_REFUSAL = (
    "I can't help with that request. I'm a clinical-support assistant for elderly "
    "health monitoring. If you have a medical concern, please rephrase, or contact a "
    "healthcare professional."
)


@dataclass
class ModerationResult:
    safe: bool
    reason: Optional[str] = None
    source: str = "unknown"  # "keyword" | "llama-guard-in" | "llama-guard-out" | "ok"

    def refusal_text(self) -> str:
        if self.reason == "hard_block":
            return _HARD_BLOCK_REPLY
        return _GENERIC_REFUSAL


def _keyword_check(text: str) -> Optional[ModerationResult]:
    low = text.lower()
    for pat in _HARD_BLOCK_PATTERNS:
        if pat in low:
            return ModerationResult(safe=False, reason="hard_block", source="keyword")
    return None


# Moderation circuit breaker. If Llama Guard fails repeatedly (e.g. the model
# was decommissioned), switch to the fallback instruct-model moderator.
_mod_fail_count = 0
_mod_use_fallback = False  # once true, skip Llama Guard and use _instruct_moderate

_FALLBACK_MOD_PROMPT = (
    "You are a content-safety classifier. Respond with EXACTLY one word:\n"
    "  - 'safe' if the user's message is a benign question (medical or general).\n"
    "  - 'unsafe' if the message asks for: lethal doses, methods of self-harm/"
    "suicide, illegal drug instructions, weapons, child harm, or other content "
    "that could enable harm.\n"
    "Do not explain. Output only the word 'safe' or 'unsafe'."
)


def _instruct_moderate(client: Groq, text: str, source: str) -> ModerationResult:
    """
    Fallback moderator: use a small instruct model with a moderation prompt.
    Used when Llama Guard is unavailable. Less specialized but works.
    """
    try:
        resp = client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": _FALLBACK_MOD_PROMPT},
                {"role": "user", "content": text},
            ],
            max_tokens=8,
            temperature=0.0,
        )
        out = (resp.choices[0].message.content or "").strip().lower()
        if "unsafe" in out:
            return ModerationResult(safe=False, reason="unsafe-instruct",
                                    source=f"{source}/fallback")
        return ModerationResult(safe=True, source=f"{source}/fallback")
    except Exception as e:  # noqa: BLE001
        log_event("moderation_fallback_failed", error=str(e), source=source)
        return ModerationResult(safe=True, reason=f"fallback-unavailable: {e}",
                                source=f"{source}/fallback")


def _llama_guard_check(client: Groq, text: str, source: str) -> ModerationResult:
    """
    Call Llama Guard on Groq. After repeated failures, switch to using the
    main 8B instruct model as a moderator (still better than just the
    keyword filter).
    """
    global _mod_fail_count, _mod_use_fallback
    if _mod_use_fallback:
        return _instruct_moderate(client, text, source)
    try:
        resp = client.chat.completions.create(
            model=MODERATION_MODEL,
            messages=[{"role": "user", "content": text}],
            max_tokens=40,
            temperature=0.0,
        )
        _mod_fail_count = 0  # reset on success
        out = (resp.choices[0].message.content or "").strip().lower()
        if out.startswith("unsafe"):
            reason = out.split("\n", 1)[1].strip() if "\n" in out else "unsafe"
            return ModerationResult(safe=False, reason=reason, source=source)
        return ModerationResult(safe=True, source=source)
    except Exception as e:  # noqa: BLE001
        _mod_fail_count += 1
        log_event("moderation_unavailable", error=str(e), source=source,
                  fail_count=_mod_fail_count)
        if _mod_fail_count >= MODERATION_DISABLE_AFTER:
            _mod_use_fallback = True
            log_event("moderation_switched_to_fallback",
                      reason=f"{_mod_fail_count} consecutive guard failures",
                      decommissioned_model=MODERATION_MODEL)
            # Try the fallback right away on this call
            return _instruct_moderate(client, text, source)
        return ModerationResult(safe=True, reason=f"guard-unavailable: {e}", source=source)


def moderate_input(text: str, client: Optional[Groq] = None) -> ModerationResult:
    kw = _keyword_check(text)
    if kw is not None:
        return kw
    client = client or Groq(api_key=GROQ_API_KEY)
    return _llama_guard_check(client, text, source="llama-guard-in")


def moderate_output(text: str, client: Optional[Groq] = None) -> ModerationResult:
    """
    Check the assistant's output before returning it to the user.
    Catches cases where the model slipped past input moderation.
    """
    client = client or Groq(api_key=GROQ_API_KEY)
    return _llama_guard_check(client, text, source="llama-guard-out")


# ── Response cache (in-memory LRU) ────────────────────────────────────

_CACHE_MAX = 256
_cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_cache_lock = threading.Lock()


def _cache_key(
    question: str,
    vitals_summary: Optional[str],
    severity: Optional[str],
    patient: Optional[dict],
    activity: Optional[str],
    user_role: Optional[str],
    recent_events: Optional[List[dict]] = None,
) -> str:
    """
    Build a deterministic cache key from all context that affects the response.

    All context that goes into the prompt MUST be included here, otherwise
    the cache could return a stale response that ignores new context (e.g.
    a fresh fall event).
    """
    norm = " ".join(question.lower().split())
    payload = json.dumps(
        {
            "q": norm,
            "v": vitals_summary,
            "s": severity,
            "p": patient or {},
            "a": activity,
            "r": user_role,
            "e": recent_events or [],
        },
        sort_keys=True,
        default=str,
    )
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    with _cache_lock:
        val = _cache.get(key)
        if val is not None:
            _cache.move_to_end(key)
            return dict(val)  # shallow copy
        return None


def _cache_put(key: str, value: Dict[str, Any]) -> None:
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_MAX:
            _cache.popitem(last=False)


# ── History trim (token-aware, rough) ─────────────────────────────────

_APPROX_CHARS_PER_TOKEN = 4
_MAX_HISTORY_TOKENS = 2000  # leaves plenty of room in Llama's 8k/128k window


def _trim_history(history: Optional[List[dict]]) -> List[dict]:
    if not history:
        return []
    trimmed: List[dict] = []
    budget = _MAX_HISTORY_TOKENS * _APPROX_CHARS_PER_TOKEN
    for msg in reversed(history):
        content = msg.get("content", "") or ""
        c = len(content)
        if c > budget and trimmed:
            break
        trimmed.append(msg)
        budget -= c
        if budget <= 0:
            break
    return list(reversed(trimmed))


# ── Retry with exponential backoff + model fallback ──────────────────

def _retry(callable_, attempts=3, base=0.8, label="llm"):
    last_exc = None
    for i in range(attempts):
        try:
            return callable_()
        except Exception as e:  # noqa: BLE001
            last_exc = e
            delay = base * (2 ** i)
            log_event("retry", label=label, attempt=i + 1, error=str(e), delay=delay)
            time.sleep(delay)
    raise last_exc


def _call_with_model_fallback(client: Groq, messages, max_tokens, temperature):
    """
    Try the primary LLM model, then fall back through LLM_FALLBACKS on
    persistent failure (e.g. TPD limit reached on Llama 3.3).
    Returns (response, used_model).
    """
    tried = []
    models = [LLM_MODEL] + list(LLM_FALLBACKS)
    last_exc = None
    for model in models:
        tried.append(model)

        def _call(m=model):
            return client.chat.completions.create(
                model=m,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )

        try:
            resp = _retry(_call, attempts=2, base=0.8, label=f"llm({model})")
            if model != LLM_MODEL:
                log_event("llm_fallback_used", model=model, tried=tried)
            return resp, model
        except Exception as e:  # noqa: BLE001
            last_exc = e
            # 429 = rate limit → try next model
            # 400 = model decommissioned → try next model
            # For other errors we still fall through so a best-effort is made.
            log_event("llm_model_failed", model=model, error=str(e)[:300])
            continue
    raise last_exc


def _stream_with_model_fallback(client: Groq, messages, max_tokens, temperature):
    """
    Stream variant. Returns (stream_iterator, used_model). Raises if all
    models in the fallback chain fail.
    """
    tried = []
    models = [LLM_MODEL] + list(LLM_FALLBACKS)
    last_exc = None
    for model in models:
        tried.append(model)
        try:
            stream = client.chat.completions.create(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=True,
            )
            if model != LLM_MODEL:
                log_event("llm_fallback_used", stream=True, model=model, tried=tried)
            return stream, model
        except Exception as e:  # noqa: BLE001
            last_exc = e
            log_event("llm_model_failed", stream=True, model=model, error=str(e)[:300])
            continue
    raise last_exc


# ── Emergency detection ───────────────────────────────────────────────

_EMERGENCY_SEVERITIES = {"CRITICAL"}


# ── Follow-up parsing ────────────────────────────────────────────────
# We instruct the LLM to append a <follow_ups>…</follow_ups> block at the
# end of its answer. This regex strips it out so the user sees a clean
# answer, and we expose the parsed list separately.
_FOLLOWUP_RE = re.compile(
    r"\s*<follow_ups\s*>(.*?)</follow_ups\s*>\s*$",
    re.IGNORECASE | re.DOTALL,
)
_FOLLOWUP_LINE_RE = re.compile(r"^\s*[-*•]\s*(.+?)\s*$", re.MULTILINE)


def _parse_follow_ups(answer: str) -> "tuple[str, List[str]]":
    """
    Extract the follow-up block at the end of the answer (if present),
    return (cleaned_answer, [follow-up strings]).
    """
    if not answer:
        return answer, []
    m = _FOLLOWUP_RE.search(answer)
    if not m:
        return answer, []
    block = m.group(1)
    follow_ups = []
    for line_m in _FOLLOWUP_LINE_RE.finditer(block):
        q = line_m.group(1).strip()
        if q and len(q) <= 200:
            follow_ups.append(q)
    cleaned = answer[: m.start()].rstrip()
    return cleaned, follow_ups[:3]  # cap at 3


# ── Structured-section parser ────────────────────────────────────────
# The LLM is instructed to use Overview / Key points / Recommendations
# headings. We extract these into a structured object that the mobile app
# can render with collapsible sections, without losing the markdown answer.
_SECTION_HEADING_RE = re.compile(
    r"^##+\s*(?P<title>[^\n]+?)\s*$\n+(?P<body>.*?)(?=^##+\s|\Z)",
    re.IGNORECASE | re.MULTILINE | re.DOTALL,
)
_BULLET_RE = re.compile(r"^\s*[-*•]\s*(?P<item>.+?)\s*$", re.MULTILINE)


def _section_kind(title: str) -> Optional[str]:
    """Map heading title to a canonical section key, or None if unknown."""
    t = title.strip().lower().rstrip(":")
    # Strip leading numbering like "5.3"
    t = re.sub(r"^\d+(\.\d+)*\.?\s*", "", t)
    if t in ("overview", "summary", "background"):
        return "overview"
    if "key" in t and "point" in t:
        return "key_points"
    if t in ("recommendations", "actions", "next steps", "what to do"):
        return "recommendations"
    if t in ("when to seek emergency care", "emergency"):
        return "emergency"
    return None


def _parse_sections(answer: str) -> Dict[str, Any]:
    """
    Parse markdown headings in the answer into a structured dict.

    Returns: {"overview": str, "key_points": [str], "recommendations": [str]}
    Empty/missing keys are omitted. The full markdown `answer` is still
    available alongside this — clients pick whichever rendering they prefer.
    """
    if not answer:
        return {}
    out: Dict[str, Any] = {}
    for m in _SECTION_HEADING_RE.finditer(answer):
        kind = _section_kind(m.group("title"))
        if not kind:
            continue
        body = m.group("body").strip()
        if not body:
            continue
        if kind in ("key_points", "recommendations"):
            items = [b.group("item").strip() for b in _BULLET_RE.finditer(body)]
            items = [i for i in items if i]
            if items:
                out[kind] = items
            else:
                # Fallback: split paragraphs
                out[kind] = [p.strip() for p in body.split("\n\n") if p.strip()]
        else:
            out[kind] = body
    return out


def _derive_emergency(
    severity: Optional[str],
    answer: str,  # kept for API compatibility; not used for derivation
    red_flags: Optional[List[RedFlag]] = None,
) -> Dict[str, Any]:
    """
    Machine-readable emergency flag for the mobile app.

    DETERMINISTIC. Trips ONLY if:
      - Rules severity == CRITICAL (vitals path), OR
      - A red-flag phrase was detected in the user's question.

    We intentionally do NOT derive emergency from the LLM's output, because
    the LLM often mentions emergency services in educational contexts
    (e.g. "here are the signs that warrant 911"), which would produce false
    positives. The mobile app needs predictable behavior.
    """
    _ = answer  # unused
    sev_critical = severity in _EMERGENCY_SEVERITIES
    has_red_flag = bool(red_flags)

    emergency = sev_critical or has_red_flag
    reason = None
    action = "none"

    # Red flag takes priority — it's the clearest "act now" signal.
    if has_red_flag:
        reason = f"red_flag:{red_flags[0].category}"
        action = "call_911"
    elif sev_critical:
        reason = f"rules_severity={severity}"
        action = "call_911"

    result = {
        "emergency": emergency,
        "emergency_reason": reason,
        "recommended_action": action,
    }
    if red_flags:
        result["red_flags"] = [
            {"category": f.category, "label": f.label,
             "severity": f.severity, "matched_text": f.matched_text}
            for f in red_flags
        ]
    else:
        result["red_flags"] = []
    return result


# ── Public API: non-streaming ─────────────────────────────────────────

def ask_llm(
    question: str,
    chat_history: Optional[List[dict]] = None,
    vitals_summary: Optional[str] = None,
    severity: Optional[str] = None,
    rule_alerts: Optional[list] = None,
    retrieval_context: str = "",
    patient: Optional[dict] = None,
    activity: Optional[str] = None,
    recent_events: Optional[List[dict]] = None,
    user_role: Optional[str] = None,
    vitals_trend: Optional[str] = None,
    max_tokens: int = 1024,
    temperature: float = 0.2,
    skip_moderation: bool = False,
    skip_cache: bool = False,
) -> Dict[str, Any]:
    """
    Ask the LLM a question and return a structured response.

    Returns:
        {
          "answer": str,
          "refused": bool,
          "moderation": {...} | None,
          "model": str,
          "from_cache": bool,
          "emergency": bool,
          "emergency_reason": str | None,
          "recommended_action": "call_911" | "contact_caregiver" | "monitor" | "none",
          "latency_ms": int,
        }
    """
    t0 = time.time()
    fp = question_fingerprint(question)

    # 0a. Drug-interaction / Beers check (cheap, pure-regex lookup).
    # Beers Criteria gated to age >= 65 when age is known.
    drug_warnings: List[DrugWarning] = []
    patient_age = (patient or {}).get("age") if patient else None
    meds = (patient or {}).get("medications") if patient else None
    if meds:
        drug_warnings = check_medications(meds, age=patient_age)
        if drug_warnings:
            log_event(
                "drug_warnings",
                fp=fp,
                count=len(drug_warnings),
                levels=[w.level for w in drug_warnings],
                categories=[w.category for w in drug_warnings],
            )
    drug_warnings_text = format_warnings_for_prompt(drug_warnings)
    drug_warnings_dicts = [
        {"level": w.level, "category": w.category, "drugs": w.drugs,
         "message": w.message, "citation": w.citation}
        for w in drug_warnings
    ]

    # 0b. Red-flag scan (cheap, regex-only). Runs before everything else so the
    # emergency flag is set even on cache hits or moderation refusals.
    red_flags = detect_red_flags(question)
    if red_flags:
        log_event(
            "red_flag_detected",
            fp=fp,
            categories=[f.category for f in red_flags],
            labels=[f.label for f in red_flags],
        )

    log_event(
        "chat_request",
        fp=fp,
        has_vitals=bool(vitals_summary),
        severity=severity,
        user_role=user_role,
        activity=activity,
        events=len(recent_events or []),
        red_flags=len(red_flags),
    )

    # 1. Cache check FIRST — cached entries were already moderated on first insert.
    # This keeps cached calls truly fast (~ms, not seconds).
    # Skip cache when there's a substantive chat history, because the correct
    # answer depends on the preceding turns and we don't hash history into the
    # cache key (would defeat cache hit rates in real usage).
    has_history = bool(chat_history) and len(chat_history) > 0
    effective_skip_cache = skip_cache or has_history

    cache_key = _cache_key(question, vitals_summary, severity, patient, activity, user_role, recent_events)
    if not effective_skip_cache:
        cached = _cache_get(cache_key)
        if cached is not None:
            log_event("cache_hit", fp=fp, key=cache_key[:12])
            cached = dict(cached)
            cached["from_cache"] = True
            cached["latency_ms"] = int((time.time() - t0) * 1000)
            # Re-derive emergency info in case red_flags detection changes it
            # (it shouldn't for identical questions, but belt-and-braces).
            emergency_info = _derive_emergency(severity, cached.get("answer", ""), red_flags)
            cached.update(emergency_info)
            # Ensure new optional fields exist on cached entries from prior code versions
            cached.setdefault("sources", [])
            cached.setdefault("follow_ups", [])
            cached.setdefault("structured", {})
            cached.setdefault("usage", {})
            return cached

    client = Groq(api_key=GROQ_API_KEY)

    # 2. Input moderation (only on cache miss)
    mod: Optional[ModerationResult] = None
    if not skip_moderation:
        mod = moderate_input(question, client=client)
        if not mod.safe:
            log_event("moderation_block", fp=fp, reason=mod.reason, source=mod.source, direction="input")
            emergency_info = _derive_emergency(severity, "", red_flags)
            return {
                "answer": mod.refusal_text(),
                "refused": True,
                "moderation": {"safe": False, "reason": mod.reason, "source": mod.source},
                "model": MODERATION_MODEL,
                "from_cache": False,
                "latency_ms": int((time.time() - t0) * 1000),
                "drug_warnings": drug_warnings_dicts,
                "sources": [],
                "follow_ups": [],
                "structured": {},
                "usage": {},
                **emergency_info,
            }

    # 3. RAG retrieval (only if caller didn't pre-supply context)
    rag_ctx = retrieval_context or ""
    rag_sources: List[Dict[str, Any]] = []
    if not rag_ctx:
        try:
            rag_ctx, rag_sources = rag_retrieve_with_sources(question, k=3, max_chars=1800)
            if rag_ctx:
                log_event("rag_hit", fp=fp, chars=len(rag_ctx),
                          n_sources=len(rag_sources))
        except Exception as e:  # noqa: BLE001
            log_event("rag_failed", fp=fp, error=str(e))
            rag_ctx = ""

    # 4. Build system prompt and messages
    system_prompt = build_system_prompt(
        vitals_summary=vitals_summary,
        severity=severity,
        rule_alerts=rule_alerts,
        retrieval_context=rag_ctx,
        patient=patient,
        activity=activity,
        recent_events=recent_events,
        user_role=user_role,
        drug_warnings_text=drug_warnings_text,
        vitals_trend=vitals_trend,
    )
    # Ask the LLM to also generate 2-3 follow-up questions in a tagged block
    # at the end of its answer. We parse and strip them server-side.
    system_prompt += (
        "\n\n## Follow-up suggestions\n"
        "After your main answer, on a new line, include EXACTLY this block:\n"
        "<follow_ups>\n"
        "- short question 1?\n"
        "- short question 2?\n"
        "- short question 3?\n"
        "</follow_ups>\n"
        "Each line MUST be phrased AS THE USER would ask it — first person, "
        "addressed to you. Good: \"Can I take it with my BP meds?\", "
        "\"What if I miss a dose?\", \"Is 38°C a fever for a child?\". "
        "BAD (do not generate these — they read like you interviewing the "
        "user): \"What meds are you taking?\", \"Any side effects?\", "
        "\"How are you feeling?\". "
        "Keep each one under 70 characters, end with a question mark, and "
        "use the same language the user wrote in."
    )
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(_trim_history(chat_history))
    messages.append({"role": "user", "content": wrap_user_input(question)})

    # 5. LLM call with retry + model fallback chain
    try:
        resp, used_model = _call_with_model_fallback(
            client, messages, max_tokens, temperature
        )
    except Exception as e:  # noqa: BLE001
        log_event("llm_failed", fp=fp, error=str(e))
        fallback = ("I'm having trouble reaching the AI right now. Based on the current readings, "
                    f"the rules-engine severity is **{severity or 'UNKNOWN'}**. "
                    "Please try again in a moment, or contact a healthcare professional if urgent.")
        emergency_info = _derive_emergency(severity, fallback, red_flags)
        return {
            "answer": red_flag_prelude(red_flags) + fallback,
            "refused": False,
            "moderation": None,
            "model": LLM_MODEL,
            "from_cache": False,
            "latency_ms": int((time.time() - t0) * 1000),
            "drug_warnings": drug_warnings_dicts,
            "sources": rag_sources,
            "follow_ups": [],
            "structured": {},
            "usage": {},
            **emergency_info,
        }

    raw_answer = (resp.choices[0].message.content or "").strip()
    # Strip the follow-up block from the visible answer
    answer, follow_ups = _parse_follow_ups(raw_answer)
    # Parse markdown headings into structured sections (non-destructive)
    structured = _parse_sections(answer)

    # Capture token usage for telemetry / thesis cost analysis
    usage_info: Dict[str, Any] = {}
    try:
        u = getattr(resp, "usage", None)
        if u is not None:
            usage_info = {
                "prompt_tokens": getattr(u, "prompt_tokens", None),
                "completion_tokens": getattr(u, "completion_tokens", None),
                "total_tokens": getattr(u, "total_tokens", None),
            }
    except Exception:  # noqa: BLE001
        pass

    # 5. Output moderation
    out_mod: Optional[ModerationResult] = None
    if not skip_moderation:
        out_mod = moderate_output(answer, client=client)
        if not out_mod.safe:
            log_event("moderation_block", fp=fp, reason=out_mod.reason,
                      source=out_mod.source, direction="output")
            emergency_info = _derive_emergency(severity, "", red_flags)
            return {
                "answer": _GENERIC_REFUSAL,
                "refused": True,
                "moderation": {"safe": False, "reason": out_mod.reason, "source": out_mod.source},
                "model": LLM_MODEL,
                "from_cache": False,
                "latency_ms": int((time.time() - t0) * 1000),
                "drug_warnings": drug_warnings_dicts,
                "sources": rag_sources,
                "follow_ups": [],
                "structured": {},
                "usage": usage_info,
                **emergency_info,
            }

    # 6. Prepend red-flag prelude (if any) so emergency advice is the FIRST
    # thing the user sees.
    answer = red_flag_prelude(red_flags) + answer

    emergency_info = _derive_emergency(severity, answer, red_flags)
    result = {
        "answer": answer,
        "refused": False,
        "moderation": {
            "safe": True,
            "reason": (out_mod.reason if out_mod else None),
            "source": (out_mod.source if out_mod else "ok"),
        },
        "model": used_model,
        "from_cache": False,
        "latency_ms": int((time.time() - t0) * 1000),
        "drug_warnings": drug_warnings_dicts,
        "sources": rag_sources,
        "follow_ups": follow_ups,
        "structured": structured,
        "usage": usage_info,
        **emergency_info,
    }
    log_event("chat_response", fp=fp,
              latency_ms=result["latency_ms"],
              total_tokens=usage_info.get("total_tokens"),
              n_sources=len(rag_sources),
              n_followups=len(follow_ups),
              emergency=result.get("emergency"))

    # 6. Cache the result
    if not effective_skip_cache:
        _cache_put(cache_key, dict(result))

    return result


# ── Public API: streaming ─────────────────────────────────────────────

def ask_llm_stream(
    question: str,
    chat_history: Optional[List[dict]] = None,
    vitals_summary: Optional[str] = None,
    severity: Optional[str] = None,
    rule_alerts: Optional[list] = None,
    retrieval_context: str = "",
    patient: Optional[dict] = None,
    activity: Optional[str] = None,
    recent_events: Optional[List[dict]] = None,
    user_role: Optional[str] = None,
    vitals_trend: Optional[str] = None,
    max_tokens: int = 1024,
    temperature: float = 0.2,
    skip_moderation: bool = False,
) -> Generator[Dict[str, Any], None, None]:
    """
    Stream the LLM response token-by-token as dicts.

    Yields:
      {"type": "start"}
      {"type": "chunk", "text": "..."}
      ...
      {"type": "final", "full_answer": "...", "emergency": bool, ...}

    The caller serializes these to SSE.

    NOTE: streaming does NOT cache (would need to buffer) and does NOT run
    output moderation (would require buffering the full answer before
    yielding). If safety is critical for a query, use ask_llm() instead.
    """
    t0 = time.time()
    fp = question_fingerprint(question)

    # Drug interactions / Beers (age-gated in check_medications)
    drug_warnings: List[DrugWarning] = []
    patient_age = (patient or {}).get("age") if patient else None
    meds = (patient or {}).get("medications") if patient else None
    if meds:
        drug_warnings = check_medications(meds, age=patient_age)
        if drug_warnings:
            log_event(
                "drug_warnings", fp=fp, stream=True,
                count=len(drug_warnings),
                levels=[w.level for w in drug_warnings],
            )
    drug_warnings_text = format_warnings_for_prompt(drug_warnings)
    drug_warnings_dicts = [
        {"level": w.level, "category": w.category, "drugs": w.drugs,
         "message": w.message, "citation": w.citation}
        for w in drug_warnings
    ]

    # Red-flag scan first — so the emergency hint is the first thing streamed.
    red_flags = detect_red_flags(question)
    if red_flags:
        log_event(
            "red_flag_detected",
            fp=fp, stream=True,
            categories=[f.category for f in red_flags],
        )

    log_event("chat_stream_request", fp=fp, has_vitals=bool(vitals_summary),
              severity=severity, red_flags=len(red_flags),
              drug_warnings=len(drug_warnings))

    client = Groq(api_key=GROQ_API_KEY)

    # Input moderation (blocking; before any token is sent)
    if not skip_moderation:
        mod = moderate_input(question, client=client)
        if not mod.safe:
            log_event("moderation_block", fp=fp, reason=mod.reason,
                      source=mod.source, direction="input_stream")
            yield {"type": "start"}
            refusal = mod.refusal_text()
            yield {"type": "chunk", "text": refusal}
            emergency_info = _derive_emergency(severity, "", red_flags)
            yield {
                "type": "final",
                "full_answer": refusal,
                "refused": True,
                "model": MODERATION_MODEL,
                "from_cache": False,
                "latency_ms": int((time.time() - t0) * 1000),
                "drug_warnings": drug_warnings_dicts,
                "sources": [],
                "follow_ups": [],
                "structured": {},
                "usage": {},
                **emergency_info,
            }
            return

    # RAG retrieval (same rule as non-streaming)
    rag_ctx = retrieval_context or ""
    rag_sources_stream: List[Dict[str, Any]] = []
    if not rag_ctx:
        try:
            rag_ctx, rag_sources_stream = rag_retrieve_with_sources(
                question, k=3, max_chars=1800
            )
            if rag_ctx:
                log_event("rag_hit", fp=fp, stream=True, chars=len(rag_ctx),
                          n_sources=len(rag_sources_stream))
        except Exception as e:  # noqa: BLE001
            log_event("rag_failed", fp=fp, stream=True, error=str(e))
            rag_ctx = ""

    # Build prompt (same follow-up instruction as non-streaming)
    system_prompt = build_system_prompt(
        vitals_summary=vitals_summary,
        severity=severity,
        rule_alerts=rule_alerts,
        retrieval_context=rag_ctx,
        patient=patient,
        activity=activity,
        recent_events=recent_events,
        user_role=user_role,
        drug_warnings_text=drug_warnings_text,
        vitals_trend=vitals_trend,
    )
    system_prompt += (
        "\n\n## Follow-up suggestions\n"
        "After your main answer, on a new line, include EXACTLY this block:\n"
        "<follow_ups>\n"
        "- short question 1?\n"
        "- short question 2?\n"
        "- short question 3?\n"
        "</follow_ups>\n"
        "Each line MUST be phrased AS THE USER would ask it — first person, "
        "addressed to you. Good: \"Can I take it with my BP meds?\", "
        "\"What if I miss a dose?\", \"Is 38°C a fever for a child?\". "
        "BAD (do not generate these — they read like you interviewing the "
        "user): \"What meds are you taking?\", \"Any side effects?\", "
        "\"How are you feeling?\". "
        "Keep each one under 70 characters, end with a question mark, and "
        "use the same language the user wrote in."
    )
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(_trim_history(chat_history))
    messages.append({"role": "user", "content": wrap_user_input(question)})

    yield {"type": "start"}

    full_parts: List[str] = []

    # Emit red-flag prelude as the first chunk so mobile UI shows it instantly.
    if red_flags:
        prelude = red_flag_prelude(red_flags)
        full_parts.append(prelude)
        yield {"type": "chunk", "text": prelude}

    used_model = LLM_MODEL
    try:
        stream, used_model = _stream_with_model_fallback(
            client, messages, max_tokens, temperature
        )
        for event in stream:
            delta = getattr(event.choices[0].delta, "content", None) or ""
            if delta:
                full_parts.append(delta)
                yield {"type": "chunk", "text": delta}
    except Exception as e:  # noqa: BLE001
        log_event("stream_failed", fp=fp, error=str(e))
        err_msg = "\n\n[stream interrupted — please try again]"
        full_parts.append(err_msg)
        yield {"type": "chunk", "text": err_msg}

    full = "".join(full_parts).strip()
    emergency_info = _derive_emergency(severity, full, red_flags)
    log_event(
        "chat_stream_response",
        fp=fp,
        latency_ms=int((time.time() - t0) * 1000),
        emergency=emergency_info["emergency"],
        answer_len=len(full),
    )
    # Strip the follow-up block from the streamed buffer for the final
    # canonical answer. (Stream consumers already saw the raw block as
    # tokens flowed; the final event sends the cleaned full answer.)
    cleaned_full, follow_ups = _parse_follow_ups(full)
    yield {
        "type": "final",
        "full_answer": cleaned_full,
        "refused": False,
        "model": used_model,
        "from_cache": False,
        "latency_ms": int((time.time() - t0) * 1000),
        "drug_warnings": drug_warnings_dicts,
        "sources": rag_sources_stream,
        "follow_ups": follow_ups,
        "structured": _parse_sections(cleaned_full),
        "usage": {},
        **emergency_info,
    }
