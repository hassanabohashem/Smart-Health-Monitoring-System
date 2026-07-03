-- ============================================================
-- 010 · Add date_of_birth to profiles
-- ============================================================
-- Background:
-- Registration now asks for the wearer's date of birth and biological
-- sex. Sex maps to the existing `sex` column (single-character M/F).
-- DOB is added here as a new optional column.
--
-- `age` (smallint) is kept alongside as a denormalised field that the
-- client populates at signup from DOB. Two reasons:
--   1. The clinical-assistant API (Assistant/) reads patient.age,
--      not patient.date_of_birth — switching the contract would
--      require a coordinated backend change.
--   2. Querying "age" at read time without DOB-derived calculation
--      keeps existing RLS / reports simpler.
-- The two can drift if someone updates DOB directly via SQL without
-- recomputing age; the client never does this. Edit Profile and
-- signUp both write both fields together.

ALTER TABLE profiles
    ADD COLUMN IF NOT EXISTS date_of_birth date;

-- Sanity check at write time — DOB can't be in the future, and a
-- pre-1900 DOB is almost certainly a typo. Keeps junk data out
-- without being overly restrictive.
ALTER TABLE profiles
    ADD CONSTRAINT profiles_dob_reasonable
    CHECK (date_of_birth IS NULL OR (date_of_birth >= '1900-01-01' AND date_of_birth <= CURRENT_DATE));
