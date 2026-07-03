"""
Smart Health AI — shared core.
Used by both the Streamlit dashboard (assistant.py) and the FastAPI backend (api.py).
"""
from .rules import analyze_vitals, build_vitals_summary, Severity
from .llm import ask_llm, ask_llm_stream, moderate_input, moderate_output, ModerationResult
from .config import GROQ_API_KEY, LLM_MODEL, MODERATION_MODEL
from .logger import log_event, question_fingerprint

__all__ = [
    "analyze_vitals",
    "build_vitals_summary",
    "Severity",
    "ask_llm",
    "ask_llm_stream",
    "moderate_input",
    "moderate_output",
    "ModerationResult",
    "GROQ_API_KEY",
    "LLM_MODEL",
    "MODERATION_MODEL",
    "log_event",
    "question_fingerprint",
]
