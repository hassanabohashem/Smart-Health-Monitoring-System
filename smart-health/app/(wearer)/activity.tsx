import { View, SafeAreaView, Text, Pressable, Dimensions } from 'react-native';
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, Dialog } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { LineChart } from 'react-native-gifted-charts';
import {
  useDesignTokens, PageHeader, ScreenBody, Card, SectionTitle,
  BarChart, Eyebrow, IconDot,
} from '@/design';
import { fontFamily, radius, spacing } from '@/design/tokens';
import { AuthIcon } from '@/components/AuthControls';
import { useActivityHistoryStore, currentRhythmBucket } from '@/stores/activity-history.store';
import { useVitalsStore } from '@/stores/vitals.store';
import { useAuthStore } from '@/stores/auth.store';
import { useDeviceStore } from '@/stores/device.store';
import { getVitalsForRange, type VitalsRow } from '@/services/vitals.service';
import { supabase } from '@/services/supabase';

// Card body width = device width - ScreenBody horizontal padding (24×2)
//                                  - Card internal padding (16×2)
const cardInnerW = Dimensions.get('window').width - 48 - 32;

/** Narrow weekday letter for day index 0–6 (Sun–Sat), localized.
 *  Arabic uses the conventional first letter of each weekday name. */
function weekdayLetter(dayIdx: number, isAr: boolean): string {
  if (isAr) return ['ح','ن','ث','ر','خ','ج','س'][dayIdx];
  return ['S','M','T','W','T','F','S'][dayIdx];
}

/** Compact hour label for chart axes. English uses 12h with a/p
 *  disambiguation around noon/midnight; Arabic uses 24h numeric. */
function hourLabel(hour: number, isAr: boolean): string {
  if (isAr) return String(hour);
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  if (hour < 12) return String(hour);
  return String(hour - 12);
}

/** Fill in missing days so the chart always renders N bars ending on
 *  `anchor`. The anchor (defaults to today) is always the last bar.
 *  Day labels use single-letter weekday for ≤7 bars and day-of-month
 *  for longer ranges. */
