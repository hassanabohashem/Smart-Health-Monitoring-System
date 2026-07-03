import * as Location from 'expo-location';
import { supabase } from './supabase';
import { queueLocation } from './offline-queue.service';
import { getGeofences, getDistanceMeters, checkGeofenceBreach, handleGeofenceBreach } from './geofence.service';
import { sendDataPushToUser } from './notification.service';

const BACKGROUND_LOCATION_TASK = 'background-location-task';
// Background notification task: a silent locate-request push wakes the
// wearer's app (even backgrounded/killed) so it can answer with a fix.
const LOCATE_NOTIFICATION_TASK = 'locate-notification-task';

/** The Expo/FCM data payload nests differently per platform/version — dig
 *  through the likely shapes (incl. a JSON-stringified `body`) for ours. */
function extractLocateWearerId(data: unknown): string | null {
  const candidates: unknown[] = [
    (data as any)?.notification?.request?.content?.data,
    (data as any)?.notification?.data,
    (data as any)?.data,
    data,
  ];
  for (let c of candidates) {
    if (typeof c === 'string') { try { c = JSON.parse(c); } catch { continue; } }
    const obj = c as any;
    if (obj && obj.type === 'locate_request' && obj.wearerId) return String(obj.wearerId);
    if (obj && typeof obj.body === 'string') {
      try {
        const b = JSON.parse(obj.body);
        if (b?.type === 'locate_request' && b.wearerId) return String(b.wearerId);
      } catch { /* not JSON */ }
    }
  }
  return null;
}

let locationSubscription: Location.LocationSubscription | null = null;
// A breach now means the wearer is outside ALL safe zones (inside none) — being
// outside some zones is normal with multiple zones. This tracks the outside-all
// state so we alert once on entry and reset when back inside any zone.
let outsideAllZones = false;

let _wearerId: string | null = null;
let _wearerName: string = 'Wearer';

/**
 * Evaluate the wearer's position against their active safe zones and fire a
 * single breach alert only when they've left ALL of them (inside none). Shared
 * by the foreground watcher and the background task. A wearer inside at least
 * one zone is safe, so being outside some zones never alerts.
 */
async function processGeofences(latitude: number, longitude: number): Promise<void> {
  if (!_wearerId) return;
  try {
    const geofences = await getGeofences(_wearerId);
    if (geofences.length === 0) {
      outsideAllZones = false;
      return;
    }
    const outside = checkGeofenceBreach(latitude, longitude, geofences);
    // Inside at least one zone → safe; clear any breach state.
    if (outside.length < geofences.length) {
      outsideAllZones = false;
      return;
    }
    // Outside every zone — fire one alert on the transition into this state,
    // tagged with the nearest zone for context.
    if (!outsideAllZones) {
      outsideAllZones = true;
      const nearest = outside.reduce((a, b) =>
        getDistanceMeters(latitude, longitude, a.latitude, a.longitude) <=
        getDistanceMeters(latitude, longitude, b.latitude, b.longitude) ? a : b
      );
      await handleGeofenceBreach(_wearerId, _wearerName, nearest, latitude, longitude);
    }
  } catch {
    // best-effort — a transient failure just skips this tick
  }
}

// Conditionally load TaskManager (only available in native builds, not Expo Go)
let TaskManager: any = null;
try {
  TaskManager = require('expo-task-manager');
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: any) => {
    if (error || !data || !_wearerId) return;

    const { locations } = data as { locations: Location.LocationObject[] };
    if (!locations || locations.length === 0) return;

    const location = locations[locations.length - 1];
    const { latitude, longitude } = location.coords;

    try {
      await supabase.from('locations').insert({
        user_id: _wearerId,
        recorded_at: new Date().toISOString(),
        latitude,
        longitude,
        accuracy: location.coords.accuracy,
      });
    } catch {
      queueLocation({
        user_id: _wearerId,
        latitude,
        longitude,
        accuracy: location.coords.accuracy,
        recorded_at: new Date().toISOString(),
      });
    }

    await processGeofences(latitude, longitude);
  });

  // Wake-on-push responder: a silent locate-request data message fires this
  // even when the wearer app is backgrounded/killed. We grab one fresh fix
  // and write it; the caregiver sees it on their `locations` subscription.
  TaskManager.defineTask(LOCATE_NOTIFICATION_TASK, async ({ data, error }: any) => {
    if (error) return;
    const wearerId = extractLocateWearerId(data);
    if (!wearerId) return;
    try {
      // Force the persisted auth session to load before the RLS-guarded
      // insert (cold-start headless task may not have restored it yet).
      await supabase.auth.getSession();
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      await supabase.from('locations').insert({
        user_id: wearerId,
        recorded_at: new Date().toISOString(),
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
    } catch {
      // best-effort: missing permission / no GPS / not authed → no update
    }
  });
} catch {
  // expo-task-manager not available (Expo Go) — background tasks disabled
}

/**
 * Register the wake-on-push locate responder so a silent push can trigger a
 * background fix. Call once for a logged-in wearer. No-op in Expo Go / if
 * the native notification task API is unavailable.
 */
export async function registerLocateBackgroundTask(): Promise<void> {
  try {
    const Notifications = require('expo-notifications');
    await Notifications.registerTaskAsync(LOCATE_NOTIFICATION_TASK);
  } catch {
    // notifications / background task registration unavailable
  }
}

/**
 * Request location permissions and start tracking.
 * Uses foreground tracking when app is open, background tracking when minimized.
 */
export async function startLocationTracking(wearerId: string, wearerName?: string): Promise<boolean> {
  const { status: foreground } = await Location.requestForegroundPermissionsAsync();
  if (foreground !== 'granted') return false;

  _wearerId = wearerId;
  _wearerName = wearerName || 'Wearer';

  // Request background permission
  let hasBackground = false;
  try {
    const { status } = await Location.requestBackgroundPermissionsAsync();
    hasBackground = status === 'granted';
  } catch {}

  // Reset breach state on fresh start
  outsideAllZones = false;

  // Start foreground tracking
  locationSubscription = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.High,
      timeInterval: 10000,
      distanceInterval: 5,
    },
    async (location) => {
      const { latitude, longitude } = location.coords;

      try {
        await supabase.from('locations').insert({
          user_id: wearerId,
          recorded_at: new Date().toISOString(),
          latitude,
          longitude,
          accuracy: location.coords.accuracy,
        });
      } catch {
        queueLocation({
          user_id: wearerId,
          latitude,
          longitude,
          accuracy: location.coords.accuracy,
          recorded_at: new Date().toISOString(),
        });
      }

      // Check safe zones — a breach means outside ALL zones (see processGeofences).
      await processGeofences(latitude, longitude);
    }
  );

  // Start background tracking if permission granted and TaskManager available
  if (hasBackground && TaskManager) {
    try {
      const isStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
      if (!isStarted) {
        await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
          accuracy: Location.Accuracy.Balanced,
          timeInterval: 30000,
          distanceInterval: 20,
          deferredUpdatesInterval: 30000,
          showsBackgroundLocationIndicator: true,
          foregroundService: {
            notificationTitle: 'Smart Health',
            notificationBody: 'Tracking your location for safety',
            notificationColor: '#1A73E8',
          },
        });
      }
    } catch (err) {
      console.error('Failed to start background location:', err);
    }
  }

  return true;
}

