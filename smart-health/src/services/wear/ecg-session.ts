/**
 * ECG session manager fed from the Galaxy Watch 5's BioActive sensor.
 *
 * The watch streams ECG at 500 Hz inside an EcgWindow blob, only when
 * the user starts a recording session in the watch's companion UI
 * (`isRecording=true`). One second of recording ≈ 500 samples in
 * millivolts plus a per-sample lead-off flag.
 *
 * Beat extraction is driven by a streaming Pan-Tompkins R-peak detector
 * (see `r-peak-detector.ts`). For each detected R-peak we:
 *
 *   1. Wait for the NEXT peak to land so `post_rr` is known (1-beat lag).
 *   2. Slice a 1-sec window around the peak (400 ms pre + 600 ms post) from
 *      the raw 500 Hz buffer.
 *   3. Resample to 128 samples (cardiac model's expected length).
 *   4. Z-score normalize to match training distribution.
 *   5. Compute real RR features from the peak history.
 *   6. Call `processCardiacBeat` for inference.
 *
 * Skips a beat if >20% of its samples are flagged lead-off (electrode lost
 * contact). Detector + buffer reset on session end.
 */

import { processCardiacBeat } from '../ai';
import type { CardiacInput } from '../ai';
import type { EcgWindow } from './types';
import { PanTompkinsDetector } from './r-peak-detector';
import { useVitalsStore, type EcgClass } from '@/stores/vitals.store';

/** Map the 4-class cardiac model label to the coarse UI category
 *  surfaced on the Home tile. N → normal; S/V/F → irregular. */
function ecgClassFor(label: string | undefined): EcgClass {
  if (!label) return 'inconclusive';
  return label.toUpperCase() === 'N' ? 'normal' : 'irregular';
}

const TARGET_BEAT_SAMPLES = 128;
const PRE_R_MS = 400;   // 200 samples @ 500 Hz before the peak
const POST_R_MS = 600;  // 300 samples @ 500 Hz after the peak
const MIN_RR_S = 0.30;  // physiological floor — anything closer is noise
const MAX_RR_S = 2.00;  // physiological ceiling — anything wider is missed beat

interface BufferedSample {
  mv: number;
  leadOff: number;
}

class EcgSession {
  /** Sliding 500-Hz buffer of samples since session start. */
  private buffer: BufferedSample[] = [];
  /**
   * Global index of `buffer[0]` in the overall sample stream — increments
   * when we trim the front of the buffer. Used to map detector peak
   * indices to current buffer positions.
   */
  private bufferGlobalStart = 0;

  private active = false;
  private wearerId: string | null = null;
  private wearerName: string | null = null;
  private detector: PanTompkinsDetector | null = null;
  private currentFsHz = 500;

  /** Global sample indices of recently detected R-peaks (oldest first). */
  private peakHistory: number[] = [];

  setWearer(wearerId: string | null, wearerName: string | null): void {
    this.wearerId = wearerId;
    this.wearerName = wearerName;
  }

  pushWindow(ecg: EcgWindow): void {
    if (!ecg.isRecording) {
      if (this.active) this.endSession();
      return;
    }
    const fsHz = ecg.sampleRateHz > 0 ? ecg.sampleRateHz : 500;
    if (!this.active) this.startSession(fsHz);

    const n = Math.min(ecg.sampleCount, ecg.samplesMv.length, ecg.leadOff.length);
    const newMv: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
      newMv[i] = ecg.samplesMv[i];
      this.buffer.push({ mv: ecg.samplesMv[i], leadOff: ecg.leadOff[i] });
    }

    // Cap buffer at ~6 sec; track global index so detector peaks still resolve.
    const capSamples = fsHz * 6;
    if (this.buffer.length > capSamples) {
      const drop = this.buffer.length - capSamples;
      this.buffer.splice(0, drop);
      this.bufferGlobalStart += drop;
    }

    // Feed detector; collect new peaks.
    const detectedPeaks = this.detector?.pushSamples(newMv) ?? [];
    for (const p of detectedPeaks) this.peakHistory.push(p.sampleIndex);

