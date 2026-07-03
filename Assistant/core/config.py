"""Configuration — read from environment, with safe defaults for dev."""
import os
import sys

# Load .env if present (local development only; production uses real env vars)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv not installed — skip silently

# ── Groq ─────────────────────────────────────────────────────────────────
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
if not GROQ_API_KEY:
    # Don't crash on import (lets tests run without a key), but warn loudly.
    print(
        "⚠️  WARNING: GROQ_API_KEY is not set. The assistant will fail on any "
        "LLM call. Set it in .env or your environment.",
        file=sys.stderr,
    )

# Primary LLM for medical Q&A
LLM_MODEL = os.environ.get("SMARTHEALTH_LLM_MODEL", "llama-3.3-70b-versatile")

# Fallback chain for when the primary is rate-limited / unavailable.
# Comma-separated. In order of preference after primary.
LLM_FALLBACKS = [
    m.strip() for m in os.environ.get(
        "SMARTHEALTH_LLM_FALLBACKS",
        "llama-3.1-8b-instant,gemma2-9b-it,mixtral-8x7b-32768",
    ).split(",") if m.strip()
]

# Moderation model — Llama Guard family. The 8B variant is still active
# on Groq at the time of writing; the 4-12B variant was decommissioned.
MODERATION_MODEL = os.environ.get(
    "SMARTHEALTH_MOD_MODEL",
    "meta-llama/llama-guard-4-12b",
)

# If moderation fails N times in a row, stop calling it for this process
# (rely on the keyword filter). Prevents burning tokens on a dead model.
MODERATION_DISABLE_AFTER = int(os.environ.get("SMARTHEALTH_MOD_DISABLE_AFTER", "3"))

# Product branding
PRODUCT_NAME = "Smart Health AI"
PRODUCT_TAGLINE = "Clinical Decision Support for Elderly Care"

# ── Auth ────────────────────────────────────────────────────────────────
# If SMARTHEALTH_AUTH_REQUIRED is true, every /chat-ish endpoint requires
# an X-API-Key header matching SMARTHEALTH_API_KEY. /health is always open.
API_KEY = os.environ.get("SMARTHEALTH_API_KEY", "")
AUTH_REQUIRED = os.environ.get("SMARTHEALTH_AUTH_REQUIRED", "false").lower() == "true"
