# Smart Health — Technical Documentation

> A React Native mobile application for elderly health monitoring with real-time alerts, location tracking, and caregiver connectivity.

**Version:** 1.0.0
**Last Updated:** March 29, 2026
**Platform:** Android (APK via EAS Build)
**Backend:** Supabase (PostgreSQL + Realtime + Auth + Storage)

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Screens](#screens)
5. [Services](#services)
6. [State Management](#state-management)
7. [Database Schema](#database-schema)
8. [Authentication & Authorization](#authentication--authorization)
9. [Internationalization (i18n)](#internationalization-i18n)
10. [Push Notifications](#push-notifications)
11. [Location Tracking & Geofencing](#location-tracking--geofencing)
12. [Offline Support](#offline-support)
13. [Achievements System](#achievements-system)
14. [Health Assistant](#health-assistant)
15. [Phone Input Component](#phone-input-component)
16. [Theming](#theming)
17. [Building & Deployment](#building--deployment)
18. [Environment Variables](#environment-variables)
19. [Known Limitations](#known-limitations)
20. [Future Work](#future-work)

---

## Architecture Overview

```
Mobile App (React Native + Expo)
  |
  |-- Expo Router (file-based navigation)
  |-- React Native Paper (Material Design 3 UI)
  |-- Zustand (state management)
  |-- i18next (EN + AR localization with RTL)
  |
  |----> Supabase Cloud
  |        |-- PostgreSQL (8 tables with RLS)
  |        |-- Realtime (WebSocket subscriptions for alerts + locations)
  |        |-- Auth (email/password with JWT)
  |        |-- Storage (avatar uploads)
  |
  |----> Expo Push Notification Service
  |        |-- FCM V1 (Firebase Cloud Messaging)
  |
  |----> GPS (expo-location)
           |-- Foreground tracking (10s interval)
           |-- Background tracking (30s interval, persistent notification)
```

**Two user roles:**
- **Wearer** — Elderly person being monitored. Sees vitals, can trigger SOS, earns achievements.
- **Caregiver** — Family member monitoring the wearer. Sees real-time location, receives alerts, manages safe zones.

---

## Tech Stack

| Category | Technology | Version |
|----------|-----------|---------|
| Framework | React Native | 0.81.5 |
| Platform | Expo SDK | 54 |
| Navigation | Expo Router | 6.0 |
| UI Library | React Native Paper | 5.15.0 |
| State | Zustand | 5.0.12 |
| Backend | Supabase JS | 2.100.0 |
| i18n | i18next + react-i18next | 25.10 / 16.6 |
| Charts | react-native-gifted-charts | 1.4.76 |
| Phone Input | libphonenumber-js | 1.12.40 |
| Image Picker | expo-image-picker | 17.0.10 |
| Localization | expo-localization | 17.0.8 |
| Location | expo-location | 19.0.8 |
| Background Tasks | expo-task-manager | 14.0.9 |
| Notifications | expo-notifications | 0.32.16 |
| SVG | react-native-svg | 15.12.1 |
| Language | TypeScript | 5.9.2 |

---

## Project Structure

```
smart-health-54/
  app/                          # Expo Router screens
    _layout.tsx                 # Root layout (Stack navigator + AuthGate)
    index.tsx                   # Entry redirect
    (auth)/                     # Authentication screens
      _layout.tsx               # Stack with headerShown: false
      login.tsx                 # Email/password sign in
      register.tsx              # Sign up with role selection
      forgot-password.tsx       # Password reset
      onboarding.tsx            # 5-slide welcome walkthrough
    (wearer)/                   # Wearer tab screens
      _layout.tsx               # Bottom tabs (Home, Activity, Assistant, Settings)
      home.tsx                  # Vitals dashboard, SOS, fall detection, demo mode
      activity.tsx              # Charts (HR, SpO2, temp, steps)
      assistant.tsx             # AI health chat with quick replies
      settings.tsx              # Profile, linking, safe zones, achievements, preferences
    (caregiver)/                # Caregiver tab screens
      _layout.tsx               # Bottom tabs (Dashboard, Map, Alerts, Settings)
      dashboard.tsx             # Wearer cards, quick stats, recent alerts
      map.tsx                   # Location cards, geofence management
      alerts.tsx                # Alert list with filter chips
      settings.tsx              # Profile, linking, preferences
    (shared)/                   # Sub-screens accessible from any role
      _layout.tsx               # Stack with themed headers + back buttons
      edit-profile.tsx          # Edit name, phone, avatar
      emergency-contacts.tsx    # CRUD emergency contacts (max 5)
      manage-links.tsx          # View/unlink caregivers or wearers
      link-wearer.tsx           # Accept/decline pending invitations
      alert-detail.tsx          # Alert details with resolve/false alarm actions
      wearer-detail.tsx         # Caregiver's view of wearer vitals + 3 charts
      safe-zones.tsx            # Wearer's view of their safe zones
      achievements.tsx          # Points, unlocked/locked achievement cards
  src/
    components/
      PhoneInput.tsx            # International phone input with progressive formatting
      Skeleton.tsx              # Skeleton loaders (Dashboard, Alerts, ManageLinks, etc.)
      ErrorState.tsx            # Error + empty state components
      OfflineBanner.tsx         # Offline status banner
    services/
      supabase.ts               # Supabase client initialization
      auth.service.ts           # Login, register, profile CRUD
      alert.service.ts          # Alert creation, resolution, querying
      link.service.ts           # Caregiver-wearer linking, invitations
      location.service.ts       # GPS tracking (foreground + background), geofence checks
      geofence.service.ts       # Geofence CRUD, breach detection, Haversine distance
      notification.service.ts   # Push token registration, send to user/caregivers
      offline-queue.service.ts  # Queue alerts/vitals/locations when offline, sync on reconnect
      mock-vitals.service.ts    # Mock vital signs generator + Supabase persistence
      achievement.service.ts    # Achievement checking, unlocking, querying
      chat.service.ts           # FAQ-based health assistant responses
      ai/                       # AI model integration layer
        index.ts                # Public API (initialize, dispose, fall detection)
        ai.service.ts           # Core inference engine
        ai-registry.ts          # Model registry and adapter selection
        fall-detection.adapter.ts # ONNX fall detection adapter (on-device)
        har.adapter.ts            # ONNX HAR (CNN-Transformer) adapter (on-device)
        cardiac.adapter.ts        # ONNX cardiac beat classifier adapter (on-device)
        onnx-runtime.ts           # Shared ORT-RN session loader/runner
    stores/
      auth.store.ts             # Session, profile, loading state
      vitals.store.ts           # Heart rate, SpO2, temp, steps, activity
      alerts.store.ts           # Alert list, active count
      device.store.ts           # Smartwatch connection, battery
      theme.store.ts            # Dark/light mode (persisted to AsyncStorage)
      achievements.store.ts     # Achievements list, total points, new unlock
    types/
      user.types.ts             # Profile, EmergencyContact, CaregiverLink
      alert.types.ts            # Alert, AlertType, AlertStatus, AlertSeverity
      device.types.ts           # DeviceStatus
      vitals.types.ts           # VitalsData
      ai.types.ts               # AIModel, FallDetectionResult
      achievement.types.ts      # Achievement, AchievementType, config
      chat.types.ts             # ChatMessage, QuickReply
    i18n/
      index.ts                  # i18next config, language switching, RTL handling
      en.ts                     # English translations (~300 keys)
      ar.ts                     # Arabic translations (~300 keys)
    utils/
      theme.ts                  # Light + dark Material Design 3 themes
      constants.ts              # App-wide constants (thresholds, intervals, UUIDs)
      useNetworkStatus.ts       # Custom hook for offline detection
  assets/
    icon.png                    # App icon
    adaptive-icon.png           # Android adaptive icon
    splash-icon.png             # Splash screen icon
    favicon.png                 # Web favicon
    models/                     # AI model files (ONNX)
  supabase/
    migrations/                 # Database migration SQL files
  .env                          # Supabase URL + anon key
  app.json                      # Expo configuration
  eas.json                      # EAS Build profiles
  google-services.json          # Firebase config for FCM
  package.json                  # Dependencies
  tsconfig.json                 # TypeScript configuration
```

---

## Screens

### Authentication (4 screens)

| Screen | File | Description |
|--------|------|-------------|
| Onboarding | `(auth)/onboarding.tsx` | 5-slide horizontal swipeable walkthrough. Shown once on first launch. Saves completion to AsyncStorage. |
| Login | `(auth)/login.tsx` | Email/password sign in via Supabase Auth. |
| Register | `(auth)/register.tsx` | Sign up with role selection (wearer/caregiver). Creates auth user + profile row. |
| Forgot Password | `(auth)/forgot-password.tsx` | Sends password reset email via Supabase. |

### Wearer (4 tab screens)

| Screen | File | Description |
|--------|------|-------------|
| Home | `(wearer)/home.tsx` | Vitals dashboard (HR, SpO2, temp, steps), SOS button with countdown, fall detection dialog, demo mode toggle. Starts location tracking and achievement checking. |
| Activity | `(wearer)/activity.tsx` | Line charts for HR, SpO2, temp over 24h. Weekly step bar chart. Requires demo mode for data. |
| Assistant | `(wearer)/assistant.tsx` | Chat UI with message bubbles and quick reply chips. Reads current vitals from store for contextual responses. |
| Settings | `(wearer)/settings.tsx` | Profile header, invite caregiver (email), linked caregivers, emergency contacts, safe zones, achievements, device pairing, dark mode, notifications toggle, language switcher, sign out. |

### Caregiver (4 tab screens)

| Screen | File | Description |
|--------|------|-------------|
| Dashboard | `(caregiver)/dashboard.tsx` | Greeting, quick stats (wearers count, active alerts), wearer cards with vitals preview, recent alerts (last 3). Real-time alert subscription via Supabase Realtime. |
| Map | `(caregiver)/map.tsx` | Location cards per wearer (coordinates, last seen, geofence status). Geofence CRUD with inline validation (min 50m radius). Real-time location updates via Supabase Realtime. |
| Alerts | `(caregiver)/alerts.tsx` | Alert list with filter chips (status: all/active/resolved/false alarm, type: all/fall/SOS/geofence/cardiac/low battery/inactivity). Pull-to-refresh. |
| Settings | `(caregiver)/settings.tsx` | Profile header, link wearer, manage wearers, dark mode, notifications toggle, language switcher, sign out. |

### Shared Sub-screens (8 screens)

| Screen | File | Description |
|--------|------|-------------|
| Edit Profile | `(shared)/edit-profile.tsx` | Edit name, phone (PhoneInput component), avatar (image picker + Supabase Storage upload). |
| Emergency Contacts | `(shared)/emergency-contacts.tsx` | Add/edit/delete emergency contacts (max 5). Dialog with name, phone (PhoneInput), relationship. |
| Manage Links | `(shared)/manage-links.tsx` | View linked caregivers (for wearer) or wearers (for caregiver). Unlink with confirmation. Skeleton loader + pull-to-refresh. |
| Link Wearer | `(shared)/link-wearer.tsx` | Caregiver views pending invitations from wearers. Accept/decline with confirmation. Skeleton loader + pull-to-refresh. |
| Alert Detail | `(shared)/alert-detail.tsx` | Full alert details: type, severity badge, wearer info, timestamps, confidence score. Action buttons: Resolve Alert, False Alarm, Call Wearer. |
| Wearer Detail | `(shared)/wearer-detail.tsx` | Caregiver's detailed view of a wearer: vitals grid (HR, SpO2, temp, steps), activity status, 3 line charts (HR, SpO2, temp over 12h). Call/message buttons. |
| Safe Zones | `(shared)/safe-zones.tsx` | Wearer's read-only view of geofences set by caregivers. Shows inside/outside status with green/red banners. |
| Achievements | `(shared)/achievements.tsx` | Total points card, unlocked achievements with dates, locked achievements with descriptions of how to unlock. |

---

## Services

### `supabase.ts`
Initializes the Supabase client with URL and anon key from environment variables. Uses `expo-secure-store` for token persistence.

### `auth.service.ts`
- `signIn(email, password)` — Supabase email sign in
- `signUp(email, password, fullName, role)` — Creates auth user + profile row
- `signOut()` — Clears session
- `getProfile(userId)` — Fetch profile with all fields
- `updateProfile(userId, updates)` — Partial profile update
- `generateInviteCode()` — 6-char random code

### `alert.service.ts`
- `createAlert(params)` — Insert alert row
- `getAlertsForCaregiver(caregiverId)` — Fetch alerts for all linked wearers (joins wearer profile)
- `resolveAlert(alertId, resolvedBy)` — Set status to 'resolved'
- `cancelAlert(alertId)` — Set status to 'cancelled' (false alarm)

### `link.service.ts`
- `sendInvitation(wearerId, caregiverEmail)` — Create pending link by email lookup
- `getPendingInvitations(caregiverId)` — Fetch pending invites with wearer profile
- `acceptInvitation(linkId)` — Set status to 'active'
- `declineInvitation(linkId)` — Delete the link row
- `getLinkedWearers(caregiverId)` — Active links with wearer profiles
- `getLinkedCaregivers(wearerId)` — Active links with caregiver profiles
- `getSentInvitations(wearerId)` — Pending invitations sent by wearer
- `unlinkWearer(linkId)` — Delete link

### `location.service.ts`
- `startLocationTracking(wearerId, wearerName)` — Foreground GPS (10s/5m) + background GPS (30s/20m via TaskManager). Persists to Supabase. Checks geofences on each update. TaskManager is conditionally loaded — gracefully disabled in Expo Go, fully functional in APK builds.
- `stopLocationTracking()` — Stops both foreground and background tracking
- `getLatestLocation(wearerId)` — Most recent location row
- `getLocationHistory(wearerId, hours)` — Location rows since N hours ago
- `getCurrentPosition()` — One-shot GPS fix

### `geofence.service.ts`
- `getGeofences(wearerId)` — All active geofences for a wearer
- `createGeofence(params)` — Insert geofence row (min 50m radius enforced in UI)
- `deleteGeofence(geofenceId)` — Soft delete (set is_active=false)
- `getDistanceMeters(lat1, lon1, lat2, lon2)` — Haversine distance calculation
- `checkGeofenceBreach(lat, lon, geofences)` — Returns geofences the wearer is outside of
- `handleGeofenceBreach(wearerId, name, fence, lat, lon)` — Creates alert + notifies caregivers

### `notification.service.ts`
- `registerForPushNotifications(userId)` — Request permission, get Expo push token, save to profile, create Android notification channel
- `sendPushToUser(targetUserId, title, body, data)` — Fetch user's token, POST to Expo Push API
- `notifyCaregivers(wearerId, wearerName, alertType, alertId)` — Send push to all linked caregivers

### `offline-queue.service.ts`
- `initOfflineQueue()` — Start sync interval (every 30s)
- `disposeOfflineQueue()` — Stop sync interval
- `createAlertWithOfflineSupport(params, wearerName)` — Try online insert, queue if offline
- `queueVitals(payload)` — Queue vitals data for later sync
- `queueLocation(payload)` — Queue location data for later sync
- Sync handles 3 types: `alert`, `vitals`, `location`. Max 5 retries per item.

### `mock-vitals.service.ts`
- `startMockVitals(wearerId?)` — Generates realistic vitals every 3s. If wearerId provided, persists to Supabase every 15s with offline queue fallback.
- `stopMockVitals()` — Stops mock generation
- `generateMockHistory(hours)` — Returns arrays of HR, SpO2, temp, steps for charts
- `generateDailySteps()` — Weekly step summary

### `achievement.service.ts`
- `getUserAchievements(userId)` — Fetch all achievements
- `unlockAchievement(userId, type, points)` — Upsert achievement row
- `checkAndUnlockAchievements(userId, context, existingTypes)` — Check all conditions and unlock new ones
- `getTotalPoints(userId)` — Sum of all points

### `chat.service.ts`
- `generateResponse(input, vitals, t)` — FAQ engine that reads vitals from store. Handles keywords (heart rate, steps, SpO2, temp, summary) and returns contextual responses. Uses i18n for localized responses.

### `ai/` (AI integration layer)
- `index.ts` — Public API: `initializeAI()`, `disposeAI()`, `onFallDetected()`, `confirmFallAlert()`, `getModelStatus()`
- `ai.service.ts` — Core inference engine
- `ai-registry.ts` — Model registry
- `fall-detection.adapter.ts` — On-device FusionNet ONNX adapter
- `har.adapter.ts` — On-device HAR CNN-Transformer ONNX adapter
- `cardiac.adapter.ts` — On-device cardiac beat classifier ONNX adapter
- `onnx-runtime.ts` — Shared ORT-RN session loader/runner

---

## State Management

All stores use Zustand with simple get/set patterns.

### `auth.store.ts`
```typescript
interface AuthState {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isLoading: boolean;
  isInitialized: boolean;
  onboardingDone: boolean;
}
```

### `vitals.store.ts`
```typescript
interface VitalsState {
  heartRate: number | null;
  spo2: number | null;
  temperature: number | null;
  steps: number;
  currentActivity: string;
}
```

### `alerts.store.ts`
```typescript
interface AlertsState {
  alerts: Alert[];
  isLoading: boolean;
  activeAlertCount: number; // computed getter
}
```

### `device.store.ts`
```typescript
interface DeviceState {
  isConnected: boolean;
  batteryLevel: number | null;
}
```

### `theme.store.ts`
```typescript
interface ThemeState {
  isDarkMode: boolean;
  // Persisted to AsyncStorage
}
```

### `achievements.store.ts`
```typescript
interface AchievementsState {
  achievements: Achievement[];
  totalPoints: number;
  newUnlock: Achievement | null;
}
```

---

## Database Schema

### `profiles`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | FK to auth.users |
| full_name | TEXT | Required |
| phone | TEXT | Nullable |
| role | TEXT | 'wearer' / 'caregiver' / 'admin' |
| avatar_url | TEXT | Supabase Storage URL |
| emergency_contacts | JSONB | Array of {name, phone, relation} |
| fcm_token | TEXT | Expo push token |
| notifications_enabled | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### `caregiver_links`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| caregiver_id | UUID (FK) | References profiles |
| wearer_id | UUID (FK) | References profiles |
| invite_code | TEXT | Unique, nullable |
| status | TEXT | 'pending' / 'active' / 'revoked' |
| created_at | TIMESTAMPTZ | |

### `alerts`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| wearer_id | UUID (FK) | References profiles |
| device_id | UUID (FK) | Nullable, references devices |
| type | TEXT | fall / sos / geofence / low_battery / cardiac / inactivity |
| severity | TEXT | low / medium / high / critical |
| confidence | REAL | 0.0 - 1.0, nullable |
| latitude | DOUBLE | Nullable |
| longitude | DOUBLE | Nullable |
| metadata | JSONB | Extra data (geofence_id, triggered_by, etc.) |
| status | TEXT | active / cancelled / resolved |
| resolved_by | UUID (FK) | Nullable |
| resolved_at | TIMESTAMPTZ | Nullable |
| created_at | TIMESTAMPTZ | |

### `vitals`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| user_id | UUID (FK) | References profiles |
| device_id | UUID (FK) | Nullable |
| heart_rate | REAL | bpm |
| spo2 | REAL | percentage |
| temperature | REAL | Celsius |
| activity | TEXT | Resting/Walking/Sitting/etc. |
| metadata | JSONB | |
| recorded_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

### `locations`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| user_id | UUID (FK) | References profiles |
| latitude | DOUBLE | |
| longitude | DOUBLE | |
| accuracy | REAL | meters |
| recorded_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |

### `geofences`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| wearer_id | UUID (FK) | The wearer this zone protects |
| created_by | UUID (FK) | The caregiver who created it |
| name | TEXT | Default 'Safe Zone' |
| latitude | DOUBLE | Center point |
| longitude | DOUBLE | Center point |
| radius_meters | REAL | Default 500, min 50m enforced in UI with inline validation |
| is_active | BOOLEAN | Soft delete flag |
| created_at | TIMESTAMPTZ | |

### `achievements`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| user_id | UUID (FK) | References profiles |
| type | TEXT | UNIQUE with user_id |
| points | INTEGER | Default 0 |
| unlocked_at | TIMESTAMPTZ | |

### `devices`
| Column | Type | Notes |
|--------|------|-------|
| id | UUID (PK) | |
| user_id | UUID (FK) | |
| hardware_id | TEXT | Unique BLE identifier |
| name | TEXT | |
| firmware_version | TEXT | |
| battery_level | INTEGER | |
| status | TEXT | online / offline / pairing |
| last_seen_at | TIMESTAMPTZ | |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

### Row Level Security (RLS)
All 8 tables have RLS enabled. Key policies:
- Users can only SELECT/UPDATE their own profile
- Wearers can INSERT alerts and vitals for themselves
- Caregivers can SELECT alerts/vitals/locations for linked wearers only
- Geofences can be created/deleted only by the caregiver who created them
- Wearers can view their own geofences (read-only)
- Achievements scoped to own user_id

### Realtime
Tables with Supabase Realtime enabled: `alerts`, `locations`, `vitals`
- Caregiver dashboard subscribes to `alerts` INSERT events
- Caregiver map subscribes to `locations` INSERT events

---

## Authentication & Authorization

### Flow
1. User signs up with email, password, full name, and role (wearer/caregiver)
2. Supabase Auth creates the user; a database trigger creates the profile row
3. On login, `AuthGate` in `_layout.tsx` detects the session and routes by role:
   - Wearer → `/(wearer)/home`
   - Caregiver → `/(caregiver)/dashboard`
4. JWT token stored securely via `expo-secure-store`
5. All Supabase queries use the authenticated client (RLS enforced)

### Linking Flow
1. Wearer goes to Settings → "Invite a Caregiver" → enters caregiver's email
2. System looks up the caregiver profile by email, creates a `caregiver_links` row with status `pending`
3. Caregiver goes to "Link a Wearer" → sees the pending invitation
4. Caregiver accepts → status changes to `active`
5. Both can now see each other's data (alerts, vitals, location)

---

## Internationalization (i18n)

### Setup
- `i18next` with `react-i18next`
- Two languages: English (`en.ts`) and Arabic (`ar.ts`)
- ~300 translation keys covering all screens
- Language persisted to AsyncStorage

### RTL Support
- Arabic triggers `I18nManager.forceRTL(true)`
- On language switch, the app reloads via `NativeModules.DevSettings.reload()` (dev) or shows a restart prompt (production)
- All UI components from React Native Paper support RTL natively

### Adding Translations
1. Add the key to both `src/i18n/en.ts` and `src/i18n/ar.ts`
2. Use in components: `const { t } = useTranslation(); t('section.key')`
3. Interpolation: `t('key', { name: 'value' })` → `"Hello, {{name}}"`

---

## Push Notifications

### Setup
- **Provider:** Expo Push Notifications + Firebase Cloud Messaging (FCM V1)
- **Credentials:** FCM V1 service account key uploaded to EAS via `eas credentials`
- **Token registration:** On login, `registerForPushNotifications(userId)` requests permission, gets Expo push token, saves to `profiles.fcm_token`

### Notification Types
| Trigger | Title | Recipient |
|---------|-------|-----------|
| SOS button | "SOS Emergency!" | All linked caregivers |
| Fall detection | "Fall Detected!" | All linked caregivers |
| Geofence breach | "Geofence Breach!" | All linked caregivers |
| Cardiac anomaly | "Cardiac Alert!" | All linked caregivers |
| Low battery | "Low Battery" | All linked caregivers |
| Inactivity | "Inactivity Alert" | All linked caregivers |

### Notification Preferences
- Toggle in Settings saves `notifications_enabled` to profile
- When disabled: `fcm_token` is set to NULL (server can't send)
- When re-enabled: token is re-registered

### Deep Linking
Tapping a notification opens the alert detail screen:
```typescript
data: { alertId, alertType, wearerId, screen: 'alert-detail' }
```

---

## Location Tracking & Geofencing

### Foreground Tracking
- Accuracy: High
- Interval: every 10 seconds or 5 meters
- Persists to `locations` table via Supabase
- Falls back to offline queue on failure

### Background Tracking
- Uses `expo-task-manager` with `expo-location`
- Accuracy: Balanced (less battery)
- Interval: every 30 seconds or 20 meters
- Shows persistent Android notification: "Smart Health — Tracking your location for safety"
- Requires "Allow all the time" location permission
- Conditionally loaded (gracefully disabled in Expo Go)

### Geofence Breach Detection
- On every location update, all active geofences are checked
- Uses Haversine formula for distance calculation
- Breach = wearer is outside the fence radius
- Each breach triggers only once (tracked in `breachedGeofenceIds` Set)
- When wearer re-enters, the breach flag clears
- Breach creates an alert + sends push notification to all caregivers

### Caregiver Real-time Map
- Subscribes to Supabase Realtime INSERT events on `locations` table
- Location cards update instantly when wearer moves
- Shows "Within safe zone" (green) or "Outside safe zone!" (red)
- "View on Map" opens OpenStreetMap in browser

---

## Offline Support

### Queue System
- `offline-queue.service.ts` manages an AsyncStorage-backed queue
- Three item types: `alert`, `vitals`, `location`
- Connectivity check: `fetch('https://www.google.com', { method: 'HEAD' })`
- Sync runs every 30 seconds
- Max 5 retries per queued item, then discarded
- `OfflineBanner` component shows when offline

### Offline-capable Operations
| Operation | Online | Offline |
|-----------|--------|---------|
| Create alert (SOS) | Direct insert + notify | Queued, synced later |
| Save vitals | Direct insert | Queued |
| Save location | Direct insert | Queued |
| Read alerts | Live from Supabase | Cached in Zustand store |

---

## Achievements System

### Achievement Types

| Type | Points | Condition |
|------|--------|-----------|
| `daily_steps_goal` | 100 | Reach 6,000 steps in a day |
| `consistent_vitals` | 150 | HR 60-100, SpO2 >= 95, Temp 36.0-37.5 |
| `weekly_streak` | 200 | daily_steps_goal unlocked + account 7+ days old |
| `first_link` | 50 | At least 1 linked caregiver |
| `profile_complete` | 50 | Name + phone + avatar all set |

### Checking
- Runs on wearer home screen when demo mode is active
- First check after 5 seconds, then every 60 seconds
- Compares current state against conditions, skips already-unlocked
- New unlock shows a Snackbar notification

### Database
- `achievements` table with UNIQUE constraint on `(user_id, type)` — prevents duplicates
- Upsert pattern: `INSERT ... ON CONFLICT DO NOTHING`

---

## Health Assistant

### Architecture
- Local FAQ engine, no cloud AI dependency
- Reads vitals from `useVitalsStore` for contextual answers
- Quick reply chips for common questions
- 300ms simulated delay for natural feel
- Messages stored in local `useState` only (no persistence)

### Supported Questions
| Quick Reply | Response Uses |
|-------------|---------------|
| "What's my heart rate?" | Current HR + normal range |
| "Am I getting enough steps?" | Steps vs 6000 goal |
| "What's my SpO2?" | Current SpO2 + normal range |
| "What's my temperature?" | Current temp + normal range |
| "Show my weekly summary" | All vitals summary |
| Free text | Keyword matching → appropriate handler |

---

## Phone Input Component

### Features
- International phone input with country picker (48 countries)
- Progressive formatting while typing (uses `formatNational()` templates from `libphonenumber-js`)
- Auto-strips trunk prefix (e.g., user types `010` for Egypt → stored as `10`)
- Real-time validation via `parsePhoneNumberFromString`
- Placeholder shows full national format (e.g., `010 01234567` for Egypt)
- Searchable country picker modal

### Usage
```tsx
<PhoneInput
  value={phone}
  onChangeText={setPhone}
  onValidation={setPhoneValid}
  label="Phone Number"
/>
```

---

## Theming

### Colors
| Token | Light | Dark |
|-------|-------|------|
| Primary | #1A73E8 | #8AB4F8 |
| Secondary | #34A853 | #81C995 |
| Error | #EA4335 | #F28B82 |
| Background | #F8F9FA | #202124 |
| Surface | #FFFFFF | #2D2D30 |

### Toggle
- `useThemeStore` persists dark mode preference to AsyncStorage
- `PaperProvider` wraps the app with the selected theme
- All screens use `theme.colors.*` for consistent theming

---

## Building & Deployment

### Prerequisites
- Node.js 18+
- EAS CLI: `npm install -g eas-cli`
- Expo account with project linked

### Build Commands
```bash
# Preview APK (internal testing)
npx eas build --platform android --profile preview

# Production APK
npx eas build --platform android --profile production

# Development build (with dev tools)
npx eas build --platform android --profile development
```

### FCM Setup (required for push notifications)
1. Firebase Console → Project Settings → Service accounts → Generate new private key
2. `npx eas credentials --platform android`
3. Select "Google Service Account" → "Manage for Push Notifications (FCM V1)" → "Set up" → upload JSON

### Health Check
```bash
# Verify all packages are compatible
npx expo-doctor
```

### Development
```bash
# Start Expo dev server
npx expo start

# Run on Android
npx expo start --android
```

---

## Environment Variables

### `.env`
```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

### EAS Build
Environment variables are embedded at build time via the `.env` file. For different environments, use EAS environment configuration.

---

## Known Limitations

1. **BLE Smartwatch Pairing** — Not implemented. Requires native BLE module and physical smartwatch hardware. Currently uses mock vitals data.
2. **ONNX Fall Detection** — Model adapter exists but requires native ONNX Runtime which isn't available in Expo Go. Works in dev/production builds with the adapter.
3. **AI Health Assistant** — Uses local FAQ engine, not a real AI model. The chat service can be swapped to a cloud LLM backend in the future.
4. **Background Location on iOS** — Not tested. iOS has stricter background location policies.
5. **expo-task-manager in Expo Go** — Native module not available. Background location only works in APK builds. Foreground tracking works in both.
6. **GPS Drift** — Stationary devices can report 5-15m position variance. Geofence minimum radius of 50m (enforced with inline validation in the create dialog) mitigates false breaches.
7. **expo-haptics** — Not available in Expo Go. Haptics calls are wrapped with `.catch(() => {})` to prevent crashes. Works in APK builds.

---

## Future Work

1. **BLE Smartwatch Integration** — Connect real smartwatch via Bluetooth Low Energy for live vitals
2. **Real AI Backend** — Replace FAQ engine with RAG-based health assistant using cloud LLM
3. **ONNX Fall Detection** — Enable on-device fall detection with real accelerometer data
4. **iOS Build** — Test and deploy on iOS (all code is cross-platform)
5. **Health Report Export** — Generate PDF reports of vitals history
6. **Multi-language Expansion** — Add more languages beyond English and Arabic
7. **Wearable Notifications** — Send alerts to smartwatch directly
8. **Video Call** — In-app video call between wearer and caregiver
