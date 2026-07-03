import { View, SectionList, Pressable, SafeAreaView, Text, RefreshControl } from 'react-native';
import { Portal, Dialog } from 'react-native-paper';
import { useRouter } from 'expo-router';
import { useEffect, useCallback, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/stores/auth.store';
import { useAlertsStore } from '@/stores/alerts.store';
import { getAlertsForCaregiver } from '@/services/alert.service';
import { AlertsListSkeleton } from '@/components/Skeleton';
import type { Alert } from '@/types/alert.types';
import {
  useDesignTokens, IconDot, Pill, Toast, useToast, Eyebrow, PageHeader, EmptyState, BtnTonal,
} from '@/design';
import { fontFamily, radius } from '@/design/tokens';
import { AuthIcon } from '@/components/AuthControls';
import {
  ALERT_GLYPH, SEVERITY_VARIANT, inkForVariant, titleFor, alertContext,
  fmtAlertTime, derivedStatus,
} from '@/utils/alert-format';

/** Plain-text 3-tab filter (All / Active / Resolved) — matches the
 *  design source which uses just three text labels, not a segmented
 *  pill. Active label is bolder + darker. */
const STATUS_OPTIONS = ['all', 'active', 'resolved'] as const;
type StatusFilter = typeof STATUS_OPTIONS[number];

/** Date presets for the filter sheet. */
const DATE_OPTIONS = ['all', 'today', '7d', '30d'] as const;
type DateFilter = typeof DATE_OPTIONS[number];
const DATE_LABEL_KEY: Record<DateFilter, string> = {
  all: 'alerts.dateAll', today: 'alerts.dateToday', '7d': 'alerts.date7d', '30d': 'alerts.date30d',
};

/** Start-of-day timestamp cutoff for a date preset; null = no bound.
 *  "7d"/"30d" are inclusive of today (subtract 6 / 29 days). */
function dateCutoff(range: DateFilter): number | null {
  if (range === 'all') return null;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  if (range === 'today') return start.getTime();
  start.setDate(start.getDate() - (range === '7d' ? 6 : 29));
  return start.getTime();
}

/** Selectable filter chip — bordered pill, accent-soft when selected
 *  (matches the safe-zone wearer chips on the Map tab). */
function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const { palette } = useDesignTokens();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        paddingHorizontal: 14, height: 34, borderRadius: 999,
        alignItems: 'center', justifyContent: 'center',
        borderWidth: 1,
        borderColor: selected ? palette.accent2 : palette.border,
        backgroundColor: selected ? palette.accentSoft : palette.surface,
        opacity: !selected && pressed ? 0.6 : 1,
      })}
    >
      <Text style={{
        fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13,
        color: selected ? palette.accentInk : palette.text2,
      }}>{label}</Text>
    </Pressable>
  );
}

/** Segmented pill control — `.seg` in the design source: surface2
 *  rounded background containing three equal-flex pill buttons; the
 *  active one is white with a tiny shadow. */
