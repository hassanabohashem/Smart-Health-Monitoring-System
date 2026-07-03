/**
 * Rolling activity history — feeds the Today's rhythm chart on Home
 * and the entire Activity tab. Updated every minute by the activity
 * ticker (`src/services/activity-ticker.ts`), persisted to AsyncStorage
 * so it survives app reloads.
 *
 * Three time-bucketed views, all kept in one store so a single tick
 * updates them atomically:
 *
 *   - `rhythm12h[12]`     — minutes active per hour, 06:00 → 17:00
 *                           Resets each day at 06:00. Drives Today's
 *                           rhythm card on Home.
 *
 *   - `daily[7]`          — last 7 days, each `{ date, steps,
 *                           activeMin }`. Drives the Steps bar chart
 *                           + Active minutes mini bars on Activity.
 *
 *   - `todayMix`          — minutes today split into Walking / Jogging /
 *                           Resting (STATIONARY|SITTING|LAYING|null) — the
 *                           WISDM model's three classes. Drives Activity mix
 *                           donut on Activity.
 *
 * The ticker is the single writer; screens are read-only consumers.
 */

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** 12 buckets × 2-hour windows starting at 06:00 — covers a full
 *  "activity day" of 6am today → 6am tomorrow. Matches the design
 *  source labels: 6, 8, 10, 12, 2p, 4, 6, 8, 10, 12, 2, 4. */
const RHYTHM_BUCKETS = 12;
const BUCKET_HOURS = 2;
const RHYTHM_START_HOUR = 6;

/** ISO date "YYYY-MM-DD" — local. Stable bucket key for the daily array. */
function ymd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Activity-day key (rhythm boundary at 6 AM, not midnight) — anything
 *  before 6 AM is grouped with the previous calendar day's evening so
 *  the chart reads as a continuous "morning → late-night" timeline. */
function activityDayKey(d: Date = new Date()): string {
  const shifted = new Date(d.getTime() - RHYTHM_START_HOUR * 3600_000);
  return ymd(shifted);
}

/** Which 2-hour bucket a given hour-of-day belongs to, with 6 AM = 0
 *  so the visual order is 6am, 8am, 10am, 12, 2p, 4, 6p, 8p, 10p, 12,
 *  2am, 4am (next day). */
function bucketFor(hour: number): number {
  return Math.floor(((hour - RHYTHM_START_HOUR + 24) % 24) / BUCKET_HOURS);
}

/** Public helper for screens that need the current-hour highlight. */
export function currentRhythmBucket(): number {
  return bucketFor(new Date().getHours());
}

export interface DailyBucket {
  date: string;     // YYYY-MM-DD
  steps: number;
  activeMin: number;
}

export interface ActivityMix {
  walking: number;  // minutes today in WALKING (+ STAIRS, folded on the GW5)
  jogging: number;  // minutes today in JOGGING
  resting: number;  // minutes today in STATIONARY / SITTING / LAYING / unknown
}

interface ActivityHistoryState {
  /** 12 × 2-hour buckets covering one activity day (6am → 6am next).
   *  Index 0 = 06:00-07:59; index 11 = 04:00-05:59. */
  rhythm12h: number[];
  /** Last 30 calendar days, most-recent last. The 7-day Week view and
   *  30-day Month view both index off this single buffer. */
  daily: DailyBucket[];
  /** Today's activity-class breakdown in minutes. */
  todayMix: ActivityMix;
  /** Calendar date the daily aggregation + todayMix correspond to
   *  (midnight boundary). */
  currentDate: string;
  /** Activity-day key (6 AM boundary) — rhythm resets when this flips. */
  rhythmDayKey: string;

  /** Hydrate from AsyncStorage. Call once at startup. */
  load: () => Promise<void>;

  /** Called every minute by the ticker. `steps` is the lifetime step counter
   *  for "today" so the store records deltas. */
  tick: (activity: string | null, steps: number) => void;

  /** Seed plausible-looking data so demo mode has a populated chart
   *  on first render instead of waiting minutes for the ticker to
   *  accumulate. Idempotent — safe to call repeatedly. */
  seedDemo: () => void;

  /** Clear everything — used on sign-out. */
  reset: () => void;
}

// v2 — rhythm buckets switched from 12×1h to 12×2h; old v1 data
// would render with the wrong x-axis labels. Bumping discards it.
const STORAGE_KEY = 'activity_history.v2';

