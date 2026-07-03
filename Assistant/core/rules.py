"""
Rules-based vitals analyzer.

Severity ladder:  NORMAL  <  WARNING  <  DANGER  <  CRITICAL
Special:          UNKNOWN (no data) / SENSOR_ERROR (implausible reading)

All vital arguments are optional. Missing values are simply skipped.
Implausible values (e.g. HR=0) produce a SENSOR_ERROR alert instead of a
false medical emergency.

Age-aware thresholds (AHA pediatric reference):
  Heart rate and respiratory rate normal ranges depend heavily on age.
  A 7-year-old's resting HR of 110 is mostly normal; in an adult it's
  tachycardia. Temperature cutoffs are also stricter for infants.

  Pass `age` (in years; infants accepted as fractional, e.g. 0.5 = 6mo)
  to analyze_vitals() to use age-appropriate thresholds. When age is
  unknown, the adult thresholds are used.
"""
from dataclasses import dataclass
from enum import Enum
from typing import List, Optional, Tuple


class Severity(str, Enum):
    UNKNOWN = "UNKNOWN"
    NORMAL = "NORMAL"
    WARNING = "WARNING"
    DANGER = "DANGER"
    CRITICAL = "CRITICAL"
    SENSOR_ERROR = "SENSOR_ERROR"


_ORDER = {
    Severity.UNKNOWN: 0,
    Severity.NORMAL: 1,
    Severity.SENSOR_ERROR: 2,
    Severity.WARNING: 3,
    Severity.DANGER: 4,
    Severity.CRITICAL: 5,
}


@dataclass
class Alert:
    level: Severity
    param: str
    value: str
    message: str

    def as_tuple(self) -> Tuple[str, str, str, str]:
        return (self.level.value, self.param, self.value, self.message)


# ── Age bands ────────────────────────────────────────────────────────────
def _age_band(age: Optional[float]) -> str:
    """
    Map an age (in years) to a band. Infants accepted as fractional years
    (e.g. 0.25 = 3 months).  age=None defaults to adult — the safest fallback
    for an unknown wearer.
    """
    if age is None:
        return "adult"
    if age < 0.25:      return "newborn"       # < 3 months
    if age < 1:         return "infant"        # 3 months – 1 year
    if age < 3:         return "toddler"       # 1–3 years
    if age < 6:         return "preschool"     # 3–6 years
    if age < 12:        return "school_age"    # 6–12 years
    if age < 18:        return "adolescent"    # 12–18 years
    return "adult"                              # 18+


# HR thresholds per band — (crit_lo, warn_lo, normal_hi, warn_hi, crit_hi)
# Anything in [warn_lo, normal_hi] is NORMAL.
# Rules: x < crit_lo       → CRITICAL (severe bradycardia)
#        crit_lo ≤ x < warn_lo → WARNING  (bradycardia)
#        warn_lo ≤ x ≤ normal_hi → NORMAL
#        normal_hi < x ≤ warn_hi  → WARNING (slightly elevated)
#        warn_hi < x ≤ crit_hi    → DANGER  (tachycardia)
#        x > crit_hi                → CRITICAL (severe tachycardia)
# Values calibrated to AHA pediatric and AHA adult references.
_HR_THRESHOLDS = {
    "newborn":     (80,  100, 160, 180, 200),
    "infant":      (70,  80,  140, 160, 180),
    "toddler":     (60,  75,  130, 150, 170),
    "preschool":   (60,  75,  120, 140, 160),
    "school_age":  (50,  70,  115, 135, 155),
    "adolescent":  (40,  60,  100, 115, 150),
    "adult":       (40,  60,  100, 110, 150),
}

# RR thresholds per band — same scheme as HR (crit_lo, warn_lo, normal_hi, warn_hi, crit_hi)
_RR_THRESHOLDS = {
    "newborn":     (20, 30, 60, 70, 80),
    "infant":      (15, 20, 40, 50, 60),
    "toddler":     (12, 20, 30, 40, 50),
    "preschool":   (10, 20, 30, 35, 45),
    "school_age":  (10, 18, 25, 30, 40),
    "adolescent":  (8,  12, 20, 25, 30),
    "adult":       (8,  12, 20, 25, 30),
}


