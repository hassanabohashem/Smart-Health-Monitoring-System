/**
 * Bridge between the native WearableListenerService and the JS-side
 * inference / vitals pipeline.
 *
 * Native side (Kotlin):
 *   - SensorDataReceiverService receives every /sensor_data packet from
 *     the paired Galaxy Watch 5 and emits a DeviceEventEmitter event
 *     named "WearSensorData" containing the raw JSON string.
 *   - Packets that arrive before the JS bundle is loaded are pushed
 *     onto WearSensorBuffer (a 32-deep ring); JS calls
 *     NativeModules.WearSensorBridge.drainBuffer() at init to replay
 *     them.
 *
 * This module:
 *   1. Subscribes to "WearSensorData" via NativeEventEmitter.
 *   2. Drains any cold-start buffer on first init.
 *   3. Parses each packet (typed as WearSensorPacket).
 *   4. Routes low-rate scalars (HR, steps, pressure) into useVitalsStore
 *      and sets the device-connected flag based on packet arrival.
 *   5. Forwards the per-second high-rate IMU window into imuWindowBuffer
 *      (which then fires fall and HAR inference).
 *   6. Forwards ECG windows into ecgSession (which calls cardiac
 *      inference when `isRecording`).
 *
 * The "connected" inference is a heartbeat: any packet within the last
 * 10 sec → connected. We don't currently have a clean disconnect signal
 * from the Wear OS Data Layer.
 */

import { NativeEventEmitter, NativeModules } from 'react-native';
import { useVitalsStore } from '@/stores/vitals.store';
import { useDeviceStore } from '@/stores/device.store';
import { useAuthStore } from '@/stores/auth.store';
import { supabase } from '@/services/supabase';
import { queueVitals } from '@/services/offline-queue.service';
import {
  processSensorWindow,
  processActivityWindow,
  onActivityDetected,
} from '../ai';
import { imuWindowBuffer } from './imu-window-buffer';
import { ecgSession } from './ecg-session';
import type { WearSensorEvent, WearSensorPacket } from './types';

const NATIVE_MODULE_NAME = 'WearSensorBridge';
const EVENT_NAME = 'WearSensorData';
const CONNECTED_TIMEOUT_MS = 10_000;
// Persist a watch vitals snapshot to Supabase at most this often so linked
// caregivers see live HR (the local store only drives the wearer's own UI).
const VITALS_PERSIST_INTERVAL_MS = 20_000;

