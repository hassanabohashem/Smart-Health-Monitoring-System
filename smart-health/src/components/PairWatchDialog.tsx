/**
 * Pair Watch dialog — real Wear OS Data Layer discovery, shown when
 * the wearer taps "Pair" on the Home wellness banner.
 *
 * Pipeline:
 *   1. Open → call `getConnectedNodes()` against the native bridge,
 *      which delegates to `Wearable.getNodeClient.connectedNodes`.
 *   2. Show whichever nodes Android reports as currently reachable
 *      via the Data Layer. Filter to `isNearby` (cloud-relay only
 *      nodes can't stream sensor data).
 *   3. On row tap, set `useDeviceStore.device` so Settings + Home
 *      name the paired watch. `isConnected` is left to the sensor
 *      listener — it'll flip true on the first /sensor_data packet
 *      from the watch's wear app.
 *
 * If no node is reachable, the dialog surfaces an honest empty state
 * ("Pair your watch in Galaxy Wearable, then come back") instead of
 * the previous fake "found a watch" mock.
 *
 * The companion-app capability check (does the watch actually run
 * our wear_app?) is a separate concern — left out for now, since
 * the Settings demo toggle covers the showcase scenario where no
 * watch is paired at all.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ActivityIndicator, Linking } from 'react-native';
import { Portal, Dialog } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useDesignTokens, BtnTonal } from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { useDeviceStore } from '@/stores/device.store';
import { getConnectedNodes, type WearNode } from '@/services/wear';
import { AuthIcon } from '@/components/AuthControls';

type Stage =
  | 'searching'
  | 'list'
  | 'empty'
  | 'connecting'
  | 'connected'
  | 'unsupported'  // device has no Wear OS / Play Services
  | 'error';       // unexpected bridge failure

/** Match the specific failure when Google Play Services Wearable
 *  isn't installed on this device — typical on AVDs without the
 *  Play Store image and on phones with stripped Google services. */
function isWearUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /API_UNAVAILABLE|Wearable\.API is not available/i.test(msg);
}

const SCAN_MIN_MS = 1200; // ensure the spinner is visible at least this long

