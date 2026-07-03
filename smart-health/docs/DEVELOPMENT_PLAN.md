# Phase 3 — Full Development Plan
## Smart Health Monitoring System — Mobile App

> **Historical document.** This is the original Phase-3 planning spec
> from March 2026. The implementation diverged in two important ways:
>
> 1. **AI runs on-device, not via Edge Functions.** All three ML models
> (fall detection, HAR, cardiac) ship as bundled ONNX models and run
> locally through `onnxruntime-react-native`. The clinical assistant
> is a separate cloud HTTP service (Hugging Face Spaces), not a
> Supabase Edge Function. The `supabase.functions.invoke('ai-cardiac' / 'ai-har' / 'ai-assistant')`
> examples below were never built.
> 2. **The `type: 'on-device' | 'cloud'` adapter union has been
> narrowed** to just `'on-device'` after the cloud-fallback path
> was removed.
>
> For the live architecture, see `DOCUMENTATION.md` and the project's
> top-level `CLAUDE.md`.

---

## 3.1 — Architecture Design

### System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MOBILE APP (Expo)                        │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Wearer UI   │  │ Caregiver UI │  │   Shared Components   │ │
│  │  - Home      │  │ - Dashboard  │  │   - Auth screens      │ │
│  │  - Activity  │  │ - Map        │  │   - Link flow         │ │
│  │  - Assistant │  │ - Alerts     │  │   - Settings base     │ │
│  │  - Settings  │  │ - Settings   │  │   - Notification UI   │ │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬───────────┘ │
│         │                 │                       │             │
│  ┌──────┴─────────────────┴───────────────────────┴───────────┐ │
│  │                    Zustand Stores                           │ │
│  │  auth.store │ alerts.store │ device.store │ vitals.store    │ │
│  └──────────────────────┬─────────────────────────────────────┘ │
│                         │                                       │
│  ┌──────────────────────┴─────────────────────────────────────┐ │
│  │                   Service Layer                             │ │
│  │  auth.service │ alert.service │ link.service │ ai.service   │ │
│  └──────────┬────────────┬──────────────┬─────────────────────┘ │
│             │            │              │                       │
│  ┌──────────┴──┐  ┌──────┴───────┐  ┌──┴──────────────────┐   │
│  │ Supabase SDK│  │  BLE Module  │  │ ONNX Runtime Mobile │   │
│  └──────┬──────┘  └──────┬───────┘  │  (Fall Detection)   │   │
│         │                │          └─────────────────────┘   │
└─────────┼────────────────┼────────────────────────────────────┘
          │                │
          ▼                ▼
┌──────────────────┐  ┌──────────────┐
│    SUPABASE      │  │  SMARTWATCH  │
│                  │  │  (Wearable)  │
│  ┌────────────┐  │  │              │
│  │  Auth      │  │  │  IMU + Baro  │
│  │  (JWT)     │  │  │  Heart Rate  │
│  ├────────────┤  │  │  SpO2        │
│  │ PostgreSQL │  │  │  GPS         │
│  │  - profiles│  │  │  BLE Radio   │
│  │  - alerts  │  │  └──────────────┘
│  │  - vitals  │  │
│  │  - devices │  │
│  │  - links   │  │
│  │  - etc.    │  │
│  ├────────────┤  │
│  │ Realtime   │  │
│  │ (WebSocket)│  │
│  ├────────────┤  │
│  │  Storage   │  │
│  │ (avatars)  │  │
│  ├────────────┤  │
│  │   Edge     │  │
│  │ Functions  │  │
│  │ (future AI)│  │
│  └────────────┘  │
│                  │
│  ┌────────────┐  │
│  │    FCM     │  │
│  │   (Push)   │  │
│  └────────────┘  │
└──────────────────┘
```

### Data Flow: Fall Detection

```
Smartwatch ──BLE──▶ Phone App ──▶ ONNX Runtime ──▶ Fall Detected?
                                                        │
                                    ┌───────────────────┤
                                    ▼                   ▼
                              YES: Create          NO: Log &
                              alert in Supabase    continue
                                    │
                         ┌──────────┴──────────┐
                         ▼                     ▼
                   Supabase Realtime      FCM Push
                   (app open)             (app closed)
                         │                     │
                         ▼                     ▼
                   Caregiver sees         Caregiver gets
                   alert instantly        notification
