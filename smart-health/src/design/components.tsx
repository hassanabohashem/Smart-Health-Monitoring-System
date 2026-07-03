/**
 * Design-system primitives ported from claude-design-output.
 *
 * Each component is a thin React Native wrapper around the equivalent
 * web CSS class set. All components consume tokens via `useDesignTokens()`
 * so they react to light/dark mode without prop drilling.
 *
 * Naming convention mirrors the CSS class names from the source:
 *   .card           → <Card>
 *   .hero-vital     → <HeroVital>
 *   .stat-card      → <StatCard>
 *   .banner         → <Banner variant="success|accent|warning|danger" />
 *   .pill           → <Pill variant="..." />
 *   .icon-dot       → <IconDot variant="accent|danger|success" />
 *   .eyebrow        → <Eyebrow />
 *   .list-row       → <ListRow />
 *   .fab-sos        → <FabSos />
 *   .fall-overlay   → <FallOverlay />
 *   .bubble*        → <ChatBubble side="user|assistant" />
 *   .wearer-row     → <WearerRow />
 *   .toggle         → <Toggle />
 *   .progress       → <Progress value={0..1} />
 */

import React from 'react';
import {
  View, Text, Pressable, StyleSheet, ViewStyle, TextStyle, ScrollView,
  Animated,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import Svg, { Circle as SvgCircle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Snackbar } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useDesignTokens } from './useDesignTokens';
import { radius, spacing, fontFamily, typeRoles, ColorPalette } from './tokens';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

// ── Eyebrow / Section title ─────────────────────────────────────────────

