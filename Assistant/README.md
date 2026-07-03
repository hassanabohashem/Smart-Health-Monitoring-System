---
title: Smart Health AI
emoji: 🩺
colorFrom: blue
colorTo: green
sdk: docker
pinned: false
app_port: 7860
short_description: Clinical decision-support API for wearables
---

# Smart Health AI

Clinical decision-support assistant for a wearable health-monitoring platform. Wearers can be any age — children, adults, or older adults. Part of the Smart Health Monitoring System graduation project.

Built around a **deterministic rules engine** for vital signs (age-aware), a **curated RAG corpus** of clinical references, and a **hardened LLM pipeline** (Groq-hosted Llama 3.3 70B with fallbacks) with input/output moderation, drug-interaction warnings, and red-flag symptom detection. Serves a FastAPI backend with typed TypeScript client for the React Native mobile app.

---

## What it does

| Capability | How |
|---|---|
| **Vitals severity** | Rules engine — `NORMAL`/`WARNING`/`DANGER`/`CRITICAL`/`SENSOR_ERROR`/`UNKNOWN` |
| **Emergency flag** | Deterministic — fires on critical vitals *or* red-flag phrases in the question |
| **Red-flag symptom detection** | 30+ regex patterns across 8 categories, English + Arabic |
| **Drug-interaction warnings** | 20 curated rules from Beers 2023 + STOPP/START + FDA labels |
| **RAG grounding** | 6 clinical documents (Beers, STEADI, ICOPE-derived) indexed with FAISS |
| **Safety moderation** | Llama Guard + keyword pre-filter + hardened system prompt |
| **Response streaming** | SSE, with emergency preamble as first chunk |
| **Bilingual** | English + Arabic throughout — prompts, patterns, corpus |
| **Resilience** | Model fallback chain (70B → 8B → GPT-OSS), retry+backoff, LRU cache |

---

## Quick start

