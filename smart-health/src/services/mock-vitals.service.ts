import { useVitalsStore } from '@/stores/vitals.store';
import { useDeviceStore } from '@/stores/device.store';
import { supabase } from './supabase';
import { queueVitals } from './offline-queue.service';
import { createAlert } from './alert.service';
import { notifyCaregivers } from './notification.service';
import { useAuthStore } from '@/stores/auth.store';

let intervalId: ReturnType<typeof setInterval> | null = null;
// Fire the low-battery alert once per drain-below-threshold (reset on recharge
// / stop). Battery is demo-only (not in the real watch packet), so this is the
// only place a low_battery alert can originate today.
let lowBatteryAlerted = false;

// Generate realistic-ish vital signs with slight variance
function randomInRange(base: number, variance: number): number {
  return Math.round((base + (Math.random() - 0.5) * 2 * variance) * 10) / 10;
}

// The WISDM HAR label set the real model actually produces (stairs fold into
// Walking on the GW5; the model can't separate light activity). Weighted toward
// Stationary like a real day, with occasional Jogging — so demo matches what the
// live classifier would show, not the old richer-but-fake UCI vocabulary.
const ACTIVITIES = ['Stationary', 'Stationary', 'Stationary', 'Walking', 'Walking', 'Jogging'];

type DayMod = {
  hrDrift: number;    // gradual baseline change (+ = higher HR)
  hrBoost: number;    // bad-sleep / fever add-on
  tempBoost: number;  // fever offset (0 = normal)
  spo2Dip: number;    // bad-night SpO₂ dip (0 = normal)
  spikeMult: number;  // multiplier for walking-spike probability
};

const NORMAL_DAY: DayMod = {
  hrDrift: 0, hrBoost: 0, tempBoost: 0, spo2Dip: 0, spikeMult: 1,
};

/** Per-day variation so 30 days of backfill don't look identical.
 *  - Slow fitness drift: resting HR was ~5 bpm higher 30 days ago
 *  - Weekend: fewer walking spikes (calmer line)
 *  - ~15 % of days: bad-sleep night (elevated HR, slight SpO₂ dip)
 *  - ~5 %  of days: fever (elevated temp + HR for the day)
 *
 *  Today (dayOffset=0) always returns NORMAL_DAY so the historical
 *  mods don't bleed into the live-tick stream. */
function dayModFor(dayOffset: number): DayMod {
  if (dayOffset === 0) return NORMAL_DAY;

  const t = new Date();
  t.setDate(t.getDate() - dayOffset);
  const dow = t.getDay();
  const isWeekend = dow === 0 || dow === 6;

  // Linear fitness drift: oldest day +5 bpm baseline, today 0.
  const hrDrift = (dayOffset / 29) * 5;

  const badSleep = Math.random() < 0.15;
  const fever    = Math.random() < 0.05;

  const hrBoost =
    (badSleep ? 8 + Math.random() * 4 : 0) +
    (fever    ? 10 + Math.random() * 5 : 0);
  const spo2Dip   = badSleep ? 1 + Math.random() : 0;
  const tempBoost = fever ? 0.8 + Math.random() * 0.7 : 0;
  const spikeMult = isWeekend ? 0.6 : 1.0;

  return { hrDrift, hrBoost, tempBoost, spo2Dip, spikeMult };
}

/** Generate one plausible vitals reading for `t`, with diurnal
 *  variation (lower HR + lower temp at night, slightly elevated in
 *  the afternoon, occasional walking spike during 9 AM – 6 PM).
 *  `mod` layers per-day variation on top (drift, illness, weekend). */
function diurnalReading(t: Date, mod: DayMod = NORMAL_DAY) {
  const hour = t.getHours();
  const sleeping = hour >= 23 || hour < 6;
  const morning  = hour >= 6  && hour < 12;
  const afternoon = hour >= 12 && hour < 18;
  const evening   = hour >= 18 && hour < 23;
  const spike = (morning || afternoon) && Math.random() < 0.15 * mod.spikeMult;
  const baseHR =
    (sleeping   ? 60
    : spike     ? 95
    : morning   ? 74
    : afternoon ? 78
    : evening   ? 70
    : 68) + mod.hrDrift + mod.hrBoost;
  const baseTemp =
    (sleeping   ? 36.3
    : afternoon ? 36.8
    : evening   ? 36.6
    : 36.5) + mod.tempBoost;
  const baseSpo2 = (sleeping ? 97 : 98) - mod.spo2Dip;
  return {
    heart_rate:  Math.max(50, Math.min(125, Math.round(randomInRange(baseHR, 5)))),
    spo2:        Math.max(92, Math.min(100, Math.round(randomInRange(baseSpo2, 1)))),
    temperature: Math.round(randomInRange(baseTemp, 0.2) * 10) / 10,
    activity: sleeping ? 'Stationary'
      : spike     ? (Math.random() < 0.4 ? 'Jogging' : 'Walking')
      : afternoon ? (Math.random() < 0.3 ? 'Walking' : 'Stationary')
      : morning   ? (Math.random() < 0.3 ? 'Walking' : 'Stationary')
      : 'Stationary',
  };
}

