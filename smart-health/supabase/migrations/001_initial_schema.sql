-- ============================================================
-- Smart Health Monitoring System - Database Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. PROFILES (extends Supabase auth.users)
CREATE TABLE profiles (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name       TEXT NOT NULL,
    phone           TEXT,
    role            TEXT NOT NULL CHECK (role IN ('wearer', 'caregiver', 'admin')),
    avatar_url      TEXT,
    emergency_contacts JSONB DEFAULT '[]',
    fcm_token       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 2. DEVICES (Smartwatches)
CREATE TABLE devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES profiles(id) ON DELETE SET NULL,
    hardware_id     TEXT NOT NULL UNIQUE,
    name            TEXT,
    firmware_version TEXT,
    battery_level   INTEGER,
    status          TEXT DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'pairing')),
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 3. CAREGIVER <-> WEARER LINKS
CREATE TABLE caregiver_links (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    caregiver_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    wearer_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    invite_code     TEXT UNIQUE,
    status          TEXT DEFAULT 'active' CHECK (status IN ('pending', 'active', 'revoked')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(caregiver_id, wearer_id)
);

-- 4. ALERTS
CREATE TABLE alerts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wearer_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    device_id       UUID REFERENCES devices(id),
    type            TEXT NOT NULL CHECK (type IN ('fall', 'sos', 'geofence', 'low_battery', 'cardiac', 'inactivity')),
    severity        TEXT DEFAULT 'high' CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    confidence      REAL,
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    metadata        JSONB DEFAULT '{}',
    status          TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'resolved')),
    resolved_by     UUID REFERENCES profiles(id),
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_wearer ON alerts(wearer_id, created_at DESC);
CREATE INDEX idx_alerts_status ON alerts(status) WHERE status = 'active';

-- 5. VITALS (time-series)
CREATE TABLE vitals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    device_id       UUID REFERENCES devices(id),
    heart_rate      REAL,
    spo2            REAL,
    temperature     REAL,
    activity        TEXT,
    metadata        JSONB DEFAULT '{}',
    recorded_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_vitals_user_time ON vitals(user_id, recorded_at DESC);

-- 6. LOCATIONS
CREATE TABLE locations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    accuracy        REAL,
    recorded_at     TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locations_user_time ON locations(user_id, recorded_at DESC);

-- 7. GEOFENCES (Safe Zones)
CREATE TABLE geofences (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wearer_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    created_by      UUID NOT NULL REFERENCES profiles(id),
    name            TEXT DEFAULT 'Safe Zone',
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    radius_meters   REAL NOT NULL DEFAULT 500,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 8. ACHIEVEMENTS (gamification, future)
CREATE TABLE achievements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,
    points          INTEGER DEFAULT 0,
    unlocked_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE caregiver_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE vitals ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE geofences ENABLE ROW LEVEL SECURITY;
ALTER TABLE achievements ENABLE ROW LEVEL SECURITY;

-- PROFILES: users see their own + caregivers see their linked wearers
CREATE POLICY "Users can view own profile"
    ON profiles FOR SELECT
    USING (auth.uid() = id);

CREATE POLICY "Caregivers can view linked wearer profiles"
    ON profiles FOR SELECT
    USING (
        id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Users can insert own profile"
    ON profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
    ON profiles FOR UPDATE
    USING (auth.uid() = id);

-- DEVICES: users see their own devices
CREATE POLICY "Users can view own devices"
    ON devices FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Users can insert own devices"
    ON devices FOR INSERT
    WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own devices"
    ON devices FOR UPDATE
    USING (user_id = auth.uid());

CREATE POLICY "Users can delete own devices"
    ON devices FOR DELETE
    USING (user_id = auth.uid());

-- CAREGIVER LINKS: both parties can see their links
CREATE POLICY "Users can view own links"
    ON caregiver_links FOR SELECT
    USING (caregiver_id = auth.uid() OR wearer_id = auth.uid());

CREATE POLICY "Users can insert links"
    ON caregiver_links FOR INSERT
    WITH CHECK (caregiver_id = auth.uid() OR wearer_id = auth.uid());

CREATE POLICY "Users can update own links"
    ON caregiver_links FOR UPDATE
    USING (caregiver_id = auth.uid() OR wearer_id = auth.uid());

-- ALERTS: wearer sees own, caregiver sees linked wearers'
CREATE POLICY "Wearers can view own alerts"
    ON alerts FOR SELECT
    USING (wearer_id = auth.uid());

CREATE POLICY "Caregivers can view linked wearer alerts"
    ON alerts FOR SELECT
    USING (
        wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Wearers can insert own alerts"
    ON alerts FOR INSERT
    WITH CHECK (wearer_id = auth.uid());

CREATE POLICY "Users can update alerts they can see"
    ON alerts FOR UPDATE
    USING (
        wearer_id = auth.uid()
        OR wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

-- VITALS: same pattern as alerts
CREATE POLICY "Users can view own vitals"
    ON vitals FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Caregivers can view linked wearer vitals"
    ON vitals FOR SELECT
    USING (
        user_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Users can insert own vitals"
    ON vitals FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- LOCATIONS: same pattern
CREATE POLICY "Users can view own locations"
    ON locations FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Caregivers can view linked wearer locations"
    ON locations FOR SELECT
    USING (
        user_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Users can insert own locations"
    ON locations FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- GEOFENCES: wearer + linked caregivers
CREATE POLICY "Wearers can view own geofences"
    ON geofences FOR SELECT
    USING (wearer_id = auth.uid());

CREATE POLICY "Caregivers can view linked wearer geofences"
    ON geofences FOR SELECT
    USING (
        wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Caregivers can create geofences for linked wearers"
    ON geofences FOR INSERT
    WITH CHECK (
        created_by = auth.uid()
        AND wearer_id IN (
            SELECT wearer_id FROM caregiver_links
            WHERE caregiver_id = auth.uid() AND status = 'active'
        )
    );

CREATE POLICY "Caregivers can update geofences they created"
    ON geofences FOR UPDATE
    USING (created_by = auth.uid());

CREATE POLICY "Caregivers can delete geofences they created"
    ON geofences FOR DELETE
    USING (created_by = auth.uid());

-- ACHIEVEMENTS: users see own
CREATE POLICY "Users can view own achievements"
    ON achievements FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "Users can insert own achievements"
    ON achievements FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- ============================================================
-- REALTIME: Enable for alerts table so caregivers get instant updates
-- ============================================================

ALTER PUBLICATION supabase_realtime ADD TABLE alerts;
ALTER PUBLICATION supabase_realtime ADD TABLE locations;
ALTER PUBLICATION supabase_realtime ADD TABLE vitals;