export function Eyebrow({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const { palette } = useDesignTokens();
  return (
    <Text style={[typeRoles.eyebrow, { color: palette.text3 }, style]}>
      {children}
    </Text>
  );
}

export function SectionTitle({ children, style }: { children: React.ReactNode; style?: TextStyle }) {
  const { palette } = useDesignTokens();
  return (
    <Text style={[typeRoles.sectionTitle, { color: palette.text }, style]}>
      {children}
    </Text>
  );
}

// ── Card / Banner ───────────────────────────────────────────────────────

export function Card({
  children, style, padding = spacing.s4, tint, onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
  padding?: number;
  tint?: 'flat' | 'accent';
  onPress?: () => void;
}) {
  const { palette } = useDesignTokens();
  const base: ViewStyle = tint === 'flat'
    ? { backgroundColor: palette.surface2, borderRadius: radius.md, padding }
    : tint === 'accent'
    ? { backgroundColor: palette.accentSoft, borderRadius: radius.md, padding }
    : {
        backgroundColor: palette.surface,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: palette.borderSoft,
        padding,
        shadowColor: palette.shadowSm,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 1,
        shadowRadius: 2,
        elevation: 1,
      };
  const Wrap = onPress ? Pressable : View;
  return <Wrap onPress={onPress} style={[base, style]}>{children}</Wrap>;
}

type BannerVariant = 'default' | 'success' | 'accent' | 'warning' | 'danger' | 'info';

function bannerColors(p: ColorPalette, v: BannerVariant): { bg: string; fg: string; iconFg: string } {
  switch (v) {
    case 'success': return { bg: p.successSoft, fg: p.successInk, iconFg: p.successInk };
    case 'accent':  return { bg: p.accentSoft, fg: p.accentInk, iconFg: p.accentInk };
    case 'warning': return { bg: p.warningSoft, fg: p.warningInk, iconFg: p.warningInk };
    case 'danger':  return { bg: p.dangerSoft, fg: p.dangerInk, iconFg: p.dangerInk };
    case 'info':    return { bg: p.infoSoft, fg: p.infoInk, iconFg: p.infoInk };
    default:        return { bg: p.surface2, fg: p.text2, iconFg: p.text3 };
  }
}

export function Banner({
  icon, iconNode, children, variant = 'default', style, right,
}: {
  /** MaterialCommunityIcons name. Falls back to this when `iconNode`
   *  isn't supplied. */
  icon?: IconName;
  /** Pre-rendered icon node — use this for custom SVG icons (e.g.
   *  AuthIcon) that you want to compose into the banner instead of
   *  the default MCI lookup. Takes precedence over `icon`. */
  iconNode?: React.ReactNode;
  children?: React.ReactNode;
  variant?: BannerVariant;
  style?: ViewStyle;
  right?: React.ReactNode;
}) {
  const { palette } = useDesignTokens();
  const c = bannerColors(palette, variant);
  const leadingIcon = iconNode
    ?? (icon ? <MaterialCommunityIcons name={icon} size={18} color={c.iconFg} /> : null);
  return (
    <View style={[{
      backgroundColor: c.bg,
      borderRadius: radius.md,
      paddingHorizontal: spacing.s4,
      paddingVertical: spacing.s3,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.s3,
    }, style]}>
      {leadingIcon}
      <View style={{ flex: 1 }}>
        {typeof children === 'string'
          ? <Text style={[typeRoles.bodyS, { color: c.fg, fontSize: 13 }]}>{children}</Text>
          : children}
      </View>
      {right}
    </View>
  );
}

// ── Pill ────────────────────────────────────────────────────────────────

export function Pill({
  children, variant = 'default', dot, style,
}: {
  children: React.ReactNode;
  variant?: BannerVariant;
  dot?: boolean;
  style?: ViewStyle;
}) {
  const { palette } = useDesignTokens();
  const c = bannerColors(palette, variant);
  return (
    <View style={[{
      flexDirection: 'row', alignItems: 'center', gap: 6,
      height: 24, paddingHorizontal: 10,
      borderRadius: radius.pill,
      backgroundColor: c.bg,
      alignSelf: 'flex-start',
    }, style]}>
      {dot ? <View style={{ width: 6, height: 6, borderRadius: 999, backgroundColor: c.fg }} /> : null}
      <Text style={{
        fontFamily: fontFamily.sansMedium,
        fontSize: 11.5,
        fontWeight: '500',
        color: c.fg,
      }}>{children}</Text>
    </View>
  );
}

// ── IconDot (small circle behind an icon) ───────────────────────────────

export function IconDot({
  icon, iconNode, size = 28, variant = 'default',
}: {
  /** MaterialCommunityIcons name — fallback when no `iconNode` provided. */
  icon?: IconName;
  /** Pre-rendered icon node — use for Lucide-style AuthIcon glyphs that
   *  match the design source. Takes precedence over `icon`. The renderer
   *  is responsible for color + size, so callers usually do
   *  `<AuthIcon name="heart" color={palette.dangerInk} size={…} />`. */
  iconNode?: React.ReactNode;
  size?: number;
  variant?: BannerVariant;
}) {
  const { palette } = useDesignTokens();
  const c = bannerColors(palette, variant);
  return (
    <View style={{
      width: size, height: size,
      borderRadius: 999,
      backgroundColor: c.bg,
      alignItems: 'center', justifyContent: 'center',
    }}>
      {iconNode ?? (icon ? (
        <MaterialCommunityIcons name={icon} size={Math.round(size * 0.55)} color={c.fg} />
      ) : null)}
    </View>
  );
}

// ── Empty state (icon tile + title + copy + optional action) ────────────
// One shared primitive for every "nothing here" card across the app
// (No Links, No Safe Zones, Live Location Map, Care empty, Alerts
// empty). Title is DM Sans semibold 16px — the wearer convention, now
// the single app-wide standard. Caller decides whether to wrap it in a
// <Card> (list-empty states) or center it in the viewport (Alerts).

export function EmptyState({
  icon, iconNode, iconVariant = 'default', title, description, action,
}: {
  /** MaterialCommunityIcons name — fallback when no `iconNode`. */
  icon?: IconName;
  /** Pre-rendered Lucide-style `<AuthIcon>` node (takes precedence). */
  iconNode?: React.ReactNode;
  iconVariant?: BannerVariant;
  title: string;
  description?: string;
  /** Optional CTA rendered below the copy (e.g. a pill button). */
  action?: React.ReactNode;
}) {
  const { palette } = useDesignTokens();
  return (
    <View style={{ alignItems: 'center' }}>
      <IconDot icon={icon} iconNode={iconNode} variant={iconVariant} size={56} />
      <Text style={{
        fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 16,
        color: palette.text, textAlign: 'center', marginTop: 16,
      }}>
        {title}
      </Text>
      {description ? (
        <Text style={{
          fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2,
          textAlign: 'center', marginTop: 8, maxWidth: 280, lineHeight: 19,
        }}>
          {description}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 18 }}>{action}</View> : null}
    </View>
  );
}

