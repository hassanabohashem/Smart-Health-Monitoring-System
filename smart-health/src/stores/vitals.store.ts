import { create } from 'zustand';

/** Coarse cardiac classification surfaced to the UI. Maps from the
 *  4-class model output (N / S / V / F) — a non-Normal label means the
 *  most recent beat was flagged as ectopic / fusion. */
export type EcgClass = 'normal' | 'irregular' | 'inconclusive';

interface VitalsState {
  heartRate: number | null;
  spo2: number | null;
  /** Watch wall-clock ms when SpO2 was measured; null if no reading yet. */
  spo2At: number | null;
  temperature: number | null;
  /** Latest cardiac model verdict. `null` = no reading yet. */
  ecgClass: EcgClass | null;
  /** Model confidence in [0, 1] for the latest beat. */
  ecgConfidence: number | null;
  /** Wall-clock ms when the latest beat was classified. */
  ecgAt: number | null;
  steps: number;
  currentActivity: string | null;
  lastUpdated: number | null;

  updateVitals: (vitals: {
    heartRate?: number | null;
    spo2?: number | null;
    spo2At?: number | null;
    temperature?: number | null;
    ecgClass?: EcgClass | null;
    ecgConfidence?: number | null;
    ecgAt?: number | null;
    steps?: number;
    currentActivity?: string | null;
  }) => void;
  reset: () => void;
}

export const useVitalsStore = create<VitalsState>((set) => ({
  heartRate: null,
  spo2: null,
  spo2At: null,
  temperature: null,
  ecgClass: null,
  ecgConfidence: null,
  ecgAt: null,
  steps: 0,
  currentActivity: null,
  lastUpdated: null,

  updateVitals: (vitals) =>
    set((state) => ({
      ...state,
      ...vitals,
      lastUpdated: Date.now(),
    })),

  reset: () =>
    set({
      heartRate: null,
      spo2: null,
      spo2At: null,
      temperature: null,
      ecgClass: null,
      ecgConfidence: null,
      ecgAt: null,
      steps: 0,
      currentActivity: null,
      lastUpdated: null,
    }),
}));
