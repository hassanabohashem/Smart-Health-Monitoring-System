/**
 * Design tokens — ported from claude-design-output/tokens.css.
 *
 * Source uses OKLCH; React Native doesn't support OKLCH at runtime, so each
 * color is precomputed to the nearest hex. The OKLCH values are kept in
 * comments alongside as the source of truth — if you ever need to tweak,
 * update the OKLCH then recompute the hex.
 *
 * Convention: every token has a light and dark value. Components read via
 * `useDesignTokens()` (see `useDesignTokens.ts`) which returns the active
 * palette based on the global theme.
 */

export type AccentName = 'sage' | 'amber' | 'slate' | 'rose';

export interface ColorPalette {
  // Surfaces
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderSoft: string;
  divider: string;

  // Text
  text: string;
  text2: string;
  text3: string;
  textOnAccent: string;
  textOnDanger: string;

  // Accent (changes with accent variant)
  accent: string;
  accent2: string;
  accentSoft: string;
  accentInk: string;

  // Semantic
  success: string;
  successSoft: string;
  successInk: string;

  warning: string;
  warningSoft: string;
  warningInk: string;

  danger: string;
  dangerSoft: string;
  dangerInk: string;

  info: string;
  infoSoft: string;
  infoInk: string;

  // Shadows + scrims
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  scrim: string;
  navBg: string;
}

// ── LIGHT ────────────────────────────────────────────────────────────────
// Hex values below are the exact sRGB-gamut renderings of the design
// source's oklch tokens (re-computed via coloraide, then in-gamut clipped).
// Don't hand-tweak — re-run the conversion script if a token changes.
const lightBase: Omit<ColorPalette, 'accent' | 'accent2' | 'accentSoft' | 'accentInk'> = {
  // Warm paper neutrals
  bg:           '#FCFAF6',  // oklch(0.985 0.005 80)
  surface:      '#FFFFFF',
  surface2:     '#F7F5F1',  // oklch(0.97 0.005 80)
  surface3:     '#EDEBE7',  // oklch(0.94 0.006 80)
  border:       '#E3E1DD',  // oklch(0.91 0.006 80)
  borderSoft:   '#EDEBE7',  // oklch(0.94 0.005 80)
  divider:      '#EAE7E4',  // oklch(0.93 0.005 80)

  text:         '#1D2227',  // oklch(0.25 0.012 240)
  text2:        '#50565B',  // oklch(0.45 0.012 240)
  text3:        '#81878C',  // oklch(0.62 0.010 240)
  textOnAccent: '#FAFCFC',  // oklch(0.99 0.003 180)
  textOnDanger: '#FEFBFB',  // oklch(0.99 0.003 25)

  success:      '#4F7E60',  // oklch(0.55 0.07 155)
  successSoft:  '#E2F4E7',  // oklch(0.95 0.025 155)
  successInk:   '#245337',  // oklch(0.40 0.07 155)

  warning:      '#C78B28',  // oklch(0.68 0.13 75)
  warningSoft:  '#FFF0D7',  // oklch(0.96 0.04 80)
  warningInk:   '#80521F',  // oklch(0.48 0.09 65)

  danger:       '#C74C41',  // oklch(0.58 0.16 28)
  dangerSoft:   '#FFE9E5',  // oklch(0.95 0.035 28)
  dangerInk:    '#903129',  // oklch(0.45 0.13 28)

  info:         '#42789C',  // oklch(0.55 0.08 240)
  infoSoft:     '#DFF1FF',  // oklch(0.95 0.03 240)
  infoInk:      '#144D6E',  // oklch(0.40 0.08 240)

  shadowSm:     'rgba(20, 24, 35, 0.04)',
  shadowMd:     'rgba(20, 24, 35, 0.05)',
  shadowLg:     'rgba(20, 24, 35, 0.08)',
  scrim:        'rgba(20, 24, 35, 0.40)',
  navBg:        'rgba(255, 255, 255, 0.85)',
};

