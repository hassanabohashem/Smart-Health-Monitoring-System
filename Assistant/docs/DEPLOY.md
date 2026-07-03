# Deploying Smart Health AI

Three options from easiest to most robust. Pick one.

---

## Option A — Render (recommended for the graduation project)

**Why**: simplest path, free tier is fine for demo, HTTPS automatic, deploys from GitHub.

1. **Push this folder to GitHub**. `Assistant/` as a repo, or as a subdirectory.
2. Sign in at https://render.com (GitHub OAuth).
3. **New → Blueprint → connect your repo**.
4. Render reads `render.yaml` and creates the service. Accept the defaults.
5. In the created service's **Environment** tab, set:
   - `GROQ_API_KEY` = your Groq key (get one at https://console.groq.com)
   - `SMARTHEALTH_API_KEY` = a long random string — generate with `openssl rand -hex 32`
6. Click **Manual Deploy → Deploy latest commit**. First build takes ~5 min (installing torch).
7. Once live, you'll have a URL like `https://smarthealth-api-xxxx.onrender.com`. Test it:
   ```bash
   curl https://smarthealth-api-xxxx.onrender.com/health
   ```
   Should return `{"status":"ok",...,"auth_required":true}`.
8. In your mobile app's `.env`, set:
   ```
   EXPO_PUBLIC_ASSISTANT_URL=https://smarthealth-api-xxxx.onrender.com
   EXPO_PUBLIC_ASSISTANT_API_KEY=<same value you set in Render>
   ```

**Free tier gotchas:**
- 512MB RAM is tight. If deploys fail with OOM errors, upgrade to the $7/mo Starter plan (1GB RAM).
- Free services sleep after 15min of inactivity; the first request after sleeping takes ~30s. For live users, upgrade.

---

## Option B — Fly.io (more control, global edge)

**Why**: if you want finer control over regions, better latency globally, and don't mind a tiny bit more setup.

1. `brew install flyctl` or grab it from https://fly.io/docs/hands-on/install-flyctl/.
2. `fly auth signup` (or `login`).
3. From the `Assistant/` directory:
   ```bash
   fly launch --copy-config --no-deploy
   ```
   Accept defaults, say NO to Postgres/Redis.
4. Set secrets:
   ```bash
   fly secrets set GROQ_API_KEY=gsk_xxxxxxx SMARTHEALTH_API_KEY=$(openssl rand -hex 32) SMARTHEALTH_AUTH_REQUIRED=true
   ```
5. Deploy:
   ```bash
   fly deploy
   ```
6. Get the URL: `fly status` → `Hostname: smarthealth-api.fly.dev`.

---

## Option C — Run on your laptop + ngrok (demo day only)

**Why**: for a one-time demo where you can't set up cloud.

1. `brew install ngrok` / download from https://ngrok.com.
2. Start the API as usual:
   ```bash
   cd Assistant
   venv/Scripts/python.exe -m uvicorn api:app --host 0.0.0.0 --port 8000
   ```
3. In another terminal:
   ```bash
   ngrok http 8000
   ```
4. ngrok gives you a `https://abcd1234.ngrok-free.app` URL. Point the mobile app at it.
5. Kill ngrok when the demo is done. Don't leave it running — the URL is public.

---

## Post-deployment checklist

After deploying, run the full test suites against the live URL:

```bash
# On your dev machine, with the live URL
export BASE=https://smarthealth-api-xxxx.onrender.com
export API_KEY=<the shared key you set>

# Quick sanity
curl -s $BASE/health

# Vitals
curl -s -X POST $BASE/analyze-vitals \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"hr":72,"spo2":98,"temp":36.8}'

# Chat
curl -s -X POST $BASE/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{"question":"What is a normal heart rate for elderly?"}'
```

All three should return JSON with `auth_required:true` / `severity:"NORMAL"` / a structured chat answer.

To run the full evaluation suite against the deployed URL, edit `eval/run_eval.py`'s `BASE` constant (or pass it as an env var if you wrap it) and rerun.

---

## Monitoring

- **Logs**: `fly logs` or Render dashboard → Logs tab. Every request writes a JSONL event.
- **Metrics endpoint**: not currently exposed. The JSONL log is the source of truth — you can tail it or `jq` it.
- **Groq usage**: https://console.groq.com → Usage. Watch tokens-per-day and bill.

---

## Cost reality check

At Groq's free tier (as of writing):
- **Llama 3.3 70B**: 14,400 tokens/min, 1M tokens/day
- **Llama 3.1 8B**: 14,400 tokens/min, 20M tokens/day
- **Llama Guard**: separate quota

A typical chat uses ~1,500 tokens (prompt + response). So the free tier gives you ~650 chats/day on Llama 3.3 before falling over to Llama 3.1. More than enough for thesis evaluation. For production, you'd want a paid tier or a self-hosted model.
