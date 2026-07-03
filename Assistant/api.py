"""
Smart Health AI — FastAPI backend.

Endpoints:
  GET  /health            — liveness check
  POST /analyze-vitals    — rules-based severity (no LLM call)
  POST /chat              — full LLM assistant (structured response)
  POST /chat/stream       — SSE stream of the LLM response
  GET  /cache-stats       — diagnostic

Designed to be called from the React Native mobile app.

Run locally:
  venv/Scripts/python.exe -m uvicorn api:app --reload --host 0.0.0.0 --port 8000
"""
import json
from typing import List, Literal, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from core import analyze_vitals, build_vitals_summary, ask_llm, ask_llm_stream
from core.config import (
    PRODUCT_NAME, PRODUCT_TAGLINE, LLM_MODEL, MODERATION_MODEL,
    API_KEY, AUTH_REQUIRED,
)
from core.llm import _cache  # for diagnostic endpoint
from core.rag import index_stats as rag_index_stats, retrieve as rag_retrieve

API_VERSION = "0.3.0"

app = FastAPI(
    title=f"{PRODUCT_NAME} API",
    description=PRODUCT_TAGLINE,
    version=API_VERSION,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*", "X-API-Key"],
)


# ── Auth dependency ─────────────────────────────────────────────────────
def require_api_key(x_api_key: str = Header(default=None, alias="X-API-Key")):
    """
    Dependency that enforces the shared API key when SMARTHEALTH_AUTH_REQUIRED
    is enabled. `/health`, `/openapi.json`, and `/docs` do NOT use this.
    """
    if not AUTH_REQUIRED:
        return
    if not API_KEY:
        # Misconfigured server — auth required but no key set.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server auth is required but SMARTHEALTH_API_KEY is not set",
        )
    if x_api_key != API_KEY:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid X-API-Key header",
        )


# ── Schemas ─────────────────────────────────────────────────────────────
class Vitals(BaseModel):
    hr: Optional[float] = Field(None, description="Heart rate, bpm")
    spo2: Optional[float] = Field(None, description="Blood oxygen saturation, %")
    rr: Optional[float] = Field(None, description="Respiratory rate, br/min (optional)")
    temp: Optional[float] = Field(None, description="Temperature, °C")


class Patient(BaseModel):
    # `age` is float to support infants <1 year (e.g. 0.1 = ~5 weeks).
    # Adults send integer years; the rules engine handles both.
    age: Optional[float] = Field(default=None, ge=0, le=130)
    sex: Optional[Literal["M", "F"]] = None
    conditions: Optional[List[str]] = None  # e.g. ["COPD", "Hypertension"]
    medications: Optional[List[str]] = None  # e.g. ["Lisinopril", "Albuterol"]


class HealthEvent(BaseModel):
    type: Literal["fall", "tachycardia", "hypoxia", "geofence_exit", "sos", "other"]
    when: str = Field(..., description="Human-readable time, e.g. '3 min ago' or ISO timestamp")
    detail: Optional[str] = None


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class ChatRequest(BaseModel):
    question: str
    chat_history: Optional[List[ChatMessage]] = None
    vitals: Optional[Vitals] = None
    patient: Optional[Patient] = None
    activity: Optional[Literal[
        "sitting", "walking", "running", "climbing_stairs",
        "going_downstairs", "sleeping", "standing", "lying",
    ]] = None
    recent_events: Optional[List[HealthEvent]] = None
    user_role: Optional[Literal["wearer", "caregiver"]] = None
    # Short human-readable trend summary, e.g. "HR climbing 70→95 over 2h".
    # Computed client-side from the vitals history; passed to the LLM as
    # context so it can reason about direction, not just point-in-time values.
    vitals_trend: Optional[str] = Field(
        default=None, max_length=300,
        description="Optional short trend summary, e.g. 'HR rose 70->95 over 2h'",
    )
    # NOTE: `retrieval_context` is intentionally NOT exposed to clients —
    # it would be a prompt-injection vector. The server retrieves RAG context
    # automatically via the local FAISS index. Sophisticated internal callers
    # can bypass the HTTP layer and call core.ask_llm() directly.


class AnalyzeVitalsResponse(BaseModel):
    severity: str
    summary: Optional[str]
    alerts: List[dict]


class RedFlagOut(BaseModel):
    category: str
    label: str
    severity: str
    matched_text: str


class DrugWarningOut(BaseModel):
    level: str           # "avoid" | "major" | "moderate" | "monitor"
    category: str        # "beers_avoid" | "interaction" | "anticholinergic_burden" | "qt_prolong"
    drugs: List[str]
    message: str
    citation: str


class SourceOut(BaseModel):
    """One retrieved corpus chunk supporting the answer."""
    source: str          # e.g. "02_beers_criteria_summary.md"
    chunk: int           # chunk index within the source
    snippet: str         # ~140-char preview for tooltips


