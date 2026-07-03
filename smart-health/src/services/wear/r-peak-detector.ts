/**
 * Streaming Pan-Tompkins R-peak detector for ECG signals.
 *
 * Based on Pan, J. & Tompkins, W.J. (1985). A Real-Time QRS Detection
 * Algorithm. IEEE Trans. Biomed. Eng., BME-32(3), 230-236.
 *
 * Pipeline applied per-sample:
 *   1. Bandpass filter 5-15 Hz (Butterworth biquad) — isolate QRS energy
 *   2. 5-point derivative — emphasize sharp slopes
 *   3. Squaring — amplify positive peaks, suppress baseline
 *   4. Moving-window integration over ~150 ms — smooth into a single peak
 *   5. Adaptive thresholding with refractory period — detect R-peaks
 *
 * Initialization: the first ~2 seconds of input feed an empirical learn
 * window that seeds the signal/noise level estimates. No peaks are emitted
 * during this warm-up.
 *
 * Output sample indices are in the original (pre-filter) signal, after
 * subtracting the integration window lag (~MWI_WINDOW_MS / 2). This puts
 * the reported index close to the true R-peak in the raw waveform —
 * accurate enough for RR-interval computation and beat-centered windowing.
 * (Final sub-sample alignment would require search-back to local-max in
 * the bandpassed signal; not needed for this use case.)
 */

const BANDPASS_LOW_HZ = 5;
const BANDPASS_HIGH_HZ = 15;
const MWI_WINDOW_MS = 150;
const REFRACTORY_MS = 200;
const INIT_LEARN_SECONDS = 2;

interface BiquadCoeffs {
  b0: number; b1: number; b2: number;
  a1: number; a2: number;
}

/**
 * Direct-form-II transposed biquad — minimal floating-point error and easy
 * to reset for streaming.
 */
class Biquad {
  private c: BiquadCoeffs;
  private z1 = 0;
  private z2 = 0;

  constructor(coeffs: BiquadCoeffs) {
    this.c = coeffs;
  }

  process(x: number): number {
    const y = this.c.b0 * x + this.z1;
    this.z1 = this.c.b1 * x - this.c.a1 * y + this.z2;
    this.z2 = this.c.b2 * x - this.c.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }
}

/**
 * Compute biquad coefficients for a 2nd-order constant-skirt Butterworth
 * bandpass via the bilinear transform. lowHz and highHz are the -3 dB
 * corners; fsHz is the sample rate.
 */
function butterworthBandpassCoeffs(lowHz: number, highHz: number, fsHz: number): BiquadCoeffs {
  const f0 = Math.sqrt(lowHz * highHz);
  const w0 = (2 * Math.PI * f0) / fsHz;
  const bw = highHz - lowHz;
  const Q = f0 / bw;
  const alpha = Math.sin(w0) / (2 * Q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0,
    b1: 0,
    b2: -alpha / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  };
}

export interface DetectedPeak {
  /** Approximate index of the R-peak in the global sample stream
   *  (since the detector was constructed/reset). Already compensated for
   *  the moving-window integration lag. */
  sampleIndex: number;
}

export class PanTompkinsDetector {
  private fsHz: number;
  private bp: Biquad;
  private mwiBuf: number[] = [];
  private mwiSum = 0;
  private mwiSize: number;
  private derivBuf: number[] = [0, 0, 0, 0];

  private spkF = 0;
  private npkF = 0;
  private threshold1 = 0;
  private threshold2 = 0;

  private lastPeakSampleIndex = -Number.MAX_SAFE_INTEGER;
  private refractorySamples: number;
  private peakLagSamples: number;
  private sampleIndex = 0;
  private candidateMax = 0;
  private candidateAt = 0;

  private initSampleBudget: number;
  private initialized = false;
  private learnMax = 0;
  private learnSum = 0;
  private learnCount = 0;

  constructor(fsHz: number) {
    this.fsHz = fsHz;
    this.bp = new Biquad(butterworthBandpassCoeffs(BANDPASS_LOW_HZ, BANDPASS_HIGH_HZ, fsHz));
    this.mwiSize = Math.max(1, Math.round((MWI_WINDOW_MS / 1000) * fsHz));
    this.refractorySamples = Math.round((REFRACTORY_MS / 1000) * fsHz);
    this.peakLagSamples = Math.round(this.mwiSize / 2);
    this.initSampleBudget = Math.round(INIT_LEARN_SECONDS * fsHz);
  }

  /**
   * Process a batch of samples. Returns any newly detected peaks (may be
   * empty). Peak indices are relative to the lifetime sample count of
   * this detector.
   */
  pushSamples(samples: number[]): DetectedPeak[] {
    const peaks: DetectedPeak[] = [];
    for (let i = 0; i < samples.length; i++) {
      const peak = this.processOne(samples[i]);
      if (peak !== null) peaks.push(peak);
    }
    return peaks;
  }

