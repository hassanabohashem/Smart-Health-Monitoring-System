import { View, ScrollView, SafeAreaView, Text, Pressable, Linking, RefreshControl, Dimensions } from 'react-native';
import { Avatar, Portal } from 'react-native-paper';
import { LineChart } from 'react-native-gifted-charts';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/services/supabase';
import { getLatestVitals, getVitalsForRange, type VitalsRow } from '@/services/vitals.service';
import { getAlerts } from '@/services/alert.service';
import type { Alert } from '@/types/alert.types';
import {
  useDesignTokens, Card, StatCard, Pill, IconDot, BarChart,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthIcon } from '@/components/AuthControls';
import {
  ALERT_GLYPH, SEVERITY_VARIANT, inkForVariant, titleFor, alertContext, fmtAlertTime,
} from '@/utils/alert-format';
import { bucketVitals, dailySteps, weekdayLetter, type TrendRange } from '@/utils/vitals-trend';

interface WearerProfile {
  full_name?: string;
  avatar_url?: string | null;
  step_goal?: number | null;
}

/** Things with a server-side history a caregiver can trend. */
type TrendMetric = 'hr' | 'spo2' | 'temp' | 'steps';

/** "just now" / "2 min ago" / "3h ago" / "1d ago" — the last-sync line. */
function timeAgo(iso: string, t: (k: string, v?: object) => string): string {
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const s = Math.round(ms / 1000);
  if (s < 45) return t('wearerDetail.lastSyncJustNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('wearerDetail.lastSyncMin', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('wearerDetail.lastSyncHour', { n: h });
  return t('wearerDetail.lastSyncDay', { n: Math.round(h / 24) });
}

function formatActivity(act: string | null | undefined, t: (k: string) => string): string {
  const lower = (act || 'resting').toLowerCase();
  if (lower.includes('walk') && lower.includes('up')) return t('caregiver.wearerStatusUpstairs');
  if (lower.includes('walk') && lower.includes('down')) return t('caregiver.wearerStatusDownstairs');
  if (lower.includes('walk')) return t('caregiver.wearerStatusWalking');
  if (lower.includes('jog') || lower.includes('run')) return t('caregiver.wearerStatusJogging');
  if (lower.includes('station')) return t('caregiver.wearerStatusStationary');
  if (lower.includes('rest')) return t('caregiver.wearerStatusResting');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** "Mostafa Genidy" → "MG"; single word → first two letters. */
function initialsOf(name?: string): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function WearerDetailScreen() {
  const { palette } = useDesignTokens();
  const { t, i18n } = useTranslation();
  const locale = i18n.language || 'en';
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, name, phone } = useLocalSearchParams<{ id: string; name: string; phone: string }>();

  const [wearerProfile, setWearerProfile] = useState<WearerProfile | null>(null);
  const [latest, setLatest] = useState<VitalsRow | null>(null);
  const [todayRows, setTodayRows] = useState<VitalsRow[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  /** Which vital's trend sheet is open ('hr' | 'spo2' | 'temp'), or null. */
  const [trendMetric, setTrendMetric] = useState<TrendMetric | null>(null);

  const loadAll = useCallback(async () => {
    if (!id) return;
    try {
      const [profileRes, latestRow, dayRows, alertRows] = await Promise.all([
        supabase.from('profiles').select('full_name, avatar_url, step_goal').eq('id', id).single(),
        getLatestVitals(id),
        getVitalsForRange(id, 1),
        getAlerts(id, 30),
      ]);
      setWearerProfile(profileRes.data as WearerProfile);
      setLatest(latestRow);
      setTodayRows(dayRows);
      setAlerts(alertRows);
    } catch (err) {
      console.error('[wearer-detail] load failed', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Live realtime — new vitals rows refresh the hero/tiles, new alerts
  // prepend to the timeline, without needing a manual refresh.
  useEffect(() => {
    if (!id) return;
    const ch = supabase
      .channel(`wearer-detail-${id}`)
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'vitals', filter: `user_id=eq.${id}` },
        (payload) => {
          const row = payload.new as VitalsRow;
          setLatest(row);
          setTodayRows((prev) => [...prev, row].slice(-400));
        })
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'alerts', filter: `wearer_id=eq.${id}` },
        (payload) => {
          const a = payload.new as Alert;
          setAlerts((prev) => [a, ...prev]);
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [id]);

  const handleRefresh = () => { setRefreshing(true); loadAll(); };

  const fullName = (name as string) || wearerProfile?.full_name || t('wearerDetail.unknown');

  const connected = useMemo(() => {
    if (!latest) return false;
    return Date.now() - new Date(latest.recorded_at).getTime() < 5 * 60_000;
  }, [latest]);

  // ── Vital tiles — mirror the wearer's Home 2×2 grid (foot = status). ─────
  const hr = latest?.heart_rate ?? null;
  const hrFoot = hr == null ? t('wearerDetail.noData')
    : hr < 60 ? t('wearerDetail.statusLow')
    : hr > 100 ? t('wearerDetail.statusElevated')
    : t('wearerDetail.statusNormal');

  const temp = latest?.temperature ?? null;
  const tempFoot = temp == null ? t('wearerDetail.noData')
    : temp < 36 ? t('wearerDetail.statusLow')
    : temp > 37.5 ? t('wearerDetail.statusElevated')
    : t('wearerDetail.statusNormal');

  // Age of the latest reading ("1h ago"). Shown on SpO₂ + ECG like the
  // wearer Home (point-in-time readings, not continuous streams). Doubles
  // as the profile-card "last sync" value.
  const readingAge = latest ? timeAgo(latest.recorded_at, t as never) : null;

  const spo2 = latest?.spo2 ?? null;
  const spo2Status = spo2 == null ? null
    : spo2 >= 95 ? t('wearerDetail.statusNormal') : t('wearerDetail.statusLow');
  const spo2Foot = spo2 == null ? t('wearerDetail.noData')
    : readingAge ? `${spo2Status} · ${readingAge}` : (spo2Status as string);

  // ── ECG — latest cardiac class, synced via metadata.ecgClass (demo
  //    writer stamps it; collapses N→Normal, S/V/F→Irregular). No trend
  //    chart — categorical; foot shows the reading age, like the wearer. ──
  const ecgClass = latest?.metadata?.ecgClass ?? null;
  const ecgValue = ecgClass === 'normal' ? t('wearerDetail.statusNormal')
    : ecgClass === 'irregular' ? t('wearerDetail.ecgIrregular')
    : ecgClass === 'inconclusive' ? t('wearerDetail.ecgUnclear')
    : '—';
  const ecgFoot = ecgClass == null ? t('wearerDetail.noEcg') : (readingAge ?? '—');

  // ── Steps (rides in vitals.metadata) ─────────────────────────────────────
  const steps = typeof latest?.metadata?.steps === 'number' ? latest.metadata.steps : null;
  const stepGoal = wearerProfile?.step_goal ?? 6000;

  // ── "How you moved today" — bucket today's vitals.activity into
  //    walking / jogging / resting (the wearer derives minutes locally from
  //    its own ticker; the caregiver derives shares from the synced
  //    activity classifications, the best server-side signal available). ──
  const movement = useMemo(() => {
    const b = { walking: 0, jogging: 0, resting: 0 };
    for (const r of todayRows) {
      const a = (r.activity || '').toUpperCase();
      if (!a) continue;
      if (a === 'JOGGING' || a === 'RUNNING') b.jogging++;
      else if (a === 'WALKING' || a === 'STAIRS' || a === 'UPSTAIRS' || a === 'DOWNSTAIRS') b.walking++;
      else b.resting++;
    }
    return { ...b, total: b.walking + b.jogging + b.resting };
  }, [todayRows]);
  const pctOf = (n: number) => (movement.total > 0 ? Math.round((n / movement.total) * 100) : 0);

  // ── Alerts — last 14 days ────────────────────────────────────────────────
  const recentAlerts = useMemo(() => {
    const cutoff = Date.now() - 14 * 24 * 3600_000;
    return alerts.filter((a) => new Date(a.created_at).getTime() >= cutoff);
  }, [alerts]);

  const activityText = formatActivity(latest?.activity, t);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* Custom header — circular back + a static "Wearer" title. The
          wearer's name lives only in the profile card below (no dupe),
          and the call button moved into that card too. */}
      <View style={{
        paddingTop: insets.top + 18, paddingHorizontal: 20, paddingBottom: 12,
        flexDirection: 'row', alignItems: 'center', gap: 14,
      }}>
        <CircleBtn onPress={() => router.back()} palette={palette}>
          <AuthIcon name="chevron-left" color={palette.text} size={22} />
        </CircleBtn>
        <Text style={{
          fontFamily: fontFamily.sansSemibold, fontSize: 22, fontWeight: '600',
          letterSpacing: -0.44, color: palette.text,
        }}>{t('wearerDetail.wearerEyebrow')}</Text>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 24, gap: 14 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={palette.accent} />}
      >
        {/* Profile card — avatar + full name + activity pill + last sync,
            with the call button living here (combined into the card). */}
        <Card padding={16}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            {wearerProfile?.avatar_url
              ? <Avatar.Image size={56} source={{ uri: wearerProfile.avatar_url }} />
              : <Avatar.Text
                  size={56}
                  label={initialsOf(fullName)}
                  style={{ backgroundColor: palette.accentSoft }}
                  color={palette.accentInk}
                  labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 19 }}
                />}
            <View style={{ flex: 1 }}>
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontSize: 17, fontWeight: '600', color: palette.text,
              }} numberOfLines={1}>{fullName}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 7, flexWrap: 'wrap' }}>
                <Pill variant={connected ? 'success' : 'default'} dot>
                  {connected ? activityText : t('wearerDetail.offline')}
                </Pill>
                <Text style={{ fontFamily: fontFamily.mono, fontSize: 11.5, color: palette.text3 }}>
                  {readingAge ? t('wearerDetail.lastSync', { time: readingAge }) : t('wearerDetail.notSynced')}
                </Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              {/* Assistant scoped to this wearer — caregiver can ask about them. */}
              <CircleBtn
                onPress={() => router.push({ pathname: '/(shared)/wearer-assistant', params: { id, name: fullName } })}
                palette={palette}
              >
                <AuthIcon name="bot" color={palette.text} size={20} />
              </CircleBtn>
              {phone ? (
                <CircleBtn onPress={() => Linking.openURL(`tel:${phone}`)} palette={palette}>
                  <AuthIcon name="phone-call" color={palette.text} size={20} />
                </CircleBtn>
              ) : null}
            </View>
          </View>
        </Card>

        {/* Vital tiles — same 2×2 grid + separation as the wearer's Home
            (HR / Temp on top, SpO₂ / ECG below). HR / Temp / SpO₂ are
            tappable to open that metric's trend (a hint line under the
            grid says so — per-tile links looked lopsided next to ECG);
            ECG has no server-side history so it stays a plain
            placeholder. */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            icon="heart" iconVariant="accent" label={t('wearerDetail.heartRate')}
            value={hr ?? '—'} unit={hr != null ? 'bpm' : ''} foot={hrFoot} valueFontSize={42}
            onPress={() => setTrendMetric('hr')}          />
          <StatCard
            icon="thermometer" iconVariant="warning" label={t('wearerDetail.tempLabel')}
            value={temp != null ? temp.toFixed(1) : '—'} unit={temp != null ? '°C' : ''} foot={tempFoot} valueFontSize={42}
            onPress={() => setTrendMetric('temp')}          />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            icon="water" iconVariant="info" label={t('wearerDetail.spo2Label')}
            value={spo2 ?? '—'} unit={spo2 != null ? '%' : ''} foot={spo2Foot} valueFontSize={42}
            onPress={() => setTrendMetric('spo2')}          />
          <StatCard
            icon="heart-pulse" iconVariant="danger" label={t('wearerDetail.ecgLabel')}
            value={ecgValue} foot={ecgFoot}
            valueFontSize={ecgClass != null ? 24 : 42} valueLineHeight={42}
          />
        </View>
        {/* One clean hint that the vital tiles are tappable for trends —
            replaces the per-tile links that left the ECG tile lopsided. */}
        <Text style={{
          fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3,
          textAlign: 'center', marginTop: -2,
        }}>
          {t('wearerDetail.tapVitalTrend')}
        </Text>

        {/* Activity today — steps headline + a segmented "how they moved"
            bar; the whole card taps through to the steps trend. */}
        <Card padding={16} onPress={() => setTrendMetric('steps')}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <IconDot icon="shoe-print" variant="accent" size={22} />
            <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 14, color: palette.text }}>
              {t('wearerDetail.activityToday')}
            </Text>
          </View>
          {/* Steps — headline count + goal (no ring). */}
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 40, lineHeight: 42, letterSpacing: -1.4, color: palette.text,
            }}>
              {steps != null ? steps.toLocaleString(locale) : '—'}
            </Text>
            <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3 }}>
              {t('wearerDetail.ofGoal', { goal: stepGoal.toLocaleString(locale) })}
            </Text>
          </View>

          {/* How they moved — one segmented bar showing the day's split,
              with a legend below. (Replaces the donut + paired legend.) */}
          {movement.total > 0 ? (
            <>
              <View style={{ flexDirection: 'row', gap: 2, height: 12, marginTop: 16 }}>
                {movement.walking > 0 && <View style={{ flex: movement.walking, backgroundColor: palette.accent2, borderRadius: 3 }} />}
                {movement.jogging > 0 && <View style={{ flex: movement.jogging, backgroundColor: palette.accent, borderRadius: 3 }} />}
                {movement.resting > 0 && <View style={{ flex: movement.resting, backgroundColor: palette.surface3, borderRadius: 3 }} />}
              </View>
              <View style={{ gap: 8, marginTop: 14 }}>
                {[
                  { label: t('wearerDetail.moveWalking'), pct: pctOf(movement.walking), dot: palette.accent2 },
                  { label: t('wearerDetail.moveJogging'), pct: pctOf(movement.jogging), dot: palette.accent },
                  { label: t('wearerDetail.moveResting'), pct: pctOf(movement.resting), dot: palette.surface3 },
                ].map((row) => (
                  <View key={row.label} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ width: 9, height: 9, borderRadius: 999, backgroundColor: row.dot }} />
                      <Text style={{ fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2 }}>{row.label}</Text>
                    </View>
                    <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13, color: palette.text }}>{row.pct}%</Text>
                  </View>
                ))}
              </View>
            </>
          ) : (
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3, fontStyle: 'italic', marginTop: 16,
            }}>
              {t('wearerDetail.noMovementData')}
            </Text>
          )}
          {/* "View trend" link — same affordance as the vital tiles. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 1, marginTop: 16 }}>
            <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 11.5, color: palette.accentInk }}>
              {t('wearerDetail.viewTrend')}
            </Text>
            <AuthIcon name="chevron-right" color={palette.accentInk} size={14} />
          </View>
        </Card>

        {/* Recent alerts — timeline, last 14 days. */}
        <Card padding={16}>
          <View style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
          }}>
            <Text style={{
              fontFamily: fontFamily.sansSemibold, fontSize: 16, fontWeight: '600', color: palette.text,
            }}>{t('wearerDetail.recentAlerts')}</Text>
            <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3 }}>
              {t('wearerDetail.last14Days')}
            </Text>
          </View>
          {recentAlerts.length === 0 ? (
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 13, color: palette.text3,
              paddingVertical: 16, textAlign: 'center',
            }}>
              {loading ? '…' : t('wearerDetail.noRecentAlerts')}
            </Text>
          ) : (
            recentAlerts.map((a, i) => (
              <AlertRow
                key={a.id}
                alert={a}
                isLast={i === recentAlerts.length - 1}
                palette={palette}
                t={t}
                locale={locale}
              />
            ))
          )}
        </Card>
      </ScrollView>

      {/* Per-metric trend sheet — opened by tapping a vital tile. */}
      {trendMetric && id ? (
        <VitalTrendSheet
          wearerId={id}
          metric={trendMetric}
          palette={palette}
          t={t}
          locale={locale}
          onClose={() => setTrendMetric(null)}
        />
      ) : null}
    </SafeAreaView>
  );
}