    this.tryEmitPendingBeats();
  }

  /**
   * Emit a beat for each peak whose `pre` and `post` neighbours are known
   * and whose ±window is still in the buffer. Stops as soon as the head
   * peak isn't ready (lack of next peak or buffer doesn't yet cover post).
   */
  private tryEmitPendingBeats(): void {
    if (!this.wearerId || !this.wearerName) return;
    const fsHz = this.currentFsHz;
    const preSamples = Math.round((PRE_R_MS / 1000) * fsHz);
    const postSamples = Math.round((POST_R_MS / 1000) * fsHz);

    while (this.peakHistory.length >= 3) {
      const prevIdx = this.peakHistory[0];
      const curIdx = this.peakHistory[1];
      const nextIdx = this.peakHistory[2];

      // Map to buffer positions.
      const startInBuf = curIdx - this.bufferGlobalStart - preSamples;
      const endInBuf = curIdx - this.bufferGlobalStart + postSamples;

      if (endInBuf > this.buffer.length) {
        // Post-R portion hasn't arrived yet; wait for more samples.
        return;
      }
      if (startInBuf < 0) {
        // Buffer was trimmed past the pre-R portion. Drop this peak.
        this.peakHistory.shift();
        continue;
      }

      const beatRaw = this.buffer.slice(startInBuf, endInBuf);

      // RR sanity: drop peaks that violate physiological bounds (likely a
      // misfire from baseline wander or a missed beat).
      const preRr = (curIdx - prevIdx) / fsHz;
      const postRr = (nextIdx - curIdx) / fsHz;
      if (preRr < MIN_RR_S || preRr > MAX_RR_S || postRr < MIN_RR_S || postRr > MAX_RR_S) {
        this.peakHistory.shift();
        continue;
      }

      // Skip if >20% of the beat's samples have lead-off flagged.
      let leadOffCount = 0;
      for (const s of beatRaw) leadOffCount += s.leadOff;
      if (leadOffCount > beatRaw.length * 0.2) {
        this.peakHistory.shift();
        continue;
      }

      const beat = resampleToLength(beatRaw.map(s => s.mv), TARGET_BEAT_SAMPLES);
      const zNormed = zScore(beat);

      // Real RR features. mean_rr_10: mean of last up-to-10 RR intervals
      // from peakHistory; falls back to preRr if we don't have history yet.
      const recentRrs: number[] = [];
      for (let i = Math.max(1, this.peakHistory.length - 10); i < this.peakHistory.length; i++) {
        const rr = (this.peakHistory[i] - this.peakHistory[i - 1]) / fsHz;
        if (rr >= MIN_RR_S && rr <= MAX_RR_S) recentRrs.push(rr);
      }
      const mean10 = recentRrs.length > 0
        ? recentRrs.reduce((a, b) => a + b, 0) / recentRrs.length
        : preRr;
      const ratio = preRr / Math.max(postRr, 0.1);

      const input: CardiacInput = {
        beat: zNormed,
        rr: [preRr, postRr, ratio, mean10],
      };

      processCardiacBeat(input, {
        wearerId: this.wearerId,
        wearerName: this.wearerName,
      }).then(result => {
        if (result) {
          // Surface the verdict on the Home tile (same shape as the
          // SpO2 reading — value + confidence + timestamp).
          useVitalsStore.getState().updateVitals({
            ecgClass: ecgClassFor(result.label),
            ecgConfidence: result.confidence,
            ecgAt: Date.now(),
          });
          // TEMP diagnostic — remove after verification
          console.log(
            `[wear] cardiac ${result.label} c=${result.confidence.toFixed(2)} ` +
            `rr=${preRr.toFixed(2)}/${postRr.toFixed(2)} bpm=${(60 / mean10).toFixed(0)}` +
            (result.isAnomaly ? ' ANOMALY' : '')
          );
        }
      }).catch(err => {
        console.warn('[ecg-session] processCardiacBeat failed:', err);
      });

      // Advance head; next iteration considers peakHistory[1] as the new head.
      this.peakHistory.shift();
    }

    // Trim peak history so it doesn't grow without bound (cap at ~50 peaks).
    if (this.peakHistory.length > 50) {
      this.peakHistory.splice(0, this.peakHistory.length - 50);
    }
  }

  private startSession(fsHz: number): void {
    this.active = true;
    this.buffer = [];
    this.bufferGlobalStart = 0;
    this.peakHistory = [];
    this.currentFsHz = fsHz;
    this.detector = new PanTompkinsDetector(fsHz);
  }

  private endSession(): void {
    this.active = false;
    this.buffer = [];
    this.bufferGlobalStart = 0;
    this.peakHistory = [];
    this.detector = null;
  }

  reset(): void {
    this.endSession();
  }

  isActive(): boolean {
    return this.active;
  }
}

/** Linear resample `input` to exactly `targetLen` samples. */
function resampleToLength(input: number[], targetLen: number): number[] {
  const inLen = input.length;
  if (inLen === targetLen) return input.slice();
  const out: number[] = new Array(targetLen);
  for (let t = 0; t < targetLen; t++) {
    const srcF = (t * (inLen - 1)) / (targetLen - 1);
    const i0 = Math.floor(srcF);
    const i1 = Math.min(i0 + 1, inLen - 1);
    const frac = srcF - i0;
    out[t] = input[i0] + (input[i1] - input[i0]) * frac;
  }
  return out;
}

function zScore(arr: number[]): number[] {
  let mean = 0;
  for (const v of arr) mean += v;
  mean /= arr.length;
  let variance = 0;
  for (const v of arr) variance += (v - mean) ** 2;
  variance /= arr.length;
  const std = Math.sqrt(variance) || 1;
  return arr.map(v => (v - mean) / std);
}

export const ecgSession = new EcgSession();
