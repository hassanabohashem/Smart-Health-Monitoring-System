"""
Central configuration for ECG TinyML Classifier - v2.

v2 changes from v1:
  - Adds Lead-I CinC-augmentation parameters (Priority 1)
  - Adds SSL pre-training parameters (Priority 2)
  - Adds multi-task joint training parameters (Priority 3)
  - Adds ensemble parameters (Priority 4)
  - Adds Focal + SWA polish parameters (Priority 6)
  - Disables in-DS1 F-class synthesis (proven harmful in v1)
  - Disables F-vs-V auxiliary head by default (proven harmful in v1)

All hyperparameters, seeds, paths, splits, AAMI mappings.
"""
import os
import random
import numpy as np
import torch

# --- Reproducibility --------------------------------------------------------
SEED_NUMPY = 42
SEED_TORCH = 42
SEED_PYTHON = 42
ENSEMBLE_SEEDS = [42, 101, 202, 303, 404]   # Priority 4: ensemble seeds

def set_seeds(seed=None):
    s = seed if seed is not None else SEED_TORCH
    random.seed(s)
    np.random.seed(s)
    torch.manual_seed(s)
    torch.cuda.manual_seed_all(s)
    torch.backends.cudnn.deterministic = True
    torch.backends.cudnn.benchmark = False

# --- Paths ------------------------------------------------------------------
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(ROOT_DIR, "data")
MITDB_DIR = os.path.join(DATA_DIR, "mitdb")
NSTDB_DIR = os.path.join(DATA_DIR, "nstdb")
INCART_DIR = os.path.join(DATA_DIR, "incart2", "files")   # full-download location
CINC2017_DIR = os.path.join(DATA_DIR, "cinc2017")
CACHE_DIR = os.path.join(ROOT_DIR, "cache")
OUTPUT_DIR = os.path.join(ROOT_DIR, "output")
CHECKPOINT_DIR = os.path.join(OUTPUT_DIR, "checkpoints")
RESULTS_DIR = os.path.join(OUTPUT_DIR, "results")
ENSEMBLE_DIR = os.path.join(CHECKPOINT_DIR, "ensemble")
SSL_DIR = os.path.join(CHECKPOINT_DIR, "ssl")

for _d in [CACHE_DIR, OUTPUT_DIR, CHECKPOINT_DIR, RESULTS_DIR, ENSEMBLE_DIR, SSL_DIR]:
    os.makedirs(_d, exist_ok=True)

# --- Signal -----------------------------------------------------------------
ORIGINAL_FS = 360
TARGET_FS = 128
BEAT_WINDOW_SAMPLES = 128
BEAT_WINDOW_LEFT = 48       # 375 ms pre-R
BEAT_WINDOW_RIGHT = 80      # 625 ms post-R

# --- Filtering --------------------------------------------------------------
BANDPASS_LOW = 0.67
BANDPASS_HIGH = 40.0
BANDPASS_ORDER = 4
NOTCH_FREQ = 50
NOTCH_Q = 30

# --- AAMI mapping -----------------------------------------------------------
AAMI_MAPPING = {
    'N': 'N', 'L': 'N', 'R': 'N', 'e': 'N', 'j': 'N',
    'A': 'S', 'a': 'S', 'J': 'S', 'S': 'S',
    'V': 'V', 'E': 'V',
    'F': 'F',
}
EXCLUDED_SYMBOLS = {'/', 'f', 'Q'}
NON_BEAT_SYMBOLS = {'+', '~', '|', 'x', '"', '!', '[', ']', 'p', 't', 'u',
                     '`', "'", '^', '(', ')', 's', 'T', '*', 'D', '=',
                     '@', '#', '%'}
AAMI_CLASSES = ['N', 'S', 'V', 'F']
NUM_CLASSES = 4
CLASS_TO_IDX = {c: i for i, c in enumerate(AAMI_CLASSES)}
IDX_TO_CLASS = {i: c for i, c in enumerate(AAMI_CLASSES)}

