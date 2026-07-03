/**
 * End-to-end smoke test of the TypeScript client against a running API.
 *
 * Run with:
 *   cd Assistant/mobile_client
 *   ./node_modules/.bin/tsc --project tsconfig.test.json
 *   node .compiled/e2e_test.js
 *
 * Or point to a non-localhost URL:
 *   API_URL=https://myapi.onrender.com API_KEY=xxx node .compiled/e2e_test.js
 */
/// <reference types="node" />
import { SmartHealthClient, SmartHealthApiError } from "./client";

const BASE = process.env.API_URL ?? "http://127.0.0.1:8000";
const KEY = process.env.API_KEY; // undefined means "no auth required"

const client = new SmartHealthClient({ baseUrl: BASE, apiKey: KEY });

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  const tail = detail ? `  (${detail})` : "";
  console.log(`[${mark}] ${label}${tail}`);
  if (cond) pass++;
  else fail++;
}

async function main() {
  // 1. Health
  try {
    const h = await client.health();
    ok("health() returns ok", h.status === "ok", `v=${h.version}`);
    ok("health() has auth_required flag", typeof h.auth_required === "boolean");
    ok("health() reports llm model", Boolean(h.llm));
  } catch (e) {
    ok("health() did not throw", false, `error=${(e as Error).message}`);
  }

  // 2. analyzeVitals — healthy
  try {
    const r = await client.analyzeVitals({ hr: 72, spo2: 98, temp: 36.8 });
    ok("analyzeVitals healthy -> NORMAL", r.severity === "NORMAL");
    ok("analyzeVitals returns alert array", Array.isArray(r.alerts) && r.alerts.length >= 3);
  } catch (e) {
    ok("analyzeVitals did not throw", false, `error=${(e as Error).message}`);
  }

  // 3. analyzeVitals — critical
  try {
    const r = await client.analyzeVitals({ hr: 160, spo2: 82, temp: 39.1 });
    ok("analyzeVitals critical -> CRITICAL", r.severity === "CRITICAL");
  } catch {
    ok("analyzeVitals critical did not throw", false);
  }

  // 4. Non-streaming chat (short to conserve Groq tokens)
  try {
    const r = await client.chat({
      question: "In one sentence: what is a normal heart rate?",
    });
    ok("chat() returned an answer", Boolean(r.answer) && r.answer.length > 10,
       `${r.answer.length} chars, model=${r.model}`);
    ok("chat() has machine-readable fields",
       typeof r.emergency === "boolean" &&
       typeof r.refused === "boolean" &&
       Array.isArray(r.red_flags) &&
       Array.isArray(r.drug_warnings));
  } catch (e) {
    ok("chat() did not throw", false, `error=${(e as Error).message}`);
  }

  // 5. Chat with vitals context -> emergency flag
  try {
    const r = await client.chat({
      question: "Briefly: what is happening?",
      vitals: { hr: 165, spo2: 82, temp: 39.1 },
    });
    ok("chat() with critical vitals -> emergency=true", r.emergency === true);
    ok("chat() with critical vitals -> recommended_action=call_911",
       r.recommended_action === "call_911");
  } catch {
    ok("chat() with vitals did not throw", false);
  }

  // 6. Streaming chat
  try {
    let chunkCount = 0;
    let finalReceived: any = null;
    const chunks: string[] = [];
    await client.chatStream(
      { question: "Give a 1-line answer: what's a normal body temperature?" },
      (text) => {
        chunkCount++;
        chunks.push(text);
      },
      (final) => {
        finalReceived = final;
      }
    );
    ok("chatStream() emitted chunks", chunkCount > 0, `got ${chunkCount} chunks`);
    ok("chatStream() fired onFinal", finalReceived !== null);
    ok("chatStream() final has required fields",
       finalReceived && typeof finalReceived.emergency === "boolean" &&
       typeof finalReceived.full_answer === "string");
    const fullLen = chunks.join("").length;
    ok("chatStream() full answer is substantial", fullLen > 20, `${fullLen} chars`);
  } catch (e) {
    ok("chatStream() did not throw", false, `error=${(e as Error).message}`);
  }

  // 7. Streaming with red flag (should emit urgent preamble first)
  try {
    let firstChunk = "";
    let finalReceived: any = null;
    await client.chatStream(
      { question: "I think my grandpa is having a heart attack." },
      (text) => {
        if (!firstChunk) firstChunk = text;
      },
      (final) => {
        finalReceived = final;
      }
    );
    ok("redflag stream: first chunk is urgent preamble",
       firstChunk.toLowerCase().includes("urgent") || firstChunk.includes("🚨"));
    ok("redflag stream: final.emergency === true",
       finalReceived?.emergency === true);
    ok("redflag stream: recommended_action call_911",
       finalReceived?.recommended_action === "call_911");
    ok("redflag stream: red_flags array has chest_pain",
       Array.isArray(finalReceived?.red_flags) &&
       finalReceived.red_flags.some((f: any) => f.category === "chest_pain"));
  } catch (e) {
    ok("redflag stream did not throw", false, `error=${(e as Error).message}`);
  }

  // 8. Error-path: wrong API key (only when auth is enabled)
  try {
    const wrongClient = new SmartHealthClient({
      baseUrl: BASE,
      apiKey: "definitely-wrong-key-12345",
    });
    const h = await wrongClient.health();
    // health is always public so should still succeed
    ok("health() still works even with wrong key",
       h.status === "ok");

    if (h.auth_required) {
      try {
        await wrongClient.analyzeVitals({ hr: 72 });
        ok("wrong key -> should throw 401", false, "did NOT throw");
      } catch (e) {
        if (e instanceof SmartHealthApiError && e.status === 401) {
          ok("wrong key -> SmartHealthApiError 401", true);
        } else {
          ok("wrong key -> SmartHealthApiError 401", false,
             `got: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } else {
      console.log("[SKIP] auth not required on this server — 401 test skipped");
    }
  } catch (e) {
    ok("auth error path did not crash", false, String(e));
  }

  console.log();
  console.log(`TOTAL: ${pass}/${pass + fail} checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(2);
});
