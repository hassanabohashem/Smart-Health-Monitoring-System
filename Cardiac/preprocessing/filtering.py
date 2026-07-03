"""
Signal preprocessing: bandpass filtering, adaptive notch filtering,
per-beat normalization (z-score and robust scaling).
"""
import numpy as np
from scipy.signal import butter, filtfilt, iirnotch


def bandpass_filter(signal, fs, low=0.67, high=40.0, order=4):
    """Apply Butterworth bandpass filter.

    Args:
        signal: 1D numpy array
        fs: sampling frequency (Hz)
        low: low cutoff frequency (Hz)
        high: high cutoff frequency (Hz)
        order: filter order

    Returns:
        Filtered signal (same shape as input)
    """
    nyq = 0.5 * fs
    low_norm = low / nyq
    high_norm = high / nyq
    # Clamp to valid range
    low_norm = max(low_norm, 1e-5)
    high_norm = min(high_norm, 1.0 - 1e-5)
    b, a = butter(order, [low_norm, high_norm], btype='band')
    return filtfilt(b, a, signal, padlen=min(3 * max(len(b), len(a)), len(signal) - 1))


def notch_filter(signal, fs, freq=50, Q=30):
    """Apply notch filter to remove powerline interference.

    Args:
        signal: 1D numpy array
        fs: sampling frequency (Hz)
        freq: notch frequency (50 Hz for EU/Asia, 60 Hz for US)
        Q: quality factor

    Returns:
        Filtered signal
    """
    if freq >= fs / 2:
        return signal  # notch freq above Nyquist, skip
    b, a = iirnotch(freq, Q, fs)
    return filtfilt(b, a, signal, padlen=min(3 * max(len(b), len(a)), len(signal) - 1))


def zscore_normalize(beat):
    """Per-beat z-score normalization (zero mean, unit variance).

    Args:
        beat: 1D numpy array

    Returns:
        Normalized beat. Returns zeros if std ≈ 0.
    """
    std = np.std(beat)
    if std < 1e-8:
        return np.zeros_like(beat)
    return (beat - np.mean(beat)) / std


def robust_normalize(beat):
    """Per-beat robust normalization using median and IQR.

    More resistant to outliers than z-score. Use as ablation for noisy beats.

    Args:
        beat: 1D numpy array

    Returns:
        Normalized beat
    """
    median = np.median(beat)
    q75, q25 = np.percentile(beat, [75, 25])
    iqr = q75 - q25
    if iqr < 1e-8:
        return np.zeros_like(beat)
    return (beat - median) / iqr


def preprocess_signal(signal, fs, notch_freq=50, normalize_method='zscore'):
    """Full preprocessing pipeline for a raw ECG signal.

    Applies bandpass → notch → returns filtered signal.
    Per-beat normalization is applied separately after beat extraction.

    Args:
        signal: 1D numpy array (full record)
        fs: sampling frequency
        notch_freq: powerline frequency (50 or 60 Hz)
        normalize_method: not used here (applied per-beat later)

    Returns:
        Filtered signal
    """
    filtered = bandpass_filter(signal, fs)
    filtered = notch_filter(filtered, fs, freq=notch_freq)
    return filtered


def normalize_beats(beats, method='zscore'):
    """Apply per-beat normalization to array of beats.

    Args:
        beats: ndarray of shape (n_beats, beat_length)
        method: 'zscore' or 'robust'

    Returns:
        Normalized beats (same shape)
    """
    norm_fn = zscore_normalize if method == 'zscore' else robust_normalize
    return np.array([norm_fn(beat) for beat in beats], dtype=np.float32)
