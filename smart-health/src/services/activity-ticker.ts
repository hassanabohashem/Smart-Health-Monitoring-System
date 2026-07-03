/**
 * Activity ticker — once-a-minute interval that snapshots the current
 * vitals into `useActivityHistoryStore`. The store decides which
 * bucket(s) to increment.
 *
 * Lifecycle: started once from `AuthGate` in `app/_layout.tsx` after
 * the activity-history store is loaded, stopped on sign-out / unmount.
 */

import { useVitalsStore } from '@/stores/vitals.store';
import { useActivityHistoryStore } from '@/stores/activity-history.store';

const TICK_MS = 60_000; // 1 minute
/** Only count a tick toward today's mix / rhythm if vitals were updated
 *  within this window. Without it, a stale "Resting" reading would
 *  silently inflate the resting bucket for every minute the app sits
 *  open — eventually drowning out the active minutes entirely. */
const FRESH_WINDOW_MS = 90_000; // 1.5 minutes

let timer: ReturnType<typeof setInterval> | null = null;

function tickOnce() {
  const v = useVitalsStore.getState();
  // Skip ticks while the vitals stream is stale (no real watch, no
  // demo mode, or the wear bridge has been disconnected). Today's
  // step count still trends correctly because the bucket update is
  // clamped via Math.max in the store.
  if (!v.lastUpdated || Date.now() - v.lastUpdated > FRESH_WINDOW_MS) {
    return;
  }
  useActivityHistoryStore.getState().tick(v.currentActivity ?? null, v.steps ?? 0);
}

export function startActivityTicker() {
  if (timer) return;
  // First tick immediately so the screen has data on first render.
  tickOnce();
  timer = setInterval(tickOnce, TICK_MS);
}

export function stopActivityTicker() {
  if (timer) clearInterval(timer);
  timer = null;
}
