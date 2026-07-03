/**
 * Auth-screen primitives — kept here (not in `src/design/`) because
 * they're only consumed by the 3 auth screens and intentionally diverge
 * from the rest of the app's Material/Paper input style. They match the
 * design HTMLs in `D:/GP-IMP/more-claude-design-output/auth/` 1:1:
 *
 *  - `AuthInput`     — flat white rounded field with leading icon +
 *                      inline placeholder (no floating label).
 *  - `AuthSegment`   — pill-segmented control with sage-soft active state.
 */

import React, { useState } from 'react';
import {
  View, Text, TextInput as RNTextInput, Pressable,
  type TextInputProps, type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useDesignTokens } from '@/design';
import { fontFamily, radius } from '@/design/tokens';

/* ───────────────────────────────────────────────────────────────────────────
 * Auth icon set — Lucide-style stroke icons inlined verbatim from the
 * design source (`I.mail`, `I.lock`, etc. in components.jsx) so the
 * auth screens are pixel-identical to the HTML refs. Stroke width 1.7
 * matches the design's `.input svg` stroke. Color is driven by the caller.
 * ─────────────────────────────────────────────────────────────────────── */

export type AuthIconName =
  | 'mail' | 'lock' | 'eye' | 'eye-off' | 'shield-check'
  | 'chevron-left' | 'user' | 'check' | 'watch' | 'watch-off' | 'users'
  | 'male' | 'female' | 'calendar' | 'target' | 'phone' | 'pencil'
  // Tab-bar glyphs — matched 1:1 with the design source SVG paths so
  // both auth and tab navigation share one icon set.
  | 'home' | 'trend' | 'bot' | 'cog' | 'grid' | 'pin' | 'bell'
  // Alert-card glyphs — Lucide-style paths verbatim from
  // more-claude-design-output/caregiver so cards match the design 1:1.
  | 'heart' | 'alert-octagon' | 'alert-circle' | 'alert-triangle' | 'battery-low'
  | 'shield-x' | 'shield-alert' | 'filter' | 'phone-call' | 'map-pin-alert'
  // Dashboard live-indicator + section-header chrome.
  | 'refresh' | 'plus'
  // Settings + empty-state glyphs from the design source.
  | 'user-plus' | 'link' | 'moon' | 'globe' | 'log-out'
  | 'chevron-right' | 'fall-tumble' | 'shield';

interface IconProps { color: string; size?: number }

function IconBox({ size = 20, children }: { size?: number; children: React.ReactNode }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {children}
    </Svg>
  );
}

