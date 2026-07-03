/**
 * Read-side Supabase wrapper for the `vitals` table. The write side
 * is owned by the wear listener (real watch) and `mock-vitals.service`
 * (demo mode). Used by Wearer Detail on the caregiver flow.
 */

import { supabase } from '@/services/supabase';

export interface VitalsRow {
  id: string;
  user_id: string;
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  activity: string | null;
  recorded_at: string;
  /** JSONB blob. `source` tags demo rows; `steps` carries the wearer's
   *  cumulative step count at write time so the caregiver's Wearer Detail
   *  can show it (there's no dedicated `steps` column). Real-watch writers
   *  should include `steps` here too once a server-side persister exists. */
  metadata?: { source?: string; steps?: number; ecgClass?: string | null } | null;
}

/** Latest single vitals row for a wearer, or null if nothing recorded. */
export async function getLatestVitals(wearerId: string): Promise<VitalsRow | null> {
  const { data, error } = await supabase
    .from('vitals')
    .select('*')
    .eq('user_id', wearerId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as VitalsRow | null) ?? null;
}

/** Last `limit` rows for the wearer, oldest first — feeds the trend
 *  charts on Wearer Detail. Sparse data is fine: charts handle gaps. */
export async function getRecentVitals(
  wearerId: string,
  limit: number = 24,
): Promise<VitalsRow[]> {
  const { data, error } = await supabase
    .from('vitals')
    .select('*')
    .eq('user_id', wearerId)
    .order('recorded_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  // Reverse so callers get chronological order (oldest left, latest right).
  return ((data as VitalsRow[] | null) ?? []).slice().reverse();
}

/** Vitals within the last `days` calendar-days, anchored to `anchorDate`
 *  (defaults to today). Used by the Activity tab to render HR / SpO₂ /
 *  Temperature trend charts that flip with the Day/Week/Month range
 *  pill. `cap` bounds the row count so a chatty watch can't blow up
 *  the JSON payload — the chart re-buckets client-side anyway.
 *  Ordered DESC at the wire and reversed client-side, so the cap takes
 *  the *newest* rows in the range rather than truncating the recent
 *  end. Returned chronologically (oldest first). */
export async function getVitalsForRange(
  wearerId: string,
  days: number,
  anchorDate: Date = new Date(),
  cap: number = 1000,
): Promise<VitalsRow[]> {
  const end = new Date(anchorDate);
  end.setHours(23, 59, 59, 999);
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  const { data, error } = await supabase
    .from('vitals')
    .select('*')
    .eq('user_id', wearerId)
    .gte('recorded_at', start.toISOString())
    .lte('recorded_at', end.toISOString())
    .order('recorded_at', { ascending: false })
    .limit(cap);
  if (error) throw error;
  return ((data as VitalsRow[] | null) ?? []).slice().reverse();
}