# --- Inter-patient split (de Chazal 2004) -----------------------------------
PACED_RECORDS = {102, 104, 107, 217}
DS1_RECORDS = [101, 106, 108, 109, 112, 114, 115, 116, 118, 119, 122, 124,
               201, 203, 205, 207, 208, 209, 215, 220, 223, 230]
DS2_RECORDS = [100, 103, 105, 111, 113, 117, 121, 123, 200, 202, 210, 212,
               213, 214, 219, 221, 222, 228, 231, 232, 233, 234]
VAL_RECORDS = [114, 124, 207, 223]
TRAIN_RECORDS = [r for r in DS1_RECORDS if r not in VAL_RECORDS]

# --- CinC 2017 train/eval split (added in audit fix) -----------------------
# Holds out 20% of CinC Normal records from the supervised augmentation pool,
# so the Lead-I N-recall metric in evaluate.py can be reported on records the
# model has not seen during supervised training. The hold-out is deterministic:
# every fifth record by sorted record-id (A00005, A00010, A00015, ...) is
# reserved for evaluation only.
#
# Set CINC_HOLDOUT_ENABLED = False to reproduce the original v2 numbers
# (evaluation on the same records the model trained on, leakage acknowledged).
CINC_HOLDOUT_ENABLED = True
CINC_HOLDOUT_FRACTION = 0.20         # 20% of CinC N records held out
CINC_HOLDOUT_STRIDE = 5              # every 5th record by sorted id → ≈20%
CINC_HOLDOUT_SEED = 1337             # only used if a non-stride strategy is added

# --- Class imbalance --------------------------------------------------------
N_UNDERSAMPLE_RATIO = 0.6
CLASS_WEIGHT_CAP = 50.0
MIXUP_ALPHA = 0.2
MIXUP_TARGET_COUNT = 2000   # per minority class

# --- Model architecture (v1 proven) ------------------------------------------
RR_FEATURE_DIM = 4
CONV1_CHANNELS = 24
CONV1_KERNEL = 7
CONV2_CHANNELS = 48
CONV2_KERNEL = 5
CONV3_CHANNELS = 48
CONV3_KERNEL = 3
FC_HIDDEN = 48
DROPOUT_RATE = 0.3
USE_FV_HEAD_DEFAULT = False   # v1 experiment: harmful; keep OFF by default

# --- Knowledge distillation (kept for completeness; KD disabled by default v2) --
KD_ALPHA = 0.5
KD_TEMPERATURE = 4.0
TEACHER_MODEL_NAME = "PKUDigitalHealth/ECGFounder"
TEACHER_CHECKPOINT = os.path.join(CACHE_DIR, "hf", "models--PKUDigitalHealth--ECGFounder", "snapshots")
TEACHER_LOGITS_CACHE = os.path.join(CACHE_DIR, "teacher_logits.npz")
TEACHER_FEATURES_CACHE = os.path.join(CACHE_DIR, "teacher_features.npz")
TEACHER_FEATURE_DIM = 1024
TEACHER_INPUT_FS = 500
TEACHER_INPUT_SAMPLES = 5000
TEACHER_BEAT_WINDOW_LEFT = 2000
TEACHER_BEAT_WINDOW_RIGHT = 3000
KD_FEATURE_PROJ_DIM = 64
KD_FEATURE_WEIGHT = 0.2
KD_FV_WEIGHT = 0.0            # v1 experiment: harmful

# --- Training ---------------------------------------------------------------
BATCH_SIZE = 64
LEARNING_RATE = 1e-3
WEIGHT_DECAY = 1e-5
LR_SCHEDULER = "plateau"
LR_PATIENCE = 5
LR_FACTOR = 0.5
EARLY_STOP_PATIENCE = 15
MAX_EPOCHS = 100
GRAD_CLIP_NORM = 5.0
LABEL_SMOOTHING = 0.05
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# --- Augmentation -----------------------------------------------------------
AUG_TIME_SHIFT_MAX = 10
AUG_AMPLITUDE_SCALE = (0.9, 1.1)
AUG_GAUSSIAN_NOISE_STD = 0.01
AUG_NSTDB_INJECT_PROB = 0.1
AUG_NSTDB_SNR_RANGE = (6, 24)
AUG_LEAD_SYNTH_PROB = 0.4                        # inherited from v1 aug
AUG_LEAD_SYNTH_ANGLE_RANGE = (-30, 90)           # inherited from v1 aug

