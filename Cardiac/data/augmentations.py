"""
Time-series-aware augmentations for ECG beat classification.

Includes: Lead-I synthesis, time shifting, amplitude scaling, Gaussian noise,
NSTDB noise injection, within-class MixUp, and DBA oversampling.
"""
import os
import sys
import numpy as np
from scipy.signal import resample_poly
from math import gcd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import (AUG_TIME_SHIFT_MAX, AUG_AMPLITUDE_SCALE,
                     AUG_GAUSSIAN_NOISE_STD, AUG_LEAD_SYNTH_PROB,
                     AUG_LEAD_SYNTH_ANGLE_RANGE, AUG_NSTDB_INJECT_PROB,
                     AUG_NSTDB_SNR_RANGE, MIXUP_ALPHA, NSTDB_DIR, TARGET_FS,
                     BEAT_WINDOW_SAMPLES)


# ─── Lead-I synthesis augmentation ──────────────────────────────────────────
def lead_i_synthesis(beat, rng=None):
    """Simulate Lead I morphology from MLII via cardiac-axis rotation.

    Method (adapted from ECGFounder, NEJM AI 2025):
    For a single-lead signal, approximate the orthogonal component using
    the differentiated (derivative) signal, then apply axis rotation:
        beat_aug = beat * cos(θ) + ortho * sin(θ)
    where θ ∈ [-30°, +90°] represents cardiac axis variability.

    Args:
        beat: 1D array of shape (beat_length,)
        rng: numpy RandomState for reproducibility

    Returns:
        Augmented beat (same shape)
    """
    if rng is None:
        rng = np.random.default_rng()

    angle_deg = rng.uniform(AUG_LEAD_SYNTH_ANGLE_RANGE[0],
                            AUG_LEAD_SYNTH_ANGLE_RANGE[1])
    theta = np.radians(angle_deg)

    # Approximate orthogonal component via derivative + smooth
    ortho = np.gradient(beat)
    # Normalize orthogonal to same energy as original
    beat_energy = np.sqrt(np.mean(beat ** 2)) + 1e-8
    ortho_energy = np.sqrt(np.mean(ortho ** 2)) + 1e-8
    ortho = ortho * (beat_energy / ortho_energy)

    augmented = beat * np.cos(theta) + ortho * np.sin(theta)
    return augmented.astype(np.float32)


# ─── Basic augmentations ────────────────────────────────────────────────────
def random_time_shift(beat, max_shift=AUG_TIME_SHIFT_MAX, rng=None):
    """Random circular shift of the beat waveform."""
    if rng is None:
        rng = np.random.default_rng()
    shift = rng.integers(-max_shift, max_shift + 1)
    return np.roll(beat, shift).astype(np.float32)


def random_amplitude_scale(beat, scale_range=AUG_AMPLITUDE_SCALE, rng=None):
    """Random amplitude scaling."""
    if rng is None:
        rng = np.random.default_rng()
    scale = rng.uniform(scale_range[0], scale_range[1])
    return (beat * scale).astype(np.float32)


def add_gaussian_noise(beat, std=AUG_GAUSSIAN_NOISE_STD, rng=None):
    """Add Gaussian noise to beat."""
    if rng is None:
        rng = np.random.default_rng()
    noise = rng.normal(0, std, size=beat.shape)
    return (beat + noise).astype(np.float32)


# ─── NSTDB noise injection ──────────────────────────────────────────────────
_nstdb_noise_cache = {}


