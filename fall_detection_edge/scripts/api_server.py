import os
import json
import time
import uvicorn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
import numpy as np
import torch
import torch.nn as nn
from typing import List, Literal, Optional
import sys
sys.path.append(os.path.join(os.path.dirname(__file__), ".."))

from models.fusion_model import BarometerFusionNet

# --- Initialization & Globals -------------------------------------------------
app = FastAPI(
    title="Smart Health Monitoring - Wrist FusionNet Fall Detection API",
    description=(
        "Wrist-mounted IMU+barometer fall-detection endpoint. Uses the honest "
        "subject-disjoint FusionNet checkpoint (9-fold LOSO macro-AUC 0.971). "
        "Waist and neck specialists were retired post-audit (their pre-audit "
        "weights are preserved in `_archive/legacy_models/fall_detection_edge/`)."
    ),
    version="3.1.0-wrist-only"
)

# Allow the dashboard HTML (opened from file:// or any origin) to call the API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

_DASHBOARD_FILE = os.path.join(os.path.dirname(__file__), "..", "dashboard.html")

# Mount static files to serve the dashboard from root
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "..")), name="static")

@app.get("/")
async def serve_dashboard():
    if os.path.exists(_DASHBOARD_FILE):
        return FileResponse(_DASHBOARD_FILE, media_type="text/html")
    else:
        return HTMLResponse(content="<h1>Dashboard file not found</h1><p>Expected to be in the parent directory of this script.</p>", status_code=404)

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")

_MODEL_FILES = {
    # Wrist is the only post-audit honest checkpoint (subject-disjoint
    # training, honest 9-fold LOSO macro-AUC 0.971). Waist and neck
    # placements were retired post-audit — their pre-audit weights
    # (broken methodology: leaky train/test split, best-checkpoint-on-test)
    # are preserved in `_archive/legacy_models/fall_detection_edge/`.
    "wrist": "fusion/FusionNet_Wrist_honest.pth",
}

# --- Load adaptive thresholds from thresholds.json ----------------------------
_THRESHOLD_FILE = os.path.join(MODELS_DIR, "thresholds.json")
_DEFAULT_THRESHOLD = 0.50

def _load_thresholds() -> dict:
    if os.path.exists(_THRESHOLD_FILE):
        with open(_THRESHOLD_FILE, "r") as f:
            data = json.load(f)
        thresholds = data.get("thresholds", {})
        print("[INFO] Adaptive thresholds loaded from thresholds.json:")
        for placement, t in thresholds.items():
            print(f"   [{placement}]  threshold = {t:.2f}")
        return thresholds
    else:
        print(f"[WARNING] thresholds.json not found — using default threshold {_DEFAULT_THRESHOLD} for all placements.")
        return {}

THRESHOLDS: dict = _load_thresholds()

def get_threshold(placement: str) -> float:
    """Return the tuned threshold for a placement, falling back to 0.5."""
    return THRESHOLDS.get(placement.lower(), _DEFAULT_THRESHOLD)


# --- Load models --------------------------------------------------------------
models = {}

def _load_model(name: str, path: str):
    """Load a BarometerFusionNet from a .pth file."""
    try:
        m = BarometerFusionNet(imu_channels=6, baro_channels=1)
        m.load_state_dict(torch.load(path, weights_only=True, map_location="cpu"))
        m.eval()
        print(f"[SUCCESS] Loaded [{name}] from {path}  (threshold={get_threshold(name):.2f})")
        return m
    except Exception as e:
        print(f"[WARNING] Could not load [{name}] from {path}: {e}")
        return None

for placement, filename in _MODEL_FILES.items():
    fpath = os.path.join(MODELS_DIR, filename)
    models[placement] = _load_model(placement, fpath)

loaded_count = sum(1 for m in models.values() if m is not None)
print(f"\n[INFO] API ready: {loaded_count}/{len(_MODEL_FILES)} FusionNet model(s) loaded.")

# --- Load per-placement scalers -----------------------------------------------
import joblib
scalers = {}
_SCALER_FILES = {"wrist": "fusion/scaler_Wrist_honest.joblib"}
for _p, _sf in _SCALER_FILES.items():
    _sp = os.path.join(MODELS_DIR, _sf)
    if os.path.exists(_sp):
        scalers[_p] = joblib.load(_sp)
        print(f"  [scaler] Loaded {_sf}")
    else:
        scalers[_p] = None
        print(f"  [scaler] {_sf} not found — no normalization for {_p}")


# --- Preload real test samples for the demo endpoint -------------------------
# Load 7-channel fused data (IMU+Baro) from data/fused/ — these match FusionNet's input.
# D1=Waist, D2=Wrist, D3=Neck. Each file is (N, 200, 7).
# IMPORTANT: We use the SAME train_test_split(random_state=42) as the training
# script to guarantee the dashboard only serves truly unseen test data.

