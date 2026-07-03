import { View, StyleSheet } from 'react-native';
import { Text, Button, useTheme, Surface } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

interface ErrorStateProps {
  title?: string;
  message?: string;
  icon?: string;
  onRetry?: () => void;
}

export function ErrorState({
  title,
  message,
  icon = 'alert-circle-outline',
  onRetry,
}: ErrorStateProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  const displayTitle = title || t('errors.somethingWrong');
  const displayMessage = message || t('errors.unexpectedError');

  return (
    <View style={styles.container}>
      <Surface style={[styles.card, { backgroundColor: theme.colors.errorContainer }]} elevation={0}>
        <MaterialCommunityIcons name={icon as any} size={56} color={theme.colors.error} />
        <Text variant="titleMedium" style={{ fontWeight: '600', color: theme.colors.onErrorContainer, marginTop: 16 }}>
          {displayTitle}
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onErrorContainer, textAlign: 'center', marginTop: 8 }}>
          {displayMessage}
        </Text>
        {onRetry && (
          <Button mode="contained" onPress={onRetry} style={{ marginTop: 20, borderRadius: 12 }}>
            {t('common.retry')}
          </Button>
        )}
      </Surface>
    </View>
  );
}

/** Empty state for lists with no data */
export function EmptyState({
  title,
  message,
  icon = 'inbox-outline',
}: {
  title: string;
  message: string;
  icon?: string;
}) {
  const theme = useTheme();

  return (
    <View style={styles.container}>
      <Surface style={[styles.card, { backgroundColor: theme.colors.surface }]} elevation={1}>
        <MaterialCommunityIcons name={icon as any} size={56} color={theme.colors.onSurfaceVariant} />
        <Text variant="titleMedium" style={{ fontWeight: '600', color: theme.colors.onSurface, marginTop: 16 }}>
          {title}
        </Text>
        <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center', marginTop: 8 }}>
          {message}
        </Text>
      </Surface>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    padding: 32,
    borderRadius: 20,
    alignItems: 'center',
    width: '100%',
    maxWidth: 340,
  },
});