const lightAccents: Record<AccentName, Pick<ColorPalette, 'accent' | 'accent2' | 'accentSoft' | 'accentInk'>> = {
  sage: {
    accent:     '#4C7C73',  // oklch(0.55 0.055 180)
    accent2:    '#1D6257',  // oklch(0.45 0.07 180)
    accentSoft: '#DAF1EC',  // oklch(0.94 0.025 180)
    accentInk:  '#07453C',  // oklch(0.35 0.06 180)
  },
  amber: {
    accent:     '#B6753B',  // oklch(0.62 0.11 60)
    accent2:    '#964D09',  // oklch(0.5 0.12 55)
    accentSoft: '#FFEBD5',  // oklch(0.95 0.04 70)
    accentInk:  '#753B07',  // oklch(0.42 0.1 55)
  },
  slate: {
    accent:     '#3C4F62',  // oklch(0.42 0.04 250)
    accent2:    '#233447',  // oklch(0.32 0.04 250)
    accentSoft: '#E2E9F0',  // oklch(0.93 0.012 250)
    accentInk:  '#233447',  // oklch(0.32 0.04 250)
  },
  rose: {
    accent:     '#AD6C66',  // oklch(0.6 0.085 25)
    accent2:    '#904D49',  // oklch(0.5 0.09 25)
    accentSoft: '#FFE9E6',  // oklch(0.95 0.025 25)
    accentInk:  '#753935',  // oklch(0.42 0.085 25)
  },
};

// ── DARK ─────────────────────────────────────────────────────────────────
const darkBase: Omit<ColorPalette, 'accent' | 'accent2' | 'accentSoft' | 'accentInk'> = {
  bg:           '#0C1013',  // oklch(0.17 0.008 240)
  surface:      '#15191C',  // oklch(0.21 0.008 240)
  surface2:     '#1C2023',  // oklch(0.24 0.008 240)
  surface3:     '#25292C',  // oklch(0.28 0.008 240)
  border:       '#2F3337',  // oklch(0.32 0.008 240)
  borderSoft:   '#25292C',  // oklch(0.28 0.008 240)
  divider:      '#23272A',  // oklch(0.27 0.008 240)

  text:         '#EDEBE7',  // oklch(0.94 0.006 80)
  text2:        '#A6ACAF',  // oklch(0.74 0.008 240)
  text3:        '#757B80',  // oklch(0.58 0.010 240)
  textOnAccent: '#080F0D',  // oklch(0.16 0.012 180)
  textOnDanger: '#FEFBFB',  // oklch(0.99 0.003 25)

  success:      '#75B68C',  // oklch(0.72 0.09 155)
  successSoft:  '#1F3326',  // oklch(0.3 0.035 155)
  successInk:   '#9BD4AE',  // oklch(0.82 0.08 155)

  warning:      '#E4AC59',  // oklch(0.78 0.12 75)
  warningSoft:  '#3E290F',  // oklch(0.3 0.05 70)
  warningInk:   '#FCC270',  // oklch(0.85 0.12 75)

  danger:       '#E66F62',  // oklch(0.68 0.15 28)
  dangerSoft:   '#47211C',  // oklch(0.3 0.06 28)
  dangerInk:    '#FFABA0',  // oklch(0.82 0.13 28)

  info:         '#6FA5CB',  // oklch(0.7 0.08 240)
  infoSoft:     '#1A3040',  // oklch(0.3 0.04 240)
  infoInk:      '#94CCF3',  // oklch(0.82 0.08 240)

  shadowSm:     'rgba(0, 0, 0, 0.30)',
  shadowMd:     'rgba(0, 0, 0, 0.35)',
  shadowLg:     'rgba(0, 0, 0, 0.45)',
  scrim:        'rgba(0, 0, 0, 0.55)',
  navBg:        'rgba(28, 32, 42, 0.85)',
};