from sklearn.model_selection import train_test_split as _tts

_FUSED_ROOT  = os.path.join(os.path.dirname(__file__), "../data/fused")
_SAMPLE_BUF_SIZE = 200   # keep up to this many ADL + Fall indices per placement

# Wrist-only post-audit (D2 = wrist FallAllD device). D1/D3 (waist/neck)
# fused arrays are no longer loaded since the dev API only exposes wrist.
_FUSED_DIRS = {"wrist": "D2"}

# Structure: { "wrist": {"adl": np.ndarray (N,200,7), "fall": np.ndarray (M,200,7)} }
_test_samples: dict = {}

for _px, _dname in _FUSED_DIRS.items():
    _dir = os.path.join(_FUSED_ROOT, _dname)
    try:
        _X = np.load(os.path.join(_dir, "X.npy"), mmap_mode='r')
        _y = np.load(os.path.join(_dir, "y.npy"), mmap_mode='r')
        # Same split as training: test_size=0.2, random_state=42, stratify=y
        _, _X_test, _, _y_test = _tts(_X, _y, test_size=0.2, random_state=42, stratify=_y)
        _adl_idx  = np.where(_y_test == 0)[0]
        _fall_idx = np.where(_y_test == 1)[0]
        np.random.shuffle(_adl_idx)
        np.random.shuffle(_fall_idx)
        _test_samples[_px] = {
            "adl":  _X_test[_adl_idx[:_SAMPLE_BUF_SIZE]].copy(),
            "fall": _X_test[_fall_idx[:_SAMPLE_BUF_SIZE]].copy(),
        }
        print(f"  [{_px}] demo samples (unseen test set): {len(_adl_idx[:_SAMPLE_BUF_SIZE])} ADL, {len(_fall_idx[:_SAMPLE_BUF_SIZE])} Fall")
    except Exception as _e:
        print(f"  [{_px}] could not load fused samples: {_e}")
        _test_samples[_px] = {"adl": None, "fall": None}

print("Demo sample buffers ready (same split as training, random_state=42).")




# --- API Data Schemas ---------------------------------------------------------
class IMUSensorReading(BaseModel):
    acc_x:  float
    acc_y:  float
    acc_z:  float
    gyro_x: float
    gyro_y: float
    gyro_z: float
    baro:   float = Field(default=1013.25, description="Barometer atmospheric pressure reading")

class FallDetectionRequest(BaseModel):
    device_id: str = Field(..., example="SmartWatch_User01")
    timestamp: int = Field(..., description="Unix timestamp of the event buffer")
    device_placement: Literal["wrist"] = Field(
        default="wrist",
        description="Sensor placement on body. Only 'wrist' is supported post-audit; waist and neck specialists were retired."
    )
    sequence: List[IMUSensorReading] = Field(..., min_length=200, max_length=200)

class FallDetectionResponse(BaseModel):
    is_fall:        bool
    confidence:     float
    threshold_used: float
    placement_used: str
    message:        str


# --- Endpoints ----------------------------------------------------------------
@app.post("/api/v1/detect_fall", response_model=FallDetectionResponse)
async def detect_fall(payload: FallDetectionRequest):
    """
    Detect a fall event from 100 sequential 6-axis IMU readings.
    Routes to the specialist model based on `device_placement` and applies
    a placement-specific tuned decision threshold.
    """
    placement = payload.device_placement.lower()
    model     = models.get(placement)
    threshold = get_threshold(placement)

    if model is None:
        raise HTTPException(
            status_code=503,
            detail=f"Model for placement '{placement}' is not available. Check server logs."
        )

    try:
        # Convert JSON List → NumPy (200, 7)
        raw_data = np.array([
            [r.acc_x, r.acc_y, r.acc_z, r.gyro_x, r.gyro_y, r.gyro_z, r.baro]
            for r in payload.sequence
        ], dtype=np.float32)

        # Normalise using the saved per-placement StandardScaler
        # (trained on the same dataset split as the model)
        scaler = scalers.get(placement)
        if scaler is not None:
            raw_data = scaler.transform(raw_data)

        # Split into Dual-Streams
        imu_data = raw_data[:, :6]
        baro_data = raw_data[:, 6:]

        # PyTorch inference (Batch, Channels, SeqLen)
        tensor_imu = torch.tensor(imu_data, dtype=torch.float32).transpose(0, 1).unsqueeze(0)
        tensor_baro = torch.tensor(baro_data, dtype=torch.float32).transpose(0, 1).unsqueeze(0)
        
        with torch.no_grad():
            output      = model(tensor_imu, tensor_baro)
            probability = float(torch.softmax(output, dim=1)[:, 1].item())
            is_fall     = probability > threshold

        return FallDetectionResponse(
            is_fall        = is_fall,
            confidence     = round(probability, 4),
            threshold_used = threshold,
            placement_used = placement,
            message        = "Fall detected! Trigger SOS." if is_fall else "Normal activity. No fall detected.",
        )

    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Inference error: {str(e)}")




