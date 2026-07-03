/**
 * Smart Health AI assistant — high-level service for the app.
 *
 * Responsibilities:
 *   1. Initialize and cache a single `SmartHealthClient` instance.
 *   2. Pull context from the app's Zustand stores (profile, vitals, alerts).
 *   3. Handle the emergency flag — auto-create a critical alert when the
 *      backend flags an emergency.
 *   4. Expose a narrow API the chat screen can call.
 *
 * Usage (from the chat screen):
 *   import { askAssistant, streamAssistant, isAssistantEnabled } from '@/services/assistant';
 *
 *   const result = await askAssistant('Why do I feel dizzy?');
 *   if (result.emergency) ... // already auto-alerted via Supabase
 */
import {
  SmartHealthClient,
  SmartHealthApiError,
  type ChatInput,
  type ChatResponse,
  type StreamFinal,
  type HealthResponse,
  type Vitals,
  type Patient,
  type HealthEvent,
} from './client';
import {
  ASSISTANT_URL,
  ASSISTANT_API_KEY,
  ASSISTANT_ENABLED,
} from '@/utils/constants';
import { useAuthStore } from '@/stores/auth.store';
import { useVitalsStore } from '@/stores/vitals.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { createAlert } from '../alert.service';
import { supabase } from '../supabase';
import type { Profile } from '@/types/user.types';
import type { Alert as WearerAlert } from '@/types/alert.types';

export { SmartHealthApiError };
export type { ChatResponse, StreamFinal, HealthResponse };

// ── Singleton client ──────────────────────────────────────────────────
let _client: SmartHealthClient | null = null;

function getClient(): SmartHealthClient {
  if (!ASSISTANT_ENABLED) {
    throw new SmartHealthApiError(
      0,
      'Assistant is not configured. Set EXPO_PUBLIC_ASSISTANT_URL in .env.',
    );
  }
  if (!_client) {
    _client = new SmartHealthClient({
      baseUrl: ASSISTANT_URL,
      apiKey: ASSISTANT_API_KEY || undefined,
      timeoutMs: 90_000,
    });
  }
  return _client;
}

export function isAssistantEnabled(): boolean {
  return ASSISTANT_ENABLED;
}

// ── Context builders ──────────────────────────────────────────────────

/** Convert our Profile to the backend's Patient shape. */
function profileToPatient(profile: Profile | null): Patient | undefined {
  if (!profile) return undefined;
  const hasAny =
    profile.age != null ||
    profile.sex != null ||
    (profile.conditions && profile.conditions.length > 0) ||
    (profile.medications && profile.medications.length > 0);
  if (!hasAny) return undefined;
  return {
    age: profile.age ?? null,
    sex: profile.sex ?? null,
    conditions: profile.conditions ?? [],
    medications: profile.medications ?? [],
  };
}

/** Convert the latest vitals-store snapshot to the backend Vitals type. */
function vitalsSnapshotToApi(): Vitals | undefined {
  const v = useVitalsStore.getState();
  const has =
    v.heartRate != null || v.spo2 != null || v.temperature != null;
  if (!has) return undefined;
  return {
    hr: v.heartRate,
    spo2: v.spo2,
    temp: v.temperature,
    rr: null, // Galaxy Watch 5 doesn't measure respiratory rate reliably
  };
}

/** Humanize "minutes ago" for an alert timestamp. */
function humanizeAgo(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  return hr === 1 ? '1 hour ago' : `${hr} hours ago`;
}

/** Map a Supabase alert to the backend HealthEvent shape. */
function alertToEvent(a: WearerAlert): HealthEvent | null {
  // Backend accepts: "fall" | "tachycardia" | "hypoxia" | "geofence_exit" | "sos" | "other"
  const typeMap: Record<string, HealthEvent['type']> = {
    fall: 'fall',
    sos: 'sos',
    geofence: 'geofence_exit',
    cardiac: 'tachycardia',
    low_battery: 'other',
    inactivity: 'other',
  };
  const backendType = typeMap[a.type] ?? 'other';
  return {
    type: backendType,
    when: humanizeAgo(a.created_at),
    detail: (a.metadata?.message as string | undefined) ?? null,
  };
}

