-- ============================================================
-- 011 · On-demand locate requests (instant "Locate now")
-- ============================================================
-- Background:
-- A stationary wearer never trips the background tracker's distance
-- filter, so when a caregiver taps "Locate now" the device must be
-- asked for a fresh fix. The first implementation used a Realtime
-- BROADCAST signal for that ask — but on this project only the
-- `postgres_changes` Realtime channel is reliably enabled (broadcast
-- never delivered in live testing), so the instant ping never fired
-- and the caregiver's spinner only cleared on the next ~30 s
-- background write.
--
-- This migration moves the ask onto the proven postgres_changes
-- channel via a tiny signalling table:
--   1. caregiver INSERTs one row (wearer_id = the wearer to locate),
--   2. the wearer's app — subscribed to INSERTs for its own
--      wearer_id — answers with a one-shot GPS fix written to
--      `locations`,
--   3. the caregiver sees that fix on the EXISTING `locations`
--      Realtime subscription (so no caregiver-side change is needed).
--
-- The rows are ephemeral signals (a few bytes each) and are never read
-- back by the app; they can be pruned on any schedule without changing
-- behaviour. The migration is additive and safe to re-run (guards on
-- IF NOT EXISTS / DROP POLICY IF EXISTS / publication membership).

-- ── Table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_requests (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wearer_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    -- Defaults to the caller so the client insert is just { wearer_id };
    -- the INSERT policy still pins it to auth.uid().
    requested_by    UUID NOT NULL DEFAULT auth.uid()
                        REFERENCES profiles(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_location_requests_wearer
    ON location_requests(wearer_id, created_at DESC);

-- ── Row Level Security ──────────────────────────────────────────────
ALTER TABLE location_requests ENABLE ROW LEVEL SECURITY;

-- A caregiver may file a locate request ONLY for a wearer they are
-- actively linked to, and the row is always stamped with their own id.
DROP POLICY IF EXISTS "Caregivers can request locates for linked wearers"
    ON location_requests;
CREATE POLICY "Caregivers can request locates for linked wearers"
    ON location_requests FOR INSERT
    WITH CHECK (
        requested_by = auth.uid()
        AND wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

-- The wearer must be able to SELECT requests aimed at them — this is
-- what lets the postgres_changes subscription deliver the INSERT to
-- their device (Realtime enforces RLS on the subscriber).
DROP POLICY IF EXISTS "Wearers can view locate requests for them"
    ON location_requests;
CREATE POLICY "Wearers can view locate requests for them"
    ON location_requests FOR SELECT
    USING (wearer_id = auth.uid());

-- The caregiver can read back the requests they themselves filed
-- (symmetry / debugging; not required by the runtime flow).
DROP POLICY IF EXISTS "Caregivers can view their own locate requests"
    ON location_requests;
CREATE POLICY "Caregivers can view their own locate requests"
    ON location_requests FOR SELECT
    USING (requested_by = auth.uid());

-- ── Realtime ────────────────────────────────────────────────────────
-- Ride the confirmed-working postgres_changes channel. Guarded so a
-- re-run against a live DB is a no-op rather than an error.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'location_requests'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE location_requests;
    END IF;
END $$;
