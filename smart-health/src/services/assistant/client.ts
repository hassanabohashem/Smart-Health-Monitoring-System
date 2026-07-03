/**
 * Smart Health AI — mobile client.
 *
 * Drop this file into your React Native app's `src/services/` folder
 * (rename to `assistant.ts`) alongside `types.ts`.
 *
 * Usage:
 *   const client = new SmartHealthClient({
 *     baseUrl: "https://your-api.onrender.com",
 *     apiKey: process.env.EXPO_PUBLIC_ASSISTANT_API_KEY,
 *   });
 *
 *   // Health check
 *   const health = await client.health();
 *
 *   // Simple chat
 *   const r = await client.chat({
 *     question: "Is a heart rate of 55 normal for my 80yo father?",
 *     patient: { age: 80, sex: "M", conditions: ["hypertension"] },
 *   });
 *   if (r.emergency) triggerSosFlow();
 *
 *   // Streaming chat
 *   await client.chatStream(
 *     { question: "Tell me about fall prevention.", user_role: "caregiver" },
 *     (chunk) => setAnswer((prev) => prev + chunk),
 *     (final) => {
 *       if (final.emergency) triggerSosFlow();
 *     },
 *   );
 */
import type { components } from "./types";

// Re-export the OpenAPI-generated types verbatim for callers who want them.
export type Vitals = components["schemas"]["Vitals"];
export type Patient = components["schemas"]["Patient"];
export type HealthEvent = components["schemas"]["HealthEvent"];
export type ChatRequest = components["schemas"]["ChatRequest"];
export type ChatResponse = components["schemas"]["ChatResponse"];
export type ChatMessage = components["schemas"]["ChatMessage"];
export type AnalyzeVitalsResponse = components["schemas"]["AnalyzeVitalsResponse"];
export type RedFlagOut = components["schemas"]["RedFlagOut"];
export type DrugWarningOut = components["schemas"]["DrugWarningOut"];


// ── Ergonomic input type for chat() / chatStream() ────────────────────
// openapi-typescript generates nullable fields as `T | null` (not `T?`), which
// forces callers to explicitly pass `null`. This is friendlier:
export interface ChatInput {
  /** The user's question (required). */
  question: string;
  /** Up to 8 previous messages for context. */
  chat_history?: ChatMessage[];
  /** Current vital signs from the wearable. */
  vitals?: Vitals;
  /** Patient profile — age, sex, conditions, medications. */
  patient?: Patient;
  /** Current activity label from the HAR model. */
  activity?:
    | "sitting"
    | "walking"
    | "running"
    | "climbing_stairs"
    | "going_downstairs"
    | "sleeping"
    | "standing"
    | "lying";
  /** Recent fall / tachycardia / geofence events. */
  recent_events?: HealthEvent[];
  /** Adjusts tone: simpler for wearer, clinical for caregiver. */
  user_role?: "wearer" | "caregiver";
  // Note: there's no `retrieval_context` field — the backend retrieves RAG
  // context server-side. Client-supplied context would be a prompt-injection
  // vector.
}


function toChatRequest(input: ChatInput): ChatRequest {
  // Map friendly optional fields to the wire format the API expects.
  return {
    question: input.question,
    chat_history: input.chat_history ?? null,
    vitals: input.vitals ?? null,
    patient: input.patient ?? null,
    activity: input.activity ?? null,
    recent_events: input.recent_events ?? null,
    user_role: input.user_role ?? null,
  };
}


export interface SmartHealthClientOptions {
  /** Base URL — e.g. "https://smarthealth-api.onrender.com". No trailing slash. */
  baseUrl: string;
  /** Shared API key. Required when the backend has SMARTHEALTH_AUTH_REQUIRED=true. */
  apiKey?: string;
  /** Default timeout for non-streaming calls, in ms. Default 60000. */
  timeoutMs?: number;
}


export interface HealthResponse {
  status: string;
  product: string;
  llm: string;
  moderation: string;
  version: string;
  auth_required: boolean;
}


export interface StreamFinal {
  full_answer: string;
  refused: boolean;
  model: string;
  severity: string | null;
  vitals_summary: string | null;
  emergency: boolean;
  emergency_reason: string | null;
  recommended_action: "call_911" | "contact_caregiver" | "monitor" | "none";
  red_flags: Array<{ category: string; label: string; severity: string; matched_text: string }>;
  drug_warnings: DrugWarningOut[];
  from_cache: boolean;
  latency_ms: number;
}


export class SmartHealthApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "SmartHealthApiError";
  }
}


export class SmartHealthClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;

  constructor(opts: SmartHealthClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...extra,
    };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      init.timeoutMs ?? this.timeoutMs,
    );
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      const text = await res.text();
      const body = text ? safeJsonParse(text) : null;
      if (!res.ok) {
        const detail = (body as { detail?: unknown })?.detail ?? text;
        throw new SmartHealthApiError(
          res.status,
          `${path} returned ${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`,
          detail,
        );
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Liveness / configuration probe. Does NOT require an API key. */
  async health(): Promise<HealthResponse> {
    return this.request<HealthResponse>("/health", { method: "GET" });
  }

  /** Rules-only vitals analysis. Very fast (~ms). No LLM call. */
  async analyzeVitals(v: Vitals): Promise<AnalyzeVitalsResponse> {
    return this.request<AnalyzeVitalsResponse>("/analyze-vitals", {
      method: "POST",
      body: JSON.stringify(v),
    });
  }

  /** Full chat call. Returns complete answer after the LLM finishes. */
  async chat(req: ChatInput): Promise<ChatResponse> {
    return this.request<ChatResponse>("/chat", {
      method: "POST",
      body: JSON.stringify(toChatRequest(req)),
      timeoutMs: 120_000,
    });
  }

  /**
   * Streaming chat. Calls `onChunk` with each partial token as it arrives,
   * and `onFinal` once with the final metadata (emergency flag, red flags, etc.)
   * after the stream completes.
   *
   * Works with React Native 0.71+ (fetch streaming enabled by default).
   * For older RN versions, see the polyfill note in INTEGRATION.md.
   */
  async chatStream(
    req: ChatInput,
    onChunk: (text: string) => void,
    onFinal: (final: StreamFinal) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/chat/stream`, {
      method: "POST",
      headers: this.headers({ Accept: "text/event-stream" }),
      body: JSON.stringify(toChatRequest(req)),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SmartHealthApiError(res.status, `Stream failed: ${text}`);
    }
    if (!res.body) {
      throw new SmartHealthApiError(500, "Stream has no body (check RN fetch polyfill)");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Each SSE event is separated by a blank line ("\n\n").
        let nlnl: number;
        while ((nlnl = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, nlnl);
          buffer = buffer.slice(nlnl + 2);
          const parsed = parseSseBlock(raw);
          if (!parsed) continue;
          const { event, data } = parsed;
          if (event === "chunk" && typeof data?.text === "string") {
            onChunk(data.text);
          } else if (event === "final" && data && typeof data.full_answer === "string") {
            onFinal(data as StreamFinal);
          } else if (event === "error") {
            throw new SmartHealthApiError(500, `stream error: ${JSON.stringify(data)}`);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}


// ── helpers ────────────────────────────────────────────────────────────

function parseSseBlock(block: string): { event: string; data: any } | null {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event: ")) {
      event = line.slice("event: ".length).trim();
    } else if (line.startsWith("data: ")) {
      dataLines.push(line.slice("data: ".length));
    }
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return { event, data: { raw: dataLines.join("\n") } };
  }
}


function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
