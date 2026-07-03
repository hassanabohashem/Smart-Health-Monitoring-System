/**
 * Cardiac Beat Classifier Adapter
 *
 * Runs the AAMI 4-class beat classifier (N / S / V / F) on a single
 * 128-sample ECG beat window plus its 4-feature RR context.
 *
 * Two adapters provided:
 *   - `CardiacAdapter`   — on-device ONNX inference via `onnxruntime-react-native`.
 *   - `CardiacSimulator` — RR-feature heuristic for demo/testing.
 *
 * Model details:
 *   - Architecture: dual-stream Student CNN (~15.8k params, 63.6 KB ONNX)
 *       Beat stream: 1D CNN over the 128-sample beat window @ 128Hz
 *       RR stream:   tiny MLP over [pre_rr, post_rr, ratio, local_mean_rr_10]
 *       Fusion:      concat → linear(4)
 *   - Inputs:
 *       beat: (1, 128, 1) — beat-aligned, 1 second @ 128Hz, z-score normalised
 *       rr:   (1, 4)      — RR features in seconds
 *   - Output: 4-class softmax — index order matches AAMI:
 *       0=N (normal), 1=S (supraventricular ectopic), 2=V (ventricular ectopic), 3=F (fusion)
 *   - Held-out CinC Lead-I N-recall (beat): 0.96; record N-dominance: 0.999.
 *     DS2 macro-F1 (4-class): 0.59 post-audit re-run.
 *     See `Cardiac/output/results/v2_ens_holdout.json`.
 *
 * Exported model file:
 *   `Cardiac/output/exported/cardiac_beat_classifier.onnx` (seed 202, best val F1 0.484)
 */

import type { AIModelAdapter, ModelPrediction, ModelStatus } from './ai-registry';
import { loadOnnxSession, runOnnxSession, ort } from './onnx-runtime';

const BEAT_WINDOW = 128;     // 1 second @ 128 Hz
const RR_DIM = 4;            // [pre_rr, post_rr, ratio, local_mean_rr_10]

const AAMI_LABELS = ['N', 'S', 'V', 'F'] as const;
export type AAMILabel = (typeof AAMI_LABELS)[number];

const AAMI_FRIENDLY: Record<AAMILabel, string> = {
  N: 'Normal',
  S: 'Supraventricular ectopic',
  V: 'Ventricular ectopic',
  F: 'Fusion',
};

export interface CardiacInput {
  /** 128-sample beat window, z-score normalised, mV scale. */
  beat: number[];
  /**
   * RR features in seconds:
   *   [0] pre_rr          — distance from previous R-peak
   *   [1] post_rr         — distance to next R-peak
   *   [2] ratio           — pre_rr / post_rr
   *   [3] local_mean_rr_10 — mean RR over last 10 beats
   */
  rr: [number, number, number, number];
}

function softmax(logits: number[]): number[] {
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sum);
}

function validateInput(input: CardiacInput): void {
  if (!input.beat || input.beat.length !== BEAT_WINDOW) {
    throw new Error(`Cardiac expects ${BEAT_WINDOW}-sample beat, got ${input.beat?.length ?? 0}`);
  }
  if (!input.rr || input.rr.length !== RR_DIM) {
    throw new Error(`Cardiac expects ${RR_DIM} RR features, got ${input.rr?.length ?? 0}`);
  }
}

/**
 * On-device cardiac adapter — runs the bundled 64 KB ONNX via
 * `onnxruntime-react-native`. The model is so small that a single
 * inference is well under 5ms on a modern phone CPU.
 */
