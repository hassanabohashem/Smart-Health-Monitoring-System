/**
 * Background-monitoring control (Android).
 *
 * Starts/stops the native MonitoringService foreground service, whose job is to
 * keep the app process alive so the existing JS pipeline — vitals persistence +
 * fall / HAR / cardiac ONNX inference (see wear/sensor-listener.ts) — keeps
 * running when the app is backgrounded / screen-off / swiped from recents.
 * Without it, Android freezes the cached process and all monitoring pauses.
 *
 * No-op on iOS (no equivalent always-on foreground service) and in Expo Go /
 * if the native module isn't registered.
 */

import { NativeModules, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface MonitoringBridge {
  startMonitoring?: () => Promise<boolean>;
  stopMonitoring?: () => Promise<boolean>;
  isIgnoringBatteryOptimizations?: () => Promise<boolean>;
  requestIgnoreBatteryOptimizations?: () => Promise<boolean>;
}

const bridge = NativeModules.WearSensorBridge as MonitoringBridge | undefined;

// Persisted flag so we ask for the battery-optimization exemption only once.
const BATTERY_PROMPT_KEY = 'battery_opt_prompted.v1';

let active = false;

/**
 * Start the foreground service. Idempotent. Always called for a logged-in
 * wearer (background monitoring has no user toggle).
 */
export async function startBackgroundMonitoring(): Promise<void> {
  if (active) return;
  if (Platform.OS !== 'android') return;
  if (!bridge?.startMonitoring) {
    console.warn('[monitoring] native bridge unavailable — FGS not started');
    return;
  }
  try {
    await bridge.startMonitoring();
    active = true;
    if (__DEV__) console.log('[monitoring] foreground service started');
    void maybePromptBatteryExemption();
  } catch (err) {
    console.warn('[monitoring] startMonitoring failed', err);
  }
}

/**
 * Ask the user — once — to exempt the app from battery optimization (Doze /
 * OEM battery managers) so the monitoring foreground service isn't killed in
 * the background. No-op if already exempt or already asked.
 */
async function maybePromptBatteryExemption(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (!bridge?.isIgnoringBatteryOptimizations || !bridge?.requestIgnoreBatteryOptimizations) return;
  try {
    if (await bridge.isIgnoringBatteryOptimizations()) return;
    if (await AsyncStorage.getItem(BATTERY_PROMPT_KEY)) return;
    await AsyncStorage.setItem(BATTERY_PROMPT_KEY, '1');
    if (__DEV__) console.log('[monitoring] requesting battery-optimization exemption');
    await bridge.requestIgnoreBatteryOptimizations();
  } catch (err) {
    console.warn('[monitoring] battery-exemption prompt failed', err);
  }
}

/** Stop the foreground service (logout / preference off). Idempotent. */
export async function stopBackgroundMonitoring(): Promise<void> {
  if (!active) return;
  active = false;
  if (Platform.OS !== 'android') return;
  try {
    await bridge?.stopMonitoring?.();
  } catch (err) {
    console.warn('[monitoring] stopMonitoring failed', err);
  }
}

export function isBackgroundMonitoringActive(): boolean {
  return active;
}