export function AuthIcon({ name, color, size = 20 }: IconProps & { name: AuthIconName }) {
  const sw = 1.7;
  const strokeProps = {
    stroke: color, strokeWidth: sw,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'mail':
      return (
        <IconBox size={size}>
          <Rect x={3} y={5} width={18} height={14} rx={2} {...strokeProps} />
          <Path d="M3 7l9 7 9-7" {...strokeProps} />
        </IconBox>
      );
    case 'lock':
      return (
        <IconBox size={size}>
          <Rect x={4} y={11} width={16} height={10} rx={2} {...strokeProps} />
          <Path d="M8 11V7a4 4 0 1 1 8 0v4" {...strokeProps} />
        </IconBox>
      );
    case 'eye':
      return (
        <IconBox size={size}>
          <Path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" {...strokeProps} />
          <Circle cx={12} cy={12} r={3} {...strokeProps} />
        </IconBox>
      );
    case 'eye-off':
      return (
        <IconBox size={size}>
          <Path d="M2 2l20 20" {...strokeProps} />
          <Path d="M6.71 6.71C4.18 8.42 2 12 2 12s4 7 10 7c1.66 0 3.18-.31 4.5-.85" {...strokeProps} />
          <Path d="M9.88 5.12C10.55 5.04 11.26 5 12 5c6 0 10 7 10 7s-.96 1.69-2.71 3.42" {...strokeProps} />
        </IconBox>
      );
    case 'shield-check':
      return (
        <IconBox size={size}>
          <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...strokeProps} />
          <Path d="M9 12l2 2 4-4" {...strokeProps} />
        </IconBox>
      );
    case 'chevron-left':
      return (
        <IconBox size={size}>
          <Path d="M15 6l-6 6 6 6" stroke={color} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" />
        </IconBox>
      );
    case 'user':
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={8} r={4} {...strokeProps} />
          <Path d="M4 21c0-4 4-6 8-6s8 2 8 6" {...strokeProps} />
        </IconBox>
      );
    case 'check':
      return (
        <IconBox size={size}>
          <Path d="M20 6L9 17l-5-5" stroke={color} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round" />
        </IconBox>
      );
    case 'watch':
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={6} {...strokeProps} />
          <Path d="M9 2h6l-.5 4M9.5 18l.5 4h4l.5-4" {...strokeProps} />
        </IconBox>
      );
    case 'watch-off':
      // Same outline as `watch` plus a diagonal slash — Lucide-style
      // "disabled" affordance, lifted from claude-design-output.
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={6} {...strokeProps} />
          <Path d="M9 2h6l-.5 4M9.5 18l.5 4h4l.5-4" {...strokeProps} />
          <Path d="M3 3l18 18" {...strokeProps} />
        </IconBox>
      );
    case 'users':
      return (
        <IconBox size={size}>
          <Circle cx={9} cy={8} r={3.5} {...strokeProps} />
          <Path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5" {...strokeProps} />
          <Circle cx={17} cy={6} r={2.5} {...strokeProps} />
          <Path d="M22 16c0-2-1.5-3.5-5-3.5" {...strokeProps} />
        </IconBox>
      );
    case 'male':
      // Mars symbol (♂) — circle below, arrow pointing up-right.
      return (
        <IconBox size={size}>
          <Circle cx={10} cy={14} r={5} {...strokeProps} />
          <Path d="M13.5 10.5L20 4" {...strokeProps} />
          <Path d="M15 4h5v5" {...strokeProps} />
        </IconBox>
      );
    case 'female':
      // Venus symbol (♀) — circle on top, cross below.
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={9} r={5} {...strokeProps} />
          <Path d="M12 14v8" {...strokeProps} />
          <Path d="M9 19h6" {...strokeProps} />
        </IconBox>
      );
    case 'calendar':
      // Lucide calendar: rounded rect with two small tab stems on top
      // and a horizontal divider below them.
      return (
        <IconBox size={size}>
          <Rect x={3} y={5} width={18} height={16} rx={2} {...strokeProps} />
          <Path d="M16 3v4" {...strokeProps} />
          <Path d="M8 3v4" {...strokeProps} />
          <Path d="M3 10h18" {...strokeProps} />
        </IconBox>
      );
    case 'target':
      // Lucide target — concentric circles. Used for the step-goal
      // row on Edit Profile (semantic = "your daily goal").
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={10} {...strokeProps} />
          <Circle cx={12} cy={12} r={6}  {...strokeProps} />
          <Circle cx={12} cy={12} r={2}  {...strokeProps} />
        </IconBox>
      );
    case 'phone':
      // Lucide phone — handset outline.
      return (
        <IconBox size={size}>
          <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" {...strokeProps} />
        </IconBox>
      );
    case 'pencil':
      // Lucide pencil — small edit affordance. Used on the
      // "tap to edit" goal pill on Home.
      return (
        <IconBox size={size}>
          <Path d="M12 20h9" {...strokeProps} />
          <Path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" {...strokeProps} />
        </IconBox>
      );
    case 'home':
      return (
        <IconBox size={size}>
          <Path d="M3 11l9-8 9 8" {...strokeProps} />
          <Path d="M5 10v10h14V10" {...strokeProps} />
        </IconBox>
      );
    case 'trend':
      return (
        <IconBox size={size}>
          <Path d="M3 17l6-6 4 4 8-8" {...strokeProps} />
          <Path d="M14 7h7v7" {...strokeProps} />
        </IconBox>
      );
    case 'bot':
      return (
        <IconBox size={size}>
          <Rect x={4} y={7} width={16} height={12} rx={3} {...strokeProps} />
          <Circle cx={9} cy={13} r={1} {...strokeProps} />
          <Circle cx={15} cy={13} r={1} {...strokeProps} />
          <Path d="M12 4v3" {...strokeProps} />
        </IconBox>
      );
    case 'cog':
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={3} {...strokeProps} />
          <Path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.3.65.97 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" {...strokeProps} />
        </IconBox>
      );
    case 'grid':
      return (
        <IconBox size={size}>
          <Rect x={3} y={3} width={7} height={7} rx={1} {...strokeProps} />
          <Rect x={14} y={3} width={7} height={7} rx={1} {...strokeProps} />
          <Rect x={3} y={14} width={7} height={7} rx={1} {...strokeProps} />
          <Rect x={14} y={14} width={7} height={7} rx={1} {...strokeProps} />
        </IconBox>
      );
    case 'pin':
      return (
        <IconBox size={size}>
          <Path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z" {...strokeProps} />
          <Circle cx={12} cy={10} r={2.5} {...strokeProps} />
        </IconBox>
      );
    case 'bell':
      return (
        <IconBox size={size}>
          <Path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" {...strokeProps} />
          <Path d="M10 21a2 2 0 1 0 4 0" {...strokeProps} />
        </IconBox>
      );
    case 'heart':
      // Lucide heart — used for cardiac alerts.
      return (
        <IconBox size={size}>
          <Path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" {...strokeProps} />
        </IconBox>
      );
    case 'alert-octagon':
      // Stop-sign octagon with a !  — used for SOS alerts.
      return (
        <IconBox size={size}>
          <Path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86z" {...strokeProps} />
          <Path d="M12 8v5M12 16h.01" {...strokeProps} />
        </IconBox>
      );
    case 'alert-circle':
      // Circle with a !  — used for "Watch disconnected" / inactivity.
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={10} {...strokeProps} />
          <Path d="M12 8v5M12 16h.01" {...strokeProps} />
        </IconBox>
      );
    case 'alert-triangle':
      // Triangle with !  — used for fall alerts.
      return (
        <IconBox size={size}>
          <Path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" {...strokeProps} />
          <Path d="M12 9v4M12 17h.01" {...strokeProps} />
        </IconBox>
      );
    case 'battery-low':
      // Lucide battery with single bar — low battery alerts.
      return (
        <IconBox size={size}>
          <Rect x={2} y={7} width={16} height={10} rx={2} {...strokeProps} />
          <Path d="M22 11v2" {...strokeProps} />
          <Path d="M6 11v2" {...strokeProps} />
        </IconBox>
      );
    case 'shield':
      // Lucide shield (plain) — alerts "All clear" empty state.
      return (
        <IconBox size={size}>
          <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...strokeProps} />
        </IconBox>
      );
    case 'shield-x':
      // Shield with X across — watch-disconnected style.
      return (
        <IconBox size={size}>
          <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...strokeProps} />
          <Path d="M9 9l6 6M15 9l-6 6" {...strokeProps} />
        </IconBox>
      );
    case 'shield-alert':
      // Shield + ! — left-safe-zone alerts.
      return (
        <IconBox size={size}>
          <Path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" {...strokeProps} />
          <Path d="M12 8v4M12 16h.01" {...strokeProps} />
        </IconBox>
      );
    case 'filter':
      // Funnel — filter icon, in case we surface a filter sheet later.
      return (
        <IconBox size={size}>
          <Path d="M22 3H2l8 9.5V19l4 2v-8.5z" {...strokeProps} />
        </IconBox>
      );
    case 'phone-call':
      // Phone-call — Call-now CTA on dashboard alert banner.
      return (
        <IconBox size={size}>
          <Path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92z" {...strokeProps} />
        </IconBox>
      );
    case 'map-pin-alert':
      // Map-pin with a ! inside — geofence/left-safe-zone alerts. Same
      // pin outline as 'pin' but the inner circle replaced with !
      return (
        <IconBox size={size}>
          <Path d="M12 22s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12z" {...strokeProps} />
          <Path d="M12 7v4M12 13h.01" {...strokeProps} />
        </IconBox>
      );
    case 'refresh':
      // Lucide refresh-cw — the "live" indicator on the dashboard.
      // Two curved arrows + arrowhead caps, verbatim Lucide geometry.
      return (
        <IconBox size={size}>
          <Path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" {...strokeProps} />
          <Path d="M21 3v5h-5" {...strokeProps} />
          <Path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" {...strokeProps} />
          <Path d="M3 21v-5h5" {...strokeProps} />
        </IconBox>
      );
    case 'plus':
      // Lucide plus — "+ Add" affordance on Wearers section header.
      return (
        <IconBox size={size}>
          <Path d="M12 5v14M5 12h14" {...strokeProps} />
        </IconBox>
      );
    case 'user-plus':
      // Lucide user-plus — Settings "Accept an invite" + dashboard
      // empty-state icon tile.
      return (
        <IconBox size={size}>
          <Path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" {...strokeProps} />
          <Circle cx={8.5} cy={7} r={4} {...strokeProps} />
          <Path d="M20 8v6M23 11h-6" {...strokeProps} />
        </IconBox>
      );
    case 'link':
      // Lucide link — empty-state "Enter invite code" pill icon.
      return (
        <IconBox size={size}>
          <Path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" {...strokeProps} />
          <Path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" {...strokeProps} />
        </IconBox>
      );
    case 'moon':
      // Lucide moon — Settings dark mode row.
      return (
        <IconBox size={size}>
          <Path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" {...strokeProps} />
        </IconBox>
      );
    case 'globe':
      // Lucide globe — Settings language row.
      return (
        <IconBox size={size}>
          <Circle cx={12} cy={12} r={10} {...strokeProps} />
          <Path d="M2 12h20M12 2a15 15 0 0 1 4 10 15 15 0 0 1-4 10 15 15 0 0 1-4-10 15 15 0 0 1 4-10z" {...strokeProps} />
        </IconBox>
      );
    case 'log-out':
      // Lucide log-out — Sign out button glyph.
      return (
        <IconBox size={size}>
          <Path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" {...strokeProps} />
          <Path d="M16 17l5-5-5-5M21 12H9" {...strokeProps} />
        </IconBox>
      );
    case 'chevron-right':
      // Lucide chevron-right — for navigable ListRows.
      return (
        <IconBox size={size}>
          <Path d="M9 6l6 6-6 6" {...strokeProps} />
        </IconBox>
      );
    case 'fall-tumble':
      // Custom fall-tumble shape from the design source — represents
      // a falling person above a ground line. Used for fall-type
      // alerts in the alerts list.
      return (
        <IconBox size={size}>
          <Path d="M14 11l3-3 4 3-3 3-4-1-4 4-3-3 4-4z" {...strokeProps} />
          <Path d="M3 22h18" {...strokeProps} />
        </IconBox>
      );
  }
}

