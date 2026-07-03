"""
Inter-patient dataset split definitions (AAMI standard, de Chazal 2004).

Paced records excluded: 102, 104, 107, 217
Validation carved from DS1 at patient level: {114, 124, 207, 223}

Also exposes the CinC 2017 hold-out split (added as part of the audit fix
to address Lead-I leakage between training augmentation and evaluation).
"""
from config import (DS1_RECORDS, DS2_RECORDS, VAL_RECORDS, TRAIN_RECORDS,
                     PACED_RECORDS,
                     CINC_HOLDOUT_ENABLED, CINC_HOLDOUT_STRIDE)


def get_train_records():
    """DS1 minus validation patients. 18 records."""
    return list(TRAIN_RECORDS)


def get_val_records():
    """4 patient-level records carved from DS1."""
    return list(VAL_RECORDS)


def get_test_records():
    """DS2 — completely held-out patients. 22 records."""
    return list(DS2_RECORDS)


def get_all_ds1_records():
    """Full DS1 (train + val). 22 records."""
    return list(DS1_RECORDS)


def get_paced_records():
    """Records excluded per AAMI standard."""
    return list(PACED_RECORDS)


# ── CinC 2017 hold-out helpers ───────────────────────────────────────────
# Used to address the Lead-I leakage finding from the audit: the original v2
# pipeline used every CinC N-record both for supervised augmentation AND for
# Lead-I evaluation. These helpers carve a deterministic 20% hold-out so the
# Lead-I N-recall metric can be reported on records the model never saw
# during supervised training.
#
# Strategy: every Nth record by sorted record-id (default stride 5 → ~20%).
# Deterministic, reproducible, and approximately stratified over recording
# date (CinC record IDs are roughly chronological).

def partition_cinc_records(all_records, *, holdout_enabled=None, stride=None):
    """
    Split a list of CinC record IDs into (held_in, held_out).

    Args:
        all_records: list of strings ('A00001', 'A00002', ...).
        holdout_enabled: if False, returns (sorted(all), []).
                         Default reads from `config.CINC_HOLDOUT_ENABLED`.
        stride: every Nth record is held out. Default `CINC_HOLDOUT_STRIDE`.

    Returns:
        (held_in, held_out) — both sorted lists of record IDs.
        held_in  — used for supervised augmentation (cinc_n_loader).
        held_out — used for evaluation (evaluate.py::eval_cinc_leadI).
    """
    if holdout_enabled is None:
        holdout_enabled = CINC_HOLDOUT_ENABLED
    if stride is None:
        stride = CINC_HOLDOUT_STRIDE

    sorted_records = sorted(all_records)
    if not holdout_enabled:
        return sorted_records, []

    held_out = sorted_records[::stride]                # every Nth (0, N, 2N, …)
    held_out_set = set(held_out)
    held_in = [r for r in sorted_records if r not in held_out_set]
    return held_in, held_out


def cinc_holdout_set(all_records, *, holdout_enabled=None, stride=None):
    """Convenience: return only the held-out set as a Python set."""
    _, held_out = partition_cinc_records(
        all_records, holdout_enabled=holdout_enabled, stride=stride
    )
    return set(held_out)


def verify_no_overlap():
    """Verify train/val/test are disjoint and paced records excluded."""
    train = set(get_train_records())
    val = set(get_val_records())
    test = set(get_test_records())
    paced = set(get_paced_records())

    assert train & val == set(), "Train/val overlap detected"
    assert train & test == set(), "Train/test overlap detected"
    assert val & test == set(), "Val/test overlap detected"
    assert (train | val | test) & paced == set(), "Paced records in split"
    assert train | val == set(DS1_RECORDS), "DS1 not fully covered"
    assert test == set(DS2_RECORDS), "DS2 mismatch"
    print(f"Split verification passed:")
    print(f"  Train: {len(train)} records {sorted(train)}")
    print(f"  Val:   {len(val)} records {sorted(val)}")
    print(f"  Test:  {len(test)} records {sorted(test)}")
    print(f"  Paced excluded: {sorted(paced)}")


if __name__ == "__main__":
    verify_no_overlap()
