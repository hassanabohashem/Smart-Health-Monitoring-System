# Smart Health Companion App (smart-health-54)

This directory contains the cross-platform React Native mobile application built with **Expo SDK** and **TypeScript**. It serves as the central hub for the Smart Health Monitoring System, providing distinct portals for wearers (patients) and caregivers.

## Features

- **Wearer Portal**: Live dashboard showing current heart rate, step counts, and active vitals; real-time messaging with the AI clinical assistant; profile management.
- **Caregiver Portal**: Remote monitoring of linked wearers' vitals; alerts feed (falls, abnormal cardiac events, inactivity); geofence boundaries configuration; direct clinical chat.
- **On-Device ML**: Runs on-device inference using **ONNX Runtime Mobile** for fall detection, human activity recognition (HAR), and cardiac beat classification.
- **Robust Sync**: Integrates with a local SQLite database (via Expo SQLite) for offline support and synchronizes with **Supabase (PostgreSQL)** when online.

---

## Project Structure

```
smart-health-54/
├── app/                       # File-based routing (Expo Router)
│   ├── (auth)/                # Login, registration, and password recovery screens
│   ├── (wearer)/              # Wearer-facing dashboard tabs
│   ├── (caregiver)/           # Caregiver-facing tabs for wearer monitoring
│   ├── (shared)/              # Shared detail screens (chat sessions, alert details)
│   └── _layout.tsx            # Root navigation & theme configuration
│
├── src/                       # Application source code
│   ├── components/            # Reusable UI elements (charts, alert cards, inputs)
│   ├── services/              # Supabase, AI client, and Wearable sync services
│   ├── stores/                # Zustand global state managers (9 stores)
│   └── utils/                 # Formatting, validations, and helper functions
│
├── docs/                      # Technical documentation & design reports
│   ├── DESIGN.md              # UI/UX guidelines, design tokens, and components
│   ├── DEVELOPMENT_PLAN.md    # Feature roadmaps, milestones, and status
│   └── DOCUMENTATION.md       # API references, SQLite schema, and Zustand sync
│
├── assets/                    # Static image assets, icons, and on-device ONNX models
├── scripts/                   # Auxiliary development & configuration utilities
├── package.json               # Node packages and dependency versions
├── app.json                   # Expo client and native build configurations
└── tsconfig.json              # TypeScript compiler configuration
```

---

## Installation & Execution

### Prerequisites
- **Node.js** (v18.x or later recommended)
- **npm** (v9.x or later)
- **Expo Go** app installed on your physical test device (iOS/Android)

### Setup Steps
1. Navigate to the project directory and install dependencies:
   ```bash
   npm install
   ```
2. Configure local environment variables:
   - Copy `.env.example` to `.env`
   - Fill in your `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`
3. Start the Expo development server:
   ```bash
   npx expo start
   ```
4. Scan the QR code printed in the terminal using your mobile device camera (iOS) or the Expo Go app (Android) to load the application.

---

## Key Documentation (in `docs/`)

- [**DOCUMENTATION.md**](file:///d:/GP-IMP/smart-health-54/docs/DOCUMENTATION.md): Comprehensive developer guide covering SQLite database tables, Zustand state stores, and the sync engine.
- [**DEVELOPMENT_PLAN.md**](file:///d:/GP-IMP/smart-health-54/docs/DEVELOPMENT_PLAN.md): Detailed log of milestones, completed screen developments, and testing coverage.
- [**DESIGN.md**](file:///d:/GP-IMP/smart-health-54/docs/DESIGN.md): Visual theme specification, typography tokens, component architecture, and styling rules.
