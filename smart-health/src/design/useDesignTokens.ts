/**
 * Hook for screens/components to read the active design palette.
 *
 * Reads dark-mode from `useThemeStore` (existing Zustand store) and accent
 * variant from a local module-level setting (default 'sage'). The accent
 * is mostly fixed — we keep one accent across the app for brand coherence,
 * but the structure is here in case a future feature lets the user pick.
 */

import { lightPalette, darkPalette, AccentName, ColorPalette } from './tokens';
import { useThemeStore } from '@/stores/theme.store';

const ACTIVE_ACCENT: AccentName = 'sage';

export function useDesignTokens(): { palette: ColorPalette; isDark: boolean } {
  const isDark = useThemeStore(s => s.isDarkMode);
  const palette = isDark ? darkPalette(ACTIVE_ACCENT) : lightPalette(ACTIVE_ACCENT);
  return { palette, isDark };
}
