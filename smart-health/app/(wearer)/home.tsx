import { View, Vibration, Pressable, SafeAreaView, Text } from 'react-native';
// `Vibration` retained for the SOS countdown buzz; the fall-detect
// buzz moved to FallOverlayHost.
import * as Haptics from 'expo-haptics';
import { Portal, Dialog, Snackbar, Button } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { PairWatchDialog } from '@/components/PairWatchDialog';
import { AuthInput } from '@/components/AuthControls';
import { updateProfile } from '@/services/auth.service';
import { AuthIcon } from '@/components/AuthControls';
import { useAuthStore } from '@/stores/auth.store';
import { useVitalsStore } from '@/stores/vitals.store';
import { useDeviceStore } from '@/stores/device.store';
import { useActivityHistoryStore } from '@/stores/activity-history.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { createAlertWithOfflineSupport } from '@/services/offline-queue.service';
import { placeEmergencyCall } from '@/services/emergency-call';
import { startMockVitals, stopMockVitals } from '@/services/mock-vitals.service';
import { startLocationTracking, stopLocationTracking, getCurrentPosition } from '@/services/location.service';
import { useFallAlertStore } from '@/stores/fall-alert.store';
import { useAchievementsStore } from '@/stores/achievements.store';
import { getUserAchievements, checkAndUnlockAchievements } from '@/services/achievement.service';
import { getLinkedCaregivers } from '@/services/link.service';
import {
  useDesignTokens, PageHeader, ScreenBody, Card, Banner, StatCard,
  IconDot, Progress, FabSos, BtnTonal, TrendTag,
  Ring, SectionTitle,
} from '@/design';
import { fontFamily, spacing, radius } from '@/design/tokens';

/** Small refresh badge for the top-right corner of the SpO₂ / ECG
 *  tiles — silent visual signal that those readings are user-
 *  initiated and stay frozen until the user retakes them on the
 *  watch. Sits next to the live-streaming HR / Temp tiles which
 *  intentionally have no badge. */
function RetakeBadge({ color }: { color: string }) {
  return (
    <View style={{ width: 16, height: 16, alignItems: 'center', justifyContent: 'center' }}>
      <MaterialCommunityIcons name="refresh" size={14} color={color} />
    </View>
  );
}

type TFunc = (k: string, o?: Record<string, unknown>) => string;