interface NativeBridge {
  drainBuffer: () => Promise<string[]>;
  getBufferSize: () => Promise<number>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

const nativeBridge = NativeModules[NATIVE_MODULE_NAME] as NativeBridge | undefined;

let eventSub: { remove: () => void } | null = null;
let harUnsub: (() => void) | null = null;
let fallUnsub: (() => void) | null = null;
let connectedWatchdog: ReturnType<typeof setInterval> | null = null;
let lastPacketAtMs = 0;
let lastVitalsPersistMs = 0;
let initialized = false;

/**
 * Initialize the wear listener. Idempotent. Safe to call before login —
 * the inference pipeline reads `wearerId` lazily from useAuthStore when
 * a window is ready, so packets that arrive pre-login are dropped only
 * for the fall-alert path (HAR runs regardless, vitals update regardless).
 */
export async function initWearListener(): Promise<void> {
  if (initialized) return;
  if (!nativeBridge) {
    console.warn('[wear] NativeModules.WearSensorBridge is null — package not registered?');
    return;
  }

  // Wire IMU windows → fall / HAR inference. Subscribers stay live for
  // the lifetime of the listener; teardown is in disposeWearListener().
  harUnsub = imuWindowBuffer.onHarWindow(async (window) => {
    try {
      // WISDM dual-head model takes RAW physical units (accel m/s² incl.
      // gravity, gyro rad/s) and bakes in normalization + derived magnitude
      // channels — feed the resampled 20 Hz window as-is, no JS preprocessing.
      await processActivityWindow({ samples: window.samples });
    } catch (err) {
      console.warn('[wear] HAR window inference failed:', err);
    }
  });

  // Surface HAR predictions on the home screen's "Current activity"
  // banner. The UCI HAR labels (WALKING / SITTING / …) are uppercase;
  // we lowercase them for display.
  onActivityDetected((label) => {
    useVitalsStore.getState().updateVitals({
      currentActivity: label.charAt(0) + label.slice(1).toLowerCase(),
    });
  });
  fallUnsub = imuWindowBuffer.onFallWindow(async (window) => {
    const { profile } = useAuthStore.getState();
    if (!profile?.id) return;
    try {
      // FusionNet (Wrist) was trained on the FallAllD dataset whose IMU
      // values are in MPU-9250 raw counts (accel ≈ 4096 counts/g, gyro
      // ≈ 16.4 counts/°/s) and a StandardScaler is applied per channel.
      // Watch sends m/s² and rad/s — convert + scale before inference.
      // Scaler params extracted from `scaler_Wrist_honest.joblib`.
      const ACCEL_M_S2_TO_COUNTS = 4096 / 9.80665;     // ≈ 417.7
      const GYRO_RAD_TO_COUNTS = (180 / Math.PI) * 16.384; // ≈ 938.5
      const MEAN = [1808.834, -158.038, -755.762, 25.605, 34.677, 1.240, 1009.778];
      const SCALE = [3244.519, 3162.055, 2286.602, 1469.690, 1126.932, 1464.094, 8.873];
      const scaledImu: number[][] = window.imu.map(row => [
        ((row[0] * ACCEL_M_S2_TO_COUNTS) - MEAN[0]) / SCALE[0],
        ((row[1] * ACCEL_M_S2_TO_COUNTS) - MEAN[1]) / SCALE[1],
        ((row[2] * ACCEL_M_S2_TO_COUNTS) - MEAN[2]) / SCALE[2],
        ((row[3] * GYRO_RAD_TO_COUNTS) - MEAN[3]) / SCALE[3],
        ((row[4] * GYRO_RAD_TO_COUNTS) - MEAN[4]) / SCALE[4],
        ((row[5] * GYRO_RAD_TO_COUNTS) - MEAN[5]) / SCALE[5],
      ]);
      const scaledBaro: number[] = window.barometer.map(p => (p - MEAN[6]) / SCALE[6]);
      const result = await processSensorWindow(
        profile.id,
        profile.full_name || 'Wearer',
        { imu: scaledImu, barometer: scaledBaro },
      );
      // Log only when a fall actually fires (per-window logging was a
      // verification aid and spammed Metro at ~1/sec).
      if (result?.isFall) {
        console.log(`[wear] FALL detected p=${result.confidence.toFixed(3)}`);
      }
    } catch (err) {
      console.warn('[wear] fall window inference failed:', err);
    }
  });

  // Subscribe to live packets before draining the cold-start buffer so
  // we don't miss anything that arrives during the drain handshake.
  const emitter = new NativeEventEmitter(NativeModules[NATIVE_MODULE_NAME]);
  eventSub = emitter.addListener(EVENT_NAME, (e: WearSensorEvent) => {
    handleRawPacket(e.json, e.receivedAtMs);
  });

  // Drain whatever the native service buffered while JS was warming up.
  try {
    const queued = await nativeBridge.drainBuffer();
    if (queued.length > 0) {
      console.log(`[wear] draining ${queued.length} cold-start packet(s)`);
      for (const json of queued) handleRawPacket(json, Date.now());
    }
  } catch (err) {
    console.warn('[wear] drainBuffer failed:', err);
  }

  // Watchdog: flip the device-store connected flag based on packet recency.
  connectedWatchdog = setInterval(() => {
    const since = Date.now() - lastPacketAtMs;
    const connected = lastPacketAtMs > 0 && since < CONNECTED_TIMEOUT_MS;
    const current = useDeviceStore.getState().isConnected;
    if (current !== connected) {
      useDeviceStore.getState().setConnected(connected);
    }
  }, 2000);

  initialized = true;
}

export function disposeWearListener(): void {
  if (eventSub) {
    eventSub.remove();
    eventSub = null;
  }
  if (harUnsub) {
    harUnsub();
    harUnsub = null;
  }
  if (fallUnsub) {
    fallUnsub();
    fallUnsub = null;
  }
  if (connectedWatchdog) {
    clearInterval(connectedWatchdog);
    connectedWatchdog = null;
  }
  imuWindowBuffer.reset();
  ecgSession.reset();
  useDeviceStore.getState().setConnected(false);
  initialized = false;
}

function handleRawPacket(json: string, receivedAtMs: number): void {
  let packet: WearSensorPacket;
  try {
    packet = JSON.parse(json) as WearSensorPacket;
  } catch (err) {
    console.warn('[wear] dropped malformed packet:', err);
    return;
  }

  // Wrap the dispatch in try/catch so a malformed sub-field can't
  // break the whole event loop (the listener fires once per second;
  // a crash here would orphan future packets too).
  try {
    lastPacketAtMs = receivedAtMs;

    // Low-rate scalars → vitals store. Steps come as a cumulative count
    // from the watch's TYPE_STEP_COUNTER, which matches the existing
    // store semantics (current-day total). SpO2 lands once per session
    // (Spo2RecordingActivity → SPO2_ON_DEMAND) — only updated when a
    // fresh reading is present in the packet.
    const updates: {
      heartRate?: number | null;
      steps?: number;
      spo2?: number | null;
      spo2At?: number | null;
    } = {};
    if (packet.heartRate != null && packet.heartRate > 0) {
      updates.heartRate = Math.round(packet.heartRate);
    }
    if (packet.stepCount != null && packet.stepCount >= 0) {
      updates.steps = Math.round(packet.stepCount);
    }
    if (packet.spo2 != null && packet.spo2.value != null && packet.spo2.status === 0) {
      updates.spo2 = Math.round(packet.spo2.value);
      updates.spo2At = packet.spo2.measuredAtEpochMs;
    }
    if (Object.keys(updates).length > 0) {
      useVitalsStore.getState().updateVitals(updates);
    }

    // Mirror the latest vitals snapshot to Supabase (throttled) so linked
    // caregivers can read live HR / activity — the local store above only
    // feeds the wearer's own screens.
    maybePersistWatchVitals(receivedAtMs);

    // ECG session: feeds cardiac inference while isRecording.
    if (packet.ecg) {
      const { profile } = useAuthStore.getState();
      ecgSession.setWearer(profile?.id ?? null, profile?.full_name ?? null);
      ecgSession.pushWindow(packet.ecg);
    }

    // High-rate IMU: feeds fall + HAR.
    if (packet.imuHighRate) {
      imuWindowBuffer.appendPacket(packet.imuHighRate);
    }
  } catch (err) {
    console.warn('[wear] handleRawPacket failed:', err);
  }
}

/**
 * Persist a vitals snapshot to Supabase for the logged-in WEARER so linked
 * caregivers see live HR / activity. The watch streams ~1/sec; we throttle
 * to one row per VITALS_PERSIST_INTERVAL_MS, which keeps the caregiver's
 * "online" window (<5 min on wearer-detail) and dashboard check-in (<60 s)
 * fresh without flooding the table. Skipped in demo mode, where the
 * mock-vitals writer owns the table; tagged `source:'watch'` so demo-mode
 * cleanup (which deletes `source:'demo'`) leaves real rows intact. Falls
 * back to the offline queue on a failed insert, like the demo writer.
 */
function maybePersistWatchVitals(nowMs: number): void {
  if (nowMs - lastVitalsPersistMs < VITALS_PERSIST_INTERVAL_MS) return;
  const { profile } = useAuthStore.getState();
  if (profile?.role !== 'wearer' || !profile?.id) return; // auth profile still hydrating
  if (useDeviceStore.getState().demoMode) return;
  const v = useVitalsStore.getState();
  if (v.heartRate == null) return; // wait for a real reading before writing
  lastVitalsPersistMs = nowMs;
  const row = {
    user_id: profile.id,
    heart_rate: v.heartRate,
    spo2: v.spo2,
    temperature: v.temperature,
    activity: v.currentActivity,
    recorded_at: new Date().toISOString(),
    metadata: { source: 'watch', steps: v.steps, ecgClass: v.ecgClass },
  };
  supabase.from('vitals').insert(row).then(({ error }) => {
    if (error) {
      // Silent before — a failed insert just queued, which made the
      // "caregiver sees offline" symptom hard to trace. DEV-log the cause.
      if (__DEV__) console.warn('[vitals] watch-persist insert failed (queued):', error.message);
      queueVitals(row);
    }
  });
}

/**
 * Debug helper exposed so a developer screen can show buffer health.
 * Not used by production UI.
 */
export async function getWearBridgeBufferSize(): Promise<number> {
  if (!nativeBridge) return 0;
  try {
    return await nativeBridge.getBufferSize();
  } catch {
    return 0;
  }
}
