-- 006_profile_medical_fields.sql
--
-- Adds patient medical profile fields used by the Smart Health AI assistant.
-- These are optional — existing profiles continue to work with NULL values.
--
--   age          : patient age in years (NULL if unknown)
--   sex          : 'M' or 'F' (NULL if unknown)
--   conditions   : text array of chronic conditions, e.g. ['COPD', 'hypertension']
--   medications  : text array of current medications, e.g. ['lisinopril', 'albuterol']
--
-- The assistant passes these to the backend so the LLM can reason about the
-- patient (e.g. drug interactions, condition-specific advice).

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS age         SMALLINT CHECK (age >= 0 AND age < 130),
    ADD COLUMN IF NOT EXISTS sex         CHAR(1)  CHECK (sex IN ('M', 'F')),
    ADD COLUMN IF NOT EXISTS conditions  TEXT[] DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS medications TEXT[] DEFAULT '{}'::TEXT[];

COMMENT ON COLUMN profiles.age IS 'Patient age in years (0-129). Used by the assistant for age-adjusted clinical advice.';
COMMENT ON COLUMN profiles.sex IS 'Biological sex: M or F. Used by the assistant for condition-specific guidance.';
COMMENT ON COLUMN profiles.conditions IS 'Chronic conditions (e.g. COPD, hypertension). Free-text array; kept lowercase or title-case as the user enters them.';
COMMENT ON COLUMN profiles.medications IS 'Current medications (generic or brand names). The assistant normalizes brand -> generic server-side.';
