# Supabase Schema — ERD Reference

This file is the canonical schema description for drawing the
Entity-Relationship Diagram in §3.12 of the thesis. Generated from the
live Supabase project `sxjajgvicsbfjpanijje` on 2026-05-08, after all
seven numbered migrations were applied and the schema-drift fix
(`003_profile_notifications_enabled.sql`) was captured.

The schema is **frozen** — no further migrations are planned before
the thesis defense unless a real bug surfaces.

---

## 9 entities, 11 foreign-key relationships

### `profiles` — extends `auth.users`

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | FK → `auth.users.id` ON DELETE CASCADE |
| `full_name` | text NOT NULL | |
| `phone` | text | nullable |
| `role` | text NOT NULL | CHECK ∈ {wearer, caregiver, admin} |
| `avatar_url` | text | nullable, points at `avatars/` storage bucket |
| `emergency_contacts` | jsonb | array of {name, phone, relation}, default [] |
| `fcm_token` | text | nullable; FCM push-notification target |
| `notifications_enabled` | bool NOT NULL DEFAULT TRUE | per-user push toggle |
| `age` | smallint | nullable; 0–129; for assistant context |
| `sex` | char(1) | nullable; ∈ {M, F}; for assistant context |
| `conditions` | text[] | chronic conditions, default `{}` |
| `medications` | text[] | current meds, default `{}` |
| `created_at`, `updated_at` | timestamptz | default `now()` |

### `devices` — smartwatch units (scaffold for sensor wiring)

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `user_id` | uuid | nullable; FK → `profiles.id` ON DELETE SET NULL |
| `hardware_id` | text NOT NULL UNIQUE | physical device identifier |
| `name` | text | nullable; user-given device label |
| `firmware_version` | text | nullable |
| `battery_level` | int | nullable |
| `status` | text | CHECK ∈ {online, offline, pairing}, default 'offline' |
| `last_seen_at` | timestamptz | nullable |
| `created_at`, `updated_at` | timestamptz | default `now()` |

### `caregiver_links` — wearer ↔ caregiver association

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `caregiver_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `wearer_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `invite_code` | text UNIQUE | nullable |
| `status` | text | CHECK ∈ {pending, active, revoked}, default 'active' |
| `created_at` | timestamptz | default `now()` |
| | | UNIQUE(caregiver_id, wearer_id) |

### `alerts` — safety/health events

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `wearer_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `device_id` | uuid | nullable; FK → `devices.id` |
| `type` | text NOT NULL | CHECK ∈ {fall, sos, geofence, low_battery, cardiac, inactivity} |
| `severity` | text | CHECK ∈ {low, medium, high, critical}, default 'high' |
| `confidence` | real | nullable; AI-model confidence 0..1 |
| `latitude`, `longitude` | float8 | nullable; location at alert time |
| `metadata` | jsonb | default `{}` |
| `status` | text | CHECK ∈ {active, cancelled, resolved}, default 'active' |
| `resolved_by` | uuid | nullable; FK → `profiles.id` |
| `resolved_at` | timestamptz | nullable |
| `created_at` | timestamptz | default `now()` |
| | | INDEX (wearer_id, created_at DESC); partial INDEX on status='active' |

### `vitals` — time-series biometric readings

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `user_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `device_id` | uuid | nullable; FK → `devices.id` |
| `heart_rate` | real | bpm |
| `spo2` | real | % oxygen saturation |
| `temperature` | real | celsius |
| `activity` | text | classified activity label |
| `metadata` | jsonb | default `{}` |
| `recorded_at` | timestamptz NOT NULL | sensor timestamp |
| `created_at` | timestamptz | default `now()` |
| | | INDEX (user_id, recorded_at DESC) |

### `locations` — GPS history

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `user_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `latitude`, `longitude` | float8 NOT NULL | |
| `accuracy` | real | nullable; metres |
| `recorded_at` | timestamptz NOT NULL | |
| `created_at` | timestamptz | default `now()` |
| | | INDEX (user_id, recorded_at DESC) |

### `geofences` — safe zones

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `wearer_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `created_by` | uuid NOT NULL | FK → `profiles.id` (the caregiver who created it) |
| `name` | text | default 'Safe Zone' |
| `latitude`, `longitude` | float8 NOT NULL | centre |
| `radius_meters` | real NOT NULL DEFAULT 500 | |
| `is_active` | bool DEFAULT TRUE | |
| `created_at` | timestamptz | default `now()` |

### `achievements` — gamification unlocks

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `user_id` | uuid NOT NULL | FK → `profiles.id` ON DELETE CASCADE |
| `type` | text NOT NULL | achievement identifier |
| `points` | int | default 0 |
| `unlocked_at` | timestamptz | default `now()` |

