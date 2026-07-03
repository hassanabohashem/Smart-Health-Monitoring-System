"""
Eval helper: run the held-out evaluation against the freshly retrained
ensemble and produce a clean comparison against the original v2_ensemble_ssl
numbers.

Output: writes `output/results/v2_ens_holdout.json` and prints a comparison
table that can be pasted directly into RESULTS.md.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evaluate import run_full_evaluation
from config import RESULTS_DIR, ENSEMBLE_DIR


NEW_MANIFEST = os.path.join(ENSEMBLE_DIR, "v2_ens_manifest.txt")
ORIG_RESULTS = os.path.join(RESULTS_DIR, "v2_ensemble_ssl.json")
NEW_RESULTS = os.path.join(RESULTS_DIR, "v2_ens_holdout.json")


def _safe(d: dict | None, *path):
    cur = d
    for p in path:
        if cur is None:
            return None
        cur = cur.get(p) if isinstance(cur, dict) else None
    return cur


def main():
    if not os.path.exists(NEW_MANIFEST):
        print(f"ERROR: New ensemble manifest not found at {NEW_MANIFEST}.")
        print("Make sure `python run_pipeline.py --stage ensemble` finished successfully.")
        sys.exit(1)

    print(f"Running full eval on {NEW_MANIFEST}...")
    new = run_full_evaluation(NEW_MANIFEST, out_json=NEW_RESULTS, verbose=True)

    print()
    print("=" * 78)
    print("HOLD-OUT vs ORIGINAL — apples-to-apples comparison")
    print("=" * 78)

    if not os.path.exists(ORIG_RESULTS):
        print(f"WARNING: original {ORIG_RESULTS} not found, only new run reported.")
        orig = None
    else:
        with open(ORIG_RESULTS, "r", encoding="utf-8") as f:
            orig = json.load(f)

    rows = []
    rows.append(("DS2 macro-F1 (4-class)",
                 _safe(orig, "ds2", "macro_f1_4class"),
                 _safe(new, "ds2", "macro_f1_4class")))
    rows.append(("DS2 macro-F1 (3-class)",
                 _safe(orig, "ds2", "macro_f1_3class"),
                 _safe(new, "ds2", "macro_f1_3class")))
    rows.append(("DS2 N-recall",
                 _safe(orig, "ds2", "per_class", "N", "recall"),
                 _safe(new, "ds2", "per_class", "N", "recall")))
    rows.append(("DS2 S-recall",
                 _safe(orig, "ds2", "per_class", "S", "recall"),
                 _safe(new, "ds2", "per_class", "S", "recall")))
    rows.append(("DS2 V-recall",
                 _safe(orig, "ds2", "per_class", "V", "recall"),
                 _safe(new, "ds2", "per_class", "V", "recall")))
    rows.append(("DS2 F-recall",
                 _safe(orig, "ds2", "per_class", "F", "recall"),
                 _safe(new, "ds2", "per_class", "F", "recall")))
    rows.append(("CinC Lead-I beat N-recall (ALL records, leakage)",
                 _safe(orig, "cinc_leadI", "lead_i_n_recall_beat_level"),
                 _safe(new, "cinc_leadI", "lead_i_n_recall_beat_level")))
    rows.append(("CinC record N-dominance (ALL records)",
                 _safe(orig, "cinc_leadI", "record_level_n_dominance"),
                 _safe(new, "cinc_leadI", "record_level_n_dominance")))
    # Honest numbers
    rows.append(("CinC Lead-I beat N-recall (HELD-OUT only)",
                 None,
                 _safe(new, "cinc_leadI_holdout", "lead_i_n_recall_beat_level")))
    rows.append(("CinC record N-dominance (HELD-OUT only)",
                 None,
                 _safe(new, "cinc_leadI_holdout", "record_level_n_dominance")))

    def fmt(v):
        if v is None:
            return "  --  "
        return f"{v:.4f}"

    print()
    print(f"  {'Metric':<55}  {'Original':>10}  {'New':>10}  {'Delta':>10}")
    print(f"  {'-' * 55}  {'-' * 10}  {'-' * 10}  {'-' * 10}")
    for label, orig_v, new_v in rows:
        if orig_v is not None and new_v is not None:
            delta = f"{new_v - orig_v:+.4f}"
        else:
            delta = "  --  "
        print(f"  {label:<55}  {fmt(orig_v):>10}  {fmt(new_v):>10}  {delta:>10}")

    print()
    print(f"Results JSON: {NEW_RESULTS}")
    print(f"Holdout records evaluated: "
          f"{_safe(new, 'cinc_leadI_holdout', 'holdout_n_record_count')}")


if __name__ == "__main__":
    main()
