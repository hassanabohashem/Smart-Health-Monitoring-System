"""
Structured JSON logging to file + stdout.

One line per event. Fields:
  ts          ISO timestamp
  event       short name (chat_request, chat_response, moderation_block, error, cache_hit, ...)
  ...         event-specific payload

Designed to be cheap (no I/O blocking the request) and reviewable
(you can grep, pipe through jq, or load into pandas).

Questions themselves are NOT logged in cleartext — only their SHA-1 prefix.
This lets you find duplicates / traffic patterns without leaking PHI.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOG_DIR = Path(os.environ.get("SMARTHEALTH_LOG_DIR", "logs"))
LOG_FILE = LOG_DIR / "assistant.jsonl"

_lock = threading.Lock()


def _ensure_dir() -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def question_fingerprint(question: str) -> str:
    h = hashlib.sha1(question.encode("utf-8", errors="ignore")).hexdigest()
    return h[:10]


def log_event(event: str, **payload: Any) -> None:
    """Write one JSONL event. Never raises."""
    record = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event,
        **payload,
    }
    try:
        line = json.dumps(record, ensure_ascii=False, default=str)
    except Exception:
        line = json.dumps({"ts": record["ts"], "event": "log_serialization_error"})

    try:
        _ensure_dir()
        with _lock:
            with LOG_FILE.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
    except Exception:
        # Never fail the request because logging failed.
        pass

    # Mirror to stderr so docker/uvicorn logs capture it too.
    try:
        print(line, file=sys.stderr, flush=True)
    except Exception:
        pass
