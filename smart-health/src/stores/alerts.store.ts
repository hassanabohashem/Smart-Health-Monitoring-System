import { create } from 'zustand';
import type { Alert } from '@/types/alert.types';

interface AlertsState {
  alerts: Alert[];
  activeAlertCount: number;
  isLoading: boolean;

  setAlerts: (alerts: Alert[]) => void;
  addAlert: (alert: Alert) => void;
  updateAlert: (alertId: string, updates: Partial<Alert>) => void;
  setLoading: (loading: boolean) => void;
  reset: () => void;
}

export const useAlertsStore = create<AlertsState>((set, get) => ({
  alerts: [],
  activeAlertCount: 0,
  isLoading: false,

  setAlerts: (alerts) =>
    set({
      alerts,
      activeAlertCount: alerts.filter((a) => a.status === 'active').length,
    }),

  addAlert: (alert) => {
    const current = get().alerts;
    const updated = [alert, ...current];
    set({
      alerts: updated,
      activeAlertCount: updated.filter((a) => a.status === 'active').length,
    });
  },

  updateAlert: (alertId, updates) => {
    const updated = get().alerts.map((a) =>
      a.id === alertId ? { ...a, ...updates } : a
    );
    set({
      alerts: updated,
      activeAlertCount: updated.filter((a) => a.status === 'active').length,
    });
  },

  setLoading: (isLoading) => set({ isLoading }),
  reset: () => set({ alerts: [], activeAlertCount: 0, isLoading: false }),
}));