function padDays(
  daily: { date: string; steps: number; activeMin: number }[],
  count: number,
  anchor: Date = new Date(),
  isAr = false,
) {
  const out: { date: string; steps: number; activeMin: number; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${day}`;
    const hit = daily.find((b) => b.date === key);
    out.push({
      date: key,
      steps: hit?.steps ?? 0,
      activeMin: hit?.activeMin ?? 0,
      label: weekdayLetter(d.getDay(), isAr),
    });
  }
  return out;
}

/** Roll the last `weeks * 7` daily buckets into N weekly aggregates,
 *  most recent week last. Label is the start-of-week date ("May 5"). */
function padWeeks(
  daily: { date: string; steps: number; activeMin: number }[],
  weeks: number,
  anchor: Date = new Date(),
  locale = 'en',
) {
  const out: { date: string; steps: number; activeMin: number; label: string }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const end = new Date(anchor);
    end.setDate(end.getDate() - w * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);

    let steps = 0;
    let activeMin = 0;
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(day.getDate() + d);
      const y = day.getFullYear();
      const m = String(day.getMonth() + 1).padStart(2, '0');
      const dd = String(day.getDate()).padStart(2, '0');
      const key = `${y}-${m}-${dd}`;
      const hit = daily.find((b) => b.date === key);
      if (hit) { steps += hit.steps; activeMin += hit.activeMin; }
    }

    const label = start.toLocaleDateString(locale, {
      month: 'short', day: 'numeric',
    });
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, '0');
    const dd = String(start.getDate()).padStart(2, '0');
    out.push({ date: `${y}-${m}-${dd}`, steps, activeMin, label });
  }
  return out;
}

/** Format a YYYY-MM-DD string into a short human-readable date. */
function fmtPickerDate(iso: string, locale = 'en'): string {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(locale, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

/** YYYY-MM-DD for today's date. */
function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

type Range = 'day' | 'week' | 'month';

type Bucket = {
  min: number | null;
  max: number | null;
  avg: number | null;
  count: number;
  label: string;
};

/** Helper: aggregate (sum, min, max, count) into a Bucket for one window. */
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

/** Aggregate vitals rows into N range-aware buckets (min / max / avg).
 *
 *  - Day   → 12 calendar-day 2-hour buckets (midnight → midnight)
 *  - Week  → 7 daily buckets ending on anchor
 *  - Month → 4 weekly buckets ending on anchor
 *
 *  Matches the x-axis used by the Steps + Active-minutes bar charts
 *  below, so all four cards share a consistent time grid for a range. */
function bucketVitals(
  rows: VitalsRow[],
  pick: (r: VitalsRow) => number | null,
  range: Range,
  anchor: Date,
  locale = 'en',
): Bucket[] {
  const isAr = locale.startsWith('ar');
  if (range === 'day') {
    // 12 × 2-hour buckets starting at midnight (0, 2, 4, ..., 22).
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

/** Compact month-grid date picker — replaces the long scroll list.
 *  Constraints:
 *    - days >30 ago, future days → disabled (data window is 30 days)
 *    - month nav arrows hidden past those edges
 *    - selected day = solid accent circle, today = ring border,
 *      days with step data = small dot under the number */
function CalendarPicker({
  viewMonth, onChangeMonth, selectedDate, daily, onPick,
}: {
  viewMonth: { y: number; m: number };
  onChangeMonth: (next: { y: number; m: number }) => void;
  selectedDate: string | null;
  daily: { date: string; steps: number; activeMin: number }[];
  onPick: (date: string) => void;
}) {
  const { palette } = useDesignTokens();
  const { i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const isAr = locale.startsWith('ar');
  const today = new Date();
  const todayY = today.getFullYear();
  const todayM = today.getMonth();
  const todayD = today.getDate();
  const todayKeyStr = todayKey();
  const selectedKey = selectedDate ?? todayKeyStr;

  // 30-day floor for tappable days.
  const minDate = new Date();
  minDate.setDate(minDate.getDate() - 29);
  minDate.setHours(0, 0, 0, 0);

  // Allow back-nav while *any* part of the view month is ≥ minDate;
  // forward only up to the current calendar month.
  const monthLastDay = new Date(viewMonth.y, viewMonth.m + 1, 0);
  const monthFirstDay = new Date(viewMonth.y, viewMonth.m, 1);
  const canPrev = new Date(viewMonth.y, viewMonth.m - 1, 1).getTime() >= new Date(minDate.getFullYear(), minDate.getMonth(), 1).getTime();
  const canNext = monthLastDay.getFullYear() < todayY
    || (monthLastDay.getFullYear() === todayY && viewMonth.m < todayM);

  const monthLabel = monthFirstDay.toLocaleDateString(locale, {
    month: 'long', year: 'numeric',
  });

  const daysInMonth = monthLastDay.getDate();
  const firstDow = monthFirstDay.getDay();

  // Build 42 cells (6 rows × 7 cols) — leading empties, days, trailing empties.
  const cells: { day: number | null; key: string; date: string }[] = [];
  for (let i = 0; i < firstDow; i++) {
    cells.push({ day: null, key: `e${i}`, date: '' });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const m = String(viewMonth.m + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    const dateKey = `${viewMonth.y}-${m}-${dd}`;
    cells.push({ day: d, key: dateKey, date: dateKey });
  }
  while (cells.length < 42) {
    cells.push({ day: null, key: `t${cells.length}`, date: '' });
  }

  const weekdays = [0, 1, 2, 3, 4, 5, 6].map((i) => weekdayLetter(i, isAr));

  const stepBack = () => onChangeMonth({
    y: viewMonth.m === 0 ? viewMonth.y - 1 : viewMonth.y,
    m: viewMonth.m === 0 ? 11 : viewMonth.m - 1,
  });
  const stepFwd = () => onChangeMonth({
    y: viewMonth.m === 11 ? viewMonth.y + 1 : viewMonth.y,
    m: viewMonth.m === 11 ? 0 : viewMonth.m + 1,
  });

  return (
    <View>
      {/* Month header with prev / next arrows */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingVertical: 4,
      }}>
        <Pressable
          onPress={canPrev ? stepBack : undefined}
          disabled={!canPrev}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: !canPrev ? 0.3 : (pressed ? 0.5 : 1), padding: 4 })}
        >
          <MaterialCommunityIcons name="chevron-left" size={22} color={palette.text} />
        </Pressable>
        <Text style={{
          fontFamily: fontFamily.sansSemibold, fontSize: 15, color: palette.text,
        }}>{monthLabel}</Text>
        <Pressable
          onPress={canNext ? stepFwd : undefined}
          disabled={!canNext}
          hitSlop={8}
          style={({ pressed }) => ({ opacity: !canNext ? 0.3 : (pressed ? 0.5 : 1), padding: 4 })}
        >
          <MaterialCommunityIcons name="chevron-right" size={22} color={palette.text} />
        </Pressable>
      </View>

      {/* Weekday headers */}
      <View style={{ flexDirection: 'row', marginTop: 8 }}>
        {weekdays.map((w, i) => (
          <View key={i} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{
              fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3, letterSpacing: 0.5,
            }}>{w}</Text>
          </View>
        ))}
      </View>

      {/* Day grid */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
        {cells.map((c) => {
          if (c.day == null) {
            return <View key={c.key} style={{ width: `${100 / 7}%`, height: 40 }} />;
          }
          const cellDate = new Date(viewMonth.y, viewMonth.m, c.day);
          cellDate.setHours(0, 0, 0, 0);
          const today0 = new Date();
          today0.setHours(0, 0, 0, 0);
          const isFuture = cellDate.getTime() > today0.getTime();
          const isPast30 = cellDate.getTime() < minDate.getTime();
          const disabled = isFuture || isPast30;
          const isToday = viewMonth.y === todayY && viewMonth.m === todayM && c.day === todayD;
          const isSel = c.date === selectedKey;
          const hasData = !!daily.find((b) => b.date === c.date);

          return (
            <View key={c.key} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2 }}>
              <Pressable
                onPress={() => !disabled && onPick(c.date)}
                disabled={disabled}
                style={({ pressed }) => ({
                  width: 36, height: 36, borderRadius: 999,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: isSel ? palette.accent2 : 'transparent',
                  borderWidth: isToday && !isSel ? 1.5 : 0,
                  borderColor: palette.accent2,
                  opacity: disabled ? 0.28 : (pressed ? 0.55 : 1),
                })}
              >
                <Text style={{
                  fontFamily: fontFamily.sansMedium,
                  fontSize: 13,
                  fontWeight: isSel || isToday ? '600' : '500',
                  color: isSel ? '#FFFFFF' : palette.text,
                }}>{c.day}</Text>
                {hasData && !isSel ? (
                  <View style={{
                    position: 'absolute', bottom: 4,
                    width: 4, height: 4, borderRadius: 2,
                    backgroundColor: palette.accent2,
                  }} />
                ) : null}
              </Pressable>
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Day/Week/Month pill segmented — matches `.seg` in the design source. */
function RangePill({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const opts: { id: Range; label: string }[] = [
    { id: 'day',   label: t('activity.range.day') },
    { id: 'week',  label: t('activity.range.week') },
    { id: 'month', label: t('activity.range.month') },
  ];
  return (
    <View style={{
      flexDirection: 'row', alignSelf: 'flex-start',
      backgroundColor: palette.surface2,
      borderRadius: 999, padding: 4, gap: 2,
    }}>
      {opts.map((o) => {
        const active = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            style={({ pressed }) => ({
              paddingHorizontal: 18, height: 36,
              borderRadius: 999, alignItems: 'center', justifyContent: 'center',
              backgroundColor: active ? palette.surface : 'transparent',
              opacity: !active && pressed ? 0.6 : 1,
              ...(active ? {
                shadowColor: palette.shadowSm,
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 1, shadowRadius: 2, elevation: 1,
              } : {}),
            })}
          >
            <Text style={{
              fontFamily: fontFamily.sansMedium,
              fontSize: 13, fontWeight: '500',
              color: active ? palette.text : palette.text2,
            }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function ActivityScreen() {
  const { palette } = useDesignTokens();
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const isAr = locale.startsWith('ar');
  const [range, setRange] = useState<Range>('week');
  /** Date the chart window anchors on (last bar). null = today. */
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const cfg = {
    eyebrow: t(`activity.rangeEyebrow.${range}`),
    subLabel: t(`activity.rangeSubLabel.${range}`),
  };
  const daily = useActivityHistoryStore((s) => s.daily);
  const rhythm12h = useActivityHistoryStore((s) => s.rhythm12h);
  const liveStepsToday = useVitalsStore((s) => s.steps);
  const profile = useAuthStore((s) => s.profile);
  // `demoMode` is in the dep array so flipping the demo toggle (which
  // starts writing fresh rows to Supabase via mock-vitals) re-fetches
  // immediately instead of waiting for the next tab change.
  const demoMode = useDeviceStore((s) => s.demoMode);

  const isToday = selectedDate == null || selectedDate === todayKey();
  const anchor = selectedDate
    ? new Date(selectedDate + 'T12:00:00')   // local-noon to avoid TZ rollover
    : new Date();

  // Vitals trend rows for the selected range. Refetches when range,
  // selectedDate, or demoMode changes. Empty array if no data / not
  // signed in.
  const [vitalsRows, setVitalsRows] = useState<VitalsRow[]>([]);
  useEffect(() => {
    if (!profile?.id) return;
    const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
    const anchorDate = selectedDate ? new Date(selectedDate) : new Date();
    getVitalsForRange(profile.id, days, anchorDate)
      .then(setVitalsRows)
      .catch((err) => console.error('[activity] vitals fetch failed', err));
  }, [profile?.id, range, selectedDate, demoMode]);

  // Realtime — push new vitals rows into the trend buffer so the
  // demo-mode writer (every ~15 s) updates the line charts without
  // requiring a tab change. Only relevant for the "today" view since
  // past-day ranges won't accept new rows anyway.
  useEffect(() => {
    if (!profile?.id || !isToday) return;
    const ch = supabase
      .channel(`my-vitals-${profile.id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vitals', filter: `user_id=eq.${profile.id}` },
        (payload) => {
          setVitalsRows((prev) => [...prev, payload.new as VitalsRow]);
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [profile?.id, isToday]);
  // Month being viewed in the picker calendar. Defaults to today's
  // calendar month; arrows navigate within the last ~3 months
  // (matches the 30-day data window — earlier months are visible
  // but every day shows as disabled).
  const [pickerMonth, setPickerMonth] = useState(() => {
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  // Day view: 12 hourly buckets from today. Steps card displays today's
  // running step count (from vitals) while the chart shows minutes
  // active per hour. Week/Month: padded daily buckets anchored on
  // `selectedDate` (defaults to today).
  // 12 × 2h buckets matching activity-history's RHYTHM scheme, starting
  // at 6 AM (the rhythm window in activity-history.store). Labels are
  // locale-aware (12h with a/p for en, 24h numeric for ar).
  const dayLabels = useMemo(
    () => Array.from({ length: 12 }, (_, i) => hourLabel((6 + i * 2) % 24, isAr)),
    [isAr],
  );
  const series = useMemo(() => {
    if (range === 'day') {
      // Past-day Day view: we don't store hourly history for non-today,
      // so the chart is empty. The Steps + Active minutes totals still
      // pull from the daily bucket for that date.
      if (!isToday) return [];
      return rhythm12h.map((v, i) => ({
        date: `h${i}`, steps: v, activeMin: v, label: dayLabels[i],
      }));
    }
    if (range === 'month') {
      // 4 rolling 7-day weeks. Reads cleaner than 30 daily bars and
      // matches the convention of every major fitness app.
      return padWeeks(daily, 4, anchor, locale);
    }
    return padDays(daily, 7, anchor, isAr);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, daily, rhythm12h, isToday, selectedDate, locale, isAr, dayLabels]);

  const minutes = series.map((d) => d.activeMin);
  const days    = series.map((d) => d.label);
  // Steps total → range + selected-date aware. Today + Day: vitals
  // live count. Past day: daily bucket for that date. Week/Month: sum
  // of window.
  const dailyBucket = selectedDate
    ? daily.find((b) => b.date === selectedDate)
    : null;
  const totalStepsN = range === 'day'
    ? (isToday ? liveStepsToday : (dailyBucket?.steps ?? 0))
    : series.reduce((acc, d) => acc + d.steps, 0);
  const totalSteps  = totalStepsN.toLocaleString();
  const totalActive = range === 'day' && !isToday
    ? (dailyBucket?.activeMin ?? 0)
    : minutes.reduce((a, b) => a + b, 0);
  const activeMin   = t('common.hoursMinutes', { h: Math.floor(totalActive / 60), m: totalActive % 60 });

  // Steps chart only makes sense for Week/Month (daily-bucketed steps).
  // Day view replaces the bars with the rhythm chart embedded in the
  // Active minutes card below.
  const stepsSeries = range === 'day' ? null : series.map((d) => d.steps);

  // Highlight: current hour in Day-today; last bar otherwise. Past-day
  // Week/Month windows highlight the anchor (last bar).
  const highlightIdx = range === 'day' && isToday
    ? currentRhythmBucket()
    : series.length - 1;

  // All ranges have ≤12 bars now (Day: 12 hourly, Week: 7 daily,
  // Month: 4 weekly) so a uniform 4px gap reads cleanly.
  const barGap = 4;


  // Dynamic y-axis: round up to next nice multiple so the tallest bar
  // doesn't touch the top edge of the chart.
  const stepsMax = stepsSeries ? Math.max(...stepsSeries, 100) : 0;
  const stepsCeiling = Math.max(1000, Math.ceil(stepsMax * 1.15 / 1000) * 1000);
  const minutesMax = Math.max(...minutes, 10);
  const minutesCeiling = Math.max(30, Math.ceil(minutesMax * 1.15 / 10) * 10);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader
        eyebrow={isToday
          ? cfg.eyebrow
          : `${cfg.eyebrow} · ${fmtPickerDate(selectedDate!, locale)}`}
        title={t('tabs.activity')}
        action={
          <Pressable
            onPress={() => setShowPicker(true)}
            style={({ pressed }) => ({
              width: 36, height: 36, borderRadius: 999,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: isToday ? palette.surface : palette.accentSoft,
              borderWidth: 1,
              borderColor: isToday ? palette.border : palette.accentSoft,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <AuthIcon
              name="calendar"
              size={18}
              color={isToday ? palette.text2 : palette.accentInk}
            />
          </Pressable>
        }
      />
      <ScreenBody gap={spacing.s4}>
        <RangePill value={range} onChange={setRange} />

        {/* Vitals trends — Whoop-style trend card.
            Anatomy (top to bottom):
              1. small icon + title row
              2. huge period-avg number with sub-label
              3. smooth area line (curved, no axes, no labels)
                 with a translucent "healthy range" band behind it
              4. low / high mini-stats footer
            Same bucketing as the bar charts below (12 / 7 / 4) but
            the visual is a single calm line rather than a noisy set
            of dots — the Whoop "are you trending in or out of your
            normal" feel. */}
        {(
          [
            { key: 'hr',   title: t('activity.heartRate'), unit: 'bpm', color: palette.danger,  pick: (r: VitalsRow) => r.heart_rate,  iconV: 'danger'  as const, icon: 'heart'       as const, decimals: 0, healthy: [60, 100]    as [number, number] },
            { key: 'spo',  title: t('activity.spo2'),      unit: '%',   color: palette.info,    pick: (r: VitalsRow) => r.spo2,        iconV: 'info'    as const, icon: 'water'       as const, decimals: 0, healthy: [95, 100]    as [number, number] },
            { key: 'temp', title: t('activity.temp'),      unit: '°C',  color: palette.warning, pick: (r: VitalsRow) => r.temperature, iconV: 'warning' as const, icon: 'thermometer' as const, decimals: 1, healthy: [36.1, 37.2] as [number, number] },
          ] as const
        ).map((spec) => {
          const buckets = bucketVitals(vitalsRows, spec.pick, range, anchor, locale);
          const filled = buckets.filter((b) => b.count > 0);
          const hasData = filled.length >= 2;

          // Footer + headline numbers.
          const allMins = filled.map((b) => b.min!) as number[];
          const allMaxs = filled.map((b) => b.max!) as number[];
          const allAvgs = filled.map((b) => b.avg!) as number[];
          const overallMin = allMins.length > 0 ? Math.min(...allMins) : 0;
          const overallMax = allMaxs.length > 0 ? Math.max(...allMaxs) : 1;
          const periodAvg = allAvgs.length > 0
            ? allAvgs.reduce((s, v) => s + v, 0) / allAvgs.length
            : null;

          // Y range — include the healthy band so the line + band
          // stay vertically co-comparable. Pad ±8% so the curve
          // doesn't hug the edges.
          const dataLo = Math.min(overallMin, spec.healthy[0]);
          const dataHi = Math.max(overallMax, spec.healthy[1]);
          const span = Math.max(1, dataHi - dataLo);
          const pad = span * 0.08;
          const yMin = dataLo - pad;
          const yMax = dataHi + pad;
          const yRange = yMax - yMin;

          // Forward-fill empty buckets so the line is one continuous
          // shape; the absent buckets just sit at the previous value.
          const seedV = filled[0]?.avg ?? 0;
          let lastV = seedV;
          const points = buckets.map((b) => {
            if (b.count > 0) { lastV = b.avg!; }
            return { value: lastV };
          });

          // Healthy-range band: convert healthy [lo, hi] into y-pixel
          // top/height inside the chart. Clamp to chart bounds.
          const chartH = 110;
          const topFor = (v: number) => ((yMax - v) / yRange) * chartH;
          const bandTop = Math.max(0, topFor(spec.healthy[1]));
          const bandBot = Math.min(chartH, topFor(spec.healthy[0]));
          const bandH = Math.max(0, bandBot - bandTop);

          const subLabel =
            range === 'day' ? cfg.subLabel
            : range === 'week' ? t('activity.avgSubLabel.week')
            : t('activity.avgSubLabel.month');

          return (
            <Card key={spec.key}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <IconDot icon={spec.icon} variant={spec.iconV} size={22} />
                <SectionTitle>{spec.title}</SectionTitle>
              </View>

              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{
                  fontFamily: fontFamily.display, fontSize: 48, lineHeight: 50,
                  letterSpacing: -1.5, color: palette.text,
                }}>
                  {periodAvg != null ? periodAvg.toFixed(spec.decimals) : '—'}
                </Text>
                <Text style={{ fontFamily: fontFamily.mono, fontSize: 12, color: palette.text3 }}>
                  {spec.unit} · {subLabel}
                </Text>
              </View>

              {hasData ? (
                <>
                  <View style={{
                    position: 'relative',
                    marginTop: 14, height: chartH, width: cardInnerW,
                  }}>
                    {/* Healthy-range band — sits behind the line. */}
                    {bandH > 0 && (
                      <View style={{
                        position: 'absolute',
                        left: 0, right: 0,
                        top: bandTop, height: bandH,
                        backgroundColor: spec.color, opacity: 0.07,
                        borderRadius: 4,
                      }} />
                    )}
                    <LineChart
                      areaChart curved disableScroll
                      data={points}
                      width={cardInnerW}
                      height={chartH}
                      thickness={2.5}
                      color={spec.color}
                      startFillColor={spec.color}
                      endFillColor={palette.surface}
                      startOpacity={0.22}
                      endOpacity={0.01}
                      hideDataPoints
                      hideYAxisText
                      hideRules
                      yAxisColor="transparent"
                      xAxisColor="transparent"
                      initialSpacing={0}
                      endSpacing={0}
                      yAxisOffset={yMin}
                      maxValue={yRange}
                      noOfSections={1}
                      adjustToWidth
                    />
                  </View>

                  <View style={{
                    flexDirection: 'row', justifyContent: 'space-between',
                    marginTop: 12,
                  }}>
                    <View>
                      <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3 }}>{t('activity.low')}</Text>
                      <Text style={{
                        fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                        fontSize: 16, color: palette.text, marginTop: 2,
                      }}>
                        {overallMin.toFixed(spec.decimals)}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3 }}>{t('activity.high')}</Text>
                      <Text style={{
                        fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                        fontSize: 16, color: palette.text, marginTop: 2,
                      }}>
                        {overallMax.toFixed(spec.decimals)}
                      </Text>
                    </View>
                  </View>

                  <Text style={{
                    fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
                    marginTop: 10,
                  }}>
                    {t('activity.healthyRange', {
                      lo: spec.healthy[0].toFixed(spec.decimals),
                      hi: spec.healthy[1].toFixed(spec.decimals),
                      unit: spec.unit,
                    })}
                  </Text>
                </>
              ) : (
                <Text style={{
                  fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3,
                  fontStyle: 'italic', textAlign: 'center', paddingVertical: 24,
                }}>
                  {t('activity.noReadings', { metric: spec.title.toLowerCase() })}
                </Text>
              )}
            </Card>
          );
        })}

        {/* Steps card — daily bars for Week/Month, just the big number
            for Day view (steps aren't bucketed hourly). */}
        <Card>
          <Eyebrow>{t('activity.steps')}</Eyebrow>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 54, lineHeight: 56,
              letterSpacing: -1.5, color: palette.text,
            }}>{totalSteps}</Text>
            <Text style={{
              fontFamily: fontFamily.mono, fontSize: 12, color: palette.text3,
            }}>{cfg.subLabel}</Text>
          </View>
          {stepsSeries ? (
            <View style={{ marginTop: 12 }}>
              <BarChart
                data={stepsSeries}
                labels={days}
                height={120}
                max={stepsCeiling}
                highlightIndex={highlightIdx}
                gap={barGap}
              />
            </View>
          ) : null}
        </Card>

        {/* Active minutes card */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <SectionTitle>{t('activity.activeMinutes')}</SectionTitle>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 22, lineHeight: 24,
              letterSpacing: -0.5, color: palette.text,
            }}>{activeMin}</Text>
          </View>
          {minutes.length > 0 ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: barGap, height: 60 }}>
                {minutes.map((v, i) => {
                  const hi = i === highlightIdx;
                  const pct = Math.min(1, v / minutesCeiling);
                  return (
                    <View key={i} style={{
                      flex: 1,
                      height: `${pct * 100}%`,
                      minHeight: 2,
                      backgroundColor: hi ? palette.accent2 : palette.accentSoft,
                      borderRadius: 5,
                    }} />
                  );
                })}
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                {days.map((d, i) => (
                  <Text key={i} style={{
                    fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3,
                    flex: 1, textAlign: 'center',
                  }}>{d}</Text>
                ))}
              </View>
            </>
          ) : (
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3,
              fontStyle: 'italic',
            }}>
              {t('activity.noHourly')}
            </Text>
          )}
        </Card>

        <View style={{ height: 12 }} />
      </ScreenBody>

      {/* Date picker — 30-day scrollable list. Tap a row to anchor the
          chart window on that day; "Today" resets to live mode. */}
      <Portal>
        <Dialog
          visible={showPicker}
          onDismiss={() => setShowPicker(false)}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text }}>
            {t('activity.pickerTitle')}
          </Dialog.Title>
          <Dialog.Content>
            <CalendarPicker
              viewMonth={pickerMonth}
              onChangeMonth={setPickerMonth}
              selectedDate={selectedDate}
              daily={daily}
              onPick={(date) => {
                setSelectedDate(date === todayKey() ? null : date);
                setShowPicker(false);
              }}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => setShowPicker(false)}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                color: palette.text2,
              }}>
                {t('common.cancel')}
              </Text>
            </Pressable>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </SafeAreaView>
  );
}
