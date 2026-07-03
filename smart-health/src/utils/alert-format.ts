/**
 * Shared alert presentation helpers — the single source of truth for how
 * an alert is rendered across the app (the caregiver Alerts tab and the
 * Wearer Detail "Recent alerts" timeline). Kept here so the two screens
 * can't drift on glyph / severity colour / title / context / time copy.
 */
import type { Alert, AlertType } from '@/types/alert.types';
import type { AuthIconName } from '@/components/AuthControls';
import type { ColorPalette } from '@/design/tokens';

/** Per-type Lucide glyph — matched 1:1 with the design source. */
export const ALERT_GLYPH: Record<AlertType, AuthIconName> = {
  fall:        'fall-tumble',
  sos:         'alert-octagon',
  geofence:    'map-pin-alert',
  low_battery: 'battery-low',
  cardiac:     'heart',
  inactivity:  'alert-circle',
};

/** Icon-tile colour by severity — matches the design: high/critical
 *  red, medium amber, low blue (info, not green). */
export const SEVERITY_VARIANT: Record<string, 'danger' | 'warning' | 'info' | 'success'> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

export function inkForVariant(
  palette: ColorPalette,
  v: 'danger' | 'warning' | 'info' | 'success' | 'default',
): string {
  switch (v) {
    case 'danger':  return palette.dangerInk;
    case 'warning': return palette.warningInk;
    case 'success': return palette.successInk;
    case 'info':    return palette.infoInk;
    default:        return palette.text3;
  }
}

export function titleFor(type: AlertType, t: (k: string) => string): string {
  switch (type) {
    case 'fall':        return t('alerts.fallTitle');
    case 'sos':         return t('alerts.sosTitle');
    case 'cardiac':     return t('alerts.cardiacTitle');
    case 'geofence':    return t('alerts.geofenceTitle');
    case 'inactivity':  return t('alerts.inactivityTitle');
    case 'low_battery': return t('alerts.lowBatteryTitle');
    default:            return type;
  }
}

/** Wearer · context (bpm / zone / battery / place / confidence). */
export function alertContext(alert: Alert, t: (k: string, v?: object) => string): string | null {
  const md = (alert.metadata ?? {}) as Record<string, unknown>;
  switch (alert.type) {
    case 'cardiac': {
      const hr = md.heart_rate ?? md.bpm;
      return typeof hr === 'number' ? t('alerts.subBpm', { n: Math.round(hr) }) : null;
    }
    case 'low_battery': {
      const pct = md.battery_level ?? md.battery;
      return typeof pct === 'number' ? t('alerts.subBattery', { n: Math.round(pct) }) : null;
    }
    case 'inactivity': {
      const hrs = md.inactive_hours ?? md.hours;
      return typeof hrs === 'number' ? t('alerts.subInactiveHours', { n: Math.round(hrs) }) : null;
    }
    case 'geofence': {
      const name = md.zone_name ?? md.zone ?? md.place;
      return typeof name === 'string'
        ? (md.outside === true ? t('alerts.subOutsideZone', { name }) : String(name))
        : null;
    }
    case 'fall': {
      const place = md.place ?? md.address;
      if (typeof place === 'string') return place;
      if (typeof alert.confidence === 'number') {
        return t('alerts.subConfidence', { value: alert.confidence.toFixed(2) });
      }
      return null;
    }
    default: return null;
  }
}

export function fmtAlertTime(
  iso: string,
  t: (k: string, v?: object) => string,
  locale: string,
): string {
  const now = new Date();
  const then = new Date(iso);
  const diffSec = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (diffSec < 5) return t('alerts.timeJustNow');
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);

  if (sameDay(now, then)) {
    if (diffSec < 60) return `${diffSec}s ago`;
    const mins = Math.floor(diffSec / 60);
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.floor(mins / 60);
    return `${hrs}h ago`;
  }
  const timePart = then.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(yesterday, then)) return t('alerts.timeYesterdayAt', { time: timePart });
  if (diffSec < 7 * 24 * 3600) {
    const day = then.toLocaleDateString(locale, { weekday: 'short' });
    return t('alerts.timeWeekdayAt', { day, time: timePart });
  }
  return then.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export type DerivedStatus = 'active' | 'ack' | 'resolved';
export function derivedStatus(alert: Alert): DerivedStatus {
  if (alert.status !== 'active') return 'resolved';
  const md = (alert.metadata ?? {}) as Record<string, unknown>;
  return md.acknowledged_at ? 'ack' : 'active';
}
