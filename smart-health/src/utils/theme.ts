/**
 * react-native-paper theme — backed by the Claude-Design tokens.
 *
 * Paper's MD3 theme shape is preserved (so existing Paper components keep
 * working without rewrites) but every color and font is replaced with
 * tokens from `src/design/tokens.ts`. Custom screen code should prefer
 * `useDesignTokens()` for direct access; this theme is for Paper's
 * built-in components (Surface, Button, TextInput, Dialog, etc.).
 */

import { MD3LightTheme, MD3DarkTheme, configureFonts } from 'react-native-paper';
import { lightPalette, darkPalette, fontFamily } from '@/design/tokens';

const fontConfig = {
  default: { fontFamily: fontFamily.sans, fontWeight: '400' as const, letterSpacing: 0 },
  displayLarge: { fontFamily: fontFamily.display, fontWeight: '400' as const, fontSize: 57, lineHeight: 64, letterSpacing: -0.25 },
  displayMedium: { fontFamily: fontFamily.display, fontWeight: '400' as const, fontSize: 45, lineHeight: 52, letterSpacing: 0 },
  displaySmall: { fontFamily: fontFamily.display, fontWeight: '400' as const, fontSize: 36, lineHeight: 44, letterSpacing: 0 },
  headlineLarge: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' as const, fontSize: 32, lineHeight: 40, letterSpacing: 0 },
  headlineMedium: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' as const, fontSize: 28, lineHeight: 36, letterSpacing: 0 },
  headlineSmall: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' as const, fontSize: 22, lineHeight: 28, letterSpacing: 0 },
  titleLarge: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' as const, fontSize: 18, lineHeight: 26, letterSpacing: 0 },
  titleMedium: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' as const, fontSize: 14, lineHeight: 20, letterSpacing: 0.15 },
  titleSmall: { fontFamily: fontFamily.sansMedium, fontWeight: '500' as const, fontSize: 13, lineHeight: 18, letterSpacing: 0.1 },
  labelLarge: { fontFamily: fontFamily.sansMedium, fontWeight: '500' as const, fontSize: 14, lineHeight: 18, letterSpacing: 0 },
  labelMedium: { fontFamily: fontFamily.sansMedium, fontWeight: '500' as const, fontSize: 12, lineHeight: 16, letterSpacing: 0.5 },
  labelSmall: { fontFamily: fontFamily.sansMedium, fontWeight: '500' as const, fontSize: 11, lineHeight: 16, letterSpacing: 0.5 },
  bodyLarge: { fontFamily: fontFamily.sans, fontWeight: '400' as const, fontSize: 16, lineHeight: 24, letterSpacing: 0 },
  bodyMedium: { fontFamily: fontFamily.sans, fontWeight: '400' as const, fontSize: 14, lineHeight: 20, letterSpacing: 0 },
  bodySmall: { fontFamily: fontFamily.sans, fontWeight: '400' as const, fontSize: 12, lineHeight: 16, letterSpacing: 0 },
};

const light = lightPalette('sage');
const dark = darkPalette('sage');

/** Map design tokens → Paper's MD3 color names so legacy components work. */
function paperColors(p: ReturnType<typeof lightPalette>, base: typeof MD3LightTheme.colors) {
  return {
    ...base,
    primary: p.accent2,
    onPrimary: p.textOnAccent,
    primaryContainer: p.accentSoft,
    onPrimaryContainer: p.accentInk,

    secondary: p.accent,
    onSecondary: p.textOnAccent,
    secondaryContainer: p.accentSoft,
    onSecondaryContainer: p.accentInk,

    tertiary: p.info,
    onTertiary: p.textOnAccent,
    tertiaryContainer: p.infoSoft,
    onTertiaryContainer: p.infoInk,

    error: p.danger,
    onError: p.textOnDanger,
    errorContainer: p.dangerSoft,
    onErrorContainer: p.dangerInk,

    background: p.bg,
    onBackground: p.text,
    surface: p.surface,
    onSurface: p.text,
    surfaceVariant: p.surface2,
    onSurfaceVariant: p.text2,

    outline: p.border,
    outlineVariant: p.borderSoft,

    inverseSurface: p.text,
    inverseOnSurface: p.bg,
    inversePrimary: p.accent,

    scrim: p.scrim,
    shadow: p.shadowMd,
    backdrop: p.scrim,
  };
}

export const lightTheme = {
  ...MD3LightTheme,
  fonts: configureFonts({ config: fontConfig }),
  colors: paperColors(light, MD3LightTheme.colors),
};

export const darkTheme = {
  ...MD3DarkTheme,
  fonts: configureFonts({ config: fontConfig }),
  colors: paperColors(dark, MD3DarkTheme.colors),
};
