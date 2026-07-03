import { View, ScrollView, Linking, SafeAreaView, Text, Pressable } from 'react-native';
import { Button, Avatar } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { resolveAlert, cancelAlert, acknowledgeAlert } from '@/services/alert.service';
import {
  useDesignTokens, Card, Pill, IconDot, BtnTonal, Eyebrow,
} from '@/design';
import { AuthIcon } from '@/components/AuthControls';
// Shared source of truth so the detail page's icon + severity colour are
// identical to the Alerts list (no per-screen drift).
import { ALERT_GLYPH, SEVERITY_VARIANT, inkForVariant, titleFor } from '@/utils/alert-format';
import { fontFamily, radius } from '@/design/tokens';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

function timeAgo(dateStr: string, t: (k: string, o?: Record<string, unknown>) => string) {
  const diff = Math.max(0, Date.now() - new Date(dateStr).getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('alerts.timeJustNow');
  if (mins < 60) return t('alerts.timeMinutesAgo', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('alerts.timeHoursAgo', { count: hrs });
  return t('alerts.timeDaysAgo', { count: Math.floor(hrs / 24) });
}

/** App-native full-width action pill (replaces Paper's MD3 buttons). */
function ActionButton({
  icon, label, bg, fg, border, onPress, disabled,
}: {
  icon: IconName; label: string; bg: string; fg: string; border?: string;
  onPress: () => void; disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
        height: 52, borderRadius: radius.pill, backgroundColor: bg,
        ...(border ? { borderWidth: 1, borderColor: border } : null),
        opacity: pressed || disabled ? 0.6 : 1,
      })}
    >
      <MaterialCommunityIcons name={icon} size={18} color={fg} />
      <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 14, color: fg }}>
        {label}
      </Text>
    </Pressable>
  );
}

