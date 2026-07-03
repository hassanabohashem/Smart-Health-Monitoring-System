"""
fuse_barometer_data.py
------------------------
Extracts and synchronizes Accelerometer, Gyroscope, and Barometer data from the FallAllD dataset.

Challenge:
- Accel (_A) and Gyro (_G) are sampled at ~238 Hz.
- Barometer (_B) is sampled at ~24 Hz.
- We must time-align and interpolate the Barometer data to match the IMU frequency before extracting the 2-second windows.
"""

import os
import glob
import numpy as np
from scipy.interpolate import interp1d

RAW_DIR = os.path.join(os.path.dirname(__file__), "..", "FallAllD")
OUT_BASE = os.path.join(os.path.dirname(__file__), "..", "data", "fused")
WINDOW_SIZE = 200  # 2 seconds at 100 Hz (Downsampled final rate)
FALL_MIN_ACTIVITY = 101 # A101..A135 are falls

def load_dat(path):
    rows = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            parts = line.split(",")
            if len(parts) >= 2:
                try:
                    rows.append([float(p) for p in parts])
                except ValueError:
                    continue
    return np.array(rows, dtype=np.float32)

def extract_and_fuse(device_code):
    print(f"Fusing Barometer + IMU for: {device_code}")

    accel_files = sorted(glob.glob(os.path.join(RAW_DIR, f"*_{device_code}_*_A.dat")))

    X_list, y_list, subj_list, action_list = [], [], [], []
    skipped_missing = 0
    skipped_short = 0

    for acc_path in accel_files:
        base = os.path.basename(acc_path)
        parts = base.split("_")
        # File pattern: S{nn}_D{n}_A{nnn}_T{nn}_{X}.dat
        subject = parts[0]            # e.g. "S01"
        action_num = int(parts[2][1:])

        gyr_path = acc_path.replace("_A.dat", "_G.dat")
        bar_path = acc_path.replace("_A.dat", "_B.dat")

        if not os.path.exists(gyr_path) or not os.path.exists(bar_path):
            skipped_missing += 1
            continue

        acc = load_dat(acc_path)
        gyr = load_dat(gyr_path)
        bar = load_dat(bar_path)
        
        # Ensure we have data
        if len(acc) == 0 or len(gyr) == 0 or len(bar) == 0:
            skipped_short += 1
            continue

        # In FallAllD, _A and _G are implicitly time-aligned (same length approx).
        # _B is much shorter. We will create a synthetic time axis for interpolation.
        min_imu_len = min(len(acc), len(gyr))
        acc = acc[:min_imu_len]
        gyr = gyr[:min_imu_len]
        
        # FallAllD IMU is ~238Hz. Barometer is ~24Hz.
        # We assume they start and stop at roughly the same time.
        imu_time = np.linspace(0, 1, min_imu_len)
        bar_time = np.linspace(0, 1, len(bar))
        
        # We want to interpolate Barometer's first column (Pressure) to match IMU length
        # Bar format: [Pressure, Temperature]
        bar_pressure = bar[:, 0]
        
        interpolator = interp1d(bar_time, bar_pressure, kind='linear', fill_value="extrapolate")
        bar_upsampled = interpolator(imu_time)
        bar_upsampled = bar_upsampled.reshape(-1, 1)

        # Fuse! Shape: (min_imu_len, 7) -> [Ax, Ay, Az, Gx, Gy, Gz, Bar]
        # acc/gyr format: [x, y, z]
        fused_raw = np.hstack([acc[:, :3], gyr[:, :3], bar_upsampled])

        # Downsample from ~238Hz -> 100Hz to match our architecture's expected input rate
        downsample_factor = int(238 / 100) # Simple decimation for speed, since IMU is oversampled
        fused = fused_raw[::downsample_factor]

        if len(fused) < WINDOW_SIZE + 50:
            skipped_short += 1
            continue
            
        # Find peak acceleration (Impact point)
        acc_mag = np.linalg.norm(fused[:, :3], axis=1)
        peak_idx = np.argmax(acc_mag)
        
        # Extract window around the peak
        # Center the peak at 1.5 seconds into the 2.0 second window (sample 150)
        start_idx = peak_idx - 150
        end_idx = start_idx + WINDOW_SIZE
        
        if start_idx < 0 or end_idx > len(fused):
            # If peak is too close to edges, try shifting
            if len(fused) >= WINDOW_SIZE:
                # Just take the fattest window if we can't center
                start_idx = max(0, peak_idx - 150)
                end_idx = start_idx + WINDOW_SIZE
                if end_idx > len(fused):
                    end_idx = len(fused)
                    start_idx = end_idx - WINDOW_SIZE
            else:
                skipped_short += 1
                continue

        window = fused[start_idx:end_idx]
        
        label = 1 if action_num >= FALL_MIN_ACTIVITY else 0
        X_list.append(window)
        y_list.append(label)
        subj_list.append(subject)
        action_list.append(action_num)

    print(f"Skipped missing files: {skipped_missing}")
    print(f"Skipped short files: {skipped_short}")
    print(f"Total extracted: {len(X_list)}")

    if len(X_list) == 0:
        return

    X = np.array(X_list, dtype=np.float32)
    y = np.array(y_list, dtype=np.float32)
    subjects = np.array(subj_list)            # dtype="<U3" e.g. "S01"
    actions = np.array(action_list, dtype=np.int32)

    out_dir = os.path.join(OUT_BASE, device_code)
    os.makedirs(out_dir, exist_ok=True)
    np.save(os.path.join(out_dir, "X.npy"), X)
    np.save(os.path.join(out_dir, "y.npy"), y)
    np.save(os.path.join(out_dir, "subjects.npy"), subjects)
    np.save(os.path.join(out_dir, "actions.npy"), actions)
    unique_subjects = sorted(set(subj_list))
    print(f"Saved shapes - X: {X.shape}, y: {y.shape}, subjects: {subjects.shape} ({len(unique_subjects)} unique) to {out_dir}")
    print(f"  Subjects: {', '.join(unique_subjects)}\n")

if __name__ == "__main__":
    import sys
    devices = sys.argv[1:] if len(sys.argv) > 1 else ["D1", "D2", "D3"]
    for device in devices:
        extract_and_fuse(device)