class UsageOut(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class StructuredOut(BaseModel):
    """Optional parsed sections of the answer for structured rendering.
    Empty if the LLM didn't produce recognizable headings."""
    overview: Optional[str] = None
    key_points: List[str] = []
    recommendations: List[str] = []
    emergency: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    refused: bool
    model: str
    severity: Optional[str] = None
    vitals_summary: Optional[str] = None
    emergency: bool = False
    emergency_reason: Optional[str] = None
    recommended_action: Literal["call_911", "contact_caregiver", "monitor", "none"] = "none"
    red_flags: List[RedFlagOut] = []
    drug_warnings: List[DrugWarningOut] = []
    sources: List[SourceOut] = []
    follow_ups: List[str] = []
    structured: StructuredOut = StructuredOut()
    usage: UsageOut = UsageOut()
    from_cache: bool = False
    latency_ms: Optional[int] = None


# ── Helpers ─────────────────────────────────────────────────────────────
def _run_rules(v: Optional[Vitals], age: Optional[int] = None):
    if v is None:
        return None, None, None
    alerts_tuples, severity = analyze_vitals(v.hr, v.spo2, v.rr, v.temp, age=age)
    summary = build_vitals_summary(v.hr, v.spo2, v.rr, v.temp)
    return alerts_tuples, severity, summary


def _history_to_dicts(h):
    return [{"role": m.role, "content": m.content} for m in h] if h else None


def _patient_to_dict(p):
    return p.model_dump(exclude_none=True) if p else None


def _events_to_dicts(events):
    return [e.model_dump(exclude_none=True) for e in events] if events else None


# ── Endpoints ───────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "product": PRODUCT_NAME,
        "llm": LLM_MODEL,
        "moderation": MODERATION_MODEL,
        "version": API_VERSION,
        "auth_required": AUTH_REQUIRED,
    }


@app.get("/cache-stats", dependencies=[Depends(require_api_key)])
def cache_stats():
    """Diagnostic — requires auth in production."""
    return {"size": len(_cache), "max": 256}


@app.get("/rag/stats", dependencies=[Depends(require_api_key)])
def rag_stats():
    """Diagnostic — requires auth in production."""
    return rag_index_stats()


@app.get("/rag/preview", dependencies=[Depends(require_api_key)])
def rag_preview(q: str, k: int = 3):
    """Diagnostic: see what chunks RAG retrieves for a query. Requires auth."""
    # Cap k to prevent abuse — a malicious caller could request large k values
    # to sweep the corpus.
    k = max(1, min(k, 10))
    return {"query": q, "chunks": rag_retrieve(q, k=k, max_chars=3000)}


@app.post("/analyze-vitals", response_model=AnalyzeVitalsResponse,
          dependencies=[Depends(require_api_key)])
def post_analyze_vitals(v: Vitals):
    alerts_tuples, severity = analyze_vitals(v.hr, v.spo2, v.rr, v.temp)
    alerts = [
        {"level": lvl, "param": param, "value": val, "message": msg}
        for lvl, param, val, msg in alerts_tuples
    ]
    summary = build_vitals_summary(v.hr, v.spo2, v.rr, v.temp)
    return AnalyzeVitalsResponse(severity=severity, summary=summary, alerts=alerts)


@app.post("/chat", response_model=ChatResponse,
          dependencies=[Depends(require_api_key)])
def post_chat(req: ChatRequest):
    if not req.question or not req.question.strip():
        raise HTTPException(status_code=400, detail="question is required")

    alerts_tuples, severity, vitals_summary = _run_rules(
        req.vitals, age=(req.patient.age if req.patient else None)
    )

    try:
        result = ask_llm(
            question=req.question,
            chat_history=_history_to_dicts(req.chat_history),
            vitals_summary=vitals_summary,
            severity=severity,
            rule_alerts=alerts_tuples,
            retrieval_context="",  # server-side RAG retrieval only
            patient=_patient_to_dict(req.patient),
            activity=req.activity,
            recent_events=_events_to_dicts(req.recent_events),
            user_role=req.user_role,
            vitals_trend=req.vitals_trend,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"LLM call failed: {e}")

    return ChatResponse(
        answer=result["answer"],
        refused=result["refused"],
        model=result["model"],
        severity=severity,
        vitals_summary=vitals_summary,
        emergency=result.get("emergency", False),
        emergency_reason=result.get("emergency_reason"),
        recommended_action=result.get("recommended_action", "none"),
        red_flags=result.get("red_flags", []),
        drug_warnings=result.get("drug_warnings", []),
        sources=result.get("sources", []),
        follow_ups=result.get("follow_ups", []),
        structured=StructuredOut(**(result.get("structured") or {})),
        usage=UsageOut(**(result.get("usage") or {})),
        from_cache=result.get("from_cache", False),
        latency_ms=result.get("latency_ms"),
    )


@app.post("/chat/stream", dependencies=[Depends(require_api_key)])
def post_chat_stream(req: ChatRequest):
    """
    Server-Sent Events stream of the LLM response.

    Protocol:
      event: start       -> (open the stream)
      event: chunk       -> data: {"text": "partial"}
      event: final       -> data: {"full_answer", "emergency", "severity", ...}

    Mobile app consumes this via EventSource or a polyfill.
    """
    if not req.question or not req.question.strip():
        raise HTTPException(status_code=400, detail="question is required")

    alerts_tuples, severity, vitals_summary = _run_rules(
        req.vitals, age=(req.patient.age if req.patient else None)
    )

    def event_stream():
        try:
            for item in ask_llm_stream(
                question=req.question,
                chat_history=_history_to_dicts(req.chat_history),
                vitals_summary=vitals_summary,
                severity=severity,
                rule_alerts=alerts_tuples,
                retrieval_context="",  # server-side RAG retrieval only
                patient=_patient_to_dict(req.patient),
                activity=req.activity,
                recent_events=_events_to_dicts(req.recent_events),
                user_role=req.user_role,
                vitals_trend=req.vitals_trend,
            ):
                event_name = item.pop("type")
                # Attach severity/vitals_summary to the final event
                if event_name == "final":
                    item["severity"] = severity
                    item["vitals_summary"] = vitals_summary
                payload = json.dumps(item, ensure_ascii=False)
                yield f"event: {event_name}\ndata: {payload}\n\n"
        except Exception as e:
            payload = json.dumps({"error": str(e)})
            yield f"event: error\ndata: {payload}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # disable nginx buffering
            "Connection": "keep-alive",
        },
    )
