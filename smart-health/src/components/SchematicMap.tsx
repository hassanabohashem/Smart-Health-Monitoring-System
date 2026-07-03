import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  View, Text, Pressable, PanResponder, type LayoutChangeEvent,
} from 'react-native';
import Svg, { Line, Circle } from 'react-native-svg';
import { useDesignTokens } from '@/design';
import { fontFamily } from '@/design/tokens';

/**
 * A Google-Maps-free "schematic" location view. It projects each wearer's
 * real lat/lng into a local 2-D plane (equirectangular approximation around
 * the points' centroid), then draws a decorative street grid, dashed
 * geofence circles, and tappable wearer pins with `react-native-svg` + RN
 * views. Pan via drag; zoom + recenter via the imperative handle so the
 * on-screen +/- and "Center" controls can live outside the canvas.
 *
 * It is intentionally NOT geographically accurate (no tiles, no API key) —
 * relative positions and distances are faithful enough to read "who is near
 * which safe zone", which is all the caregiver view needs.
 */
export interface SchematicMapHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  centerAll: () => void;
  centerOn: (id: string) => void;
}

export interface MapWearer {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  hasRealLocation: boolean;
  inAlert?: boolean;
}

export interface MapGeofence {
  id: string;
  wearer_id: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

const METERS_PER_DEG = 111320;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 5;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.slice(0, 2).map((p) => p[0] || '').join('');
  return s.toUpperCase() || '?';
}

interface Props {
  wearers: MapWearer[];
  geofences: MapGeofence[];
  emptyLabel: string;
  onPinPress?: (id: string) => void;
}