### Prerequisites
- Python 3.12 (not 3.14 — TensorFlow/torch compatibility)
- A Groq API key ([console.groq.com](https://console.groq.com))

### Local development
```bash
# 1. Set up
cd Assistant
py -3.12 -m venv venv
venv/Scripts/python.exe -m pip install -r requirements.txt

# 2. Configure
cp .env.example .env
# Edit .env and set GROQ_API_KEY

# 3. Run the API
venv/Scripts/python.exe -m uvicorn api:app --reload --host 127.0.0.1 --port 8000

# 4. (Optional) Run the Streamlit dashboard for manual testing
venv/Scripts/streamlit run assistant.py
```

API docs (auto-generated): http://127.0.0.1:8000/docs
Streamlit UI: http://localhost:8501

### Running tests
```bash
# Full safety + quality evaluation (47 prompts)
venv/Scripts/python.exe eval/run_eval.py --delay 2.5

# Individual verification suites
venv/Scripts/python.exe verification/verify_fixes.py          # 17 safety regressions
venv/Scripts/python.exe verification/verify_improvements.py   # 26 integration checks
venv/Scripts/python.exe verification/verify_redflags.py       # 23 red-flag patterns
venv/Scripts/python.exe verification/verify_drugs.py          # 20 drug interactions
venv/Scripts/python.exe verification/verify_rag.py            # 11 RAG retrievals
```

Reports land in `eval/results/<timestamp>/`.

---

## Repo layout

```
Assistant/
├── api.py                      FastAPI HTTP server
├── assistant.py                Streamlit dashboard (dev tool)
├── core/                       Shared business logic (used by both api.py + assistant.py)
│   ├── config.py               Env-driven config (models, API keys)
│   ├── rules.py                Vitals analyzer (with sensor-error detection)
│   ├── red_flags.py            Emergency symptom detection (EN + AR)
│   ├── drug_interactions.py    Beers / STOPP / FDA drug rules
│   ├── rag.py                  FAISS-backed retrieval
│   ├── prompts.py              System prompt builder
│   ├── llm.py                  Groq wrapper — moderation, cache, retry, streaming
│   └── logger.py               Structured JSONL logging
├── corpus/                     RAG source documents
│   ├── 01_vital_signs_elderly.md
│   ├── 02_beers_criteria_summary.md
│   ├── 03_fall_prevention_steadi.md
│   ├── 04_common_elderly_conditions.md
│   ├── 05_daily_wellness_elderly.md
│   └── 06_arabic_elderly_wellness.md
├── docs/                       Technical documentation
│   ├── DEPLOY.md               Deployment guide (Render / Fly / ngrok)
│   ├── INTEGRATION.md          Mobile-app integration reference
│   └── AUDIT_REPORT.md         Original audit of teammate's code
├── eval/                       Safety + quality evaluation suite
│   ├── prompt_library.py       47 curated test prompts
│   ├── run_eval.py             Runner with metrics
│   └── results/                Timestamped reports (JSON + MD) (local only, gitignored)
├── mobile_client/              TypeScript client for React Native
│   ├── client.ts               Typed client — health(), chat(), chatStream()
│   ├── types.ts                Auto-generated from OpenAPI
│   ├── e2e_test.ts             20-check smoke test
│   └── regen.sh                Regenerate types after schema changes
├── verification/               Regression testing suites
│   ├── verify_drugs.py         Verify Beers and interactions
│   ├── verify_fixes.py         Verify safety regression fixes
│   ├── verify_improvements.py  Verify general API integrations
│   ├── verify_rag.py           Verify RAG search and retrieval
│   └── verify_redflags.py      Verify emergency symptom detectors
├── logs/                       Structured JSONL request logs (local only, gitignored)
├── medical_db/                 FAISS index (built on first use, gitignored)
├── requirements.txt            Full dev deps
├── requirements-prod.txt       Lean prod deps (for Docker)
├── Dockerfile                  Production container (CPU-only torch)
├── render.yaml                 Render deployment blueprint
├── .env.example                Template for secrets
├── .gitignore                  Excludes .env, venv, logs, index, eval/results
└── README.md                   This file
```

---

## The endpoints

Interactive Swagger UI: `<base>/docs`

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | public | Liveness + config report |
| `POST /analyze-vitals` | auth | Rules-only severity (no LLM, ~ms) |
| `POST /chat` | auth | Full structured LLM response |
| `POST /chat/stream` | auth | SSE stream of the response |
| `GET /cache-stats` | auth | Cache diagnostics |
| `GET /rag/stats` | auth | RAG index diagnostics |
| `GET /rag/preview` | auth | Preview retrieved chunks for a query |

Auth is enabled when `SMARTHEALTH_AUTH_REQUIRED=true`. Disabled by default in dev.

---

## Sample chat request

```json
POST /chat
{
  "question": "My dad feels dizzy, should I be worried?",
  "vitals": { "hr": 55, "spo2": 92, "temp": 37.1 },
  "patient": {
    "age": 78,
    "sex": "M",
    "conditions": ["hypertension", "COPD"],
    "medications": ["lisinopril", "albuterol", "ibuprofen"]
  },
  "activity": "standing",
  "recent_events": [
    { "type": "fall", "when": "5 min ago" }
  ],
  "user_role": "caregiver"
}
```

Response:
```json
{
  "answer": "Based on the readings and the recent fall... (markdown text)",
  "severity": "WARNING",
  "emergency": true,
  "emergency_reason": "red_flag:fall",
  "recommended_action": "call_911",
  "red_flags": [{ "category": "fall", "label": "...", ... }],
  "drug_warnings": [],
  "from_cache": false,
  "latency_ms": 3420,
  "model": "llama-3.3-70b-versatile",
  "refused": false
}
```

---

## Deployment

See `DEPLOY.md`. TL;DR:
- **Render**: push to GitHub, blueprint from `render.yaml`, set `GROQ_API_KEY` + `SMARTHEALTH_API_KEY` in the dashboard, deploy. HTTPS automatic.
- **Fly.io**: `fly launch` then `fly secrets set ...` then `fly deploy`.
- **ngrok**: demo-day only, not for production.

---

## Mobile integration

See `INTEGRATION.md` for the complete guide. Short version:
1. Copy `mobile_client/client.ts` + `types.ts` into your React Native `src/services/`.
2. Set `EXPO_PUBLIC_ASSISTANT_URL` and `EXPO_PUBLIC_ASSISTANT_API_KEY` in the app's `.env`.
3. Instantiate `SmartHealthClient` once and call `.chat()` / `.chatStream()`.

---

## Evaluation results

Latest run: `eval/results/<timestamp>/summary.md`. Representative numbers:

| Metric | Value |
|---|---|
| Safety F1 (refusal on unsafe prompts) | 93.75% |
| Emergency F1 | 100% |
| Drug-warning F1 | 100% |
| Red-flag recall (6 categories) | 100% each |
| False-refusal rate on benign prompts | 5.56% |
| Mean latency | 5.8 s (p95 ≈ 8.6 s) |

47 curated prompts: 16 unsafe (injection, lethal info, self-harm), 13 emergency (EN + AR + vitals-based), 13 benign, 5 drug-interaction scenarios.

---

## Known limitations

- **Groq free tier**: 1M tokens/day on Llama 3.3 70B, then auto-falls-over to 8B (lower quality but still useful). Eval data reflects both paths.
- **Llama Guard**: `meta-llama/llama-guard-4-12b` default; may require updating as Groq deprecates models. Falls back to keyword-only moderation after 3 consecutive failures.
- **Skin vs core temperature**: smartwatch sensors report skin temp (~1°C lower than core). Rules thresholds assume core/oral. Adjust client-side or flag for future work.
- **Respiratory rate**: Samsung Galaxy Watch 5 doesn't measure RR reliably. Field is optional and skipped if absent.
- **Cache is in-memory**: cleared on restart. Good enough for the project scope.

---

## Credits

- **Rules & clinical knowledge**: AGS Beers Criteria 2023, STOPP/START v3, CDC STEADI, WHO ICOPE handbook
- **LLM**: Llama 3.3 70B / Llama 3.1 8B via Groq
- **Embeddings**: `sentence-transformers/all-MiniLM-L6-v2`
- **Vector store**: FAISS-CPU
- **Moderation**: Llama Guard 4 12B

Part of the Smart Health Monitoring System graduation project.
