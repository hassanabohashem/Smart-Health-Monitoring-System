export type UserRole = 'wearer' | 'caregiver' | 'admin';

export interface EmergencyContact {
  name: string;
  phone: string;
  relation: string;
}
// The "main" emergency contact (the number a fall calls first) can be ANY
// manual contact OR ANY linked caregiver, so it's tracked by phone via the
// profile's synced `primary_emergency_phone` column rather than a flag here.

export type BiologicalSex = 'M' | 'F';

export interface Profile {
  id: string;
  full_name: string;
  phone: string | null;
  role: UserRole;
  avatar_url: string | null;
  emergency_contacts: EmergencyContact[];
  /** Phone of the wearer's chosen "main" emergency contact — the number a
   *  confirmed fall dials first. May be any manual contact OR any linked
   *  caregiver (matched by phone), so it's a phone string, not a ref. NULL =
   *  use the default (first linked caregiver). Synced; see migration 013. */
  primary_emergency_phone: string | null;
  fcm_token: string | null;
  notifications_enabled: boolean;
  created_at: string;
  updated_at: string;

  // Medical profile — used by the Smart Health AI assistant. All optional.
  // See migration 006_profile_medical_fields.sql + 010_profile_date_of_birth.sql.
  age: number | null;            // Derived from date_of_birth at signup
  sex: BiologicalSex | null;
  /** YYYY-MM-DD; canonical age source. `age` above is the derived
   *  denormalisation kept for the existing assistant API. */
  date_of_birth: string | null;
  conditions: string[];   // e.g. ['COPD', 'hypertension']
  medications: string[];  // e.g. ['lisinopril', 'albuterol 90mcg']

  // Daily step target shown on the Today tab + Activity tab.
  // Default 6000 (industry "lightly active" baseline). See migration
  // 008_profile_step_goal.sql.
  step_goal: number;
}

export interface CaregiverLink {
  id: string;
  caregiver_id: string;
  wearer_id: string;
  invite_code: string | null;
  status: 'pending' | 'active' | 'revoked';
  created_at: string;
  // Joined fields (when fetching with profile data)
  wearer?: Profile;
  caregiver?: Profile;
}
