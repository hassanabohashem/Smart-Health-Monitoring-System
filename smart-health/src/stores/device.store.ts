import { create } from 'zustand';
import type { Device } from '@/types/device.types';

/** Three-step intensity used by demo-mode to pick which range the
 *  mock-vitals live tick centers each vital on. Picked from Settings
 *  → Demo controls; lets the wearer demo a calm baseline, a normal
 *  day, or an out-of-range scenario for the wellness banner. */
export type DemoLevel = 'low' | 'mid' | 'high';

/** ECG verdict for demo mode. Two states — Normal and Irregular —
 *  matching what the real cardiac pipeline actually produces (the
 *  model classifies every beat into AAMI N/S/V/F; we collapse
 *  S/V/F into Irregular). The tile's third state ("Unclear") is
 *  only the empty pre-reading state, not a model verdict, so it's
 *  not exposed as a demo option. */
export type DemoEcg = 'normal' | 'irregular';

/** Forced activity for demo mode. 'auto' keeps the random walk through
 *  Stationary / Walking / Jogging; the others pin `currentActivity` so you
 *  can drive the HAR display, wellness banner, activity-mix card, and the
 *  step rate on demand. */
export type DemoActivity = 'auto' | 'walking' | 'jogging' | 'stationary';

export interface DemoConfig {
  hr: DemoLevel;
  spo2: DemoLevel;
  temp: DemoLevel;
  ecg: DemoEcg;
  activity: DemoActivity;
}

export const DEFAULT_DEMO_CONFIG: DemoConfig = {
  hr: 'mid',
  spo2: 'mid',
  temp: 'mid',
  ecg: 'normal',
  activity: 'auto',
};

interface DeviceState {
  device: Device | null;
  isConnected: boolean;
  batteryLevel: number | null;
  /** Pretend a watch is paired and stream synthetic vitals. Toggled
   *  from Settings → Device & preferences; consumed by the Home tab
   *  to treat the UI as a live connection. */
  demoMode: boolean;
  /** Per-vital intensity knobs read by the mock-vitals live tick.
   *  Defaults to all-mid (normal day). In-memory only — flipping
   *  these resets to mid on app restart, which matches the demo
   *  mode being a session-local affordance. */
  demoConfig: DemoConfig;

  setDevice: (device: Device | null) => void;
  setConnected: (connected: boolean) => void;
  setBatteryLevel: (level: number | null) => void;
  setDemoMode: (enabled: boolean) => void;
  setDemoConfig: (patch: Partial<DemoConfig>) => void;
  reset: () => void;
}

export const useDeviceStore = create<DeviceState>((set) => ({
  device: null,
  isConnected: false,
  batteryLevel: null,
  demoMode: false,
  demoConfig: DEFAULT_DEMO_CONFIG,

  setDevice: (device) => set({ device }),
  setConnected: (isConnected) => set({ isConnected }),
  setBatteryLevel: (batteryLevel) => set({ batteryLevel }),
  setDemoMode: (demoMode) => set({ demoMode }),
  setDemoConfig: (patch) =>
    set((state) => ({ demoConfig: { ...state.demoConfig, ...patch } })),
  reset: () => set({
    device: null, isConnected: false, batteryLevel: null,
    demoMode: false, demoConfig: DEFAULT_DEMO_CONFIG,
  }),
}));
