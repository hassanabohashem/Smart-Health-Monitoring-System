# Smart Health AI — Mobile Integration Guide

Everything your React Native (Expo) app needs to integrate with the assistant backend.

## 1. What you need from the backend

| Item | Value |
|---|---|
| Base URL (local dev) | `http://<your-pc-ip>:8000` |
| Base URL (prod) | `https://<your-deployment>.onrender.com` |
| Auth header | `X-API-Key: <the shared key>` (when backend has `SMARTHEALTH_AUTH_REQUIRED=true`) |
| Endpoints | `GET /health`, `POST /analyze-vitals`, `POST /chat`, `POST /chat/stream` |

Interactive docs: `<base>/docs` (Swagger UI).

## 2. Drop the client into your app

Copy these two files from this repo into your app:

```
Assistant/mobile_client/types.ts     →  smart-health-54/src/services/assistantTypes.ts
Assistant/mobile_client/client.ts    →  smart-health-54/src/services/assistant.ts
```

(Rename as you like — adjust the relative import path in `client.ts` if you rename `types.ts`.)

Then wherever you want to use it:

```typescript
import { SmartHealthClient } from "@/services/assistant";

export const assistant = new SmartHealthClient({
  baseUrl: process.env.EXPO_PUBLIC_ASSISTANT_URL!,
  apiKey: process.env.EXPO_PUBLIC_ASSISTANT_API_KEY,
});
```

Put `EXPO_PUBLIC_ASSISTANT_URL` and `EXPO_PUBLIC_ASSISTANT_API_KEY` in your `.env` (they need the `EXPO_PUBLIC_` prefix to be exposed to the app).

## 3. Five things you can do with the client

### a) Health / connectivity probe (run on app startup)
```typescript
const h = await assistant.health();
console.log(h.status, h.version, h.llm);  // { status: "ok", ... }
```
If this throws, the backend is unreachable or the URL is wrong.

### b) Rules-only vitals analysis (cheap, ~ms)
```typescript
const result = await assistant.analyzeVitals({
  hr: 55, spo2: 92, temp: 37.2
});
// { severity: "WARNING", summary: "HR: 55 bpm, SpO2: 92%, Temp: 37.2°C",
//   alerts: [{ level: "WARNING", param: "Heart Rate", ... }, ...] }
```
Use this for a quick "what's my status right now" readout — no LLM call, no cost.

### c) Full chat (blocking)
```typescript
const r = await assistant.chat({
  question: "My dad is feeling dizzy, should I be worried?",
  vitals: { hr: 58, spo2: 95, temp: 36.9 },
  patient: {
    age: 78,
    sex: "M",
    conditions: ["hypertension", "COPD"],
    medications: ["lisinopril", "albuterol"],
  },
  activity: "standing",
  user_role: "caregiver",
});

if (r.emergency) {
  // triggerSosFlow(r.emergency_reason, r.recommended_action);
}
if (r.drug_warnings.length) {
  // showDrugWarnings(r.drug_warnings);
}
setAnswer(r.answer);
```

### d) Streaming chat (recommended for UX)
```typescript
let buffer = "";
await assistant.chatStream(
  { question: "What are signs of stroke?", user_role: "wearer" },
  (chunk) => {
    buffer += chunk;
    setAnswer(buffer);  // update UI as tokens arrive
  },
  (final) => {
    if (final.emergency) triggerSosFlow(final.emergency_reason);
    console.log("Total latency:", final.latency_ms, "ms");
  },
);
```

### e) Send recent events (pair with fall detection / HAR integration)
```typescript
await assistant.chat({
  question: "Check on me",
  recent_events: [{ type: "fall", when: "3 min ago",
                    detail: "fall detected by wrist IMU" }],
  vitals: latestVitals,
});
```

## 4. Mapping API signals to your app's UX

| Response field | What the app should do |
|---|---|
| `emergency === true` | Red banner. Fire an alert to Supabase `alerts` with `severity=critical`. Offer one-tap to dial emergency contact. |
| `recommended_action === "call_911"` | Show "Call Emergency Services" button as primary action. |
| `red_flags[].category` | Show a small icon per red flag (e.g. for breathing, for stroke). |
| `drug_warnings[].level === "avoid"` or `"major"` | Show a prominent warning card before the LLM answer. |
| `severity === "CRITICAL"` | Same treatment as `emergency: true`. |
| `severity === "SENSOR_ERROR"` | Show "sensor issue" banner, not a medical emergency. |
| `refused === true` | Fell into moderation block — show the answer as-is, do not surface as emergency. |
| `from_cache === true` | Purely diagnostic; no UX change. |

## 5. Pulling context from your existing stores

Your app already has this data — wire it into the chat call:

