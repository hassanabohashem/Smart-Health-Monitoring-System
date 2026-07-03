import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthIcon } from '@/components/AuthControls';
import { useDesignTokens } from '@/design';
import { fontFamily } from '@/design/tokens';

export default function WearerLayout() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Comfortable bottom breathing room on every device: safe-area inset
  // (home indicator on iOS, gesture bar on Android) + 10 px so the
  // labels never hug the screen edge.
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
        name="home"
        options={{
          title: t('tabs.today'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="home" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: t('tabs.activity'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="trend" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="assistant"
        options={{
          title: t('tabs.assistant'),
          tabBarIcon: ({ color, size }) => <AuthIcon name="bot" color={color} size={size} />,
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
