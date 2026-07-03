export type DeviceStatus = 'online' | 'offline' | 'pairing';

export interface Device {
  id: string;
  user_id: string | null;
  hardware_id: string;
  name: string | null;
  firmware_version: string | null;
  battery_level: number | null;
  status: DeviceStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}
