import { supabase } from './supabase';
import { createAlert } from './alert.service';
import { notifyCaregivers } from './notification.service';

export interface Geofence {
  id: string;
  wearer_id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number; // meters
  is_active: boolean;
  created_by: string;
  created_at: string;
}

/**
 * Get all geofences for a wearer.
 */
export async function getGeofences(wearerId: string): Promise<Geofence[]> {
  const { data, error } = await supabase
    .from('geofences')
    .select('*')
    .eq('wearer_id', wearerId)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

/**
 * Create a new geofence (safe zone).
 */
export async function createGeofence(params: {
  wearerId: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
  createdBy: string;
}): Promise<Geofence> {
  const { data, error } = await supabase
    .from('geofences')
    .insert({
      wearer_id: params.wearerId,
      name: params.name,
      latitude: params.latitude,
      longitude: params.longitude,
      radius_meters: params.radius,
      is_active: true,
      created_by: params.createdBy,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Delete (deactivate) a geofence.
 */
export async function deleteGeofence(geofenceId: string): Promise<void> {
  const { error } = await supabase
    .from('geofences')
    .update({ is_active: false })
    .eq('id', geofenceId);

  if (error) throw error;
}

/**
 * Calculate distance between two coordinates (Haversine formula).
 * Returns distance in meters.
 */
export function getDistanceMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Check if a position is inside any active geofence.
 * Returns the breached geofences (those the wearer is OUTSIDE of).
 */
export function checkGeofenceBreach(
  latitude: number,
  longitude: number,
  geofences: Geofence[]
): Geofence[] {
  return geofences.filter((fence) => {
    const distance = getDistanceMeters(latitude, longitude, fence.latitude, fence.longitude);
    return distance > fence.radius_meters;
  });
}

/**
 * Handle a geofence breach — create alert and notify caregivers.
 */
export async function handleGeofenceBreach(
  wearerId: string,
  wearerName: string,
  breachedFence: Geofence,
  latitude: number,
  longitude: number
): Promise<void> {
  try {
    const alert = await createAlert({
      wearer_id: wearerId,
      type: 'geofence',
      severity: 'high',
      metadata: {
        geofence_id: breachedFence.id,
        geofence_name: breachedFence.name,
        latitude,
        longitude,
      },
    });

    await notifyCaregivers(wearerId, wearerName, 'geofence', alert.id);
  } catch (err) {
    // geofence breach handling failed
  }
}
