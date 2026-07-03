// Supabase configuration
// Replace these with your actual Supabase project credentials
export const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL || 'https://your-project.supabase.co';
export const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || 'your-anon-key';

// Smart Health AI assistant backend
// Set EXPO_PUBLIC_ASSISTANT_URL + EXPO_PUBLIC_ASSISTANT_API_KEY in .env.
// The assistant feature is disabled if URL is missing.
export const ASSISTANT_URL = process.env.EXPO_PUBLIC_ASSISTANT_URL || '';
export const ASSISTANT_API_KEY = process.env.EXPO_PUBLIC_ASSISTANT_API_KEY || '';
export const ASSISTANT_ENABLED = Boolean(ASSISTANT_URL);

// Fall detection
export const FALL_DETECTION_THRESHOLDS = {
  waist: 0.56,
  wrist: 0.28,
  neck: 0.33,
} as const;

export const FALL_ALERT_COUNTDOWN_SECONDS = 30;

// BLE
export const SMARTWATCH_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
export const IMU_CHARACTERISTIC_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

// Location
export const LOCATION_UPDATE_INTERVAL_MS = 10_000; // 10 seconds
export const DEFAULT_GEOFENCE_RADIUS_METERS = 500;

// Vitals logging
export const VITALS_LOG_INTERVAL_MS = 30_000; // 30 seconds

// App
export const APP_NAME = 'Smart Health';
export const INVITE_CODE_LENGTH = 6;
