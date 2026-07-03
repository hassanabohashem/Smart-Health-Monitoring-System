import { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, RefreshControl, SafeAreaView, Text } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { getGeofences, getDistanceMeters } from '@/services/geofence.service';
import { getLinkedCaregivers } from '@/services/link.service';
import { getCurrentPosition } from '@/services/location.service';
import { Skeleton } from '@/components/Skeleton';
import {
  useDesignTokens, Card, IconDot, Banner, Pill, EmptyState,
} from '@/design';
import { fontFamily } from '@/design/tokens';

interface GeofenceWithStatus {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
  isInside: boolean | null;
  distance: number | null;
  creatorName: string | null;
}

export default function SafeZonesScreen() {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const [zones, setZones] = useState<GeofenceWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadZones = useCallback(async () => {
    if (!profile?.id) return;
    try {
      const [geofences, links] = await Promise.all([
        getGeofences(profile.id),
        getLinkedCaregivers(profile.id).catch(() => []),
      ]);
      // Resolve each zone's creator (caregiver) id → name so we can show whose
      // zone it is. Creators are the wearer's linked caregivers.
      const creatorById = new Map<string, string>();
      (links as Array<{ caregiver?: { id?: string; full_name?: string } }>).forEach((l) => {
        if (l.caregiver?.id && l.caregiver.full_name) {
          creatorById.set(l.caregiver.id, l.caregiver.full_name);
        }
      });

      let position: { latitude: number; longitude: number } | null = null;
      try {
        position = await getCurrentPosition();
      } catch {}

      const withStatus: GeofenceWithStatus[] = geofences.map((g) => {
        const creatorName = creatorById.get(g.created_by) ?? null;
        if (!position) {
          return { ...g, isInside: null, distance: null, creatorName };
        }
        const dist = getDistanceMeters(
          position.latitude, position.longitude,
          g.latitude, g.longitude
        );
        return {
          ...g,
          isInside: dist <= g.radius_meters,
          distance: Math.round(dist),
          creatorName,
        };
      });
      setZones(withStatus);
    } catch (err) {
      console.error('Failed to load safe zones:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    loadZones();
  }, [loadZones]);

  const handleRefresh = () => {
    setRefreshing(true);
    loadZones();
  };

  if (loading && !refreshing) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        <View style={{ padding: 16, gap: 12 }}>
          <Skeleton width="80%" height={14} style={{ marginBottom: 8 }} />
          {[1, 2].map((i) => (
            <Skeleton key={i} width="100%" height={120} borderRadius={16} />
          ))}
        </View>
      </SafeAreaView>
    );
  }

  if (zones.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 24 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        >
          {/* Card-less, centered — matches the alerts empty state. */}
          <EmptyState
            icon="shield-off-outline"
            title={t('safeZones.noZones')}
            description={t('safeZones.noZonesDesc')}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  const insideCount = zones.filter((z) => z.isInside === true).length;
  const allKnown = zones.every((z) => z.isInside !== null);
  // A wearer is "safe" if inside AT LEAST ONE zone — being outside some zones
  // is normal (you can't be in two places). Only outside-ALL is concerning.
  const inAnySafeZone = insideCount > 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 14 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
      >
        {/* Summary banner */}
        {allKnown && (
          <Banner
            variant={inAnySafeZone ? 'success' : 'danger'}
            icon={inAnySafeZone ? 'shield-check' : 'alert-circle'}
          >
            <Text style={{
              color: inAnySafeZone ? palette.successInk : palette.dangerInk,
              fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 13,
            }}>
              {inAnySafeZone
                ? t('safeZones.summarySafe')
                : t('safeZones.summaryUnsafe')}
            </Text>
          </Banner>
        )}

        <Text style={{
          fontFamily: fontFamily.sans, fontSize: 13, color: palette.text2, paddingHorizontal: 2,
        }}>
          {t('safeZones.description')}
        </Text>

        {zones.map((zone) => {
          const variant: 'success' | 'danger' | 'default' =
            zone.isInside === null ? 'default' : zone.isInside ? 'success' : 'danger';

          return (
            <Card key={zone.id} padding={16}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <IconDot
                  icon="shield-check"
                  variant={variant === 'danger' ? 'danger' : 'success'}
                  size={40}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{
                    fontFamily: fontFamily.sansSemibold, fontSize: 15, fontWeight: '600', color: palette.text,
                  }}>
                    {zone.name}
                  </Text>
                  {zone.creatorName && (
                    <Text style={{
                      fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2, marginTop: 2,
                    }}>
                      {t('safeZones.setBy', { name: zone.creatorName })}
                    </Text>
                  )}
                  <Text style={{
                    fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2,
                  }}>
                    {t('safeZones.radius', { meters: zone.radius_meters })}
                    {zone.distance != null && ` · ${t('safeZones.distance', { meters: zone.distance })}`}
                  </Text>
                </View>
                <Pill variant={variant} dot>
                  {zone.isInside === null
                    ? '—'
                    : zone.isInside
                      ? t('safeZones.insideZone')
                      : t('safeZones.outsideZone')}
                </Pill>
              </View>

              {zone.isInside === null && (
                <View style={{
                  marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: palette.divider,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                }}>
                  <MaterialCommunityIcons name="crosshairs-question" size={14} color={palette.text3} />
                  <Text style={{
                    fontFamily: fontFamily.sans, fontSize: 11, color: palette.text3,
                  }}>
                    {t('safeZones.locationUnavailable')}
                  </Text>
                </View>
              )}
            </Card>
          );
        })}

      </ScrollView>
    </SafeAreaView>
  );
}