export default function AlertDetailScreen() {
  const { palette } = useDesignTokens();
  const router = useRouter();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ alertId: string }>();
  const profile = useAuthStore((s) => s.profile);
  const { alerts, updateAlert } = useAlertsStore();
  const [loading, setLoading] = useState(false);

  const alert = alerts.find((a) => a.id === params.alertId);

  if (!alert) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <MaterialCommunityIcons name="alert-remove-outline" size={56} color={palette.text3} />
        <Text style={{
          fontFamily: fontFamily.sansSemibold, fontSize: 15, marginTop: 16, color: palette.text2,
        }}>{t('alertDetail.alertNotFound')}</Text>
        <Button mode="text" onPress={() => router.back()} style={{ marginTop: 12 }}>
          {t('alertDetail.goBack')}
        </Button>
      </SafeAreaView>
    );
  }

  const variant = SEVERITY_VARIANT[alert.severity] || 'danger';
  const glyph = ALERT_GLYPH[alert.type] || 'alert-octagon';
  const inkColor = inkForVariant(palette, variant);
  const isActive = alert.status === 'active';
  const wearerName = alert.wearer?.full_name || t('alertDetail.unknownWearer');
  const meta = (alert.metadata as { wearer_phone?: string; acknowledged_at?: string } | null) || {};
  const wearerPhone = meta.wearer_phone;
  const acknowledgedAt = meta.acknowledged_at;
  const isAcked = !!acknowledgedAt;

  const handleResolve = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const updated = await resolveAlert(alert.id, profile.id);
      updateAlert(alert.id, updated);
    } catch (err) { console.error('Failed to resolve:', err); }
    finally { setLoading(false); }
  };

  const handleAcknowledge = async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const updated = await acknowledgeAlert(alert.id, profile.id);
      updateAlert(alert.id, updated);
    } catch (err) { console.error('Failed to acknowledge:', err); }
    finally { setLoading(false); }
  };

  const handleCancel = async () => {
    setLoading(true);
    try {
      const updated = await cancelAlert(alert.id);
      updateAlert(alert.id, updated);
    } catch (err) { console.error('Failed to cancel:', err); }
    finally { setLoading(false); }
  };

  const handleCallWearer = () => { if (wearerPhone) Linking.openURL(`tel:${wearerPhone}`); };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}>
        {/* Hero — the SAME IconDot glyph + severity colour as the Alerts list
            (via alert-format), on a plain card so they read identically. No
            severity label. */}
        <Card padding={24} style={{ alignItems: 'center' }}>
          <IconDot
            iconNode={<AuthIcon name={glyph} color={inkColor} size={28} />}
            variant={variant}
            size={64}
          />
          <Text style={{
            fontFamily: fontFamily.display, fontSize: 26, lineHeight: 30,
            color: inkColor, marginTop: 14, textAlign: 'center', letterSpacing: -0.5,
          }}>
            {titleFor(alert.type, t)}
          </Text>
          <Text style={{
            fontFamily: fontFamily.mono, fontSize: 11, color: palette.text2, marginTop: 8,
          }}>
            {timeAgo(alert.created_at, t)} · {new Date(alert.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </Text>
        </Card>

        {/* Wearer */}
        <Card>
          <Eyebrow style={{ marginBottom: 12 }}>{t('alertDetail.wearer')}</Eyebrow>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <Avatar.Icon size={40} icon="account-outline" style={{ backgroundColor: palette.accentSoft }} color={palette.accentInk} />
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text }}>
                {wearerName}
              </Text>
              {wearerPhone && (
                <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2 }}>
                  {wearerPhone}
                </Text>
              )}
            </View>
            {wearerPhone && (
              <BtnTonal size="sm" onPress={handleCallWearer}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <MaterialCommunityIcons name="phone" size={14} color={palette.accentInk} />
                  <Text style={{ color: palette.accentInk, fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13 }}>
                    {t('alertDetail.call')}
                  </Text>
                </View>
              </BtnTonal>
            )}
          </View>
        </Card>

        {/* Details */}
        <Card>
          <Eyebrow style={{ marginBottom: 12 }}>{t('alertDetail.details')}</Eyebrow>

          {[
            {
              label: t('alertDetail.status'),
              right: <Pill variant={isActive ? 'danger' : 'success'} dot>
                {alert.status === 'cancelled' ? t('alerts.cancelled')
                  : alert.status === 'resolved' ? t('alerts.resolved')
                  : t('alerts.active')}
              </Pill>,
            },
            ...(alert.confidence != null ? [{ label: t('alertDetail.confidence'), right: <Text style={{ fontFamily: fontFamily.mono, fontWeight: '500', color: palette.text, fontSize: 13 }}>{(alert.confidence * 100).toFixed(0)}%</Text> }] : []),
            ...(acknowledgedAt ? [{ label: t('alertDetail.acknowledgedAt'), right: <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text2 }}>{new Date(acknowledgedAt).toLocaleString()}</Text> }] : []),
            ...(alert.resolved_at ? [{ label: t('alertDetail.resolvedAt'), right: <Text style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text2 }}>{new Date(alert.resolved_at).toLocaleString()}</Text> }] : []),
          ].map((row, i, arr) => (
            <View key={i}>
              <View style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 8,
              }}>
                <Text style={{ fontFamily: fontFamily.sans, color: palette.text2, fontSize: 13 }}>{row.label}</Text>
                {row.right}
              </View>
              {i < arr.length - 1 ? <View style={{ height: 1, backgroundColor: palette.divider }} /> : null}
            </View>
          ))}
        </Card>

        {/* Actions — app-native soft-pill buttons (not Paper's MD3 buttons). */}
        {isActive && (
          <View style={{ gap: 10, marginTop: 4 }}>
            {!isAcked && (
              <ActionButton
                icon="eye-check-outline" label={t('alertDetail.acknowledge')}
                bg={palette.surface} fg={palette.text2} border={palette.border}
                onPress={handleAcknowledge} disabled={loading}
              />
            )}
            <ActionButton
              icon="check-circle-outline" label={t('alertDetail.resolveAlert')}
              bg={palette.accentSoft} fg={palette.accentInk}
              onPress={handleResolve} disabled={loading}
            />
            <ActionButton
              icon="close-circle-outline" label={t('alertDetail.falseAlarm')}
              bg={palette.dangerSoft} fg={palette.dangerInk}
              onPress={handleCancel} disabled={loading}
            />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