/** Idempotent 30-day backfill. Skips only when the user already has
 *  meaningful historical data — defined as ≥5 rows older than 7 days.
 *  A small pool of recent rows (e.g. a previous short backfill or one
 *  active session) doesn't count as "history" and is allowed to be
 *  topped up to a full 30-day span. */
async function backfillDemoHistory(wearerId: string): Promise<void> {
  const olderThan = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
  const { count, error: countErr } = await supabase
    .from('vitals')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', wearerId)
    .lt('recorded_at', olderThan);
  if (countErr) {
    console.warn('[mock-vitals] backfill count check failed', countErr.message);
    return;
  }
  if ((count ?? 0) >= 5) {
    // Looks like genuine multi-week history exists — don't double-write.
    return;
  }

  const nowMs = Date.now();
  const rows: Array<{
    user_id: string;
    heart_rate: number;
    spo2: number;
    temperature: number;
    activity: string;
    recorded_at: string;
    metadata: { source: string; steps: number; ecgClass: string };
  }> = [];
  // 30 days × 12 readings/day (every 2 h) = up to 360 rows. Skip any
  // bucket whose timestamp would be in the future (matters when the
  // user toggles demo on at, say, 14:00 — we don't want rows dated
  // 16:00, 18:00, … today).
  for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
    const mod = dayModFor(dayOffset);
    for (let bucket = 0; bucket < 12; bucket++) {
      const t = new Date(nowMs);
      t.setDate(t.getDate() - dayOffset);
      // Center the row inside the 2-h window with light jitter.
      t.setHours(bucket * 2 + 1, Math.floor(Math.random() * 50) + 5, 0, 0);
      if (t.getTime() > nowMs) continue;
      const r = diurnalReading(t, mod);
      // Cumulative steps so far that day — ramps 0 → daily total across
      // waking hours (06:00 → 21:00) so a caregiver opening Wearer Detail
      // on a historical row sees a plausible count (the live tick below
      // writes the real running total).
      const minOfDay = t.getHours() * 60 + t.getMinutes();
      const wakeFrac = Math.max(0, Math.min(1, (minOfDay - 360) / 900));
      const daySteps = Math.round(wakeFrac * (5000 + Math.random() * 3500));
      // Mostly-normal ECG history with the occasional irregular reading
      // so the caregiver's ECG tile + (future) history isn't monotone.
      const ecgClass = Math.random() < 0.12 ? 'irregular' : 'normal';
      rows.push({
        user_id: wearerId,
        heart_rate: r.heart_rate,
        spo2: r.spo2,
        temperature: r.temperature,
        activity: r.activity,
        recorded_at: t.toISOString(),
        metadata: { source: 'demo', steps: daySteps, ecgClass },
      });
    }
  }

  const { error: insertErr } = await supabase.from('vitals').insert(rows);
  if (insertErr) {
    console.warn('[mock-vitals] backfill insert failed', insertErr.message);
  }
}