export function PairWatchDialog({
  visible, onClose,
}: { visible: boolean; onClose: () => void }) {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const [stage, setStage] = useState<Stage>('searching');
  const [nodes, setNodes] = useState<WearNode[]>([]);
  const [selected, setSelected] = useState<WearNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const scan = useCallback(async () => {
    setStage('searching');
    setError(null);
    const startedAt = Date.now();
    try {
      const found = await getConnectedNodes();
      const reachable = found.filter((n) => n.isNearby);
      const remaining = Math.max(0, SCAN_MIN_MS - (Date.now() - startedAt));
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
      setNodes(reachable);
      setStage(reachable.length > 0 ? 'list' : 'empty');
    } catch (err) {
      if (isWearUnsupported(err)) {
        setStage('unsupported');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStage('error');
    }
  }, []);

  // Reset + scan on every open.
  useEffect(() => {
    if (!visible) return;
    setSelected(null);
    scan();
  }, [visible, scan]);

  // Brief "connecting" stage → save device + show "connected" → close.
  useEffect(() => {
    if (stage !== 'connecting' || !selected) return;
    const node = selected;
    const t1 = setTimeout(() => {
      useDeviceStore.getState().setDevice({
        id: node.id,
        user_id: null,
        hardware_id: node.id,
        name: node.name,
        firmware_version: null,
        battery_level: null,
        status: 'online',
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      setStage('connected');
    }, 900);
    return () => clearTimeout(t1);
  }, [stage, selected]);

  // Auto-close after a brief "connected" confirmation.
  useEffect(() => {
    if (stage !== 'connected') return;
    const t = setTimeout(() => onCloseRef.current(), 900);
    return () => clearTimeout(t);
  }, [stage]);

  const cancel = () => {
    setSelected(null);
    onClose();
  };

  const openWearableApp = () => {
    // Galaxy Wearable / Wear OS companion app. Falls back to a Play
    // Store search if neither is installed.
    Linking.openURL('market://details?id=com.samsung.android.app.watchmanager')
      .catch(() => Linking.openURL('https://play.google.com/store/apps/details?id=com.samsung.android.app.watchmanager'));
  };

  const title =
    stage === 'connected' ? t('pairWatch.connected')
    : stage === 'connecting' ? t('pairWatch.connecting')
    : stage === 'unsupported' ? t('pairWatch.unsupportedTitle')
    : stage === 'error' ? t('pairWatch.scanFailedTitle')
    : t('pairWatch.title');

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={cancel}
        dismissable={stage !== 'connecting' && stage !== 'connected'}
        style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
      >
        <Dialog.Title style={{
          fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text,
        }}>
          {title}
        </Dialog.Title>

        <Dialog.Content style={{ paddingBottom: 12 }}>
          {stage === 'searching' && (
            <View style={{ alignItems: 'center', paddingVertical: 18 }}>
              <ActivityIndicator size="small" color={palette.accent2} />
              <Text style={{
                marginTop: 14,
                fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2,
                textAlign: 'center',
              }}>
                {t('pairWatch.searching')}
              </Text>
            </View>
          )}

          {stage === 'list' && (
            <View style={{ paddingVertical: 6, gap: 10 }}>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 11, color: palette.text3,
                textTransform: 'uppercase', letterSpacing: 1,
              }}>
                {t('pairWatch.availableDevices')}
              </Text>
              {nodes.map((node) => (
                <Pressable
                  key={node.id}
                  onPress={() => { setSelected(node); setStage('connecting'); }}
                  style={({ pressed }) => ({
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    paddingVertical: 12, paddingHorizontal: 12,
                    borderRadius: radius.md,
                    backgroundColor: pressed ? palette.surface2 : palette.surface,
                    borderWidth: 1, borderColor: palette.border,
                  })}
                >
                  <View style={{
                    width: 40, height: 40, borderRadius: 999,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: palette.accentSoft,
                  }}>
                    <AuthIcon name="watch" color={palette.accentInk} size={20} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{
                      fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                      fontSize: 14, color: palette.text,
                    }}>{node.name}</Text>
                    <Text style={{
                      fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3,
                      marginTop: 1,
                    }}>
                      {node.isNearby ? t('pairWatch.nearby') : t('pairWatch.cloudOnly')} · {node.id.slice(0, 6)}
                    </Text>
                  </View>
                  <BtnTonal size="xs"
                    onPress={() => { setSelected(node); setStage('connecting'); }}
                  >
                    {t('pairWatch.pair')}
                  </BtnTonal>
                </Pressable>
              ))}
            </View>
          )}

          {stage === 'empty' && (
            <View style={{ paddingVertical: 8, gap: 10 }}>
              <View style={{
                alignSelf: 'center',
                width: 56, height: 56, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: palette.surface2,
                marginBottom: 2,
              }}>
                <AuthIcon name="watch-off" color={palette.text3} size={28} />
              </View>
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                fontSize: 14, color: palette.text, textAlign: 'center',
              }}>
                {t('pairWatch.noWatchTitle')}
              </Text>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 12.5, color: palette.text2,
                textAlign: 'center', lineHeight: 18,
              }}>
                {t('pairWatch.noWatchBody')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center', marginTop: 6 }}>
                <BtnTonal size="sm" onPress={openWearableApp}>{t('pairWatch.openWearable')}</BtnTonal>
                <BtnTonal size="sm" onPress={scan}>{t('pairWatch.rescan')}</BtnTonal>
              </View>
            </View>
          )}

          {stage === 'connecting' && (
            <View style={{ alignItems: 'center', paddingVertical: 18 }}>
              <ActivityIndicator size="large" color={palette.accent2} />
              <Text style={{
                marginTop: 14,
                fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2,
                textAlign: 'center',
              }}>
                {t('pairWatch.connectingTo', { name: selected?.name ?? t('pairWatch.deviceFallback') })}
              </Text>
            </View>
          )}

          {stage === 'connected' && (
            <View style={{ alignItems: 'center', paddingVertical: 16 }}>
              <View style={{
                width: 56, height: 56, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: palette.accentSoft,
              }}>
                <MaterialCommunityIcons name="check" size={32} color={palette.accentInk} />
              </View>
              <Text style={{
                marginTop: 14,
                fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                fontSize: 14, color: palette.text, textAlign: 'center',
              }}>
                {t('pairWatch.connectedSuffix', { name: selected?.name ?? t('pairWatch.deviceFallbackCap') })}
              </Text>
              <Text style={{
                marginTop: 4,
                fontFamily: fontFamily.sans, fontSize: 12, color: palette.text3,
                textAlign: 'center',
              }}>
                {t('pairWatch.waitingFirstReading')}
              </Text>
            </View>
          )}

          {stage === 'unsupported' && (
            <View style={{ paddingVertical: 8, gap: 10 }}>
              <View style={{
                alignSelf: 'center',
                width: 56, height: 56, borderRadius: 999,
                alignItems: 'center', justifyContent: 'center',
                backgroundColor: palette.surface2,
                marginBottom: 2,
              }}>
                <MaterialCommunityIcons name="cellphone-off" size={28} color={palette.text3} />
              </View>
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                fontSize: 14, color: palette.text, textAlign: 'center',
              }}>
                {t('pairWatch.unsupportedBodyTitle')}
              </Text>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 12.5, color: palette.text2,
                textAlign: 'center', lineHeight: 18,
              }}>
                {t('pairWatch.unsupportedBody')}
              </Text>
            </View>
          )}

          {stage === 'error' && (
            <View style={{ paddingVertical: 8, gap: 10 }}>
              <Text style={{
                fontFamily: fontFamily.sansSemibold, fontWeight: '600',
                fontSize: 14, color: palette.text, textAlign: 'center',
              }}>
                {t('pairWatch.bridgeErrorTitle')}
              </Text>
              <Text style={{
                fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3,
                textAlign: 'center',
              }}>
                {error ?? t('pairWatch.unknownError')}
              </Text>
              <View style={{ alignSelf: 'center' }}>
                <BtnTonal size="sm" onPress={scan}>{t('common.retry')}</BtnTonal>
              </View>
            </View>
          )}
        </Dialog.Content>

        {stage !== 'connecting' && stage !== 'connected' && (
          <Dialog.Actions>
            <Pressable onPress={cancel} hitSlop={6} style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
              <Text style={{
                fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500',
                color: palette.text2,
              }}>
                {stage === 'unsupported' ? t('common.close') : t('common.cancel')}
              </Text>
            </Pressable>
          </Dialog.Actions>
        )}
      </Dialog>
    </Portal>
  );
}
