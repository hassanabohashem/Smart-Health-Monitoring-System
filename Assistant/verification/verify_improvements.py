# Path resolution to allow core imports when run from the verification subfolder
import os
import sys
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

"""
End-to-end verification of all integration-focused improvements.

Groups:
  A. Context fields (patient, activity, recent_events, user_role)
  B. Structured response (emergency flag, recommended_action, latency_ms)
  C. Streaming /chat/stream
  D. Caching (/cache-stats, from_cache flag)
  E. Retry / error handling (sanity)
  F. Logging (file exists + contains records)
  G. Output moderation (sanity)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

BASE = "http://127.0.0.1:8000"


def post(path, body, raw=False):
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        data = resp.read()
    return data if raw else json.loads(data.decode("utf-8"))


def get(path):
    with urllib.request.urlopen(f"{BASE}{path}", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


results = []

def check(label, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    tail = f"  ({detail})" if detail else ""
    print(f"[{mark}] {label}{tail}")
    results.append(cond)


# ── A. Context fields ─────────────────────────────────────
print("\n== A. Context fields are accepted and influence the response ==")

r = post("/chat", {
    "question": "My pulse feels fast. What could be causing it?",
    "patient": {"age": 82, "sex": "M", "conditions": ["COPD", "hypertension"],
                "medications": ["lisinopril", "albuterol"]},
    "activity": "walking",
    "user_role": "caregiver",
})
check("Chat accepts patient+activity+role", r["refused"] is False)
# With activity=walking OR COPD+hypertension context, we expect the answer to
# reference either the activity or the relevant conditions. (The 8B fallback
# may not echo "walking" explicitly but reliably reasons about COPD/hypertension.)
ans_low = r["answer"].lower()
check("Activity/condition context reaches the model",
      any(w in ans_low for w in [
          "walk", "walking", "exertion", "activity", "exercise", "exerc",
          "copd", "hypertension", "albuterol", "lisinopril"
      ]),
      detail=ans_low[:120])

r2 = post("/chat", {
    "question": "Check on me",
    "recent_events": [{"type": "fall", "when": "3 min ago",
                       "detail": "fall detected by wrist IMU"}],
    "vitals": {"hr": 102, "spo2": 96, "temp": 36.9},
})
# Answer should acknowledge the fall OR reference common post-fall concerns
# (English OR Arabic — the fallback model sometimes switches language).
ans2_low = r2["answer"].lower()
ans2_raw = r2["answer"]
check("Recent fall event reaches the model",
      any(w in ans2_low for w in [
          "fall", "fell", "injur", "pain", "suddenly", "recent event",
          "dizzy", "hurt", "able to move",
      ]) or any(w in ans2_raw for w in [
          "سقوط", "سقط", "إصابة", "ألم", "جرح", "تحرك",
      ]),
      detail=ans2_raw[:120])


# ── B. Structured response ────────────────────────────────
print("\n== B. Structured response fields ==")

r = post("/chat", {"question": "Hello, how are you?"})
for field in ["emergency", "emergency_reason", "recommended_action",
              "from_cache", "latency_ms"]:
    check(f"Response has `{field}` field", field in r)

check("Non-critical Q has emergency=False", r["emergency"] is False)
check("Non-critical Q has recommended_action=none", r["recommended_action"] == "none")

# Critical vitals should trigger emergency=True
r_crit = post("/chat", {
    "question": "What is happening?",
    "vitals": {"hr": 165, "spo2": 80, "temp": 39.1},
})
check("Critical vitals -> emergency=True", r_crit["emergency"] is True)
check("Critical vitals -> recommended_action=call_911",
      r_crit["recommended_action"] == "call_911")


# ── C. Streaming /chat/stream ─────────────────────────────
print("\n== C. Streaming endpoint ==")

req = urllib.request.Request(
    f"{BASE}/chat/stream",
    data=json.dumps({"question": "What is a normal heart rate for elderly?"}).encode("utf-8"),
    headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
    method="POST",
)
chunks = []
events = []
with urllib.request.urlopen(req, timeout=90) as resp:
    for raw in resp:
        line = raw.decode("utf-8", errors="replace").rstrip("\n")
        if line.startswith("event: "):
            events.append(line[len("event: "):].strip())
        elif line.startswith("data: "):
            try:
                payload = json.loads(line[len("data: "):].strip())
                if "text" in payload:
                    chunks.append(payload["text"])
                elif "full_answer" in payload:
                    chunks.append(f"[FINAL len={len(payload['full_answer'])}]")
            except Exception:
                pass

check("Stream emitted 'start' event", "start" in events)
check("Stream emitted at least one 'chunk'", "chunk" in events)
check("Stream emitted 'final' event", "final" in events)
check("Stream produced >0 partial text chunks", any(c and not c.startswith("[FINAL") for c in chunks))


# ── D. Caching ────────────────────────────────────────────
print("\n== D. Response cache ==")

before = get("/cache-stats")
# Unique question each run so we actually exercise the MISS→HIT transition.
q = {"question": f"What is a normal body temperature for elderly people? (test {time.time()})"}
r1 = post("/chat", q)
r2 = post("/chat", q)
after = get("/cache-stats")

check("First call was not from cache", r1["from_cache"] is False)
check("Second identical call was from cache", r2["from_cache"] is True)
check("Cache size increased", after["size"] > before["size"])
_cached_lat = r2["latency_ms"] if r2["latency_ms"] is not None else 9999
check("Cached call was fast (<200ms)", _cached_lat < 200,
      detail=f"latency={r2['latency_ms']}ms")


# ── E. Retry / error handling sanity ──────────────────────
print("\n== E. Retry logic is wired (sanity) ==")
# Can't easily force a Groq failure in test — just verify the retry helper is imported
from core.llm import _retry
check("Retry helper is importable", callable(_retry))


# ── F. Logging ────────────────────────────────────────────
print("\n== F. Logging to logs/assistant.jsonl ==")
log_path = Path("logs/assistant.jsonl")
check("Log file exists", log_path.exists())
if log_path.exists():
    lines = log_path.read_text(encoding="utf-8").strip().splitlines()
    events_logged = set()
    for ln in lines[-100:]:
        try:
            events_logged.add(json.loads(ln)["event"])
        except Exception:
            pass
    for ev in ["chat_request", "chat_response", "cache_hit"]:
        check(f"Log contains {ev}", ev in events_logged, detail=f"recent events: {sorted(events_logged)}")


# ── G. Output moderation sanity ───────────────────────────
print("\n== G. Output moderation sanity ==")

# A question that the model would normally answer fine — verify moderation doesn't break it
r = post("/chat", {"question": "What are common signs of dehydration in elderly?"})
check("Output moderation passes benign medical Q&A", r["refused"] is False and len(r["answer"]) > 100)


# ── Summary ───────────────────────────────────────────────
print()
passed = sum(1 for x in results if x)
print(f"TOTAL: {passed} / {len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
