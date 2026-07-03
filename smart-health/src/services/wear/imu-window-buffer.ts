/**
 * IMU window buffer for fall-detection and HAR inference fed from the
 * Galaxy Watch 5.
 *
 * The watch streams accelerometer and gyroscope at ~50 Hz (SENSOR_DELAY_GAME)
 * and barometer at whatever rate the hardware allows (typically ≤5 Hz).
 * It bundles ~one second's worth into a single packet, sent on path
 * /sensor_data once per second.
 *
 * The two consumer models want different rates / window sizes:
 *
 *   - HAR (WISDM dual-head): 200 samples × 6 channels (accel XYZ + gyro
 *     XYZ) at 20 Hz = 10 sec window. We resample the watch's ~50 Hz stream
 *     down to 20 Hz (raw physical units; the model normalizes internally).
 *
 *   - Fall (FusionNet wrist): 200 samples × 6 IMU channels + 200 samples
 *     × 1 barometer channel, both at 100 Hz = 2 sec window. The watch
 *     gives us 50 Hz IMU and ≤5 Hz baro, so we linearly upsample both
 *     to 100 Hz before feeding the model.
 *
 * Design:
 *   - Keep a rolling buffer (~6 sec) of every IMU sample we've seen.
 *   - On each incoming packet, append samples and ask the two emitters
 *     whether they can produce a window. Both fire at most once per
 *     incoming packet (≈1 Hz inference cadence), which is well within
 *     the latency budget for both models (~5-20 ms each on phone CPU).
 *
 * Threading: not thread-safe in the Kotlin sense, but the JS thread is
 * single-threaded so all calls land on the same execution context.
 */

import type {
  ImuHighRateWindow,
  ImuHighRatePressureArrays,
} from './types';

/** One IMU sample: 6-channel accel+gyro + monotonic timestamp ns. */
interface ImuSample {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
  tsNs: number;
}

interface PressureSample {
  value: number;
  tsNs: number;
}

// HAR (WISDM dual-head): 10 s window at 20 Hz = 200 samples. The watch streams
// ~50 Hz, so we resample the last ~10 s of native IMU (≈500 samples) → 200.
const HAR_TARGET_SAMPLES = 200;       // model input length (20 Hz × 10 s)
const HAR_NATIVE_WINDOW = 500;        // ~10 s of native 50 Hz IMU to resample from
const FALL_IMU_AT_NATIVE_RATE = 100;  // 50 Hz × 2 sec
const FALL_TARGET_SAMPLES = 200;      // 100 Hz × 2 sec
const FALL_TARGET_BARO_SAMPLES = 200; // same, barometer at upsampled rate

/** Cap on retained samples — ~11 sec at 50 Hz (holds HAR's 10 s window). */
const IMU_RING_CAPACITY = 560;
/** Cap on retained barometer samples — generous since rate is low. */
const BARO_RING_CAPACITY = 64;

export interface HarWindowReady {
  /** Channel order: [ax, ay, az, gx, gy, gz]. Length = HAR_TARGET_SAMPLES (200). */
  samples: number[][];
}

export interface FallWindowReady {
  /** Upsampled-to-100Hz IMU, length 200, 6 channels each. */
  imu: number[][];
  /** Upsampled-to-100Hz barometer, length 200. */
  barometer: number[];
}

type HarSubscriber = (w: HarWindowReady) => void;
type FallSubscriber = (w: FallWindowReady) => void;

class ImuWindowBuffer {
  private imu: ImuSample[] = [];
  private baro: PressureSample[] = [];
  private harSubs = new Set<HarSubscriber>();
  private fallSubs = new Set<FallSubscriber>();

