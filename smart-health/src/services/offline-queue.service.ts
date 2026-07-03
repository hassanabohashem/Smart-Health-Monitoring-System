/**
 * Offline Queue Service
 *
 * Queues alerts when offline, syncs when back online.
 * Uses simple fetch ping for connectivity detection.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAlert, type CreateAlertParams } from './alert.service';
import { notifyCaregivers } from './notification.service';
import { supabase } from './supabase';

const QUEUE_KEY = '@offline_queue';

interface QueuedItem {
  id: string;
  type: 'alert' | 'vitals' | 'location';
  payload: any;
  createdAt: string;
  retries: number;
}

let syncInterval: ReturnType<typeof setInterval> | null = null;
let isSyncing = false;

async function isOnline(): Promise<boolean> {
  try {
    await fetch('https://www.google.com', { method: 'HEAD', mode: 'no-cors' });
    return true;
  } catch {
    return false;
  }
}

export function initOfflineQueue(): void {
  syncQueue();
  syncInterval = setInterval(syncQueue, 30000);
}

export function disposeOfflineQueue(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export async function queueAlert(params: CreateAlertParams, wearerName?: string): Promise<void> {
  const item: QueuedItem = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'alert',
    payload: { ...params, wearerName },
    createdAt: new Date().toISOString(),
    retries: 0,
  };

  const queue = await getQueue();
  queue.push(item);
  await saveQueue(queue);
}

export async function queueVitals(payload: {
  user_id: string;
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  activity: string | null;
  recorded_at: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const queue = await getQueue();
  queue.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    type: 'vitals',
    payload,
    createdAt: new Date().toISOString(),
    retries: 0,
  });
  await saveQueue(queue);
}

export async function queueLocation(payload: {
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recorded_at: string;
}): Promise<void> {
  const queue = await getQueue();
  queue.push({
    id: Date.now().toString() + Math.random().toString(36).slice(2),
    type: 'location',
    payload,
    createdAt: new Date().toISOString(),
    retries: 0,
  });
  await saveQueue(queue);
}

export async function createAlertWithOfflineSupport(
  params: CreateAlertParams,
  wearerName?: string
): Promise<{ queued: boolean; alert?: any }> {
  const online = await isOnline();

  if (online) {
    try {
      const alert = await createAlert(params);
      if (wearerName) {
        notifyCaregivers(params.wearer_id, wearerName, params.type, alert.id);
      }
      return { queued: false, alert };
    } catch {
      await queueAlert(params, wearerName);
      return { queued: true };
    }
  } else {
    await queueAlert(params, wearerName);
    return { queued: true };
  }
}

async function syncQueue(): Promise<void> {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const queue = await getQueue();
    if (queue.length === 0) { isSyncing = false; return; }

    const online = await isOnline();
    if (!online) { isSyncing = false; return; }

    const remaining: QueuedItem[] = [];

    for (const item of queue) {
      try {
        if (item.type === 'alert') {
          const { wearerName, ...alertParams } = item.payload;
          const alert = await createAlert(alertParams);
          if (wearerName) {
            notifyCaregivers(alertParams.wearer_id, wearerName, alertParams.type, alert.id);
          }
        } else if (item.type === 'vitals') {
          const { error } = await supabase.from('vitals').insert(item.payload);
          if (error) throw error;
        } else if (item.type === 'location') {
          const { error } = await supabase.from('locations').insert(item.payload);
          if (error) throw error;
        }
      } catch {
        item.retries++;
        if (item.retries < 5) remaining.push(item);
      }
    }

    await saveQueue(remaining);
  } finally {
    isSyncing = false;
  }
}

export async function getQueueSize(): Promise<number> {
  return (await getQueue()).length;
}

async function getQueue(): Promise<QueuedItem[]> {
  try {
    const data = await AsyncStorage.getItem(QUEUE_KEY);
    return data ? JSON.parse(data) : [];
  } catch { return []; }
}

async function saveQueue(queue: QueuedItem[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
