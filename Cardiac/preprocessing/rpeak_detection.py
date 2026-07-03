"""
Robust R-peak detection using NeuroKit2 with fallback methods.

Benchmarks detector sensitivity at various SNR levels on NSTDB-augmented signals.
This addresses Problem 5: R-peak detection is the dominant inference-time failure mode.
"""
import numpy as np

try:
    import neurokit2 as nk
    HAS_NEUROKIT = True
except Exception:
    # Catch both ImportError (missing) and TypeError (Py3.10 syntax in some
    # neurokit submodules when running on Py3.9)
    HAS_NEUROKIT = False
    nk = None

from scipy.signal import find_peaks


def detect_rpeaks_neurokit(signal, fs, method='neurokit'):
    """Detect R-peaks using NeuroKit2 ensemble method.

    Args:
        signal: 1D numpy array (preprocessed ECG)
        fs: sampling frequency (Hz)
        method: NeuroKit2 method name ('neurokit', 'pantompkins1985',
                'hamilton2002', 'christov2004', 'engzeemod2012')

    Returns:
        rpeaks: 1D array of R-peak sample indices
    """
    if not HAS_NEUROKIT:
        return detect_rpeaks_simple(signal, fs)

    try:
        # NeuroKit2 expects a clean-ish signal
        _, info = nk.ecg_peaks(signal, sampling_rate=int(fs), method=method)
        rpeaks = info['ECG_R_Peaks']
        return np.array(rpeaks, dtype=np.int64)
    except Exception:
        # Fallback to simple detector
        return detect_rpeaks_simple(signal, fs)


def detect_rpeaks_simple(signal, fs):
    """Simple R-peak detector using scipy find_peaks as fallback.

    Uses adaptive thresholding based on signal amplitude statistics.

    Args:
        signal: 1D numpy array
        fs: sampling frequency (Hz)

    Returns:
        rpeaks: 1D array of R-peak sample indices
    """
    # Minimum distance between R-peaks: ~200ms (300 bpm max)
    min_distance = int(0.2 * fs)

    # Adaptive height threshold
    abs_signal = np.abs(signal)
    threshold = np.mean(abs_signal) + 0.5 * np.std(abs_signal)

    peaks, properties = find_peaks(
        signal,
        height=threshold,
        distance=min_distance,
        prominence=0.3 * np.std(signal)
    )

    if len(peaks) == 0:
        # Very noisy signal — try with lower threshold
        threshold = np.mean(abs_signal)
        peaks, _ = find_peaks(signal, height=threshold, distance=min_distance)

    return np.array(peaks, dtype=np.int64)


def detect_rpeaks(signal, fs, method='neurokit'):
    """Main R-peak detection entry point with automatic fallback.

    Args:
        signal: 1D preprocessed ECG signal
        fs: sampling frequency
        method: detection method

    Returns:
        rpeaks: 1D array of R-peak sample indices
    """
    rpeaks = detect_rpeaks_neurokit(signal, fs, method=method)

    # Sanity checks
    if len(rpeaks) == 0:
        return rpeaks

    # Remove duplicates and sort
    rpeaks = np.unique(rpeaks)

    # Remove peaks too close to signal boundaries (need window for beat extraction)
    margin = int(0.5 * fs)  # 500ms margin
    rpeaks = rpeaks[(rpeaks >= margin) & (rpeaks < len(signal) - margin)]

    return rpeaks


def evaluate_rpeak_detector(true_rpeaks, detected_rpeaks, tolerance_ms=150, fs=128):
    """Evaluate R-peak detector performance.

    Args:
        true_rpeaks: ground truth R-peak positions (sample indices)
        detected_rpeaks: detected R-peak positions
        tolerance_ms: matching tolerance in milliseconds
        fs: sampling rate

    Returns:
        dict with sensitivity, PPV (precision), F1
    """
    tolerance_samples = int(tolerance_ms * fs / 1000)
    true_set = set(true_rpeaks)
    tp = 0
    fp = 0

    matched_true = set()
    for det in detected_rpeaks:
        found = False
        for t in true_rpeaks:
            if abs(det - t) <= tolerance_samples and t not in matched_true:
                tp += 1
                matched_true.add(t)
                found = True
                break
        if not found:
            fp += 1

    fn = len(true_set) - len(matched_true)
    sensitivity = tp / max(tp + fn, 1)
    ppv = tp / max(tp + fp, 1)
    f1 = 2 * sensitivity * ppv / max(sensitivity + ppv, 1e-8)

    return {
        'sensitivity': sensitivity,
        'ppv': ppv,
        'f1': f1,
        'tp': tp,
        'fp': fp,
        'fn': fn,
    }