```typescript
import { useAuthStore } from "@/stores/auth";
import { useVitalsStore } from "@/stores/vitals";
import { useAlertsStore } from "@/stores/alerts";

async function askWithContext(question: string) {
  const profile = useAuthStore.getState().profile;
  const latestVitals = useVitalsStore.getState().latest;
  const recentAlerts = useAlertsStore.getState().alerts
    .filter((a) => Date.now() - a.createdAt < 10 * 60_000)
    .map((a) => ({
      type: a.type,  // "fall" | "tachycardia" | ...
      when: humanizeAgo(a.createdAt),
      detail: a.message,
    }));

  return assistant.chat({
    question,
    vitals: latestVitals,
    patient: {
      age: profile.age,
      sex: profile.sex,
      conditions: profile.conditions,
      medications: profile.medications,
    },
    recent_events: recentAlerts,
    user_role: profile.role,  // "wearer" | "caregiver"
  });
}
```

## 6. React Native streaming caveats

- **Expo SDK 49+ / RN 0.71+**: fetch streaming works out of the box. No polyfill needed.
- **Older RN**: `res.body.getReader()` may return `null`. Install `react-native-polyfill-globals`:
  ```bash
  npm install react-native-polyfill-globals react-native-url-polyfill
  npx pod-install
  ```
  Then import at the top of `App.tsx`:
  ```typescript
  import "react-native-polyfill-globals/auto";
  ```
- **If streaming still doesn't work**: just use the non-streaming `chat()` method. Total latency is 2–4 seconds; the UX is worse but it works everywhere.

## 7. Error handling

```typescript
import { SmartHealthApiError } from "@/services/assistant";

try {
  const r = await assistant.chat({ question });
} catch (e) {
  if (e instanceof SmartHealthApiError) {
    if (e.status === 401) {
      // Bad API key
    } else if (e.status === 429) {
      // Rate-limited — show "try again in a moment"
    } else if (e.status === 502) {
      // LLM upstream failure
    }
  } else {
    // Network error
  }
}
```

Note: when the LLM itself is rate-limited by Groq, you'll get a 200 with a friendly
"I'm having trouble reaching the AI right now" message — NOT a 5xx. This is
intentional: the rules-engine severity is still reported even when Groq is down.

## 8. Regenerating types after a backend change

If we add fields to `api.py`, regenerate the TypeScript types:

```bash
cd Assistant
venv/Scripts/python.exe -m uvicorn api:app --host 127.0.0.1 --port 8000 &
cd mobile_client
./regen.sh
```

Copy the new `types.ts` back into `smart-health-54/src/services/assistantTypes.ts`.

## 9. Security checklist before going live

- [ ] `.env` with real secrets is in `.gitignore` (confirm `git status` does not list it)
- [ ] Production `SMARTHEALTH_AUTH_REQUIRED=true`
- [ ] `SMARTHEALTH_API_KEY` is a long random string (≥32 chars)
- [ ] API is behind HTTPS (Render/Fly provide this automatically)
- [ ] CORS `allow_origins` tightened to just your app's domains, not `"*"`
- [ ] Groq key is NOT bundled into the mobile app — only the shared API key
- [ ] You've run `verification/verify_fixes.py`, `verification/verify_improvements.py`, `eval/run_eval.py` against the live deployment

## 10. Example complete flow

```typescript
// App startup
try {
  const h = await assistant.health();
  if (h.auth_required && !process.env.EXPO_PUBLIC_ASSISTANT_API_KEY) {
    showBanner("Assistant needs an API key to work");
  }
} catch {
  showBanner("Assistant is unreachable");
}

// User opens chat
async function onSend(userText: string) {
  addMessage({ role: "user", content: userText });
  setThinking(true);

  let buffer = "";
  try {
    await assistant.chatStream(
      {
        question: userText,
        vitals: latestVitals,
        patient: currentProfile,
        activity: currentActivity,
        recent_events: recentEvents,
        user_role: currentRole,
        chat_history: currentHistory.slice(-6),
      },
      (chunk) => {
        buffer += chunk;
        updateAssistantMessage(buffer);
      },
      (final) => {
        setThinking(false);
        if (final.emergency) {
          fireAlert({
            severity: "critical",
            type: "assistant_emergency",
            reason: final.emergency_reason,
            redFlags: final.red_flags,
          });
        }
        if (final.drug_warnings.length > 0) {
          showDrugWarningModal(final.drug_warnings);
        }
      },
    );
  } catch (e) {
    setThinking(false);
    if (e instanceof SmartHealthApiError && e.status === 429) {
      addMessage({
        role: "system",
        content: "The AI is busy — please try again in a moment.",
      });
    } else {
      addMessage({ role: "system", content: "Couldn't reach the assistant." });
    }
  }
}
```

That's all you need. For anything not covered here, check the interactive docs at `<base>/docs`.
