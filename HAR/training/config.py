"""
Central configuration for the HAR (Human Activity Recognition) training pipeline.

Target deployment: Galaxy Watch 5 -> phone app (TFLite model on the phone).
Training data:      WISDM v2 raw WATCH accelerometer + gyroscope (wrist placement
                    matches the Galaxy Watch 5).

Everything downstream (data prep, model, Android inference) reads its constants
from here so the train-time and run-time contracts can never silently diverge.
"""

from pathlib import Path

# --------------------------------------------------------------------------- #
# Paths
# --------------------------------------------------------------------------- #
# Root of the extracted WISDM dataset (the folder that directly contains
# README.txt, activity_key.txt, raw/, arff_files/). Archived under
# _archive/datasets/ in the Jun 2026 reorg; retraining is reproducibility-only.
WISDM_ROOT = Path(__file__).resolve().parents[2] / "_archive" / "datasets" / "wisdm-dataset"
RAW_WATCH_ACCEL = WISDM_ROOT / "raw" / "watch" / "accel"
RAW_WATCH_GYRO = WISDM_ROOT / "raw" / "watch" / "gyro"

# Where this pipeline writes its outputs.
OUT_DIR = Path(__file__).resolve().parent.parent / "artifacts"
CACHE_NPZ = OUT_DIR / "windows_cache.npz"          # prepared windows (cached)
JUNK_NPZ = OUT_DIR / "junk_cache.npz"              # non-locomotion windows (for
#                                                    threshold tuning / rejection
#                                                    metrics; NEVER trained on)
MODEL_KERAS = OUT_DIR / "har_cnn.keras"            # trained Keras model
MODEL_TFLITE_FLOAT = OUT_DIR / "har_model_float.tflite"
MODEL_TFLITE_INT8 = OUT_DIR / "har_model_int8.tflite"
MODEL_META_JSON = OUT_DIR / "har_model_meta.json"  # input/output contract for Android
CONFUSION_PNG = OUT_DIR / "confusion_matrix.png"

# --------------------------------------------------------------------------- #
# Signal / windowing parameters  (train-time AND run-time must agree)
# --------------------------------------------------------------------------- #
TARGET_HZ = 20            # WISDM native rate. The phone downsamples 50 Hz -> 20 Hz.
WINDOW_SEC = 10.0         # window length in seconds
STEP_SEC = 5.0            # hop between consecutive windows (50% overlap)

WINDOW = int(round(WINDOW_SEC * TARGET_HZ))   # = 200 samples
STEP = int(round(STEP_SEC * TARGET_HZ))       # = 100 samples

# Channel order is a hard contract shared with the Android code. Do not reorder.
CHANNELS = ["ax", "ay", "az", "gx", "gy", "gz"]
N_CHANNELS = len(CHANNELS)

# --------------------------------------------------------------------------- #
# Class definitions
# --------------------------------------------------------------------------- #
# If True, sitting + standing are merged into a single "stationary" class.
# Rationale: a WRIST sensor sees the forearm's gravity vector, not the torso, so
# sitting vs standing is physically near-ambiguous and caps accuracy. Merging
# them into "stationary" is the honest, high-accuracy choice for a watch.
MERGE_STILL = True

# If False, the catch-all "other" class is NOT a model output. The 13 non-
# locomotion activities are dropped from training, and "fake movements" are
# rejected purely by the confidence threshold (open-set rejection). This trades
# explicit junk-class training for much higher accuracy on the real classes.
INCLUDE_OTHER_CLASS = False

OTHER_CLASS = "other"

# WISDM activity letter -> our class name. The locomotion/posture activities are
# kept; every OTHER WISDM activity is folded into "other": these are real wrist
# motions that are NOT locomotion (typing, clapping, eating, etc.), which is
# exactly the "fake movement" we want the model to reject.
if MERGE_STILL:
    LOCOMOTION_MAP = {
        "A": "walking",
        "B": "jogging",
        "C": "stairs",
        "D": "stationary",
        "E": "stationary",
    }
    CLASS_NAMES = ["walking", "jogging", "stairs", "stationary"]
else:
    LOCOMOTION_MAP = {
        "A": "walking",
        "B": "jogging",
        "C": "stairs",
        "D": "sitting",
        "E": "standing",
    }
    CLASS_NAMES = ["walking", "jogging", "stairs", "sitting", "standing"]

if INCLUDE_OTHER_CLASS:
    CLASS_NAMES = CLASS_NAMES + [OTHER_CLASS]

# Index = model output neuron. Shared with Android.
N_CLASSES = len(CLASS_NAMES)
CLASS_TO_IDX = {name: i for i, name in enumerate(CLASS_NAMES)}

# All 18 WISDM activity letters (from activity_key.txt). Letters not in
# LOCOMOTION_MAP are mapped to "other".
ALL_ACTIVITY_LETTERS = list("ABCDEFGHIJKLMOPQRS")  # note: N is unused in WISDM


def letter_to_class(letter: str) -> str:
    """Map a raw WISDM activity letter to one of CLASS_NAMES."""
    return LOCOMOTION_MAP.get(letter, OTHER_CLASS)


# --------------------------------------------------------------------------- #
# Training parameters
# --------------------------------------------------------------------------- #
SEED = 1337
# Subject-wise split (hold out whole people). Fractions are over the 51 subjects.
TEST_SUBJECT_FRACTION = 0.20
VAL_SUBJECT_FRACTION = 0.15

BATCH_SIZE = 128
EPOCHS = 80
LEARNING_RATE = 1e-3

# "other" is built from 13 activities vs 1 each for the locomotion classes, so it
# is heavily over-represented. We cap how many "other" windows we keep per subject
# to limit imbalance, and additionally use class weights during training.
MAX_OTHER_WINDOWS_PER_SUBJECT = 40

# Augmentation strength (see augment.py). Softened from initial values so the
# gravity-direction posture cue is preserved.
AUG_ROTATION_DEG = 10.0
AUG_ACCEL_NOISE = 0.12
AUG_GYRO_NOISE = 0.03

# EarlyStopping patience (epochs without val improvement).
EARLY_STOP_PATIENCE = 18

# Inference-time confidence threshold: if max softmax probability < this, the
# window is reported as "uncertain" (treated as no confident activity). Tuned on
# the validation set during training; this is the default the Android code uses.
DEFAULT_CONFIDENCE_THRESHOLD = 0.60
