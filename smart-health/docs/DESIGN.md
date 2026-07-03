# Design system — quick reference

The mobile app uses a custom design system (May 2026 redesign).
Source-of-truth lives in `src/design/`. CLAUDE.md has the full audit
trail and what's-left list; this file is the navigation map.

## Where things live

| File | What |
|---|---|
| `src/design/tokens.ts` | Color palettes (warm-paper light + slate dark, 4 accent variants), spacing, radius, fontFamily, typeRoles. Every hex value is coloraide-computed from the design source oklch literal in the comment — don't hand-tune. |
| `src/design/fonts.ts` | Loads DM Sans (400/500/600), Newsreader (400), IBM Plex Mono (400/500). 4-second timeout falls back to system. |
| `src/design/useDesignTokens.ts` | `{ palette, isDark }` hook. |
| `src/design/components.tsx` | All primitives — Eyebrow, SectionTitle, Card, Banner, Pill, IconDot, HeroVital, StatCard, Sparkline, BarChart, Ring, Progress, ListRow, Toggle, FabSos, FallOverlay, ChatBubble, WearerRow, PageHeader, ScreenBody, TrendTag, BtnTonal. Use these instead of inlining View+Text everywhere. |
| `src/design/index.ts` | Public exports. Import from `@/design`, never reach into individual files. |
| `src/components/AuthControls.tsx` | `AuthInput`, `AuthSegment`, `AuthIcon` (all inline Lucide SVGs — auth icons + tab-bar icons share one set), `FieldLabel`. Used by auth screens + tab bars. |
| `src/utils/theme.ts` | Paper MD3 override that maps Paper's color/font names onto our tokens so any Paper component (TextInput, Dialog, etc.) picks up the palette automatically. |

## Fonts

- **Sans** (`fontFamily.sans` / `sansMedium` / `sansSemibold`) → **DM Sans** 400/500/600. Body text, labels, button text, list rows.
- **Display** (`fontFamily.display`) → **Newsreader** 400. Big serif numerals on hero/stat cards, screen titles ("Welcome back.", "Let's begin."), Playfair-style emphasis.
- **Mono** (`fontFamily.mono`) → **IBM Plex Mono** Medium 500. Eyebrows ("01 · VITALS", "TODAY · MON 26 MAY"), timestamps, tabular numerals, code-feel labels.

## Accent variants

`tokens.ts` ships four accent palettes — sage (default), amber, slate, rose. Switch globally via `useThemeStore` (currently fixed to sage). Each variant defines `accent`, `accent2`, `accentSoft`, `accentInk` for both light and dark themes.

## Icon set

Use `AuthIcon` for any new icon. Adding a new glyph:

1. Add the name to the `AuthIconName` union in `AuthControls.tsx`.
2. Add a case to the switch with the Lucide SVG path (`stroke-width: 1.7`, color from the `color` prop, 24×24 viewBox).
3. Use anywhere as `<AuthIcon name="…" color={…} size={…} />`.

The existing set covers the auth flow + bottom tabs. For decorative iconography elsewhere (Card prefixes, list-row leading icons) `IconDot` from `components.tsx` accepts MaterialCommunityIcons names because the design uses them as colored glyphs inside soft circles — that's fine.

## Activity history store

`src/stores/activity-history.store.ts` + `src/services/activity-ticker.ts`:

- `rhythm12h[12]` — minutes active per hour 06:00 → 17:00, resets daily
- `daily[30]` — `{ date, steps, activeMin }` rolling
- `todayMix` — minutes today in `walking` / `light` / `resting` (HAR classification: WALKING → walking; UPSTAIRS/DOWNSTAIRS/STANDING → light; rest → resting)

Ticker fires every minute, snapshots `useVitalsStore.currentActivity` + `.steps`. Skips when `lastUpdated` is older than 90 s (prevents stale "Resting" from inflating the bucket while the app sits idle). Started from RootLayout, persists to AsyncStorage under `activity_history.v1`.

## Demo mode

Single toggle in **Settings → Device & preferences**. Stored in `useDeviceStore.demoMode`. On enable:

1. `startMockVitals(profileId)` — 3-second tick of synthetic HR/SpO₂/temp/activity/steps (per-activity step rate: WALKING ≈ 220 spm).
2. `seedDemo()` — pre-populates 30 days of plausible activity history so the Activity tab + Today's-rhythm card render immediately instead of waiting for the per-minute ticker.
3. `useDeviceStore.demoMode = true` — Home tab connection card flips to **Watch connected · Currently · resting · Live** (identical to a real Wear OS pairing).

Disable reverses all three.

## Adding a new screen

1. Wrap in `SafeAreaView` with `backgroundColor: palette.bg`.
2. Render a `PageHeader` (eyebrow + title + optional action) — it handles status-bar safe-area + the comfortable 24 px top gap.
3. Body goes in a `ScreenBody` (handles horizontal padding + bottom scroll padding).
4. Use `Card` for surfaces, `Pill` for badges, `Banner` for inline alerts, `ListRow` for settings-style entries.
5. Strings go through `t()` from `react-i18next` (`src/i18n/{en,ar}.ts`).
6. New colors? Add an oklch literal to the design source first, then re-run coloraide to get the hex. Never hand-tune hex.

## Common pitfalls

- **Don't import from `src/design/components` directly.** Use `@/design` so re-exports stay consistent.
- **Don't pass MaterialCommunityIcons names to `AuthIcon`.** It only accepts the names in `AuthIconName`.
- **Don't add a flat `padding` prop to `Card` when you also want a tinted background.** Use `tint="accent"` or `tint="flat"` — both already handle their own padding.
- **Don't set `fontFamily` as a string literal** (e.g. `'DM Sans'`). Use `fontFamily.sans` from `@/design/tokens` so a future font swap stays in one place.

## See also

- `CLAUDE.md` — full project audit trail, includes the migration history of this design system + everything that's still static decoration vs live.
- `claude-design-output/` — the original Claude Design canvas exports the redesign was based on.
- `more-claude-design-output/{on-boarding,auth,wearer}/` — the per-screen HTML references used for 1:1 pixel matching.