```

### Project Folder Structure (current)

```
smart-health-54/
├── app/                    # Expo Router screens
│   ├── _layout.tsx         # Root layout + AuthGate
│   ├── index.tsx           # Entry redirect
│   ├── (auth)/             # Login, Register
│   ├── (wearer)/           # Wearer tab screens
│   ├── (caregiver)/        # Caregiver tab screens
│   └── (shared)/           # Shared screens (link flow)
├── src/
│   ├── services/           # Supabase API calls
│   ├── stores/             # Zustand state stores
│   ├── types/              # TypeScript interfaces
│   ├── utils/              # Constants, theme
│   ├── components/         # Reusable UI components
│   │   ├── alerts/         # Alert-related components
│   │   ├── map/            # Map components
│   │   ├── ui/             # Generic UI (buttons, cards)
│   │   └── vitals/         # Vitals display components
│   ├── hooks/              # Custom React hooks
│   ├── i18n/               # Translations (en, ar)
│   └── assets/
│       ├── images/         # App images
│       └── models/         # ONNX model files
├── supabase/
│   ├── migrations/         # SQL schema
│   └── functions/          # Edge Functions (future AI proxy)
├── .env                    # Supabase keys
├── app.json                # Expo config
└── package.json
```

---

## 3.2 — Feature Breakdown

### Auth & Onboarding

| # | Feature | Description | Priority | Dependencies | Effort | Status |
|---|---------|-------------|----------|-------------|--------|--------|
| 1 | Login | Email/password sign-in | P0 (MVP) | Supabase Auth | Small | Done |
| 2 | Register | Sign-up with role selection (wearer/caregiver) | P0 | Supabase Auth | Small | Done |
| 3 | Forgot Password | Password reset via email | P1 | Supabase Auth | Small | Done |
| 4 | Onboarding Walkthrough | First-launch tutorial explaining the app | P2 | None | Medium | Not started |
| 5 | Profile Editing | Edit name, phone, avatar, emergency contacts | P1 | Storage (avatar upload) | Medium | Done |

### Wearer Features

| # | Feature | Description | Priority | Dependencies | Effort | Status |
|---|---------|-------------|----------|-------------|--------|--------|
| 6 | Wearer Home Dashboard | Vitals cards (HR, SpO2, temp, steps), device status, activity banner, SOS button | P0 | Device store, vitals store | Medium | Done |
| 7 | SOS Button | Manual panic alert with countdown — creates alert, notifies caregiver | P0 | Alert service, FCM | Medium | Done |
| 8 | Device Pairing | Pair smartwatch via BLE, show connection status | P0 | BLE library (dev build) | Large | Blocked (needs dev build) |
| 9 | Live Vitals Display | Real-time heart rate, SpO2, temperature from watch | P0 | BLE, vitals store | Medium | Done (mock data, real BLE pending) |
| 10 | Activity Screen | Daily activity summary, step count, chart selector | P1 | Vitals data, chart library | Medium | Done (mock data) |
| 11 | Activity History Charts | HR/SpO2/Temp line charts + weekly steps bar chart | P1 | Chart library, vitals history | Medium | Done (mock data) |
| 12 | Fall Detection (on-device) | Run FusionNet ONNX on IMU data from watch, auto-alert | P0 | ONNX Runtime, BLE (dev build) | Large | Blocked (needs dev build) |
| 13 | Generate Invite Code | Create code for caregiver to link | P0 | Link service | Small | Done |
| 14 | View Linked Caregivers | See who is linked, option to unlink | P1 | Link service | Small | Done |
| 15 | AI Health Assistant | Chat interface for health questions (RAG-based) | P2 | Future AI model | Large | Not started |
| 16 | Geofence Setup | Wearer sets their own safe zones | P2 | Maps, geofence table | Medium | Not started |
| 17 | Achievements / Gamification | Points and badges for staying active | P2 | Achievements table | Medium | Not started |

### Caregiver Features

| # | Feature | Description | Priority | Dependencies | Effort | Status |
|---|---------|-------------|----------|-------------|--------|--------|
| 18 | Caregiver Dashboard | Overview of linked wearers, quick stats, active alerts, recent alerts | P0 | Link service, alert store | Medium | Done |
| 19 | Link Wearer (claim invite) | Enter invite code to connect with a wearer | P0 | Link service | Small | Done |
| 20 | Real-time Alert Feed | Live alerts from all linked wearers via Supabase Realtime | P0 | Supabase Realtime | Medium | Done |
| 21 | Alert Detail & Actions | View alert details, resolve, false alarm, call wearer | P0 | Alert service | Medium | Done |
| 22 | Map — Wearer Location | See wearer's current location + real-time updates | P1 | Location data, Supabase Realtime | Medium | Done (location cards + OpenStreetMap link) |
| 23 | Map — Geofence Visualization | See safe zones, breach detection, add/delete zones | P1 | Geofence service | Medium | Done (geofence status on cards, add/delete UI) |
| 24 | Wearer Vitals View | Tap a wearer card → see their vitals, charts, call/message | P1 | Vitals data via Realtime | Medium | Done (mock data) |
| 25 | Alert History | Past alerts with filters (by wearer, type, date) | P1 | Alert service | Medium | Partial (list done, filters not done) |
| 26 | Push Notifications | Receive push when app is closed (fall, SOS, geofence) | P0 | FCM, Expo Notifications | Medium | Done (FCM + Expo, dev build) |

### Shared / System Features

| # | Feature | Description | Priority | Dependencies | Effort | Status |
|---|---------|-------------|----------|-------------|--------|--------|
| 27 | Push Notification Setup | Register FCM token, handle notification tap → navigate | P0 | Expo Notifications, FCM | Medium | Done (token saved, deep-link on tap) |
| 28 | Dark Mode | Toggle light/dark theme, persisted to AsyncStorage | P1 | Theme store | Small | Done |
| 29 | Arabic Localization | Full Arabic translation + RTL support | P2 | i18next setup | Medium | Not started |
| 30 | Offline Support | Queue alerts/vitals locally when offline, sync when online | P1 | WatermelonDB or AsyncStorage | Large | Not started |
| 31 | Settings — Notification Prefs | Choose which alerts to receive, sound, vibration | P1 | Profile table | Small | Partial (toggle exists, not persisted to backend) |
| 32 | Settings — Sign Out | Log out and return to auth | P0 | Auth service | Small | Done |

---

## 3.3 — Sprint Plan (Week-by-Week)

> Assumes a small student team. Weeks marked depend on external deliverables.

### Week 1 — Foundation (COMPLETED)
- [x] Expo project setup with TypeScript (SDK 54)
- [x] Supabase project + database schema (8 tables with RLS)
- [x] Authentication (login, register, role selection)
- [x] Role-based navigation (wearer tabs, caregiver tabs)
- [x] Caregiver ↔ Wearer linking via invite codes
- [x] Real-time alert subscription on caregiver dashboard
- [x] Basic store architecture (auth, alerts, device, vitals)
- **Milestone:** Two users can register, link, and see each other

### Week 2 — SOS Alert Pipeline (COMPLETED)
- [x] SOS button triggers alert creation in Supabase
- [x] Alert confirmation dialog with 5-second countdown
- [x] Caregiver receives alert in real-time (Supabase Realtime)
- [x] Alert detail screen: view info, resolve, false alarm, call wearer
- [x] Caregiver alerts tab with badge count
- [ ] ~~Push notifications~~ → Deferred to dev build (Expo Go doesn't support push in SDK 53+)
- [ ] ~~Notification tap deep-links~~ → Deferred to dev build
- **Milestone:** SOS flow works end-to-end (press → alert → real-time → resolve)

### Week 3 — Profile & Settings (COMPLETED)
- [x] Profile editing screen (name, phone, avatar upload)
- [x] Avatar upload to Supabase Storage (bucket + RLS policies)
- [x] Emergency contacts management (add/edit/delete, max 5)
- [x] Notification preferences toggle (UI only, not persisted to backend yet)
- [x] Forgot password flow (Supabase email reset)
- [x] View/manage linked caregivers (wearer) + linked wearers (caregiver)
- [x] Unlink functionality with confirmation dialog
- [x] Dark mode toggle (persisted to AsyncStorage via theme store)
- **Milestone:** Complete user management, both roles fully functional

### Week 4 — Vitals Dashboard + Charts (COMPLETED — UI with mock data)
> Note: Original plan was BLE smartwatch. Deferred BLE to dev build phase. Built full UI with mock data simulator instead.
- [x] Mock vitals simulator (3-second refresh, realistic HR/SpO2/temp/steps/activity)
- [x] Demo Mode toggle on wearer home (simulates smartwatch connection)
- [x] Live vitals cards with status indicators (Normal/High/Low)
- [x] Steps card with progress bar toward daily goal
- [x] Current activity banner
- [x] Battery level display
- [x] Activity screen with segmented chart selector (HR/SpO2/Temp)
- [x] 24-hour line charts with avg/min/max stats
- [x] Weekly steps bar chart
- [x] Caregiver: tap wearer card → wearer detail screen (vitals, charts, call/message)
- [x] Caregiver map: location list view with mock GPS coordinates
- [ ] ~~BLE scanning and pairing~~ → Deferred to dev build
- [ ] ~~Real sensor data from watch~~ → Deferred to dev build
- **Milestone:** Full health dashboard UI working with demo data

### Week 5 — Dev Build + Push Notifications (COMPLETED)
> Switched from Expo Go to EAS Development Build (Android). Unlocked native modules.
- [x] Set up EAS Build (development profile for Android)
- [x] Firebase project created (FCM only — for push notification delivery)
- [x] Push notifications working (FCM + Expo Notifications)
- [x] FCM token registered in profiles table on login
- [x] Notification tap deep-links to alert detail screen
- [ ] ~~BLE smartwatch pairing~~ → Deferred (need specific smartwatch hardware)
- [ ] ~~ONNX Runtime Mobile + FusionNet~~ → Deferred to Week 7
- **Milestone:** Dev build running on Android emulator, push notifications working

### Week 6 — Location & Geofencing (COMPLETED)
- [x] Wearer: background location tracking service (expo-location)
- [x] Store location updates in Supabase locations table
- [x] Caregiver map: wearer location cards with coordinates + "View on Map" (opens OpenStreetMap)
- [x] Real-time location updates via Supabase Realtime subscription
- [x] Geofence creation (caregiver creates safe zone at wearer's current location)
- [x] Geofence breach detection (distance calculation, inside/outside status display)
- [x] Geofence management (add/delete safe zones)
- [x] SOS alerts now include GPS coordinates
- [ ] ~~Interactive native map~~ → Using OpenStreetMap external link (no Google Maps API key)
- [ ] ~~Location history trail on map~~ → Deferred (needs native map)
- **Milestone:** Caregiver can see wearer location + safe zone status, geofence breach detection works

### Week 7 — AI Model Integration (COMPLETED)
- [x] AI model registry + adapter pattern (ModelAdapter interface, ModelRegistry singleton)
- [x] FusionNet fall detection adapter (cloud simulator + on-device ready)
- [x] Fall detection pipeline: sensor → inference → 15s cancel countdown → auto-alert
- [x] Cloud model template for future models (cardiac, HAR)
- [x] AI model status display in wearer settings
- [x] FusionNet ONNX model file in app assets (ready for on-device when BLE connects)
- [ ] ~~Actual on-device ONNX inference~~ → Using simulator until real smartwatch sends data
- [ ] ~~Cardiac/HAR integration~~ → Waiting for model delivery
- **Milestone:** Modular AI system ready, fall detection pipeline complete

### Week 8 — Offline Support + Polish (COMPLETED)
- [x] Offline alert queue (AsyncStorage-based, auto-syncs when online)
- [x] Network state detection via fetch ping (no native module needed)
- [x] Offline banner ("You're offline") shown in app
- [x] Loading skeletons for caregiver dashboard + alerts
- [x] Error state component with retry button
- [x] Haptic feedback on SOS button press (expo-haptics)
- [x] Onboarding walkthrough (3 swipeable screens, shown on first launch)
- [x] Splash screen configured (#1A73E8 blue background)
- **Milestone:** App works reliably even with poor connectivity

### Week 9 — Arabic Localization + Accessibility (COMPLETED)
- [x] i18next setup with AsyncStorage-based language persistence
- [x] Full Arabic translations file (ar.ts) — all screen strings
- [x] Full English translations file (en.ts) — all screen strings centralized
- [x] Language switcher in both wearer and caregiver settings
- [x] RTL layout support (I18nManager.forceRTL on Arabic)
- [x] Wire t() calls into every screen — all screens now use t() for all user-facing strings
- [ ] ~~expo-localization for device language detection~~ → Needs rebuild, defaulting to English
- **Milestone:** i18n infrastructure ready, language toggle works, RTL supported

### Week 10 — Testing + Bug Fixes (COMPLETED)
- [x] Full code audit across all 37 source files (app + services + stores + types)
- [x] Fixed dynamic import anti-pattern in wearer home (was using `await import()`)
- [x] Cleaned up all debug `console.log`/`console.error` across 6+ service files
- [x] Location service: changed from 5s testing interval to 30s production interval
- [x] Notification service: cleaned up, removed emoji from push titles
- [x] AI service + registry: removed all debug logging
- [x] RLS audit: verified all 8 tables have RLS enabled, 30 policies total, all correct
- [x] Security advisory: leaked password protection flagged (needs enabling in Supabase dashboard)
- [x] Verified all layout files have proper `export default` statements
- **Milestone:** Code cleaned, audited, and production-ready

### Week 11-12 — Demo Preparation
- [ ] Final polish pass on all UI
- [ ] Prepare demo script (walk-through of all features)
- [ ] Create test accounts with pre-populated data
- [ ] Build production APK via EAS Build
- [ ] Prepare presentation slides with screenshots
- [ ] Rehearse demo
- **Milestone:** Ready for graduation demo day

---

## 3.4 — API Design

All data flows through **Supabase's auto-generated REST API** + **Realtime subscriptions**. Custom logic uses **Edge Functions**.

### Auth Endpoints (Supabase Auth — built-in)

| Action | Method | Supabase SDK Call |
|--------|--------|-------------------|
| Register | POST | `supabase.auth.signUp({ email, password, options: { data: { role, full_name }}})` |
| Login | POST | `supabase.auth.signInWithPassword({ email, password })` |
| Logout | POST | `supabase.auth.signOut()` |
| Reset Password | POST | `supabase.auth.resetPasswordForEmail(email)` |
| Get Session | GET | `supabase.auth.getSession()` |

### Profiles

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Get own profile | SELECT | `supabase.from('profiles').select('*').eq('id', userId).single()` |
| Update profile | UPDATE | `supabase.from('profiles').update({ full_name, phone, avatar_url }).eq('id', userId)` |
| Upload avatar | UPLOAD | `supabase.storage.from('avatars').upload(path, file)` |

### Caregiver Links

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Create invite code | INSERT | `supabase.from('caregiver_links').insert({ wearer_id, invite_code, status: 'pending' })` |
| Claim invite code | UPDATE | `supabase.from('caregiver_links').update({ caregiver_id, status: 'active' }).eq('invite_code', code)` |
| Get linked wearers | SELECT | `supabase.from('caregiver_links').select('*, wearer:profiles!wearer_id(*)').eq('caregiver_id', id).eq('status', 'active')` |
| Get linked caregivers | SELECT | `supabase.from('caregiver_links').select('*, caregiver:profiles!caregiver_id(*)').eq('wearer_id', id).eq('status', 'active')` |
| Unlink | UPDATE | `supabase.from('caregiver_links').update({ status: 'revoked' }).eq('id', linkId)` |

### Alerts

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Create alert | INSERT | `supabase.from('alerts').insert({ wearer_id, type, severity, message, metadata })` |
| Get wearer's alerts | SELECT | `supabase.from('alerts').select('*').eq('wearer_id', id).order('created_at', { ascending: false })` |
| Resolve alert | UPDATE | `supabase.from('alerts').update({ status: 'resolved', resolved_at: now(), resolved_by }).eq('id', alertId)` |
| Cancel alert | UPDATE | `supabase.from('alerts').update({ status: 'cancelled' }).eq('id', alertId)` |
| Subscribe to alerts | REALTIME | `supabase.channel('alerts').on('postgres_changes', { event: 'INSERT', table: 'alerts' }, callback)` |

### Vitals

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Insert vitals reading | INSERT | `supabase.from('vitals').insert({ user_id, heart_rate, spo2, temperature, activity })` |
| Get latest vitals | SELECT | `supabase.from('vitals').select('*').eq('user_id', id).order('recorded_at', { ascending: false }).limit(1)` |
| Get vitals history | SELECT | `supabase.from('vitals').select('*').eq('user_id', id).gte('recorded_at', startDate).order('recorded_at')` |
| Subscribe to vitals | REALTIME | `supabase.channel('vitals').on('postgres_changes', { event: 'INSERT', table: 'vitals' }, callback)` |

### Locations

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Insert location | INSERT | `supabase.from('locations').insert({ user_id, latitude, longitude, accuracy })` |
| Get latest location | SELECT | `supabase.from('locations').select('*').eq('user_id', id).order('recorded_at', { ascending: false }).limit(1)` |
| Subscribe to location | REALTIME | `supabase.channel('locations').on('postgres_changes', { event: 'INSERT', table: 'locations' }, callback)` |

### Geofences

| Action | Method | Supabase Call |
|--------|--------|---------------|
| Create geofence | INSERT | `supabase.from('geofences').insert({ user_id, name, latitude, longitude, radius })` |
| Get geofences | SELECT | `supabase.from('geofences').select('*').eq('user_id', wearerId).eq('is_active', true)` |
| Delete geofence | UPDATE | `supabase.from('geofences').update({ is_active: false }).eq('id', fenceId)` |

### Edge Functions (future AI models)

| Action | Method | Endpoint |
|--------|--------|----------|
| Cardiac anomaly check | POST | `supabase.functions.invoke('ai-cardiac', { body: { vitals_window }})` |
| HAR classification | POST | `supabase.functions.invoke('ai-har', { body: { imu_window }})` |
| Health assistant chat | POST | `supabase.functions.invoke('ai-assistant', { body: { message, history }})` |

---

## 3.5 — Database Schema

### Current Schema (8 tables)

```
┌──────────────┐       ┌──────────────────┐       ┌──────────────┐
│   profiles   │       │  caregiver_links │       │    devices    │
├──────────────┤       ├──────────────────┤       ├──────────────┤
│ id (PK, FK)  │◄──┐   │ id (PK)          │       │ id (PK)      │
│ role         │   ├───│ wearer_id (FK)   │       │ user_id (FK) │──▶ profiles
│ full_name    │   ├───│ caregiver_id(FK) │       │ hardware_id  │
│ phone        │   │   │ invite_code      │       │ firmware_ver │
│ avatar_url   │   │   │ status           │       │ battery      │
│ emergency_   │   │   │ created_at       │       │ status       │
│   contacts   │   │   └──────────────────┘       │ last_synced  │
│ fcm_token    │   │                               └──────────────┘
│ created_at   │   │
│ updated_at   │   │
└──────┬───────┘   │
       │           │
       │   ┌───────┴──────┐     ┌──────────────┐     ┌──────────────┐
       │   │    alerts     │     │    vitals     │     │  locations   │
       │   ├──────────────┤     ├──────────────┤     ├──────────────┤
       │   │ id (PK)      │     │ id (PK)      │     │ id (PK)      │
       ├──▶│ wearer_id(FK)│     │ user_id (FK) │◄──┤ │ user_id (FK) │◄──┐
       │   │ type         │     │ heart_rate   │  │  │ latitude     │   │
       │   │ severity     │     │ spo2         │  │  │ longitude    │   │
       │   │ status       │     │ temperature  │  │  │ accuracy     │   │
       │   │ message      │     │ activity     │  │  │ recorded_at  │   │
       │   │ metadata     │     │ recorded_at  │  │  └──────────────┘   │
       │   │ resolved_at  │     └──────────────┘  │                     │
       │   │ resolved_by  │                       │                     │
       │   │ created_at   │                       │  ┌──────────────┐   │
       │   └──────────────┘                       │  │  geofences   │   │
       │                                          │  ├──────────────┤   │
       │                                          │  │ id (PK)      │   │
       │                                          └──│ user_id (FK) │   │
       │                                             │ name         │   │
       │                                             │ latitude     │   │
       │                                             │ longitude    │   │
       │                                             │ radius       │   │
       │                                             │ is_active    │   │
       │                                             │ created_by   │───┘
       │                                             └──────────────┘
       │
       │   ┌──────────────┐
       │   │ achievements │
       │   ├──────────────┤
       └──▶│ id (PK)      │
           │ user_id (FK) │
           │ type         │
           │ name         │
           │ points       │
           │ unlocked_at  │
           └──────────────┘