@app.get("/health")
async def health_check():
    return {
        "status":        "ok",
        "models_loaded": {p: (m is not None) for p, m in models.items()},
        "thresholds":    {p: get_threshold(p) for p in models},
    }

@app.get("/api/v1/models")
async def list_models():
    """List all available placement models, their load status, and active thresholds."""
    return {
        "available_placements": list(_MODEL_FILES.keys()),
        "loaded":     {p: (m is not None) for p, m in models.items()},
        "thresholds": {p: get_threshold(p) for p in models},
    }


@app.get("/dashboard", include_in_schema=False)
async def serve_dashboard():
    """Serve the interactive fall detection demo dashboard."""
    if os.path.exists(_DASHBOARD_FILE):
        return FileResponse(_DASHBOARD_FILE, media_type="text/html")
    raise HTTPException(status_code=404, detail="dashboard.html not found")


@app.get("/api/v1/sample")
async def get_sample(
    placement: Literal["wrist"] = Query(
        default="wrist",
        description="Sensor placement to sample from. Only 'wrist' is supported post-audit."
    ),
    type: Literal["adl", "fall"] = Query(
        default="adl",
        description="Event type: 'adl' for normal activity, 'fall' for a fall event."
    )
):
    """
    Return a single real IMU window from the FallAllD held-out test set.
    The response is a complete payload ready to POST to /api/v1/detect_fall.

    Use this in demos/dashboards instead of synthetic data — real samples
    correctly reflect the training distribution of each specialist model.
    """
    buf = _test_samples.get(placement, {}).get(type)
    if buf is None or len(buf) == 0:
        raise HTTPException(
            status_code=503,
            detail=f"No '{type}' samples available for placement '{placement}'. "
                   "Check that FallAllD test data is present in data/processed/."
        )

    # Pick a random window from the buffer
    idx = int(np.random.randint(0, len(buf)))
    window = buf[idx]  # shape (200, 7): columns = acc_x, acc_y, acc_z, gyro_x, gyro_y, gyro_z, baro

    sequence = []
    for i in range(200):
        frame = {
            "acc_x":  round(float(window[i, 0]), 6),
            "acc_y":  round(float(window[i, 1]), 6),
            "acc_z":  round(float(window[i, 2]), 6),
            "gyro_x": round(float(window[i, 3]), 6),
            "gyro_y": round(float(window[i, 4]), 6),
            "gyro_z": round(float(window[i, 5]), 6),
            "baro":   round(float(window[i, 6]), 6),
        }
        sequence.append(frame)

    return {
        "device_id":        f"Demo_{placement.capitalize()}_RealSample",
        "device_placement": placement,
        "timestamp":        int(time.time()),
        "sequence":         sequence,
        "_meta": {
            "source":     "FallAllD fused dataset (7-channel)",
            "event_type": type,
            "sample_idx": idx,
        }
    }