export class CardiacAdapter implements AIModelAdapter {
  id = 'cardiac-beat-aami4';
  name = 'Cardiac Beat Classifier (AAMI 4-class)';
  type = 'cardiac_anomaly' as const;
  version = '2.0.0-holdout';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  async initialize(): Promise<void> {
    try {
      await loadOnnxSession({
        id: this.id,
        asset: require('../../assets/models/cardiac_beat_classifier.onnx'),
      });
      this.status = 'active';
    } catch (err) {
      console.warn('[cardiac.adapter] onnx load failed:', err);
      this.status = 'error';
    }
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    if (this.status !== 'active') {
      throw new Error(`Cardiac adapter not active (status=${this.status})`);
    }
    const sensorData = input as unknown as CardiacInput;
    validateInput(sensorData);

    // beat: (1, 128, 1) float32
    const beatBuf = new Float32Array(BEAT_WINDOW);
    for (let i = 0; i < BEAT_WINDOW; i++) beatBuf[i] = sensorData.beat[i];
    const beatTensor = new ort.Tensor('float32', beatBuf, [1, BEAT_WINDOW, 1]);

    // rr: (1, 4) float32
    const rrBuf = new Float32Array(RR_DIM);
    for (let i = 0; i < RR_DIM; i++) rrBuf[i] = sensorData.rr[i];
    const rrTensor = new ort.Tensor('float32', rrBuf, [1, RR_DIM]);

    const out = await runOnnxSession({
      id: this.id,
      feeds: { beat: beatTensor, rr: rrTensor },
    });
    const logits = Array.from(out.logits.data as Float32Array);
    const probs = softmax(logits);
    let bestIdx = 0;
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[bestIdx]) bestIdx = i;
    }
    const label = AAMI_LABELS[bestIdx];
    return {
      label,
      confidence: probs[bestIdx],
      raw: logits,
      metadata: {
        friendly_label: AAMI_FRIENDLY[label],
        all_probs: probs.reduce<Record<AAMILabel, number>>((acc, p, i) => {
          acc[AAMI_LABELS[i]] = p;
          return acc;
        }, {} as Record<AAMILabel, number>),
        is_anomaly: label !== 'N',
        inference_location: 'on-device',
      },
    };
  }

  async dispose(): Promise<void> {
    this.status = 'unavailable';
  }
}

/**
 * RR-feature heuristic for demo/testing.
 *
 * Uses RR-interval shape to classify (no actual ECG morphology analysis):
 *   - V (premature ventricular): pre_rr much shorter than local mean (compensatory pause likely)
 *   - S (supraventricular ectopic): pre_rr noticeably shorter, but ratio close to 1
 *   - F (fusion): pre_rr/post_rr ratio near 1 with abnormal beat amplitude (proxied via beat std)
 *   - N (normal): everything else
 *
 * Confidence is capped at 0.7 since the heuristic is much coarser than the model.
 */
export class CardiacSimulator implements AIModelAdapter {
  id = 'cardiac-simulator';
  name = 'Cardiac Simulator (Demo)';
  type = 'cardiac_anomaly' as const;
  version = '2.0.0-demo';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  async initialize(): Promise<void> {
    this.status = 'active';
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    const sensorData = input as unknown as CardiacInput;
    validateInput(sensorData);

    const [pre_rr, post_rr, ratio, local_mean] = sensorData.rr;

    // Beat amplitude (std) — used as a rough fusion proxy.
    let mean = 0;
    for (const v of sensorData.beat) mean += v;
    mean /= sensorData.beat.length;
    let varSum = 0;
    for (const v of sensorData.beat) {
      const d = v - mean;
      varSum += d * d;
    }
    const beatStd = Math.sqrt(varSum / sensorData.beat.length);

    let label: AAMILabel = 'N';
    let confidence = 0.55;

    const localMean = local_mean > 0 ? local_mean : 1.0;
    const preRatio = pre_rr / localMean;
    const postRatio = post_rr / localMean;

    if (preRatio < 0.65 && postRatio > 1.15) {
      // Premature beat with compensatory pause → likely ventricular
      label = 'V';
      confidence = 0.65;
    } else if (preRatio < 0.75 && Math.abs(ratio - 1) < 0.4) {
      // Premature but no clear pause → supraventricular
      label = 'S';
      confidence = 0.55;
    } else if (Math.abs(preRatio - 1) < 0.15 && beatStd > 1.5) {
      // Normal RR but unusually large beat → maybe fusion
      label = 'F';
      confidence = 0.45;
    } else {
      label = 'N';
      confidence = 0.6;
    }

    return {
      label,
      confidence,
      metadata: {
        friendly_label: AAMI_FRIENDLY[label],
        is_anomaly: label !== 'N',
        pre_rr_ratio: preRatio,
        post_rr_ratio: postRatio,
        beat_std: beatStd,
        inference_location: 'on-device-simulator',
      },
    };
  }

  async dispose(): Promise<void> {
    this.status = 'unavailable';
  }
}