```

### Key Relationships
- **profiles** 1:N **alerts** (a wearer has many alerts)
- **profiles** 1:N **vitals** (a wearer has many vitals readings)
- **profiles** 1:N **locations** (a wearer has many location records)
- **profiles** N:M **profiles** via **caregiver_links** (wearers ↔ caregivers)
- **profiles** 1:1 **devices** (a wearer has one smartwatch)
- **profiles** 1:N **geofences** (a wearer has many safe zones)
- **profiles** 1:N **achievements** (a user earns many achievements)

### Row Level Security Summary
- Users can only read/update their **own** profile
- Wearers can only see their **own** vitals, locations, alerts
- Caregivers can see data for **linked wearers only** (via caregiver_links join)
- Alerts can be resolved by the wearer OR their linked caregiver
- Invite codes are readable by anyone authenticated (for claiming)

---

## 3.6 — Integration Plan for AI Models

### Standard AI Model Interface

Every AI model (current and future) must conform to this contract:

```typescript
// src/types/ai.types.ts (already exists)

interface AIModelAdapter {
  modelId: string;           // e.g., "fall-detection", "cardiac", "har"
  modelName: string;         // e.g., "FusionNet Fall Detection"
  version: string;           // e.g., "1.0.0"
  type: 'on-device' | 'cloud';

