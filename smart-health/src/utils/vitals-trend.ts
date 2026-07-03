/**
 * Range-aware bucketing for vitals trend charts. This is the SAME
 * algorithm the wearer's Activity tab uses (`app/(wearer)/activity.tsx`)
 * so the caregiver's per-metric trend sheet renders identical graphs.
 * Kept here as the shared source; the wearer screen still has its own
 * inline copy (left untouched to avoid regressions) — unify onto this
 * when convenient.
 *
 *  - Day   → 12 calendar-day 2-hour buckets (midnight → midnight)
 *  - Week  → 7 daily buckets ending on the anchor
 *  - Month → 4 weekly buckets ending on the anchor
 */
import type { VitalsRow } from '@/services/vitals.service';

export type TrendRange = 'day' | 'week' | 'month';

export type Bucket = {
  min: number | null;
  max: number | null;
  avg: number | null;
  count: number;
  label: string;
};

/** Narrow weekday letter for day index 0–6 (Sun–Sat), localized. */
export function weekdayLetter(dayIdx: number, isAr: boolean): string {
  if (isAr) return ['ح', 'ن', 'ث', 'ر', 'خ', 'ج', 'س'][dayIdx];
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][dayIdx];
}

/** Compact hour label for chart axes (12h a/p for en, 24h for ar). */
export function hourLabel(hour: number, isAr: boolean): string {
  if (isAr) return String(hour);
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  if (hour < 12) return String(hour);
  return String(hour - 12);
}

function aggregateBucket(
  rows: VitalsRow[],
  pick: (r: VitalsRow) => number | null,
  fromMs: number,
  toMs: number,
  label: string,
): Bucket {
  let sum = 0, count = 0, min = Infinity, max = -Infinity;
  for (const r of rows) {
    const v = pick(r);
    if (v == null) continue;
    const ts = new Date(r.recorded_at).getTime();
    if (ts < fromMs || ts >= toMs) continue;
    sum += v; count += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return count > 0
    ? { min, max, avg: sum / count, count, label }
    : { min: null, max: null, avg: null, count: 0, label };
}

export function bucketVitals(
  rows: VitalsRow[],
  pick: (r: VitalsRow) => number | null,
  range: TrendRange,
  anchor: Date,
  locale = 'en',
): Bucket[] {
  const isAr = locale.startsWith('ar');
  if (range === 'day') {
    const labels = Array.from({ length: 12 }, (_, i) => hourLabel(i * 2, isAr));
    const dayStart = new Date(anchor);
    dayStart.setHours(0, 0, 0, 0);
    const bucketMs = 2 * 3600_000;
    return labels.map((label, i) => {
      const from = dayStart.getTime() + i * bucketMs;
      return aggregateBucket(rows, pick, from, from + bucketMs, label);
    });
  }
  if (range === 'week') {
    const out: Bucket[] = [];
    for (let i = 6; i >= 0; i--) {
      const start = new Date(anchor);
      start.setDate(start.getDate() - i);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      out.push(aggregateBucket(rows, pick, start.getTime(), end.getTime(), weekdayLetter(start.getDay(), isAr)));
    }
    return out;
  }
  // month: 4 weekly buckets ending on anchor
  const out: Bucket[] = [];
  for (let w = 3; w >= 0; w--) {
    const end = new Date(anchor);
    end.setDate(end.getDate() - w * 7);
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);
    const label = start.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
    out.push(aggregateBucket(rows, pick, start.getTime(), end.getTime() + 1, label));
  }
  return out;
}

/** Per-day step totals over the last `count` days ending on `anchor`.
 *  Steps ride in `metadata.steps` and accumulate then reset at midnight,
 *  so a day's total ≈ the MAX value seen that day. Returns oldest→newest
 *  with a short label per bar. */
export function dailySteps(
  rows: VitalsRow[],
  count: number,
  anchor: Date,
  isAr = false,
): { value: number; label: string }[] {
  const out: { value: number; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);
    const from = d.getTime();
    const to = from + 24 * 3600_000;
    let maxSteps = 0;
    for (const r of rows) {
      const s = r.metadata?.steps;
      if (typeof s !== 'number') continue;
      const ts = new Date(r.recorded_at).getTime();
      if (ts < from || ts >= to) continue;
      if (s > maxSteps) maxSteps = s;
    }
    out.push({ value: maxSteps, label: weekdayLetter(d.getDay(), isAr) });
  }
  return out;
}
