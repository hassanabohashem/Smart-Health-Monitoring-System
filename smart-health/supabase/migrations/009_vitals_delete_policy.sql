-- ============================================================
-- 009 · Allow users to delete their own vitals rows
-- ============================================================
-- Background:
-- The vitals table was created with SELECT + INSERT policies but
-- no DELETE policy. The mock-vitals service (demo mode) needs to
-- delete its own backfill + live rows on demo-off so the trend
-- cards and tiles return to an empty state. Without this policy
-- the client-side DELETE silently affects 0 rows.
--
-- Scope: a user can only delete their own vitals (user_id =
-- auth.uid()). Caregivers cannot delete linked wearers' vitals.
-- Service-role keys (used by Edge Functions / admin tasks) bypass
-- RLS as usual.

CREATE POLICY "Users can delete own vitals"
    ON vitals FOR DELETE
    USING (user_id = auth.uid());
