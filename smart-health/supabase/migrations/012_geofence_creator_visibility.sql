-- ============================================================
-- 012 · Caregivers see only the safe zones THEY created
-- ============================================================
-- Bug: the caregiver SELECT policy showed ALL of a linked wearer's
-- geofences (created by any caregiver), but the UPDATE / DELETE policies
-- only allow the CREATOR (`created_by = auth.uid()`) to modify. So a
-- caregiver could SEE another caregiver's zone yet silently fail to
-- delete it: `deleteGeofence` does `update({is_active:false})`, RLS
-- filters that UPDATE to 0 rows, PostgREST returns no error, and the app
-- optimistically reports success — so the zone reappears on refresh
-- ("delete does nothing").
--
-- Intended behaviour: each caregiver manages only their OWN safe zones.
-- Fix by scoping the caregiver SELECT to `created_by = auth.uid()` (still
-- limited to actively-linked wearers). The wearer's own SELECT policy
-- ("Wearers can view own geofences") is left untouched, so the wearer's
-- device still evaluates EVERY active zone for breach detection. The
-- UPDATE / DELETE policies already match (`created_by = auth.uid()`), so
-- with visibility narrowed a caregiver only ever sees — and can delete —
-- their own zones. Additive + safe to re-run.

DROP POLICY IF EXISTS "Caregivers can view linked wearer geofences" ON geofences;
DROP POLICY IF EXISTS "Caregivers can view geofences they created" ON geofences;

CREATE POLICY "Caregivers can view geofences they created"
    ON geofences FOR SELECT
    USING (
        created_by = auth.uid()
        AND wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );
