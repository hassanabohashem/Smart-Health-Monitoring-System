import { View, SafeAreaView, Text, Platform, Pressable } from 'react-native';
import { Avatar, Portal, Dialog, Button } from 'react-native-paper';
import { AuthInput } from '@/components/AuthControls';
import Constants from 'expo-constants';
import { useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useAuthStore } from '@/stores/auth.store';
import { useDeviceStore, type DemoLevel, type DemoEcg, type DemoActivity } from '@/stores/device.store';
import { useVitalsStore } from '@/stores/vitals.store';
import { useFallAlertStore } from '@/stores/fall-alert.store';
import { useThemeStore } from '@/stores/theme.store';
import { signOut } from '@/services/auth.service';
import { PairWatchDialog } from '@/components/PairWatchDialog';
import { sendInvitation, getLinkedCaregivers, getSentInvitations } from '@/services/link.service';
import { startMockVitals, stopMockVitals } from '@/services/mock-vitals.service';
import { useActivityHistoryStore } from '@/stores/activity-history.store';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '@/i18n';
import {
  useDesignTokens, PageHeader, ScreenBody, Card, ListRow, Toggle,
  Eyebrow, BtnTonal, Pill, Toast, useToast,
} from '@/design';
import { fontFamily, spacing, radius } from '@/design/tokens';

/** A row with a label on the left and a generic N-way pill segmented
 *  control on the right. Used by the demo-config section to tune
 *  what the mock vitals stream simulates. Generic over the option
 *  value type so we can reuse it for the Low/Mid/High intensity
 *  vitals and the categorical ECG row in a single component.
 *  Labels and option text are passed in pre-localized by the parent. */