// ── Hero vital (big number + sparkline + trend) ─────────────────────────

export function HeroVital({
  label, value, unit, statusPill, trendText, sparkline, icon = 'heart-pulse',
}: {
  label: string;
  value: string | number;
  unit?: string;
  statusPill?: { text: string; variant: BannerVariant };
  trendText?: string;
  sparkline?: React.ReactNode;
  icon?: IconName;
}) {
  const { palette } = useDesignTokens();
  return (
    <View style={{
      backgroundColor: palette.surface,
      borderWidth: 1,
      borderColor: palette.borderSoft,
      borderRadius: radius.lg,
      padding: spacing.s5,
      paddingBottom: 22,
      gap: 6,
      shadowColor: palette.shadowSm,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 1,
      shadowRadius: 2,
      elevation: 1,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.s2 }}>
          <IconDot icon={icon} variant="accent" size={28} />
          <Text style={{ fontSize: 12, fontWeight: '500', color: palette.text2, letterSpacing: -0.07 }}>
            {label}
          </Text>
        </View>
        {statusPill ? <Pill variant={statusPill.variant} dot>{statusPill.text}</Pill> : null}
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 2 }}>
        <Text style={{
          fontFamily: fontFamily.display,
          fontSize: 76,
          lineHeight: 76,
          letterSpacing: -3,
          color: palette.text,
        }}>{value}</Text>
        {unit ? <Text style={{ fontFamily: fontFamily.mono, fontSize: 13, color: palette.text3, marginLeft: 6 }}>{unit}</Text> : null}
        {trendText ? <Text style={{
          marginLeft: 'auto',
          fontFamily: fontFamily.mono,
          fontSize: 11,
          color: palette.text2,
        }}>{trendText}</Text> : null}
      </View>
      {sparkline}
    </View>
  );
}

// ── Stat card (small grid tile) ─────────────────────────────────────────