# ── Plausibility checks ──────────────────────────────────────────────────
def _is_plausible_hr(hr: float) -> bool:
    # Expanded upper bound to cover newborns (up to 220 is still plausible).
    return 20 <= hr <= 250


def _is_plausible_spo2(spo2: float) -> bool:
    return 50 <= spo2 <= 100


def _is_plausible_rr(rr: float) -> bool:
    # Newborns can reach 60 normally, tachypnea up to 80 — widened.
    return 4 <= rr <= 90


def _is_plausible_temp(temp: float) -> bool:
    return 30 <= temp <= 45


def _max(a: Severity, b: Severity) -> Severity:
    return a if _ORDER[a] >= _ORDER[b] else b


# ── Per-vital classifiers ────────────────────────────────────────────────
def _classify_band_rule(
    value: float, band: str, table: dict,
    unit: str, param: str,
    name_lo: str, name_hi: str,
) -> Alert:
    """
    Generic classifier for HR and RR against an age-band threshold table.
    """
    crit_lo, warn_lo, normal_hi, warn_hi, crit_hi = table[band]
    normal_range = f"{warn_lo}–{normal_hi} {unit}"
    if value > crit_hi:
        return Alert(Severity.CRITICAL, param, f"{value} {unit}",
                     f"Severe {name_hi} — seek emergency care immediately")
    if value > warn_hi:
        return Alert(Severity.DANGER, param, f"{value} {unit}",
                     f"{name_hi} detected — rest and monitor closely")
    if value > normal_hi:
        return Alert(Severity.WARNING, param, f"{value} {unit}",
                     f"Slightly elevated — monitor for changes")
    if value < crit_lo:
        return Alert(Severity.CRITICAL, param, f"{value} {unit}",
                     f"Severe {name_lo} — emergency care needed")
    if value < warn_lo:
        return Alert(Severity.WARNING, param, f"{value} {unit}",
                     f"{name_lo} — monitor if symptomatic")
    return Alert(Severity.NORMAL, param, f"{value} {unit}",
                 f"Within normal range ({normal_range})")


def _classify_hr(hr: float, band: str) -> Alert:
    if not _is_plausible_hr(hr):
        return Alert(Severity.SENSOR_ERROR, "Heart Rate", f"{hr} bpm",
                     "Sensor reading implausible — check device contact")
    return _classify_band_rule(
        hr, band, _HR_THRESHOLDS,
        unit="bpm", param="Heart Rate",
        name_lo="Bradycardia", name_hi="Tachycardia",
    )


def _classify_rr(rr: float, band: str) -> Alert:
    if not _is_plausible_rr(rr):
        return Alert(Severity.SENSOR_ERROR, "Resp. Rate", f"{rr} br/min",
                     "Sensor reading implausible")
    return _classify_band_rule(
        rr, band, _RR_THRESHOLDS,
        unit="br/min", param="Resp. Rate",
        name_lo="Bradypnea", name_hi="Tachypnea",
    )


def _classify_spo2(spo2: float) -> Alert:
    # Same thresholds across ages — SpO2 normal is ≥95% for everyone.
    if not _is_plausible_spo2(spo2):
        return Alert(Severity.SENSOR_ERROR, "SpO2", f"{spo2}%",
                     "Sensor reading implausible — check finger / wrist contact")
    if spo2 < 85:
        return Alert(Severity.CRITICAL, "SpO2", f"{spo2}%",
                     "Severe Hypoxia — emergency oxygen needed NOW")
    if spo2 < 90:
        return Alert(Severity.DANGER, "SpO2", f"{spo2}%",
                     "Hypoxia — supplemental oxygen required")
    if spo2 < 95:
        return Alert(Severity.WARNING, "SpO2", f"{spo2}%",
                     "Below optimal — monitor breathing carefully")
    return Alert(Severity.NORMAL, "SpO2", f"{spo2}%",
                 "Normal oxygen saturation (≥95%)")