/** Pull the last 10 minutes of alerts from the store and map them. */
function recentEventsFromStore(): HealthEvent[] | undefined {
  const { alerts } = useAlertsStore.getState();
  const cutoff = Date.now() - 10 * 60 * 1000;
  const recent = alerts.filter((a) => {
    const ts = new Date(a.created_at).getTime();
    return ts >= cutoff && a.status === 'active';
  });
  if (recent.length === 0) return undefined;
  return recent.map(alertToEvent).filter(Boolean) as HealthEvent[];
}

/**
 * Build assistant overrides scoped to a SPECIFIC wearer (for the
 * caregiver-side assistant). Instead of the logged-in user's stores, the
 * patient / vitals / recent-events come from the wearer being viewed, so
 * a caregiver can ask the assistant about that wearer. `user_role` is
 * pinned to 'caregiver' (changes the backend's framing + skips the
 * wearer-only emergency self-escalation).
 */
export function buildWearerOverrides(args: {
  patientProfile: Pick<Profile, 'age' | 'sex' | 'conditions' | 'medications'> | null;
  latestVitals: { heart_rate: number | null; spo2: number | null; temperature: number | null } | null;
  recentAlerts: WearerAlert[];
}): Partial<ChatInput> {
  // IMPORTANT: every field is returned DEFINED (even when empty). `askAssistant`
  // does `overrides.patient ?? profileToPatient(loggedInProfile)`, so a missing
  // field would fall back to the CAREGIVER's own profile / vitals / alerts —
  // leaking the wrong person's data. Defined-but-empty objects prevent that.
  const p = args.patientProfile;
  const patient: Patient = {
    age: p?.age ?? null,
    sex: p?.sex ?? null,
    conditions: p?.conditions ?? [],
    medications: p?.medications ?? [],
  };

  const lv = args.latestVitals;
  const vitals: Vitals = {
    hr: lv?.heart_rate ?? null,
    spo2: lv?.spo2 ?? null,
    temp: lv?.temperature ?? null,
    rr: null,
  };

  // Caregiver review context: surface alerts from the last 24h (wider
  // than the wearer's 10-min in-the-moment window).
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent_events: HealthEvent[] = args.recentAlerts
    .filter((a) => new Date(a.created_at).getTime() >= cutoff)
    .map(alertToEvent)
    .filter(Boolean) as HealthEvent[];

  return { patient, vitals, recent_events, user_role: 'caregiver' };
}

// ── Emergency escalation ──────────────────────────────────────────────
/**
 * When the assistant returns emergency=true, write a critical alert to
 * Supabase. This pipes into the existing caregiver notification pipeline.
 * Safe to call multiple times — duplicates are OK for now (dedup can be
 * added later).
 */
async function escalateIfEmergency(
  result: ChatResponse | StreamFinal,
  question: string,
): Promise<void> {
  if (!result.emergency) return;

  const profile = useAuthStore.getState().profile;
  if (!profile) return;

  // Only the wearer's own queries create their own alerts. If a caregiver
  // triggers this, we don't have a wearer_id to file against from this side.
  if (profile.role !== 'wearer') return;

  const reason = result.emergency_reason ?? 'assistant_emergency';
  const red_flags = ('red_flags' in result ? result.red_flags : []) ?? [];
  const category = red_flags[0]?.category;

  // Map the red-flag category to the Supabase alert type.
  // Unknown categories fall back to "sos" (generic emergency).
  const alertType: WearerAlert['type'] = ((): WearerAlert['type'] => {
    switch (category) {
      case 'chest_pain':
      case 'stroke':
      case 'breathing':
      case 'unresponsive':
      case 'bleeding':
      case 'allergy':
      case 'self_harm':
        return 'cardiac'; // use 'cardiac' for medical emergencies
      case 'fall':
        return 'fall';
      default:
        return 'sos';
    }
  })();

  try {
    await createAlert({
      wearer_id: profile.id,
      type: alertType,
      severity: 'critical',
      metadata: {
        source: 'assistant',
        reason,
        question,
        red_flags: red_flags.map((f) => f.category),
        recommended_action: result.recommended_action,
      },
    });
  } catch (e) {
    // Don't fail the chat just because the alert write failed.
    console.warn('[assistant] Failed to escalate emergency alert:', e);
  }
}