export function startMockVitals(wearerId?: string) {
  if (intervalId) return;

  // Simulate connection. Battery seed is randomised to 60-89% so
  // each demo session feels different and we're not always staring
  // at "78%"; the live tick already drains it slowly from there.
  useDeviceStore.getState().setConnected(true);
  useDeviceStore.getState().setBatteryLevel(60 + Math.floor(Math.random() * 30));
  lowBatteryAlerted = false;

  // Initial values — seed steps proportional to time-of-day so the
  // Home Steps card + Activity charts aren't empty at first paint.
  // HR / SpO₂ / Temp seeded from the current demo-config intensity
  // so flipping the levels in Settings *before* enabling demo also
  // shows the chosen baseline at first paint. ECG seeded with a
  // plausible-looking "normal" result a few minutes ago so the tile
  // mirrors a recently-taken reading instead of sitting at "tap to
  // measure" — matches the SpO2 seed pattern.
  const now = new Date();
  const minutesElapsed = now.getHours() * 60 + now.getMinutes();
  const seedSteps = Math.round((minutesElapsed / (12 * 60)) * 6800);
  const cfg = useDeviceStore.getState().demoConfig;
  // Baselines: Low and High deliberately sit just past the wellness
  // banner / tile thresholds (HR < 60 or > 100, SpO₂ < 95, Temp < 36
  // or > 37.5) so flipping a level produces a visible state change.
  const seedHR   = cfg.hr   === 'low' ? 56   : cfg.hr   === 'high' ? 108  : 72;
  const seedSpo2 = cfg.spo2 === 'low' ? 92   : cfg.spo2 === 'high' ? 99   : 98;
  const seedTemp = cfg.temp === 'low' ? 35.7 : cfg.temp === 'high' ? 38.0 : 36.6;
  // ECG: confidence stays plausible regardless of class (the model
  // could be 80% sure of "Irregular" too).
  const seedEcgConf = cfg.ecg === 'normal' ? 0.92 : 0.78;
  useVitalsStore.getState().updateVitals({
    heartRate: seedHR,
    spo2: seedSpo2,
    spo2At: Date.now() - 4 * 60_000,
    temperature: seedTemp,
    ecgClass: cfg.ecg,
    ecgConfidence: seedEcgConf,
    ecgAt: Date.now() - 8 * 60_000,
    currentActivity: cfg.activity === 'walking' ? 'Walking'
      : cfg.activity === 'jogging' ? 'Jogging'
      : 'Stationary',
    steps: seedSteps,
  });

  // Backfill 30 days of plausible vitals (1 row per 2 hours) so the
  // Activity trend cards have full Day / Week / Month coverage as soon
  // as the user lands on the tab. Idempotent: if the user already has
  // historical data (any row >2 h old), skip — flipping demo on/off
  // shouldn't pile up duplicate readings.
  if (wearerId) {
    backfillDemoHistory(wearerId).catch((err) => {
      console.warn('[mock-vitals] backfill failed', err);
    });
  }

  let persistCounter = 0;

  // Update every 3 seconds with slight variations
  intervalId = setInterval(() => {
    const current = useVitalsStore.getState();
    const cfg = useDeviceStore.getState().demoConfig;
    // Baselines per intensity level. Low/High deliberately sit just
    // past the wellness thresholds (HR < 60 or > 100, SpO₂ < 95,
    // Temp < 36 or > 37.5) so flipping a level visibly trips the
    // banner. Read fresh on each tick so a flip in Settings →
    // Demo controls pulls the live values to the new baseline
    // within ~3 sec.
    const hrBase   = cfg.hr   === 'low'  ? 56
                  : cfg.hr   === 'high' ? 108
                  : 75;
    const spo2Base = cfg.spo2 === 'low'  ? 92
                  : cfg.spo2 === 'high' ? 99
                  : 97;
    const tempBase = cfg.temp === 'low'  ? 35.7
                  : cfg.temp === 'high' ? 38.0
                  : 36.6;

    // Activity: a forced pick from Settings → Demo controls overrides the
    // random walk; 'auto' keeps the occasional random transition.
    const forcedActivity =
      cfg.activity === 'walking'    ? 'Walking'
      : cfg.activity === 'jogging'    ? 'Jogging'
      : cfg.activity === 'stationary' ? 'Stationary'
      : null;
    const nextActivity = forcedActivity ?? (Math.random() > 0.9
      ? ACTIVITIES[Math.floor(Math.random() * ACTIVITIES.length)]
      : current.currentActivity);

    // Step delta per 3s tick — keyed to the activity we're about to set so
    // steps respond immediately when you force Walking/Jogging. Walking is a
    // brisk pace, Jogging faster, resting drifts.
    const act = (nextActivity || '').toUpperCase();
    const stepDelta =
      act === 'JOGGING' ? 12 + Math.floor(Math.random() * 8)
      : act === 'WALKING' ? 8 + Math.floor(Math.random() * 6)
      : 0;

    useVitalsStore.getState().updateVitals({
      heartRate:   Math.max(50, Math.min(125, Math.round(randomInRange(hrBase, 4)))),
      spo2:        Math.max(90, Math.min(100, Math.round(randomInRange(spo2Base, 1)))),
      temperature: Math.max(35.5, Math.min(38.5, randomInRange(tempBase, 0.2))),
      currentActivity: nextActivity,
      steps: (current.steps || 0) + stepDelta,
    });

    // Persist vitals to Supabase every 5th tick (~15 seconds). Tagged
    // with metadata.source='demo' so clearDemoHistory() can scope its
    // cleanup to demo-generated rows only — real watch data would be
    // written by the wear bridge without this tag and is left alone.
    if (wearerId) {
      persistCounter++;
      if (persistCounter % 5 === 0) {
        const v = useVitalsStore.getState();
        supabase.from('vitals').insert({
          user_id: wearerId,
          heart_rate: v.heartRate,
          spo2: v.spo2,
          temperature: v.temperature,
          activity: v.currentActivity,
          recorded_at: new Date().toISOString(),
          // `steps` + `ecgClass` ride in metadata (no dedicated columns)
          // so the caregiver's Wearer Detail can read the live count and
          // the latest cardiac class.
          metadata: { source: 'demo', steps: v.steps, ecgClass: v.ecgClass },
        }).then(({ error }) => {
          if (error) {
            queueVitals({
              user_id: wearerId,
              heart_rate: v.heartRate,
              spo2: v.spo2,
              temperature: v.temperature,
              activity: v.currentActivity,
              recorded_at: new Date().toISOString(),
              metadata: { source: 'demo', steps: v.steps, ecgClass: v.ecgClass },
            });
          }
        });
      }
    }

    // Slowly drain battery; fire a low-battery alert the first time it hits 20%.
    const battery = useDeviceStore.getState().batteryLevel;
    if (battery && Math.random() > 0.8) {
      const next = Math.max(0, battery - 1);
      useDeviceStore.getState().setBatteryLevel(next);
      if (next > 25) {
        lowBatteryAlerted = false;
      } else if (next <= 20 && !lowBatteryAlerted && wearerId) {
        lowBatteryAlerted = true;
        const name = useAuthStore.getState().profile?.full_name || 'Wearer';
        createAlert({
          wearer_id: wearerId,
          type: 'low_battery',
          severity: 'low',
          metadata: { battery_level: next, triggered_by: 'demo' },
        })
          .then((a) => notifyCaregivers(wearerId, name, 'low_battery', a.id))
          .catch((e) => console.warn('[mock-vitals] low-battery alert failed', e));
      }
    }
  }, 3000);
}

