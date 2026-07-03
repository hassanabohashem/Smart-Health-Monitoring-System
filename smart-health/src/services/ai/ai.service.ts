/**
 * AI Service
 *
 * Manages AI model lifecycle and integrates with the alert system.
 * Handles the full pipeline: sensor data → inference → alert creation.
 *
 * Registers three model categories at boot (fall_detection,
 * activity_recognition, cardiac_anomaly). The clinical assistant lives
 * in a separate services/assistant/ namespace because it has a
 * substantially different API surface — this service only manages the
 * on-device ONNX model adapters.
 */

import { aiRegistry } from './ai-registry';
import {
  FallDetectionAdapter,
  FallDetectionSimulator,
  type FallDetectionInput,
} from './fall-detection.adapter';
import {
  HARAdapter,
  HARSimulator,
  type HARInput,
  type HARLabel,
} from './har.adapter';
import {
  CardiacAdapter,
  CardiacSimulator,
  type CardiacInput,
  type AAMILabel,
} from './cardiac.adapter';
import { createAlert } from '../alert.service';
import { notifyCaregivers } from '../notification.service';

let isInitialized = false;
// Dedupes concurrent / re-entrant initializeAI() calls (React StrictMode double-
// invoke, Fast-Refresh remounts): a second call joins the in-flight promise
// instead of registering a duplicate, racing set of adapters.
let initPromise: Promise<void> | null = null;
let fallDetectionEnabled = true;
let harEnabled = true;
let cardiacEnabled = true;
let onFallDetectedCallback: ((confidence: number) => void) | null = null;
let onActivityDetectedCallback: ((label: HARLabel, confidence: number) => void) | null = null;
let onCardiacAnomalyCallback: ((label: AAMILabel, confidence: number) => void) | null = null;

/**
 * Initialize the AI service and register all models.
 *
 * Default behaviour: register the on-device ONNX adapters for every
 * model — they bundle the .onnx weights into the app at build time and
 * run inference locally via `onnxruntime-react-native`. If a model
 * fails to load (status='error' after `initialize()`), we fall back to
 * the heuristic simulator for that slot so the rest of the app still
 * works.
 *
 * The total bundled-model footprint is ~6.6 MB (cardiac 64 KB +
 * fall 1.86 MB + HAR 4.7 MB), which is small enough to ship inside the
 * APK without OTA download.
 */