export interface AuthInputProps
  extends Pick<TextInputProps,
    'value' | 'onChangeText' | 'placeholder' | 'keyboardType' |
    'autoCapitalize' | 'autoComplete' | 'autoCorrect' | 'returnKeyType' |
    'editable' | 'maxLength' | 'multiline' | 'numberOfLines' | 'onSubmitEditing'
  > {
  icon: AuthIconName;
  /** Treat as password — adds a trailing eye toggle and masks input. */
  secureToggle?: boolean;
  style?: ViewStyle;
}

/** Flat rounded input matching `.input` in the design source CSS:
 *  52px tall, 1px border, leading icon, inline placeholder. When
 *  `editable={false}` the row dims and the icon mutes — used by the
 *  Edit Profile screen for the email and role rows which are
 *  display-only. */
export function AuthInput({
  icon, secureToggle, style, editable = true, ...rest
}: AuthInputProps) {
  const { palette } = useDesignTokens();
  const [show, setShow] = useState(false);
  const secure = !!secureToggle && !show;
  return (
    <View style={[{
      flexDirection: 'row',
      alignItems: 'center',
      height: 52,
      backgroundColor: editable ? palette.surface : palette.surface2,
      borderWidth: 1,
      borderColor: palette.border,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      gap: 10,
      opacity: editable ? 1 : 0.85,
    }, style]}>
      <AuthIcon name={icon} color={palette.text3} size={20} />
      <RNTextInput
        {...rest}
        editable={editable}
        secureTextEntry={secure}
        placeholderTextColor={palette.text3}
        style={{
          flex: 1,
          fontFamily: fontFamily.sans,
          fontSize: 14,
          color: editable ? palette.text : palette.text2,
          padding: 0,
          // RN on Android adds default vertical padding via includeFontPadding;
          // 0 here keeps the text vertically centered with the icon.
          paddingVertical: 0,
          textAlignVertical: 'center',
        }}
      />
      {secureToggle && (
        <Pressable hitSlop={8} onPress={() => setShow(s => !s)}>
          <AuthIcon name={show ? 'eye-off' : 'eye'} color={palette.text3} size={20} />
        </Pressable>
      )}
    </View>
  );
}