  /**
   * Append samples from one packet. Accel and gyro counts may differ
   * (different sensor rates) — we pair them by index up to the shorter
   * stream and discard the tail; the resulting timeline is close enough
   * to 50 Hz for both downstream models.
   */
  appendPacket(window: ImuHighRateWindow): void {
    // Defensive: in real watch traffic, sub-objects (accel/gyro/pressure)
    // or their per-axis arrays can be missing for the first few packets
    // after start (sensor callback hasn't fired yet, the field is null,
    // etc.). The current watch firmware also omits `tsNs` entirely on
    // some packets, so we don't require it — we synthesize monotonic
    // timestamps phone-side at the nominal 50 Hz rate when it's absent.
    const accelX = window.accel?.x ?? [];
    const accelY = window.accel?.y ?? [];
    const accelZ = window.accel?.z ?? [];
    const accelTs = window.accel?.tsNs ?? [];
    const gyroX = window.gyro?.x ?? [];
    const gyroY = window.gyro?.y ?? [];
    const gyroZ = window.gyro?.z ?? [];
    const accelLen = Math.min(accelX.length, accelY.length, accelZ.length);
    const gyroLen = Math.min(gyroX.length, gyroY.length, gyroZ.length);
    const n = Math.min(accelLen, gyroLen);
    // Step between synthetic timestamps when watch didn't supply them.
    const NS_PER_SAMPLE_AT_50HZ = 20_000_000;
    const synthesizeTs = accelTs.length < n;
    const tsBase = synthesizeTs
      ? (this.imu.length > 0 ? this.imu[this.imu.length - 1].tsNs : Date.now() * 1_000_000)
      : 0;
    for (let i = 0; i < n; i++) {
      this.imu.push({
        ax: accelX[i] ?? 0,
        ay: accelY[i] ?? 0,
        az: accelZ[i] ?? 0,
        gx: gyroX[i] ?? 0,
        gy: gyroY[i] ?? 0,
        gz: gyroZ[i] ?? 0,
        tsNs: synthesizeTs ? tsBase + (i + 1) * NS_PER_SAMPLE_AT_50HZ : (accelTs[i] ?? 0),
      });
    }
    if (this.imu.length > IMU_RING_CAPACITY) {
      this.imu.splice(0, this.imu.length - IMU_RING_CAPACITY);
    }

    const pressureValues = window.pressure?.values ?? [];
    const pressureTs = window.pressure?.tsNs ?? [];
    const pressureLen = pressureValues.length;
    const synthesizePressureTs = pressureTs.length < pressureLen;
    // Spread pressure samples evenly across the last 1 sec of IMU.
    const pBase = this.imu.length > 0
      ? this.imu[this.imu.length - 1].tsNs - 1_000_000_000
      : Date.now() * 1_000_000 - 1_000_000_000;
    for (let i = 0; i < pressureLen; i++) {
      this.baro.push({
        value: pressureValues[i] ?? 0,
        tsNs: synthesizePressureTs
          ? pBase + Math.round((1_000_000_000 * (i + 1)) / pressureLen)
          : (pressureTs[i] ?? 0),
      });
    }
    if (this.baro.length > BARO_RING_CAPACITY) {
      this.baro.splice(0, this.baro.length - BARO_RING_CAPACITY);
    }

    this.maybeEmitHar();
    this.maybeEmitFall();
  }

  /** Subscribe to ready HAR windows. Returns unsubscribe fn. */
  onHarWindow(cb: HarSubscriber): () => void {
    this.harSubs.add(cb);
    return () => this.harSubs.delete(cb);
  }

  /** Subscribe to ready fall windows. Returns unsubscribe fn. */
  onFallWindow(cb: FallSubscriber): () => void {
    this.fallSubs.add(cb);
    return () => this.fallSubs.delete(cb);
  }

  reset(): void {
    this.imu = [];
    this.baro = [];
  }

  private maybeEmitHar(): void {
    if (this.imu.length < HAR_NATIVE_WINDOW) return;
    if (this.harSubs.size === 0) return;
    // Take the last ~10 s of native (~50 Hz) IMU and resample to 200 samples
    // (20 Hz) — the rate the WISDM model was trained at. Raw physical units;
    // the model normalizes internally.
    const start = this.imu.length - HAR_NATIVE_WINDOW;
    const native: number[][] = new Array(HAR_NATIVE_WINDOW);
    for (let i = 0; i < HAR_NATIVE_WINDOW; i++) {
      const s = this.imu[start + i];
      native[i] = [s.ax, s.ay, s.az, s.gx, s.gy, s.gz];
    }
    const samples = linearUpsamplePerChannel(native, HAR_TARGET_SAMPLES, 6);
    const payload: HarWindowReady = { samples };
    for (const sub of this.harSubs) sub(payload);
  }

