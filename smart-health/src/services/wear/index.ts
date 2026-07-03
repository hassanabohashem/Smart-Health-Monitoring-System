/**
 * Public surface of the wear-os integration.
 *
 * Call `initWearListener()` once at app boot (after auth state is
 * available is fine but not required — the listener accepts packets
 * before login and dispatches to vitals/HAR; only fall alerts need a
 * wearerId). Call `disposeWearListener()` on app teardown.
 *
 * See `services/wear/sensor-listener.ts` for the full pipeline.
 */

export {
  initWearListener,
  disposeWearListener,
  getWearBridgeBufferSize,
} from './sensor-listener';

export { imuWindowBuffer } from './imu-window-buffer';
export { ecgSession } from './ecg-session';
export { getConnectedNodes } from './pair';
export type { WearNode } from './pair';

export type {
  WearSensorPacket,
  WearSensorEvent,
  EcgWindow,
  ImuHighRateWindow,
  Vector3,
} from './types';