export function StatCard({
  label, value, unit, foot, icon, iconVariant = 'accent',
  valueFontSize = 38, valueLineHeight, topRight, style, onPress, linkLabel,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  foot?: string;
  icon?: IconName;
  iconVariant?: BannerVariant;
  valueFontSize?: number;
  /** Override the line height of the value row so tiles with smaller
   *  value fonts (e.g. a categorical "Irregular" label) still match
   *  the row height of tiles with full-size numeric values. Defaults
   *  to `valueFontSize` (i.e. the text dictates the row height). */
  valueLineHeight?: number;
  /** Optional node rendered absolutely in the top-right corner —
   *  used for on-demand "tap to retake" affordances on SpO₂ / ECG
   *  tiles. Card body padding stays the same; the badge sits just
   *  inside the corner. */
  topRight?: React.ReactNode;
  style?: ViewStyle;
  /** When provided the whole tile becomes pressable (used for the
   *  caregiver's "tap a vital to open its trend" affordance). */
  onPress?: () => void;
  /** Optional accent link row at the bottom (e.g. "View trend") with a
   *  trailing chevron — a clear "this opens a detail view" cue. */
  linkLabel?: string;
}) {
  const { palette } = useDesignTokens();
  const base: ViewStyle = {
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.borderSoft,
    borderRadius: radius.md,
    padding: 14,
    gap: 4,
    shadowColor: palette.shadowSm,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 1,
    shadowRadius: 2,
    elevation: 1,
    flex: 1,
    minWidth: 0,
    position: 'relative',
  };
  const inner = (
    <>
      {topRight
        ? <View style={{ position: 'absolute', top: 10, right: 10 }}>{topRight}</View>
        : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {icon ? <IconDot icon={icon} variant={iconVariant} size={22} /> : null}
        <Text style={{ fontSize: 12, color: palette.text2, fontWeight: '500' }}>{label}</Text>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', marginTop: 2 }}>
        <Text style={{
          fontFamily: fontFamily.display,
          fontSize: valueFontSize,
          lineHeight: valueLineHeight ?? valueFontSize,
          letterSpacing: -1,
          color: palette.text,
        }}>{value}</Text>
        {unit ? <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginLeft: 4 }}>{unit}</Text> : null}
      </View>
      {foot ? <Text style={{ fontSize: 11, color: palette.text3, marginTop: 2 }}>{foot}</Text> : null}
      {linkLabel ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1, marginTop: 7 }}>
          <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 11.5, color: palette.accentInk }}>{linkLabel}</Text>
          <MaterialCommunityIcons name="chevron-right" size={14} color={palette.accentInk} />
        </View>
      ) : null}
    </>
  );
  if (onPress) {
    return (
      <Pressable onPress={onPress} style={({ pressed }) => [base, style as ViewStyle, { opacity: pressed ? 0.7 : 1 }]}>
        {inner}
      </Pressable>
    );
  }
  return <View style={[base, style]}>{inner}</View>;
}

// ── Sparkline (mini area chart) ─────────────────────────────────────────

export function Sparkline({ data, height = 36, color }: { data: number[]; height?: number; color?: string }) {
  const { palette } = useDesignTokens();
  const stroke = color ?? palette.accent;
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  // Render as a row of vertical bars (no SVG dep for ultra-simple sparkline)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap: 1, opacity: 0.85 }}>
      {data.map((v, i) => {
        const h = ((v - min) / range) * height * 0.85 + height * 0.15;
        return (
          <View key={i} style={{
            flex: 1, height: h, backgroundColor: stroke, opacity: 0.6,
            borderRadius: 1.5,
          }} />
        );
      })}
    </View>
  );
}

// ── BarChart (slightly bigger) ──────────────────────────────────────────

