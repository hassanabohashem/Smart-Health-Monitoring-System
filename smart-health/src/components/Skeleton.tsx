import { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import { useTheme } from 'react-native-paper';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: any;
}

export function Skeleton({ width = '100%', height = 16, borderRadius = 8, style }: SkeletonProps) {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, []);

  return (
    <Animated.View
      style={[
        { width: width as any, height, borderRadius, backgroundColor: theme.colors.surfaceVariant, opacity },
        style,
      ]}
    />
  );
}

/** Skeleton shaped like a vital card */
export function VitalCardSkeleton() {
  const theme = useTheme();
  return (
    <View style={[skStyles.vitalCard, { backgroundColor: theme.colors.surface }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
        <Skeleton width={24} height={24} borderRadius={12} />
        <Skeleton width={60} height={12} style={{ marginLeft: 6 }} />
      </View>
      <Skeleton width={80} height={28} />
      <Skeleton width={50} height={10} style={{ marginTop: 4 }} />
    </View>
  );
}

/** Skeleton for the wearer home dashboard */
export function DashboardSkeleton() {
  return (
    <View style={skStyles.container}>
      <Skeleton width={180} height={24} style={{ marginBottom: 16 }} />
      <Skeleton width="100%" height={48} borderRadius={12} style={{ marginBottom: 12 }} />
      <Skeleton width="100%" height={40} borderRadius={12} style={{ marginBottom: 16 }} />
      <Skeleton width={120} height={18} style={{ marginBottom: 12 }} />
      <View style={skStyles.grid}>
        <VitalCardSkeleton />
        <VitalCardSkeleton />
        <VitalCardSkeleton />
        <VitalCardSkeleton />
      </View>
      <Skeleton width="100%" height={100} borderRadius={16} style={{ marginTop: 16 }} />
    </View>
  );
}

/** Skeleton for the caregiver dashboard */
export function CaregiverDashboardSkeleton() {
  return (
    <View style={skStyles.container}>
      <Skeleton width={200} height={24} style={{ marginBottom: 16 }} />
      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
        <Skeleton width="48%" height={80} borderRadius={16} />
        <Skeleton width="48%" height={80} borderRadius={16} />
      </View>
      <Skeleton width={140} height={18} style={{ marginBottom: 12 }} />
      <Skeleton width="100%" height={80} borderRadius={16} style={{ marginBottom: 8 }} />
      <Skeleton width="100%" height={80} borderRadius={16} />
    </View>
  );
}

/** Skeleton for alerts list */
export function AlertsListSkeleton() {
  return (
    <View style={skStyles.container}>
      {[1, 2, 3].map((i) => (
        <Skeleton key={i} width="100%" height={72} borderRadius={12} style={{ marginBottom: 8 }} />
      ))}
    </View>
  );
}

/** Skeleton for profile display */
export function ProfileSkeleton() {
  return (
    <View style={[skStyles.container, { alignItems: 'center' }]}>
      <Skeleton width={72} height={72} borderRadius={36} />
      <Skeleton width={160} height={24} style={{ marginTop: 12 }} />
      <Skeleton width={120} height={16} style={{ marginTop: 8 }} />
    </View>
  );
}

/** Skeleton for manage-links list */
export function ManageLinksSkeleton() {
  return (
    <View style={skStyles.container}>
      <Skeleton width="80%" height={14} style={{ marginBottom: 16 }} />
      {[1, 2, 3].map((i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, gap: 12 }}>
          <Skeleton width={40} height={40} borderRadius={20} />
          <View style={{ flex: 1 }}>
            <Skeleton width="60%" height={16} style={{ marginBottom: 6 }} />
            <Skeleton width="40%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Skeleton for caregiver map */
export function MapSkeleton() {
  return (
    <View style={skStyles.container}>
      <Skeleton width={160} height={20} style={{ marginBottom: 12 }} />
      {[1, 2].map((i) => (
        <Skeleton key={i} width="100%" height={100} borderRadius={16} style={{ marginBottom: 12 }} />
      ))}
      <Skeleton width={140} height={20} style={{ marginTop: 8, marginBottom: 12 }} />
      <Skeleton width="100%" height={80} borderRadius={16} />
    </View>
  );
}

const skStyles = StyleSheet.create({
  container: { padding: 16 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  vitalCard: { width: '47%', padding: 14, borderRadius: 16, gap: 4, elevation: 1 },
});
