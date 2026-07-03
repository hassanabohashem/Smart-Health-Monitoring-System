/**
 * Place an emergency phone call to the wearer's resolved contact. Shared by the
 * fall overlay (auto-fired on a confirmed fall) and the manual SOS button so
 * both behave identically.
 *
 * Resolution priority (matches the ★ "main" on the Emergency-contacts screen):
 *   1. The wearer's chosen main (`profiles.primary_emergency_phone`), matched by
 *      phone against both manual contacts AND linked caregivers.
 *   2. The first linked caregiver (auto, can't-be-removed emergency contact).
 *   3. Any other manual contact.
 *
 * On Android it auto-dials via ACTION_CALL (needs CALL_PHONE, requested on first
 * use); if denied — or on iOS, which can't auto-dial — it falls back to opening
 * the dialer pre-filled (`tel:`). An emergency should reach a human.
 */

import { Platform, PermissionsAndroid, Linking } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import { getLinkedCaregivers } from '@/services/link.service';
import { normalizePhone, samePhone } from '@/utils/phone';
import type { EmergencyContact } from '@/types/user.types';

export async function placeEmergencyCall(
  wearerId: string,
  emergencyContacts: EmergencyContact[] | undefined,
  mainPhone: string | null | undefined,
): Promise<void> {
  const manualPhones = (emergencyContacts ?? [])
    .map((c) => c?.phone)
    .filter((p): p is string => !!p);
  let caregiverPhones: string[] = [];
  try {
    const links = (await getLinkedCaregivers(wearerId)) as Array<{ caregiver?: { phone?: string } }>;
    caregiverPhones = links.map((l) => l.caregiver?.phone).filter((p): p is string => !!p);
  } catch (err) {
    console.warn('[emergency-call] caregiver lookup failed', err);
  }

  // 1. The chosen main, matched (by phone) against both lists. 2. Else the
  // first linked caregiver. 3. Else any manual contact.
  let dial: string | undefined;
  if (mainPhone) {
    dial = [...manualPhones, ...caregiverPhones].find((p) => samePhone(p, mainPhone));
  }
  if (!dial) dial = caregiverPhones[0];
  if (!dial) dial = manualPhones[0];
  if (!dial) {
    console.warn('[emergency-call] no emergency contact or caregiver phone to call');
    return;
  }

  const num = normalizePhone(dial);
  // Android: true auto-dial via ACTION_CALL — rings with zero taps, the point
  // for an incapacitated wearer. Needs CALL_PHONE (requested on first use).
  if (Platform.OS === 'android') {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CALL_PHONE,
        {
          title: 'Place emergency call',
          message: 'Allow Smart Health to call your emergency contact automatically in an emergency.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        },
      );
      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        await IntentLauncher.startActivityAsync('android.intent.action.CALL', { data: `tel:${num}` });
        return;
      }
    } catch (err) {
      console.warn('[emergency-call] auto-dial failed, falling back to dialer', err);
    }
  }
  // Fallback (iOS, permission denied, or auto-dial error): open the dialer
  // pre-filled so the call is one tap away.
  await Linking.openURL(`tel:${num}`);
}