export const SchematicMap = forwardRef<SchematicMapHandle, Props>(
  function SchematicMap({ wearers, geofences, emptyLabel, onPinPress }, ref) {
    const { palette, isDark } = useDesignTokens();
    const [size, setSize] = useState({ w: 0, h: 0 });
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const panRef = useRef(pan);
    panRef.current = pan;
    const panStart = useRef({ x: 0, y: 0 });

    const live = useMemo(() => wearers.filter((w) => w.hasRealLocation), [wearers]);
    const hasLive = live.length > 0;

    // Pan-independent world frame: centroid reference, a meters→px "fit"
    // scale that frames every point + zone inside the viewport, and the
    // world-space bounding-box centre we keep pinned to the screen middle.
    const world = useMemo(() => {
      if (size.w === 0 || size.h === 0) return null;
      const pts = [
        ...live.map((w) => ({ lat: w.latitude, lng: w.longitude, r: 0 })),
        ...geofences.map((g) => ({ lat: g.latitude, lng: g.longitude, r: g.radius_meters })),
      ];
      if (pts.length === 0) return null;
      const refLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const refLng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
      const cosLat = Math.cos((refLat * Math.PI) / 180);
      const toWorld = (lat: number, lng: number) => ({
        x: (lng - refLng) * cosLat * METERS_PER_DEG,
        y: (lat - refLat) * METERS_PER_DEG,
      });
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        const { x, y } = toWorld(p.lat, p.lng);
        minX = Math.min(minX, x - p.r); maxX = Math.max(maxX, x + p.r);
        minY = Math.min(minY, y - p.r); maxY = Math.max(maxY, y + p.r);
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      // ≥300 m floor so a lone wearer with no zone doesn't zoom to infinity.
      const span = Math.max(maxX - minX, maxY - minY, 300);
      const fit = (Math.min(size.w, size.h) * 0.62) / span;
      return { toWorld, cx, cy, fit };
    }, [live, geofences, size]);

    const pxPerM = (world?.fit ?? 0) * zoom;
    const project = (lat: number, lng: number) => {
      if (!world) return { x: size.w / 2, y: size.h / 2 };
      const w = world.toWorld(lat, lng);
      return {
        x: size.w / 2 + (w.x - world.cx) * pxPerM + pan.x,
        y: size.h / 2 - (w.y - world.cy) * pxPerM + pan.y, // screen y grows downward
      };
    };

    useImperativeHandle(ref, () => ({
      zoomIn: () => setZoom((z) => clamp(z * 1.5, ZOOM_MIN, ZOOM_MAX)),
      zoomOut: () => setZoom((z) => clamp(z / 1.5, ZOOM_MIN, ZOOM_MAX)),
      centerAll: () => { setPan({ x: 0, y: 0 }); setZoom(1); },
      centerOn: (id) => {
        const target = wearers.find((x) => x.id === id);
        if (!target || !target.hasRealLocation || !world) return;
        const p = world.toWorld(target.latitude, target.longitude);
        const ppm = world.fit * zoom;
        setPan({ x: -(p.x - world.cx) * ppm, y: (p.y - world.cy) * ppm });
      },
    }), [wearers, world, zoom]);

    const panResponder = useRef(
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
        onPanResponderGrant: () => { panStart.current = panRef.current; },
        onPanResponderMove: (_, g) =>
          setPan({ x: panStart.current.x + g.dx, y: panStart.current.y + g.dy }),
      }),
    ).current;

    const onLayout = (e: LayoutChangeEvent) => {
      const { width, height } = e.nativeEvent.layout;
      setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
    };

    // Decorative street grid: scrolls with pan, scales lightly with zoom.
    // Every 3rd line is a thicker "road"; the rest are faint grid lines.
    const grid = useMemo(() => {
      const vert: { p: number; road: boolean }[] = [];
      const horz: { p: number; road: boolean }[] = [];
      if (size.w === 0) return { vert, horz };
      const gs = clamp(64 * zoom, 44, 120);
      const ox = ((pan.x % gs) + gs) % gs;
      const oy = ((pan.y % gs) + gs) % gs;
      for (let x = ox; x <= size.w; x += gs) {
        vert.push({ p: x, road: Math.round((x - pan.x) / gs) % 3 === 0 });
      }
      for (let y = oy; y <= size.h; y += gs) {
        horz.push({ p: y, road: Math.round((y - pan.y) / gs) % 3 === 0 });
      }
      return { vert, horz };
    }, [size, pan, zoom]);

    const roadColor = isDark ? palette.surface : '#FFFFFF';

    return (
      <View
        onLayout={onLayout}
        style={{ flex: 1, overflow: 'hidden', backgroundColor: palette.surface2 }}
        {...panResponder.panHandlers}
      >
        {size.w > 0 && (
          <Svg width={size.w} height={size.h}>
            {grid.vert.map((l, i) => (
              <Line
                key={`v${i}`} x1={l.p} y1={0} x2={l.p} y2={size.h}
                stroke={roadColor} strokeOpacity={l.road ? 0.9 : 0.4}
                strokeWidth={l.road ? 7 : 1.5}
              />
            ))}
            {grid.horz.map((l, i) => (
              <Line
                key={`h${i}`} x1={0} y1={l.p} x2={size.w} y2={l.p}
                stroke={roadColor} strokeOpacity={l.road ? 0.9 : 0.4}
                strokeWidth={l.road ? 7 : 1.5}
              />
            ))}
            {world && geofences.map((g) => {
              const c = project(g.latitude, g.longitude);
              // Floor the on-screen radius so a small (e.g. 100 m) zone stays a
              // visible green ring even when the map zooms out to fit wearers
              // that are far apart — otherwise a 100 m zone shrinks to sub-pixel
              // and disappears (the cause of "no circles" once a second, distant
              // wearer joined the view).
              const r = Math.max(g.radius_meters * pxPerM, 30);
              return (
                <Circle
                  key={g.id} cx={c.x} cy={c.y} r={r}
                  fill={palette.success} fillOpacity={0.15}
                  stroke={palette.success} strokeOpacity={0.95}
                  strokeWidth={2} strokeDasharray="6 5"
                />
              );
            })}
          </Svg>
        )}

        {/* Pins rendered as RN views (crisp text + tap target). Pins that land
            on (nearly) the same spot are fanned out so co-located wearers (e.g.
            two people at one address — or both writing from the same device in
            dev) don't hide each other. */}
        {world && (() => {
          const PIN = 46;
          const proj = live.map((w) => {
            const p = project(w.latitude, w.longitude);
            return { w, x: p.x, y: p.y };
          });
          // Cluster overlapping pins, then offset each cluster member around a
          // small circle so all stay visible + tappable.
          const clusters: number[][] = [];
          proj.forEach((it, i) => {
            const c = clusters.find(
              (cl) => Math.hypot(proj[cl[0]].x - it.x, proj[cl[0]].y - it.y) < PIN * 0.7,
            );
            if (c) c.push(i); else clusters.push([i]);
          });
          const pos: { x: number; y: number }[] = [];
          clusters.forEach((cl) => {
            if (cl.length === 1) {
              pos[cl[0]] = { x: proj[cl[0]].x, y: proj[cl[0]].y };
              return;
            }
            const bx = proj[cl[0]].x, by = proj[cl[0]].y, R = PIN * 0.6;
            cl.forEach((idx, k) => {
              const ang = (k / cl.length) * 2 * Math.PI - Math.PI / 2;
              pos[idx] = { x: bx + R * Math.cos(ang), y: by + R * Math.sin(ang) };
            });
          });
          return proj.map((it, i) => {
            const danger = !!it.w.inAlert;
            return (
              <Pressable
                key={it.w.id}
                onPress={() => onPinPress?.(it.w.id)}
                style={{
                  position: 'absolute', left: pos[i].x - 23, top: pos[i].y - 23,
                  width: 46, height: 46, borderRadius: 999,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: danger ? palette.danger : palette.accent,
                  borderWidth: 3, borderColor: palette.surface,
                  shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4,
                  shadowOffset: { width: 0, height: 2 }, elevation: 4,
                }}
              >
                <Text style={{
                  fontFamily: fontFamily.sansSemibold, fontWeight: '700',
                  fontSize: 13, color: palette.textOnAccent,
                }}>
                  {initials(it.w.name)}
                </Text>
              </Pressable>
            );
          });
        })()}

        {!hasLive && size.w > 0 && (
          <View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <View style={{
              paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
              backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.border,
            }}>
              <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 12.5, color: palette.text2 }}>
                {emptyLabel}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  },
);
