import { Stack } from 'expo-router';
import { useTheme } from 'react-native-paper';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';

export default function SharedLayout() {
  const theme = useTheme();
  const { t } = useTranslation();
  // The manage-links screen is shared: a wearer sees their linked
  // caregivers, a caregiver sees their linked wearers. Title flips
  // on role so the header reads correctly for both.
  const isCaregiver = useAuthStore((s) => s.profile?.role) === 'caregiver';
  const manageLinksTitle = isCaregiver
    ? t('settings.linkedWearers')
    : t('settings.linkedCaregivers');

  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.onBackground,
        headerShadowVisible: false,
        headerTitleStyle: {
          fontFamily: 'DMSans-Semibold',
          fontSize: 16,
        },
        headerBackTitle: t('common.back'),
      }}
    >
      <Stack.Screen name="edit-profile" options={{ title: t('settings.editProfile') }} />
      <Stack.Screen name="emergency-contacts" options={{ title: t('emergencyContacts.title') }} />
      <Stack.Screen name="manage-links" options={{ title: manageLinksTitle }} />
      <Stack.Screen name="alert-detail" options={{ title: t('alerts.alert') }} />
      {/* wearer-detail has its own custom in-body header (back + WEARER
          eyebrow + name + call), so the native stack header is hidden. */}
      <Stack.Screen name="wearer-detail" options={{ headerShown: false }} />
      {/* wearer-assistant also has a custom in-body header. */}
      <Stack.Screen name="wearer-assistant" options={{ headerShown: false }} />
      <Stack.Screen name="safe-zones" options={{ title: t('safeZones.title') }} />
      <Stack.Screen name="achievements" options={{ title: t('achievements.title') }} />
    </Stack>
  );
}