// ── Public API ────────────────────────────────────────────────────────

/** Health-check the backend. Call on app startup. */
export async function pingAssistant(): Promise<HealthResponse | null> {
  if (!ASSISTANT_ENABLED) return null;
  try {
    return await getClient().health();
  } catch (e) {
    console.warn('[assistant] ping failed:', e);
    return null;
  }
}

/** Ask a question with full app context auto-injected. Blocking. */
export async function askAssistant(
  question: string,
  overrides: Partial<ChatInput> = {},
): Promise<ChatResponse> {
  const profile = useAuthStore.getState().profile;
  const input: ChatInput = {
    question,
    patient: overrides.patient ?? profileToPatient(profile),
    vitals: overrides.vitals ?? vitalsSnapshotToApi(),
    recent_events: overrides.recent_events ?? recentEventsFromStore(),
    activity: overrides.activity,
    user_role: overrides.user_role ?? (profile?.role === 'caregiver' ? 'caregiver' : 'wearer'),
    chat_history: overrides.chat_history,
  };
  const result = await getClient().chat(input);
  await escalateIfEmergency(result, question);
  return result;
}

/** Stream a response. onChunk is called as tokens arrive; onFinal once at the end. */
export async function streamAssistant(
  question: string,
  onChunk: (text: string) => void,
  onFinal: (final: StreamFinal) => void,
  overrides: Partial<ChatInput> = {},
  signal?: AbortSignal,
): Promise<void> {
  const profile = useAuthStore.getState().profile;
  const input: ChatInput = {
    question,
    patient: overrides.patient ?? profileToPatient(profile),
    vitals: overrides.vitals ?? vitalsSnapshotToApi(),
    recent_events: overrides.recent_events ?? recentEventsFromStore(),
    activity: overrides.activity,
    user_role: overrides.user_role ?? (profile?.role === 'caregiver' ? 'caregiver' : 'wearer'),
    chat_history: overrides.chat_history,
  };
  await getClient().chatStream(
    input,
    onChunk,
    async (final) => {
      onFinal(final);
      await escalateIfEmergency(final, question);
    },
    { signal },
  );
}

// ── Feedback (👍 / 👎) ────────────────────────────────────────────────

export interface AssistantFeedback {
  rating: 1 | -1;             // 1 = helpful, -1 = not helpful
  question: string;
  answer: string;
  comment?: string;            // optional free-text
  model?: string;
  severity?: string | null;
  emergency?: boolean;
  emergency_reason?: string | null;
  red_flag_categories?: string[];
  sources?: string[];          // filenames only
  latency_ms?: number | null;
  from_cache?: boolean;
}

/**
 * Submit a thumbs-up / thumbs-down rating on an assistant response.
 * Inserts directly into Supabase (RLS enforces user_id = auth.uid()).
 * Silent failure — feedback is best-effort, never blocks the chat UX.
 */
export async function submitFeedback(fb: AssistantFeedback): Promise<boolean> {
  const profile = useAuthStore.getState().profile;
  if (!profile?.id) return false;
  try {
    const { error } = await supabase.from('assistant_feedback').insert({
      user_id: profile.id,
      rating: fb.rating,
      question: fb.question,
      answer: fb.answer,
      comment: fb.comment ?? null,
      model: fb.model ?? null,
      severity: fb.severity ?? null,
      emergency: fb.emergency ?? false,
      emergency_reason: fb.emergency_reason ?? null,
      red_flag_categories: fb.red_flag_categories ?? [],
      sources: fb.sources ?? [],
      latency_ms: fb.latency_ms ?? null,
      from_cache: fb.from_cache ?? false,
    });
    if (error) {
      console.warn('[assistant] feedback insert failed:', error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[assistant] feedback exception:', e);
    return false;
  }
}

// ── Convenience: expose client types via this barrel ──────────────────
export type { ChatInput, Patient, Vitals, HealthEvent };