/** 44px circular outlined icon button used in the header. */
function CircleBtn({
  onPress, children, palette,
}: { onPress: () => void; children: React.ReactNode; palette: ReturnType<typeof useDesignTokens>['palette'] }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 44, height: 44, borderRadius: 999,
        backgroundColor: palette.surface,
        borderWidth: 1, borderColor: palette.border,
        alignItems: 'center', justifyContent: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

/** One row in the Recent-alerts timeline: severity IconDot + connector
 *  line + (title · context) and relative time. */
function AlertRow({
  alert, isLast, palette, t, locale,
}: {
  alert: Alert;
  isLast: boolean;
  palette: ReturnType<typeof useDesignTokens>['palette'];
  t: ReturnType<typeof useTranslation>['t'];
  locale: string;
}) {
  const variant = SEVERITY_VARIANT[alert.severity] || 'danger';
  const glyph = ALERT_GLYPH[alert.type] || 'alert-octagon';
  const ink = inkForVariant(palette, variant);
  const context = alertContext(alert, t as never);
  const title = titleFor(alert.type, t);
  const line1 = context ? `${title} · ${context}` : title;
  const timeStr = fmtAlertTime(alert.created_at, t as never, locale);

  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <View style={{ alignItems: 'center' }}>
        <IconDot iconNode={<AuthIcon name={glyph} color={ink} size={18} />} variant={variant} size={36} />
        {!isLast && (
          <View style={{ width: 2, flex: 1, backgroundColor: palette.divider, marginTop: 4, borderRadius: 1 }} />
        )}
      </View>
      <View style={{ flex: 1, paddingBottom: isLast ? 0 : 18 }}>
        <Text style={{
          fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600',
          lineHeight: 20, color: palette.text,
        }}>{line1}</Text>
        <Text style={{
          fontFamily: fontFamily.mono, fontSize: 11.5, color: palette.text3, marginTop: 3,
        }}>{timeStr}</Text>
      </View>
    </View>
  );
}