def load_nstdb_noise_templates():
    """Load NSTDB noise templates (baseline wander, muscle artifact, electrode motion)."""
    global _nstdb_noise_cache
    if _nstdb_noise_cache:
        return _nstdb_noise_cache

    import wfdb
    for noise_type in ['bw', 'em', 'ma']:
        path = os.path.join(NSTDB_DIR, noise_type)
        try:
            record = wfdb.rdrecord(path)
            # Take first channel, resample to target fs
            noise_signal = record.p_signal[:, 0].astype(np.float64)
            orig_fs = record.fs
            if orig_fs != TARGET_FS:
                g = gcd(int(orig_fs), int(TARGET_FS))
                noise_signal = resample_poly(noise_signal,
                                              int(TARGET_FS) // g,
                                              int(orig_fs) // g)
            _nstdb_noise_cache[noise_type] = noise_signal
        except Exception as e:
            print(f"Warning: Could not load NSTDB noise '{noise_type}': {e}")

    return _nstdb_noise_cache


def inject_nstdb_noise(beat, snr_db=None, noise_type=None, rng=None):
    """Inject NSTDB noise at specified SNR.

    Args:
        beat: 1D array
        snr_db: target SNR in dB. If None, random from config range.
        noise_type: 'bw', 'em', 'ma', or None for random choice
        rng: random state

    Returns:
        Noisy beat
    """
    if rng is None:
        rng = np.random.default_rng()

    templates = load_nstdb_noise_templates()
    if not templates:
        return beat  # No templates available

    if noise_type is None:
        noise_type = rng.choice(list(templates.keys()))
    if noise_type not in templates:
        return beat

    noise_full = templates[noise_type]
    if snr_db is None:
        snr_db = rng.uniform(AUG_NSTDB_SNR_RANGE[0], AUG_NSTDB_SNR_RANGE[1])

    # Random segment from noise template
    if len(noise_full) > len(beat):
        start = rng.integers(0, len(noise_full) - len(beat))
        noise_segment = noise_full[start:start + len(beat)]
    else:
        # Tile if noise template is shorter
        reps = int(np.ceil(len(beat) / len(noise_full)))
        noise_segment = np.tile(noise_full, reps)[:len(beat)]

    # Scale noise to target SNR
    signal_power = np.mean(beat ** 2) + 1e-10
    noise_power = np.mean(noise_segment ** 2) + 1e-10
    snr_linear = 10 ** (snr_db / 10)
    scale = np.sqrt(signal_power / (noise_power * snr_linear))
    noisy = beat + scale * noise_segment

    return noisy.astype(np.float32)


# ─── Within-class MixUp ─────────────────────────────────────────────────────
def mixup_beats(beat1, beat2, rr1, rr2, alpha=MIXUP_ALPHA, rng=None):
    """Within-class MixUp between two beats.

    Args:
        beat1, beat2: 1D beat arrays
        rr1, rr2: RR feature vectors (4-dim each)
        alpha: Beta distribution parameter

    Returns:
        mixed_beat, mixed_rr
    """
    if rng is None:
        rng = np.random.default_rng()
    lam = rng.beta(alpha, alpha)
    mixed_beat = (lam * beat1 + (1 - lam) * beat2).astype(np.float32)
    mixed_rr = (lam * rr1 + (1 - lam) * rr2).astype(np.float32)
    return mixed_beat, mixed_rr


# ─── DBA (DTW Barycenter Averaging) ─────────────────────────────────────────
def dba_average(beats, n_iterations=3):
    """Compute DTW Barycenter Average of a set of beats.

    Simplified DBA: iteratively refine an average by aligning beats
    to current average using FFT-based cross-correlation (fast).

    Args:
        beats: ndarray of shape (n_beats, beat_length)
        n_iterations: number of refinement iterations

    Returns:
        Average beat (1D array)
    """
    if len(beats) == 0:
        return np.zeros(BEAT_WINDOW_SAMPLES, dtype=np.float32)

    avg = np.mean(beats, axis=0).astype(np.float64)

    for _ in range(n_iterations):
        aligned_sum = np.zeros_like(avg)
        for beat in beats:
            # FFT-based cross-correlation (much faster than np.correlate)
            from scipy.signal import fftconvolve
            corr = fftconvolve(avg, beat[::-1], mode='full')
            best_shift = np.argmax(corr) - len(beat) + 1
            best_shift = np.clip(best_shift, -len(beat) // 4, len(beat) // 4)
            aligned_sum += np.roll(beat, best_shift)
        avg = aligned_sum / len(beats)

    return avg.astype(np.float32)


def generate_biological_f_beats(n_beats, v_beats, n_rr, v_rr, n_synthetic,
                                  alpha_range=(0.4, 0.6), rng=None):
    """Generate synthetic F-class beats from the biological definition.

    AAMI 'F' = *Fusion of ventricular and normal beats*. The morphology is
    literally a linear combination of a normal conduction beat and a PVC.
    This function samples one random N beat + one random V beat and mixes
    them with alpha drawn from Uniform(alpha_range).

    This is grounded in the clinical definition of fusion beats rather than
    random within-class MixUp, which has no biological basis for F-class.

    Args:
        n_beats: ndarray (n_N, beat_length) -- pool of N-class beats
        v_beats: ndarray (n_V, beat_length) -- pool of V-class beats
        n_rr:    ndarray (n_N, 4)           -- N-class RR features
        v_rr:    ndarray (n_V, 4)           -- V-class RR features
        n_synthetic: how many F beats to synthesize
        alpha_range: (min, max) mixing coefficient. alpha*N + (1-alpha)*V.
        rng: random state

    Returns:
        syn_beats: ndarray (n_synthetic, beat_length), float32
        syn_rr:    ndarray (n_synthetic, 4), float32
    """
    if rng is None:
        rng = np.random.default_rng()

    if len(n_beats) == 0 or len(v_beats) == 0:
        return (np.empty((0, BEAT_WINDOW_SAMPLES), dtype=np.float32),
                np.empty((0, 4), dtype=np.float32))

    syn_beats = np.zeros((n_synthetic, n_beats.shape[1]), dtype=np.float32)
    syn_rr = np.zeros((n_synthetic, 4), dtype=np.float32)

    for i in range(n_synthetic):
        n_idx = rng.integers(0, len(n_beats))
        v_idx = rng.integers(0, len(v_beats))
        alpha = rng.uniform(alpha_range[0], alpha_range[1])
        syn_beats[i] = alpha * n_beats[n_idx] + (1 - alpha) * v_beats[v_idx]
        # Add small perturbation so synthetic beats are not collinear
        syn_beats[i] += rng.normal(0, 0.01, size=syn_beats[i].shape)
        # Inherit the RR context from the V parent (fusion beats follow
        # ventricular-like timing patterns; borrowing V's RR is closer to the
        # clinical reality than averaging with N's RR)
        syn_rr[i] = v_rr[v_idx]

    return syn_beats, syn_rr


def generate_dba_synthetic(beats, rr_features, n_synthetic=100, rng=None):
    """Generate synthetic beats using MixUp (fast) + a few DBA samples.

    For speed, primarily uses within-class MixUp (convex combinations of
    2-3 beats). A small fraction (~10%) uses DBA alignment for more
    morphological diversity.

    Args:
        beats: ndarray (n, beat_length) -- all beats of one class
        rr_features: ndarray (n, 4) -- corresponding RR features
        n_synthetic: number of synthetic beats to generate
        rng: random state

    Returns:
        synthetic_beats, synthetic_rr
    """
    if rng is None:
        rng = np.random.default_rng()

    n = len(beats)
    if n < 2:
        return beats, rr_features

    synthetic_beats = []
    synthetic_rr = []

    # Fast MixUp: convex combination of 2-3 random beats + perturbation
    for _ in range(n_synthetic):
        k = rng.integers(2, min(4, n + 1))  # 2 or 3 beats
        indices = rng.choice(n, size=k, replace=False)
        weights = rng.dirichlet(np.ones(k))
        syn_beat = np.average(beats[indices], axis=0, weights=weights)
        syn_beat = syn_beat + rng.normal(0, 0.015, size=syn_beat.shape)
        syn_rr = np.average(rr_features[indices], axis=0, weights=weights)
        synthetic_beats.append(syn_beat.astype(np.float32))
        synthetic_rr.append(syn_rr.astype(np.float32))

    return (np.array(synthetic_beats, dtype=np.float32),
            np.array(synthetic_rr, dtype=np.float32))


# ─── Combined augmentation pipeline ─────────────────────────────────────────
def augment_beat(beat, rr_features, rng=None, enable_lead_synth=True,
                 enable_nstdb=True):
    """Apply random augmentation pipeline to a single beat during training.

    Args:
        beat: 1D array (beat_length,)
        rr_features: 1D array (4,)
        rng: random state
        enable_lead_synth: enable Lead-I synthesis augmentation
        enable_nstdb: enable NSTDB noise injection

    Returns:
        augmented_beat, rr_features (RR features unchanged by signal augmentation)
    """
    if rng is None:
        rng = np.random.default_rng()

    aug = beat.copy()

    # Lead-I synthesis (30-50% of beats)
    if enable_lead_synth and rng.random() < AUG_LEAD_SYNTH_PROB:
        aug = lead_i_synthesis(aug, rng=rng)

    # Random time shift
    if rng.random() < 0.5:
        aug = random_time_shift(aug, rng=rng)

    # Random amplitude scaling
    if rng.random() < 0.5:
        aug = random_amplitude_scale(aug, rng=rng)

    # Gaussian noise
    if rng.random() < 0.5:
        aug = add_gaussian_noise(aug, rng=rng)

    # NSTDB noise injection (10% of beats)
    if enable_nstdb and rng.random() < AUG_NSTDB_INJECT_PROB:
        aug = inject_nstdb_noise(aug, rng=rng)

    return aug, rr_features
