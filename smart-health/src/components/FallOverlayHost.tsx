/**
 * Singleton host for the FallOverlay. Mounted once at the root layout
 * so it renders above the Stack + tab bars and covers every screen
 * (caregiver, wearer, even the auth flow if a watch packet sneaks in).
 *
 * - Subscribes to `useFallAlertStore` for countdown + confidence
 * - Ticks the countdown every second while non-null
 * - On 0: confirmFallAlert (writes Supabase + notifies caregivers)
 *   unless the trigger was tagged `isDemo` (DEV pill on Home)
 * - On user "I'm okay" / cancel: clears the store, no Supabase write
 *
 * Doing this at root removes the previous limitation where the
 * overlay only appeared on the Home tab — falls detected while the
 * wearer was on Activity / Settings / etc. silently passed.
 */

import { useEffect } from 'react';
import { Vibration } from 'react-native';
import { useFallAlertStore } from '@/stores/fall-alert.store';
import { useAuthStore } from '@/stores/auth.store';
import { confirmFallAlert } from '@/services/ai';
import { getCurrentPosition } from '@/services/location.service';
import { placeEmergencyCall } from '@/services/emergency-call';
import { FallOverlay } from '@/design';

export function FallOverlayHost() {
  const countdown = useFallAlertStore((s) => s.countdown);
  const confidence = useFallAlertStore((s) => s.confidence);
  const isDemo = useFallAlertStore((s) => s.isDemo);
  const tick = useFallAlertStore((s) => s.tick);
  const cancel = useFallAlertStore((s) => s.cancel);
  const profile = useAuthStore((s) => s.profile);

  // Buzz on first appearance.
  useEffect(() => {
    if (countdown === 15) {
      Vibration.vibrate([0, 500, 200, 500, 200, 500]);
    }
  }, [countdown]);

  // Drive the per-second countdown.
  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      // Demo runs visual-only; skip the Supabase + caregiver write.
      if (isDemo) {
        cancel();
        return;
      }
      if (!profile?.id) {
        cancel();
        return;
      }
      (async () => {
        // A confirmed fall fires three independent steps (one failing must
        // not block the others): capture a location fix, file the alert +
        // push the caregivers, and place a phone call to a human.
        const pos = await getCurrentPosition().catch(() => null);
        try {
          await confirmFallAlert(
            profile.id,
            profile.full_name || 'Wearer',
            confidence,
            pos?.latitude,
            pos?.longitude,
          );
        } catch (err) {
          console.warn('[fall-overlay] confirmFallAlert failed', err);
        }
        try {
          await placeEmergencyCall(
            profile.id,
            profile.emergency_contacts,
            profile.primary_emergency_phone,
          );
        } catch (err) {
          console.warn('[fall-overlay] emergency call failed', err);
        }
        cancel();
      })();
      return;
    }
    const id = setInterval(() => tick(), 1000);
    return () => clearInterval(id);
  }, [countdown, isDemo, confidence, profile?.id, tick, cancel]);

  if (countdown === null || countdown <= 0) return null;
  return <FallOverlay countdownSeconds={countdown} onCancel={cancel} />;
}
