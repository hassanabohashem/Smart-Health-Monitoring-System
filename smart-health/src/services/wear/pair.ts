/**
 * Wear OS pairing helpers — thin wrapper around the native bridge's
 * NodeClient calls. Used by the Pair Watch dialog on the Home tab.
 *
 * "Pairing" at the OS level happens in Galaxy Wearable or the Wear OS
 * companion app — we can't trigger that ourselves. What we CAN do:
 *
 *   1. Ask Android which Wear OS nodes are currently reachable via the
 *      Data Layer (`getConnectedNodes` below). Anything returned is a
 *      watch that's already system-paired with the phone.
 *   2. Surface those as "Available devices" in the dialog.
 *   3. On user tap, save the chosen node to `useDeviceStore.device` so
 *      Settings + Home can name the paired watch ("Galaxy Watch 5").
 *
 * `isConnected` (the live-stream heartbeat) is owned by the sensor
 * listener — pairing alone doesn't flip it; the watch's wear app
 * needs to start emitting `/sensor_data` packets first.
 */

import { NativeModules } from 'react-native';

export interface WearNode {
  /** Node ID assigned by the Wear Data Layer; opaque, stable for the
   *  lifetime of the pairing. Suitable for the `hardware_id` column. */
  id: string;
  /** User-facing device name from the watch (e.g. "Galaxy Watch5"). */
  name: string;
  /** True if the node is directly reachable (vs cloud-relay only).
   *  For sensor streaming we need this to be true. */
  isNearby: boolean;
}

interface PairBridge {
  getConnectedNodes: () => Promise<WearNode[]>;
}

const bridge = NativeModules.WearSensorBridge as PairBridge | undefined;

/** Return every Wear OS node the phone is currently paired with and
 *  can reach via the Data Layer. Empty array if none. Throws if the
 *  native module isn't registered (will only happen if the user is
 *  running an old APK that pre-dates the WearSensorPackage wiring —
 *  see CLAUDE.md pitfall §10). */
export async function getConnectedNodes(): Promise<WearNode[]> {
  if (!bridge?.getConnectedNodes) {
    throw new Error('WearSensorBridge native module missing or stale');
  }
  return bridge.getConnectedNodes();
}
