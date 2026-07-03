/**
 * HAR (Human Activity Recognition) Adapter — WISDM dual-head model.
 *
 * Runs the WISDM-trained dual-head 1D-CNN (converted TFLite → ONNX). Two
 * adapters: `HARAdapter` (on-device ONNX) and `HARSimulator` (heuristic demo).
 *
 * Model contract (see HAR/android/har_model_meta.json):
 *   - Input  (1, 200, 6) = 10 s @ 20 Hz, channels [ax,ay,az,gx,gy,gz] in
 *     m/s^2 (incl. gravity) + rad/s. **Raw** physical units — per-channel
 *     standardization AND derived magnitude channels are baked into the graph,
 *     so the JS side does zero normalization.
 *   - Output `probs`   (1, 4) softmax over [walking, jogging, stairs, stationary].
 *   - Output `is_real` (1, 1) sigmoid — P(real tracked activity). Reject as
 *     junk / fake-movement when < IS_REAL_THRESHOLD.
 *   - Rule: is_real < tau → not confident (UI shows "—"); else argmax(probs).
 *   - Subject-independent metrics: 94.4% per-window, 95.9% segment-voted,
 *     89% junk rejection. See HAR/RESULTS.md.
 *
 * The ONNX tensor names are tf2onnx-generated (`serving_default_imu_window:0`,
 * `StatefulPartitionedCall_1:{0,1}`); we bind to the session's single input and
 * disambiguate the two outputs by length (4 = probs, 1 = is_real), so a
 * re-export with different names won't break this adapter.
 */

import type { AIModelAdapter, ModelPrediction, ModelStatus } from './ai-registry';
import { loadOnnxSession, runOnnxSession, ort } from './onnx-runtime';

const WINDOW_SAMPLES = 200;      // 10 s @ 20 Hz
const NUM_CHANNELS = 6;          // ax,ay,az,gx,gy,gz (raw)
// meta.json's tau=0.8 was calibrated on the LG G Watch; on the Galaxy Watch 5
// is_real for real walking spans ~0.4 (slow) … ~0.98 (brisk), while dead-still
// sits ~0.05 and random noise ~0.025 (verified on-device 2026-06-09). 0.8 would
// reject anything but brisk walking, so we drop the gate to 0.4 — still ~8× over
// noise, but it now passes normal/slow-pace walking (matters for elderly wearers).
const IS_REAL_THRESHOLD = 0.4;
const SMOOTHING = 3;             // majority vote over the last N confident windows

// Index order MUST match the model's `probs` head (class_names in meta.json).
const HAR_LABELS = ['WALKING', 'JOGGING', 'STAIRS', 'STATIONARY'] as const;
export type HARLabel = (typeof HAR_LABELS)[number];

// --- Galaxy Watch 5 transfer adjustments (verified on-device 2026-06-09) ---
// WISDM is wrist-trained but on a different watch (LG G Watch). On the Galaxy
// Watch 5 it reliably separates rest / locomotion / jogging but CANNOT tell flat
// walking from stairs — it leans STAIRS ~60/40 for flat walking. So we fold
// STAIRS into WALKING (sum their probs) and report over the merged set.
const MERGED_LABELS = ['WALKING', 'JOGGING', 'STATIONARY'] as const;
// Trust a confident STATIONARY verdict even when is_real flags it OOD: a dead-
// still wrist is out-of-distribution for WISDM's sit/stand "stationary" (which
// always had natural sway), so is_real collapses to ~0.05 while probs[stationary]
// stays ~1.0 — the classifier is right, the rejector is paranoid. Only STATIONARY
// gets this rescue; motion classes stay is_real-gated so hand-gestures (typing,
// clapping) aren't misread as walking/jogging.
const STILL_OVERRIDE = 0.9;

export interface HARInput {
  /** Raw IMU window: 200 samples × 6 channels [ax,ay,az,gx,gy,gz] (m/s^2 + rad/s). */
  samples: number[][]; // shape (200, 6)
}

function validateInput(input: HARInput): void {
  if (!input.samples || input.samples.length !== WINDOW_SAMPLES) {
    throw new Error(`HAR expects ${WINDOW_SAMPLES} samples, got ${input.samples?.length ?? 0}`);
  }
  if (input.samples[0]?.length !== NUM_CHANNELS) {
    throw new Error(`HAR expects ${NUM_CHANNELS} channels/sample, got ${input.samples[0]?.length ?? 0}`);
  }
}

/** Majority label over a small history; ties resolve to the most recent. */
function vote(history: HARLabel[]): HARLabel {
  const counts = new Map<HARLabel, number>();
  for (const l of history) counts.set(l, (counts.get(l) ?? 0) + 1);
  let best = history[history.length - 1];
  let bestN = 0;
  for (const [l, n] of counts) if (n > bestN) { best = l; bestN = n; }
  return best;
}

/**
 * On-device HAR adapter — runs the bundled WISDM ONNX via
 * `onnxruntime-react-native`. Single raw input, two heads.
 */