/**
 * Stop location tracking (foreground and background).
 */
export async function stopLocationTracking() {
  if (locationSubscription) {
    locationSubscription.remove();
    locationSubscription = null;
  }

  try {
    const isStarted = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    if (isStarted) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {}

  _wearerId = null;
}

/**
 * Get the wearer's latest location from Supabase.
 */
export async function getLatestLocation(wearerId: string) {
  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('user_id', wearerId)
    .order('recorded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data;
}

/**
 * Get location history for a wearer (last N hours).
 */
export async function getLocationHistory(wearerId: string, hours: number = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('locations')
    .select('*')
    .eq('user_id', wearerId)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

// ── On-demand "Locate now" ──────────────────────────────────────────────
// A stationary wearer never trips watchPositionAsync's distance filter, so
// the caregiver's map can only show the last reported fix. These two halves
// let a caregiver pull a FRESH fix on demand: the caregiver INSERTs a row
// into `location_requests`, the wearer's running app — subscribed to those
// INSERTs over postgres_changes — answers with a one-shot fix written to
// `locations`, and the caregiver sees it via the existing `locations`
// realtime subscription. postgres_changes is the realtime mechanism proven
// to work on this project (an earlier broadcast-based version never
// delivered); the push is a best-effort transparency notice + background
// nudge for a backgrounded/killed wearer app.
// Requires migration 011_location_requests.sql to be applied; until then the
// INSERT no-ops and the fix still arrives on the ~30 s background cadence.

/**
 * Caregiver-side: ask a wearer's device to report its location right now.
 * Resolves once the request row is written (does NOT wait for the fix — the
 * fresh location arrives asynchronously on the `locations` subscription).
 */
export async function requestLocationNow(wearerId: string): Promise<void> {
  // The INSERT rides the postgres_changes channel the wearer listens on.
  // `requested_by` defaults to auth.uid() in the DB, so { wearer_id } is enough.
  try {
    await supabase.from('location_requests').insert({ wearer_id: wearerId });
  } catch {
    // best-effort — the silent wake below still nudges the device
  }
  // Silent high-priority push wakes a backgrounded/killed app to answer
  // (handled by the LOCATE_NOTIFICATION_TASK background task). Location checks
  // are silent — no visible notice to the wearer (product choice).
  void sendDataPushToUser(wearerId, { type: 'locate_request', wearerId });
}

/**
 * Wearer-side: answer locate requests with a fresh fix. Subscribes to INSERTs
 * on `location_requests` for this wearer over postgres_changes and writes a
 * one-shot fix to `locations`. Returns an unsubscribe fn; active only while
 * the app is running (LOCATE_NOTIFICATION_TASK covers the backgrounded/killed
 * case via the silent push).
 */
export function respondToLocationRequests(wearerId: string): () => void {
  const channel = supabase
    .channel(`locate-req:${wearerId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'location_requests', filter: `wearer_id=eq.${wearerId}` },
      async () => {
        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          if (status !== 'granted') return;
          // Balanced is faster + emulator-friendly than High; fall back to the
          // last known fix if the one-shot fails or hangs.
          let pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
          if (!pos) pos = await Location.getLastKnownPositionAsync();
          if (!pos) return;
          await supabase.from('locations').insert({
            user_id: wearerId,
            recorded_at: new Date().toISOString(),
            latitude: pos.coords.latitude,
            longitude: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
          });
        } catch {
          // best-effort; a missing permission / GPS error just yields no update
        }
      },
    )
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

/**
 * Get current position once (for SOS alerts, etc.).
 */
export async function getCurrentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;

    const lastKnown = await Location.getLastKnownPositionAsync();
    if (lastKnown) {
      return {
        latitude: lastKnown.coords.latitude,
        longitude: lastKnown.coords.longitude,
      };
    }

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Lowest,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
  } catch {
    return null;
  }
}