  // Initialize the model (load ONNX, warm up, etc.)
  initialize(): Promise<void>;

  // Run inference
  predict(input: AIInferenceRequest): Promise<AIInferenceResult>;

  // Clean up resources
  dispose(): Promise<void>;
}

interface AIInferenceRequest {
  modelId: string;
  inputData: number[] | number[][];  // Raw sensor data
  timestamp: string;
  metadata?: Record<string, any>;
}

interface AIInferenceResult {
  modelId: string;
  prediction: string;        // e.g., "fall", "normal", "afib"
  confidence: number;        // 0.0 - 1.0
  shouldAlert: boolean;      // Model decides if this warrants an alert
  alertType?: string;        // Maps to AlertType enum
  alertSeverity?: string;    // Maps to AlertSeverity enum
  timestamp: string;
  rawOutput: number[];       // Raw model output for logging
}
```

### Model 1: Fall Detection (FusionNet) — READY

```
Type:        On-device (ONNX Runtime Mobile)
Model file:  FusionNet_v1.onnx (1.87 MB)
Input:       7-channel sliding window [accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, barometer]
             Shape: (1, window_size, 7)
Output:      Binary classification [no_fall, fall] with confidence
Trigger:     Continuous — runs on every new sensor window from BLE
Alert:       If fall detected with confidence > 0.85 → create alert (type: 'fall', severity: 'critical')
Latency:     <1ms inference time
Offline:     Yes — fully on-device
```

**Integration steps:**
1. Copy `FusionNet_v1.onnx` to `src/assets/models/`
2. Install `onnxruntime-react-native`
3. Create `src/services/ai/fall-detection.adapter.ts` implementing `AIModelAdapter`
4. In BLE data handler: pipe each new sensor window → adapter.predict()
5. If shouldAlert === true → call alert.service.createAlert()

### Model 2: Cardiac Anomaly Detection — PENDING

```
Type:        Cloud (Supabase Edge Function)
Input:       Heart rate + SpO2 window (last N readings)
Output:      Classification (normal, bradycardia, tachycardia, afib, etc.)
Trigger:     Every 60 seconds (batch of recent readings)
Alert:       If anomaly detected → create alert (type: 'cardiac', severity: 'high')
```

**Integration steps (when model is delivered):**
1. Deploy model as Supabase Edge Function at `ai-cardiac`
2. Create `src/services/ai/cardiac.adapter.ts` implementing `AIModelAdapter`
3. predict() calls `supabase.functions.invoke('ai-cardiac', { body: { vitals } })`
4. Register adapter in the AI service registry

### Model 3: Human Activity Recognition (HAR) — PENDING

```
Type:        On-device OR cloud (TBD based on model size)
Input:       IMU sensor window (accelerometer + gyroscope)
Output:      Activity class (walking, running, sitting, lying, climbing stairs, etc.)
Trigger:     Every 5 seconds
Alert:       If prolonged inactivity detected → create alert (type: 'inactivity', severity: 'medium')
```

### Model 4: Intelligent Health Assistant — PENDING

```
Type:        Cloud (Supabase Edge Function → LLM API)
Input:       User message + conversation history + user health context
Output:      Natural language response
Trigger:     User-initiated (chat interface)
Alert:       None — conversational only
```

### AI Service Registry Pattern

```typescript
// src/services/ai/ai-registry.ts