def _classify_temp(temp: float, band: str) -> Alert:
    # Temperature thresholds are mostly age-independent BUT newborns/infants
    # cannot regulate temperature well and any fever is a medical emergency.
    if not _is_plausible_temp(temp):
        return Alert(Severity.SENSOR_ERROR, "Temperature", f"{temp}°C",
                     "Sensor reading implausible")
    is_infant = band in ("newborn", "infant")

    if temp >= 40.0:
        return Alert(Severity.CRITICAL, "Temperature", f"{temp}°C",
                     "Hyperpyrexia — life-threatening fever")
    if temp >= 39.0:
        return Alert(Severity.DANGER, "Temperature", f"{temp}°C",
                     "High Fever — medical attention needed")
    if temp >= 38.0:
        if is_infant:
            # Any fever in a newborn/infant < 3mo is an emergency.
            return Alert(Severity.CRITICAL, "Temperature", f"{temp}°C",
                         "Fever in infant — immediate medical evaluation required")
        return Alert(Severity.WARNING, "Temperature", f"{temp}°C",
                     "Fever — monitor and hydrate")
    if temp < 35.0:
        return Alert(Severity.DANGER, "Temperature", f"{temp}°C",
                     "Hypothermia — warm patient immediately")
    return Alert(Severity.NORMAL, "Temperature", f"{temp}°C",
                 "Normal range (36.1–37.9°C)")


# ── Public API ───────────────────────────────────────────────────────────
def analyze_vitals(
    hr: Optional[float] = None,
    spo2: Optional[float] = None,
    rr: Optional[float] = None,
    temp: Optional[float] = None,
    age: Optional[float] = None,
) -> Tuple[List[Tuple[str, str, str, str]], str]:
    """
    Analyze a set of vitals and return (alerts, overall_severity).

    If `age` is provided, age-appropriate thresholds are used for HR, RR,
    and temperature (infant fever is upgraded). Without age, adult
    thresholds are used.

    If *all* vital inputs are None, returns severity UNKNOWN (not NORMAL).
    """
    alerts: List[Alert] = []
    provided = [v for v in (hr, spo2, rr, temp) if v is not None]

    if not provided:
        alerts.append(Alert(
            Severity.UNKNOWN, "Vitals", "—",
            "No sensor data available — unable to assess",
        ))
        return [a.as_tuple() for a in alerts], Severity.UNKNOWN.value

    band = _age_band(age)

    if hr is not None:
        alerts.append(_classify_hr(hr, band))
    if spo2 is not None:
        alerts.append(_classify_spo2(spo2))
    if rr is not None:
        alerts.append(_classify_rr(rr, band))
    if temp is not None:
        alerts.append(_classify_temp(temp, band))

    overall = Severity.NORMAL
    any_real_alert = False
    for a in alerts:
        if a.level in (Severity.WARNING, Severity.DANGER, Severity.CRITICAL):
            any_real_alert = True
        overall = _max(overall, a.level)

    if not any_real_alert and any(a.level == Severity.SENSOR_ERROR for a in alerts):
        overall = Severity.SENSOR_ERROR

    return [a.as_tuple() for a in alerts], overall.value


def build_vitals_summary(
    hr: Optional[float] = None,
    spo2: Optional[float] = None,
    rr: Optional[float] = None,
    temp: Optional[float] = None,
) -> Optional[str]:
    parts = []
    if hr is not None:
        parts.append(f"HR: {hr} bpm")
    if spo2 is not None:
        parts.append(f"SpO2: {spo2}%")
    if rr is not None:
        parts.append(f"RR: {rr} br/min")
    if temp is not None:
        parts.append(f"Temp: {temp}°C")
    return ", ".join(parts) if parts else None