function FilterRow({ value, onChange }: { value: StatusFilter; onChange: (v: StatusFilter) => void }) {
  const { palette } = useDesignTokens();
  const { t } = useTranslation();
  const labels: Record<StatusFilter, string> = {
    all: t('alerts.filterAll'),
    active: t('alerts.filterActive'),
    resolved: t('alerts.filterResolved'),
  };
  return (
    // Matches the wearer Activity `RangePill`: content-width (left-
    // aligned via alignSelf), 18px horizontal padding per segment
    // (not flex:1), surface2 track, active segment = white + shadow.
    <View style={{
      flexDirection: 'row', alignSelf: 'flex-start',
      backgroundColor: palette.surface2,
      borderRadius: 999,
      padding: 4, gap: 2,
      marginTop: 4, marginBottom: 8,
    }}>
      {STATUS_OPTIONS.map((o) => {
        const active = o === value;
        return (
          <Pressable
            key={o}
            onPress={() => onChange(o)}
            style={({ pressed }) => ({
              paddingHorizontal: 18, height: 36,
              borderRadius: 999, alignItems: 'center', justifyContent: 'center',
              backgroundColor: active ? palette.surface : 'transparent',
              opacity: !active && pressed ? 0.6 : 1,
              ...(active ? {
                shadowColor: palette.shadowSm,
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 1, shadowRadius: 2, elevation: 1,
              } : {}),
            })}
          >
            <Text style={{
              fontFamily: fontFamily.sansMedium, fontSize: 13, fontWeight: '500',
              color: active ? palette.text : palette.text2,
            }}>
              {labels[o]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type Bucket = 'today' | 'yesterday' | 'thisWeek' | 'older';
function bucketOf(iso: string): Bucket {
  const now = new Date();
  const then = new Date(iso);
  const sod = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const today = sod(now);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 7);
  const td = sod(then);
  if (td.getTime() === today.getTime()) return 'today';
  if (td.getTime() === yesterday.getTime()) return 'yesterday';
  if (td.getTime() > weekAgo.getTime()) return 'thisWeek';
  return 'older';
}

function AlertCard({ alert, onPress }: { alert: Alert; onPress: () => void }) {
  const { t, i18n } = useTranslation();
  const { palette } = useDesignTokens();
  const locale = i18n.language || 'en';
  const variant = SEVERITY_VARIANT[alert.severity] || 'danger';
  const glyph = ALERT_GLYPH[alert.type] || 'alert-octagon';
  const inkColor = inkForVariant(palette, variant);
  const status = derivedStatus(alert);
  const wearerName = alert.wearer?.full_name?.split(' ')[0] || t('alerts.unknown');
  const context = alertContext(alert, t as never);
  const subLine = context ? `${wearerName} · ${context}` : wearerName;
  const timeStr = fmtAlertTime(alert.created_at, t as never, locale);

  /** Status pill — Active=danger, Ack=warning, Resolved=neutral grey.
   *  Rendered as a dotted Pill (design uses a colored-soft pill with a
   *  leading dot, not plain text). */
  const statusLabel = status === 'active' ? t('alerts.statusActive')
    : status === 'ack' ? t('alerts.statusAck')
    : t('alerts.statusResolved');
  const statusVariant: 'danger' | 'warning' | 'default' =
    status === 'active' ? 'danger'
    : status === 'ack' ? 'warning'
    : 'default';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'flex-start', gap: 12,
        // Proper card chrome per design `.card`: white bg + subtle
        // border + low-elevation shadow.
        backgroundColor: palette.surface,
        borderWidth: 1, borderColor: palette.border,
        borderRadius: radius.md,
        paddingHorizontal: 14, paddingVertical: 14,
        shadowColor: '#141823',
        shadowOpacity: 0.04,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 2,
        elevation: 1,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <IconDot
        iconNode={<AuthIcon name={glyph} color={inkColor} size={20} />}
        variant={variant}
        size={40}
      />
      <View style={{ flex: 1 }}>
        {/* Top row: title (left) + status pill (right). Design: title
            14px/600, status = soft-colored Pill with leading dot. */}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: fontFamily.sansSemibold, fontWeight: '600', fontSize: 14,
              lineHeight: 20, color: palette.text,
            }}
          >
            {titleFor(alert.type, t)}
          </Text>
          <Pill variant={statusVariant} dot>{statusLabel}</Pill>
        </View>
        {/* Bottom row: sub (left) + time (right). Design: both 11.5px/400. */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
          gap: 8, marginTop: 4,
        }}>
          <Text
            numberOfLines={1}
            style={{
              flex: 1,
              fontFamily: fontFamily.sans, fontSize: 11.5, color: palette.text2,
            }}
          >
            {subLine}
          </Text>
          <Text style={{
            fontFamily: fontFamily.sans, fontSize: 11.5, color: palette.text3,
          }}>
            {timeStr}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

export default function AlertsScreen() {
  const { t } = useTranslation();
  const { palette } = useDesignTokens();
  const router = useRouter();
  const profile = useAuthStore((s) => s.profile);
  const { alerts, setAlerts, isLoading, setLoading } = useAlertsStore();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [wearerFilter, setWearerFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const { snack, dismiss: dismissToast } = useToast();

  // Wearers that actually have alerts (you can only usefully filter to
  // one of these). Built from the loaded alerts, not a separate query.
  const wearerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const a of alerts) {
      if (a.wearer_id && !seen.has(a.wearer_id)) {
        seen.set(a.wearer_id, a.wearer?.full_name || t('alerts.unknown'));
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [alerts, t]);

  // The header funnel's "active" state + the empty-state branch key off
  // the date/wearer filters (status has its own always-visible pills).
  const dateOrWearerActive = wearerFilter !== 'all' || dateFilter !== 'all';

  const filtered = useMemo(() => {
    const cutoff = dateCutoff(dateFilter);
    return alerts.filter((a) => {
      if (statusFilter === 'active' && a.status !== 'active') return false;
      if (statusFilter === 'resolved' && a.status === 'active') return false;
      if (wearerFilter !== 'all' && a.wearer_id !== wearerFilter) return false;
      if (cutoff != null && new Date(a.created_at).getTime() < cutoff) return false;
      return true;
    });
  }, [alerts, statusFilter, wearerFilter, dateFilter]);

  const sections = useMemo(() => {
    const buckets: Record<Bucket, Alert[]> = {
      today: [], yesterday: [], thisWeek: [], older: [],
    };
    for (const a of filtered) buckets[bucketOf(a.created_at)].push(a);
    const titles: Record<Bucket, string> = {
      today: t('alerts.sectionToday'),
      yesterday: t('alerts.sectionYesterday'),
      thisWeek: t('alerts.sectionThisWeek'),
      older: t('alerts.sectionOlder'),
    };
    return (['today', 'yesterday', 'thisWeek', 'older'] as const)
      .map((k) => ({ title: titles[k], data: buckets[k] }))
      .filter((s) => s.data.length > 0);
  }, [filtered, t]);

  const loadAlerts = useCallback(async () => {
    if (!profile?.id) return;
    setLoading(true);
    try {
      const data = await getAlertsForCaregiver(profile.id);
      setAlerts(data);
    } catch (err) {
      console.error('Failed to load alerts:', err);
    } finally {
      setLoading(false);
    }
  }, [profile?.id, setAlerts, setLoading]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  if (isLoading) return <AlertsListSkeleton />;

  const isEmpty = sections.length === 0;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.bg }}>
      {/* Same PageHeader scaffold as the wearer Activity/Assistant tabs,
          with a circular funnel button (date + wearer filter sheet). The
          border turns accent + a dot shows when a filter is applied. */}
      <PageHeader
        eyebrow={t('alerts.eyebrowLast30')}
        title={t('tabs.alerts')}
        action={
          <Pressable
            onPress={() => setFilterOpen(true)}
            hitSlop={6}
            style={({ pressed }) => ({
              width: 44, height: 44, borderRadius: 999,
              backgroundColor: palette.surface,
              borderWidth: 1,
              borderColor: dateOrWearerActive ? palette.accent2 : palette.border,
              alignItems: 'center', justifyContent: 'center',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <AuthIcon name="filter" color={dateOrWearerActive ? palette.accentInk : palette.text} size={20} />
            {dateOrWearerActive && (
              <View style={{
                position: 'absolute', top: 7, right: 7, width: 9, height: 9, borderRadius: 999,
                backgroundColor: palette.accent2, borderWidth: 1.5, borderColor: palette.surface,
              }} />
            )}
          </Pressable>
        }
      />
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <FilterRow value={statusFilter} onChange={setStatusFilter} />
        }
        renderSectionHeader={({ section }) => (
          <Eyebrow style={{ marginTop: 14, marginBottom: 8 }}>{section.title}</Eyebrow>
        )}
        renderItem={({ item }) => (
          <AlertCard
            alert={item}
            onPress={() => router.push({ pathname: '/(shared)/alert-detail', params: { alertId: item.id } })}
          />
        )}
        ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
        ListEmptyComponent={
          isEmpty ? (
            // Vertically centered in the space below the filter
            // (flex:1 inside a flexGrow content container). Uses the
            // shared EmptyState primitive (sans-semibold title) so it
            // matches every other empty state in the app; icon / title /
            // copy all keyed off the active filter.
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 }}>
              {dateOrWearerActive ? (
                /* A date/wearer filter excluded everything — funnel icon +
                   a one-tap reset, rather than the misleading "All clear". */
                <EmptyState
                  iconNode={<AuthIcon name="filter" color={palette.text3} size={26} />}
                  iconVariant="default"
                  title={t('alerts.noFilterMatchTitle')}
                  description={t('alerts.noMatchingAlerts')}
                  action={
                    <Pressable
                      onPress={() => { setDateFilter('all'); setWearerFilter('all'); }}
                      style={({ pressed }) => ({
                        marginTop: 14, paddingHorizontal: 16, height: 36, borderRadius: 999,
                        backgroundColor: palette.accentSoft, alignItems: 'center', justifyContent: 'center',
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Text style={{ fontFamily: fontFamily.sansMedium, fontWeight: '500', fontSize: 13, color: palette.accentInk }}>
                        {t('alerts.clearFilters')}
                      </Text>
                    </Pressable>
                  }
                />
              ) : (
                /* Icon per status filter: All → neutral bell (nothing logged),
                   Active → green shield-check (all safe), Resolved →
                   neutral check (nothing closed yet). */
                <EmptyState
                  iconNode={
                    statusFilter === 'active'
                      ? <AuthIcon name="shield-check" color={palette.successInk} size={26} />
                      : statusFilter === 'resolved'
                        ? <AuthIcon name="check" color={palette.text3} size={26} />
                        : <AuthIcon name="bell" color={palette.text3} size={26} />
                  }
                  iconVariant={statusFilter === 'active' ? 'success' : 'default'}
                  title={
                    statusFilter === 'resolved' ? t('alerts.emptyResolvedTitle')
                      : statusFilter === 'active' ? t('alerts.emptyActiveTitle')
                      : t('alerts.emptyAllTitle')
                  }
                  description={
                    statusFilter === 'resolved' ? t('alerts.emptyResolvedDesc')
                      : statusFilter === 'active' ? t('alerts.emptyActiveDesc')
                      : t('alerts.emptyAllDesc')
                  }
                />
              )}
            </View>
          ) : null
        }
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingTop: 4,
          paddingBottom: 24,
          // flexGrow lets the empty component stretch to fill the
          // viewport below the filter so it can center vertically.
          flexGrow: 1,
        }}
        refreshControl={<RefreshControl refreshing={isLoading} onRefresh={loadAlerts} tintColor={palette.accent} />}
      />

      {/* Filter sheet — date preset + wearer. Status stays on the inline
          pills; these two secondary filters live behind the funnel. */}
      <Portal>
        <Dialog
          visible={filterOpen}
          onDismiss={() => setFilterOpen(false)}
          style={{ backgroundColor: palette.surface, borderRadius: radius.lg }}
        >
          <Dialog.Title style={{ fontFamily: fontFamily.sansSemibold, fontWeight: '600', color: palette.text }}>
            {t('alerts.filterTitle')}
          </Dialog.Title>
          <Dialog.Content style={{ gap: 18, paddingBottom: 18 }}>
            <View style={{ gap: 10 }}>
              <Eyebrow>{t('alerts.filterByDate')}</Eyebrow>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {DATE_OPTIONS.map((o) => (
                  <Chip key={o} label={t(DATE_LABEL_KEY[o])} selected={dateFilter === o} onPress={() => setDateFilter(o)} />
                ))}
              </View>
            </View>
            <View style={{ gap: 10 }}>
              <Eyebrow>{t('alerts.filterByWearer')}</Eyebrow>
              {wearerOptions.length === 0 ? (
                <Text style={{ fontFamily: fontFamily.sans, fontSize: 12.5, color: palette.text3 }}>
                  {t('alerts.filterNoWearers')}
                </Text>
              ) : (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Chip label={t('alerts.filterAllWearers')} selected={wearerFilter === 'all'} onPress={() => setWearerFilter('all')} />
                  {wearerOptions.map((w) => (
                    <Chip key={w.id} label={w.name.split(' ')[0]} selected={wearerFilter === w.id} onPress={() => setWearerFilter(w.id)} />
                  ))}
                </View>
              )}
            </View>
          </Dialog.Content>
          <Dialog.Actions>
            <Pressable
              onPress={() => { setDateFilter('all'); setWearerFilter('all'); }}
              disabled={!dateOrWearerActive}
              hitSlop={6}
              style={{ paddingHorizontal: 12, paddingVertical: 8, opacity: dateOrWearerActive ? 1 : 0.4 }}
            >
              <Text style={{ fontFamily: fontFamily.sansMedium, fontSize: 14, fontWeight: '500', color: palette.text2 }}>
                {t('alerts.clearFilters')}
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