function DemoSegmentRow<T extends string>({
  label, hint, value, onChange, options,
}: {
  label: string;
  hint: string;
  value: T;
  onChange: (next: T) => void;
  options: { id: T; label: string }[];
}) {
  const { palette } = useDesignTokens();
  const opts = options;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13, color: palette.text }}>
          {label}
        </Text>
        <Text style={{ fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3 }}>
          {hint}
        </Text>
      </View>
      <View style={{
        flexDirection: 'row', backgroundColor: palette.surface2,
        borderRadius: 999, padding: 3, gap: 2,
      }}>
        {opts.map((o) => {
          const active = o.id === value;
          return (
            <Pressable
              key={o.id}
              onPress={() => onChange(o.id)}
              style={({ pressed }) => ({
                flex: 1, height: 30, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: active ? palette.surface : 'transparent',
                opacity: !active && pressed ? 0.6 : 1,
              })}
            >
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 12,
                fontWeight: '500',
                color: active ? palette.text : palette.text2,
              }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function WearerSettingsScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const {
    isConnected, batteryLevel, device, demoMode, setDemoMode,
    demoConfig, setDemoConfig,
  } = useDeviceStore();
  /** Treat any vitals streaming as a live link too (covers demo mode,
   *  where mockVitals updates the store but no real bluetooth device
   *  is paired). Same trick used on the Today tab connection card. */
  const heartRate = useVitalsStore((s) => s.heartRate);
  const watchLive = isConnected || demoMode || heartRate != null;

  /** Flip demo mode: starts/stops the mock vitals stream and seeds
   *  the activity-history store so charts have data immediately. */
  const handleToggleDemo = (enabled: boolean) => {
    setDemoMode(enabled);
    const history = useActivityHistoryStore.getState();
    if (enabled) {
      startMockVitals(profile?.id);
      history.seedDemo();
    } else {
      stopMockVitals(profile?.id);
      history.reset();
    }
  };

  const { isDarkMode, toggleDarkMode } = useThemeStore();
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;
  /** Label hierarchy — works for any paired watch, not just the dev
   *  default Galaxy Watch 5: prefer the real device name from Supabase
   *  if a `devices` row exists, fall back to a generic "Smartwatch"
   *  when something is streaming but no record has been written yet,
   *  and finally an explicit "No watch paired" when offline. */
  const watchName = device?.name
    ?? (watchLive ? t('settings.watchSmartwatch') : t('settings.watchNoPaired'));
  const batteryText = batteryLevel != null
    ? t('settings.watchBatteryPct', { pct: batteryLevel })
    : t('settings.watchBatteryUnknown');
  const watchSub = watchLive
    ? t('settings.watchPairedBattery', { battery: batteryText })
    : t('settings.watchTapToPair');
  const [caregiverCount, setCaregiverCount] = useState(0);
  const [showPairDialog, setShowPairDialog] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [sendingInvite, setSendingInvite] = useState(false);
  const { snack, show: showToast, dismiss: dismissToast } = useToast();

  // Count linked caregivers too, not just manually-added contacts: caregivers
  // are emergency contacts (alerted + callable on an SOS/fall), so the row
  // reflects everyone who'd be contacted — and a caregiver-only wearer never
  // reads "No contacts". `caregiverCount` is already fetched above for the
  // Linked-caregivers row.
  const manualContactCount = ((profile?.emergency_contacts as { name: string; phone: string }[] | null) || []).length;
  const emergencyContactCount = manualContactCount + caregiverCount;

  /** Refresh the link counts whenever the Settings tab gains focus —
   *  catches the case where the user cancels a pending invite or
   *  unlinks a caregiver in Manage Links and comes back here. */
  const refreshLinkCounts = useCallback(() => {
    if (!profile?.id) return;
    getLinkedCaregivers(profile.id).then((d) => setCaregiverCount(d.length)).catch(console.error);
    getSentInvitations(profile.id).then((d) => setPendingCount(d.length)).catch(console.error);
  }, [profile?.id]);
  useFocusEffect(useCallback(() => { refreshLinkCounts(); }, [refreshLinkCounts]));

  const handleSendInvitation = async () => {
    if (!profile?.id || !inviteEmail.trim()) return;
    setSendingInvite(true);
    try {
      await sendInvitation(profile.id, inviteEmail.trim());
      setShowInviteDialog(false);
      setInviteEmail('');
      setPendingCount((prev) => prev + 1);
      showToast(t('settings.invitationSent'), 'success');
    } catch (err) {
      showToast(
        (err as Error).message || t('settings.invitationFailed') || 'Failed to send invitation.',
        'error',
      );
    } finally {
      setSendingInvite(false);
    }
  };

  const handleSignOut = async () => {
    try { await signOut(); } catch (err) { console.error('Sign out error:', err); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader title={t('tabs.settings')} />

      <ScreenBody gap={spacing.s4}>
        {/* Profile header */}
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            {profile?.avatar_url
              ? <Avatar.Image size={56} source={{ uri: profile.avatar_url }} />
              : <Avatar.Icon size={56} icon="account" style={{ backgroundColor: palette.accentSoft }} color={palette.accentInk} />}
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 16, color: palette.text }}>
                {profile?.full_name || t('alerts.unknown')}
              </Text>
              <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2 }}>
                {(profile?.phone || t('manageLinks.noPhone'))} ·{' '}
                {profile?.role === 'caregiver' ? t('auth.caregiver') : t('auth.wearer')}
              </Text>
            </View>
            <BtnTonal size="sm" onPress={() => router.push('/(shared)/edit-profile')}>
              {t('settings.editProfile')}
            </BtnTonal>
          </View>
        </Card>

        {/* Care circle */}
        <Eyebrow>{t('settings.careCircle')}</Eyebrow>
        <Card padding={4}>
          <View style={{ paddingHorizontal: 12 }}>
            <ListRow
              icon="account-plus-outline"
              iconVariant="accent"
              label={t('settings.inviteCaregiverShort')}
              sub={t('settings.sendLinkByEmail')}
              onPress={() => setShowInviteDialog(true)}
            />
            <ListRow
              icon="account-multiple-outline"
              iconVariant="accent"
              label={t('settings.linkedCaregivers')}
              sub={caregiverCount > 0
                ? t('settings.caregiversActive', { count: caregiverCount })
                : t('settings.caregiversNoneYet')}
              right={pendingCount > 0
                ? <Pill variant="warning">{t('settings.pendingCount', { count: pendingCount })}</Pill>
                : undefined}
              onPress={() => router.push('/(shared)/manage-links')}
            />
          </View>
        </Card>

        {/* Safety */}
        <Eyebrow>{t('settings.safety')}</Eyebrow>
        <Card padding={4}>
          <View style={{ paddingHorizontal: 12 }}>
            <ListRow
              icon="phone-outline"
              iconVariant="danger"
              label={t('settings.emergencyContacts')}
              sub={
                emergencyContactCount === 0 ? t('settings.contactsZero')
                : emergencyContactCount === 1 ? t('settings.contactsOne')
                : t('settings.contactsMany', { count: emergencyContactCount })
              }
              onPress={() => router.push('/(shared)/emergency-contacts')}
            />
            <ListRow
              icon="map-marker-radius-outline"
              iconVariant="accent"
              label={t('settings.safeZones')}
              sub={t('settings.safeZonesDesc')}
              onPress={() => router.push('/(shared)/safe-zones')}
            />
            <ListRow
              icon="trophy-outline"
              iconVariant="warning"
              label={t('achievements.title')}
              sub={t('settings.totalPoints')}
              onPress={() => router.push('/(shared)/achievements')}
            />
          </View>
        </Card>

        {/* Device & preferences */}
        <Eyebrow>{t('settings.deviceAndPrefs')}</Eyebrow>
        <Card padding={4}>
          <View style={{ paddingHorizontal: 12 }}>
            <ListRow
              icon="watch"
              iconVariant={watchLive ? 'accent' : 'default'}
              label={watchName}
              sub={watchSub}
              onPress={() => setShowPairDialog(true)}
              right={watchLive
                ? <Pill variant="success" dot>{t('wearerHome.live')}</Pill>
                : <Pill variant="default">{t('settings.watchOff')}</Pill>}
            />
            <ListRow
              icon="flask-outline"
              iconVariant={demoMode ? 'accent' : 'default'}
              label={t('settings.demoModeTitle')}
              sub={demoMode
                ? t('settings.demoModeOn')
                : t('settings.demoModeOff')}
              right={<Toggle value={demoMode} onChange={handleToggleDemo} />}
            />
            {demoMode && (
              <View style={{
                marginHorizontal: 12, marginTop: -6, marginBottom: 6,
                paddingTop: 8, gap: 12,
                borderTopWidth: 1, borderTopColor: palette.divider,
              }}>
                <Text style={{
                  fontFamily: fontFamily.mono, fontSize: 10, color: palette.text3,
                  letterSpacing: 1, textTransform: 'uppercase',
                }}>
                  {t('settings.demoControls')}
                </Text>
                <DemoSegmentRow<DemoLevel>
                  label={t('settings.demoHr')} hint={t('settings.demoHrHint')}
                  value={demoConfig.hr}
                  options={[
                    { id: 'low',  label: t('settings.demoLow') },
                    { id: 'mid',  label: t('settings.demoMid') },
                    { id: 'high', label: t('settings.demoHigh') },
                  ]}
                  onChange={(hr) => setDemoConfig({ hr })}
                />
                <DemoSegmentRow<DemoLevel>
                  label={t('settings.demoSpo2')} hint={t('settings.demoSpo2Hint')}
                  value={demoConfig.spo2}
                  options={[
                    { id: 'low',  label: t('settings.demoLow') },
                    { id: 'mid',  label: t('settings.demoMid') },
                    { id: 'high', label: t('settings.demoHigh') },
                  ]}
                  onChange={(spo2) => setDemoConfig({ spo2 })}
                />
                <DemoSegmentRow<DemoLevel>
                  label={t('settings.demoTemp')} hint={t('settings.demoTempHint')}
                  value={demoConfig.temp}
                  options={[
                    { id: 'low',  label: t('settings.demoLow') },
                    { id: 'mid',  label: t('settings.demoMid') },
                    { id: 'high', label: t('settings.demoHigh') },
                  ]}
                  onChange={(temp) => setDemoConfig({ temp })}
                />
                <DemoSegmentRow<DemoEcg>
                  label={t('settings.demoEcg')} hint={t('settings.demoEcgHint')}
                  value={demoConfig.ecg}
                  options={[
                    { id: 'normal',    label: t('settings.demoNormal')    },
                    { id: 'irregular', label: t('settings.demoIrregular') },
                  ]}
                  onChange={(ecg) => {
                    setDemoConfig({ ecg });
                    // Push immediately so the Home ECG tile reflects
                    // the new verdict without waiting for the next
                    // mock-vitals tick (the live tick only updates
                    // HR/SpO₂/Temp/steps, not ECG).
                    useVitalsStore.getState().updateVitals({
                      ecgClass: ecg,
                      ecgConfidence: ecg === 'normal' ? 0.92 : 0.78,
                      ecgAt: Date.now(),
                    });
                  }}
                />
                <DemoSegmentRow<DemoActivity>
                  label={t('settings.demoActivity')} hint={t('settings.demoActivityHint')}
                  value={demoConfig.activity}
                  options={[
                    { id: 'auto',       label: t('settings.demoAuto') },
                    { id: 'walking',    label: t('settings.demoWalking') },
                    { id: 'jogging',    label: t('settings.demoJogging') },
                    { id: 'stationary', label: t('settings.demoStationary') },
                  ]}
                  onChange={(activity) => {
                    setDemoConfig({ activity });
                    // Push the forced label immediately so the Home banner +
                    // activity card update without waiting for the next tick.
                    if (activity !== 'auto') {
                      useVitalsStore.getState().updateVitals({
                        currentActivity: activity === 'walking' ? 'Walking'
                          : activity === 'jogging' ? 'Jogging' : 'Stationary',
                      });
                    }
                  }}
                />
                {/* Fall-alert test — relocated here from the old Home dev pill
                    (shows only when demo mode is on). Overlay = visual-only;
                    Call = files the alert + auto-dials the emergency contact. */}
                <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
                  <Pressable
                    onPress={() => useFallAlertStore.getState().trigger(0.92, { isDemo: true })}
                    style={({ pressed }) => ({
                      flex: 1, alignItems: 'center', justifyContent: 'center',
                      height: 40, borderRadius: radius.pill,
                      backgroundColor: palette.accentSoft, opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12.5, color: palette.accentInk }}>
                      {t('settings.demoFallOverlay')}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => useFallAlertStore.getState().trigger(0.92, { isDemo: false })}
                    style={({ pressed }) => ({
                      flex: 1, alignItems: 'center', justifyContent: 'center',
                      height: 40, borderRadius: radius.pill,
                      backgroundColor: palette.dangerSoft, opacity: pressed ? 0.7 : 1,
                    })}
                  >
                    <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12.5, color: palette.dangerInk }}>
                      {t('settings.demoFallCall')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
            <ListRow
              icon="theme-light-dark"
              label={t('settings.darkMode')}
              sub={t('settings.darkModeFollows')}
              right={<Toggle value={isDarkMode} onChange={toggleDarkMode} />}
            />
            <ListRow
              icon="translate"
              label={t('settings.language')}
              sub={currentLang === 'ar' ? 'العربية' : t('settings.languageEnglish')}
              onPress={() => setLanguage(currentLang === 'ar' ? 'en' : 'ar')}
            />
          </View>
        </Card>

        {/* Sign out + version footer */}
        <View style={{ paddingTop: 8, gap: 12 }}>
          <Button
            mode="outlined"
            icon="logout"
            onPress={handleSignOut}
            textColor={palette.danger}
            style={{ borderRadius: radius.pill, borderColor: palette.dangerSoft }}
            contentStyle={{ height: 52 }}
            labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
          >
            {t('common.signOut')}
          </Button>
          <Text style={{
            textAlign: 'center',
            color: palette.text3,
            fontSize: 11,
            fontFamily: fontFamily.mono,
          }}>
            v{Constants.expoConfig?.version ?? '?'} ·{' '}
            {Platform.OS}{' '}
            {Constants.expoConfig?.runtimeVersion
              ? `· runtime ${Constants.expoConfig.runtimeVersion}`
              : ''}
          </Text>
        </View>
      </ScreenBody>

      <PairWatchDialog
        visible={showPairDialog}
        onClose={() => setShowPairDialog(false)}
      />

      {/* Invite dialog */}
      <Portal>
        <Dialog
          visible={showInviteDialog}
          onDismiss={() => { setShowInviteDialog(false); setInviteEmail(''); }}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{
            fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text,
          }}>
            {t('settings.inviteCaregiver')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 12, paddingBottom: 20 }}>
            <Text style={{ color: palette.text2, fontFamily: fontFamily.sans, fontSize: 13 }}>
              {t('settings.inviteDialogDesc')}
            </Text>
            <AuthInput
              icon="mail"
              value={inviteEmail}
              onChangeText={setInviteEmail}
              placeholder={t('settings.caregiverEmail')}
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => { setShowInviteDialog(false); setInviteEmail(''); }}
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
            <View style={{ opacity: (sendingInvite || !inviteEmail.trim()) ? 0.5 : 1 }}>
              <BtnTonal
                size="sm"
                onPress={(sendingInvite || !inviteEmail.trim()) ? undefined : handleSendInvitation}
              >
                {sendingInvite ? '…' : t('settings.sendInvitation')}
              </BtnTonal>
            </View>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
