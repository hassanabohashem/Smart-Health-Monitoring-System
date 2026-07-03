import { supabase } from './supabase';
import type { Alert, AlertType, AlertSeverity } from '@/types/alert.types';

export interface CreateAlertParams {
  wearer_id: string;
  device_id?: string;
  type: AlertType;
  severity?: AlertSeverity;
  confidence?: number;
  latitude?: number;
  longitude?: number;
  metadata?: Record<string, unknown>;
}

export async function createAlert(params: CreateAlertParams): Promise<Alert> {
  const { data, error } = await supabase
    .from('alerts')
    .insert({
      wearer_id: params.wearer_id,
      device_id: params.device_id || null,
      type: params.type,
      severity: params.severity || 'high',
      confidence: params.confidence || null,
      latitude: params.latitude || null,
      longitude: params.longitude || null,
      metadata: params.metadata || {},
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getAlerts(wearerId: string, limit = 50): Promise<Alert[]> {
  const { data, error } = await supabase
    .from('alerts')
    .select('*')
    .eq('wearer_id', wearerId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function getAlertsForCaregiver(caregiverId: string, limit = 50): Promise<Alert[]> {
  // Get all wearer IDs linked to this caregiver
  const { data: links, error: linkError } = await supabase
    .from('caregiver_links')
    .select('wearer_id')
    .eq('caregiver_id', caregiverId)
    .eq('status', 'active');

  if (linkError) throw linkError;
  if (!links || links.length === 0) return [];

  const wearerIds = links.map((l) => l.wearer_id);

  const { data, error } = await supabase
    .from('alerts')
    .select('*, wearer:profiles!wearer_id(full_name, avatar_url)')
    .in('wearer_id', wearerIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function resolveAlert(alertId: string, resolvedBy: string): Promise<Alert> {
  const { data, error } = await supabase
    .from('alerts')
    .update({
      status: 'resolved',
      resolved_by: resolvedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq('id', alertId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function cancelAlert(alertId: string): Promise<Alert> {
  const { data, error } = await supabase
    .from('alerts')
    .update({ status: 'cancelled' })
    .eq('id', alertId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/** Mark an alert as acknowledged by a caregiver. Stored in the
 *  `metadata` JSONB instead of a new column so we don't need a schema
 *  migration. The list UI derives the "Ack" pill from
 *  `metadata.acknowledged_at` being present. Status stays 'active'
 *  until somebody explicitly Resolves the alert. */
export async function acknowledgeAlert(alertId: string, caregiverId: string): Promise<Alert> {
  // Fetch existing metadata first so we can merge non-destructively —
  // other fields (place, value, confidence overrides) need to survive.
  const { data: existing, error: fetchErr } = await supabase
    .from('alerts')
    .select('metadata')
    .eq('id', alertId)
    .single();
  if (fetchErr) throw fetchErr;
  const merged = {
    ...(existing?.metadata as Record<string, unknown> ?? {}),
    acknowledged_at: new Date().toISOString(),
    acknowledged_by: caregiverId,
  };
  const { data, error } = await supabase
    .from('alerts')
    .update({ metadata: merged })
    .eq('id', alertId)
    .select()
    .single();
  if (error) throw error;
  return data;
}
