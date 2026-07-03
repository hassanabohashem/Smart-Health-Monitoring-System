import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAlertsStore } from '@/stores/alerts.store';
import { AuthIcon } from '@/components/AuthControls';
import { useDesignTokens } from '@/design';
import { fontFamily } from '@/design/tokens';

export default function CaregiverLayout() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const activeAlertCount = useAlertsStore((s) => s.activeAlertCount);
  const insets = useSafeAreaInsets();
  // Same bottom-padding rule as the wearer tabs — safe-area inset + 10.
  const bottomPad = insets.bottom + 10;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: palette.surface,
          borderTopColor: palette.borderSoft,
          borderTopWidth: 1,
          height: 64 + bottomPad,
          paddingTop: 6,
          paddingBottom: bottomPad,
        },
        tabBarLabelStyle: {
          fontFamily: fontFamily.sansMedium,
          fontSize: 11,
          letterSpacing: -0.05,
        },
        tabBarActiveTintColor: palette.accentInk,
        tabBarInactiveTintColor: palette.text2,
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: t('tabs.care'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="grid" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: t('tabs.map'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="pin" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="alerts"
        options={{
          title: t('tabs.alerts'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="bell" color={color} size={size} />,
          tabBarBadge: activeAlertCount > 0 ? activeAlertCount : undefined,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: t('tabs.settings'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="cog" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
