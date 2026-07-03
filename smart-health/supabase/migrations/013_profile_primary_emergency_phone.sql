-- 013_profile_primary_emergency_phone.sql
-- Applied to the live DB (sxjajgvicsbfjpanijje) via MCP apply_migration (Jun 2026).
--
-- The wearer's chosen "main" emergency contact: the phone a confirmed fall
-- dials FIRST (see FallOverlayHost.placeEmergencyCall). It can be ANY manual
-- emergency_contacts[] entry OR ANY linked caregiver, so it's stored as a phone
-- string (matched against both lists at call time via samePhone) rather than a
-- flag or foreign key. NULL = use the default (first linked caregiver).
--
-- Lives on the profile so the choice SYNCS across the wearer's reinstalls and
-- devices (it replaced an earlier device-local AsyncStorage pointer). Only the
-- wearer reads/writes it (their own row), so the existing profiles self-update
-- RLS policy already covers it — no new policy needed.
--
-- IF NOT EXISTS so re-running against the live DB is a no-op.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS primary_emergency_phone text;
