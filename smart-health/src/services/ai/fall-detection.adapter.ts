/**
 * FusionNet Fall Detection Adapter
 *
 * Runs the BarometerFusionNet model for fall detection on-device via
 * `onnxruntime-react-native`.
 *
 * Model details:
 * - Architecture: Dual-Stream 1D-CNN (IMU stream + Barometer stream), ~466k params
 * - Input: imu_input (1, 6, 200) — 6-axis IMU × 200 timesteps at 100Hz = 2 seconds
 *          baro_input (1, 1, 200) — barometer altitude × 200 timesteps
 * - Output: fall_prediction (1, 2) — [no_fall_logit, fall_logit]
 * - Placement: Wrist (for smartwatch)
 * - Honest 9-fold LOSO macro-AUC: 0.971 (recall 83%, F1 86%, FPR 3.5%)
 *   See `fall_detection_edge/output/results/wrist_loso_honest.json`.
 */

import type { AIModelAdapter, ModelPrediction, ModelStatus } from './ai-registry';
import { loadOnnxSession, runOnnxSession, ort } from './onnx-runtime';

const FALL_THRESHOLD = 0.7; // Confidence threshold to trigger alert
const WINDOW_SIZE = 200;    // 200 timesteps = 4 seconds at 50Hz
const IMU_CHANNELS = 6;     // accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z

export interface FallDetectionInput {
  /** 6-axis IMU data: array of 200 readings, each with 6 values [ax, ay, az, gx, gy, gz] */
  imu: number[][];
  /** Barometer data: array of 200 altitude readings */
  barometer: number[];
}

/**
 * Apply softmax to convert logits to probabilities.
 */
function softmax(logits: number[]): number[] {
  const maxLogit = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - maxLogit));
  const sumExps = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / sumExps);
}

/**
 * On-device wrist FusionNet — runs the bundled 1.86 MB ONNX via
 * `onnxruntime-react-native`. Trained with subject-disjoint splits
 * (see `fall_detection_edge/scripts/train_wrist_honest.py`); honest
 * 9-fold LOSO macro-AUC = 0.971.
 */
export class FallDetectionAdapter implements AIModelAdapter {
  id = 'fusionnet-wrist';
  name = 'FusionNet Fall Detection (Wrist)';
  type = 'fall_detection' as const;
  version = '2.0.0-honest';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  async initialize(): Promise<void> {
    try {
      await loadOnnxSession({
        id: this.id,
        asset: require('../../assets/models/fusion_net_wrist.onnx'),
      });
      this.status = 'active';
    } catch (err) {
      console.warn('[fall-detection.adapter] onnx load failed:', err);
      this.status = 'error';
    }
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    if (this.status !== 'active') {
      throw new Error(`Fall detection adapter not active (status=${this.status})`);
    }
    const sensorData = input as unknown as FallDetectionInput;

    if (!sensorData.imu || sensorData.imu.length !== WINDOW_SIZE) {
      throw new Error(`Expected ${WINDOW_SIZE} IMU readings, got ${sensorData.imu?.length ?? 0}`);
    }
    if (!sensorData.barometer || sensorData.barometer.length !== WINDOW_SIZE) {
      throw new Error(`Expected ${WINDOW_SIZE} barometer readings, got ${sensorData.barometer?.length ?? 0}`);
    }

    // imu_input: (1, 6, 200) float32 — channel-major
    const imuBuf = new Float32Array(IMU_CHANNELS * WINDOW_SIZE);
    for (let ch = 0; ch < IMU_CHANNELS; ch++) {
      for (let t = 0; t < WINDOW_SIZE; t++) {
        imuBuf[ch * WINDOW_SIZE + t] = sensorData.imu[t]?.[ch] ?? 0;
      }
    }
    const imuTensor = new ort.Tensor('float32', imuBuf, [1, IMU_CHANNELS, WINDOW_SIZE]);

    // baro_input: (1, 1, 200) float32
    const baroBuf = new Float32Array(WINDOW_SIZE);
    for (let t = 0; t < WINDOW_SIZE; t++) baroBuf[t] = sensorData.barometer[t];
    const baroTensor = new ort.Tensor('float32', baroBuf, [1, 1, WINDOW_SIZE]);

    const out = await runOnnxSession({
      id: this.id,
      feeds: { imu_input: imuTensor, baro_input: baroTensor },
    });
    const firstOutKey = Object.keys(out)[0];
    const logits = Array.from(out[firstOutKey].data as Float32Array);
    const probs = softmax(logits);
    const fallProbability = probs[1];

    return {
      label: fallProbability >= FALL_THRESHOLD ? 'fall' : 'no_fall',
      confidence: fallProbability,
      raw: logits,
      metadata: {
        no_fall_prob: probs[0],
        fall_prob: probs[1],
        threshold: FALL_THRESHOLD,
        inference_location: 'on-device',
      },
    };
  }

  async dispose(): Promise<void> {
    this.status = 'unavailable';
  }
}

/**
 * Simulated fall detection for demo/testing.
 * Uses heuristic-based detection on accelerometer magnitude.
 */
export class FallDetectionSimulator implements AIModelAdapter {
  id = 'fusionnet-simulator';
  name = 'FusionNet Simulator (Demo)';
  type = 'fall_detection' as const;
  version = '1.0.0-demo';
  runtime = 'on-device' as const;
  status: ModelStatus = 'unavailable';

  async initialize(): Promise<void> {
    this.status = 'active';
  }

  async predict(input: Record<string, unknown>): Promise<ModelPrediction> {
    const sensorData = input as unknown as FallDetectionInput;

    // Simple heuristic: check for sudden spike in accelerometer magnitude
    let maxMagnitude = 0;
    let minMagnitudeAfterSpike = Infinity;
    let spikeIndex = -1;

    for (let t = 0; t < sensorData.imu.length; t++) {
      const [ax, ay, az] = sensorData.imu[t];
      const magnitude = Math.sqrt(ax * ax + ay * ay + az * az);

      if (magnitude > maxMagnitude) {
        maxMagnitude = magnitude;
        spikeIndex = t;
      }

      // Check for freefall after spike (low acceleration)
      if (spikeIndex >= 0 && t > spikeIndex) {
        minMagnitudeAfterSpike = Math.min(minMagnitudeAfterSpike, magnitude);
      }
    }

    // Fall heuristic: high impact (>3g) followed by low movement (<0.5g)
    const isLikelyFall = maxMagnitude > 30 && minMagnitudeAfterSpike < 5;
    const confidence = isLikelyFall ? 0.85 : 0.1;

    return {
      label: isLikelyFall ? 'fall' : 'no_fall',
      confidence,
      metadata: {
        max_magnitude: maxMagnitude,
        min_after_spike: minMagnitudeAfterSpike,
        inference_location: 'on-device-simulator',
      },
    };
  }

  async dispose(): Promise<void> {
    this.status = 'unavailable';
  }
}
