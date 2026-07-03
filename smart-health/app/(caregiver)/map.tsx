import { View, Linking, SafeAreaView, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator, Platform, Animated, PanResponder, useWindowDimensions } from 'react-native';
import { Avatar, Portal, Dialog, IconButton } from 'react-native-paper';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { getLinkedWearers } from '@/services/link.service';
import { getLatestLocation, requestLocationNow } from '@/services/location.service';
import {
  getGeofences, createGeofence, deleteGeofence, getDistanceMeters, type Geofence,
} from '@/services/geofence.service';
import { supabase } from '@/services/supabase';
import { useTranslation } from 'react-i18next';
import { MapSkeleton } from '@/components/Skeleton';
import { AuthInput, AuthIcon } from '@/components/AuthControls';
import { SchematicMap, type SchematicMapHandle } from '@/components/SchematicMap';
import {
  useDesignTokens, PageHeader, Pill, Eyebrow,
  SectionTitle, IconDot, BtnTonal, Toast, useToast, EmptyState,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';

interface WearerLocation {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  lastSeen: string;
  hasRealLocation: boolean;
}

/** Format a (meters | km) distance for display. */
function fmtDistance(
  meters: number,
  t: (k: string, v?: Record<string, string | number>) => string,
  anchor: string,
): string {
  if (meters < 1000) {
    return t('map.zoneAwayMeters', { name: anchor, meters: Math.round(meters) });
  }
  return t('map.zoneAwayKm', { name: anchor, km: (meters / 1000).toFixed(1) });
}

/** 1–2 letter initials for the avatar / pin label. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0] || '').join('').toUpperCase() || '?';
}

export default function MapScreen() {
  const { palette, isDark } = useDesignTokens();
  const { t } = useTranslation();
  const profile = useAuthStore((s) => s.profile);
  const alerts = useAlertsStore((s) => s.alerts);
  const { snack, show: showToast, dismiss: dismissToast } = useToast();

  /** Set of wearer_id values that have ≥1 active alert. Drives the
   *  danger styling on the per-wearer Card (pin + Help pill). */
  const wearersInAlert = useMemo(
    () => new Set(alerts.filter((a) => a.status === 'active').map((a) => a.wearer_id)),
    [alerts],
  );

  const [wearerLocations, setWearerLocations] = useState<WearerLocation[]>([]);
  const [geofences, setGeofences] = useState<Geofence[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddGeofence, setShowAddGeofence] = useState(false);
  const [newFenceName, setNewFenceName] = useState('');
  const [newFenceRadius, setNewFenceRadius] = useState('100');
  const [selectedWearer, setSelectedWearer] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** Themed destructive-confirm for safe-zone deletion. */
  const [fenceToDelete, setFenceToDelete] = useState<Geofence | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Imperative control of the schematic map (zoom / recenter). */
  const mapRef = useRef<SchematicMapHandle>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Map filter sheet: hide some wearers' pins/zones + toggle zone circles. */
  const [filterOpen, setFilterOpen] = useState(false);
  const [hiddenWearerIds, setHiddenWearerIds] = useState<Set<string>>(new Set());
  const [showZones, setShowZones] = useState(true);
  /** Wearers we've pinged for a fresh fix and are awaiting a response for. */
  const [locating, setLocating] = useState<Set<string>>(new Set());
  const locatingRef = useRef(locating);
  locatingRef.current = locating;
  const locateTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // ── Draggable bottom sheet ────────────────────────────────────────────
  // The wearer/zone panel snaps between a collapsed and an expanded height.
  // Drag the handle (or the "Tracking…" header) up to expand / down to
  // collapse; tap the handle to toggle. Height is animated (the map above
  // simply gives up / reclaims the space) and the inner list scrolls
  // independently of the drag. Snap points are fractions of the actual
  // map+sheet area (measured via onLayout below), NOT the window — this
  // screen sits above the tab bar, so the window height overshoots and the
  // expanded sheet would spill under the tabs.
  const { height: winH } = useWindowDimensions();
  const [sheetAreaH, setSheetAreaH] = useState(0);       // map+sheet area
  const [sheetDragH, setSheetDragH] = useState(0);       // handle+header height
  const [sheetContentH, setSheetContentH] = useState(0); // scroll content height
  const SHEET_AREA = sheetAreaH || Math.round(winH * 0.6);
  const RAW_COLLAPSED = Math.round(SHEET_AREA * 0.52);
  const RAW_EXPANDED = Math.round(SHEET_AREA * 0.93);
  // Cap both snaps at the sheet's NATURAL height (paddingTop 6 + drag zone +
  // list) so a short roster hugs its content instead of leaving an empty
  // white gap below it — the map above just reclaims the freed space. Before
  // the content is measured we don't cap (fall back to the full snaps).
  const SHEET_NATURAL = sheetDragH > 0 && sheetContentH > 0
    ? sheetDragH + sheetContentH + 6
    : RAW_EXPANDED;
  const SHEET_COLLAPSED = Math.min(RAW_COLLAPSED, SHEET_NATURAL);
  const SHEET_EXPANDED = Math.min(RAW_EXPANDED, SHEET_NATURAL);
  const snapRef = useRef({ collapsed: SHEET_COLLAPSED, expanded: SHEET_EXPANDED });
  snapRef.current = { collapsed: SHEET_COLLAPSED, expanded: SHEET_EXPANDED };
  const sheetH = useRef(new Animated.Value(SHEET_COLLAPSED)).current;
  const dragStartH = useRef(SHEET_COLLAPSED);
  const [sheetExpanded, setSheetExpanded] = useState(false);

  // Re-sync the sheet to its current snap whenever the area or the natural
  // content height changes (first layout, rotation, roster grows / shrinks),
  // correcting the pre-layout fallback so no empty gap persists.
  useEffect(() => {
    if (sheetAreaH <= 0) return;
    sheetH.setValue(sheetExpanded ? snapRef.current.expanded : snapRef.current.collapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetAreaH, sheetDragH, sheetContentH]);

  const snapSheet = useCallback((toExpanded: boolean) => {
    setSheetExpanded(toExpanded);
    Animated.spring(sheetH, {
      toValue: toExpanded ? snapRef.current.expanded : snapRef.current.collapsed,
      useNativeDriver: false,
      bounciness: 0,
      speed: 16,
    }).start();
  }, [sheetH]);

  const sheetPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      // Claim only a deliberate vertical drag, so taps (e.g. the "Center"
      // button) still register and horizontal gestures are ignored.
      onMoveShouldSetPanResponder: (_, g) =>
        Math.abs(g.dy) > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderGrant: () => {
        sheetH.stopAnimation((v: number) => { dragStartH.current = v; });
      },
      onPanResponderMove: (_, g) => {
        const { collapsed, expanded } = snapRef.current;
        sheetH.setValue(Math.max(collapsed, Math.min(expanded, dragStartH.current - g.dy)));
      },
      onPanResponderRelease: (_, g) => {
        const { collapsed, expanded } = snapRef.current;
        const settled = Math.max(collapsed, Math.min(expanded, dragStartH.current - g.dy));
        const toExpanded = g.vy < -0.5 ? true
          : g.vy > 0.5 ? false
          : settled > (collapsed + expanded) / 2;
        snapSheet(toExpanded);
      },
      onPanResponderTerminate: () => {
        const { collapsed, expanded } = snapRef.current;
        sheetH.stopAnimation((v: number) => snapSheet(v > (collapsed + expanded) / 2));
      },
    }),
  ).current;

  const loadData = useCallback(async (silent = false) => {
    if (!profile?.id) return;
    if (!silent) setLoading(true);
    try {
      const wearers = await getLinkedWearers(profile.id);
      const locations: WearerLocation[] = [];
      const allFences: Geofence[] = [];
      for (const link of wearers) {
        const wearerId = link.wearer?.id || link.wearer_id;
        const wearerName = link.wearer?.full_name || t('alerts.unknown');
        try {
          const loc = await getLatestLocation(wearerId);
          if (loc) {
            locations.push({
              id: wearerId, name: wearerName, latitude: loc.latitude, longitude: loc.longitude,
              lastSeen: new Date(loc.recorded_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), hasRealLocation: true,
            });
          } else {
            locations.push({
              id: wearerId, name: wearerName, latitude: 30.0444, longitude: 31.2357,
              lastSeen: t('map.noLocationData'), hasRealLocation: false,
            });
          }
        } catch {
          locations.push({
            id: wearerId, name: wearerName, latitude: 30.0444, longitude: 31.2357,
            lastSeen: t('map.noLocationData'), hasRealLocation: false,
          });
        }
        try {
          const fences = await getGeofences(wearerId);
          allFences.push(...fences);
        } catch {}
      }
      setWearerLocations(locations);
      setGeofences(allFences);
    } catch (err) {
      console.error('Failed to load map data:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [profile?.id, t]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadData(true); } finally { setRefreshing(false); }
  }, [loadData]);

  // Ping a wearer's device for a fresh GPS fix. The response lands on the
  // `locations` realtime subscription (below), which clears the spinner +
  // toasts; a 12 s fallback clears it if the device never answers.
  const handleLocate = useCallback((wearer: WearerLocation) => {
    if (locatingRef.current.has(wearer.id)) return;
    setLocating((prev) => new Set(prev).add(wearer.id));
    void requestLocationNow(wearer.id);
    clearTimeout(locateTimeouts.current[wearer.id]);
    // The wearer answers a broadcast instantly; if that doesn't land (e.g.
    // Realtime broadcast disabled), the device still re-reports on its own
    // cadence (~30 s), and the `locations` subscription clears the spinner
    // when any fresh fix arrives. 35 s covers that worst case before we
    // declare the device unreachable.
    locateTimeouts.current[wearer.id] = setTimeout(() => {
      delete locateTimeouts.current[wearer.id];
      setLocating((prev) => { const n = new Set(prev); n.delete(wearer.id); return n; });
      showToast(t('map.locateTimeout', { name: wearer.name.split(' ')[0] }), 'error');
    }, 35000);
  }, [showToast, t]);

  // Clear any pending locate timers on unmount.
  useEffect(() => () => {
    Object.values(locateTimeouts.current).forEach(clearTimeout);
  }, []);

  /** Realtime location updates from the wearer's tracking ping. */
  useEffect(() => {
    if (!profile?.id || wearerLocations.length === 0) return;
    const wearerIds = wearerLocations.map((w) => w.id);
    const channel = supabase
      .channel('location-updates')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'locations' }, (payload) => {
        const newLoc = payload.new as { user_id: string; latitude: number; longitude: number };
        if (wearerIds.includes(newLoc.user_id)) {
          setWearerLocations((prev) => prev.map((w) =>
            w.id === newLoc.user_id
              ? { ...w, latitude: newLoc.latitude, longitude: newLoc.longitude, lastSeen: t('caregiver.timeJustNow'), hasRealLocation: true }
              : w));
          // A fresh fix arrived for a wearer we just pinged → resolve it.
          if (locatingRef.current.has(newLoc.user_id)) {
            clearTimeout(locateTimeouts.current[newLoc.user_id]);
            delete locateTimeouts.current[newLoc.user_id];
            setLocating((prev) => { const n = new Set(prev); n.delete(newLoc.user_id); return n; });
            showToast(t('map.locateUpdated'), 'success');
          }
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, wearerLocations, t, showToast]);

  // Open the wearer's ACTUAL location in the device's maps app (real
  // streets / place names). Native maps URI per platform, web fallback —
  // no Google Maps SDK / API key in the app, just a deep link out.
  const openInMaps = (lat: number, lng: number, label?: string) => {
    const q = `${lat},${lng}`;
    const name = encodeURIComponent(label || t('alerts.unknown'));
    const native = Platform.select({
      ios: `maps://?q=${name}&ll=${q}`,
      android: `geo:${q}?q=${q}(${name})`,
      default: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`,
    }) as string;
    Linking.openURL(native).catch(() => {
      Linking.openURL(`https://www.google.com/maps/search/?api=1&query=${q}`).catch(() => {});
    });
  };

  const handleCreateGeofence = async () => {
    if (!selectedWearer || !newFenceName.trim() || !profile?.id) return;
    const radiusMeters = parseInt(newFenceRadius) || 0;
    if (radiusMeters < 50) return;
    const wearer = wearerLocations.find((w) => w.id === selectedWearer);
    if (!wearer || !wearer.hasRealLocation) {
      showToast(t('map.safeZoneNoLocationYet'), 'error');
      return;
    }
    setCreating(true);
    try {
      const fence = await createGeofence({
        wearerId: selectedWearer,
        name: newFenceName.trim(),
        latitude: wearer.latitude,
        longitude: wearer.longitude,
        radius: radiusMeters,
        createdBy: profile.id,
      });
      setGeofences((prev) => [...prev, fence]);
      setShowAddGeofence(false);
      setNewFenceName('');
      setNewFenceRadius('100');
      setSelectedWearer(null);
      showToast(t('map.safeZoneCreated'), 'success');
    } catch (err) {
      console.error('Failed to create geofence:', err);
      showToast(t('map.safeZoneCreateFailed'), 'error');
    } finally {
      setCreating(false);
    }
  };

  const closeDeleteConfirm = () => { if (!deleting) setFenceToDelete(null); };
  const confirmDelete = async () => {
    if (!fenceToDelete) return;
    setDeleting(true);
    try {
      await deleteGeofence(fenceToDelete.id);
      setGeofences((prev) => prev.filter((f) => f.id !== fenceToDelete.id));
      setFenceToDelete(null);
      showToast(t('map.safeZoneDeleted'), 'success');
    } catch (err) {
      console.error('Failed to delete geofence:', err);
      setFenceToDelete(null);
      showToast(t('common.error'), 'error');
    } finally {
      setDeleting(false);
    }
  };

  /** Per-wearer status: closest safe-zone status + distance, plus a
   *  human-readable Inside/Outside pill variant. Returns null when no
   *  zones are configured for that wearer. */
  const wearerZoneStatus = (wearer: WearerLocation) => {
    if (!wearer.hasRealLocation) return null;
    const wearerFences = geofences.filter((f) => f.wearer_id === wearer.id);
    if (wearerFences.length === 0) return null;
    // Pick the nearest fence to report against.
    const withDistance = wearerFences.map((f) => ({
      fence: f,
      dist: getDistanceMeters(wearer.latitude, wearer.longitude, f.latitude, f.longitude),
    }));
    withDistance.sort((a, b) => a.dist - b.dist);
    const closest = withDistance[0];
    const inside = closest.dist <= closest.fence.radius_meters;
    return {
      fence: closest.fence,
      distance: closest.dist,
      inside,
    };
  };

  /** Adapter from WearerLocation[] → the schematic map's wearer shape,
   *  folding in the active-alert flag for the danger-coloured pin. */
  const mapWearers = useMemo(
    () => wearerLocations.map((w) => ({
      id: w.id, name: w.name, latitude: w.latitude, longitude: w.longitude,
      hasRealLocation: w.hasRealLocation, inAlert: wearersInAlert.has(w.id),
    })),
    [wearerLocations, wearersInAlert],
  );

  // The funnel filter only affects what the MAP draws (the roster below
  // always lists everyone). Hidden wearers drop their pin + zone; the
  // zone toggle hides all dashed circles.
  const visibleMapWearers = useMemo(
    () => mapWearers.filter((w) => !hiddenWearerIds.has(w.id)),
    [mapWearers, hiddenWearerIds],
  );
  const mapGeofencesShown = useMemo(
    () => (showZones ? geofences.filter((g) => !hiddenWearerIds.has(g.wearer_id)) : []),
    [showZones, geofences, hiddenWearerIds],
  );
  const mapFilterActive = hiddenWearerIds.size > 0 || !showZones;

  if (loading) return <MapSkeleton />;

  if (!loading && wearerLocations.length === 0) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
        <PageHeader eyebrow={t('map.liveLocationEyebrow')} title={t('tabs.map')} />
        {/* Card-less, centered — matches the alerts empty state. */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
          <EmptyState
            icon="map-marker-radius-outline"
            title={t('map.liveLocationMap')}
            description={t('map.linkWearerForLocation')}
          />
        </View>
        <Toast snack={snack} onDismiss={dismissToast} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      <PageHeader
        eyebrow={t('map.liveLocationEyebrow')}
        title={t('tabs.map')}
        action={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {/* Funnel — filter which wearers / zones the map draws. */}
            <Pressable
              onPress={() => setFilterOpen(true)}
              hitSlop={6}
              style={({ pressed }) => ({
                width: 44, height: 44, borderRadius: 999,
                backgroundColor: palette.surface,
                borderWidth: 1, borderColor: mapFilterActive ? palette.accent2 : palette.border,
                alignItems: 'center', justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <AuthIcon name="filter" color={mapFilterActive ? palette.accentInk : palette.text} size={20} />
              {mapFilterActive && (
                <View style={{
                  position: 'absolute', top: 7, right: 7, width: 9, height: 9, borderRadius: 999,
                  backgroundColor: palette.accent2, borderWidth: 1.5, borderColor: palette.surface,
                }} />
              )}
            </Pressable>
            {/* Refresh — re-pull latest locations + zones. */}
            <Pressable
              onPress={handleRefresh}
              hitSlop={6}
              disabled={refreshing}
              style={({ pressed }) => ({
                width: 44, height: 44, borderRadius: 999,
                backgroundColor: palette.surface,
                borderWidth: 1, borderColor: palette.border,
                alignItems: 'center', justifyContent: 'center',
                opacity: pressed || refreshing ? 0.6 : 1,
              })}
            >
              <AuthIcon name="refresh" color={palette.text} size={20} />
            </Pressable>
          </View>
        }
      />

      {/* Map + sheet share this flex area; its measured height is the basis
          for the sheet's snap points (the screen sits above the tab bar, so
          the window height would overshoot). */}
      <View style={{ flex: 1 }} onLayout={(e) => { const h = e.nativeEvent.layout.height; setSheetAreaH(h); }}>
      {/* In-app schematic map (no Google Maps / API key) + zoom controls. */}
      <View style={{ flex: 1 }}>
        <SchematicMap
          ref={mapRef}
          wearers={visibleMapWearers}
          geofences={mapGeofencesShown}
          emptyLabel={t('map.noLiveLocation')}
          onPinPress={(id) => mapRef.current?.centerOn(id)}
        />
        <View style={{ position: 'absolute', top: 12, right: 12, gap: 10 }}>
          {(['plus', 'minus'] as const).map((kind) => (
            <Pressable
              key={kind}
              onPress={() => (kind === 'plus' ? mapRef.current?.zoomIn() : mapRef.current?.zoomOut())}
              style={({ pressed }) => ({
                width: 44, height: 44, borderRadius: 999,
                backgroundColor: palette.surface,
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: palette.border,
                shadowColor: palette.shadowSm, shadowOpacity: 1,
                shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <MaterialCommunityIcons name={kind} size={22} color={palette.text} />
            </Pressable>
          ))}
        </View>
      </View>

      {/* Bottom sheet — wearer roster (tap a row to centre the map on that
          wearer; long-press opens the system map app) + safe-zone CRUD. */}
      <Animated.View style={{
        backgroundColor: palette.surface,
        borderTopLeftRadius: 24, borderTopRightRadius: 24,
        paddingTop: 6, height: sheetH,
        shadowColor: '#000', shadowOpacity: isDark ? 0.3 : 0.08,
        shadowRadius: 12, shadowOffset: { width: 0, height: -3 }, elevation: 16,
      }}>
        {/* Drag zone — handle + header. A deliberate vertical drag here
            expands / collapses the sheet (the list below still scrolls
            on its own); tapping the handle toggles it. */}
        <View {...sheetPan.panHandlers} onLayout={(e) => { const h = e.nativeEvent.layout.height; setSheetDragH(h); }}>
          <Pressable onPress={() => snapSheet(!sheetExpanded)} hitSlop={10} style={{ alignItems: 'center', paddingVertical: 6 }}>
            <View style={{
              width: 40, height: 5, borderRadius: 3, backgroundColor: palette.border,
            }} />
          </Pressable>
          <View style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 20, marginTop: 6, marginBottom: 6,
          }}>
            <Text style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 16, color: palette.text }}>
              {t('map.tracking', { count: wearerLocations.length })}
            </Text>
            <Pressable onPress={() => mapRef.current?.centerAll()} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
              <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 14, color: palette.accentInk }}>
                {t('map.center')}
              </Text>
            </Pressable>
          </View>
        </View>

        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 18 }} showsVerticalScrollIndicator={false} onContentSizeChange={(_, h) => setSheetContentH(h)}>
          {wearerLocations.map((wearer, i) => {
            const zoneStatus = wearerZoneStatus(wearer);
            const inAlert = wearersInAlert.has(wearer.id);
            const insidePill = zoneStatus?.inside === true;
            const sub = zoneStatus
              ? fmtDistance(zoneStatus.distance, t, zoneStatus.fence.name)
              : wearer.hasRealLocation
                ? t('map.lastSeen', { time: wearer.lastSeen })
                : t('map.noLocationData');
            return (
              <Pressable
                key={wearer.id}
                onPress={() => mapRef.current?.centerOn(wearer.id)}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 12,
                  borderTopWidth: i === 0 || inAlert ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: palette.border,
                  ...(inAlert ? {
                    backgroundColor: palette.dangerSoft, borderRadius: radius.md,
                    paddingHorizontal: 12, marginVertical: 4,
                  } : {}),
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Avatar.Text
                  size={40}
                  label={initials(wearer.name)}
                  style={{ backgroundColor: inAlert ? palette.danger : palette.accentSoft }}
                  color={inAlert ? '#FFFFFF' : palette.accentInk}
                  labelStyle={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{
                    fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 15,
                    color: inAlert ? palette.dangerInk : palette.text,
                  }}>
                    {wearer.name}
                  </Text>
                  <Text numberOfLines={1} style={{
                    fontFamily: fontFamily.mono, fontSize: 11, marginTop: 2,
                    color: inAlert ? palette.dangerInk : palette.text3,
                  }}>
                    {inAlert ? t('map.activeAlertNow') : sub}
                  </Text>
                </View>
                {zoneStatus && !inAlert && (
                  <Pill variant={insidePill ? 'success' : 'danger'} dot>
                    {insidePill ? t('map.inside') : t('map.outside')}
                  </Pill>
                )}
                {/* Locate now — ping this wearer's device for a fresh fix. */}
                <Pressable
                  onPress={() => handleLocate(wearer)}
                  hitSlop={8}
                  disabled={locating.has(wearer.id)}
                  accessibilityLabel={t('map.locate')}
                  style={({ pressed }) => ({
                    width: 34, height: 34, borderRadius: 999,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: palette.accentSoft,
                    opacity: pressed ? 0.6 : 1,
                  })}
                >
                  {locating.has(wearer.id)
                    ? <ActivityIndicator size="small" color={palette.accentInk} />
                    : <MaterialCommunityIcons name="crosshairs-gps" size={18} color={palette.accentInk} />}
                </Pressable>
                {/* Open the actual location in the device's maps app. */}
                <Pressable
                  onPress={() => openInMaps(wearer.latitude, wearer.longitude, wearer.name)}
                  hitSlop={8}
                  disabled={!wearer.hasRealLocation}
                  accessibilityLabel={t('map.viewOnMap')}
                  style={({ pressed }) => ({
                    width: 34, height: 34, borderRadius: 999,
                    alignItems: 'center', justifyContent: 'center',
                    backgroundColor: palette.surface2,
                    borderWidth: 1, borderColor: palette.border,
                    opacity: !wearer.hasRealLocation ? 0.4 : pressed ? 0.6 : 1,
                  })}
                >
                  <MaterialCommunityIcons name="map-marker-outline" size={18} color={palette.text2} />
                </Pressable>
              </Pressable>
            );
          })}

          <SectionTitle style={{ marginTop: 16 }}>{t('map.safeZones')}</SectionTitle>
          {geofences.length === 0 ? (
            <Text style={{
              fontFamily: fontFamily.sans, fontSize: 12.5, color: palette.text3,
              marginTop: 6, marginBottom: 4,
            }}>
              {t('map.noSafeZones')}
            </Text>
          ) : (
            <View style={{ marginTop: 6, gap: 10 }}>
              {geofences.map((fence) => {
                // Which wearer this zone belongs to — a caregiver can have
                // zones across several wearers, so the row must name the owner.
                const fenceWearer = wearerLocations.find((w) => w.id === fence.wearer_id)?.name ?? t('alerts.unknown');
                return (
                <View key={fence.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                  <IconDot icon="shield-check-outline" variant="success" size={32} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: fontFamily.sansSemibold, fontSize: 14, fontWeight: '600', color: palette.text }}>
                      {fence.name}
                    </Text>
                    <Text numberOfLines={1} style={{ fontFamily: fontFamily.mono, fontSize: 11, color: palette.text3, marginTop: 2 }}>
                      {fenceWearer} · {t('safeZones.radius', { meters: fence.radius_meters })}
                    </Text>
                  </View>
                  <IconButton icon="delete-outline" size={20} iconColor={palette.danger} onPress={() => setFenceToDelete(fence)} />
                </View>
                );
              })}
            </View>
          )}

          <BtnTonal size="md" onPress={() => setShowAddGeofence(true)} style={{ alignSelf: 'stretch', borderRadius: radius.pill, marginTop: 14 }}>
            + {t('map.addSafeZone')}
          </BtnTonal>
        </ScrollView>
      </Animated.View>
      </View>

      {/* Create-safe-zone dialog */}
      <Portal>
        <Dialog
          visible={showAddGeofence}
          onDismiss={() => { setShowAddGeofence(false); setSelectedWearer(null); }}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text }}>
            {t('map.addSafeZone')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 12, paddingBottom: 20 }}>
            <Text style={{ fontFamily: fontFamily.sans, fontSize: 12, color: palette.text2 }}>
              {t('map.addSafeZoneDesc')}
            </Text>
            <AuthInput
              icon="pin"
              value={newFenceName}
              onChangeText={setNewFenceName}
              placeholder={t('map.zoneName')}
              autoCapitalize="words"
            />
            <AuthInput
              icon="target"
              value={newFenceRadius}
              onChangeText={(v) => setNewFenceRadius(v.replace(/[^0-9]/g, ''))}
              placeholder={t('map.radius')}
              keyboardType="number-pad"
              maxLength={5}
            />
            {newFenceRadius.length > 0 && (parseInt(newFenceRadius) || 0) < 50 && (
              <Text style={{ fontFamily: fontFamily.sans, fontSize: 11, color: palette.danger }}>
                {t('map.minimumRadius')}
              </Text>
            )}
            {wearerLocations.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12, color: palette.text2 }}>
                  {t('map.forWhichWearer')}
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {wearerLocations.map((w) => {
                    const selected = selectedWearer === w.id;
                    return (
                      <Pressable
                        key={w.id}
                        onPress={() => w.hasRealLocation && setSelectedWearer(w.id)}
                        disabled={!w.hasRealLocation}
                        style={{
                          paddingHorizontal: 12, height: 30, borderRadius: 999,
                          alignItems: 'center', justifyContent: 'center',
                          borderWidth: 1,
                          borderColor: selected ? palette.accent2 : palette.border,
                          backgroundColor: selected ? palette.accentSoft : palette.surface,
                          opacity: w.hasRealLocation ? 1 : 0.5,
                        }}
                      >
                        <Text style={{
                          fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12,
                          color: selected ? palette.accentInk : palette.text2,
                        }}>
                          {w.name}{!w.hasRealLocation ? ` ${t('map.noLocation')}` : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => { setShowAddGeofence(false); setSelectedWearer(null); }}
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
            <View style={{
              opacity: (creating || !newFenceName.trim() || !selectedWearer || (parseInt(newFenceRadius) || 0) < 50) ? 0.5 : 1,
            }}>
              <BtnTonal
                size="sm"
                onPress={
                  creating || !newFenceName.trim() || !selectedWearer || (parseInt(newFenceRadius) || 0) < 50
                    ? undefined
                    : handleCreateGeofence
                }
              >
                {creating ? '…' : t('map.create')}
              </BtnTonal>
            </View>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      {/* Themed delete-safe-zone confirm */}
      {fenceToDelete && (
        <Portal>
          <Dialog
            visible
            onDismiss={closeDeleteConfirm}
            style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
          >
            <Dialog.Icon icon="shield-remove-outline" color={palette.danger} size={36} />
            <Dialog.Title style={{
              fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text,
              textAlign: 'center',
            }}>
              {t('map.deleteZone')}
            </Dialog.Title>
            <Dialog.Content style={{ paddingBottom: 20 }}>
              <Text style={{
                fontFamily: fontFamily.sans, fontSize: 14, color: palette.text2,
                textAlign: 'center',
              }}>
                {t('map.deleteZoneConfirm', { name: fenceToDelete.name })}
              </Text>
            </Dialog.Content>
            <Dialog.Actions>
              <Pressable
                onPress={closeDeleteConfirm}
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
              <View style={{ opacity: deleting ? 0.5 : 1 }}>
                <BtnTonal
                  size="sm"
                  tone="danger"
                  onPress={deleting ? undefined : confirmDelete}
                >
                  {deleting ? '…' : t('map.delete')}
                </BtnTonal>
              </View>
            </Dialog.Actions>
          </Dialog>
        </Portal>
      )}

      {/* Map filter sheet — which wearers the map draws + zone toggle. */}
      <Portal>
        <Dialog
          visible={filterOpen}
          onDismiss={() => setFilterOpen(false)}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text }}>
            {t('map.filterTitle')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 18, paddingBottom: 18 }}>
            <View style={{ gap: 10 }}>
              <Eyebrow>{t('map.filterShowWearers')}</Eyebrow>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {wearerLocations.map((w) => {
                  const shown = !hiddenWearerIds.has(w.id);
                  return (
                    <Pressable
                      key={w.id}
                      onPress={() => setHiddenWearerIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(w.id)) next.delete(w.id); else next.add(w.id);
                        return next;
                      })}
                      style={({ pressed }) => ({
                        paddingHorizontal: 14, height: 34, borderRadius: 999,
                        flexDirection: 'row', alignItems: 'center', gap: 6,
                        borderWidth: 1,
                        borderColor: shown ? palette.accent2 : palette.border,
                        backgroundColor: shown ? palette.accentSoft : palette.surface,
                        opacity: pressed ? 0.6 : 1,
                      })}
                    >
                      {shown && <MaterialCommunityIcons name="check" size={14} color={palette.accentInk} />}
                      <Text style={{
                        fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13,
                        color: shown ? palette.accentInk : palette.text2,
                      }}>
                        {w.name.split(' ')[0]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            <View style={{ gap: 10 }}>
              <Eyebrow>{t('map.filterSafeZones')}</Eyebrow>
              <Pressable
                onPress={() => setShowZones((s) => !s)}
                style={({ pressed }) => ({
                  alignSelf: 'flex-start',
                  paddingHorizontal: 14, height: 34, borderRadius: 999,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  borderWidth: 1,
                  borderColor: showZones ? palette.accent2 : palette.border,
                  backgroundColor: showZones ? palette.accentSoft : palette.surface,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                {showZones && <MaterialCommunityIcons name="check" size={14} color={palette.accentInk} />}
                <Text style={{
                  fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13,
                  color: showZones ? palette.accentInk : palette.text2,
                }}>
                  {t('map.showSafeZones')}
                </Text>
              </Pressable>
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => { setHiddenWearerIds(new Set()); setShowZones(true); }}
              disabled={!mapFilterActive}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: mapFilterActive ? 1 : 0.4 }}
            >
              <Text style={{ fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500', color: palette.text2 }}>
                {t('map.filterReset')}
              </Text>
            </Pressable>
            <BtnTonal size="sm" onPress={() => setFilterOpen(false)}>
              {t('common.done')}
            </BtnTonal>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Toast snack={snack} onDismiss={dismissToast} />
    </SafeAreaView>
  );
}
