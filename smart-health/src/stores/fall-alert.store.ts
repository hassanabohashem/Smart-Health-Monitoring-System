/**
 * Global fall-alert state.
 *
 * Lives at the root so the FallOverlay covers every screen (Home,
 * Activity, Assistant, Settings, even the caregiver flow if a fall
 * test fires while logged in as a caregiver) — not just the Home
 * tab where the AI service is initialized.
 *
 * Flow:
 *   onFallDetected callback (registered once in app/_layout.tsx)
 *     → useFallAlertStore.trigger(confidence)
 *     → FallOverlay renders, countdown ticks every second
 *     → user taps "I'm okay" → cancel() → overlay hides
 *     → or countdown hits 0 → confirmFallAlert() → cancel() → overlay hides
 *
 * `isDemo: true` skips the Supabase write + caregiver push when the
 * countdown finishes, so the DEV trigger pill is a true visual-only
 * test that doesn't notify anyone.
 */

import { create } from 'zustand';

interface FallAlertState {
  countdown: number | null;
  confidence: number;
  isDemo: boolean;

  /** Start the countdown. Idempotent — if a countdown is already
   *  running, ignores the new trigger. */
  trigger: (confidence: number, opts?: { isDemo?: boolean }) => void;
  /** Used by the host's interval to count down each second. */
  tick: () => void;
  /** Clear all state. Called on user cancel and on countdown completion. */
  cancel: () => void;
}

export const useFallAlertStore = create<FallAlertState>((set, get) => ({
  countdown: null,
  confidence: 0,
  isDemo: false,

  trigger: (confidence, opts) => {
    if (get().countdown !== null) return; // already counting down
    set({ countdown: 15, confidence, isDemo: opts?.isDemo ?? false });
  },

  tick: () => {
    const c = get().countdown;
    if (c === null) return;
    set({ countdown: Math.max(0, c - 1) });
  },

  cancel: () => set({ countdown: null, confidence: 0, isDemo: false }),
}));