  private processOne(x: number): DetectedPeak | null {
    this.sampleIndex++;

    // 1. Bandpass
    const bp = this.bp.process(x);

    // 2. 5-point derivative (Pan-Tompkins formula):
    //    y[n] = (2*x[n] + x[n-1] - x[n-3] - 2*x[n-4]) / 8
    const deriv = (2 * bp + this.derivBuf[3] - this.derivBuf[1] - 2 * this.derivBuf[0]) / 8;
    this.derivBuf[0] = this.derivBuf[1];
    this.derivBuf[1] = this.derivBuf[2];
    this.derivBuf[2] = this.derivBuf[3];
    this.derivBuf[3] = bp;

    // 3. Squaring
    const sq = deriv * deriv;

    // 4. Moving-window integration
    this.mwiBuf.push(sq);
    this.mwiSum += sq;
    if (this.mwiBuf.length > this.mwiSize) {
      this.mwiSum -= this.mwiBuf.shift()!;
    }
    const mwi = this.mwiSum / this.mwiBuf.length;

    // 5a. Initialization — empirically seed signal/noise from the first
    //     ~2 seconds. We skip the first ~250ms (the bandpass filter's
    //     impulse response settling) so the input ECG's DC-offset
    //     transient doesn't inflate `learnMax` into a useless ceiling.
    if (!this.initialized) {
      this.learnCount++;
      const settleSamples = Math.round(0.25 * this.fsHz);
      if (this.learnCount > settleSamples) {
        if (mwi > this.learnMax) this.learnMax = mwi;
        this.learnSum += mwi;
      }
      if (this.learnCount >= this.initSampleBudget) {
        const learnedSamples = this.initSampleBudget - settleSamples;
        const avgMwi = this.learnSum / Math.max(1, learnedSamples);
        this.spkF = this.learnMax / 3;
        this.npkF = avgMwi / 2;
        this.threshold1 = this.npkF + 0.25 * (this.spkF - this.npkF);
        this.threshold2 = 0.5 * this.threshold1;
        this.initialized = true;
        console.log(
          `[r-peak] init done: spkF=${this.spkF.toFixed(4)} ` +
          `npkF=${this.npkF.toFixed(4)} thr1=${this.threshold1.toFixed(4)}`
        );
      }
      return null;
    }

    // 5b. Detection — track the local max of MWI while above threshold,
    //     fire when it starts to fall (proper peak detection, not edge).
    if (mwi > this.threshold1) {
      if (mwi > this.candidateMax) {
        this.candidateMax = mwi;
        this.candidateAt = this.sampleIndex;
      }
      return null;
    }
    if (this.candidateMax > 0) {
      // We were tracking a candidate; MWI has now dropped below threshold.
      // Confirm as R-peak if refractory has elapsed.
      const capturedMax = this.candidateMax;
      const capturedAt = this.candidateAt;
      this.candidateMax = 0;
      this.candidateAt = 0;
      if (capturedAt - this.lastPeakSampleIndex > this.refractorySamples) {
        const peakSample = capturedAt - this.peakLagSamples;
        this.spkF = 0.125 * capturedMax + 0.875 * this.spkF;
        this.threshold1 = this.npkF + 0.25 * (this.spkF - this.npkF);
        this.threshold2 = 0.5 * this.threshold1;
        this.lastPeakSampleIndex = capturedAt;
        console.log(`[r-peak] fire @${peakSample} mwi=${capturedMax.toFixed(4)}`);
        return { sampleIndex: peakSample };
      }
    }
    if (mwi > this.threshold2 * 0.5) {
      // Above noise floor but below signal threshold — update noise estimate.
      this.npkF = 0.125 * mwi + 0.875 * this.npkF;
      this.threshold1 = this.npkF + 0.25 * (this.spkF - this.npkF);
      this.threshold2 = 0.5 * this.threshold1;
    }
    return null;
  }

  reset(): void {
    this.bp.reset();
    this.mwiBuf = [];
    this.mwiSum = 0;
    this.derivBuf = [0, 0, 0, 0];
    this.spkF = 0;
    this.npkF = 0;
    this.threshold1 = 0;
    this.threshold2 = 0;
    this.lastPeakSampleIndex = -Number.MAX_SAFE_INTEGER;
    this.candidateMax = 0;
    this.candidateAt = 0;
    this.sampleIndex = 0;
    this.learnMax = 0;
    this.learnSum = 0;
    this.learnCount = 0;
    this.initialized = false;
  }

  /** Lifetime sample count — useful for callers mapping peak indices to a buffer. */
  get totalSamples(): number {
    return this.sampleIndex;
  }

  /** True once the initial 2-second warm-up has completed. */
  get ready(): boolean {
    return this.initialized;
  }
}