/** "5s ago" / "3m ago" / "2h ago" / "1d ago" style, localized. */
function formatRelativeTime(epochMs: number, t: TFunc): string {
  const diff = Math.max(0, Date.now() - epochMs);
  const s = Math.round(diff / 1000);
  if (s < 5) return t('wearerHome.justNow');
  if (s < 60) return t('wearerHome.secsAgo', { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t('wearerHome.minsAgo', { n: m });
  const h = Math.round(m / 60);
  if (h < 24) return t('wearerHome.hrsAgo', { n: h });
  const d = Math.round(h / 24);
  return t('wearerHome.daysAgo', { n: d });
}

/** Friendly date string: "Today · Mon 24 May" (locale-aware month/weekday). */
function todayLabel(t: TFunc, locale: string): string {
  const now = new Date();
  const day = now.toLocaleDateString(locale, { weekday: 'short' });
  const date = now.getDate();
  const month = now.toLocaleDateString(locale, { month: 'short' });
  return `${t('wearerHome.today')} · ${day} ${date} ${month}`;
}

export default function WearerHomeScreen() {
  const { palette } = useDesignTokens();
  const profile = useAuthStore((s) => s.profile);
  const setProfile = useAuthStore((s) => s.setProfile);
  const {
    heartRate, spo2, spo2At, temperature,
    ecgClass, ecgConfidence, ecgAt,
    steps, currentActivity, lastUpdated,
  } = useVitalsStore();
  const { isConnected } = useDeviceStore();
  const { addAlert } = useAlertsStore();
  const { t, i18n } = useTranslation();

  const [showSOSConfirm, setShowSOSConfirm] = useState(false);
  const [sosCountdown, setSOSCountdown] = useState<number | null>(null);
  const [sosSending, setSOSSending] = useState(false);
  const [sosSent, setSOSSent] = useState(false);
  /** Pair-watch dialog shown when the wellness banner's [Pair] button
   *  is tapped — animated searching → found → pairing → paired flow
   *  that flips demo mode on internally so the rest of the UI lights
   *  up as if a real watch had connected. */
  const [showPairDialog, setShowPairDialog] = useState(false);
  /** Edit-step-goal dialog state — opens from the Steps card's
   *  "Goal · 6,000" pill. */
  const [showGoalDialog, setShowGoalDialog] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [savingGoal, setSavingGoal] = useState(false);

  const openGoalDialog = () => {
    setGoalDraft(String(profile?.step_goal ?? 6000));
    setShowGoalDialog(true);
  };
  const saveStepGoal = async () => {
    if (!profile?.id) return;
    const parsed = parseInt(goalDraft, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) { setShowGoalDialog(false); return; }
    setSavingGoal(true);
    try {
      const updated = await updateProfile(profile.id, { step_goal: parsed });
      setProfile(updated);
      setShowGoalDialog(false);
    } catch (err) {
      console.warn('[home] step goal save failed', err);
    } finally {
      setSavingGoal(false);
    }
  };
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Fall countdown / overlay state was lifted to the root layout
  // (useFallAlertStore) so the overlay covers every tab + screen,
  // not just Home. See `app/_layout.tsx` + `FallOverlayHost`.
  const fallCountdown = useFallAlertStore((s) => s.countdown);

  const demoMode = useDeviceStore((s) => s.demoMode);
  const todayMix = useActivityHistoryStore((s) => s.todayMix);

  // Activity mix — same math as the Activity tab, lifted up to Home
  // since rhythm/mix only describe TODAY (no per-day historical mix
  // is stored). Empty state shown until the first reading lands.
  const mixTotal = todayMix.walking + todayMix.jogging + todayMix.resting;
  const activePct = mixTotal > 0
    ? Math.round(((todayMix.walking + todayMix.jogging) / mixTotal) * 100)
    : 0;
  const fmtMin = (m: number) =>
    m >= 60
      ? t('common.hoursMinutes', { h: Math.floor(m / 60), m: m % 60 })
      : t('common.minutesOnly', { m });

  const firstName = profile?.full_name?.split(' ')[0] || t('wearerHome.friend');
  // Pull the wearer's daily target from the profile (column added in
  // migration 008). Falls back to 6000 if the row pre-dates the column.
  const stepGoal = profile?.step_goal ?? 6000;
  const stepProgress = Math.min(steps / stepGoal, 1);

  /** Treat demo mode as a real connection so the rest of the UI (status
   *  pill, IconDot, label) mirrors a paired watch. Demo is toggled
   *  from Settings → Device & preferences. */
  const connected = isConnected || demoMode;

  /** Combined wellness + connection status. Replaces the old pair of
   *  stacked cards (wellness banner + watch-connection card).
   *
   *  Four states layered onto the same banner shape:
   *    1. Not connected          → default tone, "Pair a watch…" sub,
   *                                right = Pair button.
   *    2. Connected, no readings → default tone, "Waiting on first
   *                                reading", right = Live pill.
   *    3. Connected, all in range → accent (sage) tone, "Currently
   *                                  {activity} · last sync Xm ago",
   *                                  right = Live pill.
   *    4. Connected, something off → warning tone, "Something to check
   *                                   · last sync Xm ago",
   *                                   right = Live pill. */
  const banner = (() => {
    const h = new Date().getHours();
    const partOfDay =
      h < 12 ? 'morning'
      : h < 18 ? 'afternoon'
      : h < 22 ? 'evening'
      : 'night';
    const greeting = t(`wearerHome.greeting${partOfDay[0].toUpperCase()}${partOfDay.slice(1)}`);
    const a = (currentActivity || 'resting').toLowerCase();
    const activityLabel = a.includes('walk') ? t('wearerHome.actWalking')
      : (a.includes('jog') || a.includes('run')) ? t('wearerHome.actJogging')
      : a.includes('station') ? t('wearerHome.actStationary')
      : t('wearerHome.actResting');

    if (!connected) {
      return {
        title: greeting,
        sub: t('wearerHome.pairToStart'),
        variant: 'default' as const,
        watchIcon: 'watch-off' as const,
        showPair: true,
      };
    }

    const hasReadings = lastUpdated != null
      && (heartRate != null || spo2 != null || temperature != null);

    if (!hasReadings) {
      return {
        title: greeting,
        sub: t('wearerHome.waitingFirstReading'),
        variant: 'default' as const,
        watchIcon: 'watch' as const,
        showPair: false,
      };
    }

    // Thresholds match the tile foot-text bands below so a tile that
    // reads "Elevated" trips the banner warning too. Sources:
    //   HR  60-100 adult resting, AHA
    //   SpO₂ ≥ 95 normal
    //   Temp 36.0-37.5 °C (mild fever above)
    const hrOk   = heartRate == null   || (heartRate >= 60 && heartRate <= 100);
    const spo2Ok = spo2 == null        || spo2 >= 95;
    const tempOk = temperature == null || (temperature >= 36.0 && temperature <= 37.5);
    const allOk = hrOk && spo2Ok && tempOk;
    const sync = formatRelativeTime(lastUpdated, t);

    if (allOk) {
      return {
        title: t('wearerHome.allLookingGood'),
        sub: t('wearerHome.bannerCurrently', { activity: activityLabel, time: sync }),
        variant: 'accent' as const,
        watchIcon: 'watch' as const,
        showPair: false,
      };
    }

    // Name the specific vital that's out of range — vague "Something
    // to check" left the user guessing. Multiple issues collapse to
    // "Vitals out of range". The watch is still connected in this
    // state, so the icon stays `watch` (not `watch-off`).
    const issues: string[] = [];
    if (heartRate != null && heartRate > 100) issues.push(t('wearerHome.issueHrElevated'));
    else if (heartRate != null && heartRate < 60) issues.push(t('wearerHome.issueHrLow'));
    if (spo2 != null && spo2 < 95) issues.push(t('wearerHome.issueSpo2Low'));
    if (temperature != null && temperature > 37.5) issues.push(t('wearerHome.issueTempElevated'));
    else if (temperature != null && temperature < 36.0) issues.push(t('wearerHome.issueTempLow'));

    const headline = issues.length === 1 ? issues[0]
      : issues.length > 1 ? t('wearerHome.issueMultiple')
      : t('wearerHome.issueGeneric');

    return {
      title: t('wearerHome.worthALookTitle'),
      sub: t('wearerHome.bannerWarningSub', { headline, time: sync }),
      variant: 'warning' as const,
      watchIcon: 'watch' as const,
      showPair: false,
    };
  })();
  // sparkline removed in grid layout — see git history if you want it back.

  // Simple step-trend tag: compare today to yesterday (placeholder until we
  // have a 7-day buffer in vitals.store).
  const stepTrend: { text: string; dir: 'up' | 'down' } | null = steps > 0
    ? { text: t('wearerHome.pctOfGoal', { pct: Math.round(stepProgress * 100) }), dir: stepProgress >= 0.5 ? 'up' : 'down' }
    : null;

  // Foot text — kept short so the 2×2 tile grid doesn't wrap on
  // narrow phones. Caregiver/Wearer Detail uses the longer copy.
  const hrStatusText = heartRate == null
    ? '—'
    : heartRate < 60 ? t('wearerHome.low')
    : heartRate > 100 ? t('wearerHome.elevated')
    : t('wearerHome.normal');
  // Temp streams continuously from the watch (skin temp sensor),
  // same as HR — so the empty state is "—" not "Tap to measure"
  // (which is the SpO₂/ECG idiom for user-initiated readings).
  const tempStatusText = temperature == null
    ? '—'
    : temperature < 36 ? t('wearerHome.low')
    : temperature > 37.5 ? t('wearerHome.elevated')
    : t('wearerHome.normal');
  // SpO₂ + ECG share the same "tap on watch to measure" pattern —
  // both are user-initiated readings (vs HR/Temp which stream
  // continuously). Foot follows the same shape: status · age.
  const spo2StatusText = spo2 == null
    ? t('wearerHome.tapOnWatch')
    : spo2 >= 95 ? t('wearerHome.normal')
    : t('wearerHome.low');
  const spo2FootText = spo2 != null && spo2At
    ? `${spo2StatusText} · ${formatRelativeTime(spo2At, t)}`
    : spo2StatusText;
  // ECG tile shows the categorical verdict in the value slot (no %
  // because the model's softmax confidence isn't a clinical reading
  // and could be misread as "92 % healthy"). Foot collapses to the
  // age or "Tap on watch" depending on whether a reading exists.
  const ecgValueText = ecgClass == null ? '—'
    : ecgClass === 'normal' ? t('wearerHome.normal')
    : ecgClass === 'irregular' ? t('wearerHome.irregular')
    // 'inconclusive' can still come from the real cardiac pipeline
    // when ecg-session.ts gets a beat with no label (e.g. model
    // skipped due to lead-off); it's not a demo option.
    : t('wearerHome.unclear');
  const ecgFootText = ecgClass != null && ecgAt
    ? formatRelativeTime(ecgAt, t)
    : t('wearerHome.tapOnWatch');

  // Fall detection + overlay are owned by the root layout
  // (`useFallAlertStore` + `FallOverlayHost`). Home only consumes
  // `fallCountdown` above so the floating SOS button can hide while
  // an alert is on-screen.

  // Location tracking
  useEffect(() => {
    if (!profile?.id) return;
    const track = async () => {
      const started = await startLocationTracking(profile.id, profile.full_name || 'Wearer');
      if (!started) return;
    };
    track();
    return () => { stopLocationTracking(); };
  }, [profile?.id]);


  // Achievement checking
  const { addAchievements, newUnlock, setNewUnlock } = useAchievementsStore();
  const [snackVisible, setSnackVisible] = useState(false);

  useEffect(() => {
    if (!profile?.id || !demoMode) return;
    const check = async () => {
      try {
        const existing = await getUserAchievements(profile.id);
        const existingTypes = new Set(existing.map((a) => a.type));
        const vitals = useVitalsStore.getState();
        let linkedCount = 0;
        try {
          const links = await getLinkedCaregivers(profile.id);
          linkedCount = links.length;
        } catch {}
        const accountAge = profile.created_at
          ? Math.floor((Date.now() - new Date(profile.created_at).getTime()) / (1000 * 60 * 60 * 24))
          : 0;
        const newOnes = await checkAndUnlockAchievements(profile.id, {
          steps: vitals.steps || 0,
          heartRate: vitals.heartRate,
          spo2: vitals.spo2,
          temperature: vitals.temperature,
          linkedCaregivers: linkedCount,
          hasName: !!profile.full_name,
          hasPhone: !!profile.phone,
          hasAvatar: !!profile.avatar_url,
          accountAgeDays: accountAge,
        }, existingTypes);
        if (newOnes.length > 0) {
          addAchievements(newOnes);
          setNewUnlock(newOnes[0]);
          setSnackVisible(true);
        }
      } catch (err) {
        console.error('Achievement check failed:', err);
      }
    };
    const interval = setInterval(check, 60000);
    const timeout = setTimeout(check, 5000);
    return () => { clearInterval(interval); clearTimeout(timeout); };
  }, [profile?.id, demoMode, addAchievements, setNewUnlock]);

  // SOS countdown
  useEffect(() => {
    if (sosCountdown === null) return;
    if (sosCountdown <= 0) {
      if (countdownRef.current) clearInterval(countdownRef.current);
      sendSOSAlert();
      return;
    }
    countdownRef.current = setInterval(() => {
      setSOSCountdown((prev) => (prev !== null ? prev - 1 : null));
    }, 1000);
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [sosCountdown]);

  const handleSOSPress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
    setShowSOSConfirm(true);
  };

  const confirmSOS = () => {
    setShowSOSConfirm(false);
    setSOSCountdown(5);
    Vibration.vibrate([0, 200, 100, 200]);
  };

  const cancelSOS = () => {
    setShowSOSConfirm(false);
    setSOSCountdown(null);
    setSOSSent(false);
    if (countdownRef.current) clearInterval(countdownRef.current);
  };

  const sendSOSAlert = async () => {
    if (!profile?.id) return;
    setSOSSending(true);
    try {
      const position = await getCurrentPosition().catch(() => null);
      const { alert } = await createAlertWithOfflineSupport(
        {
          wearer_id: profile.id,
          type: 'sos',
          severity: 'critical',
          metadata: {
            triggered_by: 'manual_sos',
            ...(position && { latitude: position.latitude, longitude: position.longitude }),
          },
        },
        profile.full_name || 'Wearer',
      );
      if (alert) addAlert(alert);
      setSOSSent(true);
      setSOSCountdown(null);
      Vibration.vibrate(500);
    } catch (err) {
      console.error('Failed to send SOS:', err);
      setSOSCountdown(null);
    } finally {
      setSOSSending(false);
    }
    // Auto-call the main emergency contact — independent of the alert result
    // (a call failure must not undo "SOS sent", and vice-versa). Same target
    // and auto-dial as a confirmed fall (main → caregiver → manual).
    try {
      await placeEmergencyCall(
        profile.id,
        profile.emergency_contacts,
        profile.primary_emergency_phone,
      );
    } catch (err) {
      console.error('SOS call failed:', err);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader
        eyebrow={todayLabel(t, i18n.language === 'ar' ? 'ar' : 'en-US')}
        title={t('wearerHome.hello', { name: firstName })}
      />

      <ScreenBody gap={spacing.s3}>
        {/* Combined wellness + connection banner. Drives variant,
            icon, title, sub, and right-widget from the `banner` state
            machine above. Replaces the previous two stacked cards. */}
        {(() => {
          const ink = banner.variant === 'accent' ? palette.accentInk
            : banner.variant === 'warning' ? palette.warningInk
            : palette.text;
          // Right-widget: Pair button only on the disconnected variant.
          // The previous "Live" pill was redundant with the sub line's
          // last-sync age + the accent tone, so we drop it.
          const right = banner.showPair
            ? <BtnTonal size="xs" onPress={() => setShowPairDialog(true)}>
                {t('wearerHome.pair')}
              </BtnTonal>
            : null;
          return (
            <Banner
              variant={banner.variant}
              iconNode={<AuthIcon name={banner.watchIcon} color={ink} size={20} />}
              right={right}
            >
              <View style={{ gap: 2 }}>
                <Text style={{
                  fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13,
                  color: ink,
                }}>
                  {banner.title}
                </Text>
                <Text style={{ fontSize: 11.5, opacity: 0.85, color: ink }}>
                  {banner.sub}
                </Text>
              </View>
            </Banner>
          );
        })()}

        {/* 2×2 grid: continuously-streamed vitals (HR + Temp) on top,
            user-initiated readings (SpO₂ + ECG) on bottom. SpO₂ and
            ECG share the same shape — "Tap on watch" until measured,
            then a value + age in the foot. */}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            icon="heart"
            iconVariant="accent"
            label={t('wearerHome.heartRate')}
            value={heartRate ?? '—'}
            unit={heartRate != null ? 'bpm' : ''}
            foot={hrStatusText}
            valueFontSize={42}
          />
          <StatCard
            icon="thermometer"
            iconVariant="warning"
            label={t('wearerHome.tempShort')}
            value={temperature != null ? temperature.toFixed(1) : '—'}
            unit={temperature != null ? '°C' : ''}
            foot={tempStatusText}
            valueFontSize={42}
          />
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <StatCard
            icon="water"
            iconVariant="info"
            label="SpO₂"
            value={spo2 ?? '—'}
            unit={spo2 != null ? '%' : ''}
            foot={spo2FootText}
            valueFontSize={42}
            topRight={<RetakeBadge color={palette.text3} />}
          />
          <StatCard
            icon="heart-pulse"
            iconVariant="danger"
            label="ECG"
            value={ecgValueText}
            foot={ecgFootText}
            // Smaller font for the wider categorical label
            // ("Irregular"), but pin lineHeight to 42 so this tile's
            // value row matches the height of the numeric tiles in
            // the same grid.
            valueFontSize={ecgClass != null ? 26 : 42}
            valueLineHeight={42}
            topRight={<RetakeBadge color={palette.text3} />}
          />
        </View>

        {/* Steps Today — full-width card with trend tag + progress */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <IconDot icon="shoe-print" variant="accent" size={22} />
              <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 14, color: palette.text }}>
                {t('wearerHome.stepsToday')}
              </Text>
            </View>
            {/* Tiny circular edit affordance — pencil only, no text.
                The goal number moves down next to the big step count
                ("0 of 6,000") so it's still visible without claiming
                a whole pill. */}
            <Pressable
              onPress={openGoalDialog}
              hitSlop={6}
              style={({ pressed }) => ({
                width: 28, height: 28, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? palette.surface2 : palette.surface,
                borderWidth: 1, borderColor: palette.border,
              })}
              accessibilityLabel={t('wearerHome.editStepGoal')}
            >
              <AuthIcon name="pencil" color={palette.text3} size={14} />
            </Pressable>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
            <Text style={{
              fontFamily: fontFamily.display, fontSize: 46, lineHeight: 46, letterSpacing: -1.5,
              color: palette.text,
            }}>
              {steps.toLocaleString()}
            </Text>
            <Text style={{
              fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3,
              marginLeft: 4,
            }}>
              / {stepGoal.toLocaleString()}
            </Text>
            {stepTrend && (
              <View style={{ marginLeft: 'auto' }}>
                <TrendTag direction={stepTrend.dir}>{stepTrend.text}</TrendTag>
              </View>
            )}
          </View>
          <View style={{ marginTop: 10 }}>
            <Progress value={stepProgress} />
          </View>
        </Card>

        {/* Activity mix — donut + 3-class legend, today only.
            Empty state until the first reading lands so we don't
            ship a 0 % ring on first launch. */}
        <Card>
          <SectionTitle>{t('wearerHome.howYouMoved')}</SectionTitle>
          {mixTotal > 0 ? (
            <View style={{ flexDirection: 'row', marginTop: 14, gap: 16, alignItems: 'center' }}>
              <Ring size={92} stroke={11} value={activePct / 100}>
                <Text style={{
                  fontFamily: fontFamily.display, fontSize: 22, lineHeight: 22,
                  letterSpacing: -0.5, color: palette.text,
                }}>{activePct}%</Text>
                <Text style={{
                  fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
                }}>{t('wearerHome.activeShare')}</Text>
              </Ring>
              <View style={{ flex: 1, gap: 10 }}>
                {[
                  { id: 'walking', label: t('wearerHome.mixWalking'), value: fmtMin(todayMix.walking), dot: palette.accent2 },
                  { id: 'jogging', label: t('wearerHome.mixJogging'), value: fmtMin(todayMix.jogging), dot: palette.accent  },
                  { id: 'resting', label: t('wearerHome.mixResting'), value: fmtMin(todayMix.resting), dot: palette.surface3 },
                ].map((row) => (
                  <View key={row.id} style={{
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <View style={{ width: 8, height: 8, borderRadius: 999, backgroundColor: row.dot }} />
                      <Text style={{ fontFamily: fontFamily.sans, fontSize: 13, color: palette.text }}>
                        {row.label}
                      </Text>
                    </View>
                    <Text style={{
                      fontFamily: fontFamily.display, fontSize: 15, color: palette.text,
                    }}>{row.value}</Text>
                  </View>
                ))}
              </View>
            </View>
          ) : (
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3,
              fontStyle: 'italic', marginTop: 10,
            }}>
              {t('wearerHome.waitingFirstReading')}
            </Text>
          )}
        </Card>

        {/* SOS sent confirmation */}
        {sosSent ? (
          <Banner variant="danger" icon="check-circle">
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13, color: palette.dangerInk }}>
                  {t('wearerHome.sosAlertSent')}
                </Text>
                <Text style={{ fontSize: 11.5, color: palette.dangerInk, opacity: 0.85 }}>
                  {t('wearerHome.caregiverHaveBeenNotified')}
                </Text>
              </View>
              <Pressable onPress={() => setSOSSent(false)}>
                <Text style={{ color: palette.dangerInk, fontWeight: '500', fontSize: 12, fontFamily: fontFamily.sansMedium }}>
                  {t('wearerHome.dismiss')}
                </Text>
              </Pressable>
            </View>
          </Banner>
        ) : null}

        <View style={{ height: 70 }} />
      </ScreenBody>

      {/* Floating SOS */}
      {fallCountdown === null && (
        <FabSos onPress={handleSOSPress} label={sosSending ? '…' : 'SOS'} />
      )}

      {/* Fall overlay moved to root layout (FallOverlayHost) so it
          covers every tab + screen. See app/_layout.tsx. */}

      {/* Pair-watch dialog — fake-but-real-looking pairing animation. */}
      <PairWatchDialog
        visible={showPairDialog}
        onClose={() => setShowPairDialog(false)}
      />

      {/* Edit step goal — small dialog that opens from the Steps
          card's "Goal · 6,000" pill. The field used to live in
          Edit Profile but landed there awkwardly next to medical
          settings; surfacing it inline on the card it controls is
          a closer match to how a user actually reasons about it. */}
      <Portal>
        <Dialog
          visible={showGoalDialog}
          onDismiss={() => setShowGoalDialog(false)}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{
            fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text,
          }}>
            {t('wearerHome.stepGoalTitle')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 12, paddingBottom: 20 }}>
            <Text style={{ color: palette.text2, fontFamily: fontFamily.sans, fontSize: 13 }}>
              {t('wearerHome.stepGoalHint')}
            </Text>
            <AuthInput
              icon="target"
              value={goalDraft}
              onChangeText={(v) => setGoalDraft(v.replace(/[^0-9]/g, ''))}
              placeholder={t('wearerHome.stepGoalPlaceholder')}
              keyboardType="numeric"
              maxLength={5}
              returnKeyType="done"
              onSubmitEditing={saveStepGoal}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => setShowGoalDialog(false)}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                color: palette.text2,
              }}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <View style={{ opacity: savingGoal || !goalDraft.trim() ? 0.5 : 1 }}>
              <BtnTonal
                size="sm"
                onPress={savingGoal || !goalDraft.trim() ? undefined : saveStepGoal}
              >
                {savingGoal ? '…' : (t('common.save') || 'Save')}
              </BtnTonal>
            </View>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* SOS confirm dialog */}
      <Portal>
        <Dialog
          visible={showSOSConfirm}
          onDismiss={cancelSOS}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Icon icon="alert-circle" color={palette.danger} size={48} />
          <Dialog.Title style={{
            fontFamily: fontFamily.sansSemibold, fontWeight: '600',
            color: palette.text, textAlign: 'center',
          }}>{t('wearerHome.sendSOS') + '?'}</Dialog.Title>
          <Dialog.Content>
            <Text style={{
              textAlign: 'center', color: palette.text2,
              fontFamily: fontFamily.sans, fontSize: 13, lineHeight: 19,
            }}>
              {t('wearerHome.sendSOSConfirm')}
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={cancelSOS}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                color: palette.text2,
              }}>
                {t('common.cancel')}
              </Text>
            </Pressable>
            <BtnTonal size="sm" tone="danger" onPress={confirmSOS}>
              {t('wearerHome.sendSOS')}
            </BtnTonal>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* SOS countdown — prominent modal (replaces the old inline banner) */}
      <Portal>
        <Dialog
          visible={sosCountdown !== null && sosCountdown > 0}
          dismissable={false}
          onDismiss={cancelSOS}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Icon icon="timer-sand" color={palette.danger} size={48} />
          <Dialog.Title style={{
            fontFamily: fontFamily.sansSemibold, fontWeight: '600',
            color: palette.text, textAlign: 'center',
          }}>
            {t('wearerHome.sendingSOSIn', { seconds: sosCountdown ?? 0 })}
          </Dialog.Title>
          <Dialog.Content>
            <Text style={{
              textAlign: 'center', color: palette.text2,
              fontFamily: fontFamily.sans, fontSize: 13, lineHeight: 19,
            }}>
              {t('wearerHome.caregiverNotified')}
            </Text>
          </Dialog.Content>
          <Dialog.Actions style={{ justifyContent: 'center' }}>
            <BtnTonal onPress={cancelSOS}>{t('common.cancel')}</BtnTonal>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={snackVisible}
        onDismiss={() => setSnackVisible(false)}
        duration={4000}
        action={{ label: t('common.ok'), onPress: () => setSnackVisible(false) }}
      >
        {newUnlock ? `🏆 ${t('achievements.newUnlock')}` : ''}
      </Snackbar>
    </SafeAreaView>
  );
}

