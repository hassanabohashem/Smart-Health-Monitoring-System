-- 008_profile_step_goal.sql
-- Adds a per-wearer daily step target. Shown on the Home Today tab
-- (Steps Today progress bar) and used by the Activity tab calculations.
-- Default 6,000 matches the "lightly active" baseline most fitness
-- platforms use, slightly below the 7,500 cardiovascular target.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS step_goal int NOT NULL DEFAULT 6000;

COMMENT ON COLUMN public.profiles.step_goal IS
  'Wearer''s daily step target. Used by the Home and Activity tabs.';