function emptyRhythm(): number[] {
  return new Array(RHYTHM_BUCKETS).fill(0);
}

function emptyMix(): ActivityMix {
  return { walking: 0, jogging: 0, resting: 0 };
}

function classify(act: string | null): 'walking' | 'jogging' | 'resting' {
  const a = (act || '').toUpperCase();
  // WISDM (current model) emits WALKING / JOGGING / STATIONARY (the GW5 folds
  // STAIRS into WALKING upstream). Jogging is its own bucket; STAIRS + the
  // legacy UCI ambulatory labels fold into walking so historical/demo rows
  // still bucket correctly.
  if (a === 'JOGGING' || a === 'RUNNING') return 'jogging';
  if (a === 'WALKING' || a === 'STAIRS' || a === 'UPSTAIRS' || a === 'DOWNSTAIRS') return 'walking';
  // STATIONARY, STANDING, SITTING, LAYING, null, unknown → resting
  return 'resting';
}

/** True if the bucket is "active" (counts toward minutes active / rhythm). */
function isActive(act: string | null): boolean {
  return classify(act) !== 'resting';
}

export const useActivityHistoryStore = create<ActivityHistoryState>((set, get) => ({
  rhythm12h: emptyRhythm(),
  daily: [],
  todayMix: emptyMix(),
  currentDate: ymd(),
  rhythmDayKey: activityDayKey(),

  load: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ActivityHistoryState>;
      set({
        rhythm12h: parsed.rhythm12h?.length === RHYTHM_BUCKETS ? parsed.rhythm12h : emptyRhythm(),
        daily: parsed.daily ?? [],
        todayMix: { ...emptyMix(), ...(parsed.todayMix ?? {}) },
        currentDate: parsed.currentDate ?? ymd(),
        rhythmDayKey: parsed.rhythmDayKey ?? activityDayKey(),
      });
    } catch (err) {
      console.warn('[activity-history] load failed:', err);
    }
  },

  tick: (activity, steps) => {
    const now = new Date();
    const today = ymd(now);
    const todayActivityDay = activityDayKey(now);
    const s = get();

    // Two rollovers fire independently:
    //  - Calendar day (midnight): resets todayMix + freezes yesterday's
    //    activeMin into the daily[] bucket
    //  - Activity day (6 AM): resets rhythm12h so the chart reads
    //    "morning → late-night" left-to-right without wrapping
    const next: ActivityHistoryState = { ...s };
    if (today !== s.currentDate) {
      const yesterdayActive = s.rhythm12h.reduce((acc, n) => acc + n, 0);
      const last = s.daily[s.daily.length - 1];
      const carry: DailyBucket[] = (last && last.date === s.currentDate)
        ? s.daily.slice(0, -1).concat({ ...last, activeMin: yesterdayActive })
        : s.daily.concat({ date: s.currentDate, steps: 0, activeMin: yesterdayActive });
      next.daily = carry.slice(-30);
      next.todayMix = emptyMix();
      next.currentDate = today;
    }
    if (todayActivityDay !== s.rhythmDayKey) {
      next.rhythm12h = emptyRhythm();
      next.rhythmDayKey = todayActivityDay;
    }

    // Bump the bucket for now's hour — covers all 24 hours, so no
    // time restriction needed.
    if (isActive(activity)) {
      const idx = bucketFor(now.getHours());
      next.rhythm12h = next.rhythm12h.map((v, i) => i === idx ? v + 1 : v);
    }

    // Activity mix: always add a minute to one of the three buckets.
    const cls = classify(activity);
    next.todayMix = { ...next.todayMix, [cls]: next.todayMix[cls] + 1 };

    // Today's daily bucket — upsert with latest steps + activeMin running
    // total. Never let live steps regress (handles demo-seeded values
    // and any spurious zeros from the live counter on startup).
    const totalActive = next.rhythm12h.reduce((acc, n) => acc + n, 0);
    const todayIdx = next.daily.findIndex((d) => d.date === today);
    if (todayIdx >= 0) {
      const prevSteps = next.daily[todayIdx].steps;
      next.daily = next.daily.map((d, i) => i === todayIdx
        ? { date: today, steps: Math.max(prevSteps, steps), activeMin: totalActive }
        : d);
    } else {
      next.daily = next.daily.concat({ date: today, steps, activeMin: totalActive }).slice(-30);
    }

    set(next);

    // Persist (fire-and-forget — fine if it lands after the next tick).
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      rhythm12h: next.rhythm12h,
      daily: next.daily,
      todayMix: next.todayMix,
      currentDate: next.currentDate,
      rhythmDayKey: next.rhythmDayKey,
    })).catch((err) => console.warn('[activity-history] persist failed:', err));
  },

  seedDemo: () => {
    const now = new Date();
    const today = ymd(now);
    const activityDay = activityDayKey(now);

    // Rhythm: 12 × 2-hour buckets covering 6am → 6am. Realistic peak
    // pattern: morning routine, lunch walk, afternoon push, evening
    // wind-down, sleeping hours empty. Per-bucket max is 120 min
    // (2 h × 60), so we stay well under that ceiling.
    // Buckets: 0=6-8a, 1=8-10a, 2=10-12, 3=12-2p, 4=2-4p, 5=4-6p,
    //          6=6-8p, 7=8-10p, 8=10-12a, 9=12-2a, 10=2-4a, 11=4-6a
    const peakPattern = [
      32,  // 6-8 AM   — morning routine
      55,  // 8-10 AM  — commute / walk
      40,  // 10-12    — desk / mid-morning
      72,  // 12-2 PM  — lunch peak
      52,  // 2-4 PM   — afternoon
      68,  // 4-6 PM   — evening walk
      42,  // 6-8 PM   — errands / dinner
      24,  // 8-10 PM  — winding down
      8,   // 10-12 AM — getting ready for bed
      0,   // 12-2 AM  — sleeping
      0,   // 2-4 AM   — sleeping
      0,   // 4-6 AM   — sleeping
    ];
    // Zero buckets we haven't reached yet in the current activity day,
    // so the chart still "grows" as time passes.
    const currentBucket = bucketFor(now.getHours());
    const rhythm = peakPattern.map((v, i) =>
      i > currentBucket ? 0 : v
    );

    // Today's mix, derived from the synthesized rhythm so the donut and the
    // bar chart agree. The WISDM model's three classes are walking / jogging /
    // stationary, so split the active minutes mostly-walking with a small jog
    // slice (~12 %) — the live demo tick refines this from the mock 'Jogging'
    // samples. Resting fills the rest.
    const activeMin = rhythm.reduce((a, b) => a + b, 0);
    const minutesElapsedToday = now.getHours() * 60 + now.getMinutes();
    const restingMin = Math.max(0, minutesElapsedToday - activeMin);
    const joggingMin = Math.round(activeMin * 0.12);
    const mix: ActivityMix = {
      walking: activeMin - joggingMin,
      jogging: joggingMin,
      resting: restingMin,
    };

    // Daily 30-day series: 3500-8500 steps with a weekly rhythm
    // (weekends lower), active minutes 25-90 per day. Today inherits
    // the live values computed below.
    const daily: DailyBucket[] = [];
    for (let i = 29; i >= 1; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dow = d.getDay(); // 0 = Sun
      const weekend = dow === 0 || dow === 6;
      // Sinusoidal jitter so the chart has natural-looking variance.
      const jitter = Math.round(Math.sin(i * 0.7) * 900);
      const baseSteps = weekend ? 4500 : 6300;
      const baseActive = weekend ? 38 : 55;
      daily.push({
        date: ymd(d),
        steps: Math.max(2000, baseSteps + jitter),
        activeMin: Math.max(15, baseActive + Math.round(Math.cos(i * 0.5) * 12)),
      });
    }
    // Today: scale lifetime steps proportional to hours elapsed.
    const todaySteps = Math.round((minutesElapsedToday / (12 * 60)) * 6800);
    daily.push({ date: today, steps: todaySteps, activeMin });

    set({
      rhythm12h: rhythm,
      daily,
      todayMix: mix,
      currentDate: today,
      rhythmDayKey: activityDay,
    });
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({
      rhythm12h: rhythm, daily, todayMix: mix, currentDate: today,
      rhythmDayKey: activityDay,
    })).catch(() => {});
  },

  reset: () => {
    set({
      rhythm12h: emptyRhythm(),
      daily: [],
      todayMix: emptyMix(),
      currentDate: ymd(),
      rhythmDayKey: activityDayKey(),
    });
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  },
}));