class AIModelRegistry {
  private adapters: Map<string, AIModelAdapter> = new Map();

  register(adapter: AIModelAdapter) {
    this.adapters.set(adapter.modelId, adapter);
  }

  async initialize(modelId: string) {
    const adapter = this.adapters.get(modelId);
    if (adapter) await adapter.initialize();
  }

  async predict(modelId: string, input: AIInferenceRequest) {
    const adapter = this.adapters.get(modelId);
    if (!adapter) throw new Error(`Model ${modelId} not registered`);
    return adapter.predict(input);
  }

  // Initialize all registered models
  async initializeAll() {
    for (const adapter of this.adapters.values()) {
      await adapter.initialize();
    }
  }
}

// Usage:
// registry.register(new FallDetectionAdapter());   // Week 5
// registry.register(new CardiacAdapter());          // When delivered
// registry.register(new HARAdapter());              // When delivered
```

**Key design principle:** Adding a new AI model = creating one adapter file + one `registry.register()` call. Zero changes to existing code.

---

## 3.7 — Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| 1 | **Smartwatch BLE protocol unknown** — we may not have documentation for the target watch's BLE services and characteristics | High | High | Research watch BLE API early (Week 4). Have a fallback plan: use a known open-protocol watch (e.g., PineTime) or simulate BLE data with a phone app for demo. |
| 2 | **AI models delivered late** — cardiac, HAR, or assistant models not ready in time | Medium | Medium | Adapter pattern means app works without them. Fall detection is already done. Demo can showcase modular design + fall detection. Other models are "plug and play" whenever ready. |
| 3 | **ONNX Runtime compatibility issues** — ONNX Runtime React Native may have build issues or not support the FusionNet model format | Medium | High | Test ONNX integration early (Week 5). Fallback: convert model to TFLite or run inference via a simple REST API on a free server. |
| 4 | **Expo Go limitations for BLE** — BLE requires a custom dev build, not Expo Go | High | Medium | Switch to EAS Development Build when BLE work starts (Week 4). This is expected and planned — just requires `eas build --profile development`. |
| 5 | **Push notification setup complexity** — FCM requires Apple Developer account for iOS, Firebase project config, etc. | Medium | Medium | Set up FCM early (Week 2). Use Expo's push notification service as a simpler alternative if direct FCM is too complex. |
| 6 | **Battery drain from continuous sensing** — BLE + GPS + on-device ML may drain phone battery fast | Medium | Medium | Implement adaptive sensing: reduce frequency when wearer is stationary. Use significant location changes instead of continuous GPS. Batch vitals uploads. |
| 7 | **Supabase free tier limits** — 500 MB database, 1 GB storage, 2 GB bandwidth per month | Low | Medium | More than enough for a graduation project. If approaching limits: reduce vitals recording frequency, clean old location data. Upgrade to Pro ($25/mo) if needed for demo period. |
| 8 | **Team coordination on parallel work** — multiple students working on different features may cause merge conflicts | Medium | Low | Clear folder structure already separates concerns. Use feature branches + PRs. Weekly sync meetings. Each person owns specific screens/services. |

---

## Summary: What's Done vs What's Next

### Completed (Weeks 1-10)
- Project setup (Expo SDK 54, TypeScript, Supabase)
- EAS Development Build (Android) with Firebase FCM
- Auth (login, register, forgot password, role selection)
- Role-based navigation (wearer 4 tabs, caregiver 4 tabs)
- Caregiver ↔ Wearer linking via invite codes + unlink
- SOS alert pipeline (button → countdown → alert → real-time → resolve)
- Push notifications (FCM token registration, Expo Push API delivery)
- Profile editing (name, phone, avatar upload to Supabase Storage)
- Emergency contacts management (add/edit/delete, max 5)
- Dark mode toggle (persisted via AsyncStorage)
- Wearer vitals dashboard with mock data simulator (HR, SpO2, temp, steps, activity)
- Activity screen with 24h line charts + weekly steps bar chart
- Caregiver wearer detail screen (vitals, charts, call/message)
- Location tracking service + Supabase storage
- Caregiver map with wearer location cards + OpenStreetMap link
- Geofence creation, deletion, and breach detection
- Alert detail screen + caregiver alerts tab with badge count
- AI model registry + adapter pattern (FusionNet simulator, cloud template)
- Fall detection pipeline (sensor → inference → 15s countdown → auto-alert)
- Offline alert queue (AsyncStorage-based, auto-sync when online)
- Offline detection + banner UI
- Loading skeletons + error states
- Haptic feedback on SOS
- Onboarding walkthrough (3 screens, shown on first launch)
- i18n infrastructure (i18next, Arabic + English translation files, language toggle, RTL)
- Full code audit + cleanup (removed debug logs, fixed anti-patterns)
- RLS security audit (8 tables, 30 policies, all verified)

### Next Up (Week 11-12) — Demo Preparation
- Final polish pass on all UI
- Build production APK via EAS Build
- Create test accounts with pre-populated demo data
- Prepare demo script
- Wire t() translation calls into screens (incremental)

### Progress: 29/32 features done (91%)
- P0 features: 13/14 done (93%) — remaining: BLE smartwatch pairing (needs hardware)
- P1 features: 12/12 done (100%)
- P2 features: 4/6 done (67%) — remaining: AI health assistant, achievements/gamification

### Current State
The app is a **complete MVP** with all critical flows working end-to-end. Both user roles (wearer + caregiver) are fully functional: auth, linking, SOS alerts, push notifications, vitals dashboard (mock data), fall detection AI (simulator), location tracking, geofencing, offline support, dark mode, Arabic localization infrastructure, and onboarding. Code has been audited, cleaned, and security-verified.

### Remaining Gaps (deferred, not blocking demo)
- BLE smartwatch pairing (needs specific hardware + Apple Developer account for iOS)
- On-device ONNX inference (currently using simulator — swap one adapter when real data flows)
- Google Maps integration (needs API key with billing — using OpenStreetMap link instead)
- Wire `t()` calls into individual screens for full Arabic translation
- Alert history filters (type, date, wearer)
- AI health assistant (waiting for RAG model delivery)
- Achievements/gamification (P2, nice-to-have)

### Full Demo Target: Week 12
Production APK built, demo accounts ready, presentation rehearsed.