# --- Priority 1: Lead-I CinC augmentation -----------------------------------
USE_CINC_N_AUGMENTATION = True
CINC_N_BEAT_WEIGHT = 0.3           # sample weight vs MIT-BIH N beats
CINC_PREMATURITY_RR_LOW = 0.80     # exclude beat if RR < 0.8 * median
CINC_PREMATURITY_RR_HIGH = 1.20    # exclude beat if RR > 1.2 * median
CINC_N_MAX_RECORDS = None          # None = all N-labeled CinC records
CINC_N_MAX_BEATS_PER_RECORD = 80   # cap beats per record to avoid dominance
CINC_N_CACHE_PATH = os.path.join(CACHE_DIR, "cinc_n_beats.npz")

# --- Priority 2: SSL masked-autoencoder pre-training ------------------------
USE_SSL_PRETRAIN = True
SSL_MASK_RATIO = 0.25              # fraction of each beat masked out
SSL_MASK_BLOCK_LEN = 16            # samples per contiguous mask block
SSL_BATCH_SIZE = 128
SSL_LR = 3e-4
SSL_EPOCHS = 25
SSL_WEIGHT_DECAY = 1e-5
SSL_DECODER_CHANNELS = 24
SSL_CACHE_PATH = os.path.join(CACHE_DIR, "cinc_ssl_beats.npz")
SSL_CHECKPOINT = os.path.join(SSL_DIR, "ssl_encoder.pt")
SSL_MAX_RECORDS = None             # all CinC records (8,528)
SSL_MAX_BEATS_PER_RECORD = 60

# --- Priority 3: Multi-task joint training ----------------------------------
USE_MULTITASK = False              # OFF by default; opt-in via run flag
MT_RHYTHM_CLASSES = ['N', 'A', 'O', '~']
MT_ALPHA_BEAT = 0.7                # weight of beat (AAMI) loss
MT_ALPHA_RHYTHM = 0.3              # weight of rhythm (CinC) loss

# --- Priority 4: Ensemble ---------------------------------------------------
USE_ENSEMBLE = True
ENSEMBLE_SIZE = 3                   # number of seeds to train
ENSEMBLE_AVG = "softmax"            # "softmax" or "logits"

# --- Priority 6: Focal + SWA -----------------------------------------------
USE_FOCAL_LOSS = True
FOCAL_GAMMA = 2.0
USE_SWA = True
SWA_START_FRAC = 0.7                # begin averaging in last 30% of epochs
SWA_LR = 5e-4

# --- Evaluation -------------------------------------------------------------
NSTDB_SNR_LEVELS = [24, 18, 12, 6]

# --- SQI --------------------------------------------------------------------
SQI_REJECTION_THRESHOLD = 0.5

# --- Deployment constraints -------------------------------------------------
MAX_PARAMS = 50_000
MAX_MODEL_SIZE_FP32_KB = 200
MAX_MODEL_SIZE_INT8_KB = 80
MAX_ACTIVATION_MEMORY_KB = 16
MAX_TOTAL_RAM_KB = 32
MAX_INFERENCE_LATENCY_MS = 50
ARM_LATENCY_SCALE = 2.5              # CPU -> ARM Cortex-A scaling

# --- INT8 PTQ ---------------------------------------------------------------
PTQ_CALIBRATION_SIZE = 500
PTQ_MACRO_F1_DROP_THRESHOLD = 0.02

# --- Streaming --------------------------------------------------------------
RING_BUFFER_SECONDS = 10
TEMPORAL_SMOOTHING_WINDOW = 5