const darkAccents: Record<AccentName, Pick<ColorPalette, 'accent' | 'accent2' | 'accentSoft' | 'accentInk'>> = {
  sage: {
    accent:     '#74BBAC',  // oklch(0.74 0.075 180)
    accent2:    '#8DD5C6',  // oklch(0.82 0.075 180)
    accentSoft: '#18342E',  // oklch(0.3 0.035 180)
    accentInk:  '#93DBCC',  // oklch(0.84 0.075 180)
  },
  amber: {
    accent:     '#E8A869',  // oklch(0.78 0.11 65)
    accent2:    '#FFBF80',  // oklch(0.85 0.11 65)
    accentSoft: '#402712',  // oklch(0.3 0.05 60)
    accentInk:  '#FFBF80',  // oklch(0.85 0.11 65)
  },
  slate: {
    accent:     '#A5BAD1',  // oklch(0.78 0.04 250)
    accent2:    '#BED4EB',  // oklch(0.86 0.04 250)
    accentSoft: '#282F35',  // oklch(0.3 0.015 250)
    accentInk:  '#BBD0E8',  // oklch(0.85 0.04 250)
  },
  rose: {
    accent:     '#E29C96',  // oklch(0.76 0.085 25)
    accent2:    '#FDB5AF',  // oklch(0.84 0.085 25)
    accentSoft: '#402624',  // oklch(0.3 0.04 25)
    accentInk:  '#FDB5AF',  // oklch(0.84 0.085 25)
  },
};

export function lightPalette(accent: AccentName = 'sage'): ColorPalette {
  return { ...lightBase, ...lightAccents[accent] };
}

export function darkPalette(accent: AccentName = 'sage'): ColorPalette {
  return { ...darkBase, ...darkAccents[accent] };
}

// ── Spacing / radius / typography roles ──────────────────────────────────

export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s7: 32,
  s8: 40,
} as const;

export const radius = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/**
 * Font family names. These match the names exposed by expo-font.loadAsync()
 * in `src/design/fonts.ts`. Use these constants in StyleSheet rather than
 * raw strings so renames stay in sync.
 *
 * Fallback behaviour: if a font hasn't loaded yet (or fails to load) RN
 * silently falls back to the system default — looks acceptable on Android,
 * close enough to design intent.
 */
export const fontFamily = {
  sans: 'DMSans',
  sansMedium: 'DMSans-Medium',
  sansSemibold: 'DMSans-Semibold',
  display: 'Newsreader',
  // IBM Plex Mono carries all monospace labels (eyebrows, timestamps,
  // coordinates, tabular numerals in detail rows). Medium weight matches
  // the eyebrow CSS in the design source (font-weight 500).
  mono: 'IBMPlexMono-Medium',
} as const;

/**
 * Typography roles ported from CSS classes. Use via `Text style={typeRoles.eyebrow}`
 * or via paper-theme variant overrides.
 */
export const typeRoles = {
  eyebrow: {
    fontFamily: fontFamily.mono,
    fontSize: 10,
    fontWeight: '500' as const,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
  sectionTitle: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 14,
    fontWeight: '600' as const,
    letterSpacing: -0.07,
  },
  bodyM: {
    fontFamily: fontFamily.sans,
    fontSize: 14,
    fontWeight: '400' as const,
  },
  bodyS: {
    fontFamily: fontFamily.sans,
    fontSize: 12,
    fontWeight: '400' as const,
  },
  caption: {
    fontFamily: fontFamily.mono,
    fontSize: 11,
    fontWeight: '400' as const,
  },
  headline: {
    fontFamily: fontFamily.sansSemibold,
    fontSize: 22,
    fontWeight: '600' as const,
    letterSpacing: -0.44,
  },
  displaySerif: {
    fontFamily: fontFamily.display,
    fontWeight: '400' as const,
    letterSpacing: -0.7,
  },
  bigSerifNum: {
    fontFamily: fontFamily.display,
    fontSize: 76,
    lineHeight: 76,
    letterSpacing: -3,
    fontWeight: '400' as const,
  },
  statValue: {
    fontFamily: fontFamily.display,
    fontSize: 38,
    lineHeight: 38,
    letterSpacing: -1,
    fontWeight: '400' as const,
  },
} as const;
