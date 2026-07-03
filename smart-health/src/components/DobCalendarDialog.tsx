/**
 * Date-of-birth calendar dialog.
 *
 * Custom Paper-Dialog calendar styled to match the rest of the app
 * (same look as the Activity tab's date browser). Replaces the
 * native `@react-native-community/datetimepicker` for the
 * registration DOB field — the native one was either silently
 * falling back to a no-op (autolink fight) or crashing when the
 * Material design was requested (theme attr missing). Custom calendar
 * = full control over colors, no native module surface area, no
 * crashes.
 *
 * Two browse modes:
 *   - "days"  — 6×7 grid of day cells, chevrons step by month
 *   - "years" — 4×3 grid of 12 years per page, chevrons step by 12
 *
 * Tap the year in the header to flip to year-mode. Picking a year
 * snaps back to day-mode in that year + the previously-viewed month.
 *
 * Constraints:
 *   - `minDate` / `maxDate` clamp the picker (we use 1900-01-01 and
 *     today for DOB). Out-of-range cells render at 30% opacity and
 *     don't fire onPick.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable } from 'react-native';
import { Portal, Dialog, Button } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useDesignTokens } from '@/design';
import { fontFamily, radius } from '@/design/tokens';

type Mode = 'days' | 'years';

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function DobCalendarDialog({
  visible, value, minDate, maxDate, onPick, onCancel,
}: {
  visible: boolean;
  value: Date | null;
  minDate: Date;
  maxDate: Date;
  onPick: (date: Date) => void;
  onCancel: () => void;
}) {
  const { palette } = useDesignTokens();
  const { t, i18n } = useTranslation();
  const locale = i18n.language === 'ar' ? 'ar' : 'en-US';
  // Locale-aware weekday letters (Sun-first). Jan 1 2023 was a Sunday.
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(2023, 0, 1 + i).toLocaleDateString(locale, { weekday: 'narrow' }));
  const seed = value ?? new Date(1990, 0, 1);

  // What the user is browsing right now. Reset on each open via the
  // value prop — but kept in state so chevron clicks don't bubble.
  const [viewMonth, setViewMonth] = useState({
    y: clamp(seed.getFullYear(), minDate.getFullYear(), maxDate.getFullYear()),
    m: seed.getMonth(),
  });
  const [mode, setMode] = useState<Mode>('days');
  // Starting year of the visible 12-year grid in year mode.
  const [yearPage, setYearPage] = useState(() => seed.getFullYear() - (seed.getFullYear() % 12));

  // Reset when re-opened so we don't show stale browsing state from a
  // previous picker session.
  const wasVisible = useState(visible)[0];
  if (visible && !wasVisible) {
    // intentional shallow reset — first-open of this mount cycle
  }

  // ── Day-grid helpers ───────────────────────────────────────────
  const firstOfMonth = new Date(viewMonth.y, viewMonth.m, 1);
  const daysInMonth = new Date(viewMonth.y, viewMonth.m + 1, 0).getDate();
  const firstDow = firstOfMonth.getDay();
  const cells: { day: number | null; key: string }[] = [];
  for (let i = 0; i < firstDow; i++) cells.push({ day: null, key: `e${i}` });
  for (let d = 1; d <= daysInMonth; d++) cells.push({ day: d, key: `d${d}` });
  while (cells.length < 42) cells.push({ day: null, key: `t${cells.length}` });

  const monthFirstTs = new Date(viewMonth.y, viewMonth.m, 1).getTime();
  const monthLastTs = new Date(viewMonth.y, viewMonth.m + 1, 0).getTime();
  const canPrevMonth = monthFirstTs - 1 >= minDate.getTime();
  const canNextMonth = monthLastTs + 24 * 3600_000 <= maxDate.getTime() + 24 * 3600_000;

  const stepMonth = (delta: number) => {
    const next = new Date(viewMonth.y, viewMonth.m + delta, 1);
    setViewMonth({ y: next.getFullYear(), m: next.getMonth() });
  };

  // ── Year-grid helpers ──────────────────────────────────────────
  const minYear = minDate.getFullYear();
  const maxYear = maxDate.getFullYear();
  const yearCells = Array.from({ length: 12 }, (_, i) => yearPage + i);
  const canPrevYearPage = yearPage > minYear;
  const canNextYearPage = yearPage + 12 <= maxYear;

  const selectedKey = value
    ? `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`
    : null;

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={onCancel}
        style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
      >
        <Dialog.Content style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}>
          {/* Header: month-and-year title flanked by chevrons. Tap
              the year to flip into year-selection mode. */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingVertical: 6,
          }}>
            <Pressable
              onPress={mode === 'days'
                ? (canPrevMonth ? () => stepMonth(-1) : undefined)
                : (canPrevYearPage ? () => setYearPage((y) => y - 12) : undefined)}
              disabled={mode === 'days' ? !canPrevMonth : !canPrevYearPage}
              hitSlop={8}
              style={({ pressed }) => ({
                opacity: (mode === 'days' ? !canPrevMonth : !canPrevYearPage)
                  ? 0.3 : (pressed ? 0.5 : 1),
                padding: 4,
              })}
            >
              <MaterialCommunityIcons name="chevron-left" size={22} color={palette.text} />
            </Pressable>

            <Pressable
              onPress={() => {
                if (mode === 'days') {
                  setYearPage(viewMonth.y - (viewMonth.y % 12));
                  setMode('years');
                } else {
                  setMode('days');
                }
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                fontSize: 15, color: palette.text,
              }}>
                {mode === 'days'
                  ? `${new Date(viewMonth.y, viewMonth.m, 1).toLocaleDateString(locale, { month: 'long' })} ${viewMonth.y}`
                  : `${yearPage} – ${yearPage + 11}`}
              </Text>
            </Pressable>

            <Pressable
              onPress={mode === 'days'
                ? (canNextMonth ? () => stepMonth(1) : undefined)
                : (canNextYearPage ? () => setYearPage((y) => y + 12) : undefined)}
              disabled={mode === 'days' ? !canNextMonth : !canNextYearPage}
              hitSlop={8}
              style={({ pressed }) => ({
                opacity: (mode === 'days' ? !canNextMonth : !canNextYearPage)
                  ? 0.3 : (pressed ? 0.5 : 1),
                padding: 4,
              })}
            >
              <MaterialCommunityIcons name="chevron-right" size={22} color={palette.text} />
            </Pressable>
          </View>

          {mode === 'days' ? (
            <>
              {/* Weekday header row */}
              <View style={{ flexDirection: 'row', marginTop: 8 }}>
                {weekdays.map((w, i) => (
                  <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                    <Text style={{
                      fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
                      letterSpacing: 0.5,
                    }}>{w}</Text>
                  </View>
                ))}
              </View>

              {/* Day grid */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 }}>
                {cells.map((c) => {
                  if (c.day == null) {
                    return <View key={c.key} style={{ width: `${100 / 7}%`, height: 40 }} />;
                  }
                  const cellDate = new Date(viewMonth.y, viewMonth.m, c.day);
                  cellDate.setHours(0, 0, 0, 0);
                  const minClamped = new Date(minDate); minClamped.setHours(0, 0, 0, 0);
                  const maxClamped = new Date(maxDate); maxClamped.setHours(0, 0, 0, 0);
                  const disabled = cellDate < minClamped || cellDate > maxClamped;
                  const isSel = selectedKey === `${viewMonth.y}-${viewMonth.m}-${c.day}`;
                  return (
                    <View key={c.key} style={{ width: `${100 / 7}%`, alignItems: 'center', paddingVertical: 2 }}>
                      <Pressable
                        onPress={() => !disabled && onPick(cellDate)}
                        disabled={disabled}
                        style={({ pressed }) => ({
                          width: 36, height: 36, borderRadius: 999,
                          alignItems: 'center', justifyContent: 'center',
                          backgroundColor: isSel ? palette.accent2 : 'transparent',
                          opacity: disabled ? 0.28 : (pressed ? 0.55 : 1),
                        })}
                      >
                        <Text style={{
                          fontFamily: fontFamily.sansMedium,
                          fontSize: 13,
                          fontWeight: isSel ? '600' : '500',
                          color: isSel ? '#FFFFFF' : palette.text,
                        }}>{c.day}</Text>
                      </Pressable>
                    </View>
                  );
                })}
              </View>
            </>
          ) : (
            // Year-selection grid: 4 cols × 3 rows = 12 years per page
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginTop: 14 }}>
              {yearCells.map((yr) => {
                const disabled = yr < minYear || yr > maxYear;
                const isSel = value?.getFullYear() === yr;
                return (
                  <View key={yr} style={{ width: '25%', alignItems: 'center', paddingVertical: 8 }}>
                    <Pressable
                      onPress={() => {
                        if (disabled) return;
                        setViewMonth({ y: yr, m: viewMonth.m });
                        setMode('days');
                      }}
                      disabled={disabled}
                      style={({ pressed }) => ({
                        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
                        backgroundColor: isSel ? palette.accent2 : 'transparent',
                        opacity: disabled ? 0.28 : (pressed ? 0.55 : 1),
                      })}
                    >
                      <Text style={{
                        fontFamily: fontFamily.sansMedium, fontSize: 14,
                        fontWeight: isSel ? '600' : '500',
                        color: isSel ? '#FFFFFF' : palette.text,
                      }}>{yr}</Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onCancel} textColor={palette.text2}>{t('common.cancel')}</Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}