### `assistant_feedback` — / on LLM responses

| Column | Type | Notes |
|---|---|---|
| `id` (PK) | uuid | default `gen_random_uuid()` |
| `user_id` | uuid | nullable; FK → `auth.users.id` ON DELETE SET NULL |
| `rating` | smallint NOT NULL | CHECK ∈ {-1, 1} (thumbs-down / thumbs-up) |
| `question` | text NOT NULL | |
| `answer` | text NOT NULL | |
| `comment` | text | nullable; user-provided free text |
| `model` | text | which LLM produced the answer |
| `severity` | text | rules-engine severity classification |
| `emergency` | bool | default FALSE |
| `emergency_reason` | text | nullable |
| `red_flag_categories` | text[] | default `{}` |
| `latency_ms` | int | nullable; round-trip latency |
| `from_cache` | bool | default FALSE |
| `sources` | text[] | RAG corpus filenames cited; default `{}` |
| `created_at` | timestamptz NOT NULL | default `now()` |
| | | INDEX (user_id, created_at DESC); INDEX (rating, created_at DESC) |

---

## Foreign-key map (for ERD arrows)

```
auth.users ──────┬──→ profiles.id (1:1, ON DELETE CASCADE)
                 └──→ assistant_feedback.user_id (1:N, SET NULL)

profiles ────────┬──→ devices.user_id           (1:N, SET NULL)
                 ├──→ caregiver_links.caregiver_id (1:N, CASCADE)
                 ├──→ caregiver_links.wearer_id    (1:N, CASCADE)
                 ├──→ alerts.wearer_id              (1:N, CASCADE)
                 ├──→ alerts.resolved_by            (1:N, no action)
                 ├──→ vitals.user_id                (1:N, CASCADE)
                 ├──→ locations.user_id             (1:N, CASCADE)
                 ├──→ geofences.wearer_id           (1:N, CASCADE)
                 ├──→ geofences.created_by          (1:N, no action)
                 └──→ achievements.user_id          (1:N, CASCADE)

devices ─────────┬──→ alerts.device_id              (1:N, no action)
                 └──→ vitals.device_id              (1:N, no action)
```

`caregiver_links` is the bridge entity: each row associates one
caregiver `profiles` row with one wearer `profiles` row (M:N self-
relationship on `profiles` resolved through this link table).

---

## Cardinality summary (helpful for ERD)

| Relationship | Cardinality |
|---|---|
| `auth.users` ↔ `profiles` | 1:1 (profiles extends users) |
| `profiles` (caregiver) ↔ `profiles` (wearer) via `caregiver_links` | M:N |
| `profiles` (wearer) ↔ `devices` | 1:N (a wearer can have multiple devices over time) |
| `profiles` (wearer) ↔ `alerts` | 1:N |
| `profiles` (wearer) ↔ `vitals` | 1:N |
| `profiles` (wearer) ↔ `locations` | 1:N |
| `profiles` (wearer) ↔ `geofences` | 1:N (geofences linked to a wearer) |
| `profiles` (caregiver) ↔ `geofences` (created_by) | 1:N |
| `profiles` (any) ↔ `achievements` | 1:N |
| `profiles` (any) ↔ `assistant_feedback` | 1:N |
| `devices` ↔ `alerts` (device_id, optional) | 1:N |
| `devices` ↔ `vitals` (device_id, optional) | 1:N |

---

## Cross-cutting

- **RLS** enabled on every table; per-table policies enforce
  self-access plus linked-caregiver access patterns.
- **Realtime publication** `supabase_realtime` includes `alerts`,
  `locations`, `vitals`. App subscribes to alerts (caregiver
  dashboard) and locations (caregiver map). Vitals subscription not
  yet wired — see CLAUDE.md "Database known state".
- **Storage bucket** `avatars` (public read, owner-only write).
- **RPC function** `get_user_id_by_email(email_input TEXT) → UUID`
  — used by caregiver linking to look up a wearer by email.

---

## For the thesis ERD (§3.12)

The ERD should show all 9 entities with their primary keys and the
11 foreign-key arrows above. The relational schema in §3.13 can
either embed the table-by-table block above or reproduce it as a
formatted SQL listing.

If the diagram tool you use supports it, mark `caregiver_links` as a
bridge entity (M:N resolution) for clarity. The medical fields on
`profiles` (age, sex, conditions, medications) and the assistant
metadata on `assistant_feedback` (model, severity, latency_ms,
from_cache, etc.) are worth showing — they're features the assistant
component depends on, not just bookkeeping.
