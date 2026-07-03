import { View, StyleSheet } from 'react-native';
import { Text, useTheme } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useNetworkStatus } from '@/hooks/useNetworkStatus';
import { useTranslation } from 'react-i18next';

export function OfflineBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { isConnected } = useNetworkStatus();

  if (isConnected) return null;

  return (
    <View style={[styles.banner, { backgroundColor: theme.colors.errorContainer }]}>
      <MaterialCommunityIcons name="wifi-off" size={16} color={theme.colors.error} />
      <Text variant="bodySmall" style={{ color: theme.colors.onErrorContainer, marginLeft: 6, fontWeight: '600' }}>
        {t('errors.offline')} — {t('errors.offlineDesc')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
});