export class HARAdapter implements AIModelAdapter {
  id = 'har-wisdm-dualhead';
  name = 'HAR WISDM dual-head';
  type = 'activity_recognition' as const;
  version = '2.0.0-wisdm';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  /** Bound to the model's actual single input name in initialize(). */
  private inputName = 'serving_default_imu_window:0';
  /** Last N confident labels, for flicker-smoothing the reported activity. */
  private recent: HARLabel[] = [];

  async initialize(): Promise<void> {
    try {
      const session = await loadOnnxSession({
        id: this.id,
        asset: require('../../assets/models/har_model.onnx'),
      });
      const inputs = session.inputNames ?? [];
      if (inputs.length < 1) {
        throw new Error(`HAR ONNX has no inputs; actual: ${JSON.stringify(inputs)}`);
      }
      this.inputName = inputs[0];
      this.recent = [];
      this.status = 'active';
    } catch (err) {
      console.warn('[har.adapter] onnx load failed:', err);
      this.status = 'error';
    }
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    if (this.status !== 'active') {
      throw new Error(`HAR adapter not active (status=${this.status})`);
    }
    const sensorData = input as unknown as HARInput;
    validateInput(sensorData);

    // (1, 200, 6) float32 — raw physical units; the model normalizes internally.
    const buf = new Float32Array(WINDOW_SAMPLES * NUM_CHANNELS);
    for (let t = 0; t < WINDOW_SAMPLES; t++) {
      const row = sensorData.samples[t];
      for (let c = 0; c < NUM_CHANNELS; c++) buf[t * NUM_CHANNELS + c] = row[c] ?? 0;
    }
    const tensor = new ort.Tensor('float32', buf, [1, WINDOW_SAMPLES, NUM_CHANNELS]);

    const out = await runOnnxSession({ id: this.id, feeds: { [this.inputName]: tensor } });

    // Disambiguate the two heads by length: 4 = probs (softmax), 1 = is_real.
    let probs: number[] | null = null;
    let isReal = 1;
    for (const key of Object.keys(out)) {
      const data = Array.from(out[key].data as Float32Array);
      if (data.length === HAR_LABELS.length) probs = data;
      else if (data.length === 1) isReal = data[0];
    }
    if (!probs) throw new Error('HAR ONNX: probs output (length 4) not found');

    // Fold STAIRS into WALKING, then argmax over the merged {WALKING,JOGGING,STATIONARY}.
    const merged = [probs[0] + probs[2], probs[1], probs[3]];
    let mergedIdx = 0;
    for (let i = 1; i < merged.length; i++) if (merged[i] > merged[mergedIdx]) mergedIdx = i;
    const rawLabel = MERGED_LABELS[mergedIdx];
    // is_real gates motion; a confidently-stationary window is trusted regardless (STILL_OVERRIDE).
    const isConfident =
      isReal >= IS_REAL_THRESHOLD || (rawLabel === 'STATIONARY' && merged[mergedIdx] >= STILL_OVERRIDE);

    // Smooth only confident windows (junk windows don't perturb the history).
    let label: HARLabel = rawLabel;
    if (isConfident) {
      this.recent.push(rawLabel);
      if (this.recent.length > SMOOTHING) this.recent.shift();
      label = vote(this.recent);
    }

    return {
      label,
      confidence: merged[mergedIdx],
      raw: probs,
      metadata: {
        is_real: isReal,
        isConfident,
        all_probs: probs.reduce<Record<string, number>>((acc, p, i) => {
          acc[HAR_LABELS[i]] = p;
          return acc;
        }, {}),
        inference_location: 'on-device',
      },
    };
  }

  async dispose(): Promise<void> {
    this.recent = [];
    this.status = 'unavailable';
  }
}

/**
 * Heuristic on-device HAR for demo/testing (no ONNX). Maps accelerometer
 * magnitude variance to the WISDM taxonomy: high → jogging, moderate →
 * walking, low → stationary. Always "confident" (it's a demo).
 */
export class HARSimulator implements AIModelAdapter {
  id = 'har-simulator';
  name = 'HAR Simulator (Demo)';
  type = 'activity_recognition' as const;
  version = '2.0.0-demo';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  async initialize(): Promise<void> {
    this.status = 'active';
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    const sensorData = input as unknown as HARInput;
    validateInput(sensorData);

    let sumMag = 0, sumMagSq = 0, n = 0;
    for (const s of sensorData.samples) {
      const m = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
      sumMag += m; sumMagSq += m * m; n++;
    }
    const meanMag = sumMag / n;
    const varMag = sumMagSq / n - meanMag * meanMag;

    let label: HARLabel;
    let confidence: number;
    if (varMag > 12) { label = 'JOGGING'; confidence = 0.6; }
    else if (varMag > 2) { label = 'WALKING'; confidence = 0.62; }
    else { label = 'STATIONARY'; confidence = 0.7; }

    return {
      label,
      confidence,
      metadata: {
        is_real: 1,
        isConfident: true,
        var_mag: varMag,
        inference_location: 'on-device-simulator',
      },
    };
  }

  async dispose(): Promise<void> {
    this.status = 'unavailable';
  }
}
