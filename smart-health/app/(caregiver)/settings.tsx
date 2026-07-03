import { View, SafeAreaView, Text, Platform } from 'react-native';
import { Avatar, Button } from 'react-native-paper';
import Constants from 'expo-constants';
import { useState, useCallback } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useAuthStore } from '@/stores/auth.store';
import { useThemeStore } from '@/stores/theme.store';
import { signOut, updateProfile } from '@/services/auth.service';
import { registerForPushNotifications } from '@/services/notification.service';
import { supabase } from '@/services/supabase';
import { getLinkedWearers, getPendingInvitations } from '@/services/link.service';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '@/i18n';
import {
  useDesignTokens, PageHeader, ScreenBody, Card, ListRow, Toggle,
  Eyebrow, BtnTonal, Pill, Toast, useToast,
} from '@/design';
import { fontFamily, spacing, radius } from '@/design/tokens';

interface WearerRecord {
  id: string;
  wearer?: { full_name: string | null } | null;
}

export default function CaregiverSettingsScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const { isDarkMode, toggleDarkMode } = useThemeStore();
  const { t, i18n } = useTranslation();
  const currentLang = i18n.language;
  const [notificationsEnabled, setNotificationsEnabled] = useState(profile?.notifications_enabled ?? true);
  const [wearers, setWearers] = useState<WearerRecord[]>([]);
  const [pendingInviteCount, setPendingInviteCount] = useState(0);
  const { snack, show: showToast, dismiss: dismissToast } = useToast();

  /** Refresh counts on focus — catches accept/decline/unlink in
   *  manage-links flowing back to this screen. */
  const refresh = useCallback(() => {
    if (!profile?.id) return;
    getLinkedWearers(profile.id).then((d) => setWearers(d as unknown as WearerRecord[])).catch(console.error);
    getPendingInvitations(profile.id).then((d) => setPendingInviteCount(d.length)).catch(console.error);
  }, [profile?.id]);
  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  const handleToggleNotifications = async (enabled: boolean) => {
    setNotificationsEnabled(enabled);
    if (!profile?.id) return;
    try {
      await updateProfile(profile.id, { notifications_enabled: enabled });
      if (!enabled) {
        await supabase.from('profiles').update({ fcm_token: null }).eq('id', profile.id);
      } else {
        await registerForPushNotifications(profile.id);
      }
    } catch (err) {
      console.error('Failed to update notification preference:', err);
      setNotificationsEnabled(!enabled);
      showToast(t('common.error'), 'error');
    }
  };

  const handleSignOut = async () => {
    try { await signOut(); } catch (err) { console.error('Sign out error:', err); }
  };

  const wearerCount = wearers.length;
  /** Sub-line for the Care-circle row: a count (mirrors the wearer's
   *  Linked-Caregivers row) — not the wearer names. */
  const wearersSub = wearerCount === 0
    ? t('settings.wearersLinkedSub_zero')
    : wearerCount === 1
      ? t('settings.wearersLinkedSub_one')
      : t('settings.wearersLinkedSub_other', { count: wearerCount });

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader title={t('tabs.settings')} />

      <ScreenBody gap={spacing.s4}>
        {/* Profile header — identical to the wearer settings profile card. */}
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
                {(profile?.phone || t('manageLinks.noPhone'))} · {t('auth.caregiver')}
              </Text>
            </View>
            <BtnTonal size="sm" onPress={() => router.push('/(shared)/edit-profile')}>
              {t('settings.editProfile')}
            </BtnTonal>
          </View>
        </Card>

        {/* Care circle — single merged row covering both linked wearers
            AND pending invitations. Tapping opens Manage Links, which
            lists active wearers + pending received invites to accept.
            The warning Pill surfaces the pending count at a glance. */}
        <Eyebrow>{t('settings.careCircle')}</Eyebrow>
        <Card padding={4}>
          <View style={{ paddingHorizontal: 12 }}>
            <ListRow
              icon="account-multiple-outline"
              iconVariant="accent"
              label={t('settings.linkedWearers')}
              sub={wearersSub}
              right={pendingInviteCount > 0
                ? <Pill variant="warning">{t('settings.pendingCount', { count: pendingInviteCount })}</Pill>
                : undefined}
              onPress={() => router.push('/(shared)/manage-links')}
            />
          </View>
        </Card>

        {/* Device & preferences — mirrors the wearer's section minus the
            watch/demo rows (caregivers don't pair a watch). */}
        <Eyebrow>{t('settings.deviceAndPrefs')}</Eyebrow>
        <Card padding={4}>
          <View style={{ paddingHorizontal: 12 }}>
            <ListRow
              icon="bell-outline"
              label={t('settings.pushNotifications')}
              sub={t('settings.pushDesc')}
              right={<Toggle value={notificationsEnabled} onChange={handleToggleNotifications} />}
            />
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

        {/* Sign out + version footer — identical to the wearer settings. */}
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

      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