export function BarChart({
  data, labels, height = 86, color, max: maxOverride, highlightIndex, gap = 4,
}: {
  data: number[]; labels?: string[]; height?: number; color?: string;
  /** Pin the y-axis ceiling explicitly (else uses max of data). */
  max?: number;
  /** Render this index in the deeper accent-2 (the rest sit in accent-soft). */
  highlightIndex?: number;
  /** Pixel gap between bars. Default 4; drop to 2 for dense (30-bar) ranges. */
  gap?: number;
}) {
  const { palette } = useDesignTokens();
  const fill = color ?? palette.accentSoft;
  const max = maxOverride ?? Math.max(...data, 1);
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height, gap }}>
        {data.map((v, i) => {
          const h = (v / max) * height * 0.95 + 2;
          const isHi = i === highlightIndex;
          return (
            <View key={i} style={{
              flex: 1, height: h,
              backgroundColor: isHi ? palette.accent2 : fill,
              borderRadius: 4,
            }} />
          );
        })}
      </View>
      {labels ? (
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
          {labels.map((l, i) => (
            <Text key={i} style={{
              fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
              flex: 1, textAlign: 'center',
            }}>{l}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// ── Ring (donut) ───────────────────────────────────────────────────────

export function Ring({
  size = 92, stroke = 11, value, color, trackColor, children,
}: {
  size?: number;
  stroke?: number;
  value: number; /* 0..1 */
  color?: string;
  trackColor?: string;
  children?: React.ReactNode;
}) {
  const { palette } = useDesignTokens();
  const c = color ?? palette.accent2;
  const tc = trackColor ?? palette.surface3;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dashLen = Math.max(0, Math.min(1, value)) * circ;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute', transform: [{ rotate: '-90deg' }] }}>
        <SvgCircle cx={size / 2} cy={size / 2} r={r} stroke={tc} strokeWidth={stroke} fill="none" />
        <SvgCircle
          cx={size / 2} cy={size / 2} r={r}
          stroke={c} strokeWidth={stroke} fill="none"
          strokeLinecap="round"
          strokeDasharray={`${dashLen} ${circ}`}
        />
      </Svg>
      {children}
    </View>
  );
}

// ── Progress bar ────────────────────────────────────────────────────────

export function Progress({ value }: { value: number /* 0..1 */ }) {
  const { palette } = useDesignTokens();
  return (
    <View style={{
      height: 8,
      backgroundColor: palette.surface3,
      borderRadius: 999,
      overflow: 'hidden',
    }}>
      <View style={{
        height: '100%',
        width: `${Math.max(0, Math.min(1, value)) * 100}%`,
        backgroundColor: palette.accent2,
        borderRadius: 999,
      }} />
    </View>
  );
}

// ── List row (settings / contacts) ──────────────────────────────────────

export function ListRow({
  icon, iconNode, iconVariant = 'default', label, sub, right, onPress,
  chevronNode,
}: {
  /** MaterialCommunityIcons name — fallback when no `iconNode`. */
  icon?: IconName;
  /** Pre-rendered icon node — use to inject Lucide-style AuthIcon
   *  glyphs matching the design source. Takes precedence over `icon`.
   *  Caller is responsible for color/size. */
  iconNode?: React.ReactNode;
  iconVariant?: BannerVariant;
  label: string;
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
  /** Override the default chevron-right shown on navigable rows. Use
   *  to pass a Lucide AuthIcon chevron instead of the MCI fallback. */
  chevronNode?: React.ReactNode;
}) {
  const { palette } = useDesignTokens();
  const c = bannerColors(palette, iconVariant);
  const Wrap = onPress ? Pressable : View;
  return (
    <Wrap onPress={onPress} style={{
      flexDirection: 'row', alignItems: 'center', gap: 14,
      paddingVertical: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: palette.divider,
    }}>
      {(iconNode || icon) ? (
        <View style={{
          width: 36, height: 36, borderRadius: 10,
          backgroundColor: c.bg,
          alignItems: 'center', justifyContent: 'center',
        }}>
          {iconNode ?? (icon ? (
            <MaterialCommunityIcons name={icon} size={18} color={c.fg} />
          ) : null)}
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 14, fontWeight: '500', color: palette.text, fontFamily: fontFamily.sansMedium }}>{label}</Text>
        {sub ? <Text style={{ fontSize: 12, color: palette.text3, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {right ?? (onPress ? (
        chevronNode ?? <MaterialCommunityIcons name="chevron-right" size={18} color={palette.text3} />
      ) : null)}
    </Wrap>
  );
}

// ── iOS-style toggle ────────────────────────────────────────────────────

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const { palette } = useDesignTokens();
  return (
    <Pressable onPress={() => onChange(!value)} style={{
      width: 42, height: 26, borderRadius: 999,
      backgroundColor: value ? palette.accent2 : palette.surface3,
      padding: 2,
    }}>
      <View style={{
        width: 22, height: 22, borderRadius: 999,
        backgroundColor: '#FFFFFF',
        transform: [{ translateX: value ? 16 : 0 }],
        shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 2,
        elevation: 1,
      }} />
    </Pressable>
  );
}

// ── Floating SOS button ─────────────────────────────────────────────────

export function FabSos({ onPress, label = 'SOS' }: { onPress?: () => void; label?: string }) {
  const { palette } = useDesignTokens();
  // Circular emergency button — a round red disc with bold "SOS", the
  // instantly-recognizable shape. Scales slightly on press for tactility.
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({
      position: 'absolute', right: 16, bottom: 24,
      width: 68, height: 68,
      borderRadius: 999,
      backgroundColor: palette.danger,
      alignItems: 'center', justifyContent: 'center',
      shadowColor: palette.danger, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.38, shadowRadius: 24,
      elevation: 8,
      transform: [{ scale: pressed ? 0.94 : 1 }],
    })}>
      <Text style={{
        color: palette.textOnDanger,
        fontWeight: '700', fontSize: 17,
        letterSpacing: 1,
        fontFamily: fontFamily.sansSemibold,
      }}>{label}</Text>
    </Pressable>
  );
}

// ── Full-screen fall overlay ────────────────────────────────────────────

export function FallOverlay({
  countdownSeconds, onCancel, onCallNow,
}: { countdownSeconds: number; onCancel?: () => void; onCallNow?: () => void }) {
  const { palette } = useDesignTokens();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  return (
    <View style={{
      position: 'absolute', inset: 0 as unknown as number, top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: palette.danger,
      // Top respects the safe-area inset + matches PageHeader's
      // breathing room (insets.top + 24) so the "FALL DETECTED"
      // chip clears the notch / status bar the same way every
      // tab's eyebrow does. Bottom keeps a generous floor so the
      // "I'm okay" button doesn't sit on the home indicator.
      paddingTop: insets.top + 24,
      paddingBottom: Math.max(insets.bottom + 16, 28),
      paddingHorizontal: 28,
      zIndex: 10,
      flexDirection: 'column',
    }}>
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
        <View style={{
          backgroundColor: 'rgba(255,255,255,0.18)',
          borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
        }}>
          <Text style={{
            fontFamily: fontFamily.mono, fontSize: 10.5, letterSpacing: 1.5,
            color: '#FFFFFF',
          }}>{t('fallOverlay.badge')}</Text>
        </View>
      </View>
      <Text style={{
        fontFamily: fontFamily.display, fontSize: 32, lineHeight: 36, color: '#FFFFFF',
        marginTop: 8, marginBottom: 4, fontWeight: '400',
      }}>{t('fallOverlay.callingIn')}</Text>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{
          fontFamily: fontFamily.display, fontSize: 220, lineHeight: 220,
          letterSpacing: -8, color: '#FFFFFF',
        }}>{countdownSeconds}</Text>
      </View>
      <Text style={{
        color: '#FFFFFF', opacity: 0.85, fontSize: 14, marginBottom: 18, textAlign: 'left',
      }}>{t('fallOverlay.tapToCancel')}</Text>
      <View style={{ gap: 10 }}>
        <Pressable onPress={onCancel} style={{
          backgroundColor: '#FFFFFF',
          height: 52, borderRadius: radius.md,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ color: palette.dangerInk, fontWeight: '600', fontSize: 15, fontFamily: fontFamily.sansSemibold }}>{t('fallOverlay.imOkay')}</Text>
        </Pressable>
        {onCallNow ? (
          <Pressable onPress={onCallNow} style={{
            backgroundColor: 'rgba(0,0,0,0.25)',
            height: 52, borderRadius: radius.md,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 15, fontFamily: fontFamily.sansSemibold }}>{t('fallOverlay.callNow')}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// ── Chat bubble ─────────────────────────────────────────────────────────

export function ChatBubble({
  children, side = 'assistant',
}: { children: React.ReactNode; side?: 'user' | 'assistant' }) {
  const { palette } = useDesignTokens();
  const isUser = side === 'user';
  return (
    <View style={{
      maxWidth: '80%',
      paddingHorizontal: 14, paddingVertical: 10,
      borderRadius: 18,
      backgroundColor: isUser ? palette.accent2 : palette.surface,
      borderWidth: isUser ? 0 : 1,
      borderColor: palette.borderSoft,
      borderBottomLeftRadius: isUser ? 18 : 6,
      borderBottomRightRadius: isUser ? 6 : 18,
      alignSelf: isUser ? 'flex-end' : 'flex-start',
    }}>
      <Text style={{
        fontSize: 13, lineHeight: 19,
        color: isUser ? palette.textOnAccent : palette.text,
        fontFamily: fontFamily.sans,
      }}>{children}</Text>
    </View>
  );
}

// ── Wearer row (caregiver dashboard) ────────────────────────────────────

export function WearerRow({
  initial, name, status, sub, right, onPress,
}: {
  initial: string;
  name: string;
  status?: { text: string; variant: BannerVariant };
  sub?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const { palette } = useDesignTokens();
  const Wrap = onPress ? Pressable : View;
  return (
    <Wrap onPress={onPress} style={{
      backgroundColor: palette.surface,
      borderWidth: 1, borderColor: palette.borderSoft,
      borderRadius: radius.md,
      padding: 14,
      flexDirection: 'row', alignItems: 'center', gap: 12,
      shadowColor: palette.shadowSm, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 1, shadowRadius: 2,
      elevation: 1,
    }}>
      <View style={{
        width: 44, height: 44, borderRadius: 999,
        backgroundColor: palette.accentSoft,
        alignItems: 'center', justifyContent: 'center',
      }}>
        <Text style={{
          fontFamily: fontFamily.display, fontSize: 18, color: palette.accentInk,
        }}>{initial}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 15, fontWeight: '600', color: palette.text, fontFamily: fontFamily.sansSemibold }}>{name}</Text>
          {status ? <Pill variant={status.variant} dot>{status.text}</Pill> : null}
        </View>
        {sub ? <Text style={{ fontSize: 12, color: palette.text3, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {right ?? <MaterialCommunityIcons name="chevron-right" size={18} color={palette.text3} />}
    </Wrap>
  );
}

// ── Page header ─────────────────────────────────────────────────────────

export function PageHeader({
  eyebrow, title, action,
}: { eyebrow?: string; title: string; action?: React.ReactNode }) {
  const { palette } = useDesignTokens();
  const insets = useSafeAreaInsets();
  return (
    <View style={{
      paddingHorizontal: 20,
      // Small breathing room under the status bar — consistent across
      // every screen that uses PageHeader (Today / Activity / Assistant
      // / Settings on wearer + caregiver, plus the shared header rows).
      paddingTop: insets.top + 24,
      paddingBottom: 14,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    }}>
      <View style={{ flex: 1 }}>
        {eyebrow ? <Eyebrow style={{ marginBottom: 2 }}>{eyebrow}</Eyebrow> : null}
        <Text style={{
          fontFamily: fontFamily.sansSemibold,
          fontSize: 22, fontWeight: '600',
          letterSpacing: -0.44,
          color: palette.text,
        }}>{title}</Text>
      </View>
      {action}
    </View>
  );
}

// ── Screen body (scroll + padding) ──────────────────────────────────────

export function ScreenBody({
  children, gap = spacing.s4, paddingHorizontal = 20, paddingBottom = 24,
}: {
  children: React.ReactNode;
  gap?: number;
  paddingHorizontal?: number;
  paddingBottom?: number;
}) {
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{
        paddingHorizontal,
        paddingTop: 4,
        paddingBottom,
        gap,
      }}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  );
}

// ── Trend tag ───────────────────────────────────────────────────────────

export function TrendTag({
  children, direction,
}: { children: React.ReactNode; direction?: 'up' | 'down' }) {
  const { palette } = useDesignTokens();
  const color = direction === 'up' ? palette.successInk
    : direction === 'down' ? palette.dangerInk
    : palette.text2;
  return (
    <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color }}>{children}</Text>
  );
}

// ── Button (extras beyond Paper) — `BtnTonal` for accent-soft style ─────

export function BtnTonal({
  children, onPress, size = 'md', tone = 'accent', style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  size?: 'xs' | 'sm' | 'md';
  /** Color tone: 'accent' (sage-soft, default — primary actions) or
   *  'danger' (red-soft — destructive actions like SOS confirm, unlink). */
  tone?: 'accent' | 'danger';
  style?: ViewStyle;
}) {
  const { palette } = useDesignTokens();
  const bg  = tone === 'danger' ? palette.dangerSoft : palette.accentSoft;
  const ink = tone === 'danger' ? palette.dangerInk  : palette.accentInk;
  const sizeStyle = size === 'xs'
    ? { height: 28, paddingHorizontal: 10, fontSize: 12 }
    : size === 'sm'
    ? { height: 36, paddingHorizontal: 14, fontSize: 13 }
    : { height: 48, paddingHorizontal: 22, fontSize: 14 };
  return (
    <Pressable onPress={onPress} style={[{
      backgroundColor: bg,
      borderRadius: size === 'md' ? radius.md : radius.sm,
      height: sizeStyle.height,
      paddingHorizontal: sizeStyle.paddingHorizontal,
      alignItems: 'center', justifyContent: 'center',
    }, style]}>
      <Text style={{
        color: ink, fontWeight: '500',
        fontFamily: fontFamily.sansMedium,
        fontSize: sizeStyle.fontSize,
      }}>{children}</Text>
    </Pressable>
  );
}

// ── Re-export Animated alias for screens that want simple fade-in ──────
export const FadeView = Animated.View;

// ── Toast (themed Snackbar wrapper) ────────────────────────────────────
// Used by screens that need transient feedback ("invitation sent",
// "save failed", …). Replaces the harsh native Alert.alert which
// breaks the design language with its system styling.

export type ToastTone = 'success' | 'error';

export interface ToastState {
  visible: boolean;
  message: string;
  tone: ToastTone;
}

export const HIDDEN_TOAST: ToastState = { visible: false, message: '', tone: 'success' };

/** Convenience hook — returns the toast state, a `show(message, tone)`
 *  helper, and the dismiss callback. Pair with the `<Toast />` component
 *  below: stash the hook return in a destructure at the top of your
 *  screen, call `show(...)` instead of `Alert.alert(...)`, and render
 *  `<Toast snack={snack} onDismiss={dismiss} />` near the bottom of
 *  your JSX (typically just before the closing SafeAreaView). */
export function useToast() {
  const [snack, setSnack] = React.useState<ToastState>(HIDDEN_TOAST);
  const show = React.useCallback((message: string, tone: ToastTone = 'success') => {
    setSnack({ visible: true, message, tone });
  }, []);
  const dismiss = React.useCallback(() => {
    setSnack((s) => ({ ...s, visible: false }));
  }, []);
  return { snack, show, dismiss };
}

/** Themed Snackbar — sage-soft for success, danger-soft for error.
 *  Auto-dismisses after 3.5 s; tap "Dismiss" to close early. */
export function Toast({
  snack, onDismiss, duration = 3500,
}: {
  snack: ToastState;
  onDismiss: () => void;
  duration?: number;
}) {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const isError = snack.tone === 'error';
  const bg = isError ? palette.dangerSoft : palette.accentSoft;
  const ink = isError ? palette.dangerInk : palette.accentInk;
  return (
    <Snackbar
      visible={snack.visible}
      onDismiss={onDismiss}
      duration={duration}
      style={{
        backgroundColor: bg,
        borderRadius: radius.md,
        marginHorizontal: 16,
        marginBottom: 16,
      }}
      action={{
        label: t('common.dismiss'),
        onPress: onDismiss,
        textColor: ink,
        labelStyle: { fontFamily: fontFamily.sansSemibold, fontWeight: '600' },
      }}
    >
      <Text style={{
        fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13,
        color: ink,
      }}>
        {snack.message}
      </Text>
    </Snackbar>
  );
}