export interface AuthSegmentOption<T extends string> {
  value: T;
  label: string;
  icon: AuthIconName;
}

export interface AuthSegmentProps<T extends string> {
  value: T;
  options: AuthSegmentOption<T>[];
  onChange: (value: T) => void;
}

/** Pill segmented control — `surface2` track + active pill in `surface`
 *  with a sm shadow. Matches `.seg` / `.seg-item.active` in the source. */
export function AuthSegment<T extends string>({
  value, options, onChange,
}: AuthSegmentProps<T>) {
  const { palette } = useDesignTokens();
  return (
    <View style={{
      flexDirection: 'row',
      backgroundColor: palette.surface2,
      borderRadius: 999,
      padding: 4,
      gap: 2,
    }}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            style={({ pressed }) => ({
              flex: 1,
              height: 36,
              borderRadius: 999,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              backgroundColor: active ? palette.surface : 'transparent',
              opacity: !active && pressed ? 0.6 : 1,
              ...(active ? {
                shadowColor: palette.shadowSm,
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 1,
                shadowRadius: 2,
                elevation: 1,
              } : {}),
            })}
          >
            <AuthIcon
              name={opt.icon}
              size={16}
              color={active ? palette.text : palette.text2}
            />
            <Text style={{
              fontFamily: fontFamily.sansMedium,
              fontSize: 13,
              fontWeight: '500',
              color: active ? palette.text : palette.text2,
            }}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 12px DM Sans Medium label rendered above a field group —
 *  matches `.field-label` in the source CSS. */
export function FieldLabel({ children }: { children: React.ReactNode }) {
  const { palette } = useDesignTokens();
  return (
    <Text style={{
      fontFamily: fontFamily.sansMedium,
      fontSize: 12,
      fontWeight: '500',
      color: palette.text2,
      letterSpacing: -0.06,
      marginBottom: 6,
    }}>{children}</Text>
  );
}
