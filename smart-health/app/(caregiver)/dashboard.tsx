import { View, SafeAreaView, Text, Pressable, Linking } from 'react-native';
import { Avatar } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { getLinkedWearers } from '@/services/link.service';
import { getAlertsForCaregiver } from '@/services/alert.service';
import { getLatestVitals, type VitalsRow } from '@/services/vitals.service';
import { supabase } from '@/services/supabase';
import { CaregiverDashboardSkeleton } from '@/components/Skeleton';
import { ErrorState } from '@/components/ErrorState';
import { AuthIcon } from '@/components/AuthControls';
import type { Alert, AlertType } from '@/types/alert.types';
import { useDesignTokens, Card, Pill, PageHeader, ScreenBody, EmptyState } from '@/design';
import { fontFamily, radius, spacing } from '@/design/tokens';

interface LinkedWearer {
  id: string;
  wearer_id: string;
  wearer: {
    id: string;
    full_name: string;
    phone: string | null;
    avatar_url: string | null;
  };
}

/** "Xs/Xm/Xh ago" — locale-aware via i18n. */
function useTimeAgo() {
  const { t } = useTranslation();
  return useCallback((iso: string): string => {
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (seconds < 5) return t('caregiver.timeJustNow');
    if (seconds < 60) return t('caregiver.timeSecondsAgo', { n: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('caregiver.timeMinutesAgo', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('caregiver.timeHoursAgo', { n: hours });
    return t('caregiver.timeDaysAgo', { n: Math.floor(hours / 24) });
  }, [t]);
}

/** Map alert type to localized hero title. */
function alertTitle(type: AlertType, t: (k: string) => string): string {
  switch (type) {
    case 'fall':         return t('caregiver.fallTitle');
    case 'sos':          return t('caregiver.sosTitle');
    case 'cardiac':      return t('caregiver.cardiacTitle');
    case 'geofence':     return t('caregiver.geofenceTitle');
    case 'inactivity':   return t('caregiver.inactivityTitle');
    case 'low_battery':  return t('caregiver.lowBatteryTitle');
    default:             return type;
  }
}

/** HAR activity class → localized verb. */
function activityLabel(activity: string | null, t: (k: string) => string): string {
  if (!activity) return t('caregiver.wearerStatusLive');
  const upper = activity.toUpperCase();
  if (upper === 'WALKING' || upper === 'WALK')                  return t('caregiver.wearerStatusWalking');
  if (upper === 'JOGGING' || upper === 'JOG')                   return t('caregiver.wearerStatusJogging');
  if (upper === 'STAIRS')                                       return t('caregiver.wearerStatusStairs');
  if (upper === 'STATIONARY')                                   return t('caregiver.wearerStatusStationary');
  if (upper === 'UPSTAIRS' || upper === 'WALKING_UPSTAIRS')     return t('caregiver.wearerStatusUpstairs');
  if (upper === 'DOWNSTAIRS' || upper === 'WALKING_DOWNSTAIRS') return t('caregiver.wearerStatusDownstairs');
  if (upper === 'SITTING')                                       return t('caregiver.wearerStatusSitting');
  if (upper === 'STANDING')                                      return t('caregiver.wearerStatusStanding');
  if (upper === 'RESTING' || upper === 'IDLE')                  return t('caregiver.wearerStatusResting');
  if (upper === 'LAYING' || upper === 'SLEEPING')               return t('caregiver.wearerStatusSleeping');
  return activity;
}

/** Two-letter initials from a full name ("Mostafa Genidy" → "MG"). */
function initialsOf(name: string | null | undefined): string {
  if (!name) return '?';
  return name.split(/\s+/).slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
}

/** "Today · Mon 24 May" — same eyebrow format the wearer Home uses,
 *  so both home screens share the PageHeader date-eyebrow convention. */
function todayLabel(t: (k: string) => string, locale: string): string {
  const now = new Date();
  const day = now.toLocaleDateString(locale, { weekday: 'short' });
  const date = now.getDate();
  const month = now.toLocaleDateString(locale, { month: 'short' });
  return `${t('caregiver.todayPrefix')} · ${day} ${date} ${month}`;
}

/** Compact "X min ago" / "Xh ago" — used in the wearer row sub-line,
 *  matches the design's "2 min ago" / "1 min ago" copy. */
function fmtMinAgo(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return t('caregiver.timeSecondsAgo', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('caregiver.timeMinutesAgo', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('caregiver.timeHoursAgo', { n: h });
  return t('caregiver.timeDaysAgo', { n: Math.floor(h / 24) });
}

/** One of the three stat tiles at the top of the dashboard. White
 *  card with a subtle 1 px border + low-elevation shadow, exactly
 *  matching the design source's `.stat-card` (bg=#fff, border=warm
 *  paper grey, box-shadow rgba(20,24,35,0.04) 0 1px 2px). The
 *  content stacks label / big serif-number / foot. */
function StatColumn({ label, value, foot, footTone = 'mute' }: {
  label: string;
  value: string | number;
  foot: string;
  footTone?: 'mute' | 'success' | 'danger';
}) {
  const { palette } = useDesignTokens();
  const footColor =
    footTone === 'success' ? palette.successInk
    : footTone === 'danger' ? palette.dangerInk
    : palette.text3;
  return (
    <Card padding={14} style={{ flex: 1, gap: 6 }}>
      <Text style={{
        fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12,
        color: palette.text2, letterSpacing: 0.1,
      }}>{label}</Text>
      <Text style={{
        fontFamily: fontFamily.display, fontSize: 30, lineHeight: 34,
        letterSpacing: -1, color: palette.text,
      }}>{value}</Text>
      <Text style={{
        fontFamily: fontFamily.mono, fontSize: 11, color: footColor,
      }}>{foot}</Text>
    </Card>
  );
}

export default function CaregiverDashboardScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const { alerts, setAlerts, addAlert } = useAlertsStore();
  const [wearers, setWearers] = useState<LinkedWearer[]>([]);
  const [vitalsByWearer, setVitalsByWearer] = useState<Record<string, VitalsRow | null>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const timeAgo = useTimeAgo();

  const firstName = profile?.full_name?.split(' ')[0] || t('assistant.welcomeFallbackName');
  const hour = new Date().getHours();
  const greetingKey =
    hour < 12 ? 'caregiver.greetingMorning'
    : hour < 18 ? 'caregiver.greetingAfternoon'
    : hour < 22 ? 'caregiver.greetingEvening'
    : 'caregiver.greetingNight';

  const loadWearers = useCallback(async () => {
    if (!profile?.id) return;
    setError(false);
    try {
      const data = await getLinkedWearers(profile.id);
      const list = data as unknown as LinkedWearer[];
      setWearers(list);
      const pairs = await Promise.all(
        list.map(async (w) => [w.wearer.id, await getLatestVitals(w.wearer.id).catch(() => null)] as const),
      );
      const map: Record<string, VitalsRow | null> = {};
      for (const [id, v] of pairs) map[id] = v;
      setVitalsByWearer(map);
    } catch (err) {
      console.error('Failed to load wearers:', err);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [profile?.id]);

  const loadAlerts = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const data = await getAlertsForCaregiver(profile.id);
      setAlerts(data);
    } catch (err) {
      console.error('Failed to load alerts:', err);
    }
  }, [profile?.id, setAlerts]);

  /** Manual refresh — fired by tapping the hero card's live badge.
   *  Re-pulls wearers+vitals and alerts in parallel; the `refreshing`
   *  flag only drives the badge's "syncing…" state (never the full
   *  skeleton, which is gated on `loading`). */
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([loadWearers(), loadAlerts()]);
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, loadWearers, loadAlerts]);

  useEffect(() => {
    loadWearers();
    loadAlerts();
  }, [loadWearers, loadAlerts]);

  /** Realtime — alerts + vitals updates for any linked wearer. */
  useEffect(() => {
    if (wearers.length === 0) return;
    const wearerIds = wearers.map((w) => w.wearer.id);
    const channel = supabase
      .channel('caregiver-dashboard')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, (payload) => {
        const newAlert = payload.new as Alert;
        if (wearerIds.includes(newAlert.wearer_id)) addAlert(newAlert);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'vitals' }, (payload) => {
        const v = payload.new as VitalsRow;
        if (wearerIds.includes(v.user_id)) {
          setVitalsByWearer((prev) => ({ ...prev, [v.user_id]: v }));
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [wearers, addAlert]);

  const activeAlerts = useMemo(() => alerts.filter((a) => a.status === 'active'), [alerts]);
  const activeAlertCount = activeAlerts.length;
  const headlineAlert = useMemo(() => {
    if (activeAlerts.length === 0) return undefined;
    return [...activeAlerts].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )[0];
  }, [activeAlerts]);
  const headlineWearer = useMemo(() => {
    if (!headlineAlert) return undefined;
    return wearers.find((w) => w.wearer.id === headlineAlert.wearer_id);
  }, [headlineAlert, wearers]);
  // Most-recent active alert per wearer — drives the row's danger styling
  // AND the pill label, so a geofence / SOS / cardiac alert shows its real
  // title instead of a hardcoded "Possible fall".
  const activeAlertByWearer = useMemo(() => {
    const m = new Map<string, Alert>();
    for (const a of [...activeAlerts].sort((x, y) =>
      new Date(y.created_at).getTime() - new Date(x.created_at).getTime())) {
      if (!m.has(a.wearer_id)) m.set(a.wearer_id, a);
    }
    return m;
  }, [activeAlerts]);

  if (loading) return <CaregiverDashboardSkeleton />;
  if (error) {
    return (
      <ErrorState
        title={t('errors.failedToLoad')}
        message={t('errors.checkConnection')}
        onRetry={() => { setLoading(true); loadWearers(); loadAlerts(); }}
      />
    );
  }

  const wearerCount = wearers.length;
  const recentCheckInCount = Object.values(vitalsByWearer).filter((v) => {
    if (!v) return false;
    return Date.now() - new Date(v.recorded_at).getTime() < 60_000;
  }).length;
  /** "Open alerts" sub-line — matches design source:
   *    0 alerts → "all clear"  (green, regardless of wearer count)
   *    >0 alerts → "needs you" (red) */
  const openAlertsSub = activeAlertCount === 0
    ? t('caregiver.statSubAllClear')
    : t('caregiver.statSubNeedsYou');
  const openAlertsTone: 'mute' | 'success' | 'danger' =
    activeAlertCount > 0 ? 'danger' : 'success';

  const headlinePlace: string | null = (() => {
    if (!headlineAlert) return null;
    const md = headlineAlert.metadata as { place?: string; address?: string } | null;
    return md?.place || md?.address || null;
  })();

  const callWearer = () => {
    const phone = headlineWearer?.wearer.phone;
    if (!phone) return;
    Linking.openURL(`tel:${phone}`).catch(console.error);
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* Same PageHeader scaffold as the wearer Home: date eyebrow +
          greeting title, then a ScreenBody scroll region. */}
      <PageHeader eyebrow={todayLabel(t, i18n.language === 'ar' ? 'ar' : 'en-US')} title={t(greetingKey, { name: firstName })} />
      <ScreenBody gap={spacing.s4}>
        {/* Hero body — three modes. */}
        {headlineAlert ? (
          /* Active-alert hero — proper card with danger-soft bg +
             1 px border + low-elevation shadow, matching the design
             source's `.card` with bg=oklch(0.95 0.035 28). */
          <View style={{
            backgroundColor: palette.dangerSoft,
            borderRadius: radius.md,
            borderWidth: 1, borderColor: palette.dangerSoft,
            paddingHorizontal: 16, paddingVertical: 16,
            shadowColor: '#141823',
            shadowOpacity: 0.04,
            shadowOffset: { width: 0, height: 1 },
            shadowRadius: 2,
            elevation: 1,
          }}>
            <Text style={{
              fontFamily: fontFamily.mono, fontSize: 11, color: palette.dangerInk,
              opacity: 0.85, marginBottom: 6,
            }}>
              {t('caregiver.activeAlertEyebrow', { ago: timeAgo(headlineAlert.created_at) })}
            </Text>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 22, lineHeight: 28,
              letterSpacing: -0.4, color: palette.dangerInk,
            }}>
              {alertTitle(headlineAlert.type, t)}
              {headlineWearer ? ` — ${headlineWearer.wearer.full_name.split(' ')[0]}` : ''}
            </Text>
            {(headlineAlert.confidence != null || headlinePlace) && (
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 12, color: palette.dangerInk,
                opacity: 0.85, marginTop: 6,
              }}>
                {[
                  headlineAlert.confidence != null
                    ? t('caregiver.fusionNetConfidence', { value: headlineAlert.confidence.toFixed(2) })
                    : null,
                  headlinePlace
                    ? t('caregiver.locationLine', { place: headlinePlace })
                    : null,
                ].filter(Boolean).join(' · ')}
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
              <Pressable
                onPress={callWearer}
                disabled={!headlineWearer?.wearer.phone}
                style={({ pressed }) => ({
                  flex: 1, height: 42, borderRadius: radius.pill,
                  backgroundColor: palette.danger,
                  alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row', gap: 8,
                  opacity: !headlineWearer?.wearer.phone ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                <AuthIcon name="phone-call" color={palette.textOnDanger} size={15} />
                <Text style={{
                  fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13.5,
                  color: palette.textOnDanger,
                }}>{t('caregiver.callNow')}</Text>
              </Pressable>
              <Pressable
                onPress={() => router.push({
                  pathname: '/(shared)/alert-detail',
                  params: { alertId: headlineAlert.id },
                })}
                style={({ pressed }) => ({
                  flex: 1, height: 42, borderRadius: radius.pill,
                  backgroundColor: palette.surface,
                  borderWidth: 1, borderColor: palette.dangerSoft,
                  alignItems: 'center', justifyContent: 'center',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{
                  fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13.5,
                  color: palette.dangerInk,
                }}>{t('caregiver.viewDetails')}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          /* Hero card — white card with subtle border + shadow, per
             the design source. Contains an uppercase RIGHT NOW + live
             pill row, the big display headline, and a muted line. The
             whole card is tappable to manually re-pull data; the live
             badge flips to "syncing…" while in flight. */
          <Pressable
            onPress={handleRefresh}
            disabled={refreshing}
            accessibilityRole="button"
            accessibilityLabel={t('caregiver.tapToRefresh')}
            style={({ pressed }) => ({
              backgroundColor: palette.surface,
              borderWidth: 1, borderColor: palette.border,
              borderRadius: radius.md,
              paddingHorizontal: 20, paddingVertical: 18,
              shadowColor: '#141823',
              shadowOpacity: 0.04,
              shadowOffset: { width: 0, height: 1 },
              shadowRadius: 2,
              elevation: 1,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View style={{
              flexDirection: 'row', justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <Text style={{
                fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
                letterSpacing: 1.2, textTransform: 'uppercase', fontWeight: '500',
              }}>{t('caregiver.rightNow')}</Text>
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 4,
                opacity: refreshing ? 0.5 : 1,
              }}>
                <AuthIcon name="refresh" color={palette.successInk} size={12} />
                <Text style={{
                  fontFamily: fontFamily.mono, fontSize: 10, color: palette.successInk,
                  letterSpacing: 0.3, fontWeight: '500',
                }}>{refreshing ? t('caregiver.syncing') : t('caregiver.liveBadge')}</Text>
              </View>
            </View>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 34, lineHeight: 40,
              letterSpacing: -0.8, color: palette.text, marginTop: 14,
              maxWidth: 280,
            }}>
              {wearerCount === 0
                ? t('caregiver.bannerNothingToWatch')
                : t('caregiver.bannerAllSafe')}
            </Text>
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2,
              marginTop: 8,
            }}>
              {wearerCount === 0
                ? t('caregiver.bannerEmptyAction')
                : recentCheckInCount === 1
                  ? t('caregiver.bannerCheckedIn_one')
                  : t('caregiver.bannerCheckedIn_other', { count: recentCheckInCount })}
            </Text>
          </Pressable>
        )}

        {/* Two white stat cards in a row — Linked + Open alerts.
            Subtle border + shadow from the Card primitive. */}
        <View style={{
          flexDirection: 'row', gap: 8,
        }}>
          <StatColumn
            label={t('caregiver.statLinked')}
            value={wearerCount}
            foot={t('caregiver.statLinkedSub')}
          />
          <StatColumn
            label={t('caregiver.statOpenAlerts')}
            value={activeAlertCount}
            foot={openAlertsSub}
            footTone={openAlertsTone}
          />
        </View>

        {/* Wearers section — header + Add, then the list/empty, all in
            one ScreenBody child so the header sits tight to its list
            while the uniform gap separates it from the stats above. */}
        <View>
        <View style={{
          flexDirection: 'row', alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}>
          <Text style={{
            fontFamily: fontFamily.sansSemibold, fontSize: 16, fontWeight: '600',
            color: palette.text, letterSpacing: -0.3,
          }}>
            {t('caregiver.wearersSection')}
          </Text>
          {wearerCount > 0 && (
            <Pressable
              onPress={() => router.push('/(shared)/manage-links')}
              hitSlop={6}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 4,
                paddingHorizontal: 6, paddingVertical: 4,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <AuthIcon name="plus" color={palette.accentInk} size={14} />
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 13, fontWeight: '500',
                color: palette.accentInk,
              }}>{t('caregiver.addWearerLabel')}</Text>
            </Pressable>
          )}
        </View>

        {wearerCount > 0 ? (
          /* Wearer rows — each is a white card with subtle border +
             shadow, containing avatar + name + (♥ bpm · time ago)
             sub-line, plus an activity status Pill on the right. In
             alert state the card flips to danger-soft with the alert
             title in the pill. */
          <View style={{ gap: 12 }}>
            {wearers.map((link) => {
              const wearerAlert = activeAlertByWearer.get(link.wearer.id);
              const inAlert = !!wearerAlert;
              const v = vitalsByWearer[link.wearer.id];
              const bpm = v?.heart_rate;
              const activity = v?.activity;
              // "Online" = a vital within the last 5 min (same window as
              // wearer-detail). An offline wearer must NOT show "Live"/an
              // activity — it shows a neutral "Offline" pill instead.
              const online = !!v?.recorded_at && (Date.now() - new Date(v.recorded_at).getTime() < 5 * 60_000);
              /** Sub-line is ♥ bpm · time-ago (NOT activity — that
               *  goes to the right pill). Fallback when no recent
               *  vital exists. */
              const subLineParts: string[] = [];
              if (typeof bpm === 'number') subLineParts.push(t('caregiver.wearerHeartRate', { bpm: Math.round(bpm) }));
              if (v?.recorded_at) subLineParts.push(fmtMinAgo(v.recorded_at, t));
              const subLine = inAlert
                ? t('caregiver.wearerActiveAlert')
                : subLineParts.length > 0
                  ? subLineParts.join(' · ')
                  : t('caregiver.wearerNoVital');
              /** Right-side Pill — activity status when safe; the
               *  active alert's type when in alert. */
              const pillLabel = wearerAlert
                ? alertTitle(wearerAlert.type, t)
                : !online
                  ? t('caregiver.wearerStatusOffline')
                  : activity
                    ? activityLabel(activity, t)
                    : t('caregiver.wearerStatusLive');
              const pillVariant: 'danger' | 'success' | 'default' = inAlert
                ? 'danger'
                : online ? 'success' : 'default';
              return (
                <Pressable
                  key={link.id}
                  onPress={() => router.push({
                    pathname: '/(shared)/wearer-detail',
                    params: {
                      id: link.wearer.id,
                      name: link.wearer.full_name,
                      phone: link.wearer.phone || '',
                    },
                  })}
                  style={({ pressed }) => ({
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    backgroundColor: inAlert ? palette.dangerSoft : palette.surface,
                    borderWidth: 1, borderColor: inAlert ? palette.dangerSoft : palette.border,
                    borderRadius: radius.md,
                    paddingHorizontal: 14, paddingVertical: 14,
                    shadowColor: '#141823',
                    shadowOpacity: 0.04,
                    shadowOffset: { width: 0, height: 1 },
                    shadowRadius: 2,
                    elevation: 1,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  {link.wearer.avatar_url ? (
                    <Avatar.Image size={44} source={{ uri: link.wearer.avatar_url }} />
                  ) : (
                    <Avatar.Text
                      size={44}
                      label={initialsOf(link.wearer.full_name)}
                      // Avatar stays neutral accent-soft in both safe AND
                      // alert states — design lets the red card carry the
                      // urgency, not the avatar itself.
                      style={{ backgroundColor: palette.accentSoft }}
                      color={palette.accentInk}
                      labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
                    />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15,
                      color: inAlert ? palette.dangerInk : palette.text,
                    }}>
                      {link.wearer.full_name}
                    </Text>
                    <Text style={{
                      fontFamily: fontFamily.mono, fontSize: 12,
                      color: inAlert ? palette.dangerInk : palette.text3,
                      marginTop: 4,
                    }}>
                      {subLine}
                    </Text>
                  </View>
                  <Pill variant={pillVariant} dot>{pillLabel}</Pill>
                </Pressable>
              );
            })}
          </View>
        ) : (
          /* Empty state — card-less (matches the alerts empty state):
             accent user-plus tile + sans title + copy + a "Check
             invites" tonal pill action. paddingVertical gives it room
             below the Wearers header since content sits above it. */
          <View style={{ paddingVertical: 20 }}>
            <EmptyState
              iconNode={<AuthIcon name="user-plus" color={palette.accentInk} size={26} />}
              iconVariant="accent"
              title={t('caregiver.emptyNoWearers')}
              description={t('caregiver.emptyDesc')}
              action={
                <Pressable
                  onPress={() => router.push('/(shared)/manage-links')}
                  style={({ pressed }) => ({
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    paddingHorizontal: 18, height: 42,
                    borderRadius: radius.pill,
                    backgroundColor: palette.accentSoft,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <AuthIcon name="link" color={palette.accentInk} size={16} />
                  <Text style={{
                    fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13,
                    color: palette.accentInk, letterSpacing: -0.07,
                  }}>
                    {t('caregiver.emptyEnterCodeText')}
                  </Text>
                </Pressable>
              }
            />
          </View>
        )}
        </View>
      </ScreenBody>
    </SafeAreaView>
  );
}