@app.get("/api/v1/sample_synthetic")
async def get_sample_synthetic(
    type: Literal["walking", "running", "jumping"] = Query(...)
):
    """
    Return a 100-tick (2-second) sequence for demonstration.
    """
    
    seq = [
    {
        "acc_x": -0.770516,
        "acc_y": 0.133048,
        "acc_z": 0.309021,
        "gyro_x": -0.162721,
        "gyro_y": 0.334213,
        "gyro_z": 1.275363
    },
    {
        "acc_x": -0.674855,
        "acc_y": 0.258706,
        "acc_z": 0.362908,
        "gyro_x": -0.173328,
        "gyro_y": 0.33283,
        "gyro_z": 1.327658
    },
    {
        "acc_x": -0.543076,
        "acc_y": 0.366261,
        "acc_z": 0.453246,
        "gyro_x": -0.186829,
        "gyro_y": 0.313469,
        "gyro_z": 1.377338
    },
    {
        "acc_x": -0.417154,
        "acc_y": 0.489789,
        "acc_z": 0.576075,
        "gyro_x": -0.187793,
        "gyro_y": 0.254003,
        "gyro_z": 1.445321
    },
    {
        "acc_x": -0.332229,
        "acc_y": 0.604798,
        "acc_z": 0.697319,
        "gyro_x": -0.174293,
        "gyro_y": 0.177942,
        "gyro_z": 1.518533
    },
    {
        "acc_x": -0.298065,
        "acc_y": 0.68999,
        "acc_z": 0.78211,
        "gyro_x": -0.133791,
        "gyro_y": 0.112944,
        "gyro_z": 1.583902
    },
    {
        "acc_x": -0.297088,
        "acc_y": 0.791155,
        "acc_z": 0.847883,
        "gyro_x": -0.082681,
        "gyro_y": 0.065924,
        "gyro_z": 1.623123
    },
    {
        "acc_x": -0.277566,
        "acc_y": 0.855049,
        "acc_z": 0.900184,
        "gyro_x": -0.032536,
        "gyro_y": 0.020288,
        "gyro_z": 1.657114
    },
    {
        "acc_x": -0.245353,
        "acc_y": 0.869957,
        "acc_z": 0.945354,
        "gyro_x": 0.017609,
        "gyro_y": -0.015669,
        "gyro_z": 1.69895
    },
    {
        "acc_x": -0.198498,
        "acc_y": 0.864633,
        "acc_z": 0.96992,
        "gyro_x": 0.069682,
        "gyro_y": -0.057157,
        "gyro_z": 1.738171
    },
    {
        "acc_x": -0.145787,
        "acc_y": 0.826296,
        "acc_z": 0.973882,
        "gyro_x": 0.121756,
        "gyro_y": -0.093113,
        "gyro_z": 1.769548
    },
    {
        "acc_x": -0.093075,
        "acc_y": 0.745364,
        "acc_z": 0.950108,
        "gyro_x": 0.178651,
        "gyro_y": -0.123537,
        "gyro_z": 1.80354
    },
    {
        "acc_x": -0.044268,
        "acc_y": 0.638874,
        "acc_z": 0.900977,
        "gyro_x": 0.221082,
        "gyro_y": -0.142898,
        "gyro_z": 1.819228
    },
    {
        "acc_x": 0.016253,
        "acc_y": 0.535579,
        "acc_z": 0.85026,
        "gyro_x": 0.256762,
        "gyro_y": -0.152579,
        "gyro_z": 1.840146
    },
    {
        "acc_x": 0.084582,
        "acc_y": 0.409922,
        "acc_z": 0.775771,
        "gyro_x": 0.285692,
        "gyro_y": -0.151196,
        "gyro_z": 1.840146
    },
    {
        "acc_x": 0.166578,
        "acc_y": 0.282134,
        "acc_z": 0.708413,
        "gyro_x": 0.313657,
        "gyro_y": -0.137367,
        "gyro_z": 1.824457
    },
    {
        "acc_x": 0.257359,
        "acc_y": 0.123464,
        "acc_z": 0.645018,
        "gyro_x": 0.339694,
        "gyro_y": -0.104176,
        "gyro_z": 1.772163
    },
    {
        "acc_x": 0.375472,
        "acc_y": -0.025621,
        "acc_z": 0.587962,
        "gyro_x": 0.364767,
        "gyro_y": -0.059922,
        "gyro_z": 1.693721
    },
    {
        "acc_x": 0.504323,
        "acc_y": -0.166188,
        "acc_z": 0.563396,
        "gyro_x": 0.401411,
        "gyro_y": -0.018434,
        "gyro_z": 1.55514
    },
    {
        "acc_x": 0.618531,
        "acc_y": -0.288651,
        "acc_z": 0.562603,
        "gyro_x": 0.451556,
        "gyro_y": 0.01199,
        "gyro_z": 1.411329
    },
    {
        "acc_x": 0.726883,
        "acc_y": -0.446256,
        "acc_z": 0.586377,
        "gyro_x": 0.523881,
        "gyro_y": 0.039649,
        "gyro_z": 1.228298
    },
    {
        "acc_x": 0.83133,
        "acc_y": -0.604926,
        "acc_z": 0.629169,
        "gyro_x": 0.624171,
        "gyro_y": 0.04518,
        "gyro_z": 1.029578
    },
    {
        "acc_x": 0.914302,
        "acc_y": -0.729519,
        "acc_z": 0.698111,
        "gyro_x": 0.761106,
        "gyro_y": 0.017522,
        "gyro_z": 0.851776
    },
    {
        "acc_x": 1.001178,
        "acc_y": -0.881799,
        "acc_z": 0.779733,
        "gyro_x": 0.92697,
        "gyro_y": -0.028115,
        "gyro_z": 0.687048
    },
    {
        "acc_x": 1.077317,
        "acc_y": -1.020236,
        "acc_z": 0.858185,
        "gyro_x": 1.09862,
        "gyro_y": -0.095879,
        "gyro_z": 0.524934
    },
    {
        "acc_x": 1.153456,
        "acc_y": -1.145893,
        "acc_z": 0.918411,
        "gyro_x": 1.239412,
        "gyro_y": -0.18162,
        "gyro_z": 0.310526
    },
    {
        "acc_x": 1.190549,
        "acc_y": -1.266227,
        "acc_z": 0.971504,
        "gyro_x": 1.354167,
        "gyro_y": -0.279808,
        "gyro_z": 0.080429
    },
    {
        "acc_x": 1.212024,
        "acc_y": -1.379106,
        "acc_z": 1.03807,
        "gyro_x": 1.425527,
        "gyro_y": -0.395975,
        "gyro_z": -0.170585
    },
    {
        "acc_x": 1.234476,
        "acc_y": -1.48879,
        "acc_z": 1.094333,
        "gyro_x": 1.456386,
        "gyro_y": -0.541182,
        "gyro_z": -0.374535
    },
    {
        "acc_x": 1.259855,
        "acc_y": -1.588891,
        "acc_z": 1.13871,
        "gyro_x": 1.439992,
        "gyro_y": -0.687773,
        "gyro_z": -0.541878
    },
    {
        "acc_x": 1.284259,
        "acc_y": -1.661304,
        "acc_z": 1.163276,
        "gyro_x": 1.370561,
        "gyro_y": -0.820535,
        "gyro_z": -0.667385
    },
    {
        "acc_x": 1.29402,
        "acc_y": -1.724133,
        "acc_z": 1.161691,
        "gyro_x": 1.249056,
        "gyro_y": -0.897979,
        "gyro_z": -0.732753
    },
    {
        "acc_x": 1.297925,
        "acc_y": -1.767794,
        "acc_z": 1.108597,
        "gyro_x": 1.065833,
        "gyro_y": -0.909042,
        "gyro_z": -0.748442
    },
    {
        "acc_x": 1.322328,
        "acc_y": -1.780572,
        "acc_z": 0.990523,
        "gyro_x": 0.813179,
        "gyro_y": -0.842661,
        "gyro_z": -0.698762
    },
    {
        "acc_x": 1.345756,
        "acc_y": -1.69538,
        "acc_z": 0.832827,
        "gyro_x": 0.497844,
        "gyro_y": -0.690539,
        "gyro_z": -0.61509
    },
    {
        "acc_x": 1.385777,
        "acc_y": -1.522867,
        "acc_z": 0.668791,
        "gyro_x": 0.158401,
        "gyro_y": -0.488631,
        "gyro_z": -0.518345
    },
    {
        "acc_x": 1.494129,
        "acc_y": -1.23854,
        "acc_z": 0.519812,
        "gyro_x": -0.155006,
        "gyro_y": -0.295021,
        "gyro_z": -0.486968
    },
    {
        "acc_x": 1.61517,
        "acc_y": -0.914811,
        "acc_z": 0.415209,
        "gyro_x": -0.419232,
        "gyro_y": -0.159493,
        "gyro_z": -0.591558
    },
    {
        "acc_x": 1.608337,
        "acc_y": -0.607055,
        "acc_z": 0.300305,
        "gyro_x": -0.640063,
        "gyro_y": -0.108325,
        "gyro_z": -0.698762
    },
    {
        "acc_x": 1.481439,
        "acc_y": -0.334442,
        "acc_z": 0.129137,
        "gyro_x": -0.821357,
        "gyro_y": -0.133218,
        "gyro_z": -0.672614
    },
    {
        "acc_x": 1.277426,
        "acc_y": -0.117203,
        "acc_z": -0.126823,
        "gyro_x": -0.986257,
        "gyro_y": -0.17194,
        "gyro_z": -0.536648
    },
    {
        "acc_x": 1.063651,
        "acc_y": 0.053181,
        "acc_z": -0.37882,
        "gyro_x": -1.113548,
        "gyro_y": -0.200981,
        "gyro_z": -0.382379
    },
    {
        "acc_x": 0.83621,
        "acc_y": 0.202267,
        "acc_z": -0.635572,
        "gyro_x": -1.179122,
        "gyro_y": -0.214811,
        "gyro_z": -0.241183
    },
    {
        "acc_x": 0.616579,
        "acc_y": 0.309821,
        "acc_z": -0.853494,
        "gyro_x": -1.199373,
        "gyro_y": -0.199598,
        "gyro_z": -0.07384
    },
    {
        "acc_x": 0.417446,
        "acc_y": 0.37904,
        "acc_z": -1.046058,
        "gyro_x": -1.199373,
        "gyro_y": -0.165025,
        "gyro_z": 0.093503
    },
    {
        "acc_x": 0.238813,
        "acc_y": 0.441868,
        "acc_z": -1.234659,
        "gyro_x": -1.184908,
        "gyro_y": -0.123537,
        "gyro_z": 0.213781
    },
    {
        "acc_x": 0.09532,
        "acc_y": 0.503633,
        "acc_z": -1.417714,
        "gyro_x": -1.164657,
        "gyro_y": -0.061305,
        "gyro_z": 0.307911
    },
    {
        "acc_x": -0.043292,
        "acc_y": 0.569656,
        "acc_z": -1.588089,
        "gyro_x": -1.164657,
        "gyro_y": 0.041032,
        "gyro_z": 0.36805
    },
    {
        "acc_x": -0.134073,
        "acc_y": 0.601603,
        "acc_z": -1.740238,
        "gyro_x": -1.176229,
        "gyro_y": 0.187622,
        "gyro_z": 0.394197
    },
    {
        "acc_x": -0.194594,
        "acc_y": 0.616512,
        "acc_z": -1.872577,
        "gyro_x": -1.19648,
        "gyro_y": 0.367403,
        "gyro_z": 0.391583
    },
    {
        "acc_x": -0.26878,
        "acc_y": 0.636745,
        "acc_z": -1.97084,
        "gyro_x": -1.220588,
        "gyro_y": 0.590055,
        "gyro_z": 0.360206
    },
    {
        "acc_x": -0.354681,
        "acc_y": 0.660172,
        "acc_z": -2.02948,
        "gyro_x": -1.226375,
        "gyro_y": 0.840366,
        "gyro_z": 0.302682
    },
    {
        "acc_x": -0.443509,
        "acc_y": 0.688925,
        "acc_z": -2.064348,
        "gyro_x": -1.22541,
        "gyro_y": 1.107271,
        "gyro_z": 0.21901
    },
    {
        "acc_x": -0.48646,
        "acc_y": 0.721936,
        "acc_z": -2.06831,
        "gyro_x": -1.229267,
        "gyro_y": 1.364497,
        "gyro_z": 0.12488
    },
    {
        "acc_x": -0.548933,
        "acc_y": 0.794349,
        "acc_z": -2.049292,
        "gyro_x": -1.237946,
        "gyro_y": 1.605127,
        "gyro_z": 0.017676
    },
    {
        "acc_x": -0.564551,
        "acc_y": 0.881671,
        "acc_z": -2.008085,
        "gyro_x": -1.251447,
        "gyro_y": 1.827779,
        "gyro_z": -0.094758
    },
    {
        "acc_x": -0.557718,
        "acc_y": 0.981771,
        "acc_z": -1.954198,
        "gyro_x": -1.265912,
        "gyro_y": 2.01724,
        "gyro_z": -0.181044
    },
    {
        "acc_x": -0.51672,
        "acc_y": 1.086131,
        "acc_z": -1.89635,
        "gyro_x": -1.285198,
        "gyro_y": 2.188724,
        "gyro_z": -0.26733
    },
    {
        "acc_x": -0.409344,
        "acc_y": 1.194751,
        "acc_z": -1.8282,
        "gyro_x": -1.313164,
        "gyro_y": 2.325634,
        "gyro_z": -0.343158
    },
    {
        "acc_x": -0.296112,
        "acc_y": 1.319344,
        "acc_z": -1.741823,
        "gyro_x": -1.335343,
        "gyro_y": 2.398929,
        "gyro_z": -0.382379
    },
    {
        "acc_x": -0.201427,
        "acc_y": 1.471624,
        "acc_z": -1.625334,
        "gyro_x": -1.346915,
        "gyro_y": 2.455629,
        "gyro_z": -0.405911
    },
    {
        "acc_x": -0.038411,
        "acc_y": 1.699512,
        "acc_z": -1.346394,
        "gyro_x": -1.327629,
        "gyro_y": 2.414141,
        "gyro_z": -0.36669
    },
    {
        "acc_x": 0.276882,
        "acc_y": 2.030695,
        "acc_z": -0.789306,
        "gyro_x": -1.263983,
        "gyro_y": 2.143087,
        "gyro_z": -0.170585
    },
    {
        "acc_x": 0.714193,
        "acc_y": 2.356554,
        "acc_z": -0.065805,
        "gyro_x": -1.088476,
        "gyro_y": 1.656295,
        "gyro_z": 0.135339
    },
    {
        "acc_x": 1.186645,
        "acc_y": 2.534392,
        "acc_z": 0.64898,
        "gyro_x": -0.749996,
        "gyro_y": 1.029827,
        "gyro_z": 0.357591
    },
    {
        "acc_x": 1.493153,
        "acc_y": 2.464108,
        "acc_z": 1.10622,
        "gyro_x": -0.298691,
        "gyro_y": 0.410274,
        "gyro_z": 0.370665
    },
    {
        "acc_x": 1.51658,
        "acc_y": 2.144639,
        "acc_z": 1.255992,
        "gyro_x": 0.177687,
        "gyro_y": -0.076518,
        "gyro_z": 0.190248
    },
    {
        "acc_x": 1.38773,
        "acc_y": 1.680344,
        "acc_z": 1.213992,
        "gyro_x": 0.614528,
        "gyro_y": -0.429165,
        "gyro_z": -0.011086
    },
    {
        "acc_x": 1.199335,
        "acc_y": 1.222438,
        "acc_z": 1.089579,
        "gyro_x": 0.999295,
        "gyro_y": -0.737559,
        "gyro_z": -0.22288
    },
    {
        "acc_x": 1.006059,
        "acc_y": 0.802869,
        "acc_z": 0.906524,
        "gyro_x": 1.334881,
        "gyro_y": -1.015528,
        "gyro_z": -0.46605
    },
    {
        "acc_x": 0.786427,
        "acc_y": 0.401402,
        "acc_z": 0.641848,
        "gyro_x": 1.593321,
        "gyro_y": -1.246477,
        "gyro_z": -0.758901
    },
    {
        "acc_x": 0.597056,
        "acc_y": 0.067025,
        "acc_z": 0.355776,
        "gyro_x": 1.762078,
        "gyro_y": -1.4553,
        "gyro_z": -1.043907
    },
    {
        "acc_x": 0.449659,
        "acc_y": -0.184291,
        "acc_z": 0.072081,
        "gyro_x": 1.84501,
        "gyro_y": -1.664122,
        "gyro_z": -1.289692
    },
    {
        "acc_x": 0.272001,
        "acc_y": -0.397271,
        "acc_z": -0.191011,
        "gyro_x": 1.852725,
        "gyro_y": -1.843904,
        "gyro_z": -1.470109
    },
    {
        "acc_x": 0.053346,
        "acc_y": -0.541032,
        "acc_z": -0.397839,
        "gyro_x": 1.788115,
        "gyro_y": -1.980814,
        "gyro_z": -1.55378
    },
    {
        "acc_x": -0.17019,
        "acc_y": -0.66669,
        "acc_z": -0.642704,
        "gyro_x": 1.669502,
        "gyro_y": -2.038897,
        "gyro_z": -1.566854
    },
    {
        "acc_x": -0.398607,
        "acc_y": -0.756141,
        "acc_z": -0.794853,
        "gyro_x": 1.527746,
        "gyro_y": -2.033365,
        "gyro_z": -1.530247
    },
    {
        "acc_x": -0.582121,
        "acc_y": -0.805126,
        "acc_z": -0.870928,
        "gyro_x": 1.38599,
        "gyro_y": -1.99326,
        "gyro_z": -1.477953
    },
    {
        "acc_x": -0.798824,
        "acc_y": -0.845592,
        "acc_z": -0.938285,
        "gyro_x": 1.246163,
        "gyro_y": -1.870179,
        "gyro_z": -1.446576
    },
    {
        "acc_x": -0.998933,
        "acc_y": -0.855176,
        "acc_z": -0.899455,
        "gyro_x": 1.116943,
        "gyro_y": -1.694547,
        "gyro_z": -1.389052
    },
    {
        "acc_x": -1.173662,
        "acc_y": -0.86689,
        "acc_z": -0.832098,
        "gyro_x": 1.010867,
        "gyro_y": -1.50232,
        "gyro_z": -1.318454
    },
    {
        "acc_x": -1.309346,
        "acc_y": -0.898837,
        "acc_z": -0.759193,
        "gyro_x": 0.921184,
        "gyro_y": -1.281051,
        "gyro_z": -1.240012
    },
    {
        "acc_x": -1.416721,
        "acc_y": -0.941433,
        "acc_z": -0.668062,
        "gyro_x": 0.835359,
        "gyro_y": -1.033506,
        "gyro_z": -1.179873
    },
    {
        "acc_x": -1.499693,
        "acc_y": -0.968056,
        "acc_z": -0.531762,
        "gyro_x": 0.751462,
        "gyro_y": -0.779047,
        "gyro_z": -1.127578
    },
    {
        "acc_x": -1.532882,
        "acc_y": -1.008522,
        "acc_z": -0.400216,
        "gyro_x": 0.662744,
        "gyro_y": -0.52597,
        "gyro_z": -1.101431
    },
    {
        "acc_x": -1.544596,
        "acc_y": -1.050053,
        "acc_z": -0.297991,
        "gyro_x": 0.547989,
        "gyro_y": -0.265979,
        "gyro_z": -1.10666
    },
    {
        "acc_x": -1.537763,
        "acc_y": -1.067091,
        "acc_z": -0.177539,
        "gyro_x": 0.391768,
        "gyro_y": -0.036413,
        "gyro_z": -1.122349
    },
    {
        "acc_x": -1.501645,
        "acc_y": -1.031949,
        "acc_z": -0.048371,
        "gyro_x": 0.191188,
        "gyro_y": 0.157198,
        "gyro_z": -1.127578
    },
    {
        "acc_x": -1.468457,
        "acc_y": -0.905227,
        "acc_z": 0.076835,
        "gyro_x": -0.018072,
        "gyro_y": 0.303788,
        "gyro_z": -1.077898
    },
    {
        "acc_x": -1.464552,
        "acc_y": -0.760401,
        "acc_z": 0.183023,
        "gyro_x": -0.209973,
        "gyro_y": 0.399211,
        "gyro_z": -1.0073
    },
    {
        "acc_x": -1.479194,
        "acc_y": -0.626224,
        "acc_z": 0.272569,
        "gyro_x": -0.398981,
        "gyro_y": 0.471123,
        "gyro_z": -0.931473
    },
    {
        "acc_x": -1.506526,
        "acc_y": -0.497371,
        "acc_z": 0.342304,
        "gyro_x": -0.583168,
        "gyro_y": 0.538887,
        "gyro_z": -0.829498
    },
    {
        "acc_x": -1.536786,
        "acc_y": -0.391946,
        "acc_z": 0.412832,
        "gyro_x": -0.749996,
        "gyro_y": 0.594204,
        "gyro_z": -0.706606
    },
    {
        "acc_x": -1.567047,
        "acc_y": -0.298235,
        "acc_z": 0.481774,
        "gyro_x": -0.901396,
        "gyro_y": 0.621863,
        "gyro_z": -0.578484
    },
    {
        "acc_x": -1.570951,
        "acc_y": -0.203459,
        "acc_z": 0.536453,
        "gyro_x": -1.028687,
        "gyro_y": 0.63016,
        "gyro_z": -0.445132
    },
    {
        "acc_x": -1.565094,
        "acc_y": -0.127852,
        "acc_z": 0.564188,
        "gyro_x": -1.128977,
        "gyro_y": 0.624628,
        "gyro_z": -0.337928
    },
    {
        "acc_x": -1.56119,
        "acc_y": -0.068217,
        "acc_z": 0.576867,
        "gyro_x": -1.195516,
        "gyro_y": 0.603885,
        "gyro_z": -0.241183
    },
    {
        "acc_x": -1.551429,
        "acc_y": -0.007518,
        "acc_z": 0.57132,
        "gyro_x": -1.231196,
        "gyro_y": 0.585906,
        "gyro_z": -0.181044
    },
    {
        "acc_x": -1.541667,
        "acc_y": 0.048921,
        "acc_z": 0.568151,
        "gyro_x": -1.226375,
        "gyro_y": 0.54027,
        "gyro_z": -0.144438
    },
    {
        "acc_x": -1.564118,
        "acc_y": 0.11388,
        "acc_z": 0.539623,
        "gyro_x": -1.181051,
        "gyro_y": 0.484952,
        "gyro_z": -0.139208
    }
]
    
    # For synthetic walking/running/jumping, preserve the harmonic structure to avoid hitting OOD fall threshold
    if type == 'jumping':
        for i in range(100):
            seq[i]['acc_y'] *= 2.5
            seq[i]['acc_z'] = 1.0 + (seq[i]['acc_z'] - 1.0) * 2.5
    elif type == 'running':
        for i in range(100):
            seq[i]['acc_y'] *= 1.8
            seq[i]['acc_z'] = 1.0 + (seq[i]['acc_z'] - 1.0) * 1.8
    elif type == 'walking':
        for i in range(100):
            # No changes, use the golden template directly
            pass

    # The new FusionNet expects 200 ticks and a `baro` field
    interpolated_seq = []
    for frame in seq:
        frame_copy = frame.copy()
        frame_copy['baro'] = 1013.25 # Standard sea-level pressure (No altitude drop)
        # Duplicate each frame to stretch 100 -> 200
        interpolated_seq.append(frame_copy)
        interpolated_seq.append(frame_copy)

    return {
        "device_id":        f"Demo_Synthetic_{type.capitalize()}",
        "device_placement": "wrist",
        "timestamp":        int(time.time()),
        "sequence":         interpolated_seq,
        "_meta": {
            "source":     "Mathematical Simulator (Template Guided)",
            "event_type": type,
        }
    }

if __name__ == "__main__":
    uvicorn.run("api_server:app", host="0.0.0.0", port=8000, reload=True)