export async function initializeAI(): Promise<void> {
  if (isInitialized) return;
  // A previous call is still registering — join it rather than starting a
  // second, parallel registration (which races the status checks and can
  // spuriously fall a freshly-loaded adapter back to its simulator).
  if (initPromise) return initPromise;

  // Try the on-device ONNX adapter for each model; if it errors out
  // during `initialize()`, register the simulator as a fallback so the
  // model slot is still functional.
  initPromise = (async () => {
    await registerWithFallback(
      () => new FallDetectionAdapter(),
      () => new FallDetectionSimulator()
    );
    await registerWithFallback(
      () => new HARAdapter(),
      () => new HARSimulator()
    );
    await registerWithFallback(
      () => new CardiacAdapter(),
      () => new CardiacSimulator()
    );
    isInitialized = true;
    if (__DEV__) {
      const active = (t: import('./ai-registry').ModelType) => pickActiveModel(t)?.id ?? 'none';
      console.log(
        `[ai.service] init complete — fall=${active('fall_detection')} har=${active('activity_recognition')} cardiac=${active('cardiac_anomaly')}`
      );
    }
  })();

  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

/**
 * Helper: return the first ACTIVE adapter for a given model type, or
 * null if none. Used by the inference entry points so that a registered-
 * but-failed primary doesn't block the fallback simulator.
 */
function pickActiveModel(
  type: import('./ai-registry').ModelType
): import('./ai-registry').AIModelAdapter | null {
  const models = aiRegistry.getByType(type);
  for (const m of models) {
    if (m.status === 'active') return m;
  }
  return null;
}

/**
 * Helper: try the primary adapter; if its `initialize()` reports `error`
 * (typically because ORT-RN can't load the bundled .onnx — happens in
 * Expo Go since ORT-RN is a native module), unregister and swap in the
 * fallback simulator.
 */
async function registerWithFallback(
  primary: () => import('./ai-registry').AIModelAdapter,
  fallback: () => import('./ai-registry').AIModelAdapter
): Promise<void> {
  const p = primary();
  aiRegistry.register(p);
  await p.initialize();
  if (p.status === 'error' || p.status === 'unavailable') {
    console.warn(`[ai.service] primary adapter "${p.id}" failed to load; falling back to simulator`);
    // Swap registration: remove primary, register fallback.
    // ai-registry has no `unregister` so we register a fallback under
    // the same logical type — `getByType` returns them in insertion
    // order, so the simulator will appear after the primary; the
    // primary will be ignored because its status is non-active.
    const fb = fallback();
    aiRegistry.register(fb);
    await fb.initialize();
  }
}

/**
 * Set a callback for when a fall is detected.
 * Used by the UI to show the cancel countdown.
 */
export function onFallDetected(callback: (confidence: number) => void): void {
  onFallDetectedCallback = callback;
}

/**
 * Subscribe to activity-recognition results (every window classified).
 */
export function onActivityDetected(
  callback: (label: HARLabel, confidence: number) => void
): void {
  onActivityDetectedCallback = callback;
}

/**
 * Subscribe to cardiac-anomaly notifications (only fires for non-N labels).
 */
export function onCardiacAnomaly(
  callback: (label: AAMILabel, confidence: number) => void
): void {
  onCardiacAnomalyCallback = callback;
}

/** Enable/disable fall detection. */
export function setFallDetectionEnabled(enabled: boolean): void {
  fallDetectionEnabled = enabled;
}
/** Enable/disable HAR. */
export function setHAREnabled(enabled: boolean): void {
  harEnabled = enabled;
}
/** Enable/disable cardiac monitoring. */
export function setCardiacEnabled(enabled: boolean): void {
  cardiacEnabled = enabled;
}

/**
 * Process a window of IMU+barometer sensor data through fall detection.
 * Triggers the alert pipeline when a fall is flagged.
 */
export async function processSensorWindow(
  wearerId: string,
  wearerName: string,
  input: FallDetectionInput
): Promise<{ isFall: boolean; confidence: number } | null> {
  if (!fallDetectionEnabled) return null;

  const model = pickActiveModel('fall_detection');
  if (!model) return null;

  try {
    const prediction = await model.predict(input as unknown as Record<string, unknown>);

    if (prediction.label === 'fall') {
      if (onFallDetectedCallback) {
        onFallDetectedCallback(prediction.confidence);
      }
      return { isFall: true, confidence: prediction.confidence };
    }
    return { isFall: false, confidence: prediction.confidence };
  } catch (err) {
    console.warn('[ai.service] fall-detection failure:', err);
    return null;
  }
}

/**
 * Process a window of IMU sensor data through HAR.
 * Returns the most likely activity label or null when disabled.
 */
export async function processActivityWindow(
  input: HARInput
): Promise<{ label: HARLabel; confidence: number } | null> {
  if (!harEnabled) return null;

  const model = pickActiveModel('activity_recognition');
  if (!model) return null;

  try {
    const prediction = await model.predict(input as unknown as Record<string, unknown>);
    const label = prediction.label as HARLabel;
    // Dual-head WISDM model: skip junk / uncertain windows (is_real < tau) so we
    // never surface a bogus activity. `isConfident` defaults true when absent
    // (e.g. the simulator), preserving prior behaviour.
    const confident = (prediction.metadata as { isConfident?: boolean } | undefined)?.isConfident !== false;
    if (confident && onActivityDetectedCallback) {
      onActivityDetectedCallback(label, prediction.confidence);
    }
    return confident ? { label, confidence: prediction.confidence } : null;
  } catch (err) {
    console.warn('[ai.service] HAR failure:', err);
    return null;
  }
}

/**
 * Process a single ECG beat through the cardiac classifier.
 * If the prediction is non-N (S/V/F) above a confidence threshold and a
 * wearerId is provided, a `cardiac` alert is filed automatically.
 */
export async function processCardiacBeat(
  input: CardiacInput,
  options: {
    wearerId?: string;
    wearerName?: string;
    /** Confidence floor for filing an automatic alert (default 0.7). */
    alertThreshold?: number;
  } = {}
): Promise<{ label: AAMILabel; confidence: number; isAnomaly: boolean } | null> {
  if (!cardiacEnabled) return null;

  const model = pickActiveModel('cardiac_anomaly');
  if (!model) return null;

  try {
    const prediction = await model.predict(input as unknown as Record<string, unknown>);
    const label = prediction.label as AAMILabel;
    const isAnomaly = label !== 'N';

    if (isAnomaly && onCardiacAnomalyCallback) {
      onCardiacAnomalyCallback(label, prediction.confidence);
    }

    const alertThreshold = options.alertThreshold ?? 0.7;
    if (
      isAnomaly &&
      prediction.confidence >= alertThreshold &&
      options.wearerId &&
      options.wearerName
    ) {
      try {
        const alert = await createAlert({
          wearer_id: options.wearerId,
          type: 'cardiac',
          severity: label === 'V' ? 'critical' : 'high',
          confidence: prediction.confidence,
          metadata: {
            triggered_by: 'ai_cardiac_classification',
            model: 'student-cnn-aami4',
            aami_label: label,
            friendly_label:
              (prediction.metadata?.friendly_label as string) ?? label,
          },
        });
        await notifyCaregivers(
          options.wearerId,
          options.wearerName,
          'cardiac',
          alert.id
        );
      } catch (e) {
        console.warn('[ai.service] cardiac alert dispatch failed:', e);
      }
    }

    return { label, confidence: prediction.confidence, isAnomaly };
  } catch (err) {
    console.warn('[ai.service] cardiac inference failure:', err);
    return null;
  }
}

/**
 * Create a fall alert after the cancel countdown expires.
 * Called by the UI when the user doesn't cancel within the countdown.
 */
export async function confirmFallAlert(
  wearerId: string,
  wearerName: string,
  confidence: number,
  latitude?: number,
  longitude?: number
): Promise<void> {
  try {
    const alert = await createAlert({
      wearer_id: wearerId,
      type: 'fall',
      severity: 'critical',
      confidence,
      metadata: {
        triggered_by: 'ai_fall_detection',
        model: 'fusionnet-wrist',
        ...(latitude && { latitude }),
        ...(longitude && { longitude }),
      },
    });

    await notifyCaregivers(wearerId, wearerName, 'fall', alert.id);
  } catch (err) {
    console.warn('[ai.service] fall alert creation failed:', err);
  }
}

/**
 * Get the status of all registered AI models.
 */
export function getModelStatus(): Array<{
  id: string;
  name: string;
  type: string;
  status: string;
  runtime: string;
  version: string;
}> {
  return aiRegistry.getAll().map((m) => ({
    id: m.id,
    name: m.name,
    type: m.type,
    status: m.status,
    runtime: m.runtime,
    version: m.version,
  }));
}

/**
 * Clean up AI service.
 */
export async function disposeAI(): Promise<void> {
  await aiRegistry.disposeAll();
  isInitialized = false;
  initPromise = null;
  onFallDetectedCallback = null;
  onActivityDetectedCallback = null;
  onCardiacAnomalyCallback = null;
}