  private maybeEmitFall(): void {
    if (this.imu.length < FALL_IMU_AT_NATIVE_RATE) return;
    if (this.baro.length < 2) return; // need at least 2 baro samples for interp
    if (this.fallSubs.size === 0) return;

    // Take the most recent 100 IMU samples (≈2 sec @ 50 Hz) and upsample
    // each channel linearly to 200 samples (100 Hz). The model was trained
    // on 100 Hz wrist data, so feeding 50 Hz raw would compress 2 sec of
    // dynamics into "1 sec" from the model's perspective.
    const start = this.imu.length - FALL_IMU_AT_NATIVE_RATE;
    const native: number[][] = new Array(FALL_IMU_AT_NATIVE_RATE);
    for (let i = 0; i < FALL_IMU_AT_NATIVE_RATE; i++) {
      const s = this.imu[start + i];
      native[i] = [s.ax, s.ay, s.az, s.gx, s.gy, s.gz];
    }
    const imu = linearUpsamplePerChannel(native, FALL_TARGET_SAMPLES, 6);

    // Barometer: take samples since (now - 2 sec) and upsample to 200
    // points across that window. We use the most recent baro samples
    // and interpolate against their own timestamps to handle the
    // irregular ≤5 Hz rate.
    const tipNs = this.imu[this.imu.length - 1].tsNs;
    const windowStartNs = tipNs - 2_000_000_000; // 2 seconds in ns
    const baroSlice = this.baro.filter(b => b.tsNs >= windowStartNs - 200_000_000);
    const barometer = upsampleBaroToFixedGrid(
      baroSlice.length > 0 ? baroSlice : this.baro,
      windowStartNs,
      tipNs,
      FALL_TARGET_BARO_SAMPLES,
    );

    const payload: FallWindowReady = { imu, barometer };
    for (const sub of this.fallSubs) sub(payload);
  }
}

/**
 * Linear upsample per channel from `inLen` samples to `outLen` samples.
 * Assumes uniform input timing; for a 50 Hz → 100 Hz doubling this just
 * interleaves originals with linear midpoints, which is good enough for
 * the model since the original training data was already low-passed by
 * the sensor's anti-alias filter.
 */
function linearUpsamplePerChannel(
  input: number[][],
  outLen: number,
  channels: number,
): number[][] {
  const inLen = input.length;
  const out: number[][] = new Array(outLen);
  for (let t = 0; t < outLen; t++) {
    const srcF = (t * (inLen - 1)) / (outLen - 1);
    const i0 = Math.floor(srcF);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcF - i0;
    const row = new Array(channels);
    for (let c = 0; c < channels; c++) {
      const v0 = input[i0][c];
      const v1 = input[i1][c];
      row[c] = v0 + (v1 - v0) * frac;
    }
    out[t] = row;
  }
  return out;
}

/**
 * Place `outLen` samples uniformly across [startNs, endNs], with each
 * point linearly interpolated against the nearest barometer samples.
 * Outside the data range we hold the nearest edge value (flat baseline).
 */
function upsampleBaroToFixedGrid(
  samples: PressureSample[],
  startNs: number,
  endNs: number,
  outLen: number,
): number[] {
  if (samples.length === 0) return new Array(outLen).fill(0);
  if (samples.length === 1) return new Array(outLen).fill(samples[0].value);

  const sorted = [...samples].sort((a, b) => a.tsNs - b.tsNs);
  const out: number[] = new Array(outLen);
  for (let t = 0; t < outLen; t++) {
    const tsNs = startNs + ((endNs - startNs) * t) / (outLen - 1);
    out[t] = interpolateAt(sorted, tsNs);
  }
  return out;
}

function interpolateAt(sorted: PressureSample[], tsNs: number): number {
  if (tsNs <= sorted[0].tsNs) return sorted[0].value;
  const last = sorted[sorted.length - 1];
  if (tsNs >= last.tsNs) return last.value;
  // Binary search for the right neighbour.
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid].tsNs <= tsNs) lo = mid;
    else hi = mid;
  }
  const a = sorted[lo];
  const b = sorted[hi];
  const frac = (tsNs - a.tsNs) / Math.max(1, b.tsNs - a.tsNs);
  return a.value + (b.value - a.value) * frac;
}

export const imuWindowBuffer = new ImuWindowBuffer();

/**
 * Test-only export so unit tests can assert behaviour without poking the
 * singleton's internal state. Not part of the public API.
 */
export const __testExports = { linearUpsamplePerChannel, upsampleBaroToFixedGrid };
