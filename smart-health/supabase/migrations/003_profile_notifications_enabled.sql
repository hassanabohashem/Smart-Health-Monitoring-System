-- 003_profile_notifications_enabled.sql
--
-- Adds the per-user notifications toggle to the profiles table.
-- The mobile app's Settings screens (both wearer and caregiver) read and
-- write this flag to enable/disable push notifications. Defaults to TRUE
-- so existing users keep the previous opt-out behaviour.
--
-- This column was originally added directly via the Supabase SQL Editor in
-- early development and was missing from the migration set, causing schema
-- drift between the live database and the repo. This migration captures it
-- so a fresh deployment from `supabase/migrations/` produces the same schema
-- as the live database.
--
-- App references:
--   src/types/user.types.ts:19      Profile.notifications_enabled
--   app/(wearer)/settings.tsx:22,35 read+write
--   app/(caregiver)/settings.tsx:21,28 read+write

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN profiles.notifications_enabled IS
    'Per-user push-notification toggle. UI in app/(*)/settings.tsx. Defaults to TRUE.';
