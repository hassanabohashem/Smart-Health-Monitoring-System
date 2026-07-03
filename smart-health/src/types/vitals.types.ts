export interface VitalsReading {
  id: string;
  user_id: string;
  device_id: string | null;
  heart_rate: number | null;
  spo2: number | null;
  temperature: number | null;
  activity: string | null;
  metadata: Record<string, unknown>;
  recorded_at: string;
  created_at: string;
}

export interface LocationUpdate {
  id: string;
  user_id: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recorded_at: string;
  created_at: string;
}

export interface Geofence {
  id: string;
  wearer_id: string;
  created_by: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  is_active: boolean;
  created_at: string;
}