const SHEET_W = Dimensions.get('window').width - 40;

/** Modal sheet opened by tapping a vital tile (or the Activity card).
 *  Renders the SAME Whoop-style trend the wearer's Activity tab uses:
 *  HR / SpO₂ / Temp → period-avg + minimal area line over a healthy
 *  band + low/high footer; Steps → daily/weekly bars + total.
 *  Read-only; the caregiver can't edit anything here. */
function VitalTrendSheet({
  wearerId, metric, palette, t, locale, onClose,
}: {
  wearerId: string;
  metric: TrendMetric;
  palette: ReturnType<typeof useDesignTokens>['palette'];
  t: ReturnType<typeof useTranslation>['t'];
  locale: string;
  onClose: () => void;
}) {
  const [range, setRange] = useState<TrendRange>('week');
  const [rows, setRows] = useState<VitalsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const isAr = locale.startsWith('ar');
  // Anchor = the last day of the shown window. Defaults to today; the
  // ‹ › arrows page it back/forward within the 30-day data window.
  const [anchor, setAnchor] = useState(() => new Date());
  const fullW = SHEET_W - 36; // card width minus 18px padding either side

  useEffect(() => {
    const days = range === 'day' ? 1 : range === 'week' ? 7 : 30;
    let alive = true;
    setLoading(true);
    getVitalsForRange(wearerId, days, anchor)
      .then((r) => { if (alive) setRows(r); })
      .catch((e) => console.error('[trend] fetch failed', e))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [wearerId, range, anchor]);

  // Caption under the day strip: the window the chart currently covers.
  const sod = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const isToday = sod(anchor).getTime() >= sod(new Date()).getTime();
  const dOpts = { month: 'short', day: 'numeric' } as const;
  const periodLabel = range === 'day'
    ? (isToday ? t('wearerDetail.trendToday') : anchor.toLocaleDateString(locale, { weekday: 'short', ...dOpts }))
    : (() => {
        const span = range === 'week' ? 6 : 27;
        const start = new Date(anchor); start.setDate(start.getDate() - span);
        return `${start.toLocaleDateString(locale, dOpts)} – ${anchor.toLocaleDateString(locale, dOpts)}`;
      })();

  // Labels reuse the wearer Activity tab's strings verbatim so the two
  // read identically (e.g. Temp → "Temperature").
  const head = {
    hr:    { label: t('activity.heartRate'), icon: 'heart' as const,       variant: 'accent' as const },
    spo2:  { label: t('activity.spo2'),      icon: 'water' as const,       variant: 'info' as const },
    temp:  { label: t('activity.temp'),      icon: 'thermometer' as const, variant: 'warning' as const },
    steps: { label: t('activity.steps'),     icon: 'shoe-print' as const,  variant: 'accent' as const },
  }[metric];

  // Sub-labels match the wearer 1:1: vitals show the period average
  // ("7-day avg"), steps show the period ("this week").
  const vitalSub = range === 'day'
    ? t('activity.rangeSubLabel.day')
    : range === 'week' ? t('activity.avgSubLabel.week') : t('activity.avgSubLabel.month');
  const stepsSub = t(`activity.rangeSubLabel.${range}`);

  // ── Vitals (HR / SpO₂ / Temp): Whoop-style bucketed area line. ───────────
  const vspecMap = {
    hr:   { color: palette.danger,  decimals: 0, unit: 'bpm', healthy: [60, 100] as [number, number],   pick: (r: VitalsRow) => r.heart_rate },
    spo2: { color: palette.info,    decimals: 0, unit: '%',   healthy: [95, 100] as [number, number],   pick: (r: VitalsRow) => r.spo2 },
    temp: { color: palette.warning, decimals: 1, unit: '°C',  healthy: [36.1, 37.2] as [number, number], pick: (r: VitalsRow) => r.temperature },
  };
  let line: null | {
    color: string; decimals: number; unit: string; healthy: [number, number];
    hasData: boolean; periodAvg: number | null; lo: number; hi: number;
    points: { value: number }[]; chartH: number; bandTop: number; bandH: number;
    yMin: number; yRange: number;
  } = null;
  if (metric !== 'steps') {
    const vspec = vspecMap[metric];
    const buckets = bucketVitals(rows, vspec.pick, range, anchor, locale);
    const filled = buckets.filter((b) => b.count > 0);
    const allAvgs = filled.map((b) => b.avg!) as number[];
    const overallMin = filled.length ? Math.min(...(filled.map((b) => b.min!) as number[])) : 0;
    const overallMax = filled.length ? Math.max(...(filled.map((b) => b.max!) as number[])) : 1;
    const periodAvg = allAvgs.length ? allAvgs.reduce((s, v) => s + v, 0) / allAvgs.length : null;
    const dataLo = Math.min(overallMin, vspec.healthy[0]);
    const dataHi = Math.max(overallMax, vspec.healthy[1]);
    const span = Math.max(1, dataHi - dataLo);
    const pad = span * 0.08;
    const yMin = dataLo - pad;
    const yMax = dataHi + pad;
    const yRange = yMax - yMin;
    const chartH = 120;
    const topFor = (v: number) => ((yMax - v) / yRange) * chartH;
    const bandTop = Math.max(0, topFor(vspec.healthy[1]));
    const bandH = Math.max(0, Math.min(chartH, topFor(vspec.healthy[0])) - bandTop);
    let lastV = filled[0]?.avg ?? 0;
    const points = buckets.map((b) => { if (b.count > 0) lastV = b.avg!; return { value: lastV }; });
    line = {
      color: vspec.color, decimals: vspec.decimals, unit: vspec.unit, healthy: vspec.healthy,
      hasData: filled.length >= 2, periodAvg, lo: overallMin, hi: overallMax,
      points, chartH, bandTop, bandH, yMin, yRange,
    };
  }

  // ── Steps: daily (week) / weekly (month) bars + total. ───────────────────
  let stepsView: null | { bars: { value: number; label: string }[]; total: number; ceiling: number } = null;
  if (metric === 'steps') {
    let bars: { value: number; label: string }[] = [];
    if (range === 'week') {
      bars = dailySteps(rows, 7, anchor, isAr);
    } else if (range === 'month') {
      // 4 weekly bars labelled by start-of-week date ("May 5"), matching
      // the wearer Activity tab's padWeeks labels.
      const d28 = dailySteps(rows, 28, anchor, isAr);
      for (let w = 0; w < 4; w++) {
        const slice = d28.slice(w * 7, w * 7 + 7);
        const start = new Date(anchor); start.setDate(start.getDate() - 27 + w * 7);
        bars.push({
          value: slice.reduce((a, b) => a + b.value, 0),
          label: start.toLocaleDateString(locale, { month: 'short', day: 'numeric' }),
        });
      }
    }
    const todayTotal = dailySteps(rows, 1, anchor, isAr)[0]?.value ?? 0;
    const total = range === 'day' ? todayTotal : bars.reduce((a, b) => a + b.value, 0);
    const peak = Math.max(1, todayTotal, ...bars.map((b) => b.value));
    const ceiling = Math.max(1000, Math.ceil((peak * 1.15) / 1000) * 1000);
    stepsView = { bars, total, ceiling };
  }

  return (
    <Portal>
      <Pressable
        onPress={onClose}
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(20,24,35,0.45)',
          alignItems: 'center', justifyContent: 'center', padding: 20,
        }}
      >
        {/* Inner press swallows taps so tapping the card doesn't dismiss. */}
        <Pressable
          onPress={() => {}}
          style={{ width: SHEET_W, backgroundColor: palette.surface, borderRadius: radius.lg, padding: 18 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <IconDot icon={head.icon} variant={head.variant} size={30} />
              <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 16, fontWeight: '600', color: palette.text }}>
                {head.label}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={{ width: 32, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.surface2 }}
            >
              <Text style={{ fontSize: 15, color: palette.text2, fontFamily: fontFamily.sansMedium }}>✕</Text>
            </Pressable>
          </View>

          {/* Day / Week / Month toggle (same look as the wearer Activity tab). */}
          <View style={{ flexDirection: 'row', alignSelf: 'flex-start', backgroundColor: palette.surface2, borderRadius: 999, padding: 4, gap: 2, marginBottom: 12 }}>
            {(['day', 'week', 'month'] as const).map((r) => {
              const active = r === range;
              return (
                <Pressable
                  key={r}
                  onPress={() => { setRange(r); setAnchor(new Date()); }}
                  style={{ paddingHorizontal: 16, height: 32, borderRadius: 999, alignItems: 'center', justifyContent: 'center', backgroundColor: active ? palette.surface : 'transparent' }}
                >
                  <Text style={{ fontFamily: fontFamily.sansMedium, fontSize: 12.5, fontWeight: '500', color: active ? palette.text : palette.text2 }}>
                    {t(`activity.range.${r}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Date selector — a clean horizontal strip of the last 30 days
              (tap one to anchor the window on it). Replaces the month-grid
              calendar, which looked mostly-greyed for a 30-day range. The
              caption shows the resulting window. */}
          <DayStrip anchor={anchor} onPick={setAnchor} palette={palette} locale={locale} />
          <Text style={{
            fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3,
            textAlign: 'center', marginTop: 8, marginBottom: 14,
          }}>{periodLabel}</Text>

          {loading ? (
            <Text style={{ fontFamily: fontFamily.sans, fontSize: 13, color: palette.text3, textAlign: 'center', paddingVertical: 40 }}>…</Text>
          ) : line ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontFamily: fontFamily.display, fontSize: 46, lineHeight: 48, letterSpacing: -1.5, color: palette.text }}>
                  {line.periodAvg != null ? line.periodAvg.toFixed(line.decimals) : '—'}
                </Text>
                <Text style={{ fontFamily: fontFamily.mono, fontSize: 12, color: palette.text3 }}>{line.unit} · {vitalSub}</Text>
              </View>
              {line.hasData ? (
                <>
                  <View style={{ position: 'relative', marginTop: 14, height: line.chartH, width: fullW }}>
                    {line.bandH > 0 && (
                      <View style={{
                        position: 'absolute', left: 0, right: 0, top: line.bandTop, height: line.bandH,
                        backgroundColor: line.color, opacity: 0.07, borderRadius: 4,
                      }} />
                    )}
                    <LineChart
                      areaChart curved disableScroll
                      data={line.points}
                      width={fullW}
                      height={line.chartH}
                      thickness={2.5}
                      color={line.color}
                      startFillColor={line.color}
                      endFillColor={palette.surface}
                      startOpacity={0.22}
                      endOpacity={0.01}
                      hideDataPoints
                      hideYAxisText
                      hideRules
                      yAxisColor="transparent"
                      xAxisColor="transparent"
                      initialSpacing={0}
                      endSpacing={0}
                      yAxisOffset={line.yMin}
                      maxValue={line.yRange}
                      noOfSections={1}
                      adjustToWidth
                    />
                  </View>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
                    <View>
                      <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3 }}>{t('activity.low')}</Text>
                      <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 16, color: palette.text, marginTop: 2 }}>{line.lo.toFixed(line.decimals)}</Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3 }}>{t('activity.high')}</Text>
                      <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 16, color: palette.text, marginTop: 2 }}>{line.hi.toFixed(line.decimals)}</Text>
                    </View>
                  </View>
                  <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3, marginTop: 10 }}>
                    {t('activity.healthyRange', { lo: line.healthy[0].toFixed(line.decimals), hi: line.healthy[1].toFixed(line.decimals), unit: line.unit })}
                  </Text>
                </>
              ) : (
                <Text style={{ fontFamily: fontFamily.sans, fontSize: 13, color: palette.text3, textAlign: 'center', paddingVertical: 36 }}>
                  {t('activity.noReadings', { metric: head.label.toLowerCase() })}
                </Text>
              )}
            </>
          ) : stepsView ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
                <Text style={{ fontFamily: fontFamily.display, fontSize: 46, lineHeight: 48, letterSpacing: -1.5, color: palette.text }}>
                  {stepsView.total.toLocaleString(locale)}
                </Text>
                <Text style={{ fontFamily: fontFamily.mono, fontSize: 12, color: palette.text3 }}>{stepsSub}</Text>
              </View>
              {range !== 'day' && stepsView.bars.length > 0 ? (
                <View style={{ marginTop: 14 }}>
                  <BarChart
                    data={stepsView.bars.map((b) => b.value)}
                    labels={stepsView.bars.map((b) => b.label)}
                    height={130}
                    max={stepsView.ceiling}
                    highlightIndex={stepsView.bars.length - 1}
                    gap={stepsView.bars.length > 7 ? 3 : 6}
                  />
                </View>
              ) : null}
            </>
          ) : null}
        </Pressable>
      </Pressable>
    </Portal>
  );
}

/** Horizontal strip of the last 30 days — tap one to anchor the trend
 *  window on it (its last day). Clean for a 30-day range: every chip is
 *  in-range (no greyed month grid). Auto-scrolls to today on open. */
function DayStrip({
  anchor, onPick, palette, locale,
}: {
  anchor: Date;
  onPick: (d: Date) => void;
  palette: ReturnType<typeof useDesignTokens>['palette'];
  locale: string;
}) {
  const isAr = locale.startsWith('ar');
  const scrollRef = useRef<ScrollView>(null);
  const didInit = useRef(false);
  // Scroll metrics (px) drive the edge chevrons' show/hide + scrolling.
  const [m, setM] = useState({ view: 1, content: 1, off: 0 });
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const now = new Date();
  const days = useMemo(() => {
    const out: Date[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      out.push(d);
    }
    return out;
  }, []);

  // Floating edge chevrons appear when there are more days that way.
  const canLeft = m.off > 4;
  const canRight = m.off < m.content - m.view - 4;
  const scrollBy = (dx: number) =>
    scrollRef.current?.scrollTo({ x: Math.max(0, m.off + dx), animated: true });

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      {/* Left chevron gutter — fixed width so the row never reflows as
          the chevrons show/hide, and the chips never sit under them. */}
      <View style={{ width: 30, alignItems: 'center' }}>
        {canLeft && <ScrollChevron side="left" palette={palette} onPress={() => scrollBy(-220)} />}
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        horizontal
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onLayout={(e) => {
          // Read nativeEvent synchronously — it's recycled before the
          // setState updater runs, so capturing it lazily crashes.
          const view = e.nativeEvent.layout.width;
          setM((s) => ({ ...s, view }));
        }}
        onContentSizeChange={(w) => {
          setM((s) => ({ ...s, content: w }));
          // Jump to today (rightmost) once the content is measured.
          if (!didInit.current && w > 100) {
            didInit.current = true;
            requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
          }
        }}
        onScroll={(e) => {
          const off = e.nativeEvent.contentOffset.x;
          setM((s) => ({ ...s, off }));
        }}
        contentContainerStyle={{ gap: 4, paddingHorizontal: 2 }}
      >
        {days.map((d, i) => {
          const selected = sameDay(d, anchor);
          const today = sameDay(d, now);
          return (
            <Pressable key={i} onPress={() => onPick(d)} style={{ alignItems: 'center', width: 42, paddingVertical: 2 }}>
              <Text style={{ fontFamily: fontFamily.mono, fontSize: 9, color: palette.text3, marginBottom: 5 }}>
                {weekdayLetter(d.getDay(), isAr)}
              </Text>
              <View style={{
                width: 34, height: 34, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: selected ? palette.accent2 : 'transparent',
                borderWidth: !selected && today ? 1 : 0,
                borderColor: palette.accent,
              }}>
                <Text style={{
                  fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                  color: selected ? palette.textOnAccent : palette.text,
                }}>{d.getDate()}</Text>
              </View>
            </Pressable>
          );
        })}
      </ScrollView>
      {/* Right chevron gutter. Chevrons live in side gutters (not overlaid
          on the chips) so they never cover the day numbers; each shows
          only when there are more days that way, and scrolls on tap. */}
      <View style={{ width: 30, alignItems: 'center' }}>
        {canRight && <ScrollChevron side="right" palette={palette} onPress={() => scrollBy(220)} />}
      </View>
    </View>
  );
}

/** A circular chevron button in a day-strip gutter — signals (and
 *  performs) horizontal scrolling. */
function ScrollChevron({
  side, palette, onPress,
}: {
  side: 'left' | 'right';
  palette: ReturnType<typeof useDesignTokens>['palette'];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 28, height: 28, borderRadius: 999,
        backgroundColor: palette.surface,
        borderWidth: 1, borderColor: palette.border,
        alignItems: 'center', justifyContent: 'center',
        shadowColor: '#141823', shadowOpacity: 0.1, shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, elevation: 2,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <AuthIcon name={side === 'left' ? 'chevron-left' : 'chevron-right'} color={palette.text2} size={16} />
    </Pressable>
  );
}