/** Delete every vitals row this user owns that was generated by demo
 *  mode (metadata.source = 'demo'). Real watch rows lack the tag and
 *  are preserved. Best-effort: failures are logged but don't block.
 *  Uses the `contains` JSONB operator (@>) which the Supabase JS
 *  client handles reliably, vs `->>` path filters that occasionally
 *  fail to serialise. */
async function clearDemoHistory(wearerId: string): Promise<void> {
  const { error, count } = await supabase
    .from('vitals')
    .delete({ count: 'exact' })
    .eq('user_id', wearerId)
    .contains('metadata', { source: 'demo' });
  if (error) {
    console.warn('[mock-vitals] demo cleanup failed', error.message);
  } else {
    console.log(`[mock-vitals] demo cleanup removed ${count ?? 0} rows`);
  }
}

export function stopMockVitals(wearerId?: string) {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  useDeviceStore.getState().setConnected(false);
  useDeviceStore.getState().setBatteryLevel(null);
  lowBatteryAlerted = false;
  useVitalsStore.getState().reset();
  // Wipe demo-tagged rows so the Activity tab + Wearer Detail don't
  // keep showing stale data after the user turned demo off. Real
  // watch rows (no metadata.source tag) are left alone.
  if (wearerId) {
    clearDemoHistory(wearerId).catch((err) => {
      console.warn('[mock-vitals] demo cleanup error', err);
    });
  }
}

// Generate mock history data for charts (last 24 hours)
export function generateMockHistory(hours: number = 24): {
  timestamps: string[];
  heartRates: number[];
  spo2Values: number[];
  temperatures: number[];
  steps: number[];
} {
  const now = Date.now();
  const interval = 30 * 60 * 1000; // 30 min intervals
  const points = Math.floor((hours * 60 * 60 * 1000) / interval);

  const timestamps: string[] = [];
  const heartRates: number[] = [];
  const spo2Values: number[] = [];
  const temperatures: number[] = [];
  const steps: number[] = [];

  for (let i = points - 1; i >= 0; i--) {
    const time = new Date(now - i * interval);
    timestamps.push(time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    const hour = time.getHours();
    // Simulate sleep (lower HR) at night
    const isSleeping = hour >= 23 || hour < 6;
    const baseHR = isSleeping ? 58 : (hour >= 10 && hour <= 14) ? 85 : 72;

    heartRates.push(Math.round(randomInRange(baseHR, 8)));
    spo2Values.push(Math.max(94, Math.min(100, Math.round(randomInRange(97.5, 1.5)))));
    temperatures.push(Math.round(randomInRange(36.5, 0.3) * 10) / 10);
    steps.push(isSleeping ? 0 : Math.floor(Math.random() * 300));
  }

  return { timestamps, heartRates, spo2Values, temperatures, steps };
}

// Generate daily step summary
export function generateDailySteps(): { day: string; steps: number }[] {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  return days.map((day) => ({
    day,
    steps: Math.floor(2000 + Math.random() * 6000),
  }));
}
