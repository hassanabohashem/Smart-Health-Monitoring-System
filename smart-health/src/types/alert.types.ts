export type AlertType = 'fall' | 'sos' | 'geofence' | 'low_battery' | 'cardiac' | 'inactivity';
export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';
export type AlertStatus = 'active' | 'cancelled' | 'resolved';

export interface Alert {
  id: string;
  wearer_id: string;
  device_id: string | null;
  type: AlertType;
  severity: AlertSeverity;
  confidence: number | null;
  latitude: number | null;
  longitude: number | null;
  metadata: Record<string, unknown>;
  status: AlertStatus;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  // Joined fields
  wearer?: {
    full_name: string;
    avatar_url: string | null;
  };
}
